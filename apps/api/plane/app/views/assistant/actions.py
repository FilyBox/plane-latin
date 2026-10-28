# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Approved changes from the assistant's cards, and undoing them."""

from uuid import UUID

from django.db import connection, transaction
from rest_framework import status
from rest_framework.response import Response

from plane.app.permissions import ROLE, allow_permission
from plane.app.views.base import BaseAPIView
from plane.db.models import AssistantAction, AssistantChat, TaggingRun, User, WorkspaceMember
from plane.utils.assistant_actions import (
    ActionError,
    action_payload,
    create_page,
    create_work_item,
    edit_page,
    tag_items,
    undo,
)
from plane.utils.assistant_pdf import edit_pdf_pages, merge_pdf, split_pdf
from plane.utils.host import base_host


def _context(request, slug):
    from plane.utils.entities import AccessContext

    return AccessContext.build(slug, request.user)


def _is_admin(request, slug) -> bool:
    member = WorkspaceMember.objects.filter(workspace__slug=slug, member=request.user, is_active=True).first()
    return bool(member and member.role >= ROLE.ADMIN.value)


def _merge_payload(run) -> dict:
    """A tag merge confirmed from the assistant (recorded as a mapping run)."""
    merge = (run.scope or {}).get("merge") or {}
    variants = ", ".join(merge.get("variants") or [])
    return {
        "id": str(run.id),
        "kind": "MERGE_TAGS",
        "status": "UNDONE" if run.status == TaggingRun.Status.UNDONE else "APPLIED",
        "summary": f"Unificó {variants} en «{merge.get('keep', '')}»"[:300],
        "result": {"keep": merge.get("keep"), "variants": merge.get("variants") or []},
        "created_at": run.created_at.isoformat(),
        "created_by": str(run.created_by_id) if run.created_by_id else None,
        "undone_at": None,
    }


