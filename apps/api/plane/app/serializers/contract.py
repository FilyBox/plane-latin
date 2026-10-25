# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Python imports
from datetime import timedelta

from django.utils import timezone

# Third party imports
from rest_framework import serializers

# Module imports
from plane.db.models import (
    Contract,
    ContractChat,
    ContractChatMessage,
    ContractProcessingJob,
    ContractQuery,
    ContractSignatureRequest,
    ContractSigner,
    ContractTemplate,
    ContractTemplateRevision,
    ContractTemplateVariant,
)

from .base import BaseSerializer

# AI-extracted fields the user can edit by hand (mirrors the crm-new schema)
CONTRACT_EDITABLE_FIELDS = [
    "titulo",
    "resumen_general",
    "nombre_grupo",
    "artistas",
    "testigos",
    "involucrados",
    "es_notariado",
    "fecha_inicio",
    "fecha_fin",
    "es_posible_expandirlo",
    "tiempo_extension_posible",
    "expansion_time_description",
    "fecha_fin_efectiva",
    "estatus_contrato",
    "tipo_contrato",
    "es_editorial",
    "periodo_coleccion",
    "collection_period_description",
    "collection_period_duration",
    "periodo_retencion",
    "retention_period_description",
    "retention_period_duration",
]


class ContractSerializer(BaseSerializer):
    file_name = serializers.SerializerMethodField()
    has_proposal = serializers.SerializerMethodField()
    days_to_expiry = serializers.SerializerMethodField()

    class Meta:
        model = Contract
        fields = [
            "id",
            "workspace_id",
            "file_asset_id",
            "thumbnail_asset_id",
            "file_name",
            "processing_status",
            "proposed_data",
            "has_proposal",
            "days_to_expiry",
            "ai_model_used",
            "processed_at",
            "text_extracted_at",
            *CONTRACT_EDITABLE_FIELDS,
            "created_at",
            "updated_at",
        ]
        read_only_fields = fields

    def get_file_name(self, obj):
        return (obj.file_asset.attributes or {}).get("name") if obj.file_asset_id else None

    def get_has_proposal(self, obj):
        return obj.proposed_data is not None

    def get_days_to_expiry(self, obj):
        if obj.fecha_fin_efectiva is None:
            return None
        today = self.context.get("today") or timezone.now().date()
        return (obj.fecha_fin_efectiva - today).days


class ContractDetailSerializer(ContractSerializer):
    proposed_changes = serializers.SerializerMethodField()
    source_template_id = serializers.SerializerMethodField()

    class Meta(ContractSerializer.Meta):
        fields = [
            *ContractSerializer.Meta.fields,
            "evidence",
            "proposed_changes",
            "source_request_id",
            "source_template_id",
            "content_hash",
        ]
        read_only_fields = fields

    def get_proposed_changes(self, obj):
        from plane.utils.contract_extraction import proposed_changes

        return proposed_changes(obj, obj.proposed_data) if obj.proposed_data is not None else []

    def get_source_template_id(self, obj):
        request = obj.source_request if obj.source_request_id else None
        if request is None or request.revision_id is None:
            return None
        return request.revision.variant.template_id


class ContractUpdateSerializer(BaseSerializer):
    class Meta:
        model = Contract
        fields = CONTRACT_EDITABLE_FIELDS


class ContractProcessingJobSerializer(BaseSerializer):
    class Meta:
        model = ContractProcessingJob
        fields = [
            "id",
            "workspace_id",
            "contract_id",
            "initiated_by_id",
            "task_type",
            "status",
            "progress",
            "current_stage",
            "workflow_instance_id",
            "error",
            "metadata",
            "started_at",
            "finished_at",
            "created_at",
            "updated_at",
        ]
        read_only_fields = fields


class ContractChatSerializer(BaseSerializer):
    class Meta:
        model = ContractChat
        fields = [
            "id",
            "workspace_id",
            "user_id",
            "title",
            "mode",
            "contract_id",
            "created_at",
            "updated_at",
        ]
        read_only_fields = fields


