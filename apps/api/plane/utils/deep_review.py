# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Deep reviews: every contract read by the AI against one question.

Sizes come from `octet_length(extracted_text)`. Postgres keeps long texts
compressed out of line (TOAST) and reads their length from a header, so
sizing hundreds of 200-page contracts never opens a single text. Each text
is then read once, by id, when its lane gets to it.
"""

from datetime import timedelta

from django.db import transaction
from django.db.models import Count, F, Func, IntegerField, Q
from django.utils import timezone

from plane.db.models import AssistantDeepReview, AssistantDeepReviewItem, Contract
from plane.utils.assistant_reports import _cell, _mention

Status = AssistantDeepReview.Status
ItemStatus = AssistantDeepReviewItem.Status

# Pause when the projected total goes this far over the estimate...
PAUSE_RATIO = 1.25
# ...once this share of the text has been read (earlier projections are noise).
MIN_PROGRESS = 0.10
# Nobody answered the over-estimate alert: answer with what was read.
PAUSE_TIMEOUT = timedelta(minutes=15)

ACTIVE = (Status.SCHEDULED, Status.RUNNING, Status.PAUSED, Status.STOPPING, Status.SYNTHESIZING)
FINISHED = (Status.COMPLETED, Status.PARTIAL, Status.FAILED, Status.CANCELLED)


class OctetLength(Func):
    function = "octet_length"
    output_field = IntegerField()


def contracts_with_text(workspace_id):
    """Contracts the AI can read, with their text size, never their text."""
    return (
        Contract.objects.filter(workspace_id=workspace_id, file_asset__is_deleted=False)
        .annotate(size=OctetLength(F("extracted_text")))
        .filter(size__gt=0)
    )


def without_text_count(workspace_id) -> int:
    """Contracts left out because their text was never extracted."""
    return (
        Contract.objects.filter(workspace_id=workspace_id, file_asset__is_deleted=False)
        .annotate(size=OctetLength(F("extracted_text")))
        .filter(Q(size__isnull=True) | Q(size=0))
        .count()
    )


@transaction.atomic
def create_draft(
    workspace, user, question: str, sizes_by_contract: dict, parent=None, title: str = ""
) -> AssistantDeepReview:
    """A review waiting for confirmation, with its contracts fixed: the
    estimate the admin sees is for exactly these."""
    review = AssistantDeepReview.objects.create(
        workspace=workspace,
        user=user,
        title=title[:200],
        question=question,
        parent=parent,
        total_count=len(sizes_by_contract),
        total_bytes=sum(sizes_by_contract.values()),
        created_by=user,
    )
    AssistantDeepReviewItem.objects.bulk_create(
        [
            AssistantDeepReviewItem(
                workspace=workspace, review=review, contract_id=contract_id, bytes=size, created_by=user
            )
            for contract_id, size in sizes_by_contract.items()
        ],
        batch_size=500,
    )
    return review


def pause_expired(review, now=None) -> bool:
    now = now or timezone.now()
    return review.status == Status.PAUSED and review.paused_at is not None and now - review.paused_at > PAUSE_TIMEOUT


def projection(review) -> float | None:
    """Total spend if the rest costs what the read part did, per byte."""
    if review.done_bytes <= 0 or review.total_bytes <= 0:
        return None
    return review.spent_usd * review.total_bytes / review.done_bytes


def over_estimate(review) -> bool:
    if review.alerts_muted or not review.estimate_usd or review.total_bytes <= 0:
        return False
    if review.done_bytes / review.total_bytes < MIN_PROGRESS:
        return False
    projected = projection(review)
    return projected is not None and projected > review.estimate_usd * PAUSE_RATIO


def add_event(review, kind: str, **data) -> None:
    """Appends to the review's process log (saved by the caller)."""
    review.events = [*(review.events or []), {"at": timezone.now().isoformat(), "kind": kind, **data}][-200:]


def control_action(review) -> str:
    """What a lane does next: read another contract, wait, or stop."""
    if review.status == Status.RUNNING:
        return "continue"
    if review.status in (Status.PAUSED, Status.SCHEDULED):
        return "pause"
    return "stop"


