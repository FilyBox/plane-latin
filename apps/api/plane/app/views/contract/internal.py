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
import unicodedata
import uuid
from datetime import date

from dateutil.relativedelta import relativedelta

# Django imports
from django.core.exceptions import ValidationError
from django.db.models import Func, Q, TextField, Value
from django.db.models.functions import Coalesce, Concat
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

# Fields (as returned by the AI subtasks, camel/spanish keys from the prompt
# schema) → Contract model columns. Lists are joined to comma-separated text to
# match the crm-new reference schema (String @db.Text columns).
SIMPLE_FIELD_MAP = {
    "tituloContrato": "titulo",
    "resumenGeneral": "resumen_general",
    "nombreGrupo": "nombre_grupo",
    "esPosibleExpandirlo": "es_posible_expandirlo",
    "tiempoExtensionPosible": "tiempo_extension_posible",
    "clausulaRenovacion": "expansion_time_description",
    "estatusContrato": "estatus_contrato",
    "tipoContrato": "tipo_contrato",
    "periodoColeccion": "periodo_coleccion",
    "descripcionPeriodoColeccion": "collection_period_description",
    "duracionPeriodoColeccion": "collection_period_duration",
    "periodoRetencion": "periodo_retencion",
    "descripcionPeriodoRetencion": "retention_period_description",
    "duracionPeriodoRetencion": "retention_period_duration",
}
LIST_FIELD_MAP = {
    "involucrados": "involucrados",
    "testigos": "testigos",
    "artistas": "artistas",
}
DATE_FIELD_MAP = {"fechaInicio": "fecha_inicio", "fechaFin": "fecha_fin"}


def _parse_date(value):
    if not value:
        return None
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


def apply_extracted_data(contract, data):
    """Applies an AI extraction payload to the contract's live columns,
    computes fecha_fin_efectiva and auto-tags the file by artist.
    """
    for key, field in SIMPLE_FIELD_MAP.items():
        if key in data and data[key] not in (None, ""):
            setattr(contract, field, data[key])

    for key, field in LIST_FIELD_MAP.items():
        value = data.get(key)
        if isinstance(value, list):
            names = [str(item.get("nombre", item) if isinstance(item, dict) else item).strip() for item in value]
            names = [name for name in names if name]
            setattr(contract, field, ", ".join(names) if names else None)
        elif isinstance(value, str) and value.strip():
            setattr(contract, field, value.strip())

    for key, field in DATE_FIELD_MAP.items():
        parsed = _parse_date(data.get(key))
        if parsed:
            setattr(contract, field, parsed)

    if "esNotariado" in data and data["esNotariado"] is not None:
        contract.es_notariado = bool(data["esNotariado"])

    # Effective end date: fecha_fin + normalized extension months when the
    # contract is expandable (avoids server-side NLP over free text)
    extension_months = data.get("tiempoExtensionMeses")
    if contract.fecha_fin and contract.es_posible_expandirlo == "SI" and isinstance(extension_months, int):
        contract.fecha_fin_efectiva = contract.fecha_fin + relativedelta(months=extension_months)
    elif contract.fecha_fin and contract.fecha_fin_efectiva is None:
        contract.fecha_fin_efectiva = contract.fecha_fin

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

        for name in each_name(data.get("artistas")):
            link_contract_tag(contract, name, FileTag.Kind.ARTIST)
        for name in each_name(data.get("involucrados")):
            link_contract_tag(contract, name, FileTag.Kind.PERSON)
        group_name = data.get("nombreGrupo")
        if group_name and not isinstance(group_name, list):
            link_contract_tag(contract, group_name, FileTag.Kind.GROUP)


def link_contract_tag(contract, name, kind):
    """Get-or-create a FileTag by name (case-insensitive) and link it to the
    contract's document. Adopts the given kind on previously-unclassified
    (CUSTOM) tags so manually-created tags gain a grouping once the AI
    recognizes them.
    """
    name = str(name).strip()
    if not name or not contract.file_asset_id:
        return
    tag = FileTag.objects.filter(workspace_id=contract.workspace_id, name__iexact=name).first()
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