class ContractChatMessageSerializer(BaseSerializer):
    class Meta:
        model = ContractChatMessage
        fields = ["id", "chat_id", "role", "content", "sources", "parts", "created_at"]
        read_only_fields = fields


class ContractQuerySerializer(BaseSerializer):
    class Meta:
        model = ContractQuery
        fields = [
            "id",
            "workspace_id",
            "user_id",
            "query",
            "status",
            "result",
            "emailed_at",
            "job_id",
            "created_at",
        ]
        read_only_fields = fields


DRAFT_ACTIVE_SECONDS = 90


def _person_name(user):
    if user is None:
        return None
    full_name = f"{user.first_name or ''} {user.last_name or ''}".strip()
    return full_name or user.display_name or (user.email or "").split("@")[0]


def variant_draft_info(variant):
    """Draft state for the UI, or None. `changed` compares the draft's last
    saved content hash with the content it was copied from."""
    asset = variant.draft_asset if variant.draft_asset_id else None
    if asset is None or asset.deleted_at:
        return None
    active = bool(
        variant.draft_active_at
        and variant.draft_active_by_id
        and variant.draft_active_at > timezone.now() - timedelta(seconds=DRAFT_ACTIVE_SECONDS)
    )
    draft_sha256 = (asset.attributes or {}).get("content_sha256")
    return {
        "exists": True,
        "asset_id": str(asset.id),
        "started_by_name": _person_name(variant.draft_started_by),
        "started_at": variant.draft_started_at,
        "updated_at": variant.draft_updated_at,
        "active_by_id": str(variant.draft_active_by_id) if active else None,
        "active_by_name": _person_name(variant.draft_active_by) if active else None,
        "active_at": variant.draft_active_at if active else None,
        "changed": bool(draft_sha256 and variant.draft_base_sha256 and draft_sha256 != variant.draft_base_sha256),
    }


class ContractTemplateVariantSerializer(BaseSerializer):
    source_file_name = serializers.SerializerMethodField()
    revision_count = serializers.SerializerMethodField()
    latest_revision = serializers.SerializerMethodField()
    draft = serializers.SerializerMethodField()

    class Meta:
        model = ContractTemplateVariant
        fields = [
            "id",
            "workspace_id",
            "template_id",
            "name",
            "source_asset_id",
            "source_file_name",
            "revision_count",
            "latest_revision",
            "is_default",
            "signature_blueprint",
            "signature_blueprint_layout",
            "signature_blueprint_layout",
            "recipient_blueprint",
            "authoring_settings",
            "variable_settings",
            "recipient_roles",
            "draft",
            "created_at",
            "updated_at",
        ]
        read_only_fields = fields

    def get_draft(self, obj):
        return variant_draft_info(obj)

    def get_source_file_name(self, obj):
        return (obj.source_asset.attributes or {}).get("name")

    def get_revision_count(self, obj):
        return obj.revisions.count()

    def get_latest_revision(self, obj):
        revision = next(iter(obj.revisions.all()), None)
        if not revision:
            return None
        return {
            "id": revision.id,
            "revision": revision.revision,
            "content_sha256": revision.content_sha256,
            "created_at": revision.created_at,
        }


class ContractTemplateSerializer(BaseSerializer):
    variants = ContractTemplateVariantSerializer(many=True, read_only=True)

    class Meta:
        model = ContractTemplate
        fields = [
            "id",
            "workspace_id",
            "name",
            "description",
            "is_active",
            "variants",
            "created_at",
            "updated_at",
        ]
        read_only_fields = fields


class ContractTemplateRevisionSerializer(BaseSerializer):
    class Meta:
        model = ContractTemplateRevision
        fields = [
            "id",
            "workspace_id",
            "variant_id",
            "revision",
            "name",
            "source_asset_id",
            "pdf_asset_id",
            "content_sha256",
            "layout_signature",
            "variable_schema",
            "signature_blueprint",
            "recipient_blueprint",
            "authoring_settings",
            "created_at",
        ]
        read_only_fields = fields


