# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Endpoints under /api/internal/ consumed by the Cloudflare Worker running
the contracts pipeline. Authenticated with the shared secret only — no user
session. The Worker never touches Postgres directly; every read/write goes
through these endpoints so Django stays the single owner of the schema.
"""

# Python imports
import re
import uuid

# Django imports
from django.core.exceptions import ValidationError
from django.db import transaction
from django.db.models import Func, Q, TextField, Value
from django.db.models.functions import Coalesce, Concat, Length, Lower
from django.utils import timezone

# Third party imports
from rest_framework import status
from rest_framework.response import Response

# Module imports
from plane.app.permissions.internal import WorkerServicePermission
from plane.app.views.base import BaseAPIView
from plane.db.models import (
    Contract,
    ContractChunk,
    ContractProcessingJob,
    ContractQuery,
    FileAsset,
    FileTag,
    FileTagLink,
)
from plane.settings.storage import S3Storage
from plane.utils.contract_extraction import (  # noqa: F401 (re-exported)
    DATE_FIELD_MAP,
    LIST_FIELD_MAP,
    SIMPLE_FIELD_MAP,
    as_bool as _as_bool,
    normalize_extracted,
    parse_date as _parse_date,
    status_for,
)
from plane.utils.contract_text_search import fold, fold_aligned, terms_for, window as text_window
from plane.utils.shared_tags import find_tag_by_name

# Stage codes the pipeline reports (see the contracts spec). Terminal codes
# never open a step of their own.
TERMINAL_STAGE_CODES = {"done", "failed", "cancelled", "timeout"}
UNTIMED_STAGE_CODES = {"queued", *TERMINAL_STAGE_CODES}
STAGE_TERMINAL_STATUS = {
    "done": ContractProcessingJob.Status.COMPLETED,
    "failed": ContractProcessingJob.Status.FAILED,
    "cancelled": ContractProcessingJob.Status.CANCELLED,
    "timeout": ContractProcessingJob.Status.FAILED,
}
TERMINAL_JOB_STATUSES = {
    ContractProcessingJob.Status.COMPLETED,
    ContractProcessingJob.Status.FAILED,
    ContractProcessingJob.Status.CANCELLED,
}


def apply_extracted_data(contract, data, fields=None, allow_clear=False):
    """Applies an AI extraction payload to the contract's live columns,
    computes fecha_fin_efectiva and estatus, stores evidence and auto-tags the
    file by artist.

    `fields` (column names) limits what is applied, for accepting part of a
    re-analysis proposal. `allow_clear` lets an explicit null clear a column;
    plain extraction leaves the current value when the AI answers empty.
    Returns the normalization warnings.
    """
    from .base import shifted_effective_end

    result = normalize_extracted(contract, data, allow_clear=allow_clear)
    values = result["values"]
    if fields is not None:
        allowed = set(fields)
        values = {field: value for field, value in values.items() if field in allowed}

    previous_end, previous_effective = contract.fecha_fin, contract.fecha_fin_efectiva
    for field, value in values.items():
        setattr(contract, field, value)

    # Accepting a new end without its effective end carries the extension
    # along, as a hand edit does.
    if fields is not None and "fecha_fin" in values and "fecha_fin_efectiva" not in values:
        contract.fecha_fin_efectiva = shifted_effective_end(previous_end, previous_effective, contract.fecha_fin)
    if contract.fecha_fin_efectiva != previous_effective and "estatus_contrato" not in values:
        derived = status_for(contract.fecha_fin_efectiva)
        if derived:
            contract.estatus_contrato = derived

    evidence = dict(contract.evidence or {})
    for field in values:
        evidence.pop(field, None)
    evidence.update({field: entry for field, entry in result["evidence"].items() if field in values})
    contract.evidence = evidence

    contract.save()

    # Auto-tag the file so the library can filter "everything of X": one tag
    # per artist (kind ARTIST, "nombre artístico - nombre real"), one for the
    # group/band (kind GROUP) and one per person appearing in the contract
    # (kind PERSON). Uses the structured arrays (never split the joined text —
    # names may contain commas).
    if contract.file_asset_id:

        def each_name(value):
            if not isinstance(value, list):
                return
            for item in value:
                yield str(item.get("nombre", item) if isinstance(item, dict) else item)

        if "artistas" in values:
            for name in each_name(data.get("artistas")):
                link_contract_tag(contract, name, FileTag.Kind.ARTIST)
        if "involucrados" in values:
            for name in each_name(data.get("involucrados")):
                link_contract_tag(contract, name, FileTag.Kind.PERSON)
        group_name = data.get("nombreGrupo")
        if "nombre_grupo" in values and group_name and not isinstance(group_name, list):
            link_contract_tag(contract, str(group_name)[:255], FileTag.Kind.GROUP)

    return result["warnings"]


def record_job_warnings(contract, warnings, job_id=None):
    """Notes dropped or coerced values on the job that produced them."""
    if not warnings:
        return
    jobs = ContractProcessingJob.objects.filter(contract=contract)
    job = jobs.filter(id=job_id).first() if job_id else None
    if job is None:
        job = jobs.order_by("-created_at").first()
    if job is None:
        return
    metadata = dict(job.metadata or {})
    metadata["warnings"] = [*(metadata.get("warnings") or []), *warnings][-50:]
    job.metadata = metadata
    job.save(update_fields=["metadata", "updated_at"])


def link_contract_tag(contract, name, kind):
    """Get-or-create a FileTag by name and link it to the contract's
    document. The name matches an existing tag ignoring case, spaces, accents
    and punctuation, so an artist "3ball Mty" reuses the group "3BallMTY".
    Adopts the given kind on previously-unclassified (CUSTOM) tags so
    manually-created tags gain a grouping once the AI recognizes them.
    """
    name = str(name).strip()
    if not name or not contract.file_asset_id:
        return
    tag = find_tag_by_name(contract.workspace_id, name)
    if tag is None:
        tag = FileTag.objects.create(workspace_id=contract.workspace_id, name=name, kind=kind)
    elif tag.kind == FileTag.Kind.CUSTOM and kind != FileTag.Kind.CUSTOM:
        tag.kind = kind
        tag.save(update_fields=["kind"])
    FileTagLink.objects.get_or_create(
        file_asset_id=contract.file_asset_id,
        tag=tag,
        defaults={"workspace_id": contract.workspace_id},
    )


def resync_contract_tags(contract):
    """AI-free tag backfill: re-derives ARTIST/GROUP/PERSON tags from the
    contract's already-stored fields, for contracts analyzed before tag kinds
    (or the artist name format) existed. Instant and free — no Worker/AI call.

    Trade-off: `artistas`/`involucrados` are stored as a single comma-joined
    TextField (crm-new schema), so this splits on ", " instead of using the
    AI's pre-join structured array. A name that itself contains a literal
    comma will split incorrectly; use "Reanalizar" for full-fidelity tagging
    in that case.
    """
    if not contract.file_asset_id:
        return
    for name in (contract.artistas or "").split(", "):
        link_contract_tag(contract, name, FileTag.Kind.ARTIST)
    for name in (contract.involucrados or "").split(", "):
        link_contract_tag(contract, name, FileTag.Kind.PERSON)
    if contract.nombre_grupo:
        link_contract_tag(contract, contract.nombre_grupo, FileTag.Kind.GROUP)


class InternalBaseView(BaseAPIView):
    authentication_classes = []
    permission_classes = [WorkerServicePermission]
    # Server-to-server traffic authenticated by shared secret. Without a user
    # session DRF's global AnonRateThrottle (30/min) would strangle concurrent
    # pipelines with 429 RATE_LIMIT_EXCEEDED.
    throttle_classes = []


class InternalAssetPresignedUrlEndpoint(InternalBaseView):
    """Resolves a presigned GET URL for an asset so the Worker can download it."""

    def get(self, request, asset_id):
        asset = FileAsset.objects.get(id=asset_id)
        storage = S3Storage.for_asset(asset)
        url = storage.generate_presigned_url(object_name=asset.asset.name)
        return Response(
            {
                "url": url,
                "name": (asset.attributes or {}).get("name"),
                "type": (asset.attributes or {}).get("type"),
                # S3 location so Textract can read the document in place
                # (no presigned URL, no download to the Worker)
                "s3_key": asset.asset.name,
                "s3_bucket": storage.aws_storage_bucket_name,
            },
            status=status.HTTP_200_OK,
        )


def _iso(moment):
    return moment.isoformat() if moment else None


def track_step(metadata, code, now, final_status=None):
    """Keeps metadata.steps: opening a new code closes the running one.
    `final_status` (done/failed) closes the running step without opening one."""
    steps = list(metadata.get("steps") or [])
    running = steps[-1] if steps and steps[-1].get("status") == "running" else None
    if final_status is None and running and running.get("code") == code:
        return
    if running:
        running["finished_at"] = _iso(now)
        running["status"] = final_status or ("failed" if code in ("failed", "cancelled", "timeout") else "done")
    if final_status is None and code and code not in UNTIMED_STAGE_CODES:
        steps.append({"code": code, "started_at": _iso(now), "finished_at": None, "status": "running"})
    metadata["steps"] = steps


def restore_contract_after_stop(job):
    """A stopped run leaves the contract as it was: analyzed if it ever was,
    otherwise in error so it can be retried."""
    from .base import is_classify_only

    if not job.contract_id or is_classify_only((job.metadata or {}).get("retry_options") or {}):
        return
    contract = Contract.objects.filter(id=job.contract_id).only("id", "processed_at").first()
    if contract is None:
        return
    Contract.objects.filter(id=contract.id).update(processing_status="COMPLETED" if contract.processed_at else "ERROR")


def stop_job(job, status_value, stage, message):
    """Ends an active job from Django's side (cancel, reaper)."""
    now = timezone.now()
    metadata = dict(job.metadata or {})
    track_step(metadata, stage, now, final_status="failed")
    job.status = status_value
    job.current_stage = stage
    job.finished_at = now
    job.metadata = metadata
    if message:
        job.error = {"message": message, "stage": stage}
    job.save(update_fields=["status", "current_stage", "finished_at", "metadata", "error", "updated_at"])
    restore_contract_after_stop(job)
    ContractQuery.objects.filter(
        job=job, status__in=[ContractProcessingJob.Status.QUEUED, ContractProcessingJob.Status.RUNNING]
    ).update(status=ContractProcessingJob.Status.FAILED)


