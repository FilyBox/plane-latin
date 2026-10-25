# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Deep reviews: the assistant reads every contract against one question.

Admins confirm an estimate in the chat card, follow progress and spend live,
and get the answer in the chat and by email. The Worker's workflow reads the
contracts through the internal endpoints below (shared secret), and every
text endpoint only answers for a contract that belongs to a running review.
"""

import csv
import gzip
import json
from io import BytesIO

from django.conf import settings
from django.db import transaction
from django.http import HttpResponse
from django.utils import timezone
from openpyxl import Workbook
from rest_framework import status
from rest_framework.response import Response

from plane.app.permissions import ROLE, allow_permission
from plane.app.views.base import BaseAPIView
from plane.app.views.contract.internal import InternalBaseView
from plane.db.models import (
    AssistantDeepReview,
    AssistantDeepReviewItem,
    Contract,
    User,
    Workspace,
    WorkspaceFeature,
    WorkspaceMember,
)
from plane.utils.deep_review import (
    FINISHED,
    build_markdown,
    contracts_with_text,
    control_action,
    create_draft,
    record_result,
    refresh_state,
    remaining_sizes,
    result_rows,
    state_payload,
    without_text_count,
)
from plane.utils.exception_logger import log_exception
from plane.utils.worker_client import WorkerTriggerError, estimate_deep_review, trigger_deep_review

Status = AssistantDeepReview.Status
ItemStatus = AssistantDeepReviewItem.Status


class DraftError(Exception):
    pass


def _draft(workspace, user, question: str, sizes: dict, parent=None, title: str = "") -> AssistantDeepReview:
    """Prices the contracts first, so a Worker failure leaves no orphan draft."""
    if not sizes:
        raise DraftError("No hay contratos con texto extraído para revisar.")
    estimate = estimate_deep_review(list(sizes.values()))
    review = create_draft(workspace, user, question, sizes, parent=parent, title=title)
    review.estimate = estimate
    review.model = estimate.get("default_model") or ""
    review.save(update_fields=["estimate", "model"])
    return review


def _is_admin(workspace, user) -> bool:
    return WorkspaceMember.objects.filter(
        workspace=workspace, member=user, is_active=True, role__gte=ROLE.ADMIN.value
    ).exists()


def _detail(review) -> dict:
    payload = state_payload(refresh_state(review))
    if review.status in FINISHED:
        # Every contract read: the card shows matches and the rest in tabs.
        payload["results"] = result_rows(review, everything=True)
        payload["remaining_count"] = review.items.exclude(status=ItemStatus.DONE).count()
    continuation = review.continuations.order_by("-created_at").first()
    payload["continuation_id"] = str(continuation.id) if continuation else None
    return payload


def _review(slug, review_id):
    return AssistantDeepReview.objects.filter(workspace__slug=slug, id=review_id).first()


# ------------------------------------------------------------------ browser


class AssistantDeepReviewEndpoint(BaseAPIView):
    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def get(self, request, slug, review_id):
        review = _review(slug, review_id)
        if review is None:
            return Response({"error": "Not found"}, status=status.HTTP_404_NOT_FOUND)
        return Response(_detail(review), status=status.HTTP_200_OK)


class AssistantDeepReviewStartEndpoint(BaseAPIView):
    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def post(self, request, slug, review_id):
        data = request.data if isinstance(request.data, dict) else {}
        off_peak = bool(data.get("off_peak"))
        with transaction.atomic():
            review = AssistantDeepReview.objects.select_for_update().filter(workspace__slug=slug, id=review_id).first()
            if review is None:
                return Response({"error": "Not found"}, status=status.HTTP_404_NOT_FOUND)
            if review.status != Status.DRAFT:
                return Response({"error": "This review already started"}, status=status.HTTP_409_CONFLICT)
            model = str(data.get("model") or review.model)
            if model not in (review.estimate.get("models") or {}):
                return Response({"error": "Unknown model"}, status=status.HTTP_400_BAD_REQUEST)
            review.model = model
            review.off_peak = off_peak
            review.status = Status.SCHEDULED if off_peak else Status.RUNNING
            review.started_at = timezone.now()
            review.save(update_fields=["model", "off_peak", "status", "started_at"])

        try:
            instance_id = trigger_deep_review(review.id, review.workspace_id, model, off_peak)
        except WorkerTriggerError as e:
            log_exception(e)
            AssistantDeepReview.objects.filter(id=review.id).update(status=Status.DRAFT, started_at=None)
            return Response({"error": e.public_message}, status=status.HTTP_502_BAD_GATEWAY)
        AssistantDeepReview.objects.filter(id=review.id).update(workflow_instance_id=instance_id or "")
        review.refresh_from_db()
        return Response(_detail(review), status=status.HTTP_200_OK)


class AssistantDeepReviewDecisionEndpoint(BaseAPIView):
    """stop: answer with what was read · continue: go past the estimate ·
    cancel: drop a review that never started."""

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def post(self, request, slug, review_id):
        action = (request.data or {}).get("action")
        with transaction.atomic():
            review = AssistantDeepReview.objects.select_for_update().filter(workspace__slug=slug, id=review_id).first()
            if review is None:
                return Response({"error": "Not found"}, status=status.HTTP_404_NOT_FOUND)
            if action == "cancel" and review.status == Status.DRAFT:
                review.status = Status.CANCELLED
                review.finished_at = timezone.now()
            elif action == "stop" and review.status == Status.SCHEDULED:
                # Nothing was read yet: no answer to give.
                review.status = Status.CANCELLED
                review.finished_at = timezone.now()
            elif action == "stop" and review.status in (Status.RUNNING, Status.PAUSED):
                review.status = Status.STOPPING
                review.pause_reason = "user_stop"
            elif action == "continue" and review.status == Status.PAUSED:
                review.status = Status.RUNNING
                review.alerts_muted = True
                review.paused_at = None
                review.pause_reason = ""
            else:
                return Response({"error": "Not possible now"}, status=status.HTTP_409_CONFLICT)
            review.save()
        return Response(_detail(review), status=status.HTTP_200_OK)


class AssistantDeepReviewRemainingEndpoint(BaseAPIView):
    """A new review, to confirm, for what a partial one did not read."""

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def post(self, request, slug, review_id):
        review = _review(slug, review_id)
        if review is None:
            return Response({"error": "Not found"}, status=status.HTTP_404_NOT_FOUND)
        if review.status not in (Status.PARTIAL, Status.FAILED):
            return Response({"error": "Nothing left to read"}, status=status.HTTP_409_CONFLICT)
        existing = review.continuations.filter(status=Status.DRAFT).order_by("-created_at").first()
        if existing is not None:
            return Response(_detail(existing), status=status.HTTP_200_OK)
        try:
            draft = _draft(
                review.workspace,
                request.user,
                review.question,
                remaining_sizes(review),
                parent=review,
                title=review.title,
            )
        except DraftError as e:
            return Response({"error": str(e)}, status=status.HTTP_409_CONFLICT)
        except WorkerTriggerError as e:
            log_exception(e)
            return Response({"error": e.public_message}, status=status.HTTP_502_BAD_GATEWAY)
        return Response(_detail(draft), status=status.HTTP_201_CREATED)


EXPORT_HEADERS = [
    "Contrato",
    "Archivo",
    "Artistas",
    "Inicio",
    "Fin",
    "Fin efectivo",
    "Coincide",
    "Confianza",
    "Motivo",
    "Cita",
    "Enlace",
]


class AssistantDeepReviewExportEndpoint(BaseAPIView):
    """The result as a spreadsheet: the matches, or every contract read
    (?scope=all)."""

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def get(self, request, slug, review_id):
        review = _review(slug, review_id)
        if review is None:
            return Response({"error": "Not found"}, status=status.HTTP_404_NOT_FOUND)
        everything = request.query_params.get("scope") == "all"
        origin = (settings.WEB_URL or settings.APP_BASE_URL or request.build_absolute_uri("/")).rstrip("/")
        rows = [
            [
                row["title"],
                row["file_name"] or "",
                ", ".join(row["artists"]),
                row["start_date"] or "",
                row["end_date"] or "",
                row["effective_end_date"] or "",
                "Sí" if row["selected"] else "No",
                row["confidence"] if row["confidence"] is not None else "",
                row["reason"],
                row["quote"],
                f"{origin}/{slug}/file-library/contracts/analyzed/?peek={row['contract_id']}",
            ]
            for row in result_rows(review, everything=everything)
        ]
        filename = f"revision-contratos-{review.created_at:%Y%m%d}"
        # "format" is reserved by DRF content negotiation
        if request.query_params.get("type") == "xlsx":
            workbook = Workbook()
            sheet = workbook.active
            sheet.title = "Revisión"
            sheet.append(EXPORT_HEADERS)
            for row in rows:
                sheet.append(row)
            output = BytesIO()
            workbook.save(output)
            response = HttpResponse(
                output.getvalue(),
                content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            )
            response["Content-Disposition"] = f'attachment; filename="{filename}.xlsx"'
            return response
        response = HttpResponse(content_type="text/csv; charset=utf-8")
        response["Content-Disposition"] = f'attachment; filename="{filename}.csv"'
        response.write("﻿")
        writer = csv.writer(response)
        writer.writerow(EXPORT_HEADERS)
        writer.writerows(rows)
        return response


class AssistantDeepReviewPageEndpoint(BaseAPIView):
    """The result as page Markdown, for the page card (review, edit, create,
    undo). Rows come from the saved results, never rewritten by the AI."""

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def get(self, request, slug, review_id):
        review = _review(slug, review_id)
        if review is None:
            return Response({"error": "Not found"}, status=status.HTTP_404_NOT_FOUND)
        return Response(
            {
                "title": f"{review.title or 'Revisión de contratos'} — {review.created_at:%Y-%m-%d}",
                "markdown": build_markdown(review, result_rows(review)),
            },
            status=status.HTTP_200_OK,
        )


# ----------------------------------------------------------------- internal


class InternalDeepReviewCreateEndpoint(InternalBaseView):
    """The assistant's tool: a draft over every contract with text, priced."""

    def post(self, request, workspace_id):
        data = request.data if isinstance(request.data, dict) else {}
        workspace = Workspace.objects.filter(id=workspace_id).first()
        user = User.objects.filter(id=data.get("user_id")).first()
        question = " ".join(str(data.get("question") or "").split())[:4000]
        title = " ".join(str(data.get("title") or "").split())[:200]
        if workspace is None or user is None or not _is_admin(workspace, user):
            return Response({"error": "Only workspace admins can review every contract"}, status=403)
        if not WorkspaceFeature.objects.filter(
            workspace=workspace, key=WorkspaceFeature.FeatureKey.FILE_LIBRARY, is_enabled=True
        ).exists():
            return Response({"error": "Contracts are not enabled in this workspace"}, status=403)
        if not question:
            return Response({"error": "question is required"}, status=status.HTTP_400_BAD_REQUEST)
        sizes = dict(contracts_with_text(workspace.id).values_list("id", "size"))
        try:
            review = _draft(workspace, user, question, sizes, title=title)
        except DraftError as e:
            return Response({"error": str(e)}, status=status.HTTP_409_CONFLICT)
        except WorkerTriggerError as e:
            log_exception(e)
            return Response({"error": e.public_message}, status=status.HTTP_502_BAD_GATEWAY)
        return Response(
            {**state_payload(review), "without_text_count": without_text_count(workspace.id)},
            status=status.HTTP_201_CREATED,
        )


