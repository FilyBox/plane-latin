# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Shared tags: one set of FileTag labels usable on any registered entity.

Where a module already stored tags, it keeps storing them there, so nothing
moves and its own screens and pipelines keep working unchanged:

- files and contracts → FileTagLink on the file (what the contract AI writes);
- expenses → EntityTagLink, with the names mirrored into Expense.tags so the
  existing filters and exports read the same thing;
- everything else (work items, pages, music, budgets) → EntityTagLink.

Songs and releases credited to a catalog artist also count as tagged with
that artist's tag (FileTag.party), without a stored row.
"""

from django.db import IntegrityError, transaction
from django.db.models import Count, DateTimeField, F, Q
from django.db.models.functions import ExtractYear, TruncDate
from django.utils import timezone

from plane.db.models import (
    Contract,
    EntityTagLink,
    Expense,
    FileTag,
    FileTagLink,
    MusicCredit,
    MusicReleaseArtist,
)
from plane.utils.entities import REGISTRY, AccessContext, entity_card

FILE_BACKED = {"file", "contract"}


def tag_payload(tag: FileTag) -> dict:
    return {
        "id": str(tag.id),
        "name": tag.name,
        "color": tag.color,
        "kind": tag.kind,
        "party_id": str(tag.party_id) if tag.party_id else None,
    }


def _asset_ids(entity_type, entity_ids):
    """The library file behind each file/contract id."""
    if entity_type == "file":
        return {str(value): str(value) for value in entity_ids}
    return {
        str(contract_id): str(asset_id)
        for contract_id, asset_id in Contract.objects.filter(id__in=list(entity_ids)).values_list("id", "file_asset_id")
    }


def get_tags(workspace_id, entity_type: str, entity_ids) -> dict[str, list[dict]]:
    """Confirmed shared tags per entity id."""
    entity_ids = [str(value) for value in entity_ids]
    result: dict[str, list[dict]] = {value: [] for value in entity_ids}
    if not entity_ids:
        return result
    if entity_type in FILE_BACKED:
        owners = _asset_ids(entity_type, entity_ids)
        by_asset: dict[str, list[str]] = {}
        for entity_id, asset_id in owners.items():
            by_asset.setdefault(asset_id, []).append(entity_id)
        links = FileTagLink.objects.filter(
            workspace_id=workspace_id, file_asset_id__in=list(by_asset), tag__deleted_at__isnull=True
        ).select_related("tag")
        for link in links:
            for entity_id in by_asset.get(str(link.file_asset_id), []):
                result[entity_id].append(tag_payload(link.tag))
    else:
        links = EntityTagLink.objects.filter(
            workspace_id=workspace_id,
            entity_type=entity_type,
            entity_id__in=entity_ids,
            status=EntityTagLink.Status.CONFIRMED,
            tag__deleted_at__isnull=True,
        ).select_related("tag")
        for link in links:
            result[str(link.entity_id)].append(tag_payload(link.tag))
    for tags in result.values():
        tags.sort(key=lambda tag: tag["name"].lower())
    return result


def _link_file_tag(workspace_id, asset_id, tag_id, user_id):
    if FileTagLink.objects.filter(file_asset_id=asset_id, tag_id=tag_id).exists():
        return
    try:
        with transaction.atomic():
            FileTagLink.objects.create(
                workspace_id=workspace_id, file_asset_id=asset_id, tag_id=tag_id, created_by_id=user_id
            )
    except IntegrityError:
        pass


def _link_entity_tag(workspace_id, entity_type, entity_id, tag_id, user_id, **extra):
    existing = EntityTagLink.objects.filter(tag_id=tag_id, entity_type=entity_type, entity_id=entity_id).first()
    if existing:
        changes = {key: value for key, value in extra.items() if getattr(existing, key) != value}
        if changes:
            for key, value in changes.items():
                setattr(existing, key, value)
            existing.save(update_fields=[*changes, "updated_at"])
        return existing
    try:
        with transaction.atomic():
            return EntityTagLink.objects.create(
                workspace_id=workspace_id,
                entity_type=entity_type,
                entity_id=entity_id,
                tag_id=tag_id,
                created_by_id=user_id,
                **extra,
            )
    except IntegrityError:
        return EntityTagLink.objects.filter(tag_id=tag_id, entity_type=entity_type, entity_id=entity_id).first()


def add_tag(workspace_id, entity_type, entity_id, tag_id, user_id=None, source=EntityTagLink.Source.MANUAL):
    """Confirms one tag on one entity, in the store that entity uses."""
    if entity_type in FILE_BACKED:
        asset_id = _asset_ids(entity_type, [entity_id]).get(str(entity_id))
        if asset_id:
            _link_file_tag(workspace_id, asset_id, tag_id, user_id)
        # A pending suggestion for it is now settled.
        EntityTagLink.objects.filter(tag_id=tag_id, entity_type=entity_type, entity_id=entity_id).update(
            deleted_at=timezone.now()
        )
    else:
        _link_entity_tag(
            workspace_id,
            entity_type,
            entity_id,
            tag_id,
            user_id,
            source=source,
            status=EntityTagLink.Status.CONFIRMED,
        )
    _mirror(entity_type, entity_id)


def remove_tag(workspace_id, entity_type, entity_id, tag_id):
    if entity_type in FILE_BACKED:
        asset_id = _asset_ids(entity_type, [entity_id]).get(str(entity_id))
        if asset_id:
            FileTagLink.objects.filter(file_asset_id=asset_id, tag_id=tag_id).delete()
    EntityTagLink.objects.filter(tag_id=tag_id, entity_type=entity_type, entity_id=entity_id).update(
        deleted_at=timezone.now()
    )
    _mirror(entity_type, entity_id)


def apply_tag_to_many(workspace_id, entity_type, entity_ids, tag_id, user_id=None, remove=False) -> int:
    """Adds (or removes) one tag on many entities at once, in each module's
    own store. Returns how many actually changed."""
    entity_ids = list({str(value) for value in entity_ids})
    if not entity_ids:
        return 0
    if entity_type in FILE_BACKED or entity_type == "expense":
        # Few rows in practice, and each keeps its own side effects (file
        # links, the expense name mirror).
        current = get_tags(workspace_id, entity_type, entity_ids)
        changed = 0
        for entity_id in entity_ids:
            has = any(tag["id"] == str(tag_id) for tag in current.get(entity_id, []))
            if remove and has:
                remove_tag(workspace_id, entity_type, entity_id, tag_id)
                changed += 1
            elif not remove and not has:
                add_tag(workspace_id, entity_type, entity_id, tag_id, user_id)
                changed += 1
        return changed
    links = EntityTagLink.objects.filter(tag_id=tag_id, entity_type=entity_type, entity_id__in=entity_ids)
    if remove:
        return links.update(deleted_at=timezone.now())
    confirmed = {
        str(value) for value in links.filter(status=EntityTagLink.Status.CONFIRMED).values_list("entity_id", flat=True)
    }
    # Pending AI suggestions for these become confirmed.
    promoted = links.exclude(status=EntityTagLink.Status.CONFIRMED).update(
        status=EntityTagLink.Status.CONFIRMED, source=EntityTagLink.Source.MANUAL
    )
    suggested = {str(value) for value in links.values_list("entity_id", flat=True)}
    missing = [value for value in entity_ids if value not in confirmed and value not in suggested]
    EntityTagLink.objects.bulk_create(
        [
            EntityTagLink(
                workspace_id=workspace_id,
                tag_id=tag_id,
                entity_type=entity_type,
                entity_id=value,
                created_by_id=user_id,
                source=EntityTagLink.Source.MANUAL,
                status=EntityTagLink.Status.CONFIRMED,
            )
            for value in missing
        ],
        batch_size=500,
        ignore_conflicts=True,
    )
    return promoted + len(missing)


def set_tags(workspace_id, entity_type, entity_id, tag_ids, user_id=None) -> list[dict]:
    """Makes an entity's confirmed tags exactly `tag_ids`."""
    wanted = {str(value) for value in tag_ids}
    current = {tag["id"] for tag in get_tags(workspace_id, entity_type, [entity_id])[str(entity_id)]}
    for tag_id in wanted - current:
        add_tag(workspace_id, entity_type, entity_id, tag_id, user_id)
    for tag_id in current - wanted:
        remove_tag(workspace_id, entity_type, entity_id, tag_id)
    return get_tags(workspace_id, entity_type, [entity_id])[str(entity_id)]


