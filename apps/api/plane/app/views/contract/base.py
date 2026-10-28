# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Python imports
import re
from datetime import timedelta

# Django imports
from django.conf import settings
from django.db import transaction
from django.db.models import F, Q
from django.utils import timezone

# Third party imports
from rest_framework import status
from rest_framework.response import Response

# Module imports
from plane.app.permissions import ROLE, allow_permission
from plane.app.serializers import (
    ContractDetailSerializer,
    ContractProcessingJobSerializer,
    ContractQuerySerializer,
    ContractSerializer,
    ContractUpdateSerializer,
)
from plane.bgtasks.contract_task import (
    dispatch_contract_pipeline,
    dispatch_contract_query,
    terminate_contract_pipeline_task,
)
from plane.db.models import Contract, ContractProcessingJob, ContractQuery, FileAsset, Workspace
from plane.utils.contract_extraction import status_for
from plane.utils.contract_views import CONTRACT_VIEWS, apply_contract_view
from plane.utils.tabular_export import spreadsheet_response

from ..file_library.base import FileLibraryBaseView

# "classify" re-runs only the cheap editorial classification over the stored
# text; it backfills contracts analyzed before the field existed. "works"
# re-reads only the songs/releases the contract lists and saves suggestions.
RETRY_OPTION_KEYS = [
    "extract_text",
    "generate_embeddings",
    "ai_analysis",
    "tags",
    "classify",
    "works",
]
# Background stages that leave the contract's own status alone
QUIET_RETRY_KEYS = {"classify", "works"}
ACTIVE_JOB_STATUSES = [ContractProcessingJob.Status.QUEUED, ContractProcessingJob.Status.RUNNING]
# Fields the list never needs; the text alone can be megabytes per contract
LIST_DEFERRED_FIELDS = ("extracted_text", "evidence", "expiry_alerts")
TAG_SOURCE_FIELDS = ("artistas", "involucrados", "nombre_grupo")
BULK_UPDATE_FIELDS = (
    "tipo_contrato",
    "estatus_contrato",
    "es_editorial",
    "es_notariado",
    "artistas",
    "nombre_grupo",
    "fecha_inicio",
    "fecha_fin",
)
MAX_PER_PAGE = 200
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


def is_classify_only(retry_options):
    """A classification-only (or works-only) run is a background backfill: it
    must not flip the contract to PROCESSING (it would jump between views) nor
    to ERROR if the model call fails — the contract itself is fine either way."""
    return any(retry_options.get(key) for key in QUIET_RETRY_KEYS) and not any(
        retry_options.get(key) for key in RETRY_OPTION_KEYS if key not in QUIET_RETRY_KEYS
    )


def live_contracts():
    """Contracts whose PDF still exists. Deleting the file from the library
    soft-deletes the asset but leaves the Contract row behind."""
    return Contract.objects.filter(file_asset__is_deleted=False)


def clean_hash(value):
    """A sha256 hex digest, lowercased, or None."""
    value = str(value or "").strip().lower()
    return value if SHA256_RE.match(value) else None


def has_text(contract_id):
    """Whether the contract has extracted text, without loading it."""
    return Contract.objects.filter(id=contract_id, extracted_text__isnull=False).exclude(extracted_text="").exists()


def has_active_job(contract_id):
    return ContractProcessingJob.objects.filter(contract_id=contract_id, status__in=ACTIVE_JOB_STATUSES).exists()


def ensure_contract_for_asset(asset, user=None):
    """Creates the Contract row and kicks off the extraction pipeline the
    first time a PDF is linked to the protected "Contratos" category.
    Idempotent: re-linking an already-tracked file does nothing, and two
    simultaneous links create a single contract.
    """
    attributes = asset.attributes or {}
    if attributes.get("type") != "application/pdf":
        return None
    content_hash = clean_hash(attributes.get("content_hash"))
    with transaction.atomic():
        contract, created = Contract.objects.get_or_create(
            file_asset=asset,
            defaults={"workspace_id": asset.workspace_id, "content_hash": content_hash},
        )
        if created:
            create_and_dispatch_job(
                workspace=contract.workspace,
                contract=contract,
                task_type=ContractProcessingJob.TaskType.EXTRACT_FULL,
                user=user,
            )
        elif content_hash and not contract.content_hash:
            contract.content_hash = content_hash
            contract.save(update_fields=["content_hash", "updated_at"])
    return contract