class InternalDeepReviewStateEndpoint(InternalBaseView):
    """The orchestrator's poll (GET) and its status moves (POST)."""

    MOVES = {
        Status.RUNNING: (Status.SCHEDULED,),
        Status.SYNTHESIZING: (Status.RUNNING, Status.PAUSED, Status.STOPPING),
    }

    def get(self, request, review_id):
        review = AssistantDeepReview.objects.filter(id=review_id).first()
        if review is None:
            return Response({"error": "Not found"}, status=status.HTTP_404_NOT_FOUND)
        return Response(state_payload(refresh_state(review)), status=status.HTTP_200_OK)

    def post(self, request, review_id):
        data = request.data if isinstance(request.data, dict) else {}
        with transaction.atomic():
            review = AssistantDeepReview.objects.select_for_update().filter(id=review_id).first()
            if review is None:
                return Response({"error": "Not found"}, status=status.HTTP_404_NOT_FOUND)
            target = data.get("status")
            if target in self.MOVES and review.status in self.MOVES[target]:
                review.status = target
            if data.get("estimate_usd") is not None and review.estimate_usd is None:
                review.estimate_usd = float(data["estimate_usd"])
            review.save()
        return Response(state_payload(review), status=status.HTTP_200_OK)


class InternalDeepReviewPlanEndpoint(InternalBaseView):
    """Contracts still to read: ids and sizes only."""

    def get(self, request, review_id):
        review = AssistantDeepReview.objects.filter(id=review_id).first()
        if review is None:
            return Response({"error": "Not found"}, status=status.HTTP_404_NOT_FOUND)
        items = review.items.filter(status=ItemStatus.PENDING).values_list("contract_id", "bytes")
        return Response(
            {"items": [{"id": str(contract_id), "bytes": size} for contract_id, size in items]},
            status=status.HTTP_200_OK,
        )