def _mirror(entity_type, entity_id):
    """Expenses keep their tag names in Expense.tags for the filters and
    exports that already read that field."""
    if entity_type != "expense":
        return
    expense = Expense.objects.filter(id=entity_id).first()
    if expense is None:
        return
    names = [tag["name"] for tag in get_tags(expense.workspace_id, "expense", [entity_id])[str(entity_id)]]
    # Category names were mirrored into the same field; keep the category.
    if expense.category_id and expense.category and expense.category.name not in names:
        names.insert(0, expense.category.name)
    if names != list(expense.tags or []):
        Expense.objects.filter(id=entity_id).update(tags=names[:20])


def _expense_ids(tag_ids) -> list:
    return list(
        EntityTagLink.objects.filter(tag_id__in=list(tag_ids), entity_type="expense")
        .values_list("entity_id", flat=True)
        .distinct()
    )


def remirror_expenses(expense_ids):
    """Rewrites Expense.tags after a tag was renamed, merged or deleted, so
    the old name is not read back (and recreated) on the next save."""
    for expense_id in set(expense_ids):
        _mirror("expense", expense_id)


def rename_tag(tag: FileTag, name: str, kind: str | None = None) -> FileTag:
    tag.name = name
    if kind:
        tag.kind = kind
    tag.save(update_fields=["name", "kind", "updated_at"])
    remirror_expenses(_expense_ids([tag.id]))
    return tag


