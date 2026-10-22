# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""AI mapping of the workspace into shared tags.

The Worker reads a compact inventory of each kind of thing, proposes for every
item what it is and whose it is, and hands the proposals back. Nothing is
applied then: a person reviews the run and applies the parts they accept.
Everything an applied run writes is recorded on it, so the run can be undone
— including tag merges, which put the merged tags and their links back.
"""

from django.db import transaction
from django.db.models import Count, Q
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from plane.db.models import (
    Contract,
    EntityTagLink,
    Expense,
    FileAsset,
    FileTag,
    FileTagLink,
    Issue,
    MusicParty,
    TaggingRun,
)
from plane.utils.shared_tags import (
    FILE_BACKED,
    _asset_ids,
    _expense_ids,
    add_tag,
    find_or_create_tag,
    get_tags,
    merge_into,
    remirror_expenses,
)

# What the agents may scan. Music is already tied to artists by its credits.
SCANNABLE = ("contract", "file", "issue", "expense")

# The closed list each agent picks "what it is" from (None: no type tag).
TYPE_VOCABULARY = {
    "contract": [
        "Contrato editorial",
        "Contrato de artista",
        "Contrato de distribución",
        "Contrato de licencia",
        "Contrato de servicios",
        "Contrato de arrendamiento",
        "Otro contrato",
    ],
    "file": [
        "Portada",
        "Foto de artista",
        "Audio",
        "Video",
        "Letra",
        "Factura",
        "Contrato",
        "Documento legal",
        "Hoja de cálculo",
        "Presentación",
        "Imagen",
        "Otro documento",
    ],
    "issue": [],
    "expense": [],
}


def _clip(text, limit):
    text = " ".join(str(text or "").split())
    return text if len(text) <= limit else f"{text[: limit - 1]}…"


def inventory(workspace_id, entity_type, offset=0, limit=40, ids=None):
    """One page of what an agent reads: id, a title and a short text.

    `ids` limits it to those items (a run over just-uploaded files)."""
    if entity_type == "contract":
        rows = Contract.objects.filter(workspace_id=workspace_id, file_asset__is_deleted=False).select_related(
            "file_asset"
        )
        total = rows.count()
        page = list(rows.order_by("created_at")[offset : offset + limit])
        items = [
            {
                "id": str(row.id),
                "title": row.titulo or (row.file_asset.attributes or {}).get("name", ""),
                "text": _clip(
                    " | ".join(
                        part
                        for part in (
                            f"tipo: {row.get_tipo_contrato_display()}" if row.tipo_contrato else "",
                            "editorial" if row.es_editorial else "",
                            f"artistas: {row.artistas}" if row.artistas else "",
                            f"grupo: {row.nombre_grupo}" if row.nombre_grupo else "",
                            f"involucrados: {row.involucrados}" if row.involucrados else "",
                            row.resumen_general or "",
                        )
                        if part
                    ),
                    900,
                ),
            }
            for row in page
        ]
    elif entity_type == "file":
        contract_assets = Contract.objects.filter(workspace_id=workspace_id).values("file_asset_id")
        rows = (
            FileAsset.objects.filter(
                workspace_id=workspace_id,
                entity_type=FileAsset.EntityTypeContext.WORKSPACE_FILE_LIBRARY,
                is_uploaded=True,
                is_deleted=False,
            )
            # Contracts are read as contracts, with their analysis.
            .exclude(id__in=contract_assets)
            .select_related("folder")
        )
        if ids is not None:
            rows = rows.filter(id__in=list(ids))
        total = rows.count()
        page = list(rows.order_by("created_at")[offset : offset + limit])
        items = [
            {
                "id": str(row.id),
                "title": (row.attributes or {}).get("name", ""),
                "text": _clip(
                    " | ".join(
                        part
                        for part in (
                            (row.attributes or {}).get("type", ""),
                            f"carpeta: {row.folder.name}" if row.folder_id and row.folder else "",
                        )
                        if part
                    ),
                    300,
                ),
            }
            for row in page
        ]
    elif entity_type == "issue":
        rows = Issue.issue_objects.filter(workspace_id=workspace_id).select_related("project")
        total = rows.count()
        page = list(rows.order_by("created_at")[offset : offset + limit])
        items = [
            {
                "id": str(row.id),
                "title": row.name,
                "text": _clip(f"proyecto: {row.project.name} | {row.description_stripped or ''}", 500),
            }
            for row in page
        ]
    elif entity_type == "expense":
        rows = Expense.objects.filter(workspace_id=workspace_id)
        total = rows.count()
        page = list(rows.order_by("created_at")[offset : offset + limit])
        items = [
            {
                "id": str(row.id),
                "title": row.concept or row.vendor or "",
                "text": _clip(" | ".join(part for part in (row.vendor, row.description, row.reference) if part), 400),
            }
            for row in page
        ]
    else:
        return {"total": 0, "results": []}

    current = get_tags(workspace_id, entity_type, [item["id"] for item in items])
    for item in items:
        item["tags"] = [tag["name"] for tag in current.get(item["id"], [])]
    return {"total": total, "results": items}


def context(workspace_id):
    """Names the agents should reuse instead of inventing new ones."""
    from plane.utils.shared_tags import tag_usage

    usage = tag_usage(workspace_id)
    tags = [
        {
            "name": row["name"],
            "kind": row["kind"],
            # How established a name is: a merge keeps the catalog's or the
            # most used spelling, never a one-off typo.
            "usage": usage.get(str(row["id"]), 0),
            "catalog": row["party_id"] is not None,
        }
        for row in FileTag.objects.filter(workspace_id=workspace_id)
        .values("id", "name", "kind", "party_id")
        .order_by("name")[:3000]
    ]
    artists = list(
        MusicParty.objects.filter(workspace_id=workspace_id, disabled=False)
        .values_list("display_name", flat=True)
        .order_by("display_name")[:3000]
    )
    return {"tags": tags, "artists": artists, "vocabulary": TYPE_VOCABULARY}


def count_scannable(workspace_id, types):
    counts = {}
    for entity_type in types:
        if entity_type in SCANNABLE:
            counts[entity_type] = inventory(workspace_id, entity_type, 0, 0)["total"]
    return counts


def _visible_keys(ctx, entity_type, ids):
    from plane.utils.entities import REGISTRY

    definition = REGISTRY.get(entity_type)
    if definition is None or not definition.allows(ctx):
        return set()
    return {str(value) for value in definition.visible(ctx).filter(id__in=list(ids)).values_list("id", flat=True)}


@transaction.atomic
def apply_run(run: TaggingRun, ctx, approved: dict, user_id) -> dict:
    """Applies the parts of a run a person accepted.

    approved = {"tags": [{"name", "kind", "items": [{"entity_name", "id"}]}],
                "merges": [{"keep": name, "variants": [names]}]}
    """
    applied = {"links": [], "created_tags": [], "merges": []}
    workspace_id = run.workspace_id

    for merge in approved.get("merges") or []:
        record = merge_tags(workspace_id, merge.get("keep") or "", merge.get("variants") or [])
        if record:
            applied["merges"].append(record)

    for group in approved.get("tags") or []:
        name = " ".join(str(group.get("name") or "").split())
        if not name:
            continue
        kind = group.get("kind") if group.get("kind") in FileTag.Kind.values else FileTag.Kind.CUSTOM
        existed = FileTag.objects.filter(workspace_id=workspace_id, name__iexact=name).exists()
        tag = find_or_create_tag(workspace_id, name, kind, user_id)
        if not existed:
            applied["created_tags"].append(str(tag.id))
        by_type: dict[str, list[str]] = {}
        for item in group.get("items") or []:
            by_type.setdefault(item.get("entity_name"), []).append(str(item.get("id")))
        for entity_type, ids in by_type.items():
            visible = _visible_keys(ctx, entity_type, ids)
            current = get_tags(workspace_id, entity_type, list(visible))
            for entity_id in visible:
                if any(existing["id"] == str(tag.id) for existing in current.get(entity_id, [])):
                    continue
                add_tag(workspace_id, entity_type, entity_id, tag.id, user_id, source=EntityTagLink.Source.AI)
                applied["links"].append({"entity_name": entity_type, "id": entity_id, "tag_id": str(tag.id)})

    # Links written to EntityTagLink carry the run for traceability.
    entity_links = [link for link in applied["links"] if link["entity_name"] not in FILE_BACKED]
    for link in entity_links:
        EntityTagLink.objects.filter(
            tag_id=link["tag_id"], entity_type=link["entity_name"], entity_id=link["id"]
        ).update(run=run)

    summary = dict(run.summary or {})
    summary["applied"] = applied
    run.summary = summary
    run.status = TaggingRun.Status.COMPLETED
    run.finished_at = timezone.now()
    run.save(update_fields=["summary", "status", "finished_at", "updated_at"])
    return applied


def merge_tags(workspace_id, keep_name: str, variant_names) -> dict | None:
    """Folds variant tags into one, recording enough to put them back."""
    keep = FileTag.objects.filter(workspace_id=workspace_id, name__iexact=keep_name.strip()).first()
    if keep is None:
        return None
    record = {"keep_id": str(keep.id), "variants": []}
    for name in variant_names:
        variant = (
            FileTag.objects.filter(workspace_id=workspace_id, name__iexact=str(name).strip())
            .exclude(id=keep.id)
            .first()
        )
        if variant is None:
            continue
        record["variants"].append(merge_into(workspace_id, keep, variant))
        keep.refresh_from_db()
    return record if record["variants"] else None


@transaction.atomic
def undo_run(run: TaggingRun) -> dict:
    """Takes back everything an applied run wrote."""
    applied = (run.summary or {}).get("applied") or {}
    removed = 0
    for link in applied.get("links") or []:
        if link["entity_name"] in FILE_BACKED:
            asset_id = _asset_ids(link["entity_name"], [link["id"]]).get(link["id"])
            if asset_id:
                removed += FileTagLink.objects.filter(file_asset_id=asset_id, tag_id=link["tag_id"]).delete()
        else:
            removed += EntityTagLink.objects.filter(
                tag_id=link["tag_id"], entity_type=link["entity_name"], entity_id=link["id"]
            ).update(deleted_at=timezone.now())
    remirror_expenses([link["id"] for link in applied.get("links") or [] if link["entity_name"] == "expense"])

    for merge in reversed(applied.get("merges") or []):
        keep_id = merge["keep_id"]
        for variant in reversed(merge["variants"]):
            tag = FileTag.all_objects.filter(id=variant["id"]).first()
            if tag is None:
                continue
            # Someone made a tag with this name since: keep the merge for it
            # rather than end up with two tags of the same name.
            if FileTag.objects.filter(workspace_id=tag.workspace_id, name__iexact=tag.name).exclude(id=tag.id).exists():
                continue
            # Only the links the merge took away come back, never ones removed
            # earlier by hand, nor ones that were added back since.
            removed_at = parse_datetime(variant["deleted_at"])
            FileTag.all_objects.filter(id=tag.id).update(deleted_at=None)
            FileTagLink.all_objects.filter(tag_id=tag.id, deleted_at=removed_at).exclude(
                file_asset_id__in=FileTagLink.objects.filter(tag_id=tag.id).values("file_asset_id")
            ).update(deleted_at=None)
            active_entities = set(EntityTagLink.objects.filter(tag_id=tag.id).values_list("entity_type", "entity_id"))
            for link in EntityTagLink.all_objects.filter(tag_id=tag.id, deleted_at=removed_at):
                if (link.entity_type, link.entity_id) not in active_entities:
                    EntityTagLink.all_objects.filter(id=link.id).update(deleted_at=None)
            FileTagLink.objects.filter(tag_id=keep_id, file_asset_id__in=variant["added_assets"]).delete()
            for entity_type, entity_id in variant["added_entities"]:
                EntityTagLink.objects.filter(tag_id=keep_id, entity_type=entity_type, entity_id=entity_id).update(
                    deleted_at=timezone.now()
                )
            if variant.get("adopted_party"):
                FileTag.objects.filter(id=keep_id, party_id=variant["adopted_party"]).update(party=None)
            if variant.get("adopted_kind"):
                FileTag.objects.filter(id=keep_id, kind=variant["adopted_kind"]).update(kind=FileTag.Kind.CUSTOM)
            remirror_expenses(_expense_ids([keep_id, tag.id]))

    # Tags the run created and nothing else uses go away again.
    for tag_id in applied.get("created_tags") or []:
        tag = (
            FileTag.objects.filter(id=tag_id)
            .annotate(
                files=Count("file_links", filter=Q(file_links__deleted_at__isnull=True)),
                entities=Count("entity_links", filter=Q(entity_links__deleted_at__isnull=True)),
            )
            .first()
        )
        if tag and tag.files == 0 and tag.entities == 0 and tag.party_id is None:
            tag.delete()

    run.status = TaggingRun.Status.UNDONE
    run.save(update_fields=["status", "updated_at"])
    return {"removed_links": removed}


# ------------------------------------------------------------ new uploads

# Wait this long after an upload so a batch of files becomes one run.
AUTO_CLASSIFY_DELAY_SECONDS = 300
# On the first automatic run, look back this far (never the whole library:
# mapping everything is the manual "Mapear con IA").
AUTO_CLASSIFY_FIRST_LOOKBACK = timezone.timedelta(days=1)


def new_uploads_to_classify(workspace_id):
    """Library files uploaded since the last automatic run, contracts aside
    (they have their own analysis), not already tagged."""
    last = (
        TaggingRun.objects.filter(workspace_id=workspace_id, scope__auto=True)
        .exclude(status=TaggingRun.Status.FAILED)
        .order_by("-created_at")
        .first()
    )
    since = parse_datetime(last.scope.get("until")) if last and last.scope.get("until") else None
    since = since or timezone.now() - AUTO_CLASSIFY_FIRST_LOOKBACK
    contract_assets = Contract.objects.filter(workspace_id=workspace_id).values("file_asset_id")
    tagged = FileTagLink.objects.filter(workspace_id=workspace_id).values("file_asset_id")
    return list(
        FileAsset.objects.filter(
            workspace_id=workspace_id,
            entity_type=FileAsset.EntityTypeContext.WORKSPACE_FILE_LIBRARY,
            is_uploaded=True,
            is_deleted=False,
            created_at__gt=since,
        )
        .exclude(id__in=contract_assets)
        .exclude(id__in=tagged)
        .values_list("id", flat=True)[:200]
    )
