"""Receipt ingestion: uploaded assets become reviewable drafts, never paid expenses."""
import uuid
import requests
from django.conf import settings
from django.db import transaction
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework import serializers
from rest_framework.response import Response
from plane.app.permissions import ROLE, allow_permission
from plane.app.serializers.finance import ExpenseSerializer
from plane.app.views.contract.internal import InternalBaseView
import unicodedata
from datetime import timedelta
from decimal import Decimal, InvalidOperation

from django.db.models import Q

from plane.db.models import BudgetScenario, Expense, ExpenseCategory, ExpenseDocument, FileAsset, Workspace
from plane.db.models.finance import ExpenseImport
from plane.settings.storage import S3Storage
from plane.utils.expense_recurrence import materialize_expenses
from .base import FinanceBaseView


class ImportSerializer(serializers.ModelSerializer):
    name = serializers.SerializerMethodField()

    class Meta:
        model = ExpenseImport
        fields = ["id", "asset_id", "name", "status", "stage", "data", "error", "expense_id", "created_at", "scenario_id"]

    def get_name(self, obj):
        return (obj.asset.attributes or {}).get("name", "Document")


# An analysis that never reported back within this window is treated as failed,
# so it can be retried instead of spinning forever in the queue.
STALE_AFTER = timedelta(minutes=30)


def _plain(value):
    text = unicodedata.normalize("NFKD", str(value or "").lower())
    return "".join(char for char in text if not unicodedata.combining(char))


def _suggestions(job, data):
    """Budget and category the extracted expense most likely belongs to.

    Deterministic on purpose: a budget whose period holds the expense date in
    the same currency (an active one first), and a category whose name shows up
    in the tags, concept or vendor. The reviewer confirms or changes both.
    """
    suggestion = {"scenario": str(job.scenario_id) if job.scenario_id else None, "category": None}
    expense_date = data.get("expense_date")
    currency = str(data.get("currency") or "").upper()
    if not suggestion["scenario"] and expense_date:
        scenarios = (
            BudgetScenario.objects.filter(
                workspace_id=job.workspace_id, period_start__lte=expense_date, period_end__gte=expense_date
            )
            .exclude(status=BudgetScenario.Status.ARCHIVED)
            .order_by("-updated_at")
        )
        if currency:
            scenarios = scenarios.filter(currency=currency)
        ranked = sorted(scenarios[:20], key=lambda item: item.status != BudgetScenario.Status.ACTIVE)
        if ranked:
            suggestion["scenario"] = str(ranked[0].id)
    words = " ".join(
        [_plain(tag) for tag in data.get("tags") or []] + [_plain(data.get("concept")), _plain(data.get("vendor"))]
    )
    best, best_length = None, 0
    for category in ExpenseCategory.objects.filter(workspace_id=job.workspace_id).only("id", "name"):
        name = _plain(category.name).strip()
        if len(name) >= 3 and name in words and len(name) > best_length:
            best, best_length = category, len(name)
    if best:
        suggestion["category"] = str(best.id)
    return suggestion


def _duplicates(job, data):
    """Expenses already in the ledger that look like this same invoice."""
    reference = str(data.get("reference") or "").strip()
    vendor = str(data.get("vendor") or "").strip()
    match = Q()
    if reference:
        match |= Q(reference__iexact=reference)
    try:
        amount = Decimal(str(data.get("amount")))
    except (InvalidOperation, TypeError, ValueError):
        amount = None
    if vendor and amount is not None and data.get("expense_date"):
        match |= Q(vendor__iexact=vendor, amount=amount, expense_date=data.get("expense_date"))
    if not match:
        return []
    rows = Expense.objects.filter(match, workspace_id=job.workspace_id).exclude(status="CANCELLED")[:5]
    return [
        {
            "id": str(row.id),
            "concept": row.concept or row.vendor,
            "amount": str(row.amount),
            "currency": row.currency,
            "expense_date": row.expense_date.isoformat(),
        }
        for row in rows
    ]