def delete_tag(tag: FileTag):
    """Soft-deletes a tag and its links in every store; the tagged things stay."""
    expense_ids = _expense_ids([tag.id])
    now = timezone.now()
    FileTagLink.objects.filter(tag=tag).update(deleted_at=now)
    EntityTagLink.objects.filter(tag=tag).update(deleted_at=now)
    tag.delete()
    remirror_expenses(expense_ids)


def merge_into(workspace_id, keep: FileTag, variant: FileTag, source=EntityTagLink.Source.AI) -> dict:
    """Folds `variant` into `keep` across every store, then soft-deletes the
    variant. Returns what it did, enough to put it back (see
    plane.utils.tagging.undo_run)."""
    expense_ids = _expense_ids([keep.id, variant.id])
    keep_assets = set(FileTagLink.objects.filter(tag=keep).values_list("file_asset_id", flat=True))
    variant_assets = list(FileTagLink.objects.filter(tag=variant).values_list("file_asset_id", flat=True))
    added_assets = [asset for asset in variant_assets if asset not in keep_assets]
    for asset in added_assets:
        FileTagLink.objects.create(workspace_id=workspace_id, file_asset_id=asset, tag=keep)

    keep_entities = set(EntityTagLink.objects.filter(tag=keep).values_list("entity_type", "entity_id"))
    variant_entities = list(
        EntityTagLink.objects.filter(tag=variant, status=EntityTagLink.Status.CONFIRMED).values_list(
            "entity_type", "entity_id"
        )
    )
    # A variant tied to another catalog artist: that artist's songs and
    # releases were under it through credits; keep them under the kept
    # name explicitly so merging never loses them.
    if variant.party_id and variant.party_id != keep.party_id:
        variant_entities += [
            ("music_track", track_id)
            for track_id in MusicCredit.objects.filter(party_id=variant.party_id).values_list("track_id", flat=True)
        ]
        variant_entities += [
            ("music_release", release_id)
            for release_id in MusicReleaseArtist.objects.filter(party_id=variant.party_id).values_list(
                "release_id", flat=True
            )
        ]
        variant_entities.append(("music_artist", variant.party_id))
    seen: set = set()
    added_entities = []
    for pair in variant_entities:
        key = (pair[0], str(pair[1]))
        if key in seen or (pair[0], pair[1]) in keep_entities:
            continue
        seen.add(key)
        added_entities.append(pair)
    for entity_type, entity_id in added_entities:
        EntityTagLink.objects.create(
            workspace_id=workspace_id,
            tag=keep,
            entity_type=entity_type,
            entity_id=entity_id,
            source=source,
        )
    adopted_party = None
    if keep.party_id is None and variant.party_id:
        adopted_party = str(variant.party_id)
        keep.party_id = variant.party_id
        keep.save(update_fields=["party", "updated_at"])
    # The kept tag adopts the variant's classification if it had none.
    adopted_kind = None
    if keep.kind == FileTag.Kind.CUSTOM and variant.kind != FileTag.Kind.CUSTOM:
        adopted_kind = variant.kind
        keep.kind = variant.kind
        keep.save(update_fields=["kind", "updated_at"])
    # The variant and its links are soft-deleted: undo brings them back.
    now = timezone.now()
    FileTagLink.objects.filter(tag=variant).update(deleted_at=now)
    EntityTagLink.objects.filter(tag=variant).update(deleted_at=now)
    FileTag.objects.filter(id=variant.id).update(deleted_at=now)
    record = {
        "id": str(variant.id),
        "deleted_at": now.isoformat(),
        "added_assets": [str(asset) for asset in added_assets],
        "added_entities": [[entity_type, str(entity_id)] for entity_type, entity_id in added_entities],
        "adopted_party": adopted_party,
        "adopted_kind": adopted_kind,
    }
    remirror_expenses(expense_ids)
    return record