class InternalDeepReviewTextEndpoint(InternalBaseView):
    """One contract's text, only while its review is running and only if the
    contract is part of it and not read yet. Gzipped: a 200-page text travels
    at about a quarter of its size."""

    def get(self, request, review_id, contract_id):
        review = AssistantDeepReview.objects.filter(id=review_id).first()
        if review is None:
            return Response({"error": "Not found"}, status=status.HTTP_404_NOT_FOUND)
        if review.status != Status.RUNNING:
            return Response({"action": control_action(refresh_state(review))}, status=status.HTTP_200_OK)
        claimed = AssistantDeepReviewItem.objects.filter(
            review=review, contract_id=contract_id, status__in=[ItemStatus.PENDING, ItemStatus.RUNNING]
        ).update(status=ItemStatus.RUNNING)
        if not claimed:
            return Response({"action": "skip"}, status=status.HTTP_200_OK)
        row = (
            Contract.objects.filter(id=contract_id, workspace_id=review.workspace_id)
            .values_list("titulo", "extracted_text")
            .first()
        )
        if row is None:
            return Response({"action": "skip"}, status=status.HTTP_200_OK)
        body = json.dumps({"action": "continue", "title": row[0] or "", "text": row[1] or ""}).encode()
        if "gzip" in request.headers.get("Accept-Encoding", ""):
            response = HttpResponse(gzip.compress(body, compresslevel=5), content_type="application/json")
            response["Content-Encoding"] = "gzip"
        else:
            response = HttpResponse(body, content_type="application/json")
        return response