def dispatch_import(job):
    url = getattr(settings, "CF_EXPENSE_WORKER_TRIGGER_URL", "")
    secret = getattr(settings, "CF_WORKER_TRIGGER_SECRET", "")
    if not url or not secret:
        job.status, job.error = "FAILED", "Expense analysis is not configured. Configure CF_EXPENSE_WORKER_TRIGGER_URL."
        job.save(update_fields=["status", "error"])
        return
    try:
        response = requests.post(url.rstrip("/") + "/trigger/extract", json={
            "job_id": str(job.id), "workspace_id": str(job.workspace_id), "attempt": str(job.attempt),
        }, headers={"X-Trigger-Secret": secret}, timeout=20)
        response.raise_for_status()
    except requests.RequestException:
        ExpenseImport.objects.filter(id=job.id, status="QUEUED").update(
            status="FAILED", error="Could not start analysis. Retry when the analysis service is available."
        )


def cancel_worker(attempt):
    url = getattr(settings, "CF_EXPENSE_WORKER_TRIGGER_URL", "")
    if not url:
        return
    try:
        requests.post(url.rstrip("/") + "/trigger/cancel", json={"attempt": attempt},
                      headers={"X-Trigger-Secret": getattr(settings, "CF_WORKER_TRIGGER_SECRET", "")}, timeout=5)
    except requests.RequestException:
        # The invalidated attempt also rejects every late callback.
        pass


class ExpenseImportEndpoint(FinanceBaseView):
    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def get(self, request, slug):
        ExpenseImport.objects.filter(
            workspace__slug=slug, status__in=("QUEUED", "RUNNING"), updated_at__lt=timezone.now() - STALE_AFTER
        ).update(status="FAILED", stage="", error="The analysis took too long. Retry it.")
        jobs = ExpenseImport.objects.filter(workspace__slug=slug).select_related("asset")[:200]
        return Response(ImportSerializer(jobs, many=True).data)

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def post(self, request, slug):
        workspace = Workspace.objects.get(slug=slug)
        field = serializers.ListField(child=serializers.UUIDField(), min_length=1, max_length=30)
        ids = field.run_validation(request.data.get("asset_ids"))
        assets = list(FileAsset.objects.filter(id__in=ids, workspace=workspace, is_uploaded=True, is_deleted=False))
        if len(assets) != len(set(ids)):
            return Response({"error": "Some files are unavailable in this workspace"}, status=400)
        allowed = {"application/pdf", "application/xml", "text/xml", "image/png", "image/jpeg", "image/webp", "image/tiff"}
        for asset in assets:
            attributes = asset.attributes or {}
            if attributes.get("type") not in allowed or int(attributes.get("size") or 0) > 20 * 1024 * 1024:
                return Response({"error": "Upload PDF, XML or receipt images up to 20 MB"}, status=400)
        scenario_id = serializers.UUIDField(allow_null=True).run_validation(request.data.get("scenario"))
        if scenario_id:
            get_object_or_404(BudgetScenario, id=scenario_id, workspace=workspace)
        jobs = []
        for asset in assets:
            job = ExpenseImport.all_objects.filter(workspace=workspace, asset=asset).first()
            created = job is None
            if created:
                job = ExpenseImport.objects.create(
                    workspace=workspace, asset=asset, scenario_id=scenario_id, created_by=request.user
                )
            elif job.deleted_at is not None:
                # The file was analysed before and that analysis was discarded:
                # start it over instead of hitting the one-job-per-file rule.
                job.deleted_at = None
                job.status, job.stage, job.error, job.data, job.expense = "QUEUED", "", "", {}, None
                job.attempt, job.scenario_id = uuid.uuid4(), scenario_id
                job.save()
                created = True
            if created:
                dispatch_import(job)
            job.refresh_from_db()
            jobs.append(job)
        return Response(ImportSerializer(jobs, many=True).data, status=201)


