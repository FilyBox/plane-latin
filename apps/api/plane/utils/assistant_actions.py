# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Changes the assistant makes once the user approves them in a card.

Every change is recorded as an AssistantAction holding exactly what changed,
so undo reverts that and nothing else:
- tagging only touches items whose tag state actually changed (an item that
  already had the tag is left alone, and undo won't strip it);
- a created work item is only deleted on undo if nobody edited it since.
Each change runs as the asking user, with the same visibility rules as the
rest of the app.
"""

import json
from datetime import timedelta

from django.core.serializers.json import DjangoJSONEncoder
from django.db import transaction
from django.utils import timezone

from plane.db.models import AssistantAction, FileTag, Issue, Project, ProjectMember, WorkspaceMember
from plane.utils.assistant_markdown import MENTION_RE
from plane.utils.entities import REGISTRY
from plane.utils.shared_tags import (
    add_tag,
    find_or_create_tag,
    find_tag_by_name,
    get_tags,
    remove_tag,
    tag_payload,
)

MAX_ITEMS = 200
PDF_KINDS = (
    AssistantAction.Kind.SPLIT_PDF,
    AssistantAction.Kind.MERGE_PDF,
    AssistantAction.Kind.EDIT_PDF_PAGES,
)
# Edits within this window after creation count as part of creating it.
EDIT_GRACE = timedelta(seconds=30)


class ActionError(Exception):
    """A user-facing reason the change can't be made (or undone)."""


def _group(items) -> dict[str, list[str]]:
    grouped: dict[str, list[str]] = {}
    for item in items or []:
        if isinstance(item, dict) and item.get("entity_name") and item.get("id"):
            grouped.setdefault(str(item["entity_name"]), [])
            if str(item["id"]) not in grouped[str(item["entity_name"])]:
                grouped[str(item["entity_name"])].append(str(item["id"]))
    return grouped


def _visible(ctx, entity_type: str, ids: list[str]) -> list[str]:
    definition = REGISTRY.get(entity_type)
    if definition is None or not definition.allows(ctx):
        return []
    return [str(value) for value in definition.visible(ctx).filter(id__in=ids).values_list("id", flat=True)]


@transaction.atomic
def tag_items(ctx, user, *, tag_id=None, tag_name=None, items=None, remove=False, payload=None) -> AssistantAction:
    grouped = _group(items)
    total = sum(len(ids) for ids in grouped.values())
    if total == 0 or total > MAX_ITEMS:
        raise ActionError(f"Choose between 1 and {MAX_ITEMS} items.")

    created_tag = False
    tag = FileTag.objects.filter(workspace_id=ctx.workspace_id, id=tag_id).first() if tag_id else None
    if tag is None and tag_name and not remove:
        existed = find_tag_by_name(ctx.workspace_id, str(tag_name)) is not None
        tag = find_or_create_tag(ctx.workspace_id, str(tag_name), user_id=user.id)
        created_tag = not existed
    if tag is None:
        raise ActionError("Tag not found.")

    changed, skipped = [], 0
    for entity_type, ids in grouped.items():
        visible = _visible(ctx, entity_type, ids)
        skipped += len(ids) - len(visible)
        current = get_tags(ctx.workspace_id, entity_type, visible)
        for entity_id in visible:
            has = any(row["id"] == str(tag.id) for row in current.get(entity_id, []))
            if remove and has:
                remove_tag(ctx.workspace_id, entity_type, entity_id, tag.id)
            elif not remove and not has:
                add_tag(ctx.workspace_id, entity_type, entity_id, tag.id, user.id)
            else:
                continue
            changed.append({"entity_name": entity_type, "id": entity_id})

    verb = "Quitó" if remove else "Puso"
    return AssistantAction.objects.create(
        workspace_id=ctx.workspace_id,
        kind=AssistantAction.Kind.UNTAG_ITEMS if remove else AssistantAction.Kind.TAG_ITEMS,
        summary=f"{verb} «{tag.name}» en {len(changed)} elemento(s)"[:300],
        payload=payload or {},
        result={"tag": tag_payload(tag), "changed": changed, "skipped": skipped, "created_tag": created_tag},
    )


def _undo_tagging(action: AssistantAction):
    result = action.result or {}
    tag_id = (result.get("tag") or {}).get("id")
    tag = FileTag.objects.filter(workspace_id=action.workspace_id, id=tag_id).first()
    if tag is None:
        # Merged or deleted since: nothing left of this change to revert.
        return
    for item in result.get("changed") or []:
        if action.kind == AssistantAction.Kind.TAG_ITEMS:
            remove_tag(action.workspace_id, item["entity_name"], item["id"], tag.id)
        else:
            add_tag(action.workspace_id, item["entity_name"], item["id"], tag.id)
    if result.get("created_tag"):
        from plane.db.models import EntityTagLink, FileTagLink

        unused = (
            not FileTagLink.objects.filter(tag=tag).exists()
            and not EntityTagLink.objects.filter(tag=tag).exists()
            and tag.party_id is None
        )
        if unused:
            tag.delete()


def _clean_html(text: str) -> str:
    from html import escape

    paragraphs = [escape(line.strip()) for line in str(text or "").splitlines() if line.strip()]
    return "".join(f"<p>{line}</p>" for line in paragraphs) or "<p></p>"


@transaction.atomic
def create_work_item(ctx, user, data: dict, origin: str, payload=None) -> AssistantAction:
    from plane.app.serializers import IssueCreateSerializer
    from plane.bgtasks.issue_activities_task import issue_activity
    from plane.utils.references import add_attachment

    project = Project.objects.filter(workspace_id=ctx.workspace_id, id=data.get("project_id")).first()
    if project is None:
        raise ActionError("Project not found.")
    if not ProjectMember.objects.filter(project=project, member=user, is_active=True, role__gte=15).exists():
        raise ActionError("You can't create work items in this project.")
    name = " ".join(str(data.get("name") or "").split())[:255]
    if not name:
        raise ActionError("The work item needs a title.")

    fields = {"name": name, "description_html": _clean_html(data.get("description"))}
    if data.get("priority") in {"urgent", "high", "medium", "low", "none"}:
        fields["priority"] = data["priority"]
    for key in ("target_date", "start_date"):
        if data.get(key):
            fields[key] = str(data[key])[:10]
    assignees = [str(value) for value in data.get("assignee_ids") or []]
    if assignees:
        fields["assignee_ids"] = list(
            ProjectMember.objects.filter(project=project, member_id__in=assignees, is_active=True).values_list(
                "member_id", flat=True
            )
        )
    serializer = IssueCreateSerializer(
        data=fields,
        context={
            "project_id": project.id,
            "workspace_id": project.workspace_id,
            "default_assignee_id": project.default_assignee_id,
        },
    )
    if not serializer.is_valid():
        raise ActionError(json.dumps(serializer.errors)[:300])
    serializer.save()
    issue = Issue.objects.get(id=serializer.data["id"])

    attached = []
    for entity_type, ids in _group(data.get("references")).items():
        for entity_id in _visible(ctx, entity_type, ids):
            add_attachment(ctx.workspace_id, "issue", str(issue.id), entity_type, entity_id, user.id)
            attached.append({"entity_name": entity_type, "id": entity_id})

    issue_activity.delay(
        type="issue.activity.created",
        requested_data=json.dumps(fields, cls=DjangoJSONEncoder),
        actor_id=str(user.id),
        issue_id=str(issue.id),
        project_id=str(project.id),
        current_instance=None,
        epoch=int(timezone.now().timestamp()),
        notification=True,
        origin=origin,
    )
    key = f"{project.identifier}-{issue.sequence_id}"
    return AssistantAction.objects.create(
        workspace_id=ctx.workspace_id,
        kind=AssistantAction.Kind.CREATE_WORK_ITEM,
        summary=f"Creó {key}: {name}"[:300],
        payload=payload or {},
        result={
            "issue_id": str(issue.id),
            "project_id": str(project.id),
            "key": key,
            "name": name,
            "path": f"/{ctx.slug}/browse/{key}/",
            "references": attached,
        },
    )


def _undo_work_item(action: AssistantAction, user, origin: str):
    from plane.bgtasks.issue_activities_task import issue_activity

    result = action.result or {}
    issue = Issue.issue_objects.filter(id=result.get("issue_id")).first()
    if issue is None:
        return
    if issue.updated_at > action.created_at + EDIT_GRACE:
        raise ActionError("Someone edited this work item after it was created; delete it from the work item itself.")
    issue.delete()
    issue_activity.delay(
        type="issue.activity.deleted",
        requested_data=json.dumps({"issue_id": str(issue.id)}),
        actor_id=str(user.id),
        issue_id=str(issue.id),
        project_id=str(issue.project_id),
        current_instance={},
        epoch=int(timezone.now().timestamp()),
        notification=True,
        origin=origin,
        subscriber=False,
    )


@transaction.atomic
def create_page(ctx, user, data: dict, payload=None) -> AssistantAction:
    """A project page written by the assistant (Markdown → editor HTML).

    Mentions become the editor's mention nodes (only for items the user can
    open), so the page links to them and shows up in their references.
    """
    from plane.app.serializers import PageSerializer
    from plane.bgtasks.page_transaction_task import page_transaction
    from plane.utils.assistant_markdown import markdown_to_html, plain_text
    from plane.utils.references import sync_mentions

    project = Project.objects.filter(workspace_id=ctx.workspace_id, id=data.get("project_id")).first()
    if project is None:
        raise ActionError("Project not found.")
    if not ProjectMember.objects.filter(project=project, member=user, is_active=True, role__gte=15).exists():
        raise ActionError("You can't create pages in this project.")
    if not getattr(project, "page_view", True):
        raise ActionError("Pages are turned off in this project.")
    name = " ".join(str(data.get("name") or "").split())[:255]
    if not name:
        raise ActionError("The page needs a title.")

    visible_cache: dict[str, set[str]] = {}

    def allowed(kind: str, identifier: str) -> bool:
        # Without References the chips can't load: write the plain name instead.
        if "references" not in ctx.features:
            return False
        if kind not in visible_cache:
            ids = [match.group(3) for match in MENTION_RE.finditer(str(data.get("markdown") or "")) if match.group(1) == kind]
            visible_cache[kind] = set(_visible(ctx, kind, ids))
        return identifier.lower() in {value.lower() for value in visible_cache[kind]}

    description_html = markdown_to_html(
        str(data.get("markdown") or "")[:120_000],
        set(REGISTRY),
        allowed,
        tag_href=lambda identifier: f"/{ctx.slug}/tags/{identifier}/",
    )
    serializer = PageSerializer(
        data={"name": name, "access": 1 if data.get("private") else 0},
        context={
            "project_id": project.id,
            "owned_by_id": user.id,
            "description_json": {},
            "description_binary": None,
            "description_html": description_html,
        },
    )
    if not serializer.is_valid():
        raise ActionError(json.dumps(serializer.errors)[:300])
    serializer.save()
    page_id = str(serializer.data["id"])
    page_transaction.delay(new_description_html=description_html, old_description_html=None, page_id=page_id)
    sync_mentions(ctx.workspace_id, "page", page_id, description_html, user.id)
    return AssistantAction.objects.create(
        workspace_id=ctx.workspace_id,
        kind=AssistantAction.Kind.CREATE_PAGE,
        summary=f"Creó la página «{name}»"[:300],
        payload=payload or {},
        result={
            "page_id": page_id,
            "project_id": str(project.id),
            "name": name,
            "path": f"/{ctx.slug}/projects/{project.id}/pages/{page_id}/",
            # Words as created: undo refuses once someone changed them.
            "text": plain_text(description_html)[:20_000],
        },
    )


def _undo_page(action: AssistantAction):
    from plane.db.models import Page
    from plane.utils.assistant_markdown import plain_text

    result = action.result or {}
    page = Page.objects.filter(id=result.get("page_id")).first()
    if page is None:
        return
    # Opening the page re-saves it in the editor's format, so compare the
    # words rather than timestamps.
    edited = page.name != result.get("name") or plain_text(page.description_html)[:20_000] != result.get("text")
    if edited:
        raise ActionError("Someone edited this page after it was created; delete it from the page itself.")
    page.delete()


def _page_mention_check(ctx, markdown: str):
    """Which mentions in the assistant's Markdown the reader may open."""
    visible_cache: dict[str, set[str]] = {}
    member_ids: set[str] | None = None

    def allowed(kind: str, identifier: str) -> bool:
        nonlocal member_ids
        if kind == "user_mention":
            if member_ids is None:
                member_ids = {
                    str(value).lower()
                    for value in WorkspaceMember.objects.filter(
                        workspace_id=ctx.workspace_id, is_active=True
                    ).values_list("member_id", flat=True)
                }
            return identifier.lower() in member_ids
        # Without References the chips can't load: write the plain name instead.
        if "references" not in ctx.features:
            return False
        if kind not in visible_cache:
            ids = [match.group(3) for match in MENTION_RE.finditer(markdown) if match.group(1) == kind]
            visible_cache[kind] = {value.lower() for value in _visible(ctx, kind, ids)}
        return identifier.lower() in visible_cache[kind]

    return allowed


def edit_page(ctx, user, data: dict, cookie: str, payload=None) -> AssistantAction:
    """Rewrites an existing page's content with the assistant's Markdown.

    Refuses when the page changed since the assistant read it, so nobody's
    edit is overwritten; blocks Markdown can't hold come back untouched.
    """
    from plane.utils.assistant_markdown import plain_text
    from plane.utils.assistant_pages import PageUnavailable, find_page, write_page_html
    from plane.utils.page_markdown import PageChanged, fingerprint, markdown_to_page_html
    from plane.utils.references import sync_mentions

    try:
        page, project = find_page(ctx, user, data.get("page_id"), for_edit=True)
    except PageUnavailable as error:
        raise ActionError(str(error))
    before_html = page.description_html or ""
    if data.get("base_version") and fingerprint(before_html) != data.get("base_version"):
        raise ActionError("The page changed after the assistant read it. Ask it to read the page again.")
    markdown = str(data.get("markdown") or "")[:120_000]
    if not markdown.strip():
        raise ActionError("The new content is empty.")
    try:
        after_html = markdown_to_page_html(
            markdown,
            before_html,
            set(REGISTRY) | {"user_mention"},
            _page_mention_check(ctx, markdown),
            tag_href=lambda identifier: f"/{ctx.slug}/tags/{identifier}/",
        )
    except PageChanged:
        raise ActionError("The page changed after the assistant read it. Ask it to read the page again.")
    try:
        write_page_html(page, project, after_html, user, cookie)
    except PageUnavailable as error:
        raise ActionError(str(error))
    sync_mentions(ctx.workspace_id, "page", str(page.id), after_html, user.id)
    return AssistantAction.objects.create(
        workspace_id=ctx.workspace_id,
        kind=AssistantAction.Kind.EDIT_PAGE,
        summary=f"Editó la página «{page.name}»"[:300],
        payload=payload or {},
        result={
            "page_id": str(page.id),
            "project_id": str(project.id),
            "name": page.name,
            "path": f"/{ctx.slug}/projects/{project.id}/pages/{page.id}/",
            # What it was, to put it back; the words after, to refuse once someone edits again
            "before_html": before_html,
            "text": plain_text(after_html)[:20_000],
        },
    )


def _undo_page_edit(action: AssistantAction, user, cookie: str):
    from plane.utils.assistant_markdown import plain_text
    from plane.utils.assistant_pages import PageUnavailable, find_page, write_page_html
    from plane.utils.entities import AccessContext
    from plane.utils.references import sync_mentions

    result = action.result or {}
    ctx = AccessContext.build(action.workspace.slug, user)
    try:
        page, project = find_page(ctx, user, result.get("page_id"), for_edit=True)
    except PageUnavailable as error:
        raise ActionError(str(error))
    if plain_text(page.description_html)[:20_000] != result.get("text"):
        raise ActionError("Someone edited this page after the change; undo it from the page's version history.")
    before_html = result.get("before_html") or "<p></p>"
    try:
        write_page_html(page, project, before_html, user, cookie)
    except PageUnavailable as error:
        raise ActionError(str(error))
    sync_mentions(action.workspace_id, "page", str(page.id), before_html, user.id)


@transaction.atomic
def undo(action: AssistantAction, user, origin: str, cookie: str = "") -> AssistantAction:
    if action.status != AssistantAction.Status.APPLIED:
        raise ActionError("This change was already undone.")
    if action.kind in (AssistantAction.Kind.TAG_ITEMS, AssistantAction.Kind.UNTAG_ITEMS):
        _undo_tagging(action)
    elif action.kind == AssistantAction.Kind.CREATE_WORK_ITEM:
        _undo_work_item(action, user, origin)
    elif action.kind == AssistantAction.Kind.CREATE_PAGE:
        _undo_page(action)
    elif action.kind == AssistantAction.Kind.EDIT_PAGE:
        _undo_page_edit(action, user, cookie)
    elif action.kind in PDF_KINDS:
        from plane.utils.assistant_pdf import undo_pdf

        undo_pdf(action)
    action.status = AssistantAction.Status.UNDONE
    action.undone_at = timezone.now()
    action.undone_by = user
    action.save(update_fields=["status", "undone_at", "undone_by", "updated_at"])
    return action


def action_payload(action: AssistantAction) -> dict:
    return {
        "id": str(action.id),
        "kind": action.kind,
        "status": action.status,
        "summary": action.summary,
        # The page as it was before an edit stays on the server (it can be large)
        "result": {key: value for key, value in (action.result or {}).items() if key != "before_html"},
        "created_at": action.created_at.isoformat(),
        "created_by": str(action.created_by_id) if action.created_by_id else None,
        "undone_at": action.undone_at.isoformat() if action.undone_at else None,
    }
