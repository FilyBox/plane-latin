# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""One registry of everything in a workspace that can be mentioned, attached,
tagged or exported from anywhere else.

Each entity type says once what it is, who may see it, how it is searched and
where it opens. Mentions, references, shared tags and exports all go through
here, so a new module becomes referenceable by adding one definition — and a
viewer never learns the name of something their role or the workspace's
modules don't let them open.

Payroll (employees, salaries) is deliberately not registered.
"""

import re
from dataclasses import dataclass
from typing import Callable, Iterable

from django.db.models import DateField, OuterRef, Q, QuerySet, Subquery
from django.db.models.functions import Coalesce

from plane.db.models import (
    BudgetScenario,
    Contract,
    Expense,
    FileAsset,
    Issue,
    MusicParty,
    MusicRelease,
    MusicReleaseTrack,
    MusicTrack,
    Page,
    WorkspaceFeature,
    WorkspaceMember,
)
from plane.utils.contract_access import contract_file_q

ADMIN, MEMBER, GUEST = 20, 15, 5


@dataclass
class AccessContext:
    """Who is asking, resolved once per request."""

    workspace_id: str
    slug: str
    user: object
    role: int
    features: frozenset

    @classmethod
    def build(cls, slug, user):
        member = (
            WorkspaceMember.objects.filter(workspace__slug=slug, member=user, is_active=True)
            .select_related("workspace")
            .first()
        )
        if member is None:
            return None
        features = frozenset(
            WorkspaceFeature.objects.filter(workspace_id=member.workspace_id, is_enabled=True).values_list(
                "key", flat=True
            )
        )
        return cls(
            workspace_id=str(member.workspace_id),
            slug=slug,
            user=user,
            role=member.role,
            features=features,
        )


@dataclass(frozen=True)
class EntityDefinition:
    name: str
    model: type
    # Workspace module that must be on, and the lowest workspace role that
    # may open it — the same rules the module's own endpoints apply.
    feature: str | None
    min_role: int
    # Rows this viewer may open (live rows only).
    visible: Callable[[AccessContext], QuerySet]
    search: Callable[[QuerySet, str], QuerySet]
    describe: Callable[[object, AccessContext], dict]
    # Rows of this type in the workspace regardless of the viewer, to tell
    # "restricted" (exists, can't open) from "missing" (deleted).
    exists: Callable[[str, Iterable[str]], set]
    order_by: str = "-created_at"
    # The date people filter this type by (release date, expense date…);
    # None when the type has no meaningful date.
    date_field: str | None = "created_at"
    # When the date lives elsewhere (a song's comes from its release), the
    # expression that computes it; date_field then only marks it as dated.
    date_expression: Callable[[], object] | None = None

    def allows(self, ctx: AccessContext) -> bool:
        if self.feature and self.feature not in ctx.features:
            return False
        return ctx.role >= self.min_role


def _ids(model, workspace_id, ids, **extra):
    return {
        str(value)
        for value in model.objects.filter(workspace_id=workspace_id, id__in=list(ids), **extra).values_list(
            "id", flat=True
        )
    }


def _icontains(*fields):
    def run(queryset, query):
        if not query:
            return queryset
        condition = Q()
        for field in fields:
            condition |= Q(**{f"{field}__icontains": query})
        return queryset.filter(condition)

    return run


# ---------------------------------------------------------------- work items


def _visible_issues(ctx):
    return Issue.issue_objects.filter(
        workspace_id=ctx.workspace_id,
        project__project_projectmember__member=ctx.user,
        project__project_projectmember__is_active=True,
        project__project_projectmember__deleted_at__isnull=True,
    ).select_related("project")


def _search_issues(queryset, query):
    if not query:
        return queryset
    condition = Q(name__icontains=query) | Q(project__identifier__icontains=query)
    for sequence in re.findall(r"\b\d+\b", query):
        condition |= Q(sequence_id=sequence)
    return queryset.filter(condition)


def _describe_issue(issue, ctx):
    key = f"{issue.project.identifier}-{issue.sequence_id}"
    return {
        "title": issue.name,
        "subtitle": key,
        "path": f"/{ctx.slug}/browse/{key}/",
        "meta": {"project_id": str(issue.project_id), "state_id": str(issue.state_id) if issue.state_id else None},
    }


# --------------------------------------------------------------------- pages


def _visible_pages(ctx):
    return (
        Page.objects.filter(
            workspace_id=ctx.workspace_id,
            projects__project_projectmember__member=ctx.user,
            projects__project_projectmember__is_active=True,
            archived_at__isnull=True,
        )
        .filter(Q(access=0) | Q(owned_by=ctx.user))
        .prefetch_related("projects")
        .distinct()
    )


def _describe_page(page, ctx):
    project = next(iter(page.projects.all()), None)
    return {
        "title": page.name or "",
        "subtitle": project.identifier if project else "",
        "path": f"/{ctx.slug}/projects/{project.id}/pages/{page.id}/" if project else "",
        "meta": {"project_id": str(project.id) if project else None},
    }


# --------------------------------------------------------------------- files


def _visible_files(ctx):
    files = FileAsset.objects.filter(
        workspace_id=ctx.workspace_id,
        entity_type=FileAsset.EntityTypeContext.WORKSPACE_FILE_LIBRARY,
        is_uploaded=True,
        is_deleted=False,
    )
    # A contract's PDF is the contract: admins only, like the contract itself
    return files if ctx.role >= ADMIN else files.exclude(contract_file_q())


def _describe_file(asset, ctx):
    attributes = asset.attributes or {}
    return {
        "title": attributes.get("name") or "",
        "subtitle": _file_detail(attributes),
        "path": f"/{ctx.slug}/file-library?preview={asset.id}",
        "meta": {"mime": attributes.get("type") or "", "size": attributes.get("size")},
    }


def _file_detail(attributes):
    """ "PDF · 1.2 MB" rather than a MIME type."""
    name, size = attributes.get("name") or "", attributes.get("size")
    extension = name.rsplit(".", 1)[-1].upper() if "." in name else ""
    if isinstance(size, (int, float)) and size > 0:
        units = ["B", "KB", "MB", "GB"]
        value, unit = float(size), 0
        while value >= 1024 and unit < len(units) - 1:
            value, unit = value / 1024, unit + 1
        readable = f"{value:.0f} {units[unit]}" if unit < 2 else f"{value:.1f} {units[unit]}"
        return " · ".join(part for part in (extension, readable) if part)
    return extension


def _existing_files(workspace_id, ids):
    return _ids(FileAsset, workspace_id, ids, entity_type=FileAsset.EntityTypeContext.WORKSPACE_FILE_LIBRARY)


# ----------------------------------------------------------------- contracts


def _visible_contracts(ctx):
    return Contract.objects.filter(workspace_id=ctx.workspace_id, file_asset__is_deleted=False).select_related(
        "file_asset"
    )


def _describe_contract(contract, ctx):
    file_name = ((contract.file_asset.attributes or {}).get("name") if contract.file_asset else "") or ""
    details = [
        part
        for part in (contract.get_tipo_contrato_display() if contract.tipo_contrato else "", contract.artistas)
        if part
    ]
    title = contract.titulo or file_name
    return {
        "title": title,
        "subtitle": " · ".join(details) or (file_name if file_name != title else ""),
        "path": f"/{ctx.slug}/file-library/contracts/analyzed?peek={contract.id}",
        "meta": {"asset_id": str(contract.file_asset_id), "editorial": contract.es_editorial},
    }


# --------------------------------------------------------------------- music


def _visible_tracks(ctx):
    return MusicTrack.objects.filter(workspace_id=ctx.workspace_id)


def _describe_track(track, ctx):
    title = f"{track.title} ({track.version})" if track.version else track.title
    return {
        "title": title,
        # Codes and dates only: labels are localized by the client.
        "subtitle": " · ".join(
            part for part in (track.isrc, str(track.release_date.year) if track.release_date else "") if part
        ),
        "path": f"/{ctx.slug}/music?track={track.id}",
        "meta": {"cover_url": track.cover_url or ""},
    }


def _track_date():
    """A song's own release date, or else its earliest release's."""
    first_release = (
        MusicReleaseTrack.objects.filter(track_id=OuterRef("pk"), release__release_date__isnull=False)
        .order_by("release__release_date")
        .values("release__release_date")[:1]
    )
    return Coalesce("release_date", "original_release_date", Subquery(first_release), output_field=DateField())


def _visible_releases(ctx):
    return MusicRelease.objects.filter(workspace_id=ctx.workspace_id)


def _describe_release(release, ctx):
    return {
        "title": release.title,
        "subtitle": " · ".join(
            part for part in (release.upc, str(release.release_date.year) if release.release_date else "") if part
        ),
        "path": f"/{ctx.slug}/music?release={release.id}",
        "meta": {"cover_url": release.cover_url or ""},
    }


def _visible_artists(ctx):
    return MusicParty.objects.filter(workspace_id=ctx.workspace_id, disabled=False)


def _describe_artist(party, ctx):
    return {
        "title": party.display_name,
        "subtitle": party.legal_name if party.legal_name and party.legal_name != party.display_name else "",
        "path": f"/{ctx.slug}/music?artist={party.id}",
        "meta": {"avatar_url": party.avatar_url or "", "kind": party.kind},
    }


# ------------------------------------------------------------------- finance


def _visible_budgets(ctx):
    return BudgetScenario.objects.filter(workspace_id=ctx.workspace_id)


def _describe_budget(scenario, ctx):
    return {
        "title": scenario.name,
        "subtitle": f"{scenario.fiscal_year} · {scenario.currency}",
        "path": f"/{ctx.slug}/payments?budget={scenario.id}",
        "meta": {},
    }


def _visible_expenses(ctx):
    return Expense.objects.filter(workspace_id=ctx.workspace_id)


def _describe_expense(expense, ctx):
    return {
        "title": expense.concept or expense.vendor or "",
        "subtitle": f"{expense.expense_date} · {expense.amount} {expense.currency}",
        "path": f"/{ctx.slug}/expenses?expense={expense.id}",
        "meta": {"status": expense.status},
    }


FEATURE = WorkspaceFeature.FeatureKey

REGISTRY: dict[str, EntityDefinition] = {
    definition.name: definition
    for definition in (
        EntityDefinition(
            name="issue",
            model=Issue,
            feature=None,
            min_role=GUEST,
            visible=_visible_issues,
            search=_search_issues,
            describe=_describe_issue,
            exists=lambda workspace_id, ids: _ids(Issue, workspace_id, ids),
        ),
        EntityDefinition(
            name="page",
            model=Page,
            feature=None,
            min_role=GUEST,
            visible=_visible_pages,
            search=_icontains("name"),
            describe=_describe_page,
            exists=lambda workspace_id, ids: _ids(Page, workspace_id, ids),
        ),
        EntityDefinition(
            name="file",
            model=FileAsset,
            feature=FEATURE.FILE_LIBRARY,
            min_role=GUEST,
            visible=_visible_files,
            search=_icontains("attributes__name"),
            describe=_describe_file,
            exists=_existing_files,
        ),
        EntityDefinition(
            name="contract",
            model=Contract,
            feature=FEATURE.FILE_LIBRARY,
            min_role=ADMIN,
            visible=_visible_contracts,
            search=_icontains("titulo", "artistas", "file_asset__attributes__name"),
            describe=_describe_contract,
            exists=lambda workspace_id, ids: _ids(Contract, workspace_id, ids),
            date_field="fecha_inicio",
        ),
        EntityDefinition(
            name="music_track",
            model=MusicTrack,
            feature=FEATURE.MUSIC_CATALOG,
            min_role=ADMIN,
            visible=_visible_tracks,
            search=_icontains("title", "isrc", "credits__party__display_name"),
            describe=_describe_track,
            exists=lambda workspace_id, ids: _ids(MusicTrack, workspace_id, ids),
            date_field="release_date",
            date_expression=_track_date,
        ),
        EntityDefinition(
            name="music_release",
            model=MusicRelease,
            feature=FEATURE.MUSIC_CATALOG,
            min_role=ADMIN,
            visible=_visible_releases,
            search=_icontains("title", "upc", "artists__display_name"),
            describe=_describe_release,
            exists=lambda workspace_id, ids: _ids(MusicRelease, workspace_id, ids),
            date_field="release_date",
        ),
        EntityDefinition(
            name="music_artist",
            model=MusicParty,
            feature=FEATURE.MUSIC_CATALOG,
            min_role=ADMIN,
            visible=_visible_artists,
            search=_icontains("display_name", "legal_name"),
            describe=_describe_artist,
            exists=lambda workspace_id, ids: _ids(MusicParty, workspace_id, ids),
            order_by="display_name",
            date_field=None,
        ),
        EntityDefinition(
            name="budget",
            model=BudgetScenario,
            feature=FEATURE.PAYMENTS,
            min_role=ADMIN,
            visible=_visible_budgets,
            search=_icontains("name"),
            describe=_describe_budget,
            exists=lambda workspace_id, ids: _ids(BudgetScenario, workspace_id, ids),
        ),
        EntityDefinition(
            name="expense",
            model=Expense,
            feature=FEATURE.PAYMENTS,
            min_role=ADMIN,
            visible=_visible_expenses,
            search=_icontains("concept", "vendor", "reference"),
            describe=_describe_expense,
            exists=lambda workspace_id, ids: _ids(Expense, workspace_id, ids),
            order_by="-expense_date",
            date_field="expense_date",
        ),
    )
}


def allowed_types(ctx: AccessContext) -> list[str]:
    return [name for name, definition in REGISTRY.items() if definition.allows(ctx)]


def entity_card(definition, obj, ctx):
    return {"entity_name": definition.name, "id": str(obj.id), "status": "ok", **definition.describe(obj, ctx)}


def search_entities(ctx: AccessContext, query: str, names: Iterable[str] | None = None, count: int = 5) -> dict:
    """Top matches per type the viewer may open, in registry order."""
    wanted = [name for name in (names or REGISTRY.keys()) if name in REGISTRY]
    results = {}
    for name in wanted:
        definition = REGISTRY[name]
        if not definition.allows(ctx):
            continue
        rows = definition.search(definition.visible(ctx), query.strip()).distinct().order_by(definition.order_by)
        results[name] = [entity_card(definition, obj, ctx) for obj in rows[:count]]
    return results


def resolve_entities(ctx: AccessContext, items: Iterable[dict]) -> list[dict]:
    """Cards for mention chips and reference lists.

    `status` is "ok", "restricted" (exists but this viewer can't open it — no
    name is revealed) or "missing" (deleted or never existed).
    """
    by_type: dict[str, list[str]] = {}
    for item in items:
        name, identifier = item.get("entity_name"), str(item.get("id") or "")
        if name in REGISTRY and identifier:
            by_type.setdefault(name, []).append(identifier)

    cards = {}
    for name, ids in by_type.items():
        definition = REGISTRY[name]
        found = {}
        if definition.allows(ctx):
            valid = [value for value in ids if _is_uuid(value)]
            found = {str(obj.id): obj for obj in definition.visible(ctx).filter(id__in=valid)}
        existing = definition.exists(ctx.workspace_id, [value for value in ids if _is_uuid(value)])
        for identifier in ids:
            if identifier in found:
                cards[(name, identifier)] = entity_card(definition, found[identifier], ctx)
            else:
                cards[(name, identifier)] = {
                    "entity_name": name,
                    "id": identifier,
                    "status": "restricted" if identifier in existing else "missing",
                }
    return [
        cards[(item.get("entity_name"), str(item.get("id")))]
        for item in items
        if (item.get("entity_name"), str(item.get("id"))) in cards
    ]


_UUID = re.compile(r"^[0-9a-fA-F-]{32,36}$")


def _is_uuid(value: str) -> bool:
    return bool(_UUID.match(value))