class InternalJobProgressEndpoint(InternalBaseView):
    """Progress/stage/status updates from the Workflow; keeps the contract's
    processing_status in sync so panels can show live state.
    """

    def post(self, request, job_id):
        job = ContractProcessingJob.objects.filter(id=job_id).first()
        if job is None:
            return Response({"error": "Job not found"}, status=status.HTTP_404_NOT_FOUND)

        data = request.data
        update_fields = []
        if "progress" in data:
            job.progress = max(0, min(100, int(data["progress"])))
            update_fields.append("progress")
        if "current_stage" in data:
            job.current_stage = str(data["current_stage"])[:255]
            update_fields.append("current_stage")
        if "status" in data and data["status"] in ContractProcessingJob.Status.values:
            job.status = data["status"]
            update_fields.append("status")
            if data["status"] == ContractProcessingJob.Status.RUNNING and job.started_at is None:
                job.started_at = timezone.now()
                update_fields.append("started_at")
            if data["status"] in (ContractProcessingJob.Status.COMPLETED, ContractProcessingJob.Status.FAILED):
                job.finished_at = timezone.now()
                update_fields.append("finished_at")
        if "error" in data:
            job.error = data["error"]
            update_fields.append("error")
        job.save(update_fields=update_fields or None)

        # Mirror terminal states onto the contract itself
        if job.contract_id and "status" in data:
            if data["status"] == ContractProcessingJob.Status.COMPLETED:
                Contract.objects.filter(id=job.contract_id).update(
                    processing_status="COMPLETED", processed_at=timezone.now()
                )
            elif data["status"] == ContractProcessingJob.Status.FAILED:
                Contract.objects.filter(id=job.contract_id).update(processing_status="ERROR")
            elif data["status"] == ContractProcessingJob.Status.RUNNING:
                Contract.objects.filter(id=job.contract_id).update(processing_status="PROCESSING")

        return Response({"status": "ok"}, status=status.HTTP_200_OK)


class InternalContractTextEndpoint(InternalBaseView):
    def get(self, request, contract_id):
        contract = Contract.objects.get(id=contract_id)
        return Response(
            {"extracted_text": contract.extracted_text, "has_text": bool(contract.extracted_text)},
            status=status.HTTP_200_OK,
        )

    def post(self, request, contract_id):
        contract = Contract.objects.get(id=contract_id)
        text = request.data.get("extracted_text")
        if not text:
            return Response({"error": "extracted_text is required"}, status=status.HTTP_400_BAD_REQUEST)
        contract.extracted_text = text
        contract.text_extracted_at = timezone.now()
        contract.save(update_fields=["extracted_text", "text_extracted_at"])
        return Response({"status": "ok"}, status=status.HTTP_200_OK)


class InternalContractDataEndpoint(InternalBaseView):
    def post(self, request, contract_id):
        contract = Contract.objects.get(id=contract_id)
        data = request.data.get("data") or {}
        mode = request.data.get("mode", "apply")
        model_used = request.data.get("model_used")

        if model_used:
            contract.ai_model_used = model_used

        if mode == "proposed":
            # Re-analysis result parked until the user confirms the overwrite
            contract.proposed_data = data
            contract.save(update_fields=["proposed_data", "ai_model_used"])
        else:
            apply_extracted_data(contract, data)

        return Response({"status": "ok"}, status=status.HTTP_200_OK)


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


class InternalContractThumbnailEndpoint(InternalBaseView):
    def post(self, request, contract_id):
        """Returns a presigned POST so the Worker can upload the rendered
        thumbnail directly to storage.
        """
        contract = Contract.objects.get(id=contract_id)
        name = f"contract-thumbnail-{contract.id}.png"
        asset_key = f"{contract.workspace_id}/{uuid.uuid4().hex}-{name}"
        asset = FileAsset.objects.create(
            attributes={"name": name, "type": "image/png", "size": 0},
            asset=asset_key,
            size=0,
            workspace_id=contract.workspace_id,
            entity_type=FileAsset.EntityTypeContext.CONTRACT_THUMBNAIL,
        )
        storage = S3Storage()
        presigned = storage.generate_presigned_post(
            object_name=asset_key, file_type="image/png", file_size=10 * 1024 * 1024
        )
        return Response({"upload_data": presigned, "asset_id": str(asset.id)}, status=status.HTTP_200_OK)

    def patch(self, request, contract_id):
        contract = Contract.objects.get(id=contract_id)
        asset_id = request.data.get("asset_id")
        asset = FileAsset.objects.filter(id=asset_id, workspace_id=contract.workspace_id).first()
        if asset is None:
            return Response({"error": "Asset not found"}, status=status.HTTP_400_BAD_REQUEST)
        asset.is_uploaded = True
        asset.save(update_fields=["is_uploaded"])
        contract.thumbnail_asset = asset
        contract.save(update_fields=["thumbnail_asset"])
        return Response({"status": "ok"}, status=status.HTTP_200_OK)


