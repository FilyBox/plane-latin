# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""AI mapping runs: start a scan, review what it proposes, apply or undo.

Runs are admin-only: they can touch every module's tags at once.
"""

import logging
from uuid import UUID

from django.db import transaction
from django.utils import timezone
from rest_framework import status
from rest_framework.response import Response

from plane.app.permissions import ROLE, allow_permission
from plane.app.views.contract.internal import InternalBaseView
from plane.db.models import EntityTagLink, FileTag, TaggingRun, Workspace
from plane.utils.shared_tags import merge_into, tag_payload
from plane.utils.tagging import (
    DEFAULT_TYPES,
    SCANNABLE,
    apply_run,
    context,
    count_scannable,
    inventory,
    runnable_types,
    undo_run,
)
from plane.utils.worker_client import WorkerTriggerError, trigger_tagging_run

from .base import ReferenceBaseView, _is_uuid

logger = logging.getLogger("plane.api")

# A run that never reported back is given up on after this long.
STALE_MINUTES = 60
# Variants one merge request may fold at once.
MAX_MERGE_VARIANTS = 10


def run_payload(run: TaggingRun, full: bool = False) -> dict:
    summary = run.summary or {}
    payload = {
        "id": str(run.id),
        "status": run.status,
        "scope": run.scope,
        "progress": run.progress,
        "error": run.error,
        "provider": run.provider,
        "created_at": run.created_at.isoformat(),
        "finished_at": run.finished_at.isoformat() if run.finished_at else None,
        "counts": {
            "tags": len((summary.get("proposals") or {}).get("tags") or []),
            "merges": len((summary.get("proposals") or {}).get("merges") or []),
            "applied_links": len((summary.get("applied") or {}).get("links") or []),
            "applied_merges": sum(
                len(merge.get("variants") or []) for merge in (summary.get("applied") or {}).get("merges") or []
            ),
        },
    }
    if full:
        payload["proposals"] = summary.get("proposals") or {"tags": [], "merges": []}
        payload["applied"] = summary.get("applied")
    return payload


class TaggingRunEndpoint(ReferenceBaseView):
    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def get(self, request, slug):
        ctx = self.context(slug)
        stale = timezone.now() - timezone.timedelta(minutes=STALE_MINUTES)
        TaggingRun.objects.filter(
            workspace_id=ctx.workspace_id,
            status__in=[TaggingRun.Status.QUEUED, TaggingRun.Status.RUNNING],
            updated_at__lt=stale,
        ).update(status=TaggingRun.Status.FAILED, error="La corrida dejó de responder.")
        runs = TaggingRun.objects.filter(workspace_id=ctx.workspace_id).order_by("-created_at")[:20]
        scannable, _ = runnable_types(ctx, SCANNABLE)
        requested = [value for value in request.query_params.get("types", ",".join(scannable)).split(",") if value]
        return Response(
            {
                "runs": [run_payload(run) for run in runs],
                "scannable": scannable,
                # Checked when starting: songs and releases are opt-in.
                "defaults": [value for value in DEFAULT_TYPES if value in scannable],
                "counts": count_scannable(ctx.workspace_id, [value for value in requested if value in scannable]),
            },
            status=status.HTTP_200_OK,
        )

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def post(self, request, slug):
        ctx = self.context(slug)
        if request.data.get("mode") == "merge":
            return self.start_merge(request, ctx)
        requested = request.data.get("types") or DEFAULT_TYPES
        if not isinstance(requested, (list, tuple)):
            return Response({"error": "types must be a list"}, status=status.HTTP_400_BAD_REQUEST)
        # Songs and releases only for who may open the catalog; the rest of
        # the run goes ahead and says what it left out (scope.skipped).
        types, skipped = runnable_types(ctx, [str(value) for value in requested])
        if not types:
            message = (
                "Songs and releases need the music catalog module and a workspace admin"
                if skipped
                else "Choose at least one kind of item"
            )
            return Response({"error": message, "skipped": skipped}, status=status.HTTP_400_BAD_REQUEST)
        if self.busy(ctx):
            return Response({"error": "A mapping is already running"}, status=status.HTTP_409_CONFLICT)
        run = TaggingRun.objects.create(
            workspace=Workspace.objects.get(id=ctx.workspace_id),
            scope={"types": types, **({"skipped": skipped} if skipped else {})},
            progress={"done": 0, "total": sum(count_scannable(ctx.workspace_id, types).values())},
            created_by=request.user,
        )
        return self.launch(run, ctx, types)

    @staticmethod
    def busy(ctx):
        """One run at a time: a waiting review blocks nothing, a running one does."""
        return TaggingRun.objects.filter(
            workspace_id=ctx.workspace_id, status__in=[TaggingRun.Status.QUEUED, TaggingRun.Status.RUNNING]
        ).exists()

    def start_merge(self, request, ctx):
        """"Combinar con IA": looks for duplicated tags across the workspace
        and proposes joining them; nothing changes until a person applies."""
        if self.busy(ctx):
            return Response({"error": "A mapping is already running"}, status=status.HTTP_409_CONFLICT)
        run = TaggingRun.objects.create(
            workspace=Workspace.objects.get(id=ctx.workspace_id),
            scope={"mode": "merge", "types": []},
            progress={"done": 0, "total": 0, "stage": "normalize"},
            created_by=request.user,
        )
        return self.launch(run, ctx, [], mode="merge")

    def launch(self, run, ctx, types, mode="map"):
        try:
            instance_id = trigger_tagging_run(run.id, ctx.workspace_id, types, mode=mode)
        except WorkerTriggerError as error:
            logger.exception("tagging run trigger failed")
            run.status, run.error = TaggingRun.Status.FAILED, error.public_message
            run.save(update_fields=["status", "error", "updated_at"])
            return Response({"error": error.public_message}, status=status.HTTP_502_BAD_GATEWAY)
        run.workflow_instance_id = instance_id or ""
        run.status = TaggingRun.Status.RUNNING
        run.started_at = timezone.now()
        run.save(update_fields=["workflow_instance_id", "status", "started_at", "updated_at"])
        return Response(run_payload(run), status=status.HTTP_201_CREATED)


class TaggingRunDetailEndpoint(ReferenceBaseView):
    def get_run(self, ctx, run_id):
        return TaggingRun.objects.filter(workspace_id=ctx.workspace_id, id=run_id).first()

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def get(self, request, slug, run_id):
        ctx = self.context(slug)
        run = self.get_run(ctx, run_id)
        if run is None:
            return Response({"error": "Not found"}, status=status.HTTP_404_NOT_FOUND)
        return Response(run_payload(run, full=True), status=status.HTTP_200_OK)

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def post(self, request, slug, run_id):
        """action=apply with the accepted proposals, or action=undo."""
        ctx = self.context(slug)
        run = self.get_run(ctx, run_id)
        if run is None:
            return Response({"error": "Not found"}, status=status.HTTP_404_NOT_FOUND)
        action = request.data.get("action")
        if action == "apply":
            if run.status != TaggingRun.Status.REVIEW:
                return Response({"error": "This mapping is not waiting for review"}, status=status.HTTP_409_CONFLICT)
            approved = request.data.get("approved") or {}
            if not isinstance(approved, dict):
                return Response({"error": "approved must be an object"}, status=status.HTTP_400_BAD_REQUEST)
            apply_run(run, ctx, approved, request.user.id)
        elif action == "undo":
            if run.status != TaggingRun.Status.COMPLETED:
                return Response({"error": "Only an applied mapping can be undone"}, status=status.HTTP_409_CONFLICT)
            undo_run(run)
        elif action == "discard":
            if run.status != TaggingRun.Status.REVIEW:
                return Response({"error": "This mapping is not waiting for review"}, status=status.HTTP_409_CONFLICT)
            run.status = TaggingRun.Status.CANCELLED
            run.save(update_fields=["status", "updated_at"])
        else:
            return Response({"error": "Unknown action"}, status=status.HTTP_400_BAD_REQUEST)
        run.refresh_from_db()
        return Response(run_payload(run, full=True), status=status.HTTP_200_OK)


class SharedTagMergeEndpoint(ReferenceBaseView):
    """Folds variant tags into one on request (the assistant's merge card).

    Recorded as an already-applied run, so it shows in the mapping history
    and is undone exactly like a merge an AI mapping proposed.
    """

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def post(self, request, slug):
        ctx = self.context(slug)
        keep_id = request.data.get("keep_id")
        variant_ids = [str(value) for value in request.data.get("variant_ids") or []]
        if (
            not _is_uuid(keep_id)
            or not variant_ids
            or len(variant_ids) > MAX_MERGE_VARIANTS
            or not all(_is_uuid(value) for value in variant_ids)
        ):
            return Response(
                {"error": f"keep_id and 1-{MAX_MERGE_VARIANTS} variant_ids are required"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        tags = FileTag.objects.filter(workspace_id=ctx.workspace_id)
        keep = tags.filter(id=keep_id).first()
        variants = list(tags.filter(id__in=variant_ids).exclude(id=keep_id))
        if keep is None or not variants:
            return Response({"error": "Tags not found"}, status=status.HTTP_404_NOT_FOUND)

        with transaction.atomic():
            record = {"keep_id": str(keep.id), "variants": []}
            for variant in variants:
                record["variants"].append(
                    merge_into(ctx.workspace_id, keep, variant, source=EntityTagLink.Source.MANUAL)
                )
                keep.refresh_from_db()
            now = timezone.now()
            run = TaggingRun.objects.create(
                workspace_id=ctx.workspace_id,
                status=TaggingRun.Status.COMPLETED,
                scope={"source": "assistant", "merge": {"keep": keep.name, "variants": [tag.name for tag in variants]}},
                summary={"applied": {"links": [], "created_tags": [], "merges": [record]}},
                started_at=now,
                finished_at=now,
            )
        return Response({**run_payload(run), "keep": tag_payload(keep)}, status=status.HTTP_201_CREATED)


# ------------------------------------------------------------ worker callbacks


class InternalTaggingInventoryEndpoint(InternalBaseView):
    def get(self, request, workspace_id):
        entity_type = request.query_params.get("type", "")
        if entity_type not in SCANNABLE:
            return Response({"error": "Unknown type"}, status=status.HTTP_400_BAD_REQUEST)
        try:
            offset = max(0, int(request.query_params.get("offset", 0)))
            limit = max(1, min(int(request.query_params.get("limit", 40)), 100))
        except ValueError:
            return Response({"error": "offset/limit must be integers"}, status=status.HTTP_400_BAD_REQUEST)
        # A run over just-uploaded files reads only those.
        ids = None
        run_id = request.query_params.get("run_id")
        if run_id:
            try:
                run = TaggingRun.objects.filter(id=UUID(run_id), workspace_id=workspace_id).first()
            except ValueError:
                return Response({"error": "run_id must be a UUID"}, status=status.HTTP_400_BAD_REQUEST)
            if run is not None and run.scope.get("ids"):
                ids = run.scope["ids"]
            # Only the kinds the run was started for (music needs an admin).
            if run is not None and run.scope.get("types") and entity_type not in run.scope["types"]:
                return Response({"total": 0, "results": []}, status=status.HTTP_200_OK)
        return Response(inventory(workspace_id, entity_type, offset, limit, ids=ids), status=status.HTTP_200_OK)


class InternalTaggingContextEndpoint(InternalBaseView):
    def get(self, request, workspace_id):
        return Response(context(workspace_id), status=status.HTTP_200_OK)


class InternalTaggingRunEndpoint(InternalBaseView):
    """Progress while the run works, then its proposals for review."""

    def post(self, request, run_id):
        run = TaggingRun.objects.filter(id=run_id).first()
        if run is None:
            return Response({"error": "Not found"}, status=status.HTTP_404_NOT_FOUND)
        if run.status in (TaggingRun.Status.CANCELLED, TaggingRun.Status.COMPLETED, TaggingRun.Status.UNDONE):
            return Response({"status": run.status}, status=status.HTTP_200_OK)
        if request.data.get("progress"):
            run.progress = {**(run.progress or {}), **request.data["progress"]}
        if request.data.get("provider"):
            run.provider = str(request.data["provider"])[:60]
        new_status = request.data.get("status")
        if new_status == "REVIEW":
            summary = dict(run.summary or {})
            summary["proposals"] = request.data.get("proposals") or {"tags": [], "merges": []}
            run.summary = summary
            run.status = TaggingRun.Status.REVIEW
            run.finished_at = timezone.now()
        elif new_status == "FAILED":
            run.status = TaggingRun.Status.FAILED
            run.error = str(request.data.get("error") or "")[:500]
            run.finished_at = timezone.now()
        run.save()
        return Response({"status": run.status}, status=status.HTTP_200_OK)