class InternalJobProgressEndpoint(InternalBaseView):
    """Progress/stage/status updates from the Workflow; keeps the contract's
    processing_status in sync so panels can show live state.

    Payload: stage (code; `current_stage` still accepted), progress, status,
    detail, detail_data, usage, error. A job that already ended is never
    reopened by a late post.
    """

    def post(self, request, job_id):
        data = request.data if isinstance(request.data, dict) else {}
        with transaction.atomic():
            job = ContractProcessingJob.objects.select_for_update().filter(id=job_id).first()
            if job is None:
                return Response({"error": "Job not found"}, status=status.HTTP_404_NOT_FOUND)
            if job.status in TERMINAL_JOB_STATUSES:
                return Response({"status": "ignored", "job_status": job.status}, status=status.HTTP_200_OK)

            now = timezone.now()
            metadata = dict(job.metadata or {})
            update_fields = ["metadata", "updated_at"]

            if "progress" in data:
                try:
                    job.progress = max(0, min(100, int(float(data["progress"]))))
                    update_fields.append("progress")
                except (TypeError, ValueError):
                    pass

            stage = data.get("stage", data.get("current_stage"))
            if stage:
                code = str(stage)[:255]
                if code != job.current_stage:
                    metadata.pop("detail", None)
                    metadata.pop("detail_data", None)
                job.current_stage = code
                update_fields.append("current_stage")
                track_step(metadata, code, now)
            if "detail" in data:
                metadata["detail"] = str(data["detail"])[:255] if data["detail"] else None
            if isinstance(data.get("detail_data"), dict):
                metadata["detail_data"] = data["detail_data"]
            if isinstance(data.get("usage"), dict):
                metadata["usage"] = data["usage"]

            new_status = data.get("status")
            if new_status not in ContractProcessingJob.Status.values:
                # A terminal code ends the job even without an explicit status
                new_status = STAGE_TERMINAL_STATUS.get(str(stage)) if stage else None
            if new_status:
                job.status = new_status
                update_fields.append("status")
                if new_status == ContractProcessingJob.Status.RUNNING and job.started_at is None:
                    job.started_at = now
                    update_fields.append("started_at")
                if new_status in TERMINAL_JOB_STATUSES:
                    job.finished_at = now
                    update_fields.append("finished_at")
                    track_step(
                        metadata,
                        None,
                        now,
                        final_status="done" if new_status == ContractProcessingJob.Status.COMPLETED else "failed",
                    )
                    if not stage:
                        job.current_stage = {
                            ContractProcessingJob.Status.COMPLETED: "done",
                            ContractProcessingJob.Status.FAILED: "failed",
                            ContractProcessingJob.Status.CANCELLED: "cancelled",
                        }[new_status]
                        update_fields.append("current_stage")

            if "error" in data:
                error = data["error"]
                if isinstance(error, dict):
                    error = {
                        **error,
                        "message": str(error.get("message") or "")[:2000],
                        "stage": str(error.get("stage") or job.current_stage or "")[:255],
                    }
                elif error:
                    error = {"message": str(error)[:2000], "stage": job.current_stage}
                else:
                    error = None
                job.error = error
                update_fields.append("error")

            job.metadata = metadata
            job.save(update_fields=list(dict.fromkeys(update_fields)))

        # Mirror terminal states onto the contract itself — except for a
        # classification-only backfill, which must leave the contract as it is.
        from .base import is_classify_only

        quiet = is_classify_only((job.metadata or {}).get("retry_options") or {})
        if job.contract_id and new_status and not quiet:
            contracts = Contract.objects.filter(id=job.contract_id)
            if new_status == ContractProcessingJob.Status.COMPLETED:
                # A re-analysis only proposes; processed_at moves on accept.
                if job.task_type == ContractProcessingJob.TaskType.REANALYZE:
                    contracts.update(processing_status="COMPLETED")
                else:
                    contracts.update(processing_status="COMPLETED", processed_at=timezone.now())
            elif new_status == ContractProcessingJob.Status.FAILED:
                contracts.update(processing_status="ERROR")
            elif new_status == ContractProcessingJob.Status.CANCELLED:
                restore_contract_after_stop(job)
            elif new_status == ContractProcessingJob.Status.RUNNING:
                contracts.update(processing_status="PROCESSING")

        return Response({"status": "ok"}, status=status.HTTP_200_OK)


