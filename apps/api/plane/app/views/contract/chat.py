# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Chat over contracts. GENERAL mode answers with RAG over the workspace's
vectorized chunks (ranked by cosine similarity); CONTRACT mode is scoped to a
single contract whose full extracted text is passed as system context. The AI
call itself runs in the Cloudflare Worker — Django only owns auth, history and
persistence.
"""

# Django imports
from django.db import transaction
from django.http import StreamingHttpResponse

# Third party imports
from rest_framework import status
from rest_framework.response import Response

# Module imports
from plane.app.permissions import ROLE, allow_permission
from plane.app.serializers import ContractChatMessageSerializer, ContractChatSerializer
from plane.db.models import Contract, ContractChat, ContractChatMessage, Workspace
from plane.utils.exception_logger import log_exception
from plane.utils.worker_client import (
    WorkerTriggerError,
    chat_with_contracts,
    get_contracts_agent_models,
    stream_contracts_agent,
)

from ..file_library.base import FileLibraryBaseView

# How many previous turns travel to the model with each new message
HISTORY_LIMIT = 12


class ContractChatModelsEndpoint(FileLibraryBaseView):
    """Selectable chat models, proxied from the Worker's env-driven list.

    Defaults to the agent's tool-capable model rather than the old one-shot
    chat default — a model without tool support cannot drive this chat.
    """

    model = ContractChat

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def get(self, request, slug):
        try:
            return Response(get_contracts_agent_models(), status=status.HTTP_200_OK)
        except WorkerTriggerError as e:
            log_exception(e)
            return Response({"error": e.public_message}, status=status.HTTP_502_BAD_GATEWAY)


class ContractChatsEndpoint(FileLibraryBaseView):
    serializer_class = ContractChatSerializer
    model = ContractChat

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def get(self, request, slug):
        chats = ContractChat.objects.filter(workspace__slug=slug, user=request.user)
        contract_id = request.query_params.get("contract_id")
        if contract_id:
            chats = chats.filter(contract_id=contract_id)
        mode = request.query_params.get("mode")
        if mode:
            chats = chats.filter(mode=mode)
        return Response(ContractChatSerializer(chats[:50], many=True).data, status=status.HTTP_200_OK)

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def post(self, request, slug):
        workspace = Workspace.objects.get(slug=slug)
        mode = request.data.get("mode", ContractChat.Mode.GENERAL)
        if mode not in ContractChat.Mode.values:
            return Response({"error": "invalid mode"}, status=status.HTTP_400_BAD_REQUEST)
        contract = None
        if mode == ContractChat.Mode.CONTRACT:
            contract = Contract.objects.filter(id=request.data.get("contract_id"), workspace=workspace).first()
            if contract is None:
                return Response({"error": "contract_id is required for CONTRACT mode"}, status=status.HTTP_400_BAD_REQUEST)
        chat = ContractChat.objects.create(
            workspace=workspace,
            user=request.user,
            mode=mode,
            contract=contract,
            title=(request.data.get("title") or "")[:255],
        )
        return Response(ContractChatSerializer(chat).data, status=status.HTTP_201_CREATED)


class ContractChatDetailEndpoint(FileLibraryBaseView):
    serializer_class = ContractChatMessageSerializer
    model = ContractChatMessage

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def get(self, request, slug, chat_id):
        chat = ContractChat.objects.get(id=chat_id, workspace__slug=slug, user=request.user)
        messages = chat.messages.all()
        return Response(
            {
                "chat": ContractChatSerializer(chat).data,
                "messages": ContractChatMessageSerializer(messages, many=True).data,
            },
            status=status.HTTP_200_OK,
        )

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def delete(self, request, slug, chat_id):
        chat = ContractChat.objects.get(id=chat_id, workspace__slug=slug, user=request.user)
        chat.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class ContractChatMessageEndpoint(FileLibraryBaseView):
    serializer_class = ContractChatMessageSerializer
    model = ContractChatMessage

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def post(self, request, slug, chat_id):
        chat = ContractChat.objects.select_related("contract").get(
            id=chat_id, workspace__slug=slug, user=request.user
        )
        content = (request.data.get("message") or "").strip()
        if not content:
            return Response({"error": "message is required"}, status=status.HTTP_400_BAD_REQUEST)

        history = [
            {"role": message.role.lower(), "content": message.content}
            for message in chat.messages.order_by("-created_at")[:HISTORY_LIMIT][::-1]
        ]

        user_message = ContractChatMessage.objects.create(
            workspace=chat.workspace,
            chat=chat,
            role=ContractChatMessage.Role.USER,
            content=content,
        )
        # First message titles the chat
        if not chat.title:
            chat.title = content[:255]
        chat.save(update_fields=["title", "updated_at"])

        try:
            result = chat_with_contracts(
                workspace_id=chat.workspace_id,
                mode=chat.mode,
                query=content,
                history=history,
                contract_id=chat.contract_id,
                model=(request.data.get("model") or "").strip() or None,
            )
        except WorkerTriggerError as e:
            log_exception(e)
            return Response(
                {
                    "user_message": ContractChatMessageSerializer(user_message).data,
                    "error": e.public_message,
                },
                status=status.HTTP_502_BAD_GATEWAY,
            )

        assistant_message = ContractChatMessage.objects.create(
            workspace=chat.workspace,
            chat=chat,
            role=ContractChatMessage.Role.ASSISTANT,
            content=result.get("answer") or "",
            sources=result.get("sources") or [],
        )
        return Response(
            {
                "user_message": ContractChatMessageSerializer(user_message).data,
                "assistant_message": ContractChatMessageSerializer(assistant_message).data,
            },
            status=status.HTTP_200_OK,
        )


# ---------------------------------------------------------------------------
# Agent runtime
#
# The endpoints above are the legacy single-shot RAG turn. The agent below is
# the real one: Django owns auth, workspace scoping and persistence, while the
# Cloudflare Worker runs an AI SDK agent that decides which tools to call
# (structured search, excerpts, sub-agent summaries) and streams the result
# back through this proxy.
# ---------------------------------------------------------------------------

# How much conversation travels upstream. Older turns keep their text but lose
# their tool payloads: a single find_contracts result can be tens of thousands
# of characters, and replaying five of them is what pushed the old chat over
# the model's context limit mid-conversation.
AGENT_MESSAGE_LIMIT = 24
AGENT_FULL_TOOL_OUTPUT_TURNS = 4
PRUNED_OUTPUT = {"pruned": True, "note": "Resultado antiguo omitido; vuelve a llamar la tool si lo necesitas."}


def _prune_messages(messages):
    """Trims the conversation the browser replays on every turn.

    assistant-ui sends the whole thread with each request, tool results
    included. We keep the last `AGENT_MESSAGE_LIMIT` messages and blank out
    tool outputs older than the most recent few, which keeps the token cost of
    a long chat roughly flat instead of growing with every document the agent
    has ever looked at.
    """
    trimmed = messages[-AGENT_MESSAGE_LIMIT:]
    keep_from = max(0, len(trimmed) - AGENT_FULL_TOOL_OUTPUT_TURNS)
    pruned = []
    for index, message in enumerate(trimmed):
        if not isinstance(message, dict):
            continue
        parts = message.get("parts")
        if index >= keep_from or not isinstance(parts, list):
            pruned.append(message)
            continue
        message = {**message, "parts": [_prune_part(part) for part in parts]}
        pruned.append(message)
    return pruned


def _prune_part(part):
    if not isinstance(part, dict):
        return part
    part_type = str(part.get("type") or "")
    is_tool = part_type.startswith("tool-") or part_type == "dynamic-tool"
    if is_tool and part.get("state") == "output-available":
        return {**part, "output": PRUNED_OUTPUT}
    return part


class ContractAgentChatEndpoint(FileLibraryBaseView):
    """Streams one agent turn. The response body is the Worker's UI-message SSE
    stream piped straight through, so assistant-ui consumes it with the user's
    own session (no CORS, no worker secret in the browser).
    """

    model = ContractChat

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def post(self, request, slug):
        workspace = Workspace.objects.get(slug=slug)

        messages = request.data.get("messages")
        if not isinstance(messages, list) or not messages:
            return Response({"error": "messages must be a non-empty list"}, status=status.HTTP_400_BAD_REQUEST)

        # Mode/contract come from the chat when one exists, so a CONTRACT chat
        # can never be widened into a workspace-wide search from the client.
        mode = request.data.get("mode") or ContractChat.Mode.GENERAL
        contract_id = request.data.get("contract_id")
        chat_id = request.data.get("chat_id")
        if chat_id:
            chat = ContractChat.objects.filter(id=chat_id, workspace=workspace, user=request.user).first()
            if chat is None:
                return Response({"error": "chat not found"}, status=status.HTTP_404_NOT_FOUND)
            mode = chat.mode
            contract_id = chat.contract_id
        if mode not in ContractChat.Mode.values:
            return Response({"error": "invalid mode"}, status=status.HTTP_400_BAD_REQUEST)
        if mode == ContractChat.Mode.CONTRACT:
            if not Contract.objects.filter(id=contract_id, workspace=workspace).exists():
                return Response(
                    {"error": "contract_id is required for CONTRACT mode"}, status=status.HTTP_400_BAD_REQUEST
                )

        payload = {
            "workspace_id": str(workspace.id),
            "workspace_slug": slug,
            "mode": mode,
            "contract_id": str(contract_id) if contract_id else None,
            "messages": _prune_messages(messages),
            "model": (request.data.get("model") or "").strip() or None,
            "locale": (request.data.get("locale") or "").strip() or None,
        }

        try:
            upstream = stream_contracts_agent(payload)
        except WorkerTriggerError as e:
            log_exception(e)
            return Response({"error": e.public_message}, status=status.HTTP_502_BAD_GATEWAY)

        response = StreamingHttpResponse(
            upstream.iter_content(chunk_size=None),
            content_type=upstream.headers.get("Content-Type", "text/event-stream"),
            status=upstream.status_code,
        )
        # SSE must not be buffered by intermediaries (nginx) or Django caching
        response["Cache-Control"] = "no-cache"
        response["X-Accel-Buffering"] = "no"
        return response


class ContractChatTurnEndpoint(FileLibraryBaseView):
    """Persists the conversation after a run settles.

    The stream itself is stateless, so the client posts the transcript here
    once a run finishes. It replaces the stored messages rather than appending
    them: the browser holds the authoritative thread, and a regenerate or an
    edited turn rewrites history rather than adding to it — appending would
    leave the superseded answer behind. Storing `parts` (not just text) is what
    lets a reopened chat replay the document cards the agent produced.
    """

    serializer_class = ContractChatMessageSerializer
    model = ContractChatMessage

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def post(self, request, slug, chat_id):
        chat = ContractChat.objects.filter(id=chat_id, workspace__slug=slug, user=request.user).first()
        if chat is None:
            return Response({"error": "chat not found"}, status=status.HTTP_404_NOT_FOUND)

        turns = request.data.get("messages")
        if not isinstance(turns, list) or not turns:
            return Response({"error": "messages must be a non-empty list"}, status=status.HTTP_400_BAD_REQUEST)

        rows = []
        for position, turn in enumerate(turns):
            if not isinstance(turn, dict):
                continue
            role = str(turn.get("role") or "").upper()
            if role not in ContractChatMessage.Role.values:
                continue
            parts = turn.get("parts") if isinstance(turn.get("parts"), list) else []
            text = "\n\n".join(
                str(part.get("text") or "")
                for part in parts
                if isinstance(part, dict) and part.get("type") == "text" and part.get("text")
            )
            rows.append(
                ContractChatMessage(
                    workspace=chat.workspace,
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
            # Hard delete: these rows are a cache of the client transcript, and
            # soft-deleted copies would pile up on every turn of every chat.
            ContractChatMessage.objects.filter(chat=chat).delete(soft=False)
            created = ContractChatMessage.objects.bulk_create(rows, batch_size=100)

            if not chat.title:
                first_user = next((row for row in rows if row.role == ContractChatMessage.Role.USER), None)
                if first_user and first_user.content:
                    chat.title = first_user.content[:255]
            chat.save(update_fields=["title", "updated_at"])

        return Response(
            {"messages": ContractChatMessageSerializer(created, many=True).data},
            status=status.HTTP_201_CREATED,
        )