def create_and_dispatch_job(workspace, contract, task_type, user=None, metadata=None):
    """Creates a processing job and hands it to the Worker via celery once the
    transaction commits (so the Worker never reads a job that is not there yet).

    "tags" is special: it's an AI-free, Django-only resync of ARTIST/GROUP/
    PERSON tags from the contract's already-stored fields (see
    resync_contract_tags), so it never touches the Cloudflare pipeline. When
    it's the only stage selected on a partial retry, the job completes
    synchronously and instantly; combined with other stages, it still runs
    right away (cheap) while those other stages dispatch normally.
    """
    retry_options = (metadata or {}).get("retry_options") or {}
    job = ContractProcessingJob.objects.create(
        workspace=workspace,
        contract=contract,
        initiated_by=user,
        task_type=task_type,
        status=ContractProcessingJob.Status.QUEUED,
        current_stage="queued",
        metadata=metadata or {},
    )
    quiet = is_classify_only(retry_options)
    if contract is not None and not quiet:
        contract.processing_status = "PROCESSING"
        contract.save(update_fields=["processing_status", "updated_at"])

    if retry_options.get("tags"):
        from .internal import resync_contract_tags

        resync_contract_tags(contract)

        other_stages_selected = any(retry_options.get(key) for key in RETRY_OPTION_KEYS if key != "tags")
        if task_type == ContractProcessingJob.TaskType.RETRY_PARTIAL and not other_stages_selected:
            now = timezone.now()
            job.status = ContractProcessingJob.Status.COMPLETED
            job.progress = 100
            job.current_stage = "done"
            job.started_at = now
            job.finished_at = now
            job.metadata = {
                **job.metadata,
                "steps": [
                    {
                        "code": "syncing_tags",
                        "started_at": now.isoformat(),
                        "finished_at": now.isoformat(),
                        "status": "done",
                    }
                ],
            }
            job.save(update_fields=["status", "progress", "current_stage", "started_at", "finished_at", "metadata"])
            contract.processing_status = "COMPLETED"
            contract.save(update_fields=["processing_status", "updated_at"])
            return job

    # A new run supersedes a re-analysis proposal still waiting for review
    if contract is not None and not quiet and contract.proposed_data is not None:
        contract.proposed_data = None
        contract.save(update_fields=["proposed_data", "updated_at"])

    job_id = str(job.id)
    transaction.on_commit(lambda: dispatch_contract_pipeline.delay(job_id))
    return job


def _by_date(field, descending):
    """Order on a nullable AI-extracted date, undated contracts last.

    Postgres sorts NULLs first on DESC, so a plain "-fecha_fin" would open the
    list with every contract the pipeline could not date — the opposite of
    what someone sorting by expiry wants to see.
    """
    expression = F(field).desc(nulls_last=True) if descending else F(field).asc(nulls_last=True)
    return (expression, "-created_at")


def _get_contract_ordering(value):
    ordering = {
        "-created_at": ("-created_at",),
        "-updated_at": ("-updated_at", "-created_at"),
        "titulo": ("titulo", "-created_at"),
        "-titulo": ("-titulo", "-created_at"),
        "fecha_inicio": _by_date("fecha_inicio", False),
        "-fecha_inicio": _by_date("fecha_inicio", True),
        "fecha_fin": _by_date("fecha_fin", False),
        "-fecha_fin": _by_date("fecha_fin", True),
        "fin_efectiva": _by_date("fecha_fin_efectiva", False),
        "-fin_efectiva": _by_date("fecha_fin_efectiva", True),
    }.get(value, ("-created_at",))
    # A unique tiebreak keeps pages stable
    return (*ordering, "id")


