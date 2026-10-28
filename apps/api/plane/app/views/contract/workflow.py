# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

import hashlib
import hmac
import re
from datetime import timedelta
from io import BytesIO
from uuid import UUID, uuid4

import fitz
from django.conf import settings
from django.db import IntegrityError, transaction
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
    MissingValueError,
    analyse_docx_variables,
    analyse_docx_warnings,
    format_variable_value,
    locate_and_remove_pdf_markers,
    render_docx_variables,
    sample_value,
    schema_summary,
)
from plane.settings.storage import S3Storage
from plane.utils.exception_logger import log_exception

from ..base import BaseAPIView
from ..file_library.base import FileLibraryBaseView
from ..file_library.collabora import DOCX_MIME, convert_to_pdf, mark_content_changed
from .base import ensure_contract_for_asset

MAX_TEMPLATE_BYTES = 25 * 1024 * 1024
PDF_CACHE_PREFIX = "contract-pdf:"
DRAFT_LOCK_SECONDS = 90


class ContractInputError(ValueError):
    """A user-fixable problem with a stable code the web maps to i18n."""

    def __init__(self, code, detail=None, http_status=status.HTTP_400_BAD_REQUEST, **params):
        super().__init__(detail or code)
        self.code = code
        self.detail = detail
        self.http_status = http_status
        self.params = params


def _error(code, http_status=status.HTTP_400_BAD_REQUEST, detail=None, **params):
    body = {"error": code, **params}
    if detail:
        body["detail"] = detail
    return Response(body, status=http_status)


def _input_error_response(exc):
    return _error(exc.code, exc.http_status, exc.detail, **exc.params)


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
# Defaults only fill keys a request does not have; stored settings win.
DEFAULT_AUTHORING_SETTINGS = {
    "subject": "",
    "message": "",
    "timezone": "America/Monterrey",
    "dateFormat": "dd/MM/yyyy",
    "redirectUrl": "",
    "language": "es",
    "identity_verification_required": False,
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


def _create_asset(*, workspace, user, key, name, mime_type, content, entity_type, track=None, entity_identifier=None):
    # This upload is performed by Django, not by the browser. It must always
    # use the internal S3 endpoint even when an HTTP request is available.
    storage = _storage()
    if not storage.upload_file(BytesIO(content), key, content_type=mime_type):
        raise RuntimeError("Unable to upload contract file")
    if track is not None:
        track.append(key)
    metadata = storage.get_object_metadata(key) or {}
    metadata["bucket"] = _contract_bucket()
    metadata["purpose"] = entity_type
    return FileAsset.objects.create(
        workspace=workspace,
        user=user,
        asset=key,
        attributes={"name": name, "type": mime_type, "content_sha256": hashlib.sha256(content).hexdigest()},
        entity_type=entity_type,
        entity_identifier=entity_identifier,
        size=len(content),
        is_uploaded=True,
        storage_metadata=metadata,
    )


def _delete_uploaded(keys):
    """Remove objects uploaded by a step that then failed (no orphans)."""
    if not keys:
        return
    try:
        _storage().delete_files(list(keys))
    except Exception as exc:
        log_exception(exc)


def _pdf_from_cache(workspace_id, content_sha256):
    cached = (
        FileAsset.objects.filter(
            workspace_id=workspace_id,
            entity_identifier=f"{PDF_CACHE_PREFIX}{content_sha256}",
            is_uploaded=True,
            deleted_at__isnull=True,
        )
        .order_by("-created_at")
        .first()
    )
    if cached is None:
        revision = (
            ContractTemplateRevision.objects.filter(workspace_id=workspace_id, content_sha256=content_sha256)
            .select_related("pdf_asset")
            .first()
        )
        cached = revision.pdf_asset if revision else None
    if cached is None:
        return None, None
    try:
        return _read_asset(cached), cached
    except Exception as exc:
        log_exception(exc)
        return None, None


def _pdf_for_content(workspace, content, name, user=None, store=True, source_asset=None):
    """One Collabora conversion per content: look up by sha256, convert on a
    miss and (optionally) keep the result as a cache asset."""
    content_sha256 = hashlib.sha256(content).hexdigest()
    pdf_bytes, cached = _pdf_from_cache(workspace.id, content_sha256)
    if pdf_bytes is None:
        pdf_bytes = convert_to_pdf(content, name)
        if not pdf_bytes:
            return None
        if store:
            try:
                cached = _create_asset(
                    workspace=workspace,
                    user=user,
                    key=_asset_key(workspace.id, "pdf-cache", "pdf"),
                    name=f"{name.rsplit('.', 1)[0]}.pdf",
                    mime_type="application/pdf",
                    content=pdf_bytes,
                    entity_type=FileAsset.EntityTypeContext.CONTRACT_UNSIGNED,
                    entity_identifier=f"{PDF_CACHE_PREFIX}{content_sha256}",
                )
            except Exception as exc:
                log_exception(exc)
                cached = None
    if source_asset is not None and cached is not None:
        pointer = {"sha256": content_sha256, "asset_id": str(cached.id)}
        if (source_asset.attributes or {}).get("pdf_cache") != pointer:
            # Queryset update: leaves updated_at alone (WOPI uses it).
            FileAsset.objects.filter(id=source_asset.id).update(
                attributes={**(source_asset.attributes or {}), "pdf_cache": pointer}
            )
    return pdf_bytes


def _pdf_for_asset(asset):
    content = _read_asset(asset)
    name = (asset.attributes or {}).get("name", "document")
    mime_type = (asset.attributes or {}).get("type", "")
    if mime_type == "application/pdf" or name.lower().endswith(".pdf"):
        return content
    if name.lower().endswith(".docx"):
        return _pdf_for_content(asset.workspace, content, name, user=None, source_asset=asset)
    return None


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


def _create_revision(variant, user, source_bytes, name="", reuse_existing=False, track=None, pdf_bytes=None):
    """Create the next revision of a variant from `source_bytes`.

    The number is taken under a row lock on the variant, so concurrent saves
    cannot collide. With reuse_existing, a revision with the same content is
    returned instead (legacy "Usar"/"Guardar versión" behaviour); otherwise a
    new revision is always created and no existing one is renamed.
    Returns (revision, created). Raises ContractInputError on conversion.
    """
    content_sha256 = hashlib.sha256(source_bytes).hexdigest()
    if reuse_existing:
        existing = ContractTemplateRevision.objects.filter(variant=variant, content_sha256=content_sha256).first()
        if existing:
            return existing, False

    pdf_bytes = pdf_bytes or _pdf_for_content(
        variant.workspace,
        source_bytes,
        (variant.source_asset.attributes or {}).get("name", "contract.docx"),
        user=user,
        store=False,
    )
    if not pdf_bytes:
        raise ContractInputError("conversion_failed", "Collabora could not convert the Word template to PDF")
    layout_signature = _pdf_layout_signature(pdf_bytes)
    variable_schema = analyse_docx_variables(source_bytes)
    uploaded = [] if track is None else track
    try:
        with transaction.atomic():
            locked = ContractTemplateVariant.objects.select_for_update().get(id=variant.id)
            if reuse_existing:
                existing = ContractTemplateRevision.objects.filter(
                    variant=locked, content_sha256=content_sha256
                ).first()
                if existing:
                    return existing, False
            next_revision = (
                ContractTemplateRevision.objects.filter(variant=locked).aggregate(value=Max("revision"))["value"] or 0
            ) + 1
            source_asset = _create_asset(
                workspace=variant.workspace,
                user=user,
                key=_asset_key(variant.workspace_id, "template-versions", "docx"),
                name=f"{variant.template.name}-{locked.name}-v{next_revision}.docx",
                mime_type=DOCX_MIME,
                content=source_bytes,
                entity_type=FileAsset.EntityTypeContext.CONTRACT_REVISION,
                track=uploaded,
            )
            pdf_asset = _create_asset(
                workspace=variant.workspace,
                user=user,
                key=_asset_key(variant.workspace_id, "template-versions", "pdf"),
                name=f"{variant.template.name}-{locked.name}-v{next_revision}.pdf",
                mime_type="application/pdf",
                content=pdf_bytes,
                entity_type=FileAsset.EntityTypeContext.CONTRACT_UNSIGNED,
                track=uploaded,
            )
            blueprint_layout = locked.signature_blueprint_layout or {}
            blueprint_matches = blueprint_layout.get("content_sha256") == content_sha256
            revision = ContractTemplateRevision.objects.create(
                workspace=variant.workspace,
                variant=locked,
                revision=next_revision,
                name=str(name or "").strip()[:255],
                source_asset=source_asset,
                pdf_asset=pdf_asset,
                content_sha256=content_sha256,
                layout_signature=layout_signature,
                variable_schema=variable_schema,
                signature_blueprint=locked.signature_blueprint if blueprint_matches else [],
                signature_blueprint_layout=locked.signature_blueprint_layout if blueprint_matches else {},
                recipient_blueprint=locked.recipient_blueprint if blueprint_matches else [],
                authoring_settings=locked.authoring_settings if blueprint_matches else {},
                created_by=user,
            )
    except Exception:
        if track is None:
            _delete_uploaded(uploaded)
        raise
    return revision, True


def _get_or_create_template_revision(variant, user, source_bytes=None, name=""):
    # Legacy path (revisions POST, edit decision, "Usar" on the current
    # document): reuses a same-content revision and renames it when a name is
    # given. New flows call _create_revision directly and never rename.
    source_bytes = source_bytes if source_bytes is not None else _read_asset(variant.source_asset)
    content_sha256 = hashlib.sha256(source_bytes).hexdigest()
    existing = ContractTemplateRevision.objects.filter(variant=variant, content_sha256=content_sha256).first()
    if existing:
        if name and existing.name != name:
            existing.name = name
            existing.save(update_fields=["name", "updated_at"])
        return existing, False
    return _create_revision(variant, user, source_bytes, name=name, reuse_existing=True)


def _overwrite_asset_content(asset, content):
    storage = S3Storage.for_asset(asset)
    uploaded = storage.upload_file(
        BytesIO(content),
        asset.asset.name,
        content_type=(asset.attributes or {}).get("type", DOCX_MIME),
    )
    if not uploaded:
        raise RuntimeError("Unable to restore contract document")
    mark_content_changed(asset, content)


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
        internal_assets.extend([signature_request.rendered_source_asset, signature_request.rendered_pdf_asset])
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


def _rendered_variable_values(schema, values, omitted_keys, settings_map):
    """Values as they go into the Word file: defaults applied, optional
    blanks omitted, dates/numbers formatted. Raises MissingValueError."""
    rendered = {}
    for item in schema.get("variables") or []:
        key = item["key"]
        if key in omitted_keys:
            continue
        setting = settings_map.get(key) or {}
        raw = str(values.get(key) or "").strip()
        if not raw and setting.get("default"):
            raw = str(setting["default"]).strip()
        if not raw:
            if setting.get("required") is False:
                omitted_keys.append(key)
                continue
            raise MissingValueError(key, setting.get("label") or item["label"])
        rendered[key] = format_variable_value(raw, item.get("type"), setting)
    return rendered


def _open_template_sessions(revision):
    return ContractSignatureRequest.objects.filter(
        revision=revision,
        authoring_mode=ContractSignatureRequest.AuthoringMode.TEMPLATE,
        status=ContractSignatureRequest.Status.READY,
    ).exclude(metadata__contains={"superseded": True})


def _open_template_session(revision):
    return (
        _open_template_sessions(revision)
        .select_related("revision", "revision__variant", "revision__variant__template")
        .order_by("-updated_at")
        .first()
    )


def _manual_blueprint_for_revision(variant, revision):
    if revision.signature_blueprint:
        return revision.signature_blueprint, revision.recipient_blueprint, "COMPATIBLE"
    if (variant.signature_blueprint_layout or {}).get("content_sha256") == revision.content_sha256:
        return variant.signature_blueprint, variant.recipient_blueprint, "COMPATIBLE"
    if variant.signature_blueprint:
        return [], [], "REQUIRES_REVIEW"
    return [], [], "NONE"


def _prepare_recipients(*, schema, supplied, blueprint, fields, authoring_mode, variant=None):
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
        role_name = ((variant.recipient_roles or {}) if variant is not None else {}).get(str(index))
        placeholder = (
            provided.get("placeholderLabel") or role_name or saved.get("placeholderLabel") or f"Firmante {index + 1}"
        )
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
        "identity_verification_required",
    ):
        if key in raw:
            result[key] = bool(raw[key])
    if not any(result[key] for key in ("typedSignatureEnabled", "uploadSignatureEnabled", "drawSignatureEnabled")):
        raise ContractInputError("no_signature_type", "At least one signature type must be enabled")
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


