# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""The assistant's workspace memory: admins write it, members suggest.

Nothing here deletes: a memory is archived (and can come back), and every
change leaves a revision.
"""

from datetime import date

from rest_framework import status
from rest_framework.response import Response

from plane.app.permissions import ROLE, allow_permission
from plane.app.views.base import BaseAPIView
from plane.app.views.contract.internal import InternalBaseView
from plane.db.models import AssistantChat, AssistantMemory, User, Workspace, WorkspaceMember
from plane.utils.assistant_memory import (
    MAX_ACTIVE,
    MAX_PINNED,
    activate,
    archive,
    clean_aliases,
    clean_content,
    clean_details,
    clean_entities,
    memory_payload,
    record,
    search,
)

STATUS_FILTERS = {
    "active": [AssistantMemory.Status.ACTIVE],
    "proposed": [AssistantMemory.Status.PROPOSED],
    "archived": [AssistantMemory.Status.ARCHIVED, AssistantMemory.Status.REJECTED],
}


def _is_admin(user, workspace) -> bool:
    member = WorkspaceMember.objects.filter(workspace=workspace, member=user, is_active=True).first()
    return bool(member and member.role >= ROLE.ADMIN.value)


def _parse_date(value):
    if not value:
        return None
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


def _limits_error(workspace_id, *, activating: bool, pinning: bool, exclude_id=None):
    active = AssistantMemory.objects.filter(workspace_id=workspace_id, status=AssistantMemory.Status.ACTIVE)
    if exclude_id:
        active = active.exclude(id=exclude_id)
    if activating and active.count() >= MAX_ACTIVE:
        return f"The workspace already has {MAX_ACTIVE} active memories; archive some first."
    if pinning and active.filter(pinned=True).count() >= MAX_PINNED:
        return f"At most {MAX_PINNED} memories can be pinned."
    return None


class AssistantMemoriesEndpoint(BaseAPIView):
    @allow_permission([ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def get(self, request, slug):
        workspace = Workspace.objects.get(slug=slug)
        admin = _is_admin(request.user, workspace)
        wanted = request.query_params.get("status", "active")
        statuses = STATUS_FILTERS.get(wanted, STATUS_FILTERS["active"])
        memories = AssistantMemory.objects.filter(workspace=workspace, status__in=statuses)
        # Members see what is active, plus the suggestions they made.
        if not admin and wanted != "active":
            memories = memories.filter(created_by=request.user)
        return Response(
            {"memories": [memory_payload(memory) for memory in memories[:500]], "can_edit": admin},
            status=status.HTTP_200_OK,
        )

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def post(self, request, slug):
        workspace = Workspace.objects.get(slug=slug)
        admin = _is_admin(request.user, workspace)
        data = request.data
        content = clean_content(data.get("content"))
        if not content:
            return Response({"error": "content is required"}, status=status.HTTP_400_BAD_REQUEST)
        kind = data.get("kind") if data.get("kind") in AssistantMemory.Kind.values else AssistantMemory.Kind.FACT
        # Admins save straight away unless they ask for a draft; members suggest.
        activating = admin and data.get("status") != AssistantMemory.Status.PROPOSED
        pinned = bool(data.get("pinned")) and admin
        error = _limits_error(workspace.id, activating=activating, pinning=pinned and activating)
        if error:
            return Response({"error": error}, status=status.HTTP_400_BAD_REQUEST)
        supersedes = None
        if data.get("supersedes"):
            supersedes = AssistantMemory.objects.filter(workspace=workspace, id=data["supersedes"]).first()
        source_chat = None
        if data.get("source_chat"):
            source_chat = AssistantChat.objects.filter(
                workspace=workspace, user=request.user, id=data["source_chat"]
            ).first()
        memory = AssistantMemory.objects.create(
            workspace=workspace,
            kind=kind,
            content=content,
            details=clean_details(data.get("details")),
            aliases=clean_aliases(data.get("aliases")),
            entities=clean_entities(data.get("entities")),
            pinned=pinned,
            valid_until=_parse_date(data.get("valid_until")),
            supersedes=supersedes,
            source=AssistantMemory.Source.ASSISTANT
            if data.get("source") == AssistantMemory.Source.ASSISTANT
            else AssistantMemory.Source.MANUAL,
            source_chat=source_chat,
            evidence=str(data.get("evidence") or "")[:1000],
            status=AssistantMemory.Status.PROPOSED,
        )
        record(memory, "created")
        if activating:
            activate(memory, request.user)
        memory.refresh_from_db()
        return Response(memory_payload(memory), status=status.HTTP_201_CREATED)


class AssistantMemoryDetailEndpoint(BaseAPIView):
    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def patch(self, request, slug, memory_id):
        """Edit, pin, approve (status ACTIVE), reject, archive or restore."""
        workspace = Workspace.objects.get(slug=slug)
        memory = AssistantMemory.objects.filter(workspace=workspace, id=memory_id).first()
        if memory is None:
            return Response({"error": "Not found"}, status=status.HTTP_404_NOT_FOUND)
        data = request.data
        new_status = data.get("status")
        if new_status and new_status not in AssistantMemory.Status.values:
            return Response({"error": "Unknown status"}, status=status.HTTP_400_BAD_REQUEST)

        changed = []
        if "content" in data:
            content = clean_content(data.get("content"))
            if not content:
                return Response({"error": "content can't be empty"}, status=status.HTTP_400_BAD_REQUEST)
            memory.content = content
            changed.append("content")
        if "details" in data:
            memory.details = clean_details(data.get("details"))
            changed.append("details")
        if data.get("kind") in AssistantMemory.Kind.values:
            memory.kind = data["kind"]
            changed.append("kind")
        if "aliases" in data:
            memory.aliases = clean_aliases(data.get("aliases"))
            changed.append("aliases")
        if "entities" in data:
            memory.entities = clean_entities(data.get("entities"))
            changed.append("entities")
        if "valid_until" in data:
            memory.valid_until = _parse_date(data.get("valid_until"))
            changed.append("valid_until")
        if "pinned" in data:
            pinning = bool(data.get("pinned"))
            if pinning and not memory.pinned:
                error = _limits_error(workspace.id, activating=False, pinning=True)
                if error:
                    return Response({"error": error}, status=status.HTTP_400_BAD_REQUEST)
            memory.pinned = pinning
            changed.append("pinned")
        if changed:
            memory.save()
            record(memory, "edited")

        if new_status == AssistantMemory.Status.ACTIVE and memory.status != AssistantMemory.Status.ACTIVE:
            error = _limits_error(workspace.id, activating=True, pinning=memory.pinned, exclude_id=memory.id)
            if error:
                return Response({"error": error}, status=status.HTTP_400_BAD_REQUEST)
            activate(memory, request.user, "approved" if memory.status == AssistantMemory.Status.PROPOSED else "restored")
        elif new_status == AssistantMemory.Status.ARCHIVED and memory.status != AssistantMemory.Status.ARCHIVED:
            archive(memory)
        elif new_status == AssistantMemory.Status.REJECTED and memory.status == AssistantMemory.Status.PROPOSED:
            memory.status = AssistantMemory.Status.REJECTED
            memory.save(update_fields=["status", "updated_at"])
            record(memory, "rejected")
        memory.refresh_from_db()
        return Response(memory_payload(memory), status=status.HTTP_200_OK)


class InternalAssistantMemorySearchEndpoint(InternalBaseView):
    """The assistant's search_memory tool, answered as the asking user."""

    def get(self, request, workspace_id):
        from plane.utils.entities import AccessContext

        workspace = Workspace.objects.filter(id=workspace_id).first()
        user = User.objects.filter(id=request.query_params.get("user_id")).first()
        if workspace is None or user is None:
            return Response({"error": "Not available"}, status=status.HTTP_403_FORBIDDEN)
        if not WorkspaceMember.objects.filter(workspace=workspace, member=user, is_active=True).exists():
            return Response({"error": "Not available"}, status=status.HTTP_403_FORBIDDEN)
        ctx = AccessContext.build(workspace.slug, user)
        query = str(request.query_params.get("q") or "")[:300]
        results = search(workspace.id, ctx, query)
        return Response(
            {
                "results": [
                    {key: row[key] for key in ("id", "kind", "content", "details", "aliases", "valid_until", "pinned")}
                    for row in results
                ]
            },
            status=status.HTTP_200_OK,
        )