def tagged_ids(workspace_id, tag: FileTag, entity_type: str) -> list[str]:
    """Ids of `entity_type` carrying `tag` (confirmed), including credits."""
    if entity_type in FILE_BACKED:
        asset_ids = list(
            FileTagLink.objects.filter(workspace_id=workspace_id, tag=tag).values_list("file_asset_id", flat=True)
        )
        if entity_type == "file":
            # A contract's PDF is listed once, as the contract.
            contract_assets = set(
                Contract.objects.filter(file_asset_id__in=asset_ids).values_list("file_asset_id", flat=True)
            )
            return [str(value) for value in asset_ids if value not in contract_assets]
        return [
            str(value)
            for value in Contract.objects.filter(workspace_id=workspace_id, file_asset_id__in=asset_ids).values_list(
                "id", flat=True
            )
        ]
    ids = {
        str(value)
        for value in EntityTagLink.objects.filter(
            workspace_id=workspace_id, tag=tag, entity_type=entity_type, status=EntityTagLink.Status.CONFIRMED
        ).values_list("entity_id", flat=True)
    }
    if tag.party_id:
        if entity_type == "music_track":
            ids |= {
                str(value)
                for value in MusicCredit.objects.filter(party_id=tag.party_id).values_list("track_id", flat=True)
            }
        elif entity_type == "music_release":
            ids |= {
                str(value)
                for value in MusicReleaseArtist.objects.filter(party_id=tag.party_id).values_list(
                    "release_id", flat=True
                )
            }
        elif entity_type == "music_artist":
            ids.add(str(tag.party_id))
    return list(ids)


def combined_ids(workspace_id, tags, entity_type: str, mode: str = "all") -> list[str]:
    """Ids of `entity_type` carrying every tag in `tags` (mode "all") or at
    least one of them (mode "any"), with the same meaning of "carrying" as
    tagged_ids: credits count, so a song credited to an artist and tagged
    with an album has both. One set operation per tag, no per-item queries."""
    result: set[str] | None = None
    for tag in tags:
        ids = set(tagged_ids(workspace_id, tag, entity_type))
        if result is None:
            result = ids
        elif mode == "any":
            result |= ids
        else:
            result &= ids
        if not result and mode != "any":
            break
    return list(result or ())


def _entity_date(definition):
    """The date a type is filtered and sorted by, as a plain date."""
    if definition.date_expression:
        return definition.date_expression()
    field = definition.model._meta.get_field(definition.date_field)
    if isinstance(field, DateTimeField):
        return TruncDate(definition.date_field)
    return F(definition.date_field)


def entities_for_tag(
    ctx: AccessContext,
    tag: FileTag,
    types=None,
    query: str = "",
    date_from=None,
    date_to=None,
    offset: int = 0,
    limit_per_type: int = 50,
    with_tags=(),
    mode: str = "all",
) -> dict:
    """Everything carrying a tag, grouped by type, as cards the viewer may
    open. Types the viewer can't open are left out entirely.

    `with_tags` combines more tags with it: things carrying all of them
    (`mode="all"`) or any of them (`mode="any"`), see combined_ids.
    `query` narrows each type with its own search (song title, ISRC, contract
    title…); `date_from`/`date_to` narrow by each type's own date (release
    date, expense date…), leaving out types that have none. Each group gives
    the full matching `count` and one page of `items`, newest first."""
    groups = {}
    dated = date_from is not None or date_to is not None
    for name, definition in REGISTRY.items():
        if types and name not in types:
            continue
        if not definition.allows(ctx) or (dated and not definition.date_field):
            continue
        ids = combined_ids(ctx.workspace_id, [tag, *with_tags], name, mode)
        if not ids:
            continue
        rows = definition.visible(ctx).filter(id__in=ids)
        if query:
            rows = definition.search(rows, query)
        if definition.date_field:
            rows = rows.annotate(entity_date=_entity_date(definition))
            if date_from is not None:
                rows = rows.filter(entity_date__gte=date_from)
            if date_to is not None:
                rows = rows.filter(entity_date__lte=date_to)
            ordering = [F("entity_date").desc(nulls_last=True), "-created_at", "id"]
        else:
            ordering = [definition.order_by, "id"]
        rows = rows.distinct()
        count = rows.count()
        if count == 0:
            continue
        page = list(rows.order_by(*ordering)[offset : offset + limit_per_type])
        cards = []
        for obj in page:
            card = entity_card(definition, obj, ctx)
            value = getattr(obj, "entity_date", None)
            card["date"] = value.isoformat() if value else None
            cards.append(card)
        # Each item's own tags, so the view can narrow by kind of thing
        # (cover art, service contract…) within this tag.
        own = get_tags(ctx.workspace_id, name, [card["id"] for card in cards])
        for card in cards:
            card["tags"] = own.get(card["id"], [])
        groups[name] = {"count": count, "items": cards}
    return groups


