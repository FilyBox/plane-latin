# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

import logging
from datetime import timedelta

from celery import shared_task
from django.conf import settings
from django.core.mail import EmailMultiAlternatives, get_connection
from django.template.loader import render_to_string
from django.db.models import Q
from django.utils import timezone
from django.utils.html import strip_tags

from plane.license.utils.instance_value import get_email_configuration
from plane.utils.exception_logger import log_exception
from plane.utils.worker_client import (
    WorkerUnreachableError,
    terminate_contract_pipeline,
    trigger_contract_pipeline,
    trigger_contract_query,
)

logger = logging.getLogger(__name__)


@shared_task(bind=True, max_retries=3)
def dispatch_contract_pipeline(self, job_id):
    """Asks the Cloudflare Worker to start (or retry) a contract pipeline run.
    Fire-and-forget from the request thread. Network errors retry with
    backoff; anything else (or the last retry) marks the job FAILED so the UI
    can offer a retry.
    """
    from plane.db.models import ContractProcessingJob

    job = ContractProcessingJob.objects.select_related("contract").filter(id=job_id).first()
    # A job cancelled (or reaped) before the trigger went out stays stopped
    if job is None or job.status != ContractProcessingJob.Status.QUEUED:
        return

    try:
        # "tags" is a Django-only stage (resync_contract_tags runs it directly
        # in create_and_dispatch_job) — the Cloudflare pipeline has no step for
        # it and shouldn't receive it.
        retry_options = (job.metadata or {}).get("retry_options") or {}
        worker_retry_options = {key: value for key, value in retry_options.items() if key != "tags"}
        instance_id = trigger_contract_pipeline(
            job_id=job.id,
            contract_id=job.contract_id,
            workspace_id=job.workspace_id,
            asset_id=job.contract.file_asset_id,
            mode=job.task_type,
            retry_options=worker_retry_options,
        )
        ContractProcessingJob.objects.filter(id=job.id).update(
            workflow_instance_id=instance_id or str(job.id), updated_at=timezone.now()
        )
    except WorkerUnreachableError as e:
        if self.request.retries < self.max_retries:
            raise self.retry(exc=e, countdown=20 * (2**self.request.retries))
        _fail_dispatch(job, e)
    except Exception as e:
        _fail_dispatch(job, e)


def _fail_dispatch(job, error):
    from plane.app.views.contract.base import is_classify_only
    from plane.app.views.contract.internal import track_step
    from plane.db.models import ContractProcessingJob

    now = timezone.now()
    metadata = dict(job.metadata or {})
    track_step(metadata, None, now, final_status="failed")
    job.status = ContractProcessingJob.Status.FAILED
    job.current_stage = "failed"
    job.error = {"message": "No se pudo iniciar el análisis", "stage": "starting"}
    job.finished_at = now
    job.metadata = metadata
    job.save(update_fields=["status", "current_stage", "error", "finished_at", "metadata", "updated_at"])
    # Mirror the failure onto the contract — dispatch marked it PROCESSING
    # before the trigger call, and nothing else will ever move it forward.
    if job.contract_id and not is_classify_only(metadata.get("retry_options") or {}):
        job.contract.processing_status = "ERROR"
        job.contract.save(update_fields=["processing_status"])
    log_exception(error)


@shared_task
def terminate_contract_pipeline_task(job_id):
    """Best effort: stopping the Workflow instance saves the rest of its cost.
    The job is already marked stopped on Django's side either way."""
    try:
        terminate_contract_pipeline(job_id)
    except Exception as e:
        logger.info("Could not terminate contract pipeline %s: %s", job_id, e)


@shared_task
def dispatch_contract_query(job_id, query_id):
    """Asks the Worker to start the NL query fan-out workflow."""
    from plane.db.models import ContractProcessingJob, ContractQuery

    job = ContractProcessingJob.objects.filter(id=job_id).first()
    query = ContractQuery.objects.filter(id=query_id).first()
    if job is None or query is None:
        return

    try:
        instance_id = trigger_contract_query(
            job_id=job.id,
            query_id=query.id,
            workspace_id=job.workspace_id,
            user_query=query.query,
        )
        job.workflow_instance_id = instance_id
        job.save(update_fields=["workflow_instance_id"])
    except Exception as e:
        job.status = ContractProcessingJob.Status.FAILED
        job.error = {"message": str(e), "stage": "dispatch"}
        job.finished_at = timezone.now()
        job.save(update_fields=["status", "error", "finished_at"])
        query.status = ContractProcessingJob.Status.FAILED
        query.save(update_fields=["status"])
        log_exception(e)


