# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Approved changes from the assistant's cards, and undoing them."""

from rest_framework import status
from rest_framework.response import Response

from plane.app.permissions import ROLE, allow_permission
from plane.app.views.base import BaseAPIView
from plane.db.models import AssistantAction, TaggingRun, User, WorkspaceMember
from plane.utils.assistant_actions import ActionError, action_payload, create_page, create_work_item, tag_items, undo
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
        kind = data.get("kind")
        try:
            if kind in (AssistantAction.Kind.TAG_ITEMS, AssistantAction.Kind.UNTAG_ITEMS):
                action = tag_items(
                    ctx,
                    request.user,
                    tag_id=data.get("tag_id"),
                    tag_name=data.get("tag_name"),
                    items=data.get("items"),
                    remove=kind == AssistantAction.Kind.UNTAG_ITEMS,
                    payload=data,
                )
            elif kind == AssistantAction.Kind.CREATE_WORK_ITEM:
                action = create_work_item(ctx, request.user, data, base_host(request=request, is_app=True), payload=data)
            elif kind == AssistantAction.Kind.CREATE_PAGE:
                action = create_page(ctx, request.user, data, payload=data)
            else:
                return Response({"error": "Unknown action"}, status=status.HTTP_400_BAD_REQUEST)
        except ActionError as error:
            return Response({"error": str(error)}, status=status.HTTP_400_BAD_REQUEST)
        return Response(action_payload(action), status=status.HTTP_201_CREATED)


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
            undo(action, request.user, base_host(request=request, is_app=True))
        except ActionError as error:
            return Response({"error": str(error)}, status=status.HTTP_409_CONFLICT)
        action.refresh_from_db()
        return Response(action_payload(action), status=status.HTTP_200_OK)
