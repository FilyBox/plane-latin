# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Workspace AI assistant. Django owns auth and feature gating; the agent
itself (AI SDK streamText + tools) runs in the Cloudflare Worker. This
endpoint pipes the Worker's UI-message SSE stream back to the browser so
assistant-ui's transport can consume it with the user's normal session —
no CORS, no browser-held worker secrets.
"""

from django.http import StreamingHttpResponse
from rest_framework import status
from rest_framework.response import Response

from plane.app.permissions import ROLE, allow_permission
from plane.app.views.base import BaseAPIView
from plane.db.models import Workspace, WorkspaceFeature
from plane.utils.worker_client import WorkerTriggerError, get_assistant_models, stream_assistant_chat


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
            return Response({"error": str(e)[:300]}, status=status.HTTP_502_BAD_GATEWAY)


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
        from plane.app.views.music.base import _apply_overrides, _collect_unparsed, _record_import_run

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
        with transaction.atomic():
            for index, row in enumerate(rows, start=header_row + 1):
                effective_row, effective_mapping = _apply_row_overrides(
                    row, mapping, row_overrides.get(str(index), {})
                )
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
                        outcome, track = importer._import_row(
                            workspace,
                            effective_row,
                            effective_mapping,
                            strategy,
                            request.data.get("defaults") or {},
                            dedupe_by,
                        )
                    result[outcome] += 1
                    if track is not None:
                        touched.append((track.id, outcome, index))
                except Exception as exc:
                    result["errors"].append(
                        _import_error_detail(index, exc, effective_row, effective_mapping)
                    )
            aborted = result["errors"] and invalid_row_strategy == "abort"
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

        payload = {
            "workspace_id": str(workspace.id),
            "workspace_slug": slug,
            "messages": messages,
            "model": (request.data.get("model") or "").strip() or None,
            "locale": (request.data.get("locale") or "").strip() or None,
            # Which tool families the agent may use, derived from the flags —
            # a workspace with only contracts must not expose music tools.
            "capabilities": {
                "contracts": WorkspaceFeature.objects.filter(
                    workspace=workspace, key=WorkspaceFeature.FeatureKey.FILE_LIBRARY, is_enabled=True
                ).exists(),
                "music": WorkspaceFeature.objects.filter(
                    workspace=workspace, key=WorkspaceFeature.FeatureKey.MUSIC_CATALOG, is_enabled=True
                ).exists(),
            },
        }

        try:
            upstream = stream_assistant_chat(payload)
        except WorkerTriggerError as e:
            return Response({"error": str(e)[:300]}, status=status.HTTP_502_BAD_GATEWAY)

        response = StreamingHttpResponse(
            upstream.iter_content(chunk_size=None),
            content_type=upstream.headers.get("Content-Type", "text/event-stream"),
            status=upstream.status_code,
        )
        # SSE must not be buffered by intermediaries (nginx) or Django caching
        response["Cache-Control"] = "no-cache"
        response["X-Accel-Buffering"] = "no"
        return response