class InternalDeepReviewResultEndpoint(InternalBaseView):
    """One contract read (or failed); answers with the lane's next action."""

    def post(self, request, review_id, contract_id):
        if not AssistantDeepReview.objects.filter(id=review_id).exists():
            return Response({"error": "Not found"}, status=status.HTTP_404_NOT_FOUND)
        data = request.data if isinstance(request.data, dict) else {}
        return Response({"action": record_result(review_id, contract_id, data)}, status=status.HTTP_200_OK)


class InternalDeepReviewCandidatesEndpoint(InternalBaseView):
    """What the final pass weighs: every contract the AI said matches."""

    def get(self, request, review_id):
        review = AssistantDeepReview.objects.filter(id=review_id).first()
        if review is None:
            return Response({"error": "Not found"}, status=status.HTTP_404_NOT_FOUND)
        items = (
            review.items.filter(status=ItemStatus.DONE, matches=True).select_related("contract").order_by("-confidence")
        )
        return Response(
            {
                "question": review.question,
                "read_count": review.done_count,
                "total_count": review.total_count,
                "candidates": [
                    {
                        "id": str(item.contract_id),
                        "title": item.contract.titulo or "",
                        "confidence": item.confidence,
                        "reason": item.reason[:300],
                        "quote": item.quote[:200],
                    }
                    for item in items
                ],
            },
            status=status.HTTP_200_OK,
        )