class InternalContractTextEndpoint(InternalBaseView):
    def get(self, request, contract_id):
        # Called once per AI step and embedding batch: one column, one query
        row = Contract.objects.filter(id=contract_id).values_list("extracted_text", flat=True)
        if not row:
            return Response({"error": "Contract not found"}, status=status.HTTP_404_NOT_FOUND)
        text = row[0]
        return Response({"extracted_text": text, "has_text": bool(text)}, status=status.HTTP_200_OK)

    def post(self, request, contract_id):
        contract = Contract.objects.get(id=contract_id)
        text = request.data.get("extracted_text")
        if not text:
            return Response({"error": "extracted_text is required"}, status=status.HTTP_400_BAD_REQUEST)
        contract.extracted_text = text
        contract.text_extracted_at = timezone.now()
        contract.save(update_fields=["extracted_text", "text_extracted_at"])
        # The [[p. N]] markers give the PDF's page count for free
        from plane.utils.assistant_pdf import contract_pages, remember_page_count

        pages = contract_pages(text)
        if pages and contract.file_asset_id:
            asset = FileAsset.objects.filter(id=contract.file_asset_id).first()
            if asset is not None:
                remember_page_count(asset, max(pages))
        return Response({"status": "ok"}, status=status.HTTP_200_OK)