class ExpenseImportDetailEndpoint(FinanceBaseView):
    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def post(self, request, slug, job_id):
        retry = request.data.get("action") == "retry"
        with transaction.atomic():
            job = get_object_or_404(ExpenseImport.objects.select_for_update(), id=job_id, workspace__slug=slug)
            if request.data.get("action") == "cancel":
                if job.status not in ("QUEUED", "RUNNING"):
                    return Response({"error": "Only pending analysis can be cancelled"}, status=409)
                previous_attempt = str(job.attempt)
                job.status, job.attempt, job.stage = "CANCELLED", uuid.uuid4(), ""
                job.save()
                transaction.on_commit(lambda: cancel_worker(previous_attempt))
                return Response(ImportSerializer(job).data)
            if retry:
                stale = (timezone.now() - job.updated_at).total_seconds() > 1800
                if job.expense_id or (job.status not in ("FAILED", "CANCELLED") and not stale):
                    return Response({"error": "This analysis cannot be retried yet"}, status=409)
                job.attempt, job.status, job.error = uuid.uuid4(), "QUEUED", ""
                job.save()
            else:
                if job.expense_id:
                    return Response(ExpenseSerializer(job.expense).data)
                if job.status != "READY":
                    return Response({"error": "Wait for analysis before saving"}, status=409)
                serializer = ExpenseSerializer(data=request.data.get("expense", {}), context={"workspace_id": job.workspace_id})
                serializer.is_valid(raise_exception=True)
                expense = serializer.save(workspace_id=job.workspace_id)
                ExpenseDocument.objects.create(workspace_id=job.workspace_id, expense=expense, asset=job.asset)
                job.expense, job.status = expense, "IMPORTED"
                job.save()
                return Response(ExpenseSerializer(expense).data, status=201)
        dispatch_import(job)
        job.refresh_from_db()
        return Response(ImportSerializer(job).data)

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def delete(self, request, slug, job_id):
        job = get_object_or_404(ExpenseImport, id=job_id, workspace__slug=slug)
        previous_attempt = str(job.attempt)
        job.delete()
        cancel_worker(previous_attempt)
        return Response(status=204)


class ExpenseGenerateEndpoint(FinanceBaseView):
    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def post(self, request, slug):
        materialize_expenses(Workspace.objects.get(slug=slug).id)
        return Response({"status": "ok"})


class InternalExpenseImportEndpoint(InternalBaseView):
    def get(self, request, workspace_id, job_id, attempt):
        job = get_object_or_404(ExpenseImport.objects.select_related("asset"), id=job_id, workspace_id=workspace_id, attempt=attempt)
        storage = S3Storage.for_asset(job.asset)
        return Response({
            "url": storage.generate_presigned_url(object_name=job.asset.asset.name),
            "type": (job.asset.attributes or {}).get("type"),
            "name": (job.asset.attributes or {}).get("name"),
            "s3_key": job.asset.asset.name, "s3_bucket": storage.aws_storage_bucket_name,
        })

    def post(self, request, workspace_id, job_id, attempt):
        with transaction.atomic():
            job = get_object_or_404(ExpenseImport.objects.select_for_update(), id=job_id, workspace_id=workspace_id, attempt=attempt)
            if job.status in ("IMPORTED", "CANCELLED"):
                return Response({"status": "ok"})
            new_status = request.data.get("status")
            if new_status not in ("RUNNING", "READY", "FAILED"):
                return Response({"error": "Invalid status"}, status=400)
            if job.status == "READY" and new_status != "READY":
                return Response({"status": "ok"})
            job.status = new_status
            job.stage = str(request.data.get("stage", ""))[:255]
            if new_status == "READY":
                data = request.data.get("data")
                if not isinstance(data, dict) or len(str(data)) > 50000:
                    return Response({"error": "Invalid extraction"}, status=400)
                allowed = ("concept", "vendor", "amount", "currency", "expense_date", "reference", "description", "tags", "warnings")
                job.data = {key: data[key] for key in allowed if key in data}
                # Never registered on its own: the extraction waits as a draft
                # for someone to review it, with the budget and category it most
                # likely belongs to and any invoice that looks already recorded.
                job.data["suggestions"] = _suggestions(job, job.data)
                job.data["duplicates"] = _duplicates(job, job.data)
                job.stage, job.error = "", ""
            if new_status == "FAILED":
                job.error = "Analysis failed. Check the document and retry."
            job.save()
        return Response({"status": "ok"})
