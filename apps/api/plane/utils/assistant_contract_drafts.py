# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Contracts the assistant prepares from a template.

The assistant fills the variables (each value says where it came from) and
the signers; the card lets the person correct them and "Crear borrador"
leaves a READY signature request, the same one the "Usar" dialog makes.
Sending stays with the person, on the send screen: the assistant never sends.

Text changes for one contract ("quita la cláusula de exclusividad") go
through the template rule: a NEW variant with those edits, and the contract
is built on it. Filling variables never changes the template.
"""

from django.db import transaction
from django.utils import timezone

from plane.db.models import AssistantAction, ContractSignatureRequest, ContractTemplateRevision, FileAsset
from plane.utils.assistant_actions import ActionError, register_undo
from plane.utils.assistant_templates import (
    _edited,
    _require,
    _workflow,
    create_template_variant,
    dry_run,
    find_variant,
)
from plane.utils.assistant_workspace import register_apply

MAX_VALUE = 5000
# Statuses where nothing left Plane yet: undo can delete the request
UNSENT = {
    ContractSignatureRequest.Status.DRAFT,
    ContractSignatureRequest.Status.READY,
    ContractSignatureRequest.Status.ERROR,
}


class ContractDraftError(ActionError):
    """A value or a signer that is missing, with the key the web translates."""

    def __init__(self, message, code, **params):
        super().__init__(message)
        self.code = code
        self.params = params


def _revision(variant, number=None):
    revisions = ContractTemplateRevision.objects.filter(variant=variant).select_related("source_asset")
    if number:
        revision = revisions.filter(revision=int(number)).first()
        if revision is None:
            raise ActionError(f"Version {number} does not exist in this variant.")
        return revision
    return revisions.order_by("-revision").first()


def _values(raw) -> dict:
    """{key: "x"} or {key: {value, source}} → {key: {value, source}}."""
    values = {}
    for key, item in (raw if isinstance(raw, dict) else {}).items():
        if isinstance(item, dict):
            value, source = item.get("value"), item.get("source")
        else:
            value, source = item, None
        value = str(value if value is not None else "").strip()[:MAX_VALUE]
        values[str(key)[:100]] = {"value": value, "source": str(source)[:300] if source else None}
    return values


def _recipients(raw) -> list[dict]:
    rows = []
    for item in (raw if isinstance(raw, list) else [])[:20]:
        item = item if isinstance(item, dict) else {}
        rows.append(
            {
                "name": str(item.get("name") or "").strip()[:255],
                "email": str(item.get("email") or "").strip()[:255],
                "source": str(item.get("source"))[:300] if item.get("source") else None,
            }
        )
    return rows


def proposal(variant, revision_number=None, values=None, recipients=None, title=None, document_edits=None) -> dict:
    """What the card shows: the form (one row per variable, with its settings,
    the proposed value and its origin), the signers by role, and what is
    still missing. With document_edits, the dry run of the new variant."""
    from plane.integrations.contract_docx import analyse_docx_variables, analyse_docx_warnings

    workflow = _workflow()
    revision = _revision(variant, revision_number)
    if document_edits:
        # The contract will be built on a new variant with these edits
        run = dry_run(variant, revision_number, document_edits)
        schema = run["schema"]
        settings_map = run["variable_settings"]
        warnings = run["document_warnings"]
    else:
        run = None
        source = workflow._read_asset(revision.source_asset if revision else variant.source_asset)
        schema = workflow._revision_schema(revision) if revision else analyse_docx_variables(source)
        settings_map = variant.variable_settings or {}
        warnings = analyse_docx_warnings(source, schema, variant.signature_blueprint)
    values = _values(values)
    supplied = _recipients(recipients)

    form = []
    missing = []
    for item in schema.get("variables") or []:
        key = item["key"]
        setting = settings_map.get(key) or {}
        proposed = values.get(key) or {}
        value = proposed.get("value") or ""
        required = setting.get("required") is not False
        row = {
            "key": key,
            "label": setting.get("label") or item.get("label") or key,
            "type": setting.get("type") or item.get("type") or "text",
            "required": required,
            "options": setting.get("options") or None,
            "default": setting.get("default") or None,
            "help": setting.get("help") or None,
            "value": value,
            "source": proposed.get("source"),
        }
        form.append(row)
        if required and not value and not setting.get("default"):
            missing.append(key)
    unknown = sorted(set(values) - {row["key"] for row in form})

    _, blueprint, _ = workflow._manual_blueprint_for_revision(variant, revision) if revision else ([], [], None)
    by_index = {item["index"]: item for item in schema.get("recipients") or []}
    count = max(len(supplied), len(blueprint or []), (max(by_index) + 1) if by_index else 0, 1)
    signers = []
    for index in range(count):
        semantic = by_index.get(index) or {}
        given = supplied[index] if index < len(supplied) else {}
        saved = (blueprint or [])[index] if index < len(blueprint or []) else {}
        signers.append(
            {
                "index": index,
                "role": (variant.recipient_roles or {}).get(str(index))
                or (saved or {}).get("placeholderLabel")
                or f"Firmante {index + 1}",
                "name": given.get("name") or "",
                "email": given.get("email") or "",
                "source": given.get("source"),
                # Written in the Word ({{NombreFirmante2}}): needed to render
                "requires_name": bool(semantic.get("requires_name")),
                "requires_email": bool(semantic.get("requires_email")),
            }
        )
        if not given.get("name") or "@" not in (given.get("email") or ""):
            missing.append(f"signer:{index}")

    return {
        "template_id": str(variant.template_id),
        "template_name": variant.template.name,
        "variant_id": str(variant.id),
        "variant_name": variant.name,
        "revision": revision.revision if revision else None,
        "title": (title or variant.template.name).strip()[:500],
        "variables": form,
        "signers": signers,
        "missing": missing,
        "unknown_values": unknown or None,
        "warnings": warnings or None,
        "document_edits": run,
        "base_sha256": run["base"]["base_sha256"] if run else None,
    }


def _form_values(data):
    values = {key: item["value"] for key, item in _values(data.get("values")).items()}
    omitted = [str(key)[:100] for key in (data.get("omitted_keys") or [])[:100] if isinstance(key, str)]
    return values, omitted


def render_preview(variant, data) -> bytes:
    """The Word filled with the card's values, as a PDF. Missing values show
    as «Etiqueta»; nothing is stored."""
    from plane.integrations.contract_docx import analyse_docx_variables, format_variable_value, render_docx_variables

    workflow = _workflow()
    revision = _revision(variant, data.get("revision"))
    source = workflow._read_asset(revision.source_asset if revision else variant.source_asset)
    if data.get("document_edits"):
        source = _edited(source, data["document_edits"])[0]
    schema = analyse_docx_variables(source)
    extra = data.get("variable_settings") if isinstance(data.get("variable_settings"), dict) else {}
    settings_map = {**(variant.variable_settings or {}), **extra}
    values, omitted = _form_values(data)
    rendered = {}
    for item in schema.get("variables") or []:
        key = item["key"]
        setting = settings_map.get(key) or {}
        raw = values.get(key) or setting.get("default") or ""
        rendered[key] = (
            format_variable_value(raw, item.get("type"), setting) if raw else f"«{setting.get('label') or key}»"
        )
    recipients = [
        {"name": item["name"] or f"«{item.get('role') or index + 1}»", "email": item["email"] or "correo@ejemplo.com"}
        for index, item in enumerate(_recipients(data.get("recipients")))
    ]
    count = len(schema.get("recipients") or [])
    while len(recipients) < count:
        recipients.append({"name": f"«Firmante {len(recipients) + 1}»", "email": "correo@ejemplo.com"})
    document, _, _ = render_docx_variables(source, rendered, recipients, omitted_keys=omitted)
    pdf = workflow._pdf_for_content(variant.workspace, document, "vista-previa.docx", store=False)
    if not pdf:
        raise ActionError("Collabora could not convert the Word to PDF.")
    return pdf


def _signature_request(variant, user, data, revision):
    from plane.integrations.contract_docx import MissingValueError

    workflow = _workflow()
    values, omitted = _form_values(data)
    try:
        signature_request, _ = workflow.create_signature_request(
            variant,
            user,
            {
                "revision_id": str(revision.id) if revision else None,
                "title": data.get("title"),
                "authoring_mode": "DOCUMENT",
                "variable_values": values,
                "omitted_variable_keys": omitted,
                "recipients": [
                    {"name": item["name"], "email": item["email"]} for item in _recipients(data.get("recipients"))
                ],
            },
        )
    except MissingValueError as error:
        raise ContractDraftError(str(error), "missing_value", key=error.key, label=error.label)
    except workflow.ContractInputError as error:
        raise ContractDraftError(str(error.detail or error.code), error.code, **error.params)
    return signature_request


@register_apply(AssistantAction.Kind.CREATE_CONTRACT_DRAFT)
def create_contract_draft(ctx, request, data) -> AssistantAction:
    """A READY signature request with the values; never sent."""
    _require(ctx)
    variant = find_variant(ctx.workspace_id, data.get("variant_id"))
    if variant is None:
        raise ActionError("Template variant not found.")
    variant_action = None
    if data.get("document_edits"):
        # Text changes for this contract: a new variant first (rule 1.2)
        variant_action = create_template_variant(
            ctx,
            request,
            {
                "base": {"variant_id": str(variant.id), "revision": data.get("revision")},
                "edits": data["document_edits"],
                "base_sha256": data.get("base_sha256"),
                "name": data.get("variant_name") or f"{variant.name} – {(data.get('title') or 'contrato')[:60]}",
                "variable_settings": data.get("variable_settings"),
            },
        )
        variant = find_variant(ctx.workspace_id, variant_action.result["variant_id"])
        revision = _revision(variant)
    else:
        revision = _revision(variant, data.get("revision"))
    signature_request = _signature_request(variant, request.user, data, revision)
    template = variant.template
    path = f"/{ctx.slug}/file-library/contracts/documents/{signature_request.id}/editor"
    return AssistantAction.objects.create(
        workspace_id=ctx.workspace_id,
        kind=AssistantAction.Kind.CREATE_CONTRACT_DRAFT,
        summary=f"Preparó «{signature_request.title}» desde «{template.name}»"[:300],
        payload=data,
        result={
            "request_id": str(signature_request.id),
            "title": signature_request.title,
            "template_id": str(template.id),
            "template_name": template.name,
            "variant_id": str(variant.id),
            "variant_name": variant.name,
            "revision": signature_request.revision.revision,
            "variant_action_id": str(variant_action.id) if variant_action else None,
            "warnings": signature_request.preparation_warnings or None,
            "path": path,
        },
    )


@register_undo(AssistantAction.Kind.CREATE_CONTRACT_DRAFT)
def undo_contract_draft(action, user, origin, cookie):
    from plane.utils.assistant_actions import undo

    result = action.result or {}
    signature_request = (
        ContractSignatureRequest.objects.select_for_update(of=("self",))
        .select_related("rendered_source_asset", "rendered_pdf_asset")
        .filter(workspace_id=action.workspace_id, id=result.get("request_id"))
        .first()
    )
    if signature_request is not None:
        if signature_request.status not in UNSENT or signature_request.documenso_envelope_id:
            raise ActionError("This contract was already sent for signature; cancel it from the contract instead.")
        assets = [signature_request.rendered_source_asset, signature_request.rendered_pdf_asset]
        signature_request.delete(soft=False)
        keys = [asset.asset.name for asset in assets if asset is not None]
        for asset in assets:
            if asset is not None:
                FileAsset.objects.filter(id=asset.id).update(is_deleted=True, deleted_at=timezone.now())
        workflow = _workflow()
        transaction.on_commit(lambda: workflow._delete_uploaded(keys))
    # The variant made only for this contract goes with it, while unused
    variant_action = AssistantAction.objects.filter(
        id=result.get("variant_action_id"), status=AssistantAction.Status.APPLIED
    ).first()
    if variant_action is not None:
        try:
            undo(variant_action, user, origin, cookie)
        except ActionError:
            pass
    return None