@shared_task
def send_contract_query_email(query_id):
    """Emails the NL query result to the requesting user via the instance SMTP
    configuration (same pattern as magic_link_code_task).
    """
    from plane.db.models import ContractQuery

    query = ContractQuery.objects.select_related("user", "workspace").filter(id=query_id).first()
    if query is None or query.result is None:
        return

    try:
        (
            EMAIL_HOST,
            EMAIL_HOST_USER,
            EMAIL_HOST_PASSWORD,
            EMAIL_PORT,
            EMAIL_USE_TLS,
            EMAIL_USE_SSL,
            EMAIL_FROM,
        ) = get_email_configuration()

        result = query.result or {}
        subject = f"Resultado de tu consulta de contratos — {query.workspace.name}"
        context = {
            "query": query.query,
            "summary": result.get("summary", ""),
            "matches": result.get("matches", []),
            "scanned_count": result.get("scanned_count", 0),
            "workspace_name": query.workspace.name,
        }
        html_content = render_to_string("emails/contract_query_result.html", context)
        text_content = strip_tags(html_content)

        connection = get_connection(
            host=EMAIL_HOST,
            port=int(EMAIL_PORT),
            username=EMAIL_HOST_USER,
            password=EMAIL_HOST_PASSWORD,
            use_tls=EMAIL_USE_TLS == "1",
            use_ssl=EMAIL_USE_SSL == "1",
        )
        msg = EmailMultiAlternatives(
            subject=subject,
            body=text_content,
            from_email=EMAIL_FROM,
            to=[query.user.email],
            connection=connection,
        )
        msg.attach_alternative(html_content, "text/html")
        msg.send()

        query.emailed_at = timezone.now()
        query.save(update_fields=["emailed_at"])
        logger.info("Contract query result email sent to %s", query.user.email)
    except Exception as e:
        log_exception(e)


@shared_task
def sync_contract_status_by_date():
    """Keeps `estatus_contrato` true to the effective end date.

    The AI reads the status once, at analysis time, so without this a contract
    stays VIGENTE long after it ends. The vigentes/vencidos views already decide
    by date; this keeps the status column agreeing with them. Contracts with no
    effective end keep what the AI read from the text.
    """
    from plane.db.models import Contract

    today = timezone.now().date()
    dated = Contract.objects.filter(fecha_fin_efectiva__isnull=False)
    expired = (
        dated.filter(fecha_fin_efectiva__lt=today)
        .exclude(estatus_contrato="FINALIZADO")
        .update(estatus_contrato="FINALIZADO")
    )
    active = (
        dated.filter(fecha_fin_efectiva__gte=today).exclude(estatus_contrato="VIGENTE").update(estatus_contrato="VIGENTE")
    )
    logger.info("Contract status sync: %s now FINALIZADO, %s now VIGENTE", expired, active)
    return {"finalizado": expired, "vigente": active}


# Stuck jobs: queued and never handed to the Worker, or silent for too long
QUEUED_TIMEOUT = timedelta(minutes=30)
SILENT_TIMEOUT = timedelta(minutes=45)
STUCK_MESSAGE = "Sin avance; se detuvo"


@shared_task
def reap_stuck_contract_jobs():
    """Fails jobs that stopped reporting, so they stop showing as running and
    bulk retry no longer skips their contracts."""
    from plane.app.views.contract.internal import stop_job
    from plane.db.models import ContractProcessingJob

    Status = ContractProcessingJob.Status
    now = timezone.now()
    never_dispatched = Q(workflow_instance_id__isnull=True) | Q(workflow_instance_id="")
    stuck = ContractProcessingJob.objects.filter(
        Q(status=Status.QUEUED, created_at__lt=now - QUEUED_TIMEOUT) & never_dispatched
        | Q(status=Status.QUEUED, updated_at__lt=now - SILENT_TIMEOUT) & ~never_dispatched
        | Q(status=Status.RUNNING, updated_at__lt=now - SILENT_TIMEOUT)
    )
    reaped = []
    for job in stuck:
        was_dispatched = bool(job.workflow_instance_id)
        stop_job(job, Status.FAILED, "timeout", STUCK_MESSAGE)
        if was_dispatched:
            terminate_contract_pipeline_task.delay(str(job.id))
        reaped.append(str(job.id))
    if reaped:
        logger.info("Reaped %s stuck contract jobs", len(reaped))
    return reaped


# Days before the effective end at which an alert goes out
EXPIRY_THRESHOLDS = (60, 30, 7)


