# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Workspace assistant conversations, per user.

The stream itself is stateless: once a run settles, the client posts the
whole transcript here and it replaces what was stored (a regenerated or
edited turn rewrites history rather than appending to it).
"""

import json

from django.db import transaction
from rest_framework import status
from rest_framework.response import Response

from plane.app.permissions import ROLE, allow_permission
from plane.app.views.base import BaseAPIView
from plane.db.models import AssistantChat, AssistantChatMessage, Workspace
from plane.app.views.assistant.base import MENTION_RE

# A tool result bigger than this is kept as a short stub: the card it drew is
# rebuilt from the stub, and long tables do not bloat every saved chat.
MAX_PART_BYTES = 24_000
MAX_MESSAGES = 200
SUMMARY_KEYS = ("total", "returned", "count", "matched", "candidates", "scanned", "has_more", "created", "updated")


def _shrink_part(part):
    if not isinstance(part, dict):
        return None
    output = part.get("output")
    if output is None:
        return part
    size = len(json.dumps(output, default=str))
    if size <= MAX_PART_BYTES:
        return part
    summary = {key: output[key] for key in SUMMARY_KEYS if isinstance(output, dict) and key in output}
    return {**part, "output": {**summary, "_truncated": True}}


def _chat_payload(chat):
    return {
        "id": str(chat.id),
        "title": chat.title,
        "created_at": chat.created_at.isoformat(),
        "updated_at": chat.updated_at.isoformat(),
    }


class AssistantChatsEndpoint(BaseAPIView):
    @allow_permission([ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def get(self, request, slug):
        chats = AssistantChat.objects.filter(workspace__slug=slug, user=request.user).order_by("-updated_at")[:100]
        return Response([_chat_payload(chat) for chat in chats], status=status.HTTP_200_OK)

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def post(self, request, slug):
        workspace = Workspace.objects.get(slug=slug)
        chat = AssistantChat.objects.create(
            workspace=workspace, user=request.user, title=str(request.data.get("title") or "")[:255]
        )
        return Response(_chat_payload(chat), status=status.HTTP_201_CREATED)


class AssistantChatDetailEndpoint(BaseAPIView):
    def get_chat(self, request, slug, chat_id):
        return AssistantChat.objects.filter(id=chat_id, workspace__slug=slug, user=request.user).first()

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def get(self, request, slug, chat_id):
        chat = self.get_chat(request, slug, chat_id)
        if chat is None:
            return Response({"error": "Not found"}, status=status.HTTP_404_NOT_FOUND)
        messages = [
            {"id": str(message.id), "role": message.role.lower(), "parts": message.parts or []}
            for message in chat.messages.order_by("position")
        ]
        return Response({**_chat_payload(chat), "messages": messages}, status=status.HTTP_200_OK)

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def patch(self, request, slug, chat_id):
        chat = self.get_chat(request, slug, chat_id)
        if chat is None:
            return Response({"error": "Not found"}, status=status.HTTP_404_NOT_FOUND)
        title = " ".join(str(request.data.get("title") or "").split())[:255]
        if title:
            chat.title = title
            chat.save(update_fields=["title", "updated_at"])
        return Response(_chat_payload(chat), status=status.HTTP_200_OK)

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def delete(self, request, slug, chat_id):
        chat = self.get_chat(request, slug, chat_id)
        if chat is not None:
            chat.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class AssistantChatMessagesEndpoint(BaseAPIView):
    """Replaces the stored transcript with the one the client holds."""

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def put(self, request, slug, chat_id):
        chat = AssistantChat.objects.filter(id=chat_id, workspace__slug=slug, user=request.user).first()
        if chat is None:
            return Response({"error": "Not found"}, status=status.HTTP_404_NOT_FOUND)
        turns = request.data.get("messages")
        if not isinstance(turns, list) or not turns:
            return Response({"error": "messages must be a non-empty list"}, status=status.HTTP_400_BAD_REQUEST)

        rows = []
        for position, turn in enumerate(turns[-MAX_MESSAGES:]):
            if not isinstance(turn, dict):
                continue
            role = str(turn.get("role") or "").upper()
            if role not in AssistantChatMessage.Role.values:
                continue
            raw_parts = turn.get("parts") if isinstance(turn.get("parts"), list) else []
            parts = [part for part in (_shrink_part(part) for part in raw_parts) if part is not None]
            text = "\n\n".join(
                str(part.get("text") or "") for part in parts if part.get("type") == "text" and part.get("text")
            )
            rows.append(
                AssistantChatMessage(
                    workspace_id=chat.workspace_id,
                    chat=chat,
                    role=role,
                    content=text,
                    parts=parts,
                    position=position,
                )
            )
        if not rows:
            return Response({"error": "no valid messages"}, status=status.HTTP_400_BAD_REQUEST)

        with transaction.atomic():
            # Hard delete: the rows mirror the client transcript; soft-deleted
            # copies would pile up on every turn.
            AssistantChatMessage.objects.filter(chat=chat).delete(soft=False)
            AssistantChatMessage.objects.bulk_create(rows, batch_size=100)
            if not chat.title:
                first_user = next(
                    (row for row in rows if row.role == AssistantChatMessage.Role.USER and row.content), None
                )
                if first_user:
                    # "@3BallMTY", not the mention's :tag[3BallMTY]{name=…} form.
                    readable = MENTION_RE.sub(lambda match: match.group(2), first_user.content)
                    chat.title = " ".join(readable.split())[:80]
            chat.save(update_fields=["title", "updated_at"])
        return Response(_chat_payload(chat), status=status.HTTP_200_OK)