class InternalContractDataEndpoint(InternalBaseView):
    def post(self, request, contract_id):
        contract = Contract.objects.defer("extracted_text").get(id=contract_id)
        data = request.data.get("data") or {}
        if not isinstance(data, dict):
            return Response({"error": "data must be an object"}, status=status.HTTP_400_BAD_REQUEST)
        mode = request.data.get("mode", "apply")
        model_used = request.data.get("model_used")
        job_id = request.data.get("job_id")

        if mode == "proposed":
            # Re-analysis result parked until the user confirms the overwrite;
            # the model only becomes the contract's when it is accepted.
            warnings = normalize_extracted(contract, data, allow_clear=True)["warnings"]
            contract.proposed_data = {**data, "_model_used": model_used} if model_used else data
            contract.save(update_fields=["proposed_data", "updated_at"])
        else:
            if model_used:
                contract.ai_model_used = str(model_used)[:255]
            warnings = apply_extracted_data(contract, data)
        record_job_warnings(contract, warnings, job_id=job_id)

        return Response({"status": "ok", "warnings": warnings}, status=status.HTTP_200_OK)


class InternalContractChunksEndpoint(InternalBaseView):
    def get(self, request, contract_id):
        count = ContractChunk.objects.filter(contract_id=contract_id).count()
        return Response({"exists": count > 0, "count": count}, status=status.HTTP_200_OK)

    def post(self, request, contract_id):
        contract = Contract.objects.get(id=contract_id)
        chunks = request.data.get("chunks") or []
        if not isinstance(chunks, list) or not chunks:
            return Response({"error": "chunks must be a non-empty list"}, status=status.HTTP_400_BAD_REQUEST)

        # Large embedding payloads arrive in batches (Django's body-size limit):
        # the first batch replaces the previous chunk set, the rest append.
        mode = request.data.get("mode", "replace")
        if mode == "replace":
            # Chunking is deterministic over the current text
            ContractChunk.objects.filter(contract=contract).delete(soft=False)
        ContractChunk.objects.bulk_create(
            [
                ContractChunk(
                    workspace_id=contract.workspace_id,
                    contract=contract,
                    chunk_index=int(chunk["index"]),
                    content=chunk["content"],
                    token_count=int(chunk.get("token_count", 0)),
                    embedding=chunk["embedding"],
                )
                for chunk in chunks
            ],
            batch_size=100,
        )
        return Response({"status": "ok", "count": len(chunks)}, status=status.HTTP_200_OK)


class InternalWorkspaceContractsEndpoint(InternalBaseView):
    """Paginated contract list (with extracted text) for the NL query fan-out."""

    def get(self, request, workspace_id):
        limit = min(int(request.query_params.get("limit", 20)), 50)
        offset = int(request.query_params.get("offset", 0))
        contracts = (
            Contract.objects.filter(
                workspace_id=workspace_id, extracted_text__isnull=False, file_asset__is_deleted=False
            )
            .exclude(extracted_text="")
            .select_related("file_asset")
            .order_by("created_at")
        )
        total = contracts.count()
        page = contracts[offset : offset + limit]
        return Response(
            {
                "total": total,
                "offset": offset,
                "results": [
                    {
                        "id": str(contract.id),
                        "titulo": contract.titulo,
                        "file_name": (contract.file_asset.attributes or {}).get("name")
                        if contract.file_asset_id
                        else None,
                        "extracted_text": contract.extracted_text,
                    }
                    for contract in page
                ],
            },
            status=status.HTTP_200_OK,
        )


class InternalWorkspaceTagsEndpoint(InternalBaseView):
    """Existing file-tag names, sent to the artists-extraction prompt so the
    AI maps a detected artist onto an existing tag (spelling/alias variants)
    instead of minting near-duplicates.
    """

    def get(self, request, workspace_id):
        # Filter before the cap: the artists prompt only uses these kinds, and
        # slicing first used to drop them behind PERSON/TYPE tags.
        kinds = [kind for kind in (request.query_params.get("kinds") or "").split(",") if kind]
        kinds = [kind for kind in kinds if kind in FileTag.Kind.values] or [FileTag.Kind.ARTIST, FileTag.Kind.CUSTOM]
        rows = list(
            FileTag.objects.filter(workspace_id=workspace_id, kind__in=kinds)
            .order_by("name")
            .values("name", "kind")[:500]
        )
        return Response(
            {
                # Names-only list kept for backward compatibility with older
                # Worker deploys; `detailed` carries the kind grouping.
                "tags": [row["name"] for row in rows],
                "detailed": list(rows),
            },
            status=status.HTTP_200_OK,
        )