class InternalWorkspaceContractsEndpoint(InternalBaseView):
    """Paginated contract list (with extracted text) for the NL query fan-out."""

    def get(self, request, workspace_id):
        limit = min(int(request.query_params.get("limit", 20)), 50)
        offset = int(request.query_params.get("offset", 0))
        contracts = (
            Contract.objects.filter(workspace_id=workspace_id, extracted_text__isnull=False)
            .exclude(extracted_text="")
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
        rows = FileTag.objects.filter(workspace_id=workspace_id).order_by("name").values("name", "kind")[:500]
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

        chunks = (
            ContractChunk.objects.filter(workspace_id=workspace_id)
            .annotate(distance=CosineDistance("embedding", embedding))
            .select_related("contract", "contract__file_asset")
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


def _strip_accents(value):
    """Accent-insensitive folding so "3ball monterrey" matches "3Ball Monterrey"."""
    return "".join(
        char for char in unicodedata.normalize("NFD", str(value)) if unicodedata.category(char) != "Mn"
    ).lower()


def _as_int(value):
    """Tool arguments come from a model, so a malformed number degrades to
    "no filter" instead of a 500 that the agent cannot recover from."""
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _asset_name(contract):
    return (contract.file_asset.attributes or {}).get("name") if contract.file_asset_id else None


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
        "processing_status": contract.processing_status,
        "has_text": bool(contract.extracted_text),
    }
    if include_summary and contract.resumen_general:
        row["resumen"] = contract.resumen_general[:SUMMARY_PREVIEW_CHARS]
    return row


class Squash(Func):
    """Lowercases and strips every non-alphanumeric character.

    This is what makes "3ball" find "3 Ball Monterrey": users and the model
    both write group names with arbitrary spacing and casing, and plain
    ILIKE only matches the exact spacing that happens to be stored.
    """

    function = "REGEXP_REPLACE"
    template = "LOWER(REGEXP_REPLACE(%(expressions)s, '[^a-zA-Z0-9]', '', 'g'))"
    output_field = TextField()


def _squash(value):
    return re.sub(r"[^a-z0-9]", "", str(value).lower())


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
        for field in NAME_SEARCH_FIELDS:
            term_filter |= Q(**{f"{field}__icontains": term})
        term_filter |= Q(file_asset__attributes__name__icontains=term)
        contracts = contracts.filter(term_filter)

    for key, field in (
        ("artist", "artistas"),
        ("group", "nombre_grupo"),
        ("title", "titulo"),
        ("summary_contains", "resumen_general"),
    ):
        value = data.get(key)
        if isinstance(value, str) and value.strip():
            contracts = contracts.filter(**{f"{field}__icontains": value.strip()})

    person = data.get("person")
    if isinstance(person, str) and person.strip():
        contracts = contracts.filter(
            Q(involucrados__icontains=person.strip()) | Q(testigos__icontains=person.strip())
        )

    file_name = data.get("file_name")
    if isinstance(file_name, str) and file_name.strip():
        contracts = contracts.filter(file_asset__attributes__name__icontains=file_name.strip())

    # Date windows. `date_field` picks which column the range applies to, so
    # the agent can ask for "signed in 2017" vs "expiring in 2017".
    field = DATE_FIELD_CHOICES.get(str(data.get("date_field") or "fin").lower(), "fecha_fin")
    year = _as_int(data.get("year"))
    if year:
        contracts = contracts.filter(**{f"{field}__year": year})
    month = _as_int(data.get("month"))
    if month and 1 <= month <= 12:
        contracts = contracts.filter(**{f"{field}__month": month})
    date_from = _parse_date(data.get("date_from"))
    if date_from:
        contracts = contracts.filter(**{f"{field}__gte": date_from})
    date_to = _parse_date(data.get("date_to"))
    if date_to:
        contracts = contracts.filter(**{f"{field}__lte": date_to})

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
        contracts = Contract.objects.filter(workspace_id=workspace_id).select_related("file_asset")
        contracts = _apply_contract_filters(contracts, data)

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
                Contract.objects.filter(workspace_id=workspace_id, id__in=contract_ids).select_related("file_asset")
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
                    "text_length": len(contract.extracted_text or ""),
                }
            )
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
                Contract.objects.filter(workspace_id=workspace_id, id__in=contract_ids).select_related("file_asset")
            )
        except (ValueError, ValidationError):
            return Response({"error": "contract_ids must be uuids"}, status=status.HTTP_400_BAD_REQUEST)

        results = []
        for contract in contracts:
            text = contract.extracted_text or ""
            folded = _strip_accents(text)
            excerpts = []
            matched = []
            for keyword in keywords:
                needle = _strip_accents(keyword)
                if not needle:
                    continue
                start = folded.find(needle)
                hits = 0
                while start != -1 and hits < per_keyword and len(excerpts) < EXCERPT_MAX_PER_CONTRACT:
                    left = max(0, start - window // 2)
                    right = min(len(text), start + len(needle) + window // 2)
                    excerpts.append({"keyword": keyword, "text": text[left:right].strip()})
                    hits += 1
                    start = folded.find(needle, start + len(needle))
                if hits:
                    matched.append(keyword)
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
        contracts = Contract.objects.filter(workspace_id=workspace_id)

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
