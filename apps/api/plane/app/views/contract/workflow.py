# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

import hashlib
import hmac
import json
import re
from io import BytesIO
from uuid import UUID, uuid4

import fitz
from django.conf import settings
from django.db import transaction
from django.db.models import Max
from django.http import HttpResponse
from django.utils import timezone
from rest_framework import status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response

from plane.app.permissions import ROLE, allow_permission
from plane.app.serializers import (
    ContractSignatureRequestSerializer,
    ContractTemplateRevisionSerializer,
    ContractTemplateSerializer,
)
from plane.db.models import (
    ContractSignatureRequest,
    ContractSigner,
    ContractTemplate,
    ContractTemplateRevision,
    ContractTemplateVariant,
    ContractWebhookEvent,
    FileAsset,
    Workspace,
)
from plane.integrations.documenso import DocumensoClient, DocumensoError
from plane.integrations.contract_docx import (
    analyse_docx_variables,
    locate_and_remove_pdf_markers,
    render_docx_variables,
)
from plane.settings.storage import S3Storage
from plane.utils.exception_logger import log_exception

from ..base import BaseAPIView
from ..file_library.collabora import DOCX_MIME, convert_to_pdf
from .base import ensure_contract_for_asset

ALLOWED_ROLES = {"SIGNER", "APPROVER", "CC", "VIEWER", "ASSISTANT"}
ALLOWED_FIELD_TYPES = {
    "SIGNATURE",
    "INITIALS",
    "NAME",
    "EMAIL",
    "DATE",
    "TEXT",
    "NUMBER",
    "RADIO",
    "CHECKBOX",
    "DROPDOWN",
}
ALLOWED_ACTION_AUTH = {"ACCOUNT", "PASSKEY", "TWO_FACTOR_AUTH", "PASSWORD", "EXPLICIT_NONE"}
CONTRACT_PREVIEW_ASSET_TYPES = {
    FileAsset.EntityTypeContext.CONTRACT_TEMPLATE,
    FileAsset.EntityTypeContext.CONTRACT_REVISION,
    FileAsset.EntityTypeContext.CONTRACT_UNSIGNED,
    FileAsset.EntityTypeContext.CONTRACT_SIGNED,
}
DEFAULT_EMAIL_SETTINGS = {
    "recipientSigningRequest": True,
    "recipientRemoved": True,
    "recipientSigned": True,
    "documentPending": True,
    "documentCompleted": True,
    "documentDeleted": True,
    "ownerDocumentCompleted": True,
    "ownerRecipientExpired": True,
    "ownerDocumentCreated": True,
}
DEFAULT_AUTHORING_SETTINGS = {
    "subject": "",
    "message": "",
    "timezone": "Etc/UTC",
    "dateFormat": "yyyy-MM-dd hh:mm a",
    "redirectUrl": "",
    "language": "en",
    "distributionMethod": "EMAIL",
    "signingOrder": "PARALLEL",
    "allowDictateNextSigner": False,
    "typedSignatureEnabled": True,
    "uploadSignatureEnabled": True,
    "drawSignatureEnabled": True,
    "emailReplyTo": "",
    "emailSettings": DEFAULT_EMAIL_SETTINGS,
    "envelopeExpirationPeriod": {"unit": "month", "amount": 3},
    "reminderSettings": {
        "sendAfter": {"unit": "day", "amount": 5},
        "repeatEvery": {"unit": "day", "amount": 2},
    },
}


def _contract_bucket():
    return settings.CONTRACTS_S3_BUCKET_NAME


def _storage(request=None):
    return S3Storage(request=request, bucket_name=_contract_bucket())


def _asset_key(workspace_id, purpose, extension):
    return f"contracts/{workspace_id}/{purpose}/{uuid4().hex}.{extension}"


def _create_asset(*, workspace, user, key, name, mime_type, content, entity_type):
    # This upload is performed by Django, not by the browser. It must always
    # use the internal S3 endpoint even when an HTTP request is available.
    storage = _storage()
    if not storage.upload_file(BytesIO(content), key, content_type=mime_type):
        raise RuntimeError("Unable to upload contract file")
    metadata = storage.get_object_metadata(key) or {}
    metadata["bucket"] = _contract_bucket()
    metadata["purpose"] = entity_type
    return FileAsset.objects.create(
        workspace=workspace,
        user=user,
        asset=key,
        attributes={"name": name, "type": mime_type},
        entity_type=entity_type,
        size=len(content),
        is_uploaded=True,
        storage_metadata=metadata,
    )


def _read_asset(asset):
    storage = S3Storage.for_asset(asset)
    result = storage.s3_client.get_object(Bucket=storage.aws_storage_bucket_name, Key=asset.asset.name)
    return result["Body"].read()


def _copy_asset(*, source, workspace, user, name, entity_type, purpose):
    source_storage = S3Storage.for_asset(source)
    target_storage = _storage()
    key = _asset_key(workspace.id, purpose, name.rsplit(".", 1)[-1].lower())
    if source_storage.aws_storage_bucket_name == target_storage.aws_storage_bucket_name:
        copied = target_storage.copy_object(source.asset.name, key)
    else:
        copied = target_storage.upload_file(
            BytesIO(_read_asset(source)),
            key,
            content_type=(source.attributes or {}).get("type"),
        )
    if not copied:
        raise RuntimeError("Unable to copy contract file")
    metadata = target_storage.get_object_metadata(key) or {}
    metadata["bucket"] = _contract_bucket()
    metadata["purpose"] = entity_type
    return FileAsset.objects.create(
        workspace=workspace,
        user=user,
        asset=key,
        attributes={"name": name, "type": (source.attributes or {}).get("type", DOCX_MIME)},
        entity_type=entity_type,
        size=source.size,
        is_uploaded=True,
        storage_metadata=metadata,
    )


def _pdf_layout_signature(pdf_bytes):
    """Geometry-only signature used to decide whether saved field positions fit.

    It intentionally ignores PDF content, so a changed header with identical
    page boxes can reuse a variant's field blueprint.
    """
    try:
        import fitz

        document = fitz.open(stream=pdf_bytes, filetype="pdf")
        result = {
            "page_count": len(document),
            "media_boxes": [[page.rect.x0, page.rect.y0, page.rect.x1, page.rect.y1] for page in document],
        }
        document.close()
        return result
    except Exception:
        pass

    boxes = []
    for match in re.finditer(
        rb"/MediaBox\s*\[\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\]",
        pdf_bytes,
    ):
        boxes.append([float(value) for value in match.groups()])
    page_markers = len(re.findall(rb"/Type\s*/Page(?!s)\b", pdf_bytes))
    return {"page_count": page_markers, "media_boxes": boxes[:page_markers]}


def _blueprint_for_layout(blueprint, blueprint_layout, current_layout):
    geometry_keys = ("page_count", "media_boxes")
    blueprint_geometry = {key: (blueprint_layout or {}).get(key) for key in geometry_keys}
    current_geometry = {key: (current_layout or {}).get(key) for key in geometry_keys}
    return blueprint if blueprint_geometry == current_geometry else []


def _layout_with_content(layout, content_sha256):
    return {**(layout or {}), "content_sha256": content_sha256}


def _get_or_create_template_revision(variant, user, source_bytes=None, name=""):
    source_bytes = source_bytes if source_bytes is not None else _read_asset(variant.source_asset)
    content_sha256 = hashlib.sha256(source_bytes).hexdigest()
    existing = ContractTemplateRevision.objects.filter(variant=variant, content_sha256=content_sha256).first()
    if existing:
        if name and existing.name != name:
            existing.name = name
            existing.save(update_fields=["name", "updated_at"])
        return existing, False

    pdf_bytes = convert_to_pdf(
        source_bytes,
        (variant.source_asset.attributes or {}).get("name", "contract.docx"),
    )
    if not pdf_bytes:
        raise RuntimeError("Collabora could not convert the Word template to PDF")
    layout_signature = _pdf_layout_signature(pdf_bytes)
    variable_schema = analyse_docx_variables(source_bytes)
    next_revision = (
        ContractTemplateRevision.objects.filter(variant=variant).aggregate(value=Max("revision"))["value"] or 0
    ) + 1
    source_asset = _create_asset(
        workspace=variant.workspace,
        user=user,
        key=_asset_key(variant.workspace_id, "template-versions", "docx"),
        name=f"{variant.template.name}-{variant.name}-v{next_revision}.docx",
        mime_type=DOCX_MIME,
        content=source_bytes,
        entity_type=FileAsset.EntityTypeContext.CONTRACT_REVISION,
    )
    pdf_asset = _create_asset(
        workspace=variant.workspace,
        user=user,
        key=_asset_key(variant.workspace_id, "template-versions", "pdf"),
        name=f"{variant.template.name}-{variant.name}-v{next_revision}.pdf",
        mime_type="application/pdf",
        content=pdf_bytes,
        entity_type=FileAsset.EntityTypeContext.CONTRACT_UNSIGNED,
    )
    blueprint_layout = variant.signature_blueprint_layout or {}
    blueprint_matches = blueprint_layout.get("content_sha256") == content_sha256
    revision = ContractTemplateRevision.objects.create(
        workspace=variant.workspace,
        variant=variant,
        revision=next_revision,
        name=str(name or "").strip()[:255],
        source_asset=source_asset,
        pdf_asset=pdf_asset,
        content_sha256=content_sha256,
        layout_signature=layout_signature,
        variable_schema=variable_schema,
        signature_blueprint=variant.signature_blueprint if blueprint_matches else [],
        signature_blueprint_layout=variant.signature_blueprint_layout if blueprint_matches else {},
        recipient_blueprint=variant.recipient_blueprint if blueprint_matches else [],
        authoring_settings=variant.authoring_settings if blueprint_matches else {},
        created_by=user,
    )
    return revision, True


