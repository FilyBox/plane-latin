# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Reading and writing EntityReference rows.

Mentions are derived from the stored HTML of work items, comments and pages:
the HTML is only ever read, and the reference rows follow it. Attachments are
added and removed by hand. Removing either never touches the referenced item.
"""

from bs4 import BeautifulSoup
from django.db import IntegrityError, transaction
from django.utils import timezone

from plane.db.models import EntityReference, IssueComment
from plane.utils.entities import REGISTRY, AccessContext, resolve_entities

# Things that can hold mentions, and the registry type a reader lands on.
SOURCE_TYPES = {"issue": "issue", "issue_comment": "issue", "page": "page"}


def extract_mentions(html: str) -> set[tuple[str, str]]:
    """Registered entities mentioned in editor HTML (users are left to Plane's
    own mention handling)."""
    if not html or "mention-component" not in html:
        return set()
    found = set()
    for node in BeautifulSoup(html, "html.parser").find_all("mention-component"):
        name, identifier = node.get("entity_name"), node.get("entity_identifier")
        if name in REGISTRY and identifier:
            found.add((name, identifier))
    return found


def has_registered_mentions(html: str) -> bool:
    """Cheap pre-check before queueing a sync from a save signal."""
    if not html or "mention-component" not in html:
        return False
    return any(f'entity_name="{name}"' in html for name in REGISTRY)


def _upsert(workspace_id, source_type, source_id, target_type, target_id, kind, user_id=None):
    """Creates the reference, or brings back a removed one, without duplicates."""
    lookup = {
        "source_type": source_type,
        "source_id": source_id,
        "target_type": target_type,
        "target_id": target_id,
        "kind": kind,
    }
    if EntityReference.objects.filter(**lookup).exists():
        return False
    removed = EntityReference.all_objects.filter(deleted_at__isnull=False, **lookup).first()
    if removed:
        removed.deleted_at = None
        removed.save(update_fields=["deleted_at", "updated_at"])
        return True
    try:
        with transaction.atomic():
            EntityReference.objects.create(workspace_id=workspace_id, created_by_id=user_id, **lookup)
    except IntegrityError:
        # A concurrent sync got there first.
        return False
    return True


def sync_mentions(workspace_id, source_type, source_id, html, user_id=None) -> dict:
    """Makes the mention rows of one source match its HTML."""
    wanted = {(name, identifier) for name, identifier in extract_mentions(html) if _is_uuid(identifier)}
    current = {
        (row.target_type, str(row.target_id)): row
        for row in EntityReference.objects.filter(
            source_type=source_type, source_id=source_id, kind=EntityReference.Kind.MENTION
        )
    }
    added = 0
    for target_type, target_id in wanted - set(current):
        added += _upsert(
            workspace_id, source_type, source_id, target_type, target_id, EntityReference.Kind.MENTION, user_id
        )
    stale = [current[key].id for key in set(current) - wanted]
    if stale:
        EntityReference.objects.filter(id__in=stale).update(deleted_at=timezone.now())
    return {"added": added, "removed": len(stale)}


def add_attachment(workspace_id, source_type, source_id, target_type, target_id, user_id=None) -> bool:
    return _upsert(
        workspace_id, source_type, source_id, target_type, target_id, EntityReference.Kind.ATTACHMENT, user_id
    )


def remove_attachment(source_type, source_id, target_type, target_id) -> int:
    return EntityReference.objects.filter(
        source_type=source_type,
        source_id=source_id,
        target_type=target_type,
        target_id=target_id,
        kind=EntityReference.Kind.ATTACHMENT,
    ).update(deleted_at=timezone.now())


def outgoing(ctx: AccessContext, source_type: str, source_id: str) -> list[dict]:
    """What a work item, comment or page mentions or has attached."""
    rows = list(
        EntityReference.objects.filter(
            workspace_id=ctx.workspace_id, source_type=source_type, source_id=source_id
        ).order_by("created_at")
    )
    cards = resolve_entities(ctx, [{"entity_name": row.target_type, "id": str(row.target_id)} for row in rows])
    by_key = {(card["entity_name"], card["id"]): card for card in cards}
    merged: dict[tuple, dict] = {}
    for row in rows:
        key = (row.target_type, str(row.target_id))
        if key not in by_key:
            continue
        entry = merged.setdefault(key, {**by_key[key], "kinds": []})
        if row.kind not in entry["kinds"]:
            entry["kinds"].append(row.kind)
    return list(merged.values())


def backlinks(ctx: AccessContext, target_type: str, target_id: str) -> list[dict]:
    """Where something is mentioned or attached. Comments are reported as
    their work item, so the reader lands somewhere they can open."""
    rows = list(
        EntityReference.objects.filter(
            workspace_id=ctx.workspace_id, target_type=target_type, target_id=target_id
        ).order_by("-created_at")
    )
    comment_ids = [row.source_id for row in rows if row.source_type == "issue_comment"]
    comment_issue = {
        str(comment_id): str(issue_id)
        for comment_id, issue_id in IssueComment.objects.filter(id__in=comment_ids).values_list("id", "issue_id")
    }

    entries: list[tuple[str, str, str, bool]] = []
    for row in rows:
        if row.source_type == "issue_comment":
            issue_id = comment_issue.get(str(row.source_id))
            if issue_id:
                entries.append(("issue", issue_id, row.kind, True))
        elif row.source_type in SOURCE_TYPES:
            entries.append((SOURCE_TYPES[row.source_type], str(row.source_id), row.kind, False))

    cards = resolve_entities(ctx, [{"entity_name": name, "id": identifier} for name, identifier, _, _ in entries])
    by_key = {(card["entity_name"], card["id"]): card for card in cards}
    merged: dict[tuple, dict] = {}
    for name, identifier, kind, in_comment in entries:
        card = by_key.get((name, identifier))
        if not card or card["status"] == "missing":
            continue
        entry = merged.setdefault((name, identifier), {**card, "kinds": [], "in_comment": False})
        if kind not in entry["kinds"]:
            entry["kinds"].append(kind)
        entry["in_comment"] = entry["in_comment"] or in_comment
    return list(merged.values())


def _is_uuid(value: str) -> bool:
    import uuid

    try:
        uuid.UUID(str(value))
    except ValueError:
        return False
    return True