VARIABLE_TYPES = {"text", "date", "number", "currency", "choice"}


def _normalise_variable_settings(value):
    if not isinstance(value, dict):
        raise ValueError("variable_settings must be an object")
    if len(value) > 500:
        raise ValueError("Too many variables")
    result = {}
    for key, raw in value.items():
        if not isinstance(raw, dict):
            continue
        item = {}
        for name, limit in (("label", 255), ("default", 5000), ("help", 1000)):
            if raw.get(name) not in (None, ""):
                item[name] = str(raw[name])[:limit]
        if raw.get("type") in VARIABLE_TYPES:
            item["type"] = raw["type"]
        if "required" in raw:
            item["required"] = bool(raw["required"])
        if raw.get("date_format") in {"long", "iso"}:
            item["date_format"] = raw["date_format"]
        # The template wrote this value in capitals ("JUAN PÉREZ"): keep it so
        if raw.get("case") == "upper":
            item["case"] = "upper"
        if isinstance(raw.get("options"), list):
            item["options"] = [str(option)[:255] for option in raw["options"][:100] if str(option).strip()]
        if item:
            result[str(key)[:100]] = item
    return result


def _normalise_recipient_roles(value):
    if not isinstance(value, dict):
        raise ValueError("recipient_roles must be an object")
    result = {}
    for key, role in value.items():
        try:
            index = int(key)
        except (TypeError, ValueError):
            raise ValueError("recipient_roles keys must be signer indexes")
        if 0 <= index < 50 and str(role or "").strip():
            result[str(index)] = str(role).strip()[:100]
    return result


def _role_label(variant, index, fallback=None):
    roles = (variant.recipient_roles or {}) if variant is not None else {}
    return roles.get(str(index)) or fallback or f"Firmante {index + 1}"


def _schema_for_display(schema, variant):
    """Copy of a schema with variable settings and role names applied.
    Classification is untouched; only labels and display hints change."""
    settings_map = variant.variable_settings or {}
    variables = []
    for item in schema.get("variables") or []:
        setting = settings_map.get(item["key"]) or {}
        variables.append(
            {
                **item,
                "label": setting.get("label") or item.get("label"),
                "type": setting.get("type") or item.get("type"),
                "required": setting.get("required", item.get("required", True)),
                "settings": setting,
            }
        )
    recipients = [
        {**item, "role_name": _role_label(variant, item["index"], item.get("label"))}
        for item in schema.get("recipients") or []
    ]
    return {**schema, "variables": variables, "recipients": recipients}


def _normalise_authoring_payload(recipients, authoring_settings=None):
    if not isinstance(recipients, list) or not recipients:
        raise ContractInputError("no_recipients", "At least one recipient is required")
    if len(recipients) > 50:
        raise ContractInputError("too_many_recipients", "A contract cannot have more than 50 recipients")
    result = []
    seen_emails = set()
    for index, recipient in enumerate(recipients):
        if not isinstance(recipient, dict):
            raise ContractInputError("invalid_recipient", f"Invalid recipient at position {index + 1}", index=index)
        email = str(recipient.get("email") or "").strip()
        name = str(recipient.get("name") or "").strip()
        role = str(recipient.get("role") or "SIGNER").upper()
        if not name:
            raise ContractInputError(
                "missing_signer", f"Invalid recipient at position {index + 1}", index=index, field="name"
            )
        if not email or "@" not in email:
            raise ContractInputError(
                "missing_signer", f"Invalid recipient at position {index + 1}", index=index, field="email"
            )
        if role not in ALLOWED_ROLES:
            raise ContractInputError("invalid_recipient", f"Invalid recipient at position {index + 1}", index=index)
        normalised_email = email.lower()
        if normalised_email in seen_emails:
            raise ContractInputError("duplicate_email", "Recipient emails must be unique", index=index)
        seen_emails.add(normalised_email)
        fields = recipient.get("fields") or []
        cleaned_fields = [_normalise_authoring_field(field, email) for field in fields]
        if role in {"CC", "VIEWER"}:
            cleaned_fields = []
        if role == "SIGNER" and not any(field["type"] == "SIGNATURE" for field in cleaned_fields):
            raise ContractInputError(
                "signer_without_signature", f"{email} requires at least one signature field", index=index
            )
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
        raise ContractInputError("assistant_last", "An assistant cannot be the last recipient")
    return result


def _normalise_authoring_draft(recipients):
    """Sanitise an in-progress authoring payload without requiring completion.

    Drafts intentionally allow empty recipient names/emails and signers without
    fields. The stricter `_normalise_authoring_payload` remains the gate before
    creating and distributing a Documenso envelope.
    """

    if not isinstance(recipients, list):
        raise ValueError("Recipients must be a list")
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