def _overwrite_asset_content(asset, content):
    storage = S3Storage.for_asset(asset)
    uploaded = storage.upload_file(
        BytesIO(content),
        asset.asset.name,
        content_type=(asset.attributes or {}).get("type", DOCX_MIME),
    )
    if not uploaded:
        raise RuntimeError("Unable to restore contract document")
    asset.size = len(content)
    asset.save(update_fields=["size", "updated_at"])


def _dispose_edit_backup(backup):
    try:
        S3Storage.for_asset(backup).delete_files([backup.asset.name])
    except Exception as exc:
        log_exception(exc)
    backup.is_deleted = True
    backup.deleted_at = timezone.now()
    backup.save(update_fields=["is_deleted", "deleted_at", "updated_at"])


def _delete_signature_requests(signature_requests, *, delete_files=False, delete_analysis=False):
    """Delete local signing records without touching shared template revisions.

    Rendered DOCX/unsigned PDF assets belong exclusively to the request and are
    always removed. The signed file-library PDF and AI data are explicit,
    destructive options. AI data must go with a signed file so no analysis can
    point at an object that no longer exists.
    """
    signature_requests = list(signature_requests)
    if delete_files and not delete_analysis and any(item.analysis_contract_id for item in signature_requests):
        raise ValueError("Deleting signed files also requires deleting their AI analysis")

    internal_assets = []
    signed_assets = []
    analysis_assets = []
    analysis_contracts = []
    for signature_request in signature_requests:
        internal_assets.extend(
            [signature_request.rendered_source_asset, signature_request.rendered_pdf_asset]
        )
        if delete_files:
            signed_assets.append(signature_request.signed_asset)
        if delete_analysis and signature_request.analysis_contract:
            analysis_contracts.append(signature_request.analysis_contract)
            analysis_assets.append(signature_request.analysis_contract.thumbnail_asset)

    # Storage deletion happens before database deletion. A failed object-store
    # operation leaves the records intact so the user can retry safely.
    assets_to_purge = [*internal_assets, *signed_assets, *analysis_assets]
    unique_assets = {asset.id: asset for asset in assets_to_purge if asset is not None}
    for asset in unique_assets.values():
        object_name = asset.asset.name
        if object_name and not S3Storage.for_asset(asset).delete_files([object_name]):
            raise RuntimeError(f"Unable to delete contract file {asset.id}")

    deleted_ids = [str(item.id) for item in signature_requests]
    with transaction.atomic():
        for analysis_contract in analysis_contracts:
            # Hard deletion cascades through extracted text chunks/embeddings,
            # processing jobs and contract-scoped chats immediately.
            analysis_contract.delete(soft=False)
        for signature_request in signature_requests:
            signature_request.delete(soft=False)
        for asset in unique_assets.values():
            asset.delete(soft=False)

    return {
        "deleted": deleted_ids,
        "files_deleted": len(unique_assets),
        "analyses_deleted": len(analysis_contracts),
    }