class InternalDeepReviewCompleteEndpoint(InternalBaseView):
    """Final answer: keeps the matches the last pass did not drop, then emails."""

    def post(self, request, review_id):
        from plane.bgtasks.assistant_deep_review_task import send_deep_review_email

        data = request.data if isinstance(request.data, dict) else {}
        with transaction.atomic():
            review = AssistantDeepReview.objects.select_for_update().filter(id=review_id).first()
            if review is None:
                return Response({"error": "Not found"}, status=status.HTTP_404_NOT_FOUND)
            if review.status in FINISHED:
                return Response(state_payload(review), status=status.HTTP_200_OK)
            dropped = [str(value) for value in data.get("drop_ids") or []]
            review.items.filter(status=ItemStatus.DONE, matches=True).exclude(contract_id__in=dropped).update(
                selected=True
            )
            # Reads that never finished are not results
            review.items.filter(status=ItemStatus.RUNNING).update(status=ItemStatus.PENDING)
            if data.get("failed"):
                review.status = Status.FAILED
                review.error = {"message": str(data.get("error") or "")[:500]}
            elif review.items.exclude(status=ItemStatus.DONE).exists():
                review.status = Status.PARTIAL
            else:
                review.status = Status.COMPLETED
            review.summary = str(data.get("summary") or "")[:20000]
            review.finished_at = timezone.now()
            review.save()
        if review.status != Status.FAILED or review.done_count:
            send_deep_review_email.delay(str(review.id))
        return Response(state_payload(review), status=status.HTTP_200_OK)


class InternalDeepReviewResultsEndpoint(InternalBaseView):
    """A finished review's matches, for follow-up questions in the chat."""

    def get(self, request, workspace_id, review_id):
        review = AssistantDeepReview.objects.filter(id=review_id, workspace_id=workspace_id).first()
        user = User.objects.filter(id=request.query_params.get("user_id")).first()
        if review is None or user is None or not _is_admin(review.workspace, user):
            return Response({"error": "Not available"}, status=status.HTTP_403_FORBIDDEN)
        payload = state_payload(refresh_state(review))
        if review.status in FINISHED:
            # Every contract read, so follow-ups about the rest need no new reads
            payload["results"] = result_rows(review, everything=True)
        return Response(payload, status=status.HTTP_200_OK)


__all__ = [
    "AssistantDeepReviewDecisionEndpoint",
    "AssistantDeepReviewEndpoint",
    "AssistantDeepReviewExportEndpoint",
    "AssistantDeepReviewPageEndpoint",
    "AssistantDeepReviewRemainingEndpoint",
    "AssistantDeepReviewStartEndpoint",
    "InternalDeepReviewCandidatesEndpoint",
    "InternalDeepReviewCompleteEndpoint",
    "InternalDeepReviewCreateEndpoint",
    "InternalDeepReviewPlanEndpoint",
    "InternalDeepReviewResultEndpoint",
    "InternalDeepReviewResultsEndpoint",
    "InternalDeepReviewStateEndpoint",
    "InternalDeepReviewTextEndpoint",
]