class InternalChunkSearchEndpoint(InternalBaseView):
    """Vector search over the workspace's contract chunks (RAG retrieval for
    the general chat). Ranks by cosine distance and returns the top chunks
    with their source-contract metadata.
    """

    def post(self, request, workspace_id):
        from pgvector.django import CosineDistance

        embedding = request.data.get("embedding")
        if not isinstance(embedding, list) or not embedding:
            return Response({"error": "embedding is required"}, status=status.HTTP_400_BAD_REQUEST)
        limit = min(int(request.data.get("limit", 12)), 40)

        chunks = ContractChunk.objects.filter(
            workspace_id=workspace_id, contract__deleted_at__isnull=True, contract__file_asset__is_deleted=False
        )
        # Single-contract chat: search only that contract's chunks
        contract_id = request.data.get("contract_id")
        if contract_id:
            try:
                chunks = chunks.filter(contract_id=uuid.UUID(str(contract_id)))
            except (TypeError, ValueError):
                return Response({"error": "contract_id must be a uuid"}, status=status.HTTP_400_BAD_REQUEST)
        chunks = (
            chunks.annotate(distance=CosineDistance("embedding", embedding))
            .select_related("contract", "contract__file_asset")
            .defer("contract__extracted_text", "contract__proposed_data", "contract__evidence")
            .order_by("distance")[:limit]
        )
        results = []
        for chunk in chunks:
            contract = chunk.contract
            results.append(
                {
                    "content": chunk.content,
                    "chunk_index": chunk.chunk_index,
                    "similarity": round(1.0 - float(chunk.distance), 4),
                    "contract_id": str(contract.id),
                    "title": contract.titulo,
                    "file_name": (contract.file_asset.attributes or {}).get("name") if contract.file_asset_id else None,
                    "asset_id": str(contract.file_asset_id) if contract.file_asset_id else None,
                }
            )
        return Response({"results": results}, status=status.HTTP_200_OK)


class InternalQueryResultEndpoint(InternalBaseView):
    def post(self, request, query_id):
        from plane.bgtasks.contract_task import send_contract_query_email

        query = ContractQuery.objects.filter(id=query_id).first()
        if query is None:
            return Response({"error": "Query not found"}, status=status.HTTP_404_NOT_FOUND)
        query.result = request.data.get("result")
        query.status = (
            ContractProcessingJob.Status.COMPLETED
            if request.data.get("status", "COMPLETED") == "COMPLETED"
            else ContractProcessingJob.Status.FAILED
        )
        query.save(update_fields=["result", "status"])
        if query.result and query.status == ContractProcessingJob.Status.COMPLETED:
            send_contract_query_email.delay(str(query.id))
        return Response({"status": "ok"}, status=status.HTTP_200_OK)


# ---------------------------------------------------------------------------
# Agent tool surface
#
# The contracts agent (Cloudflare Worker) answers questions like "contracts of
# artist X not finished in August 2017 that carry person Y's INE". Pure vector
# RAG cannot express that, so these endpoints expose the structured columns
# and a keyword-window reader over the extracted text.
#
# Every endpoint takes workspace_id in the path and filters by it, so a tool
# call can never reach another workspace's contracts.
# ---------------------------------------------------------------------------

# Result caps: tool output travels back into the model's context, so rows are
# compact by default and the caller pages instead of asking for everything.
SEARCH_DEFAULT_LIMIT = 25
SEARCH_MAX_LIMIT = 100
SUMMARY_PREVIEW_CHARS = 240
EXCERPT_WINDOW_CHARS = 400
EXCERPT_MAX_PER_CONTRACT = 6

# Free-text columns an unqualified `names` term is matched against
NAME_SEARCH_FIELDS = (
    "titulo",
    "nombre_grupo",
    "artistas",
    "involucrados",
    "testigos",
    "resumen_general",
)

DATE_FIELD_CHOICES = {
    "inicio": "fecha_inicio",
    "fin": "fecha_fin",
    "fin_efectiva": "fecha_fin_efectiva",
    "creacion": "created_at__date",
}
DATE_FILTER_KEYS = ("year", "month", "date_from", "date_to")


def _strip_accents(value):
    """Accent-insensitive folding so "3ball monterrey" matches "3Ball Monterrey"."""
    return fold(value)


def _as_int(value):
    """Tool arguments come from a model, so a malformed number degrades to
    "no filter" instead of a 500 that the agent cannot recover from."""
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _asset_name(contract):
    return (contract.file_asset.attributes or {}).get("name") if contract.file_asset_id else None


def without_text(contracts):
    """The queryset without loading the extracted text, measured instead."""
    return contracts.defer("extracted_text").annotate(text_length=Length("extracted_text"))