def _delete_signature_requests_from_payload(request, slug):
    if request.data.get("confirm") is not True:
        return Response({"error": "Deletion must be confirmed"}, status=status.HTTP_400_BAD_REQUEST)
    request_ids = request.data.get("request_ids")
    if not isinstance(request_ids, list) or not request_ids or len(request_ids) > 100:
        return Response(
            {"error": "request_ids must contain between 1 and 100 items"},
            status=status.HTTP_400_BAD_REQUEST,
        )
    try:
        parsed_ids = [UUID(str(request_id)) for request_id in request_ids]
    except (TypeError, ValueError, AttributeError):
        return Response({"error": "Invalid request id"}, status=status.HTTP_400_BAD_REQUEST)

    signature_requests = list(
        ContractSignatureRequest.objects.filter(
            id__in=parsed_ids,
            workspace__slug=slug,
            authoring_mode=ContractSignatureRequest.AuthoringMode.DOCUMENT,
        ).select_related(
            "rendered_source_asset",
            "rendered_pdf_asset",
            "signed_asset",
            "analysis_contract__thumbnail_asset",
        )
    )
    found_ids = {item.id for item in signature_requests}
    try:
        result = _delete_signature_requests(
            signature_requests,
            delete_files=bool(request.data.get("delete_files")),
            delete_analysis=bool(request.data.get("delete_analysis")),
        )
    except ValueError as exc:
        return Response({"error": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
    except RuntimeError as exc:
        log_exception(exc)
        return Response({"error": str(exc)}, status=status.HTTP_502_BAD_GATEWAY)
    result["not_found"] = [str(request_id) for request_id in parsed_ids if request_id not in found_ids]
    return Response(result, status=status.HTTP_200_OK)


def _revision_schema(revision):
    return revision.variable_schema or analyse_docx_variables(_read_asset(revision.source_asset))


def _manual_blueprint_for_revision(variant, revision):
    if revision.signature_blueprint:
        return revision.signature_blueprint, revision.recipient_blueprint, "COMPATIBLE"
    if (variant.signature_blueprint_layout or {}).get("content_sha256") == revision.content_sha256:
        return variant.signature_blueprint, variant.recipient_blueprint, "COMPATIBLE"
    if variant.signature_blueprint:
        return [], [], "REQUIRES_REVIEW"
    return [], [], "NONE"


def _prepare_recipients(*, schema, supplied, blueprint, fields, authoring_mode):
    supplied = supplied if isinstance(supplied, list) else []
    semantic_indexes = [item["index"] for item in schema.get("recipients") or []]
    field_indexes = [field.get("recipient_index", 0) for field in fields]
    recipient_count = max(
        len(supplied),
        len(blueprint),
        (max(semantic_indexes + field_indexes) + 1) if semantic_indexes or field_indexes else 0,
    )
    recipient_count = recipient_count or 1
    recipients = []
    for index in range(recipient_count):
        provided = supplied[index] if index < len(supplied) and isinstance(supplied[index], dict) else {}
        saved = blueprint[index] if index < len(blueprint) and isinstance(blueprint[index], dict) else {}
        placeholder = provided.get("placeholderLabel") or saved.get("placeholderLabel") or f"Firmante {index + 1}"
        name = str(provided.get("name") or "").strip()
        email = str(provided.get("email") or "").strip()
        if authoring_mode == ContractSignatureRequest.AuthoringMode.TEMPLATE:
            name = name or placeholder
            email = email or f"firmante{index + 1}@ejemplo.local"
        recipients.append(
            {
                "name": name,
                "email": email,
                "placeholderLabel": placeholder,
                "role": str(provided.get("role") or saved.get("role") or "SIGNER").upper(),
                "signingOrder": index + 1,
                "actionAuth": provided.get("actionAuth") or saved.get("actionAuth") or [],
                "fields": [
                    {key: value for key, value in field.items() if key != "recipient_index"}
                    for field in fields
                    if field.get("recipient_index", 0) == index
                ],
            }
        )
    return recipients


def _bounded_number(value, default, minimum, maximum):
    return max(minimum, min(maximum, float(value if value is not None else default)))


def _normalise_field_meta(field_type, value):
    if not isinstance(value, dict):
        value = {}
    result = {"type": field_type.lower()}
    for key, limit in (("label", 255), ("placeholder", 255), ("text", 5000), ("numberFormat", 100)):
        if key in value and value[key] is not None:
            result[key] = str(value[key])[:limit]
    for key in ("required", "readOnly"):
        if key in value:
            result[key] = bool(value[key])
    if "fontSize" in value:
        result["fontSize"] = _bounded_number(value["fontSize"], 12, 8, 96)
    if value.get("overflow") in {"auto", "horizontal", "vertical", "crop"}:
        result["overflow"] = value["overflow"]
    if value.get("textAlign") in {"left", "center", "right"}:
        result["textAlign"] = value["textAlign"]
    if value.get("verticalAlign") in {"top", "middle", "bottom"}:
        result["verticalAlign"] = value["verticalAlign"]
    if value.get("direction") in {"vertical", "horizontal"}:
        result["direction"] = value["direction"]
    for key, minimum, maximum in (
        ("lineHeight", 1, 10),
        ("letterSpacing", 0, 100),
        ("characterLimit", 0, 100000),
        ("validationLength", 0, 100),
    ):
        if value.get(key) is not None:
            result[key] = _bounded_number(value[key], minimum, minimum, maximum)
    for key in ("minValue", "maxValue"):
        if value.get(key) is not None:
            result[key] = float(value[key])
    if value.get("validationRule"):
        result["validationRule"] = str(value["validationRule"])[:80]
    if value.get("defaultValue") is not None:
        result["defaultValue"] = str(value["defaultValue"])[:500]
    if value.get("value") is not None:
        result["value"] = str(value["value"])[:500]
    if value.get("templateVariable"):
        result["templateVariable"] = str(value["templateVariable"])[:100]
    if field_type in {"RADIO", "CHECKBOX", "DROPDOWN"}:
        raw_values = value.get("values") if isinstance(value.get("values"), list) else []
        choices = []
        for index, choice in enumerate(raw_values[:100]):
            if not isinstance(choice, dict):
                continue
            item = {"value": str(choice.get("value") or "")[:500]}
            if field_type != "DROPDOWN":
                item.update({"id": int(choice.get("id") or index + 1), "checked": bool(choice.get("checked"))})
            choices.append(item)
        if not choices:
            choices = (
                [{"value": "Option 1"}] if field_type == "DROPDOWN" else [{"id": 1, "checked": False, "value": ""}]
            )
        result["values"] = choices
    return result


def _normalise_authoring_field(field, context):
    if not isinstance(field, dict):
        raise ValueError(f"Invalid field for {context}")
    field_type = str(field.get("type") or "").upper()
    if field_type not in ALLOWED_FIELD_TYPES:
        raise ValueError(f"Invalid field type for {context}")
    return {
        "identifier": 0,
        "type": field_type,
        "page": max(1, int(field.get("page", 1))),
        "positionX": _bounded_number(field.get("positionX"), 10, 0, 100),
        "positionY": _bounded_number(field.get("positionY"), 80, 0, 100),
        "width": _bounded_number(field.get("width"), 25, 1, 100),
        "height": _bounded_number(field.get("height"), 6, 1, 100),
        "fieldMeta": _normalise_field_meta(field_type, field.get("fieldMeta")),
    }


def _normalise_period(value, default, allowed_units):
    if isinstance(value, dict) and value.get("disabled") is True:
        return {"disabled": True}
    if not isinstance(value, dict) or value.get("unit") not in allowed_units:
        value = default
    return {"unit": value["unit"], "amount": max(1, min(365, int(value.get("amount") or 1)))}


def _normalise_authoring_settings(value):
    raw = value if isinstance(value, dict) else {}
    result = {
        **DEFAULT_AUTHORING_SETTINGS,
        "emailSettings": {**DEFAULT_EMAIL_SETTINGS},
        "reminderSettings": {**DEFAULT_AUTHORING_SETTINGS["reminderSettings"]},
    }
    for key, limit in (
        ("subject", 254),
        ("message", 5000),
        ("timezone", 100),
        ("dateFormat", 100),
        ("redirectUrl", 2000),
        ("language", 10),
        ("emailReplyTo", 254),
    ):
        if key in raw:
            result[key] = str(raw.get(key) or "")[:limit]
    if raw.get("distributionMethod") in {"EMAIL", "NONE"}:
        result["distributionMethod"] = raw["distributionMethod"]
    if raw.get("signingOrder") in {"PARALLEL", "SEQUENTIAL"}:
        result["signingOrder"] = raw["signingOrder"]
    for key in (
        "allowDictateNextSigner",
        "typedSignatureEnabled",
        "uploadSignatureEnabled",
        "drawSignatureEnabled",
    ):
        if key in raw:
            result[key] = bool(raw[key])
    if not any(result[key] for key in ("typedSignatureEnabled", "uploadSignatureEnabled", "drawSignatureEnabled")):
        raise ValueError("At least one signature type must be enabled")
    if isinstance(raw.get("emailSettings"), dict):
        result["emailSettings"] = {
            key: bool(raw["emailSettings"].get(key, default)) for key, default in DEFAULT_EMAIL_SETTINGS.items()
        }
    result["envelopeExpirationPeriod"] = _normalise_period(
        raw.get("envelopeExpirationPeriod"),
        DEFAULT_AUTHORING_SETTINGS["envelopeExpirationPeriod"],
        {"day", "week", "month", "year"},
    )
    reminders = raw.get("reminderSettings") if isinstance(raw.get("reminderSettings"), dict) else {}
    result["reminderSettings"] = {
        "sendAfter": _normalise_period(
            reminders.get("sendAfter"),
            DEFAULT_AUTHORING_SETTINGS["reminderSettings"]["sendAfter"],
            {"day", "week", "month"},
        ),
        "repeatEvery": _normalise_period(
            reminders.get("repeatEvery"),
            DEFAULT_AUTHORING_SETTINGS["reminderSettings"]["repeatEvery"],
            {"day", "week", "month"},
        ),
    }
    return result


def _normalise_authoring_payload(recipients, authoring_settings=None):
    if not isinstance(recipients, list) or not recipients:
        raise ValueError("At least one recipient is required")
    if len(recipients) > 50:
        raise ValueError("A contract cannot have more than 50 recipients")
    result = []
    seen_emails = set()
    for index, recipient in enumerate(recipients):
        if not isinstance(recipient, dict):
            raise ValueError(f"Invalid recipient at position {index + 1}")
        email = str(recipient.get("email") or "").strip()
        name = str(recipient.get("name") or "").strip()
        role = str(recipient.get("role") or "SIGNER").upper()
        if not email or "@" not in email or not name or role not in ALLOWED_ROLES:
            raise ValueError(f"Invalid recipient at position {index + 1}")
        normalised_email = email.lower()
        if normalised_email in seen_emails:
            raise ValueError("Recipient emails must be unique")
        seen_emails.add(normalised_email)
        fields = recipient.get("fields") or []
        cleaned_fields = [_normalise_authoring_field(field, email) for field in fields]
        if role in {"CC", "VIEWER"}:
            cleaned_fields = []
        if role == "SIGNER" and not any(field["type"] == "SIGNATURE" for field in cleaned_fields):
            raise ValueError(f"{email} requires at least one signature field")
        action_auth = [item for item in recipient.get("actionAuth") or [] if item in ALLOWED_ACTION_AUTH]
        result.append(
            {
                "email": email,
                "name": name,
                "role": role,
                "signingOrder": index + 1,
                "actionAuth": action_auth,
                "fields": cleaned_fields,
            }
        )
    _normalise_authoring_settings(authoring_settings)
    if result[-1]["role"] == "ASSISTANT":
        raise ValueError("An assistant cannot be the last recipient")
    return result


def _normalise_authoring_draft(recipients):
    """Sanitise an in-progress authoring payload without requiring completion.

    Drafts intentionally allow empty recipient names/emails and signers without
    fields. The stricter `_normalise_authoring_payload` remains the gate before
    creating and distributing a Documenso envelope.
    """

    if not isinstance(recipients, list) or not recipients:
        raise ValueError("At least one recipient is required")
    if len(recipients) > 50:
        raise ValueError("A contract cannot have more than 50 recipients")

    result = []
    for index, recipient in enumerate(recipients):
        if not isinstance(recipient, dict):
            raise ValueError(f"Invalid recipient at position {index + 1}")
        role = str(recipient.get("role") or "SIGNER").upper()
        if role not in ALLOWED_ROLES:
            raise ValueError(f"Invalid recipient role at position {index + 1}")

        fields = recipient.get("fields") or []
        if not isinstance(fields, list) or len(fields) > 250:
            raise ValueError(f"Invalid fields at position {index + 1}")
        cleaned_fields = [_normalise_authoring_field(field, f"recipient at position {index + 1}") for field in fields]
        if role in {"CC", "VIEWER"}:
            cleaned_fields = []
        result.append(
            {
                "email": str(recipient.get("email") or "").strip()[:254],
                "name": str(recipient.get("name") or "").strip()[:255],
                "role": role,
                "signingOrder": index + 1,
                "placeholderLabel": str(recipient.get("placeholderLabel") or "")[:255],
                "actionAuth": [item for item in recipient.get("actionAuth") or [] if item in ALLOWED_ACTION_AUTH],
                "fields": cleaned_fields,
            }
        )
    return result


def _recipients_from_blueprint(variant, fields):
    blueprints = variant.recipient_blueprint or []
    if not blueprints and fields:
        recipient_count = max(field.get("recipient_index", 0) for field in fields) + 1
        blueprints = [
            {
                "placeholderLabel": f"Recipient {index + 1}",
                "role": "SIGNER",
                "signingOrder": index + 1,
            }
            for index in range(recipient_count)
        ]
    if not blueprints:
        blueprints = [{"placeholderLabel": "Recipient 1", "role": "SIGNER", "signingOrder": 1}]
    return [
        {
            "name": "",
            "email": "",
            "placeholderLabel": blueprint.get("placeholderLabel") or f"Recipient {index + 1}",
            "role": blueprint.get("role") or "SIGNER",
            "signingOrder": index + 1,
            "actionAuth": blueprint.get("actionAuth") or [],
            "fields": [
                {key: value for key, value in field.items() if key != "recipient_index"}
                for field in fields
                if field.get("recipient_index") == index
            ],
        }
        for index, blueprint in enumerate(blueprints)
    ]


def _signing_links_from_envelope(envelope):
    public_url = settings.DOCUMENSO_URL.rstrip("/")
    return [
        {
            "id": recipient.get("id"),
            "name": recipient.get("name") or "",
            "email": recipient.get("email") or "",
            "role": recipient.get("role") or "SIGNER",
            "signing_order": recipient.get("signingOrder"),
            "url": f"{public_url}/sign/{recipient['token']}",
        }
        for recipient in envelope.get("recipients") or []
        if recipient.get("token") and recipient.get("role") != "CC"
    ]


def _signing_details_from_envelope(envelope):
    """Return the safe recipient/field progress needed by Plane's details UI."""

    recipients = [
        {
            "id": recipient.get("id"),
            "name": recipient.get("name") or "",
            "email": recipient.get("email") or "",
            "role": recipient.get("role") or "SIGNER",
            "signing_order": recipient.get("signingOrder"),
            "signing_status": recipient.get("signingStatus") or "NOT_SIGNED",
            "read_status": recipient.get("readStatus") or "NOT_OPENED",
            "send_status": recipient.get("sendStatus") or "NOT_SENT",
            "signed_at": recipient.get("signedAt"),
            "rejection_reason": recipient.get("rejectionReason"),
        }
        for recipient in envelope.get("recipients") or []
    ]
    fields = []
    for field in envelope.get("fields") or []:
        field_meta = field.get("fieldMeta") if isinstance(field.get("fieldMeta"), dict) else {}
        value = field.get("customText")
        if field.get("type") in {"SIGNATURE", "INITIALS"}:
            value = "Completado" if field.get("inserted") else "Pendiente"
        elif field.get("type") in {"CHECKBOX", "RADIO", "DROPDOWN"} and not value:
            values = field_meta.get("values") if isinstance(field_meta.get("values"), list) else []
            selected = [str(item.get("value") or item.get("label") or "") for item in values if item.get("checked")]
            value = ", ".join(item for item in selected if item)
        fields.append(
            {
                "id": field.get("id"),
                "recipient_id": field.get("recipientId"),
                "type": field.get("type") or "TEXT",
                "page": field.get("page"),
                "label": field_meta.get("label") or field.get("type") or "Campo",
                "value": value or "",
                "inserted": bool(field.get("inserted")),
            }
        )
    return {
        "status": envelope.get("status"),
        "recipients": recipients,
        "fields": fields,
        "synced_at": timezone.now().isoformat(),
    }


def _attach_envelope_progress(signature_request, envelope):
    _sync_signers_from_webhook(signature_request, envelope)
    if hasattr(signature_request, "_prefetched_objects_cache"):
        signature_request._prefetched_objects_cache.pop("signers", None)
    signature_request._signing_details = _signing_details_from_envelope(envelope)
    return signature_request


class ContractTemplatesEndpoint(BaseAPIView):
    @allow_permission([ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def get(self, request, slug):
        templates = (
            ContractTemplate.objects.filter(workspace__slug=slug, is_active=True)
            .prefetch_related("variants__source_asset", "variants__revisions")
            .order_by("name")
        )
        return Response(ContractTemplateSerializer(templates, many=True).data)

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def post(self, request, slug):
        upload = request.FILES.get("file")
        name = str(request.data.get("name") or "").strip()
        description = str(request.data.get("description") or "").strip()
        if not upload or not name:
            return Response({"error": "name and DOCX file are required"}, status=status.HTTP_400_BAD_REQUEST)
        if not upload.name.lower().endswith(".docx") or upload.read(4)[:2] != b"PK":
            return Response({"error": "Only valid .docx files are accepted"}, status=status.HTTP_400_BAD_REQUEST)
        upload.seek(0)
        workspace = Workspace.objects.get(slug=slug)
        try:
            asset = _create_asset(
                workspace=workspace,
                user=request.user,
                key=_asset_key(workspace.id, "templates", "docx"),
                name=upload.name,
                mime_type=DOCX_MIME,
                content=upload.read(),
                entity_type=FileAsset.EntityTypeContext.CONTRACT_TEMPLATE,
            )
            with transaction.atomic():
                template = ContractTemplate.objects.create(
                    workspace=workspace,
                    name=name,
                    description=description,
                    created_by=request.user,
                )
                ContractTemplateVariant.objects.create(
                    workspace=workspace,
                    template=template,
                    name="Principal",
                    source_asset=asset,
                    is_default=True,
                    created_by=request.user,
                )
        except Exception as exc:
            log_exception(exc)
            return Response({"error": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        return Response(ContractTemplateSerializer(template).data, status=status.HTTP_201_CREATED)


class ContractTemplateDetailEndpoint(BaseAPIView):
    @allow_permission([ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def get(self, request, slug, template_id):
        template = (
            ContractTemplate.objects.filter(id=template_id, workspace__slug=slug, is_active=True)
            .prefetch_related("variants__source_asset", "variants__revisions__source_asset", "variants__revisions__pdf_asset")
            .get()
        )
        return Response(ContractTemplateSerializer(template).data)

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def delete(self, request, slug, template_id):
        template = ContractTemplate.objects.get(id=template_id, workspace__slug=slug, is_active=True)
        # Do not cascade through variants/revisions: signed and pending requests
        # keep their immutable revision history after the template leaves the library.
        template.is_active = False
        template.deleted_at = timezone.now()
        template.save()
        return Response(status=status.HTTP_204_NO_CONTENT)


class ContractAssetThumbnailEndpoint(BaseAPIView):
    """Render a small first-page image for fast version selection."""

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def get(self, request, slug, asset_id):
        asset = FileAsset.objects.filter(
            id=asset_id,
            workspace__slug=slug,
            entity_type__in=CONTRACT_PREVIEW_ASSET_TYPES,
            is_uploaded=True,
            deleted_at__isnull=True,
        ).first()
        if not asset:
            return Response({"error": "File not found"}, status=status.HTTP_404_NOT_FOUND)

        try:
            content = _read_asset(asset)
            name = (asset.attributes or {}).get("name", "document")
            mime_type = (asset.attributes or {}).get("type", "")
            if mime_type == "application/pdf" or name.lower().endswith(".pdf"):
                pdf_bytes = content
            elif name.lower().endswith(".docx"):
                pdf_bytes = convert_to_pdf(content, name)
            else:
                pdf_bytes = None
        except Exception as exc:
            log_exception(exc)
            pdf_bytes = None
        if not pdf_bytes:
            return Response({"error": "Preview is not available"}, status=status.HTTP_422_UNPROCESSABLE_ENTITY)

        try:
            document = fitz.open(stream=pdf_bytes, filetype="pdf")
            if document.page_count == 0:
                raise ValueError("Empty document")
            page = document.load_page(0)
            scale = min(1.15, 360 / max(page.rect.width, 1))
            pixmap = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
            image = pixmap.tobytes("png")
            document.close()
        except Exception as exc:
            log_exception(exc)
            return Response({"error": "Unable to render preview"}, status=status.HTTP_422_UNPROCESSABLE_ENTITY)

        response = HttpResponse(image, content_type="image/png")
        response["Cache-Control"] = "private, max-age=60"
        return response


class ContractAssetPdfPreviewEndpoint(BaseAPIView):
    """Serve a contract asset as PDF, converting Word sources on the way.

    The browser-side .docx renderer drops most of the document's content, so
    template previews are rendered through the same LibreOffice conversion the
    thumbnails already use and handed to the regular PDF viewer instead.
    """

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def get(self, request, slug, asset_id):
        asset = FileAsset.objects.filter(
            id=asset_id,
            workspace__slug=slug,
            entity_type__in=CONTRACT_PREVIEW_ASSET_TYPES,
            is_uploaded=True,
            deleted_at__isnull=True,
        ).first()
        if not asset:
            return Response({"error": "File not found"}, status=status.HTTP_404_NOT_FOUND)

        try:
            content = _read_asset(asset)
            name = (asset.attributes or {}).get("name", "document")
            mime_type = (asset.attributes or {}).get("type", "")
            if mime_type == "application/pdf" or name.lower().endswith(".pdf"):
                pdf_bytes = content
            elif name.lower().endswith(".docx"):
                pdf_bytes = convert_to_pdf(content, name)
            else:
                pdf_bytes = None
        except Exception as exc:
            log_exception(exc)
            pdf_bytes = None

        if not pdf_bytes:
            return Response({"error": "Preview is not available"}, status=status.HTTP_422_UNPROCESSABLE_ENTITY)

        response = HttpResponse(pdf_bytes, content_type="application/pdf")
        response["Content-Disposition"] = 'inline; filename="preview.pdf"'
        response["Cache-Control"] = "private, max-age=60"
        return response


class ContractTemplateVariantsEndpoint(BaseAPIView):
    @allow_permission([ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def post(self, request, slug, template_id):
        template = ContractTemplate.objects.get(id=template_id, workspace__slug=slug)
        source_variant_id = request.data.get("source_variant_id")
        source = (
            template.variants.filter(id=source_variant_id).first()
            if source_variant_id
            else template.variants.filter(is_default=True).first()
        )
        name = str(request.data.get("name") or "").strip()
        if not source or not name:
            return Response({"error": "name and a source variant are required"}, status=status.HTTP_400_BAD_REQUEST)
        try:
            asset = _copy_asset(
                source=source.source_asset,
                workspace=template.workspace,
                user=request.user,
                name=f"{name}.docx",
                entity_type=FileAsset.EntityTypeContext.CONTRACT_TEMPLATE,
                purpose="variants",
            )
            ContractTemplateVariant.objects.create(
                workspace=template.workspace,
                template=template,
                name=name,
                source_asset=asset,
                signature_blueprint=source.signature_blueprint,
                signature_blueprint_layout=source.signature_blueprint_layout,
                recipient_blueprint=source.recipient_blueprint,
                authoring_settings=source.authoring_settings,
                created_by=request.user,
            )
        except Exception as exc:
            log_exception(exc)
            return Response({"error": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        return Response(ContractTemplateSerializer(template).data, status=status.HTTP_201_CREATED)


class ContractTemplateVariantDetailEndpoint(BaseAPIView):
    @allow_permission([ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def patch(self, request, slug, variant_id):
        variant = ContractTemplateVariant.objects.get(id=variant_id, workspace__slug=slug)
        if "name" in request.data:
            variant.name = str(request.data["name"]).strip() or variant.name
        if "signature_blueprint" in request.data:
            blueprint = request.data["signature_blueprint"]
            if not isinstance(blueprint, list):
                return Response({"error": "signature_blueprint must be a list"}, status=status.HTTP_400_BAD_REQUEST)
            variant.signature_blueprint = blueprint
        if "recipient_blueprint" in request.data:
            variant.recipient_blueprint = request.data["recipient_blueprint"]
        if "authoring_settings" in request.data:
            variant.authoring_settings = _normalise_authoring_settings(request.data["authoring_settings"])
        variant.save(
            update_fields=[
                "name",
                "signature_blueprint",
                "recipient_blueprint",
                "authoring_settings",
                "updated_at",
            ]
        )
        return Response(ContractTemplateSerializer(variant.template).data)


class ContractTemplateVariantRevisionsEndpoint(BaseAPIView):
    @allow_permission([ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def get(self, request, slug, variant_id):
        variant = ContractTemplateVariant.objects.get(id=variant_id, workspace__slug=slug)
        revisions = variant.revisions.select_related("source_asset", "pdf_asset").order_by("-revision")
        return Response(ContractTemplateRevisionSerializer(revisions, many=True).data)

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def post(self, request, slug, variant_id):
        variant = ContractTemplateVariant.objects.select_related("workspace", "template", "source_asset").get(
            id=variant_id, workspace__slug=slug
        )
        try:
            revision, created = _get_or_create_template_revision(
                variant,
                request.user,
                name=str(request.data.get("name") or "").strip(),
            )
        except Exception as exc:
            log_exception(exc)
            return Response({"error": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        return Response(
            ContractTemplateRevisionSerializer(revision).data,
            status=status.HTTP_201_CREATED if created else status.HTTP_200_OK,
        )


class ContractTemplateVariantEditSessionEndpoint(BaseAPIView):
    @allow_permission([ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def post(self, request, slug, variant_id):
        variant = ContractTemplateVariant.objects.select_related("source_asset", "workspace").get(
            id=variant_id,
            workspace__slug=slug,
        )
        try:
            backup = _create_asset(
                workspace=variant.workspace,
                user=request.user,
                key=_asset_key(variant.workspace_id, "edit-backups", "docx"),
                name=f"backup-{(variant.source_asset.attributes or {}).get('name', str(variant.id))}",
                mime_type=DOCX_MIME,
                content=_read_asset(variant.source_asset),
                entity_type=FileAsset.EntityTypeContext.CONTRACT_REVISION,
            )
            backup.entity_identifier = f"contract-edit-backup:{variant.id}"
            backup.save(update_fields=["entity_identifier", "updated_at"])
        except Exception as exc:
            log_exception(exc)
            return Response({"error": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        return Response({"backup_asset_id": backup.id}, status=status.HTTP_201_CREATED)

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def patch(self, request, slug, variant_id):
        variant = ContractTemplateVariant.objects.select_related("source_asset", "workspace", "template").get(
            id=variant_id,
            workspace__slug=slug,
        )
        backup = FileAsset.objects.filter(
            id=request.data.get("backup_asset_id"),
            workspace=variant.workspace,
            user=request.user,
            entity_identifier=f"contract-edit-backup:{variant.id}",
            is_deleted=False,
        ).first()
        if not backup:
            return Response({"error": "Edit backup not found"}, status=status.HTTP_404_NOT_FOUND)

        action = str(request.data.get("action") or "").upper()
        if action not in {"DISCARD", "OVERWRITE", "NEW_REVISION", "NEW_VARIANT"}:
            return Response({"error": "Invalid edit action"}, status=status.HTTP_400_BAD_REQUEST)
        name = str(request.data.get("name") or "").strip()[:255]
        if action in {"NEW_REVISION", "NEW_VARIANT"} and not name:
            return Response({"error": "A name is required"}, status=status.HTTP_400_BAD_REQUEST)

        revision = None
        result_variant = variant
        try:
            backup_bytes = _read_asset(backup)
            if action == "DISCARD":
                _overwrite_asset_content(variant.source_asset, backup_bytes)
            elif action == "NEW_REVISION":
                revision, _ = _get_or_create_template_revision(variant, request.user, name=name)
            elif action == "NEW_VARIANT":
                edited_bytes = _read_asset(variant.source_asset)
                source_asset = _create_asset(
                    workspace=variant.workspace,
                    user=request.user,
                    key=_asset_key(variant.workspace_id, "variants", "docx"),
                    name=f"{name}.docx",
                    mime_type=DOCX_MIME,
                    content=edited_bytes,
                    entity_type=FileAsset.EntityTypeContext.CONTRACT_TEMPLATE,
                )
                result_variant = ContractTemplateVariant.objects.create(
                    workspace=variant.workspace,
                    template=variant.template,
                    name=name,
                    source_asset=source_asset,
                    signature_blueprint=variant.signature_blueprint,
                    signature_blueprint_layout=variant.signature_blueprint_layout,
                    recipient_blueprint=variant.recipient_blueprint,
                    authoring_settings=variant.authoring_settings,
                    created_by=request.user,
                )
                revision, _ = _get_or_create_template_revision(result_variant, request.user, source_bytes=edited_bytes)
                _overwrite_asset_content(variant.source_asset, backup_bytes)
            _dispose_edit_backup(backup)
        except Exception as exc:
            log_exception(exc)
            return Response({"error": str(exc)}, status=status.HTTP_400_BAD_REQUEST)

        template = ContractTemplate.objects.prefetch_related(
            "variants__source_asset", "variants__revisions__source_asset", "variants__revisions__pdf_asset"
        ).get(id=variant.template_id)
        return Response(
            {
                "template": ContractTemplateSerializer(template).data,
                "variant_id": result_variant.id,
                "revision_id": revision.id if revision else None,
                "action": action,
            }
        )


class ContractTemplateVariantSchemaEndpoint(BaseAPIView):
    @allow_permission([ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def get(self, request, slug, variant_id):
        variant = ContractTemplateVariant.objects.select_related("source_asset", "template").get(
            id=variant_id, workspace__slug=slug
        )
        revision_id = request.query_params.get("revision_id")
        if revision_id:
            revision = ContractTemplateRevision.objects.get(id=revision_id, variant=variant)
            source_bytes = _read_asset(revision.source_asset)
            content_sha256 = revision.content_sha256
            schema = _revision_schema(revision)
            _, _, compatibility = _manual_blueprint_for_revision(variant, revision)
            source = {"kind": "REVISION", "revision_id": revision.id, "revision": revision.revision}
        else:
            source_bytes = _read_asset(variant.source_asset)
            content_sha256 = hashlib.sha256(source_bytes).hexdigest()
            schema = analyse_docx_variables(source_bytes)
            revision = ContractTemplateRevision.objects.filter(variant=variant, content_sha256=content_sha256).first()
            if revision:
                _, _, compatibility = _manual_blueprint_for_revision(variant, revision)
            elif (variant.signature_blueprint_layout or {}).get("content_sha256") == content_sha256:
                compatibility = "COMPATIBLE"
            elif variant.signature_blueprint:
                compatibility = "REQUIRES_REVIEW"
            else:
                compatibility = "NONE"
            source = {
                "kind": "CURRENT",
                "revision_id": revision.id if revision else None,
                "revision": revision.revision if revision else None,
            }
        revisions = variant.revisions.select_related("source_asset", "pdf_asset").order_by("-revision")
        return Response(
            {
                "variant_id": variant.id,
                "content_sha256": content_sha256,
                "source": source,
                "schema": schema,
                "manual_fields_status": compatibility,
                "manual_field_count": len(variant.signature_blueprint or []),
                "revisions": ContractTemplateRevisionSerializer(revisions, many=True).data,
            }
        )


class ContractSignatureRequestsEndpoint(BaseAPIView):
    @allow_permission([ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def get(self, request, slug):
        requests_qs = (
            ContractSignatureRequest.objects.filter(
                workspace__slug=slug,
                authoring_mode=ContractSignatureRequest.AuthoringMode.DOCUMENT,
            )
            .select_related(
                "revision",
                "revision__variant",
                "rendered_source_asset",
                "rendered_pdf_asset",
                "signed_asset",
                "analysis_contract",
            )
            .prefetch_related("signers")
        )
        return Response(ContractSignatureRequestSerializer(requests_qs, many=True).data)

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def post(self, request, slug):
        variant = ContractTemplateVariant.objects.select_related("source_asset", "workspace", "template").get(
            id=request.data.get("variant_id"),
            workspace__slug=slug,
        )
        title = str(request.data.get("title") or variant.template.name).strip()
        authoring_mode = str(request.data.get("authoring_mode") or "DOCUMENT").upper()
        if authoring_mode not in ContractSignatureRequest.AuthoringMode.values:
            return Response({"error": "Invalid authoring mode"}, status=status.HTTP_400_BAD_REQUEST)
        try:
            revision_id = request.data.get("revision_id")
            if revision_id:
                revision = ContractTemplateRevision.objects.select_related("source_asset", "pdf_asset").get(
                    id=revision_id, variant=variant
                )
            else:
                revision, _ = _get_or_create_template_revision(variant, request.user)

            source_bytes = _read_asset(revision.source_asset)
            schema = _revision_schema(revision)
            variable_values = request.data.get("variable_values")
            variable_values = variable_values if isinstance(variable_values, dict) else {}
            variable_values = {str(key)[:100]: str(value)[:5000] for key, value in variable_values.items()}
            omitted_variable_keys = request.data.get("omitted_variable_keys")
            omitted_variable_keys = omitted_variable_keys if isinstance(omitted_variable_keys, list) else []
            omitted_variable_keys = [str(key)[:100] for key in omitted_variable_keys[:100]]
            supplied_recipients = request.data.get("recipients")
            supplied_recipients = supplied_recipients if isinstance(supplied_recipients, list) else []

            if authoring_mode == ContractSignatureRequest.AuthoringMode.TEMPLATE:
                omitted_variable_keys = []
                variable_values = {
                    item["key"]: variable_values.get(item["key"]) or f"[{item['label']}]"
                    for item in schema.get("variables") or []
                }
            else:
                for semantic_recipient in schema.get("recipients") or []:
                    index = semantic_recipient["index"]
                    provided = supplied_recipients[index] if index < len(supplied_recipients) else {}
                    if semantic_recipient.get("requires_name") and not str(provided.get("name") or "").strip():
                        raise ValueError(f"Missing name for Firmante {index + 1}")
                    if semantic_recipient.get("requires_email") and "@" not in str(provided.get("email") or ""):
                        raise ValueError(f"Missing valid email for Firmante {index + 1}")

            manual_blueprint, recipient_blueprint, manual_status = _manual_blueprint_for_revision(variant, revision)
            sample_recipients = _prepare_recipients(
                schema=schema,
                supplied=supplied_recipients,
                blueprint=recipient_blueprint,
                fields=[],
                authoring_mode=authoring_mode,
            )
            rendered_docx, marker_fields, _ = render_docx_variables(
                source_bytes,
                variable_values,
                sample_recipients,
                omitted_keys=omitted_variable_keys,
            )
            pdf_bytes = convert_to_pdf(rendered_docx, f"{title}.docx")
            if not pdf_bytes:
                raise RuntimeError("Collabora could not convert the completed Word file to PDF")
            pdf_bytes, semantic_fields = locate_and_remove_pdf_markers(pdf_bytes, marker_fields)
            layout_signature = _pdf_layout_signature(pdf_bytes)

            manual_blueprint = [
                field for field in manual_blueprint if not (field.get("fieldMeta") or {}).get("templateVariable")
            ]
            reusable_manual_fields = _blueprint_for_layout(
                manual_blueprint,
                revision.signature_blueprint_layout or revision.layout_signature,
                layout_signature,
            )
            combined_fields = [*reusable_manual_fields, *semantic_fields]
            warnings = []
            if manual_status == "REQUIRES_REVIEW":
                warnings.append(
                    "El Word cambió desde la última configuración. Los campos manuales no se reutilizaron; "
                    "los campos con variables sí se recalcularon."
                )
            elif manual_blueprint and not reusable_manual_fields:
                warnings.append(
                    "La paginación cambió y los campos manuales se descartaron para evitar posiciones incorrectas."
                )
            elif reusable_manual_fields and (schema.get("variables") or []):
                warnings.append(
                    "Revisa los campos manuales: los valores insertados pueden desplazar texto aunque "
                    "la paginación coincida."
                )

            recipients = _prepare_recipients(
                schema=schema,
                supplied=supplied_recipients,
                blueprint=recipient_blueprint,
                fields=combined_fields,
                authoring_mode=authoring_mode,
            )
            rendered_source_asset = _create_asset(
                workspace=variant.workspace,
                user=request.user,
                key=_asset_key(variant.workspace_id, "rendered", "docx"),
                name=f"{title}.docx",
                mime_type=DOCX_MIME,
                content=rendered_docx,
                entity_type=FileAsset.EntityTypeContext.CONTRACT_REVISION,
            )
            rendered_pdf_asset = _create_asset(
                workspace=variant.workspace,
                user=request.user,
                key=_asset_key(variant.workspace_id, "unsigned", "pdf"),
                name=f"{title}.pdf",
                mime_type="application/pdf",
                content=pdf_bytes,
                entity_type=FileAsset.EntityTypeContext.CONTRACT_UNSIGNED,
            )
            with transaction.atomic():
                signature_request = ContractSignatureRequest.objects.create(
                    workspace=variant.workspace,
                    revision=revision,
                    rendered_source_asset=rendered_source_asset,
                    rendered_pdf_asset=rendered_pdf_asset,
                    title=title,
                    authoring_mode=authoring_mode,
                    status=ContractSignatureRequest.Status.READY,
                    recipients=recipients,
                    fields=combined_fields,
                    authoring_settings=_normalise_authoring_settings(
                        revision.authoring_settings or variant.authoring_settings
                    ),
                    variable_values=variable_values,
                    preparation_warnings=warnings,
                    rendered_layout_signature=layout_signature,
                    created_by=request.user,
                )
        except Exception as exc:
            log_exception(exc)
            return Response({"error": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        return Response(ContractSignatureRequestSerializer(signature_request).data, status=status.HTTP_201_CREATED)

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def delete(self, request, slug):
        return _delete_signature_requests_from_payload(request, slug)


class ContractSignatureRequestsDeleteEndpoint(BaseAPIView):
    """Action endpoint for clients/proxies that do not support DELETE bodies."""

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def post(self, request, slug):
        return _delete_signature_requests_from_payload(request, slug)


class ContractSignatureRequestDetailEndpoint(BaseAPIView):
    @allow_permission([ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def get(self, request, slug, request_id):
        signature_request = (
            ContractSignatureRequest.objects.select_related("revision", "signed_asset", "analysis_contract")
            .prefetch_related("signers")
            .get(id=request_id, workspace__slug=slug)
        )
        if signature_request.documenso_envelope_id:
            try:
                envelope = DocumensoClient().get_envelope(signature_request.documenso_envelope_id)
                _attach_envelope_progress(signature_request, envelope)
            except DocumensoError as exc:
                signature_request._signing_details = {
                    "status": signature_request.status,
                    "recipients": [],
                    "fields": [],
                    "error": str(exc),
                }
        return Response(ContractSignatureRequestSerializer(signature_request).data)

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def patch(self, request, slug, request_id):
        signature_request = ContractSignatureRequest.objects.select_related("revision").get(
            id=request_id, workspace__slug=slug
        )
        if signature_request.status != ContractSignatureRequest.Status.READY:
            return Response({"error": "Only a ready request can be edited"}, status=status.HTTP_409_CONFLICT)
        try:
            recipients = _normalise_authoring_draft(request.data.get("recipients"))
            authoring_settings = _normalise_authoring_settings(
                request.data.get("authoring_settings", signature_request.authoring_settings)
            )
        except (TypeError, ValueError) as exc:
            return Response({"error": str(exc)}, status=status.HTTP_400_BAD_REQUEST)

        signature_request.recipients = recipients
        signature_request.fields = [
            {**field, "recipient_index": index}
            for index, recipient in enumerate(recipients)
            for field in recipient["fields"]
        ]
        signature_request.authoring_settings = authoring_settings
        if "title" in request.data:
            signature_request.title = str(request.data.get("title") or signature_request.title).strip()[:500]
        signature_request.error = None
        with transaction.atomic():
            signature_request.save(
                update_fields=["title", "recipients", "fields", "authoring_settings", "error", "updated_at"]
            )
            if signature_request.authoring_mode == ContractSignatureRequest.AuthoringMode.TEMPLATE:
                variant = signature_request.revision.variant
                blueprint_layout = _layout_with_content(
                    signature_request.rendered_layout_signature,
                    signature_request.revision.content_sha256,
                )
                variant.signature_blueprint = signature_request.fields
                variant.signature_blueprint_layout = blueprint_layout
                recipient_blueprint = [
                    {
                        "placeholderLabel": recipient.get("placeholderLabel")
                        or recipient.get("name")
                        or f"Recipient {index + 1}",
                        "role": recipient["role"],
                        "signingOrder": index + 1,
                        "actionAuth": recipient.get("actionAuth") or [],
                    }
                    for index, recipient in enumerate(recipients)
                ]
                variant.recipient_blueprint = recipient_blueprint
                variant.authoring_settings = authoring_settings
                variant.save(
                    update_fields=[
                        "signature_blueprint",
                        "signature_blueprint_layout",
                        "recipient_blueprint",
                        "authoring_settings",
                        "updated_at",
                    ]
                )
                signature_request.revision.signature_blueprint = signature_request.fields
                signature_request.revision.signature_blueprint_layout = blueprint_layout
                signature_request.revision.recipient_blueprint = recipient_blueprint
                signature_request.revision.authoring_settings = authoring_settings
                signature_request.revision.variable_schema = _revision_schema(signature_request.revision)
                signature_request.revision.save(
                    update_fields=[
                        "signature_blueprint",
                        "signature_blueprint_layout",
                        "recipient_blueprint",
                        "authoring_settings",
                        "variable_schema",
                        "updated_at",
                    ]
                )
        return Response(ContractSignatureRequestSerializer(signature_request).data)

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def delete(self, request, slug, request_id):
        if request.data.get("confirm") is not True:
            return Response({"error": "Deletion must be confirmed"}, status=status.HTTP_400_BAD_REQUEST)
        signature_request = ContractSignatureRequest.objects.select_related(
            "rendered_source_asset",
            "rendered_pdf_asset",
            "signed_asset",
            "analysis_contract__thumbnail_asset",
        ).get(
            id=request_id,
            workspace__slug=slug,
            authoring_mode=ContractSignatureRequest.AuthoringMode.DOCUMENT,
        )
        try:
            result = _delete_signature_requests(
                [signature_request],
                delete_files=bool(request.data.get("delete_files")),
                delete_analysis=bool(request.data.get("delete_analysis")),
            )
        except ValueError as exc:
            return Response({"error": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        except RuntimeError as exc:
            log_exception(exc)
            return Response({"error": str(exc)}, status=status.HTTP_502_BAD_GATEWAY)
        return Response(result, status=status.HTTP_200_OK)


class ContractSignatureRequestPdfEndpoint(BaseAPIView):
    @allow_permission([ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def get(self, request, slug, request_id):
        signature_request = ContractSignatureRequest.objects.select_related(
            "revision__pdf_asset", "rendered_pdf_asset"
        ).get(id=request_id, workspace__slug=slug)
        asset = signature_request.rendered_pdf_asset or signature_request.revision.pdf_asset
        return Response(
            {
                "url": S3Storage.for_asset(asset, request=request).generate_presigned_url(
                    asset.asset.name,
                    filename=(asset.attributes or {}).get("name"),
                )
            }
        )


class ContractSignatureRequestSendEndpoint(BaseAPIView):
    @allow_permission([ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def post(self, request, slug, request_id):
        signature_request = ContractSignatureRequest.objects.select_related(
            "revision__pdf_asset", "rendered_pdf_asset"
        ).get(id=request_id, workspace__slug=slug)
        if signature_request.status != ContractSignatureRequest.Status.READY:
            return Response({"error": "Only a ready request can be sent"}, status=status.HTTP_409_CONFLICT)
        if signature_request.authoring_mode != ContractSignatureRequest.AuthoringMode.DOCUMENT:
            return Response({"error": "Template mappings cannot be sent"}, status=status.HTTP_409_CONFLICT)
        try:
            authoring_settings = _normalise_authoring_settings(
                request.data.get("authoring_settings", signature_request.authoring_settings)
            )
            submitted_recipients = _normalise_authoring_payload(request.data.get("recipients"), authoring_settings)
            if any(recipient["role"] == "ASSISTANT" for recipient in submitted_recipients):
                authoring_settings["signingOrder"] = "SEQUENTIAL"
            client = DocumensoClient()
            if signature_request.documenso_envelope_id:
                recipients = signature_request.recipients or submitted_recipients
                envelope = client.get_envelope(signature_request.documenso_envelope_id)
            else:
                recipients = submitted_recipients
                pdf_bytes = _read_asset(signature_request.rendered_pdf_asset or signature_request.revision.pdf_asset)
                envelope = client.create_envelope(
                    title=signature_request.title,
                    external_id=str(signature_request.id),
                    pdf_bytes=pdf_bytes,
                    recipients=recipients,
                    authoring_settings=authoring_settings,
                )
            envelope_id = envelope["id"]
            items = envelope.get("envelopeItems") or envelope.get("items") or []
            if not items:
                raise DocumensoError("Documenso did not return an envelope item")
            doc_recipients = envelope.get("recipients") or []
            with transaction.atomic():
                signature_request.recipients = recipients
                signature_request.fields = [
                    {**field, "recipient_index": index}
                    for index, recipient in enumerate(recipients)
                    for field in recipient["fields"]
                ]
                signature_request.documenso_envelope_id = envelope_id
                signature_request.documenso_envelope_item_id = items[0]["id"]
                signature_request.error = None
                signature_request.authoring_settings = authoring_settings
                signature_request.save()
                signature_request.signers.all().delete()
                for index, recipient in enumerate(recipients):
                    resolved = next(
                        (item for item in doc_recipients if item.get("email") == recipient["email"]),
                        {},
                    )
                    ContractSigner.objects.create(
                        workspace=signature_request.workspace,
                        signature_request=signature_request,
                        name=recipient["name"],
                        email=recipient["email"],
                        role=recipient["role"],
                        signing_order=recipient["signingOrder"],
                        status=ContractSigner.Status.NOT_SENT,
                        documenso_recipient_id=resolved.get("id"),
                    )
            remote_status = None
            try:
                client.distribute_envelope(envelope_id)
            except DocumensoError:
                # Distribution can succeed remotely while its HTTP response is
                # interrupted. Reconcile before exposing a retry to avoid
                # creating or sending a duplicate envelope.
                envelope = client.get_envelope(envelope_id)
                remote_status = envelope.get("status")
                if remote_status not in {"PENDING", "COMPLETED"}:
                    raise
            if remote_status == "COMPLETED":
                _complete_signature_request(signature_request)
                return Response(ContractSignatureRequestSerializer(signature_request).data)
            signature_request.status = ContractSignatureRequest.Status.PENDING
            signature_request.sent_at = signature_request.sent_at or timezone.now()
            signature_request.error = None
            signature_request.save(update_fields=["status", "sent_at", "error", "updated_at"])
            signature_request.signers.update(status=ContractSigner.Status.SENT)
        except (ValueError, DocumensoError, RuntimeError) as exc:
            signature_request.error = {"message": str(exc)}
            signature_request.save(update_fields=["error", "updated_at"])
            return Response({"error": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        return Response(ContractSignatureRequestSerializer(signature_request).data)


class ContractSignatureRequestLinksEndpoint(BaseAPIView):
    @allow_permission([ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def get(self, request, slug, request_id):
        signature_request = ContractSignatureRequest.objects.get(id=request_id, workspace__slug=slug)
        if not signature_request.documenso_envelope_id:
            return Response({"error": "The contract has not been distributed"}, status=status.HTTP_409_CONFLICT)
        try:
            envelope = DocumensoClient().get_envelope(signature_request.documenso_envelope_id)
        except DocumensoError as exc:
            return Response({"error": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        return Response({"links": _signing_links_from_envelope(envelope)})


def _complete_signature_request(signature_request):
    if signature_request.signed_asset_id:
        return signature_request
    client = DocumensoClient()
    signed_bytes = client.download_signed_item(signature_request.documenso_envelope_item_id)
    signed_asset = _create_asset(
        workspace=signature_request.workspace,
        user=signature_request.created_by,
        key=_asset_key(signature_request.workspace_id, "signed", "pdf"),
        name=f"{signature_request.title}-signed.pdf",
        mime_type="application/pdf",
        content=signed_bytes,
        # Final PDFs participate in the existing file-library/analysis UI;
        # the dedicated bucket/purpose remains recorded in storage_metadata.
        entity_type=FileAsset.EntityTypeContext.WORKSPACE_FILE_LIBRARY,
    )
    analysis_contract = ensure_contract_for_asset(signed_asset, user=signature_request.created_by)
    signature_request.signed_asset = signed_asset
    signature_request.analysis_contract = analysis_contract
    signature_request.status = ContractSignatureRequest.Status.COMPLETED
    signature_request.completed_at = timezone.now()
    signature_request.error = None
    signature_request.save()
    signature_request.signers.exclude(role__in=["CC", "VIEWER"]).update(status=ContractSigner.Status.SIGNED)
    return signature_request


def _sync_signers_from_webhook(signature_request, event_payload):
    recipients = event_payload.get("recipients") or event_payload.get("Recipient") or []
    for recipient in recipients:
        email = recipient.get("email")
        if not email:
            continue
        signing_status = recipient.get("signingStatus")
        read_status = recipient.get("readStatus")
        send_status = recipient.get("sendStatus")
        signer_status = None
        if signing_status == "REJECTED":
            signer_status = ContractSigner.Status.REJECTED
        elif signing_status == "SIGNED":
            signer_status = ContractSigner.Status.SIGNED
        elif read_status == "OPENED":
            signer_status = ContractSigner.Status.OPENED
        elif send_status == "SENT":
            signer_status = ContractSigner.Status.SENT
        if signer_status:
            signature_request.signers.filter(email=email).update(status=signer_status)


class DocumensoWebhookEndpoint(BaseAPIView):
    permission_classes = [AllowAny]
    authentication_classes = []

    def post(self, request):
        expected = settings.DOCUMENSO_WEBHOOK_SECRET or ""
        received = request.headers.get("X-Documenso-Secret", "")
        if not expected:
            return Response({"error": "Webhook is not configured"}, status=status.HTTP_503_SERVICE_UNAVAILABLE)
        if not hmac.compare_digest(received, expected):
            return Response({"error": "Invalid webhook secret"}, status=status.HTTP_401_UNAUTHORIZED)

        payload = request.data if isinstance(request.data, dict) else {}
        event_type = payload.get("event") or ""
        event_payload = payload.get("payload") or {}
        raw = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str).encode()
        event_key = hashlib.sha256(raw).hexdigest()
        event, created = ContractWebhookEvent.objects.get_or_create(
            event_key=event_key,
            defaults={"event_type": event_type, "payload": payload},
        )
        if not created and event.processed_at:
            return Response({"received": True, "duplicate": True})

        external_id = event_payload.get("externalId")
        envelope_id = event_payload.get("envelopeId") or event_payload.get("id")
        signature_request = None
        if external_id:
            try:
                signature_request_id = UUID(str(external_id))
            except (TypeError, ValueError):
                signature_request_id = None
            if signature_request_id:
                signature_request = ContractSignatureRequest.objects.filter(id=signature_request_id).first()
        if not signature_request and envelope_id:
            signature_request = ContractSignatureRequest.objects.filter(documenso_envelope_id=str(envelope_id)).first()

        try:
            if signature_request:
                _sync_signers_from_webhook(signature_request, event_payload)
                if event_type == "DOCUMENT_COMPLETED":
                    _complete_signature_request(signature_request)
                elif event_type == "DOCUMENT_REJECTED":
                    signature_request.status = ContractSignatureRequest.Status.REJECTED
                    signature_request.save(update_fields=["status", "updated_at"])
                elif event_type == "DOCUMENT_CANCELLED":
                    signature_request.status = ContractSignatureRequest.Status.CANCELLED
                    signature_request.save(update_fields=["status", "updated_at"])
            event.processed_at = timezone.now()
            event.error = None
            event.save(update_fields=["processed_at", "error", "updated_at"])
        except Exception as exc:
            log_exception(exc)
            event.error = str(exc)
            event.save(update_fields=["error", "updated_at"])
            return Response({"error": "Webhook processing failed"}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)
        return Response({"received": True})


class ContractSignatureRequestSyncEndpoint(BaseAPIView):
    """Manual recovery path when a webhook was delayed or misconfigured."""

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def post(self, request, slug, request_id):
        signature_request = ContractSignatureRequest.objects.get(id=request_id, workspace__slug=slug)
        if not signature_request.documenso_envelope_id:
            return Response({"error": "Request has no Documenso envelope"}, status=status.HTTP_409_CONFLICT)
        try:
            envelope = DocumensoClient().get_envelope(signature_request.documenso_envelope_id)
            _attach_envelope_progress(signature_request, envelope)
            remote_status = envelope.get("status")
            if remote_status == "COMPLETED":
                _complete_signature_request(signature_request)
            elif remote_status in {"REJECTED", "CANCELLED", "PENDING"}:
                signature_request.status = remote_status
                signature_request.save(update_fields=["status", "updated_at"])
        except DocumensoError as exc:
            return Response({"error": str(exc)}, status=status.HTTP_502_BAD_GATEWAY)
        return Response(ContractSignatureRequestSerializer(signature_request).data)
