# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Workspace AI assistant. Django owns auth and feature gating; the agent
itself (AI SDK streamText + tools) runs in the Cloudflare Worker. This
endpoint pipes the Worker's UI-message SSE stream back to the browser so
assistant-ui's transport can consume it with the user's normal session —
no CORS, no browser-held worker secrets.
"""

import re

from django.core.cache import cache
from django.http import StreamingHttpResponse
from django.utils import timezone
from rest_framework import status
from rest_framework.response import Response

from plane.app.permissions import ROLE, allow_permission
from plane.app.views.base import BaseAPIView
from plane.db.models import Workspace, WorkspaceFeature, WorkspaceMember
from plane.utils.exception_logger import log_exception
from plane.utils.streaming import proxy_stream
from plane.utils.worker_client import (
    WorkerTriggerError,
    get_assistant_balance,
    get_assistant_models,
    stream_assistant_chat,
)


def _assistant_enabled(workspace):
    """The assistant spans the AI modules: available when either is on."""
    return WorkspaceFeature.objects.filter(
        workspace=workspace,
        key__in=[WorkspaceFeature.FeatureKey.FILE_LIBRARY, WorkspaceFeature.FeatureKey.MUSIC_CATALOG],
        is_enabled=True,
    ).exists()


class AssistantModelsEndpoint(BaseAPIView):
    """Tool-capable models for the assistant's picker (proxied from the Worker)."""

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def get(self, request, slug):
        try:
            return Response(get_assistant_models(), status=status.HTTP_200_OK)
        except WorkerTriggerError as e:
            log_exception(e)
            return Response({"error": e.public_message}, status=status.HTTP_502_BAD_GATEWAY)


# The balance is one DeepSeek account for the whole instance; a short cache
# keeps every open panel from asking DeepSeek on each message.
BALANCE_CACHE_KEY = "assistant:deepseek-balance"
BALANCE_CACHE_SECONDS = 20


class AssistantBalanceEndpoint(BaseAPIView):
    """What is left on the AI provider account, for the composer's meter.

    Admins only: it is the company's money, not something every member needs.
    `?fresh=1` skips the cache, used right after a message finishes.
    """

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def get(self, request, slug):
        fresh = request.query_params.get("fresh") == "1"
        balance = None if fresh else cache.get(BALANCE_CACHE_KEY)
        if balance is None:
            try:
                balance = get_assistant_balance()
            except WorkerTriggerError as e:
                log_exception(e)
                return Response({"error": e.public_message}, status=status.HTTP_502_BAD_GATEWAY)
            cache.set(BALANCE_CACHE_KEY, balance, BALANCE_CACHE_SECONDS)
        return Response(balance, status=status.HTTP_200_OK)


