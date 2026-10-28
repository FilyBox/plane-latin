# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Expenses from receipts the assistant was given (photo, PDF, CFDI XML).

It uses the expense importer instead of a second extraction: one
ExpenseImport per file (a CFDI is read exactly and is ready at once; the rest
go to the analysis), the same budget/category suggestions and duplicate
check, and the same way of saving (ExpenseSerializer, one ExpenseDocument per
file, the analysis marked IMPORTED).

A PDF and the XML of the same invoice become ONE expense with both files:
paired by the fiscal UUID printed on the PDF, else by the same file name,
else by the same total and date. Admins only, like the module.
"""

from pathlib import PurePath

from django.db import transaction

from plane.db.models import AssistantAction, Expense, ExpenseDocument, FileAsset, Workspace
from plane.db.models.finance import ExpenseImport
from plane.utils.assistant_actions import ActionError, register_undo
from plane.utils.assistant_undo import snapshot
from plane.utils.assistant_workspace import register_apply

ADMIN = 20
MAX_FILES = 30
FIELDS = (
    "concept",
    "vendor",
    "amount",
    "currency",
    "expense_date",
    "reference",
    "description",
    "status",
    "paid_at",
    "category",
    "scenario",
    "project",
    "tags",
)


def can_use(ctx) -> bool:
    return ctx is not None and ctx.role >= ADMIN and "payments" in ctx.features


def _require(ctx):
    if not can_use(ctx):
        raise ActionError("Only workspace admins with Payments can register expenses.")


def _imports():
    from plane.app.views.finance import imports

    return imports


def start(ctx, user, asset_ids, scenario_id=None) -> dict:
    """Creates or reuses the analysis of each file; a CFDI is ready at once."""
    _require(ctx)
    imports = _imports()
    ids = [str(item) for item in (asset_ids or [])][:MAX_FILES]
    assets = list(
        FileAsset.objects.filter(id__in=ids, workspace_id=ctx.workspace_id, is_uploaded=True, is_deleted=False)
    )
    missing = sorted(set(ids) - {str(asset.id) for asset in assets})
    if not assets:
        raise ActionError("None of those files is available in this workspace.")
    unsupported = imports.unsupported_assets(assets)
    if unsupported:
        names = ", ".join((asset.attributes or {}).get("name", str(asset.id)) for asset in unsupported)
        raise ActionError(f"Only PDF, XML or receipt images up to 20 MB: {names}")
    workspace = Workspace.objects.get(id=ctx.workspace_id)
    jobs = imports.start_expense_imports(workspace, user, assets, scenario_id)
    return {
        "job_ids": [str(job.id) for job in jobs],
        "missing": missing or None,
        **drafts(ctx, [job.id for job in jobs]),
    }


def _name(job) -> str:
    return (job.asset.attributes or {}).get("name") or "documento"


def _is_xml(job) -> bool:
    return _imports()._is_xml(job.asset)


def pairs(jobs) -> list[list]:
    """Groups of jobs that are the same invoice (XML first), then singles."""
    ready = [job for job in jobs if job.status in ("READY", "IMPORTED")]
    xmls = [job for job in ready if _is_xml(job) and (job.data or {}).get("cfdi_uuid")]
    others = [job for job in ready if not _is_xml(job)]
    used, groups = set(), []
    for xml in xmls:
        data = xml.data or {}
        uuid = str(data.get("cfdi_uuid") or "").upper()
        stem = PurePath(_name(xml)).stem.lower()

        def free(candidates):
            return [job for job in candidates if job.id not in used]

        match, by = None, None
        by_uuid = free(job for job in others if str((job.data or {}).get("cfdi_uuid") or "").upper() == uuid)
        by_name = free(job for job in others if PurePath(_name(job)).stem.lower() == stem)
        by_total = free(
            job
            for job in others
            if (job.data or {}).get("amount") == data.get("amount")
            and (job.data or {}).get("expense_date") == data.get("expense_date")
            and data.get("amount")
        )
        if len(by_uuid) == 1:
            match, by = by_uuid[0], "uuid"
        elif len(by_name) == 1:
            match, by = by_name[0], "name"
        elif len(by_total) == 1:
            match, by = by_total[0], "total"
        if match is not None:
            used.update({xml.id, match.id})
            groups.append(([xml, match], by))
    for job in jobs:
        if job.id not in used:
            groups.append(([job], None))
    return groups


def drafts(ctx, job_ids) -> dict:
    """The card's state: each file's analysis and the expenses they make."""
    jobs = list(
        ExpenseImport.objects.filter(workspace_id=ctx.workspace_id, id__in=job_ids).select_related("asset", "expense")
    )
    pending = [job for job in jobs if job.status in ("QUEUED", "RUNNING")]
    rows = []
    for group, matched_by in pairs(jobs):
        main = group[0]
        data = dict(main.data or {})
        # The XML's exact data wins; the PDF only fills what the XML lacks
        for other in group[1:]:
            for key, value in (other.data or {}).items():
                if not data.get(key) and value:
                    data[key] = value
        rows.append(
            {
                "job_ids": [str(job.id) for job in group],
                "files": [
                    {"job_id": str(job.id), "asset_id": str(job.asset_id), "name": _name(job), "xml": _is_xml(job)}
                    for job in group
                ],
                "status": main.status if all(job.status == main.status for job in group) else "MIXED",
                "stage": main.stage or None,
                "error": main.error or None,
                "matched_by": matched_by,
                "data": data,
                "expense_id": str(main.expense_id) if main.expense_id else None,
            }
        )
    return {"pending": len(pending), "expenses": rows}


# ---------------------------------------------------------------- apply


def _validated(ctx, fields):
    from plane.app.serializers.finance import ExpenseSerializer

    allowed = {key: value for key, value in (fields or {}).items() if key in (*FIELDS, "budget_line")}
    serializer = ExpenseSerializer(data=allowed, context={"workspace_id": ctx.workspace_id})
    if not serializer.is_valid():
        field, errors = next(iter(serializer.errors.items()))
        raise ActionError(f"{field}: {errors[0] if isinstance(errors, list) else errors}")
    return serializer


@register_apply(AssistantAction.Kind.CREATE_EXPENSES)
def create_expenses(ctx, request, data) -> AssistantAction:
    _require(ctx)
    items = [item for item in (data.get("items") or []) if isinstance(item, dict)][:MAX_FILES]
    if not items:
        raise ActionError("Nothing to register.")
    created = []
    with transaction.atomic():
        for item in items:
            ids = [str(job_id) for job_id in item.get("job_ids") or []][:2]
            jobs = list(
                ExpenseImport.objects.select_for_update()
                .filter(workspace_id=ctx.workspace_id, id__in=ids)
                .select_related("asset")
            )
            if not jobs or len(jobs) != len(ids):
                raise ActionError("A receipt's analysis was not found.")
            if any(job.expense_id for job in jobs):
                raise ActionError(f"«{_name(jobs[0])}» was already registered as an expense.")
            if any(job.status != "READY" for job in jobs):
                raise ActionError(f"«{_name(jobs[0])}» is still being analysed.")
            uuid = next(
                (
                    str((job.data or {}).get("cfdi_uuid") or "").upper()
                    for job in jobs
                    if (job.data or {}).get("cfdi_uuid")
                ),
                "",
            )
            if uuid and not item.get("allow_duplicate"):
                existing = (
                    Expense.objects.filter(workspace_id=ctx.workspace_id, cfdi_uuid__iexact=uuid)
                    .exclude(status="CANCELLED")
                    .first()
                )
                if existing is not None:
                    raise ActionError(
                        f"The invoice {uuid} is already registered ({existing.concept or existing.vendor})."
                    )
            expense = _validated(ctx, item.get("expense")).save(workspace_id=ctx.workspace_id)
            if uuid:
                expense.cfdi_uuid = uuid[:40]
                expense.save(update_fields=["cfdi_uuid"])
            for job in jobs:
                ExpenseDocument.objects.create(workspace_id=ctx.workspace_id, expense=expense, asset=job.asset)
                job.expense, job.status = expense, "IMPORTED"
                job.save(update_fields=["expense", "status", "updated_at"])
            expense.refresh_from_db()
            created.append(
                {
                    "expense_id": str(expense.id),
                    "job_ids": [str(job.id) for job in jobs],
                    "concept": expense.concept or expense.vendor,
                    "amount": str(expense.amount),
                    "currency": expense.currency,
                    "after": snapshot(expense, FIELDS),
                }
            )
        total = len(created)
        summary = (
            f"Registró el gasto «{created[0]['concept']}» ({created[0]['amount']} {created[0]['currency']})"
            if total == 1
            else f"Registró {total} gastos desde comprobantes"
        )
        return AssistantAction.objects.create(
            workspace_id=ctx.workspace_id,
            kind=AssistantAction.Kind.CREATE_EXPENSES,
            summary=summary[:300],
            payload=data,
            result={"expenses": created, "path": f"/{ctx.slug}/expenses"},
        )


@register_undo(AssistantAction.Kind.CREATE_EXPENSES)
def undo_create_expenses(action, user, origin, cookie):
    """Deletes (soft) the expenses nobody edited since; their analyses go
    back to READY, so they can be registered again."""
    rows = (action.result or {}).get("expenses") or []
    conflicts = []
    for row in rows:
        expense = Expense.objects.select_for_update().filter(id=row["expense_id"]).first()
        if expense is None:
            continue
        now = snapshot(expense, FIELDS)
        changed = [field for field in FIELDS if now.get(field) != row["after"].get(field)]
        if changed:
            conflicts.extend(
                {
                    "field": field,
                    "name": row.get("concept"),
                    "current": now.get(field),
                    "expected": row["after"].get(field),
                }
                for field in changed
            )
            continue
        ExpenseDocument.objects.filter(expense=expense).delete()
        ExpenseImport.objects.filter(id__in=row["job_ids"], expense=expense).update(expense=None, status="READY")
        expense.delete()
    return {"conflicts": conflicts} if conflicts else None
