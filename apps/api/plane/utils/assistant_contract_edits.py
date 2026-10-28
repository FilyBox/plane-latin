# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Corrections to the data extracted from contracts ("la fecha de inicio es
1 de marzo", "estos 5 son de edición").

Same path as the contract panel's edit: the partial ContractUpdateSerializer,
the effective end carried along when the end moves, the status refreshed and
the artist tags re-synced. Each corrected field keeps evidence marked
{manual: true, quote, page, by, at} so the panel shows "corregido a mano" and
a re-analysis flags proposals over it. Undo goes field by field and only
where the value is still the assistant's.
"""

from django.db import transaction
from django.utils import timezone

from plane.db.models import AssistantAction, Contract
from plane.utils.assistant_actions import ActionError, register_undo
from plane.utils.assistant_undo import diff, revert_fields, snapshot, to_json
from plane.utils.assistant_workspace import register_apply

MEMBER = 15
MAX_CONTRACTS = 50
# Fields that may move on their own after an edit (effective end, status)
DERIVED = ("fecha_fin_efectiva", "estatus_contrato")


def _contract_views():
    from plane.app.views.contract import base

    return base


def can_edit(ctx) -> bool:
    return ctx is not None and ctx.role >= MEMBER and "file_library" in ctx.features


def _require(ctx):
    if not can_edit(ctx):
        raise ActionError("Only workspace members with the file library can correct contracts.")


def _editable():
    from plane.app.serializers.contract import CONTRACT_EDITABLE_FIELDS

    return CONTRACT_EDITABLE_FIELDS


def _contracts(ctx, ids):
    ids = [str(item) for item in ids][:MAX_CONTRACTS]
    try:
        rows = _contract_views().live_contracts().filter(workspace_id=ctx.workspace_id, id__in=ids)
        return {str(contract.id): contract for contract in rows.defer("extracted_text").select_related("file_asset")}
    except Exception:
        return {}


def _validated(contract, changes):
    """The changes as the panel's serializer reads them, or field errors."""
    from plane.app.serializers.contract import ContractUpdateSerializer

    editable = set(_editable())
    clean = {field: value for field, value in (changes or {}).items() if field in editable}
    unknown = sorted(set(changes or {}) - editable)
    serializer = ContractUpdateSerializer(contract, data=clean, partial=True)
    if not serializer.is_valid():
        return None, {field: [str(item) for item in errors] for field, errors in serializer.errors.items()}, unknown
    return serializer.validated_data, None, unknown


def edit_preview(ctx, items) -> dict:
    """What the card shows: per contract, field / before / after with the
    quote and page, and whether a re-analysis is waiting on it."""
    _require(ctx)
    items = [item for item in (items or []) if isinstance(item, dict)][:MAX_CONTRACTS]
    contracts = _contracts(ctx, [item.get("contract_id") for item in items])
    rows = []
    for item in items:
        contract = contracts.get(str(item.get("contract_id")))
        if contract is None:
            rows.append({"contract_id": item.get("contract_id"), "error": "Contract not found."})
            continue
        validated, errors, unknown = _validated(contract, item.get("changes"))
        changes = []
        for field, value in (validated or {}).items():
            before, after = to_json(getattr(contract, field)), to_json(value)
            if before != after:
                changes.append({"field": field, "before": before, "after": after})
        rows.append(
            {
                "contract_id": str(contract.id),
                "titulo": contract.titulo or (contract.file_asset.attributes or {}).get("name"),
                "file_asset_id": str(contract.file_asset_id),
                "changes": changes,
                "errors": errors,
                "unknown_fields": unknown or None,
                "reason": str(item.get("reason") or "")[:500] or None,
                "quote": str(item.get("quote") or "")[:500] or None,
                "page": item.get("page") if isinstance(item.get("page"), int) else None,
                "pending_reanalysis": contract.proposed_data is not None or None,
                "manual_before": sorted(
                    field
                    for field in (validated or {})
                    if isinstance((contract.evidence or {}).get(field), dict) and contract.evidence[field].get("manual")
                )
                or None,
            }
        )
    return {"contracts": rows, "path": f"/{ctx.slug}/file-library/contracts"}