def record_result(review_id, contract_id, data: dict) -> str:
    """Saves one contract's outcome and adds it to the counters.

    Idempotent: a retried report finds the item already settled and changes
    nothing. Returns the lane's next action.
    """
    failed = data.get("status") == "failed"
    with transaction.atomic():
        review = AssistantDeepReview.objects.select_for_update().get(id=review_id)
        item = (
            AssistantDeepReviewItem.objects.select_for_update()
            .filter(review=review, contract_id=contract_id, status__in=[ItemStatus.PENDING, ItemStatus.RUNNING])
            .first()
        )
        if item is not None:
            cost = max(0.0, float(data.get("cost_usd") or 0))
            input_tokens = max(0, int(data.get("input_tokens") or 0))
            output_tokens = max(0, int(data.get("output_tokens") or 0))
            item.status = ItemStatus.FAILED if failed else ItemStatus.DONE
            item.matches = None if failed else bool(data.get("matches"))
            confidence = data.get("confidence")
            item.confidence = None if failed or confidence is None else max(0, min(100, int(confidence)))
            item.reason = str(data.get("reason") or "")[:4000]
            item.quote = str(data.get("quote") or "")[:2000]
            item.details = data.get("details") if isinstance(data.get("details"), dict) else {}
            item.chunks = max(1, int(data.get("chunks") or 1))
            item.input_tokens = input_tokens
            item.output_tokens = output_tokens
            item.cost_usd = cost
            item.error = str(data.get("error") or "")[:500]
            item.save()

            review.spent_usd += cost
            review.input_tokens += input_tokens
            review.output_tokens += output_tokens
            if failed:
                review.failed_count += 1
            else:
                review.done_count += 1
                review.done_bytes += item.bytes

            if data.get("error_code") == "insufficient_balance" and review.status in (Status.RUNNING, Status.PAUSED):
                review.status = Status.STOPPING
                review.pause_reason = "insufficient_balance"
                add_event(review, "no_balance", read=review.done_count)
            elif review.status == Status.RUNNING and over_estimate(review):
                review.status = Status.PAUSED
                review.pause_reason = "over_estimate"
                review.paused_at = timezone.now()
                add_event(
                    review,
                    "paused",
                    projection=round(projection(review) or 0, 6),
                    estimate=review.estimate_usd,
                    read=review.done_count,
                )
            review.save()
        return control_action(review)


def refresh_state(review) -> AssistantDeepReview:
    """Applies the pause timeout; called on every poll."""
    if pause_expired(review):
        with transaction.atomic():
            locked = AssistantDeepReview.objects.select_for_update().get(id=review.id)
            if locked.status == Status.PAUSED:
                locked.status = Status.STOPPING
                locked.pause_reason = "pause_timeout"
                add_event(locked, "pause_timeout")
                locked.save(update_fields=["status", "pause_reason", "events"])
        review.refresh_from_db()
    return review


def item_counts(review) -> dict:
    counts = {status: 0 for status in ItemStatus.values}
    for row in review.items.values("status").annotate(n=Count("id")).order_by():
        counts[row["status"]] = row["n"]
    return counts


def state_payload(review) -> dict:
    counts = item_counts(review)
    return {
        "id": str(review.id),
        "status": review.status,
        "title": review.title,
        "question": review.question,
        "model": review.model,
        "off_peak": review.off_peak,
        "total_count": review.total_count,
        "total_bytes": review.total_bytes,
        "done_count": review.done_count,
        "failed_count": review.failed_count,
        "done_bytes": review.done_bytes,
        "pending_count": counts[ItemStatus.PENDING],
        "running_count": counts[ItemStatus.RUNNING],
        "spent_usd": round(review.spent_usd, 6),
        "estimate": review.estimate,
        "estimate_usd": review.estimate_usd,
        "projection_usd": projection(review),
        "alerts_muted": review.alerts_muted,
        "pause_reason": review.pause_reason,
        "paused_at": review.paused_at.isoformat() if review.paused_at else None,
        "started_at": review.started_at.isoformat() if review.started_at else None,
        "finished_at": review.finished_at.isoformat() if review.finished_at else None,
        "summary": review.summary,
        "error": review.error,
        "action": control_action(review),
    }