class AssistantMusicImportEndpoint(BaseAPIView):
    """Applies (or re-simulates) an import proposal produced by the agent's
    `propose_music_import` tool. Runs under the USER's session and role — the
    model never writes to the catalog by itself.
    """

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def post(self, request, slug):
        from django.db import transaction

        from plane.app.views.music.base import MusicImportEndpoint, _apply_row_overrides, _import_error_detail
        from plane.app.views.music.internal import _load_asset_table
        from plane.db.models import FileAsset

        workspace = Workspace.objects.get(slug=slug)
        asset_id = request.data.get("asset_id")
        mapping = request.data.get("mapping") or {}
        if not asset_id or not mapping.get("track.title"):
            return Response(
                {"error": "asset_id and mapping['track.title'] are required"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        try:
            _, (headers, rows, _sheets, header_row) = _load_asset_table(
                workspace.id, asset_id, request.data.get("sheet")
            )
        except FileAsset.DoesNotExist:
            return Response({"error": "Asset not found"}, status=status.HTTP_404_NOT_FOUND)
        except Exception as exc:
            return Response({"error": f"Could not read spreadsheet: {exc}"}, status=status.HTTP_400_BAD_REQUEST)

        strategy = request.data.get("duplicate_strategy", "skip")
        dedupe_by = request.data.get("dedupe_by", "auto")
        relations_mode = request.data.get("relations_mode", "merge")
        dedupe_within_file = bool(request.data.get("dedupe_within_file", False))
        value_overrides = request.data.get("value_overrides") or {}
        invalid_row_strategy = request.data.get("invalid_row_strategy", "abort")
        if invalid_row_strategy not in ("abort", "skip"):
            return Response(
                {"invalid_row_strategy": ["Use abort or skip"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        row_overrides = request.data.get("row_overrides") or {}
        if not isinstance(row_overrides, dict):
            return Response({"row_overrides": ["Must be an object"]}, status=status.HTTP_400_BAD_REQUEST)
        dry_run = bool(request.data.get("dry_run", False))
        from plane.app.views.music.base import (
            _apply_overrides,
            _collect_unparsed,
            _create_planned_roles,
            _record_import_run,
        )

        importer = MusicImportEndpoint()
        result = {
            "total": len(rows),
            "created": 0,
            "updated": 0,
            "skipped": 0,
            "errors": [],
            "invalid_row_strategy": invalid_row_strategy,
            "aborted": False,
        }
        touched = []
        unparseable = {}
        run_created_ids = set()
        with transaction.atomic():
            for index, row in enumerate(rows, start=header_row + 1):
                effective_row, effective_mapping = _apply_row_overrides(row, mapping, row_overrides.get(str(index), {}))
                effective_row, skip_row = _apply_overrides(effective_row, effective_mapping, value_overrides)
                if skip_row:
                    result["skipped"] += 1
                    continue
                if dry_run:
                    for field, token in _collect_unparsed(effective_row, effective_mapping).items():
                        tokens = unparseable.setdefault(field, {})
                        tokens[token] = tokens.get(token, 0) + 1
                try:
                    with transaction.atomic():
                        # _import_row also returns how the row matched (unused here).
                        outcome, track, *_ = importer._import_row(
                            workspace,
                            effective_row,
                            effective_mapping,
                            strategy,
                            request.data.get("defaults") or {},
                            dedupe_by,
                            relations_mode=relations_mode if relations_mode in ("merge", "replace") else "merge",
                            exclude_ids=None if dedupe_within_file else run_created_ids,
                        )
                    result[outcome] = result.get(outcome, 0) + 1
                    if outcome == "created" and track is not None:
                        run_created_ids.add(track.id)
                    if track is not None:
                        touched.append((track.id, outcome, index))
                except Exception as exc:
                    result["errors"].append(_import_error_detail(index, exc, effective_row, effective_mapping))
            aborted = result["errors"] and invalid_row_strategy == "abort"
            # Roles named after the file's tags that the credits use
            result["new_roles"] = _create_planned_roles(
                workspace, importer._role_catalog(workspace), dry_run=bool(dry_run or aborted)
            )
            if not dry_run and not aborted:
                asset = FileAsset.objects.get(id=asset_id, workspace=workspace)
                run = _record_import_run(
                    workspace,
                    file_asset=asset,
                    source_name=(asset.attributes or {}).get("name") or asset.asset.name,
                    source="ASSISTANT",
                    sheet=request.data.get("sheet"),
                    rules={
                        "mapping": mapping,
                        "duplicate_strategy": strategy,
                        "dedupe_by": dedupe_by,
                        "relations_mode": relations_mode,
                        "dedupe_within_file": dedupe_within_file,
                        "value_overrides": value_overrides,
                    },
                    summary={k: result[k] for k in ("total", "created", "updated", "skipped")},
                    touched=touched,
                )
                result["import_run_id"] = str(run.id)
            if dry_run or aborted:
                transaction.set_rollback(True)
                result["aborted"] = bool(aborted)
        result["dry_run"] = dry_run
        if dry_run:
            result["unparseable"] = {
                field: [{"value": token, "count": count} for token, count in tokens.items()]
                for field, tokens in unparseable.items()
            }
        return Response(result, status=status.HTTP_200_OK)


def _page_context(request, slug, references_enabled):
    """What the user is looking at, so "this song" or "these contracts" make
    sense. The item's name is resolved here as this user, never taken from
    the client."""
    raw = request.data.get("context")
    if not isinstance(raw, dict):
        return None
    page = str(raw.get("page") or "")[:40]
    context = {"page": page} if page else {}
    items = raw.get("items") if isinstance(raw.get("items"), list) else []
    items = [
        {"entity_name": str(item.get("entity_name") or ""), "id": str(item.get("id") or "")}
        for item in items[:30]
        if isinstance(item, dict)
    ]
    if not references_enabled:
        return context or None
    from plane.db.models import FileTag, Issue
    from plane.utils.entities import AccessContext, resolve_entities

    ctx = AccessContext.build(slug, request.user)
    if ctx is None:
        return context or None
    # A work item opened by key (YO-1) and the open shared tag.
    issue_key = str(raw.get("issue_key") or "")
    if "-" in issue_key:
        identifier, _, sequence = issue_key.rpartition("-")
        issue = (
            Issue.issue_objects.filter(
                workspace_id=ctx.workspace_id, project__identifier__iexact=identifier, sequence_id=sequence
            ).first()
            if sequence.isdigit()
            else None
        )
        if issue is not None:
            items.insert(0, {"entity_name": "issue", "id": str(issue.id)})
    tag_id = str(raw.get("tag_id") or "")
    if tag_id:
        try:
            tag = FileTag.objects.filter(workspace_id=ctx.workspace_id, id=tag_id).first()
        except Exception:
            tag = None
        if tag is not None:
            context["tag"] = {"id": str(tag.id), "name": tag.name, "path": f"/{slug}/tags/{tag.id}"}
    if items:
        context["items"] = [
            {key: card.get(key) for key in ("entity_name", "id", "title", "subtitle", "path")}
            for card in resolve_entities(ctx, items)
            if card.get("status") == "ok"
        ]
    return context or None


# A mention written by the composer: :type[label]{name=uuid}
MENTION_RE = re.compile(r":([a-z_]{2,20})\[([^\]\n]{1,160})\]\{name=([0-9a-fA-F-]{36})\}")
MAX_MENTIONS = 10


def _mentions(request, slug, messages, references_enabled):
    """The items the user mentioned with @ in their latest message, resolved
    as this user: what they can't open is dropped, names come from the
    database, never from the message."""
    if not references_enabled:
        return []
    last = next(
        (message for message in reversed(messages) if isinstance(message, dict) and message.get("role") == "user"), None
    )
    if last is None:
        return []
    text = " ".join(
        str(part.get("text") or "")
        for part in last.get("parts") or []
        if isinstance(part, dict) and part.get("type") == "text"
    )
    found = []
    for kind, _label, item_id in MENTION_RE.findall(text):
        if (kind, item_id) not in found:
            found.append((kind, item_id))
    if not found:
        return []
    from plane.db.models import FileTag
    from plane.utils.entities import AccessContext, resolve_entities

    ctx = AccessContext.build(slug, request.user)
    if ctx is None:
        return []
    found = found[:MAX_MENTIONS]
    tags = {
        str(tag.id): tag
        for tag in FileTag.objects.filter(
            workspace_id=ctx.workspace_id, id__in=[item_id for kind, item_id in found if kind == "tag"]
        )
    }
    cards = {
        (card["entity_name"], str(card["id"])): card
        for card in resolve_entities(
            ctx, [{"entity_name": kind, "id": item_id} for kind, item_id in found if kind != "tag"]
        )
        if card.get("status") == "ok"
    }
    resolved = []
    for kind, item_id in found:
        if kind == "tag":
            tag = tags.get(item_id.lower())
            if tag is not None:
                resolved.append(
                    {
                        "entity_name": "tag",
                        "id": str(tag.id),
                        "title": tag.name,
                        "subtitle": tag.kind,
                        "path": f"/{slug}/tags/{tag.id}",
                    }
                )
            continue
        card = cards.get((kind, item_id.lower())) or cards.get((kind, item_id))
        if card is not None:
            resolved.append({key: card.get(key) for key in ("entity_name", "id", "title", "subtitle", "path")})
    return resolved


def _last_user_text(messages) -> str:
    last = next((m for m in reversed(messages) if isinstance(m, dict) and m.get("role") == "user"), None)
    if last is None:
        return ""
    text = " ".join(
        str(part.get("text") or "")
        for part in last.get("parts") or []
        if isinstance(part, dict) and part.get("type") == "text"
    )
    # Mentions read as their names.
    return MENTION_RE.sub(lambda match: match.group(2), text)


def _memory(request, slug, messages, context, mentions):
    """Workspace memory for this turn: the pinned block plus what this message
    is about (aliases said, items on screen or mentioned, keywords)."""
    from plane.utils.assistant_memory import memory_context
    from plane.utils.entities import AccessContext

    ctx = AccessContext.build(slug, request.user)
    if ctx is None:
        return {"pinned": [], "relevant": []}
    keys = {(item["entity_name"], str(item["id"])) for item in (context or {}).get("items") or []}
    keys |= {(item["entity_name"], str(item["id"])) for item in mentions}
    if (context or {}).get("tag"):
        keys.add(("tag", context["tag"]["id"]))
    return memory_context(ctx.workspace_id, ctx, _last_user_text(messages), keys)


class AssistantChatEndpoint(BaseAPIView):
    @allow_permission([ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def post(self, request, slug):
        workspace = Workspace.objects.get(slug=slug)
        if not _assistant_enabled(workspace):
            return Response(
                {"error": "The AI assistant is not enabled for this workspace"},
                status=status.HTTP_403_FORBIDDEN,
            )

        messages = request.data.get("messages")
        if not isinstance(messages, list) or not messages:
            return Response({"error": "messages must be a non-empty list"}, status=status.HTTP_400_BAD_REQUEST)

        enabled = set(
            WorkspaceFeature.objects.filter(workspace=workspace, is_enabled=True).values_list("key", flat=True)
        )
        member = WorkspaceMember.objects.filter(workspace=workspace, member=request.user, is_active=True).first()
        is_admin = bool(member and member.role >= ROLE.ADMIN.value)
        payload = {
            "workspace_id": str(workspace.id),
            "workspace_slug": slug,
            "messages": messages,
            "model": (request.data.get("model") or "").strip() or None,
            "locale": (request.data.get("locale") or "").strip() or None,
            # Lookups across modules are answered as this user (their role
            # decides what the assistant may name).
            "user_id": str(request.user.id),
            "user_name": request.user.display_name or request.user.first_name or "",
            "today": timezone.localdate().isoformat(),
            # Which tool families the agent may use, from the flags and the
            # user's role: the music catalog is admin-only everywhere else, so
            # members never get its tools (or buttons they cannot use).
            "capabilities": {
                "contracts": WorkspaceFeature.FeatureKey.FILE_LIBRARY in enabled,
                "music": WorkspaceFeature.FeatureKey.MUSIC_CATALOG in enabled and is_admin,
                "references": WorkspaceFeature.FeatureKey.REFERENCES in enabled,
                # Merging tags and starting an AI mapping are admin actions
                # on the tags page too.
                "tag_admin": WorkspaceFeature.FeatureKey.REFERENCES in enabled and is_admin,
                # Admins save memories; members can only suggest them.
                "memory_admin": is_admin,
                # Reading every contract costs real money: admins only.
                "deep_review": WorkspaceFeature.FeatureKey.FILE_LIBRARY in enabled and is_admin,
            },
            "context": _page_context(request, slug, WorkspaceFeature.FeatureKey.REFERENCES in enabled),
            "mentions": _mentions(request, slug, messages, WorkspaceFeature.FeatureKey.REFERENCES in enabled),
        }
        payload["memory"] = _memory(request, slug, messages, payload["context"], payload["mentions"])

        try:
            upstream = stream_assistant_chat(payload)
        except WorkerTriggerError as e:
            log_exception(e)
            return Response({"error": e.public_message}, status=status.HTTP_502_BAD_GATEWAY)

        response = StreamingHttpResponse(
            proxy_stream(request, upstream),
            content_type=upstream.headers.get("Content-Type", "text/event-stream"),
            status=upstream.status_code,
        )
        # SSE must not be buffered by intermediaries (nginx) or Django caching
        response["Cache-Control"] = "no-cache"
        response["X-Accel-Buffering"] = "no"
        return response