def _int_param(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _multi(params, key):
    """Repeated and comma-separated values: ?tipo=A&tipo=B or ?tipo=A,B."""
    return [item.strip() for raw in params.getlist(key) for item in str(raw).split(",") if item.strip()]


def filter_contracts(params, slug):
    """The list filters, shared by the list and the export."""
    contracts = live_contracts().filter(workspace__slug=slug).select_related("file_asset")
    today = timezone.now().date()

    # The sidebar views: vigentes / vencidos / editoriales
    view = params.get("vista")
    if view in CONTRACT_VIEWS:
        contracts = apply_contract_view(contracts, view, today)

    # Filters over AI-extracted data
    asset_id = params.get("asset_id")
    if asset_id:
        contracts = contracts.filter(file_asset_id=asset_id)
    search = params.get("search")
    if search:
        contracts = contracts.filter(
            Q(titulo__icontains=search)
            | Q(resumen_general__icontains=search)
            | Q(file_asset__attributes__name__icontains=search)
        )
    person = params.get("person")
    if person:
        contracts = contracts.filter(Q(involucrados__icontains=person) | Q(testigos__icontains=person))
    artist = params.get("artist")
    if artist:
        contracts = contracts.filter(artistas__icontains=artist)
    year = params.get("year")
    if year:
        contracts = contracts.filter(Q(fecha_inicio__year=year) | Q(fecha_fin__year=year))
    estatus = _multi(params, "estatus")
    if estatus:
        contracts = contracts.filter(estatus_contrato__in=estatus)
    tipo = _multi(params, "tipo")
    if tipo:
        contracts = contracts.filter(tipo_contrato__in=tipo)
    processing_status = _multi(params, "processing_status")
    if processing_status:
        contracts = contracts.filter(processing_status__in=processing_status)
    tag_ids = params.getlist("tag")
    if tag_ids:
        contracts = contracts.filter(file_asset__tag_links__tag_id__in=tag_ids).distinct()
    fin_after = params.get("fecha_fin_efectiva_after")
    if fin_after:
        contracts = contracts.filter(fecha_fin_efectiva__gte=fin_after)
    fin_before = params.get("fecha_fin_efectiva_before")
    if fin_before:
        contracts = contracts.filter(fecha_fin_efectiva__lte=fin_before)
    # "Por vencer": effective end between today and today + N days
    expiring = _int_param(params.get("vence_en"))
    if expiring is not None and expiring >= 0:
        contracts = contracts.filter(
            fecha_fin_efectiva__gte=today, fecha_fin_efectiva__lte=today + timedelta(days=expiring)
        )
    has_proposal = params.get("has_proposal")
    if has_proposal in ("true", "1"):
        contracts = contracts.filter(proposed_data__isnull=False)
    elif has_proposal in ("false", "0"):
        contracts = contracts.filter(proposed_data__isnull=True)

    return contracts.order_by(*_get_contract_ordering(params.get("order")))


class ContractsEndpoint(FileLibraryBaseView):
    serializer_class = ContractSerializer
    model = Contract

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def get(self, request, slug):
        from plane.utils.contract_works import pending_suggestions_count

        contracts = (
            filter_contracts(request.query_params, slug)
            .defer(*LIST_DEFERRED_FIELDS)
            .annotate(works_suggested=pending_suggestions_count())
        )
        context = {"today": timezone.now().date()}

        # Opt-in pagination; without per_page the plain array stays as before
        per_page = _int_param(request.query_params.get("per_page"))
        if per_page is None:
            serializer = ContractSerializer(contracts, many=True, context=context)
            return Response(serializer.data, status=status.HTTP_200_OK)

        per_page = max(1, min(per_page, MAX_PER_PAGE))
        offset = max(0, _int_param(request.query_params.get("cursor")) or 0)
        page = list(contracts[offset : offset + per_page + 1])
        has_more = len(page) > per_page
        return Response(
            {
                "results": ContractSerializer(page[:per_page], many=True, context=context).data,
                "next_cursor": str(offset + per_page) if has_more else None,
                "total": contracts.count(),
            },
            status=status.HTTP_200_OK,
        )


EXPORT_HEADERS = [
    "Título",
    "Archivo",
    "Artistas",
    "Grupo",
    "Tipo",
    "Estatus",
    "Inicio",
    "Fin",
    "Fin efectiva",
    "Días para vencer",
    "Editorial",
    "Notariado",
    "Involucrados",
    "Testigos",
    "Resumen",
    "Enlace",
]


def _yes_no(value):
    if value is None:
        return ""
    return "Sí" if value else "No"


class ContractsExportEndpoint(FileLibraryBaseView):
    """The filtered list as .xlsx or .csv (?type=xlsx|csv + the list filters)."""

    model = Contract

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def get(self, request, slug):
        from plane.db.models.contract import ContractStatus, ContractType

        today = timezone.now().date()
        origin = (settings.WEB_URL or settings.APP_BASE_URL or request.build_absolute_uri("/")).rstrip("/")
        types = dict(ContractType.choices)
        statuses = dict(ContractStatus.choices)
        contracts = filter_contracts(request.query_params, slug).defer(*LIST_DEFERRED_FIELDS, "proposed_data")
        rows = []
        for contract in contracts.iterator(chunk_size=500):
            effective = contract.fecha_fin_efectiva
            rows.append(
                [
                    contract.titulo or "",
                    (contract.file_asset.attributes or {}).get("name") or "",
                    contract.artistas or "",
                    contract.nombre_grupo or "",
                    types.get(contract.tipo_contrato, contract.tipo_contrato or ""),
                    statuses.get(contract.estatus_contrato, contract.estatus_contrato or ""),
                    contract.fecha_inicio.isoformat() if contract.fecha_inicio else "",
                    contract.fecha_fin.isoformat() if contract.fecha_fin else "",
                    effective.isoformat() if effective else "",
                    (effective - today).days if effective else "",
                    _yes_no(contract.es_editorial),
                    _yes_no(contract.es_notariado),
                    contract.involucrados or "",
                    contract.testigos or "",
                    contract.resumen_general or "",
                    f"{origin}/{slug}/file-library/contracts/analyzed/?peek={contract.id}",
                ]
            )
        kind = "xlsx" if request.query_params.get("type") == "xlsx" else "csv"
        return spreadsheet_response(
            f"contratos-{today:%Y%m%d}", EXPORT_HEADERS, rows, kind=kind, sheet_title="Contratos"
        )


class ContractCheckDuplicatesEndpoint(FileLibraryBaseView):
    """Before uploading: which files are already analyzed contracts.

    Matches the sha256 the web computes; contracts uploaded before hashes
    existed fall back to the same file name and size.
    """

    model = Contract

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def post(self, request, slug):
        files = request.data.get("files")
        if not isinstance(files, list) or len(files) > 500:
            return Response({"error": "files must be a list (max 500)"}, status=status.HTTP_400_BAD_REQUEST)
        files = [item for item in files if isinstance(item, dict)]
        hashes = {clean_hash(item.get("hash")) for item in files} - {None}
        names = {str(item.get("name") or "") for item in files} - {""}

        contracts = (
            live_contracts()
            .filter(workspace__slug=slug)
            .select_related("file_asset")
            .only("id", "titulo", "content_hash", "file_asset__attributes", "file_asset__size")
        )
        by_hash = {}
        for contract in contracts.filter(content_hash__in=hashes) if hashes else []:
            by_hash.setdefault(contract.content_hash, contract)
        by_name = {}
        for contract in contracts.filter(file_asset__attributes__name__in=list(names)) if names else []:
            attributes = contract.file_asset.attributes or {}
            size = attributes.get("size") or contract.file_asset.size
            by_name.setdefault((attributes.get("name"), _int_param(size)), contract)

        results = []
        for item in files:
            name = str(item.get("name") or "")
            match = by_hash.get(clean_hash(item.get("hash"))) or by_name.get((name, _int_param(item.get("size"))))
            results.append(
                {
                    "name": name,
                    "duplicate_of": (
                        {
                            "id": str(match.id),
                            "titulo": match.titulo,
                            "file_name": (match.file_asset.attributes or {}).get("name"),
                        }
                        if match
                        else None
                    ),
                }
            )
        return Response({"results": results}, status=status.HTTP_200_OK)


def resync_tags_if_changed(contract, before):
    """Hand edits to parties re-link their tags (AI-free)."""
    if any(getattr(contract, field) != before.get(field) for field in TAG_SOURCE_FIELDS):
        from .internal import resync_contract_tags

        resync_contract_tags(contract)


def refresh_status(contract, previous_effective):
    """Status follows the effective end, as the daily sync does."""
    if contract.fecha_fin_efectiva != previous_effective:
        derived = status_for(contract.fecha_fin_efectiva)
        if derived and derived != contract.estatus_contrato:
            contract.estatus_contrato = derived
            return True
    return False


class ContractDetailEndpoint(FileLibraryBaseView):
    serializer_class = ContractSerializer
    model = Contract

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def get(self, request, slug, contract_id):
        contract = (
            live_contracts()
            .select_related("file_asset", "source_request__revision__variant")
            .defer("extracted_text")
            .get(id=contract_id, workspace__slug=slug)
        )
        return Response(ContractDetailSerializer(contract).data, status=status.HTTP_200_OK)

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def patch(self, request, slug, contract_id):
        contract = live_contracts().defer("extracted_text").get(id=contract_id, workspace__slug=slug)
        previous_end, previous_effective = contract.fecha_fin, contract.fecha_fin_efectiva
        before = {field: getattr(contract, field) for field in TAG_SOURCE_FIELDS}
        serializer = ContractUpdateSerializer(contract, data=request.data, partial=True)
        if serializer.is_valid():
            contract = serializer.save()
            # The views decide vigente/vencido on the effective end, so editing
            # the end date has to carry it along — keeping whatever extension
            # the contract already had — unless the effective end was sent too.
            if "fecha_fin" in request.data and "fecha_fin_efectiva" not in request.data:
                effective = shifted_effective_end(previous_end, previous_effective, contract.fecha_fin)
                if effective != contract.fecha_fin_efectiva:
                    contract.fecha_fin_efectiva = effective
                    contract.save(update_fields=["fecha_fin_efectiva"])
            if "estatus_contrato" not in request.data and refresh_status(contract, previous_effective):
                contract.save(update_fields=["estatus_contrato"])
            resync_tags_if_changed(contract, before)
            contract = (
                Contract.objects.select_related("file_asset", "source_request__revision__variant")
                .defer("extracted_text")
                .get(id=contract.id)
            )
            return Response(ContractDetailSerializer(contract).data, status=status.HTTP_200_OK)
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def delete(self, request, slug, contract_id):
        contract = Contract.objects.get(id=contract_id, workspace__slug=slug)
        delete_contracts([contract])
        return Response(status=status.HTTP_204_NO_CONTENT)


def shifted_effective_end(previous_end, previous_effective, new_end):
    """The effective end after the end date moves, keeping the extension gap."""
    if new_end is None:
        return None
    if previous_end is None or previous_effective is None:
        return new_end
    return new_end + (previous_effective - previous_end)


def delete_contracts(contracts):
    """Deletes analyzed contracts and their PDFs.

    The PDF is the contract, so its asset goes too — otherwise it would linger
    in Archivos under "Contratos" with nothing behind it. The asset is soft
    deleted, exactly as deleting it from Archivos does. The analysis is hard
    deleted, as the signature workflow does with its own: that cascades through
    chunks, embeddings, jobs and contract chats at once, so the chat stops
    citing it immediately, and it frees the one-to-one slot on the asset.
    A signature request that produced the analysis keeps its record
    (SET_NULL).
    """
    contracts = list(contracts)
    if not contracts:
        return
    with transaction.atomic():
        FileAsset.objects.filter(id__in=[contract.file_asset_id for contract in contracts]).update(
            is_deleted=True, deleted_at=timezone.now()
        )
        for contract in contracts:
            contract.delete(soft=False)


def _retry_options(raw, contract_has_text):
    """Per-stage selection; an empty selection is a full retry, which skips
    re-running OCR when the text is already there."""
    raw = raw if isinstance(raw, dict) else {}
    options = {key: bool(raw.get(key)) for key in RETRY_OPTION_KEYS}
    if not any(options.values()):
        options = {key: True for key in RETRY_OPTION_KEYS}
        if contract_has_text:
            options["extract_text"] = False
    return options


def _job_active_response():
    return Response({"error": "job_active"}, status=status.HTTP_409_CONFLICT)


class ContractRetryEndpoint(FileLibraryBaseView):
    model = ContractProcessingJob

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def post(self, request, slug, contract_id):
        contract = (
            Contract.objects.select_related("workspace")
            .defer("extracted_text")
            .get(id=contract_id, workspace__slug=slug)
        )
        if has_active_job(contract.id):
            return _job_active_response()
        retry_options = _retry_options(request.data, has_text(contract.id))
        job = create_and_dispatch_job(
            workspace=contract.workspace,
            contract=contract,
            task_type=ContractProcessingJob.TaskType.RETRY_PARTIAL,
            user=request.user,
            metadata={"retry_options": retry_options},
        )
        return Response(ContractProcessingJobSerializer(job).data, status=status.HTTP_201_CREATED)


class ContractReanalyzeEndpoint(FileLibraryBaseView):
    model = ContractProcessingJob

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def post(self, request, slug, contract_id):
        contract = (
            Contract.objects.select_related("workspace")
            .defer("extracted_text")
            .get(id=contract_id, workspace__slug=slug)
        )
        if not has_text(contract.id):
            return Response(
                {"error": "The contract has no extracted text yet"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if has_active_job(contract.id):
            return _job_active_response()
        job = create_and_dispatch_job(
            workspace=contract.workspace,
            contract=contract,
            task_type=ContractProcessingJob.TaskType.REANALYZE,
            user=request.user,
        )
        return Response(ContractProcessingJobSerializer(job).data, status=status.HTTP_201_CREATED)


class ContractReanalyzeConfirmEndpoint(FileLibraryBaseView):
    """Accepts (all or some fields of) or discards a re-analysis proposal.
    Body: {"accept": bool, "fields"?: [column names]}."""

    model = Contract

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def post(self, request, slug, contract_id):
        from .internal import apply_extracted_data

        contract = live_contracts().defer("extracted_text").get(id=contract_id, workspace__slug=slug)
        if contract.proposed_data is None:
            return Response({"error": "There is no proposed data to confirm"}, status=status.HTTP_400_BAD_REQUEST)
        fields = request.data.get("fields")
        if fields is not None and (not isinstance(fields, list) or not all(isinstance(f, str) for f in fields)):
            return Response({"error": "fields must be a list of field names"}, status=status.HTTP_400_BAD_REQUEST)

        with transaction.atomic():
            if request.data.get("accept"):
                proposal = dict(contract.proposed_data)
                model_used = proposal.pop("_model_used", None)
                apply_extracted_data(contract, proposal, fields=fields, allow_clear=True)
                contract.processed_at = timezone.now()
                if model_used:
                    contract.ai_model_used = str(model_used)[:255]
            # Discarding leaves the contract exactly as it was
            contract.proposed_data = None
            contract.save()

        contract = (
            Contract.objects.select_related("file_asset", "source_request__revision__variant")
            .defer("extracted_text")
            .get(id=contract.id)
        )
        return Response(ContractDetailSerializer(contract).data, status=status.HTTP_200_OK)


class ContractJobCancelEndpoint(FileLibraryBaseView):
    """Stops an active run: the job is cancelled, the contract goes back to
    how it was, and the Worker is asked to terminate the instance."""

    model = ContractProcessingJob

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def post(self, request, slug, contract_id, job_id):
        from .internal import stop_job

        with transaction.atomic():
            job = (
                ContractProcessingJob.objects.select_for_update()
                .filter(id=job_id, contract_id=contract_id, workspace__slug=slug)
                .first()
            )
            if job is None:
                return Response({"error": "Job not found"}, status=status.HTTP_404_NOT_FOUND)
            if job.status not in ACTIVE_JOB_STATUSES:
                return Response({"error": "job_not_active"}, status=status.HTTP_409_CONFLICT)
            stop_job(job, ContractProcessingJob.Status.CANCELLED, "cancelled", None)
            transaction.on_commit(lambda: terminate_contract_pipeline_task.delay(str(job_id)))
        return Response(ContractProcessingJobSerializer(job).data, status=status.HTTP_200_OK)


class ContractsBulkEndpoint(FileLibraryBaseView):
    """Bulk actions over contracts: retry, re-analyze, delete, move them in or
    out of Editoriales ("editorial", with es_editorial true/false), or edit
    fields ("update", with fields)."""

    model = ContractProcessingJob

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def post(self, request, slug):
        action = request.data.get("action")
        contract_ids = request.data.get("contract_ids") or request.data.get("ids") or []
        actions = ("retry", "reanalyze", "delete", "editorial", "update")
        if action not in actions or not isinstance(contract_ids, list) or not contract_ids:
            return Response(
                {"error": "action (retry|reanalyze|delete|editorial|update) and contract_ids are required"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if action == "editorial":
            # Moving between the sidebar views by hand. Vigente/vencido follows
            # the dates, so the only thing a person files is editorial or not.
            value = request.data.get("es_editorial")
            if not isinstance(value, bool):
                return Response({"error": "es_editorial must be true or false"}, status=status.HTTP_400_BAD_REQUEST)
            contracts = Contract.objects.filter(id__in=contract_ids, workspace__slug=slug)
            updated = [str(contract_id) for contract_id in contracts.values_list("id", flat=True)]
            contracts.update(es_editorial=value, updated_at=timezone.now())
            return Response({"updated": updated}, status=status.HTTP_200_OK)

        if action == "update":
            return self._update(request, slug, contract_ids)

        if action == "delete":
            doomed = list(Contract.objects.filter(id__in=contract_ids, workspace__slug=slug))
            # Read the ids first: a hard delete sets each instance's pk to None.
            deleted_ids = [str(contract.id) for contract in doomed]
            delete_contracts(doomed)
            return Response({"deleted": deleted_ids}, status=status.HTTP_200_OK)

        contracts = list(
            Contract.objects.filter(id__in=contract_ids, workspace__slug=slug)
            .select_related("workspace")
            .defer("extracted_text")
        )
        ids = [contract.id for contract in contracts]
        busy = set(
            ContractProcessingJob.objects.filter(contract_id__in=ids, status__in=ACTIVE_JOB_STATUSES).values_list(
                "contract_id", flat=True
            )
        )
        with_text = set(
            Contract.objects.filter(id__in=ids, extracted_text__isnull=False)
            .exclude(extracted_text="")
            .values_list("id", flat=True)
        )
        raw_options = request.data.get("retry_options") or {}

        dispatched, skipped = [], []
        for contract in contracts:
            # Skip contracts that already have an active run
            if contract.id in busy or (action == "reanalyze" and contract.id not in with_text):
                skipped.append(str(contract.id))
                continue
            job = create_and_dispatch_job(
                workspace=contract.workspace,
                contract=contract,
                task_type=(
                    ContractProcessingJob.TaskType.REANALYZE
                    if action == "reanalyze"
                    else ContractProcessingJob.TaskType.RETRY_PARTIAL
                ),
                user=request.user,
                metadata=(
                    {"retry_options": _retry_options(raw_options, contract.id in with_text)}
                    if action == "retry"
                    else None
                ),
            )
            dispatched.append(str(job.id))
        return Response({"dispatched": dispatched, "skipped": skipped}, status=status.HTTP_200_OK)

    def _update(self, request, slug, contract_ids):
        fields = request.data.get("fields")
        if not isinstance(fields, dict) or not fields:
            return Response({"error": "fields is required"}, status=status.HTTP_400_BAD_REQUEST)
        unknown = sorted(set(fields) - set(BULK_UPDATE_FIELDS))
        if unknown:
            return Response({"error": f"fields not editable in bulk: {', '.join(unknown)}"}, status=400)
        serializer = ContractUpdateSerializer(data=fields, partial=True)
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
        values = serializer.validated_data
        start, end = values.get("fecha_inicio"), values.get("fecha_fin")
        if start and end and end < start:
            return Response({"error": "fecha_fin must not be before fecha_inicio"}, status=400)

        updated = []
        with transaction.atomic():
            for contract in Contract.objects.filter(id__in=contract_ids, workspace__slug=slug).defer("extracted_text"):
                previous_end, previous_effective = contract.fecha_fin, contract.fecha_fin_efectiva
                before = {field: getattr(contract, field) for field in TAG_SOURCE_FIELDS}
                for field, value in values.items():
                    setattr(contract, field, value)
                if "fecha_fin" in values:
                    contract.fecha_fin_efectiva = shifted_effective_end(
                        previous_end, previous_effective, contract.fecha_fin
                    )
                if "estatus_contrato" not in values:
                    refresh_status(contract, previous_effective)
                contract.save()
                resync_tags_if_changed(contract, before)
                updated.append(str(contract.id))
        return Response({"updated": updated}, status=status.HTTP_200_OK)


class ContractJobsEndpoint(FileLibraryBaseView):
    serializer_class = ContractProcessingJobSerializer
    model = ContractProcessingJob

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def get(self, request, slug, contract_id=None):
        jobs = ContractProcessingJob.objects.filter(workspace__slug=slug)
        if contract_id:
            jobs = jobs.filter(contract_id=contract_id)
        if request.query_params.get("active"):
            jobs = jobs.filter(status__in=ACTIVE_JOB_STATUSES)
        contract_ids = request.query_params.getlist("contract_ids")
        if contract_ids:
            jobs = jobs.filter(contract_id__in=contract_ids)
        serializer = ContractProcessingJobSerializer(jobs.order_by("-created_at")[:100], many=True)
        return Response(serializer.data, status=status.HTTP_200_OK)


class ContractQueryEndpoint(FileLibraryBaseView):
    serializer_class = ContractQuerySerializer
    model = ContractQuery

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def get(self, request, slug):
        # Each person's query history is their own
        queries = ContractQuery.objects.filter(workspace__slug=slug, user=request.user).order_by("-created_at")[:50]
        return Response(ContractQuerySerializer(queries, many=True).data, status=status.HTTP_200_OK)

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def post(self, request, slug):
        user_query = (request.data.get("query") or "").strip()
        if not user_query:
            return Response({"error": "query is required"}, status=status.HTTP_400_BAD_REQUEST)

        workspace = Workspace.objects.get(slug=slug)
        job = ContractProcessingJob.objects.create(
            workspace=workspace,
            contract=None,
            initiated_by=request.user,
            task_type=ContractProcessingJob.TaskType.QUERY,
            status=ContractProcessingJob.Status.QUEUED,
            current_stage="queued",
        )
        query = ContractQuery.objects.create(workspace=workspace, user=request.user, query=user_query, job=job)
        job_id, query_id = str(job.id), str(query.id)
        transaction.on_commit(lambda: dispatch_contract_query.delay(job_id, query_id))
        return Response(ContractQuerySerializer(query).data, status=status.HTTP_201_CREATED)