def _text_length(contract):
    length = getattr(contract, "text_length", None)
    if length is None and "extracted_text" not in contract.get_deferred_fields():
        length = len(contract.extracted_text or "")
    return length or 0


def _contract_row(contract, include_summary=True):
    """Compact projection of a contract - never the extracted text."""
    row = {
        "contract_id": str(contract.id),
        "titulo": contract.titulo,
        "file_name": _asset_name(contract),
        "asset_id": str(contract.file_asset_id) if contract.file_asset_id else None,
        "nombre_grupo": contract.nombre_grupo,
        "artistas": contract.artistas,
        "involucrados": contract.involucrados,
        "testigos": contract.testigos,
        "es_notariado": contract.es_notariado,
        "fecha_inicio": contract.fecha_inicio.isoformat() if contract.fecha_inicio else None,
        "fecha_fin": contract.fecha_fin.isoformat() if contract.fecha_fin else None,
        "fecha_fin_efectiva": contract.fecha_fin_efectiva.isoformat() if contract.fecha_fin_efectiva else None,
        "estatus_contrato": contract.estatus_contrato,
        "tipo_contrato": contract.tipo_contrato,
        "es_editorial": contract.es_editorial,
        "processing_status": contract.processing_status,
        "has_text": _text_length(contract) > 0,
    }
    if include_summary and contract.resumen_general:
        row["resumen"] = contract.resumen_general[:SUMMARY_PREVIEW_CHARS]
    return row


# Accented letters and their plain form, for folding inside Postgres without
# the unaccent extension (not installed everywhere).
ACCENTED = "áàäâãåéèëêíìïîóòöôõúùüûñçÁÀÄÂÃÅÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÑÇ"
PLAIN = "aaaaaaeeeeiiiiooooouuuuncAAAAAAEEEEIIIIOOOOOUUUUNC"


def Fold(expression):
    """SQL lowercase without accents: "José" -> "jose"."""
    return Lower(Func(expression, Value(ACCENTED), Value(PLAIN), function="TRANSLATE", output_field=TextField()))


def Squash(expression):
    """`Fold`, then drops every non-alphanumeric character.

    This is what makes "3ball" find "3 Ball Monterrey" and "jose" find
    "José": users and the model write names with arbitrary spacing, casing
    and accents, and plain ILIKE only matches the exact form stored.
    """
    return Func(
        Fold(expression),
        Value("[^a-z0-9]"),
        Value(""),
        Value("g"),
        function="REGEXP_REPLACE",
        output_field=TextField(),
    )


def _squash(value):
    return re.sub(r"[^a-z0-9]", "", fold(value))


def _folded_contains(contracts, fields, value):
    """Contracts where any of `fields` contains `value`, ignoring case and accents."""
    needle = fold(value)
    condition = Q()
    for field in fields:
        alias = f"folded_{field}"
        contracts = contracts.annotate(**{alias: Fold(Coalesce(field, Value("")))})
        condition |= Q(**{f"{alias}__contains": needle})
    return contracts.filter(condition)


def _date_window(data):
    """(column, Q) for the requested date filter, or (column, None)."""
    field = DATE_FIELD_CHOICES.get(str(data.get("date_field") or "fin").lower(), "fecha_fin")
    condition = Q()
    year = _as_int(data.get("year"))
    if year:
        condition &= Q(**{f"{field}__year": year})
    month = _as_int(data.get("month"))
    if month and 1 <= month <= 12:
        condition &= Q(**{f"{field}__month": month})
    date_from = _parse_date(data.get("date_from"))
    if date_from:
        condition &= Q(**{f"{field}__gte": date_from})
    date_to = _parse_date(data.get("date_to"))
    if date_to:
        condition &= Q(**{f"{field}__lte": date_to})
    return field, (condition if condition else None)


def undated_count(contracts, data):
    """How many contracts a date filter left out only because they have no
    date there. Old scanned contracts often lack one, and dropping them
    without saying so reads as "there are none"."""
    data = data if isinstance(data, dict) else {}
    field, condition = _date_window(data)
    if condition is None or field == "created_at__date" or data.get("include_undated"):
        return 0
    undated = {key: value for key, value in data.items() if key not in DATE_FILTER_KEYS}
    return _apply_contract_filters(contracts, undated).filter(**{f"{field}__isnull": True}).count()