class ContractTemplatesEndpoint(FileLibraryBaseView):
    @allow_permission([ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def get(self, request, slug):
        templates = (
            ContractTemplate.objects.filter(workspace__slug=slug, is_active=True)
            .prefetch_related(
                "variants__source_asset",
                "variants__revisions",
                "variants__draft_asset",
                "variants__draft_started_by",
                "variants__draft_active_by",
            )
            .order_by("name")
        )
        return Response(ContractTemplateSerializer(templates, many=True).data)

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def post(self, request, slug):
        upload = request.FILES.get("file")
        name = str(request.data.get("name") or "").strip()[:255]
        description = str(request.data.get("description") or "").strip()
        if not upload:
            return _error("invalid_docx", detail="A .docx file is required")
        if not name:
            return _error("name_required", detail="name is required")
        if upload.size and upload.size > MAX_TEMPLATE_BYTES:
            return _error("file_too_large", limit_mb=MAX_TEMPLATE_BYTES // (1024 * 1024))
        if not upload.name.lower().endswith(".docx") or upload.read(4)[:2] != b"PK":
            return _error("invalid_docx", detail="Only valid .docx files are accepted")
        upload.seek(0)
        content = upload.read()
        if len(content) > MAX_TEMPLATE_BYTES:
            return _error("file_too_large", limit_mb=MAX_TEMPLATE_BYTES // (1024 * 1024))
        workspace = Workspace.objects.get(slug=slug)
        if ContractTemplate.objects.filter(workspace=workspace, name=name).exists():
            return _error("template_name_taken", status.HTTP_409_CONFLICT)
        try:
            schema = analyse_docx_variables(content)
            warnings = analyse_docx_warnings(content, schema)
        except Exception as exc:
            log_exception(exc)
            return _error("invalid_docx", detail="The Word file could not be read")
        pdf_bytes = _pdf_for_content(workspace, content, upload.name, user=request.user, store=False)
        if not pdf_bytes:
            return _error("conversion_failed")

        # Validated: upload and create rows in one transaction; any failure
        # rolls the rows back and removes what was uploaded.
        uploaded = []
        try:
            with transaction.atomic():
                asset = _create_asset(
                    workspace=workspace,
                    user=request.user,
                    key=_asset_key(workspace.id, "templates", "docx"),
                    name=upload.name,
                    mime_type=DOCX_MIME,
                    content=content,
                    entity_type=FileAsset.EntityTypeContext.CONTRACT_TEMPLATE,
                    track=uploaded,
                )
                template = ContractTemplate.objects.create(
                    workspace=workspace,
                    name=name,
                    description=description,
                    created_by=request.user,
                )
                variant = ContractTemplateVariant.objects.create(
                    workspace=workspace,
                    template=template,
                    name="Principal",
                    source_asset=asset,
                    is_default=True,
                    created_by=request.user,
                )
                # New templates start with revision 1, usable right away.
                revision, _ = _create_revision(variant, request.user, content, track=uploaded, pdf_bytes=pdf_bytes)
        except IntegrityError:
            _delete_uploaded(uploaded)
            return _error("template_name_taken", status.HTTP_409_CONFLICT)
        except ContractInputError as exc:
            _delete_uploaded(uploaded)
            return _input_error_response(exc)
        except Exception as exc:
            log_exception(exc)
            _delete_uploaded(uploaded)
            return _error("upload_failed")
        template = ContractTemplate.objects.prefetch_related(
            "variants__source_asset", "variants__revisions__source_asset", "variants__revisions__pdf_asset"
        ).get(id=template.id)
        data = ContractTemplateSerializer(template).data
        data["variant_id"] = str(variant.id)
        data["revision_id"] = str(revision.id)
        data["schema"] = schema
        data["summary"] = schema_summary(schema)
        data["warnings"] = warnings
        return Response(data, status=status.HTTP_201_CREATED)


class ContractTemplateDetailEndpoint(FileLibraryBaseView):
    @allow_permission([ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def get(self, request, slug, template_id):
        template = (
            ContractTemplate.objects.filter(id=template_id, workspace__slug=slug, is_active=True)
            .prefetch_related(
                "variants__source_asset",
                "variants__revisions__source_asset",
                "variants__revisions__pdf_asset",
                "variants__draft_asset",
                "variants__draft_started_by",
                "variants__draft_active_by",
            )
            .get()
        )
        return Response(ContractTemplateSerializer(template).data)

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def patch(self, request, slug, template_id):
        template = ContractTemplate.objects.get(id=template_id, workspace__slug=slug, is_active=True)
        if "name" in request.data:
            name = str(request.data.get("name") or "").strip()[:255]
            if not name:
                return Response({"error": "name cannot be empty"}, status=status.HTTP_400_BAD_REQUEST)
            taken = (
                ContractTemplate.objects.filter(workspace=template.workspace, name=name)
                .exclude(id=template.id)
                .exists()
            )
            if taken:
                return Response({"error": "template_name_taken"}, status=status.HTTP_409_CONFLICT)
            template.name = name
        if "description" in request.data:
            template.description = str(request.data.get("description") or "").strip()
        template.save(update_fields=["name", "description", "updated_at"])
        template = (
            ContractTemplate.objects.filter(id=template.id)
            .prefetch_related("variants__source_asset", "variants__revisions")
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


class ContractAssetThumbnailEndpoint(FileLibraryBaseView):
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
            pdf_bytes = _pdf_for_asset(asset)
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


class ContractAssetPdfPreviewEndpoint(FileLibraryBaseView):
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
            pdf_bytes = _pdf_for_asset(asset)
        except Exception as exc:
            log_exception(exc)
            pdf_bytes = None

        if not pdf_bytes:
            return Response({"error": "Preview is not available"}, status=status.HTTP_422_UNPROCESSABLE_ENTITY)

        response = HttpResponse(pdf_bytes, content_type="application/pdf")
        response["Content-Disposition"] = 'inline; filename="preview.pdf"'
        response["Cache-Control"] = "private, max-age=60"
        return response


class ContractTemplateVariantsEndpoint(FileLibraryBaseView):
    @allow_permission([ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def post(self, request, slug, template_id):
        template = ContractTemplate.objects.get(id=template_id, workspace__slug=slug)
        source_variant_id = request.data.get("source_variant_id")
        source = (
            template.variants.filter(id=source_variant_id).first()
            if source_variant_id
            else template.variants.filter(is_default=True).first()
        )
        name = str(request.data.get("name") or "").strip()[:255]
        if not source or not name:
            return Response({"error": "name and a source variant are required"}, status=status.HTTP_400_BAD_REQUEST)
        if template.variants.filter(name=name).exists():
            return _error("variant_name_taken", status.HTTP_409_CONFLICT)
        asset = None
        try:
            with transaction.atomic():
                asset = _copy_asset(
                    source=source.source_asset,
                    workspace=template.workspace,
                    user=request.user,
                    name=f"{name}.docx",
                    entity_type=FileAsset.EntityTypeContext.CONTRACT_TEMPLATE,
                    purpose="variants",
                )
                variant = ContractTemplateVariant.objects.create(
                    workspace=template.workspace,
                    template=template,
                    name=name,
                    source_asset=asset,
                    signature_blueprint=source.signature_blueprint,
                    signature_blueprint_layout=source.signature_blueprint_layout,
                    recipient_blueprint=source.recipient_blueprint,
                    authoring_settings=source.authoring_settings,
                    variable_settings=source.variable_settings,
                    recipient_roles=source.recipient_roles,
                    created_by=request.user,
                )
        except IntegrityError:
            if asset is not None:
                _delete_uploaded([asset.asset.name])
            return _error("variant_name_taken", status.HTTP_409_CONFLICT)
        except Exception as exc:
            log_exception(exc)
            if asset is not None:
                _delete_uploaded([asset.asset.name])
            return _error("upload_failed")
        # Revision 1 so the new variant is usable at once. Best effort: "Usar"
        # still creates it later if Collabora is unavailable now.
        try:
            _create_revision(variant, request.user, _read_asset(asset), reuse_existing=True)
        except Exception as exc:
            log_exception(exc)
        template = ContractTemplate.objects.prefetch_related(
            "variants__source_asset", "variants__revisions__source_asset", "variants__revisions__pdf_asset"
        ).get(id=template.id)
        data = ContractTemplateSerializer(template).data
        data["variant_id"] = str(variant.id)
        return Response(data, status=status.HTTP_201_CREATED)


class ContractTemplateVariantDetailEndpoint(FileLibraryBaseView):
    @allow_permission([ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def patch(self, request, slug, variant_id):
        variant = ContractTemplateVariant.objects.get(id=variant_id, workspace__slug=slug)
        if "name" in request.data:
            name = str(request.data["name"] or "").strip()[:255] or variant.name
            if variant.template.variants.filter(name=name).exclude(id=variant.id).exists():
                return Response({"error": "variant_name_taken"}, status=status.HTTP_409_CONFLICT)
            variant.name = name
        if "signature_blueprint" in request.data:
            blueprint = request.data["signature_blueprint"]
            if not isinstance(blueprint, list):
                return Response({"error": "signature_blueprint must be a list"}, status=status.HTTP_400_BAD_REQUEST)
            variant.signature_blueprint = blueprint
        if "recipient_blueprint" in request.data:
            variant.recipient_blueprint = request.data["recipient_blueprint"]
        if "authoring_settings" in request.data:
            try:
                variant.authoring_settings = _normalise_authoring_settings(request.data["authoring_settings"])
            except ValueError as exc:
                return Response({"error": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        if "variable_settings" in request.data:
            try:
                variant.variable_settings = _normalise_variable_settings(request.data["variable_settings"])
            except ValueError as exc:
                return _error("invalid_variable_settings", detail=str(exc))
        if "recipient_roles" in request.data:
            try:
                variant.recipient_roles = _normalise_recipient_roles(request.data["recipient_roles"])
            except ValueError as exc:
                return _error("invalid_recipient_roles", detail=str(exc))
        try:
            variant.save(
                update_fields=[
                    "name",
                    "signature_blueprint",
                    "recipient_blueprint",
                    "authoring_settings",
                    "variable_settings",
                    "recipient_roles",
                    "updated_at",
                ]
            )
        except IntegrityError:
            return _error("variant_name_taken", status.HTTP_409_CONFLICT)
        return Response(ContractTemplateSerializer(variant.template).data)

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def delete(self, request, slug, variant_id):
        variant = ContractTemplateVariant.objects.select_related("template").get(id=variant_id, workspace__slug=slug)
        siblings = variant.template.variants.exclude(id=variant.id)
        if not siblings.exists():
            return Response({"error": "last_variant"}, status=status.HTTP_409_CONFLICT)
        with transaction.atomic():
            # A queryset update, not delete(): soft-deleting the instance would
            # cascade to its revisions and the signature requests built on them.
            ContractTemplateVariant.objects.filter(id=variant.id).update(
                deleted_at=timezone.now(), is_default=False, updated_at=timezone.now()
            )
            if variant.is_default:
                promoted = siblings.order_by("created_at").first()
                ContractTemplateVariant.objects.filter(id=promoted.id).update(is_default=True)
        template = (
            ContractTemplate.objects.filter(id=variant.template_id)
            .prefetch_related("variants__source_asset", "variants__revisions")
            .get()
        )
        return Response(ContractTemplateSerializer(template).data)


class ContractTemplateVariantRevisionsEndpoint(FileLibraryBaseView):
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
        except ContractInputError as exc:
            return _input_error_response(exc)
        except Exception as exc:
            log_exception(exc)
            return Response(
                {"error": "Something went wrong please try again later"}, status=status.HTTP_400_BAD_REQUEST
            )
        return Response(
            ContractTemplateRevisionSerializer(revision).data,
            status=status.HTTP_201_CREATED if created else status.HTTP_200_OK,
        )


class ContractTemplateVariantEditSessionEndpoint(FileLibraryBaseView):
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
            return Response(
                {"error": "Something went wrong please try again later"}, status=status.HTTP_400_BAD_REQUEST
            )
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
            return Response(
                {"error": "Something went wrong please try again later"}, status=status.HTTP_400_BAD_REQUEST
            )

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


class ContractTemplateVariantSchemaEndpoint(FileLibraryBaseView):
    @allow_permission([ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def get(self, request, slug, variant_id):
        variant = (
            ContractTemplateVariant.objects.select_related("source_asset", "template", "draft_asset")
            .filter(id=variant_id, workspace__slug=slug)
            .first()
        )
        if not variant:
            return Response({"error": "Variant not found"}, status=status.HTTP_404_NOT_FOUND)
        revision_id = request.query_params.get("revision_id")
        manual_fields = variant.signature_blueprint or []
        try:
            if revision_id:
                revision = ContractTemplateRevision.objects.filter(id=revision_id, variant=variant).first()
                if not revision:
                    return Response({"error": "Revision not found"}, status=status.HTTP_404_NOT_FOUND)
                source_bytes = _read_asset(revision.source_asset)
                content_sha256 = revision.content_sha256
                schema = _revision_schema(revision)
                manual_fields, _, compatibility = _manual_blueprint_for_revision(variant, revision)
                source = {"kind": "REVISION", "revision_id": revision.id, "revision": revision.revision}
            elif (
                request.query_params.get("source") == "draft"
                and variant.draft_asset_id
                and variant.draft_asset is not None
                and not variant.draft_asset.deleted_at
            ):
                source_bytes = _read_asset(variant.draft_asset)
                content_sha256 = hashlib.sha256(source_bytes).hexdigest()
                schema = analyse_docx_variables(source_bytes)
                compatibility = (
                    "COMPATIBLE"
                    if (variant.signature_blueprint_layout or {}).get("content_sha256") == content_sha256
                    else "REQUIRES_REVIEW"
                    if variant.signature_blueprint
                    else "NONE"
                )
                source = {"kind": "DRAFT", "revision_id": None, "revision": None}
            else:
                source_bytes = _read_asset(variant.source_asset)
                content_sha256 = hashlib.sha256(source_bytes).hexdigest()
                schema = analyse_docx_variables(source_bytes)
                revision = ContractTemplateRevision.objects.filter(
                    variant=variant, content_sha256=content_sha256
                ).first()
                if revision:
                    manual_fields, _, compatibility = _manual_blueprint_for_revision(variant, revision)
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
            warnings = analyse_docx_warnings(source_bytes, schema, manual_fields=manual_fields)
        except Exception as exc:
            log_exception(exc)
            return _error("invalid_docx", detail="The Word file could not be read")
        revisions = variant.revisions.select_related("source_asset", "pdf_asset").order_by("-revision")
        return Response(
            {
                "variant_id": variant.id,
                "content_sha256": content_sha256,
                "source": source,
                "schema": schema,
                "display_schema": _schema_for_display(schema, variant),
                "summary": schema_summary(schema),
                "warnings": warnings,
                "variable_settings": variant.variable_settings or {},
                "recipient_roles": variant.recipient_roles or {},
                "manual_fields_status": compatibility,
                "manual_field_count": len(variant.signature_blueprint or []),
                "revisions": ContractTemplateRevisionSerializer(revisions, many=True).data,
            }
        )


class ContractSignatureRequestsEndpoint(FileLibraryBaseView):
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
                "revision__variant__template",
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
        variant = (
            ContractTemplateVariant.objects.select_related("source_asset", "workspace", "template")
            .filter(id=request.data.get("variant_id"), workspace__slug=slug)
            .first()
        )
        if not variant:
            return Response({"error": "Variant not found"}, status=status.HTTP_404_NOT_FOUND)
        title = str(request.data.get("title") or variant.template.name).strip()
        authoring_mode = str(request.data.get("authoring_mode") or "DOCUMENT").upper()
        if authoring_mode not in ContractSignatureRequest.AuthoringMode.values:
            return Response({"error": "Invalid authoring mode"}, status=status.HTTP_400_BAD_REQUEST)
        is_template = authoring_mode == ContractSignatureRequest.AuthoringMode.TEMPLATE
        uploaded = []
        try:
            revision_id = request.data.get("revision_id")
            if revision_id:
                revision = (
                    ContractTemplateRevision.objects.select_related("source_asset", "pdf_asset")
                    .filter(id=revision_id, variant=variant)
                    .first()
                )
                if not revision:
                    return Response({"error": "Revision not found"}, status=status.HTTP_404_NOT_FOUND)
            else:
                revision, _ = _get_or_create_template_revision(variant, request.user)

            if is_template:
                # One configure session per revision: reuse the open one.
                open_session = _open_template_session(revision)
                if open_session is not None and request.data.get("reuse") is not False:
                    return Response(ContractSignatureRequestSerializer(open_session).data, status=status.HTTP_200_OK)

            source_bytes = _read_asset(revision.source_asset)
            schema = _revision_schema(revision)
            settings_map = variant.variable_settings or {}
            variable_values = request.data.get("variable_values")
            variable_values = variable_values if isinstance(variable_values, dict) else {}
            variable_values = {str(key)[:100]: str(value)[:5000] for key, value in variable_values.items()}
            omitted_variable_keys = request.data.get("omitted_variable_keys")
            omitted_variable_keys = omitted_variable_keys if isinstance(omitted_variable_keys, list) else []
            omitted_variable_keys = [str(key)[:100] for key in omitted_variable_keys[:100]]
            supplied_recipients = request.data.get("recipients")
            supplied_recipients = supplied_recipients if isinstance(supplied_recipients, list) else []

            if is_template:
                omitted_variable_keys = []
                # Realistic stand-ins so the configure PDF flows like a real one.
                rendered_values = {
                    item["key"]: variable_values.get(item["key"]) or sample_value(item, settings_map.get(item["key"]))
                    for item in schema.get("variables") or []
                }
                variable_values = rendered_values
            else:
                rendered_values = _rendered_variable_values(
                    schema, variable_values, omitted_variable_keys, settings_map
                )
                for semantic_recipient in schema.get("recipients") or []:
                    index = semantic_recipient["index"]
                    provided = supplied_recipients[index] if index < len(supplied_recipients) else {}
                    provided = provided if isinstance(provided, dict) else {}
                    if semantic_recipient.get("requires_name") and not str(provided.get("name") or "").strip():
                        raise ContractInputError(
                            "missing_signer", f"Missing name for Firmante {index + 1}", index=index, field="name"
                        )
                    if semantic_recipient.get("requires_email") and "@" not in str(provided.get("email") or ""):
                        raise ContractInputError(
                            "missing_signer",
                            f"Missing valid email for Firmante {index + 1}",
                            index=index,
                            field="email",
                        )

            manual_blueprint, recipient_blueprint, manual_status = _manual_blueprint_for_revision(variant, revision)
            sample_recipients = _prepare_recipients(
                schema=schema,
                supplied=supplied_recipients,
                blueprint=recipient_blueprint,
                fields=[],
                authoring_mode=authoring_mode,
                variant=variant,
            )
            if is_template:
                sample_recipients = [
                    {**recipient, "name": "Nombre Apellido Apellido", "email": "nombre@empresa.com"}
                    for recipient in sample_recipients
                ]
            rendered_docx, marker_fields, _ = render_docx_variables(
                source_bytes,
                rendered_values,
                sample_recipients,
                omitted_keys=omitted_variable_keys,
            )
            pdf_bytes = _pdf_for_content(
                variant.workspace, rendered_docx, f"{title}.docx", user=request.user, store=is_template
            )
            if not pdf_bytes:
                raise ContractInputError("conversion_failed", "Collabora could not convert the completed Word file")
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
                variant=variant,
            )
            with transaction.atomic():
                rendered_source_asset = _create_asset(
                    workspace=variant.workspace,
                    user=request.user,
                    key=_asset_key(variant.workspace_id, "rendered", "docx"),
                    name=f"{title}.docx",
                    mime_type=DOCX_MIME,
                    content=rendered_docx,
                    entity_type=FileAsset.EntityTypeContext.CONTRACT_REVISION,
                    track=uploaded,
                )
                rendered_pdf_asset = _create_asset(
                    workspace=variant.workspace,
                    user=request.user,
                    key=_asset_key(variant.workspace_id, "unsigned", "pdf"),
                    name=f"{title}.pdf",
                    mime_type="application/pdf",
                    content=pdf_bytes,
                    entity_type=FileAsset.EntityTypeContext.CONTRACT_UNSIGNED,
                    track=uploaded,
                )
                if is_template:
                    # Forced fresh session: older open ones are marked, never deleted.
                    for previous in _open_template_sessions(revision):
                        previous.metadata = {**(previous.metadata or {}), "superseded": True}
                        previous.save(update_fields=["metadata", "updated_at"])
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
        except MissingValueError as exc:
            _delete_uploaded(uploaded)
            return _error("missing_value", detail=str(exc), key=exc.key, label=exc.label)
        except ContractInputError as exc:
            _delete_uploaded(uploaded)
            return _input_error_response(exc)
        except Exception as exc:
            log_exception(exc)
            _delete_uploaded(uploaded)
            return _error("upload_failed", detail="Something went wrong please try again later")
        return Response(ContractSignatureRequestSerializer(signature_request).data, status=status.HTTP_201_CREATED)

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def delete(self, request, slug):
        return _delete_signature_requests_from_payload(request, slug)


class ContractSignatureRequestsDeleteEndpoint(FileLibraryBaseView):
    """Action endpoint for clients/proxies that do not support DELETE bodies."""

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def post(self, request, slug):
        return _delete_signature_requests_from_payload(request, slug)


class ContractSignatureRequestDetailEndpoint(FileLibraryBaseView):
    @allow_permission([ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def get(self, request, slug, request_id):
        signature_request = (
            ContractSignatureRequest.objects.select_related(
                "revision", "revision__variant__template", "signed_asset", "analysis_contract"
            )
            .prefetch_related("signers")
            .get(id=request_id, workspace__slug=slug)
        )
        if signature_request.documenso_envelope_id:
            try:
                envelope = DocumensoClient().get_envelope(signature_request.documenso_envelope_id)
                # Also persists the status (the signed PDF is fetched by a task).
                _attach_envelope_progress(signature_request, envelope, complete="defer")
            except DocumensoError as exc:
                log_exception(exc)
                signature_request._signing_details = {
                    "status": signature_request.status,
                    "recipients": [],
                    "fields": [],
                    "error": exc.public_message,
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

        is_template = signature_request.authoring_mode == ContractSignatureRequest.AuthoringMode.TEMPLATE
        # commit absent = legacy (every save writes the blueprint); false = save
        # the session only; true = validate, then write the blueprint.
        commit = request.data.get("commit") if "commit" in request.data else None
        if is_template and commit is True:
            for index, recipient in enumerate(recipients):
                if recipient["role"] == "SIGNER" and not any(
                    field["type"] == "SIGNATURE" for field in recipient["fields"]
                ):
                    return _error(
                        "signer_without_signature",
                        detail=f"Signer {index + 1} has no signature field",
                        index=index,
                    )

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
            if is_template and commit is not False:
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
        data = ContractSignatureRequestSerializer(signature_request).data
        if is_template:
            data["committed"] = commit is not False
        return Response(data)

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


class ContractSignatureRequestPdfEndpoint(FileLibraryBaseView):
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


SEND_STALE_SECONDS = 15 * 60
TERMINAL_SIGNATURE_STATUSES = {
    ContractSignatureRequest.Status.COMPLETED,
    ContractSignatureRequest.Status.CANCELLED,
    ContractSignatureRequest.Status.REJECTED,
}
NON_SIGNING_ROLES = {"CC", "VIEWER"}


def _set_send_step(signature_request, step, **extra):
    """Persist metadata.send without touching other columns."""
    now = timezone.now()
    metadata = dict(signature_request.metadata or {})
    metadata["send"] = {**(metadata.get("send") or {}), "step": step, "updated_at": now.isoformat(), **extra}
    signature_request.metadata = metadata
    ContractSignatureRequest.objects.filter(id=signature_request.id).update(metadata=metadata, updated_at=now)


class ContractSignatureRequestSendEndpoint(FileLibraryBaseView):
    """Validates and queues the send; the Celery task does the Documenso work
    and reports its steps in metadata.send (queued → uploading → creating →
    distributing → done | failed)."""

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def post(self, request, slug, request_id):
        with transaction.atomic():
            signature_request = (
                ContractSignatureRequest.objects.select_for_update().filter(id=request_id, workspace__slug=slug).first()
            )
            if not signature_request:
                return Response({"error": "Request not found"}, status=status.HTTP_404_NOT_FOUND)
            if signature_request.status == ContractSignatureRequest.Status.PREPARING:
                return _error("already_sending", status.HTTP_409_CONFLICT)
            if signature_request.status != ContractSignatureRequest.Status.READY:
                return _error("request_not_ready", status.HTTP_409_CONFLICT, detail="Only a ready request can be sent")
            if signature_request.authoring_mode != ContractSignatureRequest.AuthoringMode.DOCUMENT:
                return Response({"error": "Template mappings cannot be sent"}, status=status.HTTP_409_CONFLICT)
            try:
                authoring_settings = _normalise_authoring_settings(
                    request.data.get("authoring_settings", signature_request.authoring_settings)
                )
                recipients = _normalise_authoring_payload(request.data.get("recipients"), authoring_settings)
            except ContractInputError as exc:
                return _input_error_response(exc)
            except (TypeError, ValueError) as exc:
                return Response({"error": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
            if any(recipient["role"] == "ASSISTANT" for recipient in recipients):
                authoring_settings["signingOrder"] = "SEQUENTIAL"
            # Retries always use what was submitted now, not an older attempt.
            signature_request.recipients = recipients
            signature_request.fields = [
                {**field, "recipient_index": index}
                for index, recipient in enumerate(recipients)
                for field in recipient["fields"]
            ]
            signature_request.authoring_settings = authoring_settings
            signature_request.status = ContractSignatureRequest.Status.PREPARING
            signature_request.error = None
            attempt = int(((signature_request.metadata or {}).get("send") or {}).get("attempt") or 0) + 1
            now = timezone.now().isoformat()
            signature_request.metadata = {
                **(signature_request.metadata or {}),
                "send": {"step": "queued", "queued_at": now, "updated_at": now, "attempt": attempt},
            }
            signature_request.save(
                update_fields=[
                    "recipients",
                    "fields",
                    "authoring_settings",
                    "status",
                    "error",
                    "metadata",
                    "updated_at",
                ]
            )
            from plane.bgtasks.contract_signature_task import send_signature_request

            request_key = str(signature_request.id)
            transaction.on_commit(lambda: send_signature_request.delay(request_key))
        return Response(ContractSignatureRequestSerializer(signature_request).data, status=status.HTTP_202_ACCEPTED)


def _envelope_matches(envelope, recipients):
    """A draft envelope is reusable only if it has the same people and fields."""
    remote = envelope.get("recipients") or []
    remote_emails = sorted(str(item.get("email") or "").lower() for item in remote)
    local_emails = sorted(str(item.get("email") or "").lower() for item in recipients)
    if remote_emails != local_emails:
        return False
    if "fields" not in envelope:
        return True
    return len(envelope.get("fields") or []) == sum(len(item.get("fields") or []) for item in recipients)


def _store_envelope(signature_request, envelope, recipients):
    items = envelope.get("envelopeItems") or envelope.get("items") or []
    if not items:
        raise DocumensoError("Documenso did not return an envelope item")
    doc_recipients = envelope.get("recipients") or []
    with transaction.atomic():
        signature_request.documenso_envelope_id = envelope["id"]
        signature_request.documenso_envelope_item_id = items[0]["id"]
        signature_request.save(update_fields=["documenso_envelope_id", "documenso_envelope_item_id", "updated_at"])
        signature_request.signers.all().delete()
        for recipient in recipients:
            resolved = next(
                (item for item in doc_recipients if str(item.get("email") or "").lower() == recipient["email"].lower()),
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


def run_signature_send(request_id):
    """Body of the send task. Safe to re-run: an existing envelope (by id or
    by externalId) is reused, so a retry after a timeout never duplicates."""
    signature_request = (
        ContractSignatureRequest.objects.select_related("workspace", "revision__pdf_asset", "rendered_pdf_asset")
        .filter(id=request_id)
        .first()
    )
    if not signature_request or signature_request.status != ContractSignatureRequest.Status.PREPARING:
        return None
    step = "uploading"
    try:
        _set_send_step(signature_request, step, started_at=timezone.now().isoformat(), error=None)
        recipients = signature_request.recipients or []
        authoring_settings = signature_request.authoring_settings or {}
        client = DocumensoClient()
        pdf_bytes = _read_asset(signature_request.rendered_pdf_asset or signature_request.revision.pdf_asset)

        step = "creating"
        _set_send_step(signature_request, step)
        envelope = None
        if signature_request.documenso_envelope_id:
            envelope = client.get_envelope(signature_request.documenso_envelope_id)
        else:
            envelope = client.find_envelope_by_external_id(str(signature_request.id))
        if envelope and envelope.get("status") in {"CANCELLED", "REJECTED"}:
            envelope = None
        if envelope and envelope.get("status") == "DRAFT" and not _envelope_matches(envelope, recipients):
            # Never sent to anyone, but built from older recipients: rebuild it.
            client.delete_envelope(envelope["id"])
            envelope = None
        if envelope is None:
            envelope = client.create_envelope(
                title=signature_request.title,
                external_id=str(signature_request.id),
                pdf_bytes=pdf_bytes,
                recipients=recipients,
                authoring_settings=authoring_settings,
            )
        _store_envelope(signature_request, envelope, recipients)

        step = "distributing"
        _set_send_step(signature_request, step)
        current = (
            ContractSignatureRequest.objects.filter(id=signature_request.id).values_list("status", flat=True).first()
        )
        if current != ContractSignatureRequest.Status.PREPARING:
            # Cancelled meanwhile: do not send what the user withdrew.
            if envelope.get("status") == "DRAFT":
                client.delete_envelope(envelope["id"])
                ContractSignatureRequest.objects.filter(id=signature_request.id).update(
                    documenso_envelope_id=None, documenso_envelope_item_id=None
                )
            _set_send_step(signature_request, "failed", error={"code": "cancelled", "message": "Cancelled"})
            return None
        if envelope.get("status") == "DRAFT":
            try:
                client.distribute_envelope(envelope["id"])
            except DocumensoError:
                # Distribution can succeed remotely while its HTTP response is
                # interrupted. Reconcile before exposing a retry.
                if client.get_envelope(envelope["id"]).get("status") not in {"PENDING", "COMPLETED"}:
                    raise
        envelope = client.get_envelope(envelope["id"])

        with transaction.atomic():
            locked = ContractSignatureRequest.objects.select_for_update().get(id=signature_request.id)
            if locked.status == ContractSignatureRequest.Status.PREPARING:
                locked.status = ContractSignatureRequest.Status.PENDING
                locked.sent_at = locked.sent_at or timezone.now()
                locked.error = None
                locked.save(update_fields=["status", "sent_at", "error", "updated_at"])
                locked.signers.filter(status=ContractSigner.Status.NOT_SENT).update(status=ContractSigner.Status.SENT)
            apply_envelope_state(locked, envelope, complete="defer")
        _set_send_step(signature_request, "done", finished_at=timezone.now().isoformat())
        return signature_request.id
    except Exception as exc:
        log_exception(exc)
        if isinstance(exc, ContractInputError):
            code, message = exc.code, str(exc)
        elif isinstance(exc, DocumensoError):
            code, message = "documenso_error", exc.public_message
        else:
            code, message = "send_failed", "Something went wrong please try again later"
        with transaction.atomic():
            locked = ContractSignatureRequest.objects.select_for_update().filter(id=signature_request.id).first()
            if locked and locked.status == ContractSignatureRequest.Status.PREPARING:
                # Back to READY so the user can fix and retry; the envelope id
                # (if any) is kept so the retry reuses it.
                locked.status = ContractSignatureRequest.Status.READY
                locked.error = {"message": message, "code": code}
                locked.save(update_fields=["status", "error", "updated_at"])
        _set_send_step(signature_request, "failed", failed_step=step, error={"code": code, "message": message})
        return None


class ContractSignatureRequestLinksEndpoint(FileLibraryBaseView):
    @allow_permission([ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def get(self, request, slug, request_id):
        signature_request = ContractSignatureRequest.objects.get(id=request_id, workspace__slug=slug)
        if not signature_request.documenso_envelope_id:
            return Response({"error": "The contract has not been distributed"}, status=status.HTTP_409_CONFLICT)
        try:
            envelope = DocumensoClient().get_envelope(signature_request.documenso_envelope_id)
        except DocumensoError as exc:
            log_exception(exc)
            return Response({"error": exc.public_message}, status=status.HTTP_400_BAD_REQUEST)
        return Response({"links": _signing_links_from_envelope(envelope)})


def _complete_signature_request(signature_request):
    """Download the signed PDF once. Runs under a row lock, so a webhook, the
    sync button and the reconcile job can race without duplicating it."""
    uploaded = []
    try:
        with transaction.atomic():
            locked = (
                ContractSignatureRequest.objects.select_for_update(of=("self",))
                .select_related("workspace", "created_by")
                .get(id=signature_request.id)
            )
            if not locked.signed_asset_id:
                client = DocumensoClient()
                signed_bytes = client.download_signed_item(locked.documenso_envelope_item_id)
                signed_asset = _create_asset(
                    workspace=locked.workspace,
                    user=locked.created_by,
                    key=_asset_key(locked.workspace_id, "signed", "pdf"),
                    name=f"{locked.title}-signed.pdf",
                    mime_type="application/pdf",
                    content=signed_bytes,
                    # Final PDFs participate in the existing file-library/analysis UI;
                    # the dedicated bucket/purpose remains recorded in storage_metadata.
                    entity_type=FileAsset.EntityTypeContext.WORKSPACE_FILE_LIBRARY,
                    track=uploaded,
                )
                analysis_contract = ensure_contract_for_asset(signed_asset, user=locked.created_by)
                if analysis_contract is not None and analysis_contract.source_request_id is None:
                    analysis_contract.source_request = locked
                    analysis_contract.save(update_fields=["source_request", "updated_at"])
                locked.signed_asset = signed_asset
                locked.analysis_contract = analysis_contract
                locked.status = ContractSignatureRequest.Status.COMPLETED
                locked.completed_at = timezone.now()
                locked.error = None
                locked.save()
                locked.signers.exclude(role__in=["CC", "VIEWER"]).update(status=ContractSigner.Status.SIGNED)
    except Exception:
        _delete_uploaded(uploaded)
        raise
    signature_request.refresh_from_db(
        fields=["signed_asset", "analysis_contract", "status", "completed_at", "error", "updated_at"]
    )
    return signature_request


def _parse_datetime(value):
    if not value:
        return None
    if hasattr(value, "tzinfo"):
        return value
    try:
        from datetime import datetime

        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else timezone.make_aware(parsed)


def _recipient_expired(recipient, now):
    if recipient.get("signingStatus") in {"SIGNED", "REJECTED"}:
        return False
    if recipient.get("expirationNotifiedAt"):
        return True
    expires_at = _parse_datetime(recipient.get("expiresAt"))
    return bool(expires_at and expires_at <= now)


def _signing_recipients(envelope):
    recipients = envelope.get("recipients") or envelope.get("Recipient") or []
    return [item for item in recipients if isinstance(item, dict) and item.get("role") not in NON_SIGNING_ROLES]


def envelope_request_status(local_status, envelope, now=None):
    """Map a Documenso envelope onto a Plane request status. Local terminal
    states never move; a rejecting signer means REJECTED; a PENDING envelope
    whose unsigned signer link expired means EXPIRED."""
    now = now or timezone.now()
    if local_status in TERMINAL_SIGNATURE_STATUSES:
        return local_status
    remote = envelope.get("status")
    signers = _signing_recipients(envelope)
    if remote == "COMPLETED":
        return ContractSignatureRequest.Status.COMPLETED
    if remote == "CANCELLED":
        return ContractSignatureRequest.Status.CANCELLED
    if remote == "REJECTED" or any(item.get("signingStatus") == "REJECTED" for item in signers):
        return ContractSignatureRequest.Status.REJECTED
    if remote == "PENDING":
        if any(_recipient_expired(item, now) for item in signers):
            return ContractSignatureRequest.Status.EXPIRED
        return ContractSignatureRequest.Status.PENDING
    return local_status


def _signer_status_for(recipient, now):
    signing_status = recipient.get("signingStatus")
    if signing_status == "REJECTED":
        return ContractSigner.Status.REJECTED
    if signing_status == "SIGNED":
        return ContractSigner.Status.SIGNED
    if recipient.get("role") not in NON_SIGNING_ROLES and _recipient_expired(recipient, now):
        return ContractSigner.Status.EXPIRED
    if recipient.get("readStatus") == "OPENED":
        return ContractSigner.Status.OPENED
    if recipient.get("sendStatus") == "SENT":
        return ContractSigner.Status.SENT
    return None


def _sync_signers_from_webhook(signature_request, event_payload, now=None):
    now = now or timezone.now()
    recipients = event_payload.get("recipients") or event_payload.get("Recipient") or []
    for recipient in recipients:
        email = recipient.get("email")
        if not email:
            continue
        signer_status = _signer_status_for(recipient, now)
        if signer_status:
            signature_request.signers.filter(email=email).update(status=signer_status)


def apply_envelope_state(signature_request, envelope, complete="defer"):
    """The one place that turns a Documenso envelope (API or webhook payload)
    into Plane state: signer statuses, request status, expiry. Used by the
    webhook, sync, request detail and the reconcile job.

    complete: "inline" downloads the signed PDF now; "defer" queues it (the
    status stays PENDING until the file is stored, so reconcile can retry).
    """
    now = timezone.now()
    _sync_signers_from_webhook(signature_request, envelope, now)
    if hasattr(signature_request, "_prefetched_objects_cache"):
        signature_request._prefetched_objects_cache.pop("signers", None)

    update_fields = []
    unsigned_expiries = [
        _parse_datetime(item.get("expiresAt"))
        for item in _signing_recipients(envelope)
        if item.get("signingStatus") not in {"SIGNED", "REJECTED"}
    ]
    unsigned_expiries = [value for value in unsigned_expiries if value]
    if unsigned_expiries and signature_request.expires_at != min(unsigned_expiries):
        signature_request.expires_at = min(unsigned_expiries)
        update_fields.append("expires_at")

    target = envelope_request_status(signature_request.status, envelope, now)
    needs_completion = target == ContractSignatureRequest.Status.COMPLETED and not signature_request.signed_asset_id
    if needs_completion:
        if complete == "inline":
            if update_fields:
                signature_request.save(update_fields=[*update_fields, "updated_at"])
            _complete_signature_request(signature_request)
            return {"status": signature_request.status, "completed": True}
        if complete == "defer":
            from plane.bgtasks.contract_signature_task import complete_signature_request

            request_key = str(signature_request.id)
            transaction.on_commit(lambda: complete_signature_request.delay(request_key))
    elif target != signature_request.status:
        signature_request.status = target
        update_fields.append("status")
    if update_fields:
        signature_request.save(update_fields=[*update_fields, "updated_at"])
    return {"status": signature_request.status, "completed": False, "needs_completion": needs_completion}


def _attach_envelope_progress(signature_request, envelope, complete="defer"):
    apply_envelope_state(signature_request, envelope, complete=complete)
    signature_request._signing_details = _signing_details_from_envelope(envelope)
    return signature_request


EVENT_STATUS = {
    "DOCUMENT_COMPLETED": "COMPLETED",
    "DOCUMENT_REJECTED": "REJECTED",
    "DOCUMENT_CANCELLED": "CANCELLED",
}


def webhook_event_key(event_type, payload):
    """Same delivery → same key. Built from the envelope, event, status and
    each recipient's state; timestamps such as createdAt are left out so a
    re-delivery is recognised."""
    payload = payload if isinstance(payload, dict) else {}
    envelope_id = payload.get("envelopeId") or payload.get("id") or payload.get("externalId") or ""
    recipients = payload.get("recipients") or payload.get("Recipient") or []
    parts = sorted(
        ":".join(
            [
                str(item.get("id") or item.get("email") or ""),
                str(item.get("signingStatus") or ""),
                str(item.get("readStatus") or ""),
                str(item.get("sendStatus") or ""),
                "expired" if item.get("expirationNotifiedAt") else "",
            ]
        )
        for item in recipients
        if isinstance(item, dict)
    )
    raw = "|".join([str(envelope_id), str(event_type or ""), str(payload.get("status") or ""), *parts])
    return hashlib.sha256(raw.encode()).hexdigest()


def _request_for_payload(event_payload):
    external_id = event_payload.get("externalId")
    envelope_id = event_payload.get("envelopeId") or event_payload.get("id")
    if external_id:
        try:
            request_id = UUID(str(external_id))
        except (TypeError, ValueError):
            request_id = None
        if request_id:
            found = ContractSignatureRequest.objects.filter(id=request_id).values_list("id", flat=True).first()
            if found:
                return found
    if envelope_id:
        return (
            ContractSignatureRequest.objects.filter(documenso_envelope_id=str(envelope_id))
            .values_list("id", flat=True)
            .first()
        )
    return None


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
        event_payload = event_payload if isinstance(event_payload, dict) else {}
        event, created = ContractWebhookEvent.objects.get_or_create(
            event_key=webhook_event_key(event_type, event_payload),
            defaults={"event_type": event_type, "payload": payload},
        )
        if not created and event.processed_at:
            return Response({"received": True, "duplicate": True})

        envelope = dict(event_payload)
        if not envelope.get("status") and event_type in EVENT_STATUS:
            envelope["status"] = EVENT_STATUS[event_type]
        try:
            request_id = _request_for_payload(event_payload)
            if request_id:
                with transaction.atomic():
                    signature_request = ContractSignatureRequest.objects.select_for_update().get(id=request_id)
                    # The signed PDF download runs in a task; this stays fast.
                    apply_envelope_state(signature_request, envelope, complete="defer")
            event.processed_at = timezone.now()
            event.error = None
            event.save(update_fields=["processed_at", "error", "updated_at"])
        except Exception as exc:
            log_exception(exc)
            event.error = str(exc)
            event.save(update_fields=["error", "updated_at"])
            return Response({"error": "Webhook processing failed"}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)
        return Response({"received": True})


class ContractSignatureRequestSyncEndpoint(FileLibraryBaseView):
    """Manual recovery path when a webhook was delayed or misconfigured."""

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def post(self, request, slug, request_id):
        signature_request = ContractSignatureRequest.objects.get(id=request_id, workspace__slug=slug)
        if not signature_request.documenso_envelope_id:
            return Response({"error": "Request has no Documenso envelope"}, status=status.HTTP_409_CONFLICT)
        try:
            envelope = DocumensoClient().get_envelope(signature_request.documenso_envelope_id)
            _attach_envelope_progress(signature_request, envelope, complete="inline")
        except DocumensoError as exc:
            log_exception(exc)
            return Response({"error": exc.public_message}, status=status.HTTP_502_BAD_GATEWAY)
        return Response(ContractSignatureRequestSerializer(signature_request).data)


def reconcile_signature_requests(limit=200):
    """Beat job: bring requests whose webhook may have been lost in line with
    Documenso, and re-queue sends whose worker died."""
    stale_before = timezone.now() - timedelta(seconds=SEND_STALE_SECONDS)
    from plane.bgtasks.contract_signature_task import send_signature_request

    requeued = 0
    for signature_request in ContractSignatureRequest.objects.filter(
        status=ContractSignatureRequest.Status.PREPARING, metadata__has_key="send", updated_at__lt=stale_before
    )[:limit]:
        send_signature_request.delay(str(signature_request.id))
        requeued += 1

    candidates = list(
        ContractSignatureRequest.objects.filter(
            status__in=[ContractSignatureRequest.Status.PENDING, ContractSignatureRequest.Status.EXPIRED],
            documenso_envelope_id__isnull=False,
        )
        .order_by("updated_at")
        .values_list("id", flat=True)[:limit]
    )
    if not candidates:
        return {"checked": 0, "requeued": requeued}
    try:
        client = DocumensoClient()
    except DocumensoError as exc:
        log_exception(exc)
        return {"checked": 0, "requeued": requeued}
    checked = 0
    for request_id in candidates:
        try:
            current = ContractSignatureRequest.objects.get(id=request_id)
            envelope = client.get_envelope(current.documenso_envelope_id)
            with transaction.atomic():
                locked = ContractSignatureRequest.objects.select_for_update().get(id=request_id)
                apply_envelope_state(locked, envelope, complete="inline")
            checked += 1
        except Exception as exc:
            log_exception(exc)
    return {"checked": checked, "requeued": requeued}


ACTIVE_SIGNATURE_STATUSES = {
    ContractSignatureRequest.Status.DRAFT,
    ContractSignatureRequest.Status.PREPARING,
    ContractSignatureRequest.Status.READY,
    ContractSignatureRequest.Status.PENDING,
    ContractSignatureRequest.Status.EXPIRED,
    ContractSignatureRequest.Status.ERROR,
}


def _cancel_signature_request(signature_request, reason=None):
    """Cancel locally and, if sent, in Documenso. Raises DocumensoError."""
    if signature_request.documenso_envelope_id:
        DocumensoClient().cancel_envelope(signature_request.documenso_envelope_id, reason=reason)
    signature_request.status = ContractSignatureRequest.Status.CANCELLED
    signature_request.error = None
    signature_request.save(update_fields=["status", "error", "updated_at"])
    return signature_request


class ContractSignatureRequestCancelEndpoint(FileLibraryBaseView):
    """Withdraws a request. A sent envelope is cancelled in Documenso too, so
    the signing links stop working; the local record is kept."""

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def post(self, request, slug, request_id):
        signature_request = ContractSignatureRequest.objects.get(id=request_id, workspace__slug=slug)
        if signature_request.status not in ACTIVE_SIGNATURE_STATUSES:
            return Response({"error": "request_not_active"}, status=status.HTTP_409_CONFLICT)
        try:
            reason = str(request.data.get("reason") or "").strip()[:500] or None
            _cancel_signature_request(signature_request, reason=reason)
        except DocumensoError as exc:
            log_exception(exc)
            return Response({"error": exc.public_message}, status=status.HTTP_502_BAD_GATEWAY)
        return Response(ContractSignatureRequestSerializer(signature_request).data)


class ContractSignatureRequestRemindEndpoint(FileLibraryBaseView):
    """Re-sends the signing email to everyone who has not signed yet."""

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def post(self, request, slug, request_id):
        signature_request = ContractSignatureRequest.objects.get(id=request_id, workspace__slug=slug)
        if signature_request.status != ContractSignatureRequest.Status.PENDING or not (
            signature_request.documenso_envelope_id
        ):
            return Response({"error": "request_not_pending"}, status=status.HTTP_409_CONFLICT)
        try:
            client = DocumensoClient()
            envelope = client.get_envelope(signature_request.documenso_envelope_id)
            waiting = [
                recipient["id"]
                for recipient in envelope.get("recipients") or []
                if recipient.get("id") is not None
                and recipient.get("role") not in ("CC", "VIEWER")
                and recipient.get("signingStatus") not in ("SIGNED", "REJECTED")
            ]
            if not waiting:
                return Response({"error": "nobody_to_remind"}, status=status.HTTP_409_CONFLICT)
            client.redistribute_envelope(signature_request.documenso_envelope_id, waiting)
        except DocumensoError as exc:
            log_exception(exc)
            return Response({"error": exc.public_message}, status=status.HTTP_502_BAD_GATEWAY)
        signature_request.last_reminded_at = timezone.now()
        signature_request.save(update_fields=["last_reminded_at", "updated_at"])
        return Response({"reminded": len(waiting), "last_reminded_at": signature_request.last_reminded_at})


def _duplicate_signature_request(source, user, title):
    """A READY copy with its own rendered files. Uploads are removed again
    if the row cannot be created."""
    uploaded = []
    try:
        with transaction.atomic():
            copies = {}
            for field, entity_type, purpose in (
                ("rendered_source_asset", FileAsset.EntityTypeContext.CONTRACT_REVISION, "rendered"),
                ("rendered_pdf_asset", FileAsset.EntityTypeContext.CONTRACT_UNSIGNED, "unsigned"),
            ):
                original = getattr(source, field)
                if original is None:
                    copies[field] = None
                    continue
                extension = ((original.attributes or {}).get("name") or "").rsplit(".", 1)[-1].lower() or "pdf"
                copies[field] = _copy_asset(
                    source=original,
                    workspace=source.workspace,
                    user=user,
                    name=f"{title}.{extension}",
                    entity_type=entity_type,
                    purpose=purpose,
                )
                uploaded.append(copies[field].asset.name)
            return ContractSignatureRequest.objects.create(
                workspace=source.workspace,
                revision=source.revision,
                rendered_source_asset=copies["rendered_source_asset"],
                rendered_pdf_asset=copies["rendered_pdf_asset"],
                title=title,
                authoring_mode=source.authoring_mode,
                status=ContractSignatureRequest.Status.READY,
                recipients=source.recipients,
                fields=source.fields,
                authoring_settings=source.authoring_settings,
                variable_values=source.variable_values,
                preparation_warnings=source.preparation_warnings,
                rendered_layout_signature=source.rendered_layout_signature,
                metadata={"duplicated_from": str(source.id)},
                created_by=user,
            )
    except Exception:
        _delete_uploaded(uploaded)
        raise


class ContractSignatureRequestDuplicateEndpoint(FileLibraryBaseView):
    """A fresh, unsent copy of a request (same document, recipients and
    fields), ready to adjust and send."""

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def post(self, request, slug, request_id):
        source = ContractSignatureRequest.objects.select_related(
            "workspace", "revision", "rendered_source_asset", "rendered_pdf_asset"
        ).get(id=request_id, workspace__slug=slug, authoring_mode=ContractSignatureRequest.AuthoringMode.DOCUMENT)
        title = str(request.data.get("title") or f"{source.title} (copia)").strip()[:500]
        try:
            duplicate = _duplicate_signature_request(source, request.user, title)
        except Exception as exc:
            log_exception(exc)
            return Response(
                {"error": "Something went wrong please try again later"}, status=status.HTTP_400_BAD_REQUEST
            )
        return Response(ContractSignatureRequestSerializer(duplicate).data, status=status.HTTP_201_CREATED)


class ContractSignatureRequestCancelAndDuplicateEndpoint(FileLibraryBaseView):
    """Correct a sent contract in one step: cancel it (Documenso too) and
    return a READY copy to edit and send again."""

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def post(self, request, slug, request_id):
        source = (
            ContractSignatureRequest.objects.select_related(
                "workspace", "revision", "rendered_source_asset", "rendered_pdf_asset"
            )
            .filter(id=request_id, workspace__slug=slug, authoring_mode=ContractSignatureRequest.AuthoringMode.DOCUMENT)
            .first()
        )
        if not source:
            return Response({"error": "Request not found"}, status=status.HTTP_404_NOT_FOUND)
        if source.status == ContractSignatureRequest.Status.COMPLETED:
            return Response({"error": "request_not_active"}, status=status.HTTP_409_CONFLICT)
        if source.status == ContractSignatureRequest.Status.PREPARING:
            return _error("already_sending", status.HTTP_409_CONFLICT)
        title = str(request.data.get("title") or source.title).strip()[:500]
        if source.status in ACTIVE_SIGNATURE_STATUSES:
            try:
                reason = str(request.data.get("reason") or "").strip()[:500] or None
                _cancel_signature_request(source, reason=reason)
            except DocumensoError as exc:
                log_exception(exc)
                return Response({"error": exc.public_message}, status=status.HTTP_502_BAD_GATEWAY)
        try:
            duplicate = _duplicate_signature_request(source, request.user, title)
        except Exception as exc:
            log_exception(exc)
            return _error("upload_failed", detail="The request was cancelled but the copy could not be created")
        data = ContractSignatureRequestSerializer(duplicate).data
        data["cancelled_request_id"] = str(source.id)
        return Response(data, status=status.HTTP_201_CREATED)