class AssistantActionsEndpoint(BaseAPIView):
    @allow_permission([ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def get(self, request, slug):
        """Recent changes made through the assistant: the user's own, or the
        whole workspace's for admins (?scope=all). Tag merges confirmed from
        the chat are included (they live as mapping runs)."""
        calls = [value for value in (request.query_params.get("tool_call_ids") or "").split(",") if value][:200]
        if calls:
            # What each card of a chat did, so a reopened chat (any tab) shows it
            found = AssistantAction.objects.filter(
                workspace__slug=slug, created_by=request.user, tool_call_id__in=calls
            )
            return Response(
                {"outcomes": {action.tool_call_id: action_payload(action) for action in found}},
                status=status.HTTP_200_OK,
            )
        everyone = request.query_params.get("scope") == "all" and _is_admin(request, slug)
        actions = AssistantAction.objects.filter(workspace__slug=slug)
        merges = TaggingRun.objects.filter(workspace__slug=slug, scope__source="assistant")
        if not everyone:
            actions = actions.filter(created_by=request.user)
            merges = merges.filter(created_by=request.user)
        rows = [action_payload(action) for action in actions.select_related("created_by")[:50]]
        rows += [_merge_payload(run) for run in merges[:50]]
        rows.sort(key=lambda row: row["created_at"], reverse=True)
        rows = rows[:50]
        names = {
            str(user.id): user.display_name or user.first_name or user.email
            for user in User.objects.filter(id__in={row["created_by"] for row in rows if row["created_by"]})
        }
        for row in rows:
            row["actor"] = names.get(row["created_by"] or "", "")
        return Response({"actions": rows, "can_see_all": _is_admin(request, slug)}, status=status.HTTP_200_OK)

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def post(self, request, slug):
        ctx = _context(request, slug)
        if ctx is None:
            return Response({"error": "Not a member of this workspace"}, status=status.HTTP_403_FORBIDDEN)
        data = request.data if isinstance(request.data, dict) else {}
        handler = HANDLERS.get(data.get("kind"))
        if handler is None:
            return Response({"error": "Unknown action"}, status=status.HTTP_400_BAD_REQUEST)
        tool_call_id = str(data.get("tool_call_id") or "")[:100]
        chat = (
            AssistantChat.objects.filter(
                id=data.get("chat_id"), workspace_id=ctx.workspace_id, user=request.user
            ).first()
            if _is_uuid(data.get("chat_id"))
            else None
        )
        try:
            with transaction.atomic():
                if tool_call_id:
                    # One card, one change: a second apply (another tab, a double
                    # click) waits for the first and gets its result back.
                    with connection.cursor() as cursor:
                        cursor.execute(
                            "SELECT pg_advisory_xact_lock(hashtext(%s))",
                            [f"assistant-action:{ctx.workspace_id}:{tool_call_id}"],
                        )
                    existing = AssistantAction.objects.filter(
                        workspace_id=ctx.workspace_id, tool_call_id=tool_call_id
                    ).first()
                    if existing is not None:
                        return Response(action_payload(existing), status=status.HTTP_200_OK)
                action = handler(ctx, request, data)
                if tool_call_id or chat:
                    action.tool_call_id = tool_call_id
                    action.chat = chat
                    action.save(update_fields=["tool_call_id", "chat", "updated_at"])
        except ActionError as error:
            return Response(_error_body(error), status=status.HTTP_400_BAD_REQUEST)
        return Response(action_payload(action), status=status.HTTP_201_CREATED)


def _error_body(error) -> dict:
    """The message, plus a code and its params when the web translates it
    (missing_value, missing_signer…) or where an anchor was found."""
    body = {"error": str(error)}
    if getattr(error, "code", None):
        body = {**getattr(error, "params", {}), **body, "code": error.code}
    if getattr(error, "detail", None):
        body["detail"] = error.detail
    return body


def _is_uuid(value) -> bool:
    try:
        UUID(str(value))
        return True
    except ValueError:
        return False


def _origin(request) -> str:
    return base_host(request=request, is_app=True)


# kind → how to apply it. Each returns the AssistantAction it recorded.
HANDLERS = {
    AssistantAction.Kind.TAG_ITEMS: lambda ctx, request, data: tag_items(
        ctx,
        request.user,
        tag_id=data.get("tag_id"),
        tag_name=data.get("tag_name"),
        items=data.get("items"),
        payload=data,
    ),
    AssistantAction.Kind.UNTAG_ITEMS: lambda ctx, request, data: tag_items(
        ctx,
        request.user,
        tag_id=data.get("tag_id"),
        tag_name=data.get("tag_name"),
        items=data.get("items"),
        remove=True,
        payload=data,
    ),
    AssistantAction.Kind.CREATE_WORK_ITEM: lambda ctx, request, data: create_work_item(
        ctx, request.user, data, _origin(request), payload=data
    ),
    AssistantAction.Kind.CREATE_PAGE: lambda ctx, request, data: create_page(ctx, request.user, data, payload=data),
    # The live server loads and saves the page as this person
    AssistantAction.Kind.EDIT_PAGE: lambda ctx, request, data: edit_page(
        ctx, request.user, data, request.META.get("HTTP_COOKIE", ""), payload=data
    ),
    AssistantAction.Kind.SPLIT_PDF: lambda ctx, request, data: split_pdf(ctx, request.user, data, payload=data),
    AssistantAction.Kind.MERGE_PDF: lambda ctx, request, data: merge_pdf(ctx, request.user, data, payload=data),
    AssistantAction.Kind.EDIT_PDF_PAGES: lambda ctx, request, data: edit_pdf_pages(
        ctx, request.user, data, payload=data
    ),
}


class AssistantActionUndoEndpoint(BaseAPIView):
    @allow_permission([ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def post(self, request, slug, action_id):
        action = AssistantAction.objects.filter(workspace__slug=slug, id=action_id).first()
        if action is None:
            return Response({"error": "Not found"}, status=status.HTTP_404_NOT_FOUND)
        member = WorkspaceMember.objects.filter(workspace__slug=slug, member=request.user, is_active=True).first()
        is_admin = bool(member and member.role >= ROLE.ADMIN.value)
        # Whoever made the change undoes it (or an admin).
        if action.created_by_id != request.user.id and not is_admin:
            return Response({"error": "Only who made this change can undo it"}, status=status.HTTP_403_FORBIDDEN)
        try:
            undo(action, request.user, base_host(request=request, is_app=True), request.META.get("HTTP_COOKIE", ""))
        except ActionError as error:
            return Response({"error": str(error)}, status=status.HTTP_409_CONFLICT)
        action.refresh_from_db()
        return Response(action_payload(action), status=status.HTTP_200_OK)


def _register_workspace_actions():
    """Edits across modules register themselves (contracts, work items, files…)."""
    from plane.utils.assistant_workspace import APPLY_HANDLERS

    HANDLERS.update(APPLY_HANDLERS)


_register_workspace_actions()
