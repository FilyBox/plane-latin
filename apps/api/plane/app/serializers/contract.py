# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

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
    "periodo_coleccion",
    "collection_period_description",
    "collection_period_duration",
    "periodo_retencion",
    "retention_period_description",
    "retention_period_duration",
]


class ContractSerializer(BaseSerializer):
    file_name = serializers.SerializerMethodField()

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
        fields = ["id", "chat_id", "role", "content", "sources", "created_at"]
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


class ContractTemplateVariantSerializer(BaseSerializer):
    source_file_name = serializers.SerializerMethodField()
    revision_count = serializers.SerializerMethodField()
    latest_revision = serializers.SerializerMethodField()

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
            "created_at",
            "updated_at",
        ]
        read_only_fields = fields

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
            "signers",
            "signing_details",
            "created_at",
            "updated_at",
        ]
        read_only_fields = fields