def _apply_contract_filters(contracts, data):
    """Shared filter builder for the search endpoint. Unknown keys are ignored
    so a hallucinated filter degrades to a broader search, never a 500.
    """
    # `names` is the alias-tolerant entry point: every term is OR-matched
    # across the free-text columns, and the terms AND together.
    names = data.get("names") or []
    if isinstance(names, str):
        names = [names]
    terms = [str(name).strip() for name in names if str(name).strip()]
    if terms:
        # One squashed haystack over every name-bearing column, so a term
        # matches regardless of how the stored value is spaced or accented.
        contracts = contracts.annotate(
            squashed_names=Squash(
                Concat(
                    *[Coalesce(field, Value("")) for field in NAME_SEARCH_FIELDS],
                    Value(" "),
                    output_field=TextField(),
                )
            )
        )
    for term in terms:
        term_filter = Q(squashed_names__contains=_squash(term))
        term_filter |= Q(file_asset__attributes__name__icontains=term)
        contracts = contracts.filter(term_filter)

    for key, fields in (
        ("artist", ("artistas",)),
        ("group", ("nombre_grupo",)),
        ("title", ("titulo",)),
        ("summary_contains", ("resumen_general",)),
        ("person", ("involucrados", "testigos")),
    ):
        value = data.get(key)
        if isinstance(value, str) and value.strip():
            contracts = _folded_contains(contracts, fields, value.strip())

    file_name = data.get("file_name")
    if isinstance(file_name, str) and file_name.strip():
        contracts = contracts.filter(file_asset__attributes__name__icontains=file_name.strip())

    # Date windows. `date_field` picks which column the range applies to, so
    # the agent can ask for "signed in 2017" vs "expiring in 2017".
    field, date_condition = _date_window(data)
    if date_condition is not None:
        if data.get("include_undated") and field != "created_at__date":
            date_condition |= Q(**{f"{field}__isnull": True})
        contracts = contracts.filter(date_condition)

    for key, column in (
        ("estatus", "estatus_contrato"),
        ("tipo", "tipo_contrato"),
        ("processing_status", "processing_status"),
    ):
        values = data.get(key)
        if isinstance(values, str):
            values = [values]
        if values:
            contracts = contracts.filter(**{f"{column}__in": [str(value) for value in values]})

    if data.get("es_notariado") is not None:
        contracts = contracts.filter(es_notariado=bool(data["es_notariado"]))
    if data.get("es_editorial") is not None:
        contracts = (
            contracts.filter(es_editorial=True)
            if data["es_editorial"]
            else contracts.filter(Q(es_editorial=False) | Q(es_editorial__isnull=True))
        )
    if data.get("has_text") is not None:
        contracts = (
            contracts.exclude(extracted_text__isnull=True).exclude(extracted_text="")
            if data["has_text"]
            else contracts.filter(Q(extracted_text__isnull=True) | Q(extracted_text=""))
        )

    tags = data.get("tags") or []
    if isinstance(tags, str):
        tags = [tags]
    tag_names = [str(tag).strip() for tag in tags if str(tag).strip()]
    if tag_names:
        tag_filter = Q()
        for name in tag_names:
            tag_filter |= Q(file_asset__tag_links__tag__name__iexact=name)
        contracts = contracts.filter(tag_filter).distinct()

    return contracts


class InternalContractSearchEndpoint(InternalBaseView):
    """Structured search over the workspace's contract metadata.

    This is what lifts the chat past plain RAG: the agent composes filters
    (artist, person, dates, status, tags) instead of hoping the answer sits in
    the top-k embedding neighbours, and gets back compact rows it can page
    through without flooding its context.
    """

    def post(self, request, workspace_id):
        data = request.data if isinstance(request.data, dict) else {}
        base = without_text(
            Contract.objects.filter(workspace_id=workspace_id, file_asset__is_deleted=False).select_related(
                "file_asset"
            )
        )
        contracts = _apply_contract_filters(base, data)

        allowed_order = {
            "-created_at",
            "created_at",
            "titulo",
            "-titulo",
            "fecha_inicio",
            "-fecha_inicio",
            "fecha_fin",
            "-fecha_fin",
            "fecha_fin_efectiva",
            "-fecha_fin_efectiva",
        }
        order = str(data.get("order") or "-created_at")
        contracts = contracts.order_by(order if order in allowed_order else "-created_at")

        total = contracts.count()
        offset = max(0, _as_int(data.get("offset")) or 0)
        limit = min(max(1, _as_int(data.get("limit")) or SEARCH_DEFAULT_LIMIT), SEARCH_MAX_LIMIT)
        page = contracts[offset : offset + limit]
        include_summary = data.get("include_summary", True)

        return Response(
            {
                "total": total,
                "offset": offset,
                "returned": len(page),
                "has_more": offset + limit < total,
                "without_date": undated_count(base, data),
                "results": [_contract_row(contract, include_summary=include_summary) for contract in page],
            },
            status=status.HTTP_200_OK,
        )


class InternalContractDetailsEndpoint(InternalBaseView):
    """Full AI-extracted record for a handful of contracts (no raw text)."""

    def post(self, request, workspace_id):
        contract_ids = request.data.get("contract_ids") or []
        if isinstance(contract_ids, str):
            contract_ids = [contract_ids]
        contract_ids = [str(value) for value in contract_ids][:20]
        if not contract_ids:
            return Response({"error": "contract_ids is required"}, status=status.HTTP_400_BAD_REQUEST)

        try:
            contracts = list(
                without_text(
                    Contract.objects.filter(
                        workspace_id=workspace_id, id__in=contract_ids, file_asset__is_deleted=False
                    ).select_related("file_asset")
                )
            )
        except (ValueError, ValidationError):
            return Response({"error": "contract_ids must be uuids"}, status=status.HTTP_400_BAD_REQUEST)

        results = []
        for contract in contracts:
            row = _contract_row(contract, include_summary=False)
            row.update(
                {
                    "resumen_general": contract.resumen_general,
                    "es_posible_expandirlo": contract.es_posible_expandirlo,
                    "tiempo_extension_posible": contract.tiempo_extension_posible,
                    "expansion_time_description": contract.expansion_time_description,
                    "periodo_coleccion": contract.periodo_coleccion,
                    "collection_period_description": contract.collection_period_description,
                    "collection_period_duration": contract.collection_period_duration,
                    "periodo_retencion": contract.periodo_retencion,
                    "retention_period_description": contract.retention_period_description,
                    "retention_period_duration": contract.retention_period_duration,
                    "text_length": _text_length(contract),
                }
            )
            # Split off a bundled PDF, or the bundle its parts came from
            if contract.file_asset_id:
                from plane.utils.assistant_pdf import lineage_summary

                row.update(lineage_summary(workspace_id, contract.file_asset))
            results.append(row)
        return Response({"results": results}, status=status.HTTP_200_OK)