class ContractSignerSerializer(BaseSerializer):
    class Meta:
        model = ContractSigner
        fields = [
            "id",
            "signature_request_id",
            "name",
            "email",
            "role",
            "signing_order",
            "status",
            "documenso_recipient_id",
            "created_at",
            "updated_at",
        ]
        read_only_fields = fields


class ContractSignatureRequestSerializer(BaseSerializer):
    signers = ContractSignerSerializer(many=True, read_only=True)
    revision = ContractTemplateRevisionSerializer(read_only=True)
    pdf_asset_id = serializers.SerializerMethodField()
    source_asset_id = serializers.SerializerMethodField()
    signing_details = serializers.SerializerMethodField()
    template_id = serializers.SerializerMethodField()
    template_name = serializers.SerializerMethodField()
    variant_id = serializers.SerializerMethodField()
    variant_name = serializers.SerializerMethodField()
    pending_signers = serializers.SerializerMethodField()

    def _variant(self, obj):
        revision = obj.revision
        return revision.variant if revision is not None else None

    def get_template_id(self, obj):
        variant = self._variant(obj)
        return str(variant.template_id) if variant else None

    def get_template_name(self, obj):
        variant = self._variant(obj)
        return variant.template.name if variant else None

    def get_variant_id(self, obj):
        variant = self._variant(obj)
        return str(variant.id) if variant else None

    def get_variant_name(self, obj):
        variant = self._variant(obj)
        return variant.name if variant else None

    def get_pending_signers(self, obj):
        return [
            {"name": signer.name, "email": signer.email, "status": signer.status}
            for signer in obj.signers.all()
            if signer.role not in ("CC", "VIEWER")
            and signer.status not in (ContractSigner.Status.SIGNED, ContractSigner.Status.REJECTED)
        ]

    def to_representation(self, instance):
        data = super().to_representation(instance)
        if instance.authoring_mode == ContractSignatureRequest.AuthoringMode.TEMPLATE:
            # Fields that come from {{...FirmanteN}} tokens are recomputed from
            # the Word file on every use, so the editor shows them locked.
            def lock(field):
                if isinstance(field, dict) and (field.get("fieldMeta") or {}).get("templateVariable"):
                    return {**field, "locked": True, "source": "template_variable"}
                return field

            data["fields"] = [lock(field) for field in data.get("fields") or []]
            data["recipients"] = [
                {**recipient, "fields": [lock(field) for field in recipient.get("fields") or []]}
                if isinstance(recipient, dict)
                else recipient
                for recipient in data.get("recipients") or []
            ]
        return data

    def get_pdf_asset_id(self, obj):
        return obj.rendered_pdf_asset_id or obj.revision.pdf_asset_id

    def get_source_asset_id(self, obj):
        return obj.rendered_source_asset_id or obj.revision.source_asset_id

    def get_signing_details(self, obj):
        return getattr(obj, "_signing_details", None)

    class Meta:
        model = ContractSignatureRequest
        fields = [
            "id",
            "workspace_id",
            "revision",
            "rendered_source_asset_id",
            "rendered_pdf_asset_id",
            "title",
            "authoring_mode",
            "status",
            "recipients",
            "fields",
            "authoring_settings",
            "variable_values",
            "preparation_warnings",
            "rendered_layout_signature",
            "documenso_envelope_id",
            "documenso_envelope_item_id",
            "source_asset_id",
            "pdf_asset_id",
            "signed_asset_id",
            "analysis_contract_id",
            "error",
            "sent_at",
            "completed_at",
            "expires_at",
            "last_reminded_at",
            "metadata",
            "template_id",
            "template_name",
            "variant_id",
            "variant_name",
            "pending_signers",
            "signers",
            "signing_details",
            "created_at",
            "updated_at",
        ]
        read_only_fields = fields