def _file_name(contract) -> str | None:
    return (contract.file_asset.attributes or {}).get("name") if contract.file_asset_id else None


def process_payload(review) -> dict:
    """What the review did, for the process block in the chat: its events
    and every contract read so far, in the order they finished."""
    items = (
        review.items.filter(status__in=[ItemStatus.DONE, ItemStatus.FAILED])
        .select_related("contract", "contract__file_asset")
        .order_by("updated_at")
    )
    return {
        "events": review.events or [],
        "items": [
            {
                "contract_id": str(item.contract_id),
                "title": item.contract.titulo or _file_name(item.contract) or "Contrato",
                "status": item.status,
                "matches": item.matches,
                "selected": item.selected,
                "confidence": item.confidence,
                "chunks": item.chunks,
                "tokens": item.input_tokens + item.output_tokens,
                "cost_usd": round(item.cost_usd, 6),
                "error": item.error,
                "reason": item.reason[:300] if item.matches and not item.selected else "",
                "finished_at": item.updated_at.isoformat(),
            }
            for item in items
        ],
    }


def result_rows(review, everything: bool = False) -> list[dict]:
    """The matches (or every contract read), with what the AI found."""
    items = review.items.select_related("contract", "contract__file_asset").filter(status=ItemStatus.DONE)
    if not everything:
        items = items.filter(selected=True)
    rows = []
    for item in items.order_by("-confidence", "contract__titulo"):
        contract = item.contract
        details = item.details or {}
        rows.append(
            {
                "contract_id": str(contract.id),
                "title": contract.titulo or _file_name(contract) or "Contrato",
                "file_name": _file_name(contract),
                "file_asset_id": str(contract.file_asset_id) if contract.file_asset_id else None,
                "artists": details.get("artists") or ([contract.artistas] if contract.artistas else []),
                "start_date": details.get("start_date")
                or (contract.fecha_inicio.isoformat() if contract.fecha_inicio else None),
                "end_date": details.get("end_date") or (contract.fecha_fin.isoformat() if contract.fecha_fin else None),
                "effective_end_date": details.get("effective_end_date")
                or (contract.fecha_fin_efectiva.isoformat() if contract.fecha_fin_efectiva else None),
                "matches": bool(item.matches),
                "selected": item.selected,
                "confidence": item.confidence,
                "reason": item.reason,
                "quote": item.quote,
            }
        )
    return rows


def remaining_sizes(review) -> dict:
    """Contracts a partial review did not get to (or that failed)."""
    return dict(review.items.exclude(status=ItemStatus.DONE).values_list("contract_id", "bytes"))


def build_markdown(review, rows: list[dict]) -> str:
    """The result as a page: summary, then one linked row per contract."""
    heading = f"Revisión de contratos: {_cell(review.title)}" if review.title else "Revisión de todos los contratos"
    lines = [f"# {heading}", "", f"> **Criterio:** {_cell(review.question)}", ""]
    if review.summary:
        lines += [review.summary.strip(), ""]
    read = review.done_count
    lines += [f"_Se analizaron {read} de {review.total_count} contratos._", ""]
    if not rows:
        return "\n".join(lines + ["Ningún contrato coincidió.", ""])
    lines += [
        f"## Contratos que coinciden ({len(rows)})",
        "",
        "| Contrato | Artistas | Inicio | Fin efectivo | Motivo | Cita |",
        "|---|---|---|---|---|---|",
    ]
    for row in rows:
        lines.append(
            "| "
            + " | ".join(
                [
                    _mention("contract", row["title"], row["contract_id"]),
                    _cell(", ".join(row["artists"]) if row["artists"] else ""),
                    _cell(row["start_date"]),
                    _cell(row["effective_end_date"]),
                    _cell(row["reason"])[:400],
                    _cell(f"«{row['quote']}»" if row["quote"] else "")[:300],
                ]
            )
            + " |"
        )
    return "\n".join(lines + [""])


__all__ = [
    "ACTIVE",
    "FINISHED",
    "build_markdown",
    "contracts_with_text",
    "control_action",
    "create_draft",
    "over_estimate",
    "projection",
    "record_result",
    "refresh_state",
    "remaining_sizes",
    "result_rows",
    "state_payload",
    "without_text_count",
]