class InternalContractExcerptsEndpoint(InternalBaseView):
    """Keyword windows over a contract's extracted text.

    Lets the agent verify a detail ("does it carry person X's INE?") by reading
    only the neighbourhood of each hit instead of pulling a 60k-character
    document into the conversation.
    """

    def post(self, request, workspace_id):
        contract_ids = request.data.get("contract_ids") or []
        if isinstance(contract_ids, str):
            contract_ids = [contract_ids]
        contract_ids = [str(value) for value in contract_ids][:10]
        keywords = request.data.get("keywords") or []
        if isinstance(keywords, str):
            keywords = [keywords]
        keywords = [str(keyword).strip() for keyword in keywords if str(keyword).strip()][:10]
        if not contract_ids or not keywords:
            return Response({"error": "contract_ids and keywords are required"}, status=status.HTTP_400_BAD_REQUEST)

        window = min(max(80, _as_int(request.data.get("window")) or EXCERPT_WINDOW_CHARS), 1200)
        per_keyword = min(max(1, _as_int(request.data.get("max_per_contract")) or 3), EXCERPT_MAX_PER_CONTRACT)

        try:
            contracts = list(
                Contract.objects.filter(
                    workspace_id=workspace_id, id__in=contract_ids, file_asset__is_deleted=False
                ).select_related("file_asset")
            )
        except (ValueError, ValidationError):
            return Response({"error": "contract_ids must be uuids"}, status=status.HTTP_400_BAD_REQUEST)

        terms = terms_for(keywords)
        results = []
        for contract in contracts:
            text = contract.extracted_text or ""
            folded = fold_aligned(text)
            excerpts = []
            matched = []
            for term in terms:
                room = min(per_keyword, EXCERPT_MAX_PER_CONTRACT - len(excerpts))
                # Still report the keyword as found when there is no room left for its excerpt
                hits = term.occurrences(folded, limit=max(room, 1))
                for start, end in hits[: max(room, 0)]:
                    excerpt = {"keyword": term.keyword, "text": text_window(text, start, end, window)}
                    if term.expanded:
                        excerpt["found"] = text[start:end]
                    excerpts.append(excerpt)
                if hits:
                    matched.append(term.keyword)
            results.append(
                {
                    "contract_id": str(contract.id),
                    "titulo": contract.titulo,
                    "file_name": _asset_name(contract),
                    "asset_id": str(contract.file_asset_id) if contract.file_asset_id else None,
                    "matched_keywords": matched,
                    "excerpts": excerpts,
                }
            )
        return Response({"results": results}, status=status.HTTP_200_OK)


class InternalContractFacetsEndpoint(InternalBaseView):
    """Distinct values the agent can filter on.

    Users write "3ball", "3 Ball MTY" or "3ballMTY" for the same group; the
    agent reads the real stored spellings from here before searching, instead
    of guessing at the filter string.
    """

    def get(self, request, workspace_id):
        contracts = Contract.objects.filter(workspace_id=workspace_id, file_asset__is_deleted=False)

        def split_names(values):
            seen = {}
            for value in values:
                for name in str(value or "").split(", "):
                    name = name.strip()
                    if name:
                        seen[_strip_accents(name)] = name
            return sorted(seen.values())[:300]

        years = sorted(
            {value.year for value in contracts.values_list("fecha_inicio", flat=True) if value is not None}
            | {value.year for value in contracts.values_list("fecha_fin", flat=True) if value is not None}
        )
        return Response(
            {
                "total_contracts": contracts.count(),
                "artistas": split_names(contracts.values_list("artistas", flat=True)),
                "grupos": split_names(contracts.values_list("nombre_grupo", flat=True)),
                "involucrados": split_names(contracts.values_list("involucrados", flat=True)),
                "tags": list(
                    FileTag.objects.filter(workspace_id=workspace_id)
                    .order_by("name")
                    .values_list("name", flat=True)[:300]
                ),
                "estatus": sorted({value for value in contracts.values_list("estatus_contrato", flat=True) if value}),
                "tipos": sorted({value for value in contracts.values_list("tipo_contrato", flat=True) if value}),
                "years": years,
            },
            status=status.HTTP_200_OK,
        )