def pending_expiry_alert(effective_end, alerts, today):
    """(days_left, thresholds to mark sent) when an alert is due, else None.

    Thresholds are tracked per effective end: moving the date starts over.
    A contract first seen inside several windows gets one alert for all.
    """
    if effective_end is None:
        return None
    days = (effective_end - today).days
    if days < 0:
        return None
    alerts = alerts if isinstance(alerts, dict) else {}
    sent = set(alerts.get("sent") or []) if alerts.get("for") == effective_end.isoformat() else set()
    due = [threshold for threshold in EXPIRY_THRESHOLDS if days <= threshold and threshold not in sent]
    return (days, due) if due else None


def _send_html_email(subject, html_content, to):
    (
        EMAIL_HOST,
        EMAIL_HOST_USER,
        EMAIL_HOST_PASSWORD,
        EMAIL_PORT,
        EMAIL_USE_TLS,
        EMAIL_USE_SSL,
        EMAIL_FROM,
    ) = get_email_configuration()
    connection = get_connection(
        host=EMAIL_HOST,
        port=int(EMAIL_PORT),
        username=EMAIL_HOST_USER,
        password=EMAIL_HOST_PASSWORD,
        use_tls=EMAIL_USE_TLS == "1",
        use_ssl=EMAIL_USE_SSL == "1",
    )
    msg = EmailMultiAlternatives(
        subject=subject, body=strip_tags(html_content), from_email=EMAIL_FROM, to=[to], connection=connection
    )
    msg.attach_alternative(html_content, "text/html")
    msg.send()


@shared_task
def send_contract_expiry_alerts():
    """Daily digest of contracts reaching 60/30/7 days before their effective
    end, to workspace admins and whoever uploaded each contract. Email only:
    Plane's in-app notifications are built around work items."""
    from plane.app.permissions import ROLE
    from plane.db.models import Contract, WorkspaceMember

    today = timezone.now().date()
    origin = (settings.WEB_URL or settings.APP_BASE_URL or "").rstrip("/")
    contracts = (
        Contract.objects.filter(
            file_asset__is_deleted=False,
            fecha_fin_efectiva__gte=today,
            fecha_fin_efectiva__lte=today + timedelta(days=max(EXPIRY_THRESHOLDS)),
        )
        .select_related("workspace", "file_asset__created_by")
        .defer("extracted_text", "proposed_data", "evidence")
        .order_by("fecha_fin_efectiva")
    )

    admins_by_workspace = {}
    digests = {}  # email -> [item]
    due_by_contract = {}
    for contract in contracts:
        pending = pending_expiry_alert(contract.fecha_fin_efectiva, contract.expiry_alerts, today)
        if pending is None:
            continue
        days, due = pending
        if contract.workspace_id not in admins_by_workspace:
            admins_by_workspace[contract.workspace_id] = set(
                WorkspaceMember.objects.filter(
                    workspace_id=contract.workspace_id, role=ROLE.ADMIN.value, is_active=True
                ).values_list("member__email", flat=True)
            )
        recipients = set(admins_by_workspace[contract.workspace_id])
        uploader = contract.file_asset.created_by if contract.file_asset_id else None
        if uploader is not None and uploader.email:
            recipients.add(uploader.email)
        item = {
            "contract_id": str(contract.id),
            "title": contract.titulo or (contract.file_asset.attributes or {}).get("name") or "Contrato",
            "effective_end": contract.fecha_fin_efectiva.isoformat(),
            "days": days,
            "workspace_name": contract.workspace.name,
            "url": f"{origin}/{contract.workspace.slug}/file-library/contracts/vigentes?peek={contract.id}",
        }
        due_by_contract[str(contract.id)] = (contract, due, set())
        for email in recipients:
            if email:
                digests.setdefault(email, []).append(item)

    for email, items in digests.items():
        try:
            html_content = render_to_string("emails/contract_expiry_alert.html", {"items": items})
            subject = (
                f"Un contrato vence en {items[0]['days']} días"
                if len(items) == 1
                else f"{len(items)} contratos están por vencer"
            )
            _send_html_email(subject, html_content, email)
        except Exception as e:
            log_exception(e)
            continue
        for item in items:
            due_by_contract[item["contract_id"]][2].add(email)

    alerted = 0
    for contract, due, delivered in due_by_contract.values():
        if not delivered:
            continue
        previous = contract.expiry_alerts if isinstance(contract.expiry_alerts, dict) else {}
        key = contract.fecha_fin_efectiva.isoformat()
        sent = set(previous.get("sent") or []) if previous.get("for") == key else set()
        Contract.objects.filter(id=contract.id).update(
            expiry_alerts={"for": key, "sent": sorted(sent | set(due), reverse=True)}
        )
        alerted += 1
    logger.info("Contract expiry alerts: %s contracts, %s recipients", alerted, len(digests))
    return {"contracts": alerted, "recipients": len(digests)}