def tag_years(
    ctx: AccessContext, tag: FileTag, types=None, query: str = "", with_tags=(), mode: str = "all"
) -> list[int]:
    """Years that have something under a tag (or a combination of tags, as
    in entities_for_tag), newest first: the quick picks for the date filter
    (a band's release years, an artist's contract years)."""
    years: set[int] = set()
    for name, definition in REGISTRY.items():
        if (types and name not in types) or not definition.date_field or not definition.allows(ctx):
            continue
        ids = combined_ids(ctx.workspace_id, [tag, *with_tags], name, mode)
        if not ids:
            continue
        rows = definition.visible(ctx).filter(id__in=ids)
        if query:
            rows = definition.search(rows, query)
        rows = rows.annotate(entity_date=_entity_date(definition)).filter(entity_date__isnull=False)
        years.update(
            value for value in rows.annotate(year=ExtractYear("entity_date")).values_list("year", flat=True) if value
        )
    return sorted(years, reverse=True)


def tag_usage(workspace_id) -> dict[str, int]:
    """How many things carry each tag, across every store."""
    counts: dict[str, int] = {}
    for tag_id, total in (
        FileTagLink.objects.filter(workspace_id=workspace_id).values_list("tag_id").annotate(total=Count("id"))
    ):
        counts[str(tag_id)] = counts.get(str(tag_id), 0) + total
    for tag_id, total in (
        EntityTagLink.objects.filter(workspace_id=workspace_id, status=EntityTagLink.Status.CONFIRMED)
        .values_list("tag_id")
        .annotate(total=Count("id"))
    ):
        counts[str(tag_id)] = counts.get(str(tag_id), 0) + total
    # Artist tags also count the songs and releases credited to the artist.
    party_tags = dict(
        FileTag.objects.filter(workspace_id=workspace_id, party__isnull=False).values_list("party_id", "id")
    )
    if party_tags:
        for model in (MusicCredit, MusicReleaseArtist):
            for party_id, total in (
                model.objects.filter(party_id__in=list(party_tags)).values_list("party_id").annotate(total=Count("id"))
            ):
                key = str(party_tags[party_id])
                counts[key] = counts.get(key, 0) + total
    return counts


def find_or_create_tag(workspace_id, name: str, kind=FileTag.Kind.CUSTOM, user_id=None) -> FileTag:
    """Case-insensitive, the way the contract pipeline matches names."""
    clean = " ".join(name.split())[:255]
    tag = FileTag.objects.filter(workspace_id=workspace_id, name__iexact=clean).first()
    if tag:
        return tag
    try:
        with transaction.atomic():
            return FileTag.objects.create(workspace_id=workspace_id, name=clean, kind=kind, created_by_id=user_id)
    except IntegrityError:
        return FileTag.objects.filter(workspace_id=workspace_id, name__iexact=clean).first()


def search_tags(workspace_id, query: str = "", kind: str | None = None, limit: int = 50):
    tags = FileTag.objects.filter(workspace_id=workspace_id)
    if query:
        tags = tags.filter(Q(name__icontains=query))
    if kind:
        tags = tags.filter(kind=kind)
    return tags.order_by("name")[:limit]


def sync_expense_tags_from_names(expense, user_id=None):
    """Expenses still edit their tags as names (Expense.tags). Those names are
    the expense's shared tags: create the missing tags, link them, and drop
    links whose name was removed. The category name, mirrored into the same
    field, stays a category."""
    category = expense.category.name.lower() if expense.category_id and expense.category else None
    names = []
    for raw in expense.tags or []:
        clean = " ".join(str(raw).split())
        if clean and clean.lower() != category and clean.lower() not in {name.lower() for name in names}:
            names.append(clean)
    wanted = {find_or_create_tag(expense.workspace_id, name, user_id=user_id).id for name in names}
    current = set(
        EntityTagLink.objects.filter(entity_type="expense", entity_id=expense.id).values_list("tag_id", flat=True)
    )
    for tag_id in wanted - current:
        _link_entity_tag(
            expense.workspace_id,
            "expense",
            expense.id,
            tag_id,
            user_id,
            source=EntityTagLink.Source.MANUAL,
            status=EntityTagLink.Status.CONFIRMED,
        )
    if current - wanted:
        EntityTagLink.objects.filter(
            entity_type="expense", entity_id=expense.id, tag_id__in=list(current - wanted)
        ).update(deleted_at=timezone.now())
