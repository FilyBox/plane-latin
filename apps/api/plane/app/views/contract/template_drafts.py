# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Word editing on a private draft per variant.

The editor never writes the published document. "Edit" copies the live
source into a draft asset; Collabora saves into the draft; publishing turns
the draft into the next revision and the new live source. One person edits a
draft at a time (heartbeat every 30 s, stale after 90 s).
"""

import hashlib
from datetime import timedelta

from django.db import IntegrityError, transaction
from django.utils import timezone
from rest_framework import status
from rest_framework.response import Response

from plane.app.permissions import ROLE, allow_permission
from plane.app.serializers import ContractTemplateRevisionSerializer, ContractTemplateSerializer
from plane.app.serializers.contract import variant_draft_info
from plane.db.models import ContractTemplate, ContractTemplateRevision, ContractTemplateVariant, FileAsset
from plane.integrations.contract_docx import analyse_docx_variables, schema_changes
from plane.settings.storage import S3Storage
from plane.utils.exception_logger import log_exception

from ..file_library.base import FileLibraryBaseView
from ..file_library.collabora import (
    CONTRACT_DRAFT_PREFIX,
    DOCX_MIME,
    build_editor_session,
    request_origin,
    user_friendly_name,
)
from .workflow import (
    DRAFT_LOCK_SECONDS,
    ContractInputError,
    _asset_key,
    _create_asset,
    _create_revision,
    _delete_uploaded,
    _error,
    _input_error_response,
    _manual_blueprint_for_revision,
    _overwrite_asset_content,
    _pdf_for_content,
    _read_asset,
)


def _locked_variant(slug, variant_id):
    return (
        ContractTemplateVariant.objects.select_for_update(of=("self",))
        .select_related("source_asset", "template", "workspace", "draft_asset")
        .filter(id=variant_id, workspace__slug=slug)
        .first()
    )


def _lock_conflict(variant, user):
    """409 body when someone else edited the draft in the last 90 s."""
    if not variant.draft_active_by_id or variant.draft_active_by_id == user.id or not variant.draft_active_at:
        return None
    if variant.draft_active_at <= timezone.now() - timedelta(seconds=DRAFT_LOCK_SECONDS):
        return None
    return _error(
        "draft_locked",
        status.HTTP_409_CONFLICT,
        by_name=user_friendly_name(variant.draft_active_by_id),
        since=variant.draft_active_at.isoformat(),
    )


def _clear_draft(variant):
    asset_id = variant.draft_asset_id
    variant.draft_asset = None
    variant.draft_base_sha256 = None
    variant.draft_started_by = None
    variant.draft_started_at = None
    variant.draft_updated_at = None
    variant.draft_active_by = None
    variant.draft_active_at = None
    variant.save(
        update_fields=[
            "draft_asset",
            "draft_base_sha256",
            "draft_started_by",
            "draft_started_at",
            "draft_updated_at",
            "draft_active_by",
            "draft_active_at",
            "updated_at",
        ]
    )
    if asset_id:
        transaction.on_commit(lambda: _dispose_draft_asset(asset_id))


def _dispose_draft_asset(asset_id):
    asset = FileAsset.objects.filter(id=asset_id).first()
    if not asset:
        return
    try:
        S3Storage.for_asset(asset).delete_files([asset.asset.name])
    except Exception as exc:
        log_exception(exc)
    FileAsset.objects.filter(id=asset_id).update(is_deleted=True, deleted_at=timezone.now())


def _template_payload(template_id):
    template = ContractTemplate.objects.prefetch_related(
        "variants__source_asset",
        "variants__draft_asset",
        "variants__revisions__source_asset",
        "variants__revisions__pdf_asset",
    ).get(id=template_id)
    return ContractTemplateSerializer(template).data


def _draft_bytes(variant):
    if not variant.draft_asset_id or variant.draft_asset is None or variant.draft_asset.deleted_at:
        raise ContractInputError("no_draft", http_status=status.HTTP_409_CONFLICT)
    return _read_asset(variant.draft_asset)


class ContractTemplateVariantDraftEndpoint(FileLibraryBaseView):
    """Create (or reuse) the draft and return the Collabora editor for it."""

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def post(self, request, slug, variant_id):
        uploaded = []
        created = False
        try:
            with transaction.atomic():
                variant = _locked_variant(slug, variant_id)
                if not variant:
                    return Response({"error": "Variant not found"}, status=status.HTTP_404_NOT_FOUND)
                conflict = _lock_conflict(variant, request.user)
                if conflict:
                    return conflict
                now = timezone.now()
                if not variant.draft_asset_id or variant.draft_asset is None or variant.draft_asset.deleted_at:
                    source_bytes = _read_asset(variant.source_asset)
                    variant.draft_asset = _create_asset(
                        workspace=variant.workspace,
                        user=request.user,
                        key=_asset_key(variant.workspace_id, "drafts", "docx"),
                        name=f"{variant.template.name} ({variant.name}).docx",
                        mime_type=DOCX_MIME,
                        content=source_bytes,
                        entity_type=FileAsset.EntityTypeContext.CONTRACT_TEMPLATE,
                        entity_identifier=f"{CONTRACT_DRAFT_PREFIX}{variant.id}",
                        track=uploaded,
                    )
                    variant.draft_base_sha256 = hashlib.sha256(source_bytes).hexdigest()
                    variant.draft_started_by = request.user
                    variant.draft_started_at = now
                    variant.draft_updated_at = now
                    created = True
                variant.draft_active_by = request.user
                variant.draft_active_at = now
                variant.save(
                    update_fields=[
                        "draft_asset",
                        "draft_base_sha256",
                        "draft_started_by",
                        "draft_started_at",
                        "draft_updated_at",
                        "draft_active_by",
                        "draft_active_at",
                        "updated_at",
                    ]
                )
        except Exception as exc:
            log_exception(exc)
            _delete_uploaded(uploaded)
            return _error("upload_failed")

        draft = variant_draft_info(variant)
        editor, error = build_editor_session(variant.draft_asset, request.user, "write", origin=request_origin(request))
        if error:
            return Response({"error": "editor_unavailable", "detail": error[0], "draft": draft}, status=error[1])
        return Response(
            {"draft": draft, "editor": editor},
            status=status.HTTP_201_CREATED if created else status.HTTP_200_OK,
        )


class ContractTemplateVariantDraftHeartbeatEndpoint(FileLibraryBaseView):
    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def post(self, request, slug, variant_id):
        with transaction.atomic():
            variant = _locked_variant(slug, variant_id)
            if not variant:
                return Response({"error": "Variant not found"}, status=status.HTTP_404_NOT_FOUND)
            if not variant.draft_asset_id:
                return _error("no_draft", status.HTTP_409_CONFLICT)
            conflict = _lock_conflict(variant, request.user)
            if conflict:
                return conflict
            variant.draft_active_by = request.user
            variant.draft_active_at = timezone.now()
            variant.save(update_fields=["draft_active_by", "draft_active_at", "updated_at"])
        return Response({"draft": variant_draft_info(variant)})


class ContractTemplateVariantDraftReleaseEndpoint(FileLibraryBaseView):
    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def post(self, request, slug, variant_id):
        with transaction.atomic():
            variant = _locked_variant(slug, variant_id)
            if not variant:
                return Response({"error": "Variant not found"}, status=status.HTTP_404_NOT_FOUND)
            if variant.draft_active_by_id == request.user.id:
                variant.draft_active_by = None
                variant.draft_active_at = None
                variant.save(update_fields=["draft_active_by", "draft_active_at", "updated_at"])
        return Response({"draft": variant_draft_info(variant)})


class ContractTemplateVariantDraftPublishEndpoint(FileLibraryBaseView):
    """Draft → revision N + new live source. Never renames an existing
    revision; identical content to the latest revision just drops the draft."""

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def post(self, request, slug, variant_id):
        name = str(request.data.get("name") or "").strip()[:255]
        variant = (
            ContractTemplateVariant.objects.select_related("source_asset", "template", "workspace", "draft_asset")
            .filter(id=variant_id, workspace__slug=slug)
            .first()
        )
        if not variant:
            return Response({"error": "Variant not found"}, status=status.HTTP_404_NOT_FOUND)
        conflict = _lock_conflict(variant, request.user)
        if conflict:
            return conflict
        uploaded = []
        try:
            draft_bytes = _draft_bytes(variant)
            draft_sha256 = hashlib.sha256(draft_bytes).hexdigest()
            live_bytes = _read_asset(variant.source_asset)
            try:
                old_schema = analyse_docx_variables(live_bytes)
                new_schema = analyse_docx_variables(draft_bytes)
            except Exception as exc:
                log_exception(exc)
                raise ContractInputError("invalid_docx", "The Word file could not be read")
            changes = schema_changes(old_schema, new_schema)
            latest = ContractTemplateRevision.objects.filter(variant=variant).order_by("-revision").first()
            draft_asset_id = variant.draft_asset_id

            if latest and latest.content_sha256 == draft_sha256:
                with transaction.atomic():
                    locked = _locked_variant(slug, variant_id)
                    if locked.draft_asset_id != draft_asset_id:
                        raise ContractInputError("no_draft", http_status=status.HTTP_409_CONFLICT)
                    if hashlib.sha256(live_bytes).hexdigest() != draft_sha256:
                        _overwrite_asset_content(locked.source_asset, draft_bytes)
                    _clear_draft(locked)
                _, _, manual_status = _manual_blueprint_for_revision(variant, latest)
                return Response(
                    {
                        "unchanged": True,
                        "revision": ContractTemplateRevisionSerializer(latest).data,
                        "variable_changes": changes,
                        "manual_fields_status": manual_status,
                        "manual_field_count": len(variant.signature_blueprint or []),
                        "template": _template_payload(variant.template_id),
                    }
                )

            pdf_bytes = _pdf_for_content(
                variant.workspace, draft_bytes, f"{variant.name}.docx", user=request.user, store=False
            )
            if not pdf_bytes:
                raise ContractInputError("conversion_failed")
            with transaction.atomic():
                locked = _locked_variant(slug, variant_id)
                if locked.draft_asset_id != draft_asset_id:
                    raise ContractInputError("no_draft", http_status=status.HTTP_409_CONFLICT)
                revision, _ = _create_revision(
                    locked, request.user, draft_bytes, name=name, track=uploaded, pdf_bytes=pdf_bytes
                )
                _overwrite_asset_content(locked.source_asset, draft_bytes)
                _clear_draft(locked)
        except ContractInputError as exc:
            _delete_uploaded(uploaded)
            return _input_error_response(exc)
        except Exception as exc:
            log_exception(exc)
            _delete_uploaded(uploaded)
            return _error("upload_failed")

        variant.refresh_from_db()
        _, _, manual_status = _manual_blueprint_for_revision(variant, revision)
        return Response(
            {
                "unchanged": False,
                "revision": ContractTemplateRevisionSerializer(revision).data,
                "variable_changes": changes,
                "manual_fields_status": manual_status,
                "manual_field_count": len(variant.signature_blueprint or []),
                "template": _template_payload(variant.template_id),
            },
            status=status.HTTP_201_CREATED,
        )


class ContractTemplateVariantDraftDiscardEndpoint(FileLibraryBaseView):
    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def post(self, request, slug, variant_id):
        with transaction.atomic():
            variant = _locked_variant(slug, variant_id)
            if not variant:
                return Response({"error": "Variant not found"}, status=status.HTTP_404_NOT_FOUND)
            if not variant.draft_asset_id:
                return _error("no_draft", status.HTTP_409_CONFLICT)
            conflict = _lock_conflict(variant, request.user)
            if conflict:
                return conflict
            _clear_draft(variant)
        return Response({"draft": None, "template": _template_payload(variant.template_id)})


class ContractTemplateVariantDraftAsVariantEndpoint(FileLibraryBaseView):
    """Save the draft as a new variant (with revision 1); the original
    variant's draft is dropped and its live document is untouched."""

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def post(self, request, slug, variant_id):
        name = str(request.data.get("name") or "").strip()[:255]
        if not name:
            return _error("name_required", detail="name is required")
        variant = (
            ContractTemplateVariant.objects.select_related("source_asset", "template", "workspace", "draft_asset")
            .filter(id=variant_id, workspace__slug=slug)
            .first()
        )
        if not variant:
            return Response({"error": "Variant not found"}, status=status.HTTP_404_NOT_FOUND)
        if variant.template.variants.filter(name=name).exists():
            return _error("variant_name_taken", status.HTTP_409_CONFLICT)
        conflict = _lock_conflict(variant, request.user)
        if conflict:
            return conflict
        uploaded = []
        try:
            draft_bytes = _draft_bytes(variant)
            draft_asset_id = variant.draft_asset_id
            pdf_bytes = _pdf_for_content(variant.workspace, draft_bytes, f"{name}.docx", user=request.user, store=False)
            if not pdf_bytes:
                raise ContractInputError("conversion_failed")
            with transaction.atomic():
                locked = _locked_variant(slug, variant_id)
                if locked.draft_asset_id != draft_asset_id:
                    raise ContractInputError("no_draft", http_status=status.HTTP_409_CONFLICT)
                source_asset = _create_asset(
                    workspace=locked.workspace,
                    user=request.user,
                    key=_asset_key(locked.workspace_id, "variants", "docx"),
                    name=f"{name}.docx",
                    mime_type=DOCX_MIME,
                    content=draft_bytes,
                    entity_type=FileAsset.EntityTypeContext.CONTRACT_TEMPLATE,
                    track=uploaded,
                )
                new_variant = ContractTemplateVariant.objects.create(
                    workspace=locked.workspace,
                    template=locked.template,
                    name=name,
                    source_asset=source_asset,
                    signature_blueprint=locked.signature_blueprint,
                    signature_blueprint_layout=locked.signature_blueprint_layout,
                    recipient_blueprint=locked.recipient_blueprint,
                    authoring_settings=locked.authoring_settings,
                    variable_settings=locked.variable_settings,
                    recipient_roles=locked.recipient_roles,
                    created_by=request.user,
                )
                revision, _ = _create_revision(
                    new_variant, request.user, draft_bytes, track=uploaded, pdf_bytes=pdf_bytes
                )
                _clear_draft(locked)
        except IntegrityError:
            _delete_uploaded(uploaded)
            return _error("variant_name_taken", status.HTTP_409_CONFLICT)
        except ContractInputError as exc:
            _delete_uploaded(uploaded)
            return _input_error_response(exc)
        except Exception as exc:
            log_exception(exc)
            _delete_uploaded(uploaded)
            return _error("upload_failed")
        return Response(
            {
                "variant_id": str(new_variant.id),
                "revision": ContractTemplateRevisionSerializer(revision).data,
                "template": _template_payload(variant.template_id),
            },
            status=status.HTTP_201_CREATED,
        )