def _apply_one(contract, item, user):
    base = _contract_views()
    validated, errors, _ = _validated(contract, item.get("changes"))
    if errors:
        field, messages = next(iter(errors.items()))
        raise ActionError(f"{contract.titulo or contract.id}: {field}: {messages[0]}")
    fields = [field for field, value in validated.items() if to_json(getattr(contract, field)) != to_json(value)]
    if not fields:
        return None
    tracked = list(dict.fromkeys([*fields, *DERIVED]))
    before = snapshot(contract, tracked)
    tags_before = {field: getattr(contract, field) for field in base.TAG_SOURCE_FIELDS}
    previous_end, previous_effective = contract.fecha_fin, contract.fecha_fin_efectiva
    for field in fields:
        setattr(contract, field, validated[field])
    if "fecha_fin" in fields and "fecha_fin_efectiva" not in fields:
        contract.fecha_fin_efectiva = base.shifted_effective_end(previous_end, previous_effective, contract.fecha_fin)
    if "estatus_contrato" not in fields:
        base.refresh_status(contract, previous_effective)

    evidence = dict(contract.evidence or {})
    evidence_before = {field: evidence.get(field) for field in fields}
    page = item.get("page") if isinstance(item.get("page"), int) else None
    stamp = {
        "manual": True,
        "quote": str(item.get("quote") or "")[:500],
        "page": page,
        "by": str(user.id),
        "at": timezone.now().isoformat(),
        "reason": str(item.get("reason") or "")[:300] or None,
    }
    evidence_after = {field: stamp for field in fields}
    evidence.update(evidence_after)
    contract.evidence = evidence
    contract.save()
    base.resync_tags_if_changed(contract, tags_before)
    return {
        "contract_id": str(contract.id),
        "titulo": contract.titulo,
        # What was asked; the effective end and the status may follow it
        "requested": fields,
        "changes": diff(before, snapshot(contract, tracked)),
        "evidence_before": to_json(evidence_before),
        "evidence_after": to_json(evidence_after),
    }


@register_apply(AssistantAction.Kind.EDIT_CONTRACT)
def edit_contracts(ctx, request, data) -> AssistantAction:
    _require(ctx)
    items = [item for item in (data.get("items") or []) if isinstance(item, dict)][:MAX_CONTRACTS]
    if not items:
        raise ActionError("Nothing to change.")
    with transaction.atomic():
        ids = [str(item.get("contract_id")) for item in items]
        locked = {
            str(contract.id): contract
            for contract in Contract.objects.select_for_update()
            .filter(workspace_id=ctx.workspace_id, id__in=_contracts(ctx, ids).keys())
            .defer("extracted_text")
        }
        edited = []
        for item in items:
            contract = locked.get(str(item.get("contract_id")))
            if contract is None:
                raise ActionError("A contract was not found or was deleted.")
            row = _apply_one(contract, item, request.user)
            if row:
                edited.append(row)
        if not edited:
            raise ActionError("The contracts already have those values.")
        fields = sum(len(row["requested"]) for row in edited)
        title = edited[0]["titulo"] or "contrato"
        summary = (
            f"Corrigió {fields} dato(s) de «{title}»"
            if len(edited) == 1
            else f"Corrigió {fields} dato(s) en {len(edited)} contratos"
        )
        return AssistantAction.objects.create(
            workspace_id=ctx.workspace_id,
            kind=AssistantAction.Kind.EDIT_CONTRACT,
            summary=summary[:300],
            payload=data,
            result={"contracts": edited},
        )


@register_undo(AssistantAction.Kind.EDIT_CONTRACT)
def undo_edit_contracts(action, user, origin, cookie):
    base = _contract_views()
    rows = (action.result or {}).get("contracts") or []
    contracts = {
        str(contract.id): contract
        for contract in Contract.objects.select_for_update()
        .filter(workspace_id=action.workspace_id, id__in=[row["contract_id"] for row in rows])
        .defer("extracted_text")
    }
    conflicts = []
    for row in rows:
        contract = contracts.get(row["contract_id"])
        if contract is None:
            continue
        tags_before = {field: getattr(contract, field) for field in base.TAG_SOURCE_FIELDS}
        reverted, clashes = revert_fields(contract, row["changes"])
        conflicts.extend({**clash, "contract_id": row["contract_id"], "titulo": row.get("titulo")} for clash in clashes)
        # The evidence goes back only where the field and its stamp are ours
        evidence = dict(contract.evidence or {})
        for field, stamp in (row.get("evidence_after") or {}).items():
            if field in reverted and to_json(evidence.get(field)) == stamp:
                previous = (row.get("evidence_before") or {}).get(field)
                if previous is None:
                    evidence.pop(field, None)
                else:
                    evidence[field] = previous
        contract.evidence = evidence
        if reverted:
            contract.save()
            base.resync_tags_if_changed(contract, tags_before)
    return {"conflicts": conflicts} if conflicts else None
