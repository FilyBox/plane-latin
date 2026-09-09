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
from plane.db.models import ExpenseDocument, FileAsset, Workspace
from plane.db.models.finance import ExpenseImport
from plane.settings.storage import S3Storage
from plane.utils.expense_recurrence import materialize_expenses
from .base import FinanceBaseView


class ImportSerializer(serializers.ModelSerializer):
    name = serializers.SerializerMethodField()

    class Meta:
        model = ExpenseImport
        fields = ["id", "asset_id", "name", "status", "stage", "data", "error", "expense_id", "created_at"]

    def get_name(self, obj):
        return (obj.asset.attributes or {}).get("name", "Document")


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


class ExpenseImportEndpoint(FinanceBaseView):
    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def get(self, request, slug):
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
        jobs = []
        for asset in assets:
            job, created = ExpenseImport.objects.get_or_create(workspace=workspace, asset=asset)
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
            if retry:
                stale = (timezone.now() - job.updated_at).total_seconds() > 1800
                if job.expense_id or (job.status not in ("FAILED",) and not stale):
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
        job.delete()
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
            if job.status == "IMPORTED":
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
            if new_status == "FAILED":
                job.error = "Analysis failed. Check the document and retry."
            job.save()
        return Response({"status": "ok"})
