# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

from contextlib import nullcontext
from unittest.mock import MagicMock

import pytest

from plane.app.views.contract.workflow import (
    _blueprint_for_layout,
    _delete_signature_requests,
    _normalise_authoring_draft,
    _normalise_authoring_payload,
    _normalise_authoring_settings,
    _pdf_layout_signature,
    _recipients_from_blueprint,
    _signing_details_from_envelope,
    _sync_signers_from_webhook,
    _signing_links_from_envelope,
)
from plane.db.models import ContractSigner
from plane.settings.storage import S3Storage


def test_normalise_authoring_payload_clamps_coordinates():
    result = _normalise_authoring_payload(
        [
            {
                "name": "Persona Firmante",
                "email": "firma@example.com",
                "role": "signer",
                "fields": [
                    {
                        "type": "signature",
                        "page": 1,
                        "positionX": -5,
                        "positionY": 120,
                        "width": 150,
                        "height": 0,
                    }
                ],
            }
        ]
    )

    assert result[0]["role"] == "SIGNER"
    assert result[0]["signingOrder"] == 1
    assert result[0]["fields"][0] == {
        "identifier": 0,
        "type": "SIGNATURE",
        "page": 1,
        "positionX": 0,
        "positionY": 100,
        "width": 100,
        "height": 1,
        "fieldMeta": {"type": "signature"},
    }


def test_signer_requires_a_signature_field():
    with pytest.raises(ValueError, match="requires at least one signature field"):
        _normalise_authoring_payload(
            [{"name": "Persona Firmante", "email": "firma@example.com", "role": "SIGNER", "fields": []}]
        )


def test_non_signing_recipient_fields_are_ignored():
    result = _normalise_authoring_payload(
        [
            {
                "name": "Persona en copia",
                "email": "copia@example.com",
                "role": "CC",
                "fields": [
                    {
                        "type": "SIGNATURE",
                        "page": 1,
                        "positionX": 10,
                        "positionY": 10,
                        "width": 20,
                        "height": 5,
                    }
                ],
            }
        ]
    )

    assert result[0]["fields"] == []


def test_authoring_draft_allows_incomplete_recipients_and_clamps_fields():
    result = _normalise_authoring_draft(
        [
            {
                "name": "",
                "email": "",
                "role": "signer",
                "fields": [
                    {
                        "type": "date",
                        "page": 0,
                        "positionX": -5,
                        "positionY": 110,
                        "width": 150,
                        "height": 0,
                    }
                ],
            }
        ]
    )

    assert result[0]["name"] == ""
    assert result[0]["email"] == ""
    assert result[0]["signingOrder"] == 1
    assert result[0]["fields"][0] == {
        "identifier": 0,
        "type": "DATE",
        "page": 1,
        "positionX": 0,
        "positionY": 100,
        "width": 100,
        "height": 1,
        "fieldMeta": {"type": "date"},
    }


def test_advanced_field_meta_and_assistant_are_preserved():
    result = _normalise_authoring_payload(
        [
            {
                "name": "Asistente",
                "email": "assistant@example.com",
                "role": "ASSISTANT",
                "fields": [
                    {
                        "type": "CHECKBOX",
                        "page": 1,
                        "positionX": 10,
                        "positionY": 20,
                        "width": 25,
                        "height": 8,
                        "fieldMeta": {
                            "label": "Opciones",
                            "required": True,
                            "direction": "horizontal",
                            "values": [
                                {"id": 3, "checked": True, "value": "A"},
                                {"id": 4, "checked": False, "value": "B"},
                            ],
                        },
                    }
                ],
            },
            {"name": "Visor", "email": "viewer@example.com", "role": "VIEWER", "fields": []},
        ]
    )

    assert result[0]["role"] == "ASSISTANT"
    assert result[0]["fields"][0]["fieldMeta"] == {
        "type": "checkbox",
        "label": "Opciones",
        "required": True,
        "direction": "horizontal",
        "values": [
            {"id": 3, "checked": True, "value": "A"},
            {"id": 4, "checked": False, "value": "B"},
        ],
    }


def test_assistant_cannot_be_last_recipient():
    with pytest.raises(ValueError, match="cannot be the last"):
        _normalise_authoring_payload(
            [{"name": "Asistente", "email": "assistant@example.com", "role": "ASSISTANT", "fields": []}]
        )


def test_authoring_settings_keep_email_reminders_and_signature_methods():
    result = _normalise_authoring_settings(
        {
            "subject": "Firma de {{document.name}}",
            "signingOrder": "SEQUENTIAL",
            "typedSignatureEnabled": False,
            "drawSignatureEnabled": True,
            "uploadSignatureEnabled": False,
            "emailSettings": {"recipientSigningRequest": False},
            "reminderSettings": {
                "sendAfter": {"unit": "week", "amount": 1},
                "repeatEvery": {"disabled": True},
            },
        }
    )

    assert result["subject"] == "Firma de {{document.name}}"
    assert result["signingOrder"] == "SEQUENTIAL"
    assert result["typedSignatureEnabled"] is False
    assert result["drawSignatureEnabled"] is True
    assert result["emailSettings"]["recipientSigningRequest"] is False
    assert result["reminderSettings"]["sendAfter"] == {"unit": "week", "amount": 1}
    assert result["reminderSettings"]["repeatEvery"] == {"disabled": True}


def test_pdf_layout_signature_uses_geometry_not_content():
    first = b"/Type /Page /MediaBox [0 0 612 792] (first header)"
    second = b"/Type /Page /MediaBox [0 0 612 792] (different header)"

    assert _pdf_layout_signature(first) == _pdf_layout_signature(second)


def test_blueprint_is_only_reused_for_the_same_layout():
    blueprint = [{"recipient_index": 0, "type": "SIGNATURE"}]
    layout = {"page_count": 1, "media_boxes": [[0, 0, 612, 792]]}

    assert _blueprint_for_layout(blueprint, layout, layout) == blueprint
    assert (
        _blueprint_for_layout(
            blueprint,
            layout,
            {"page_count": 2, "media_boxes": [[0, 0, 612, 792], [0, 0, 612, 792]]},
        )
        == []
    )


def test_template_recipient_blueprint_restores_roles_and_mapped_fields():
    variant = MagicMock(
        recipient_blueprint=[
            {"placeholderLabel": "Cliente", "role": "SIGNER", "signingOrder": 1},
            {"placeholderLabel": "Representante", "role": "APPROVER", "signingOrder": 2},
        ]
    )
    fields = [
        {
            "recipient_index": 0,
            "type": "SIGNATURE",
            "page": 1,
            "positionX": 10,
            "positionY": 20,
            "width": 25,
            "height": 6,
            "fieldMeta": {"type": "signature"},
        },
        {
            "recipient_index": 1,
            "type": "TEXT",
            "page": 1,
            "positionX": 10,
            "positionY": 30,
            "width": 25,
            "height": 6,
            "fieldMeta": {"type": "text", "label": "Puesto"},
        },
    ]

    result = _recipients_from_blueprint(variant, fields)

    assert [recipient["placeholderLabel"] for recipient in result] == ["Cliente", "Representante"]
    assert [recipient["role"] for recipient in result] == ["SIGNER", "APPROVER"]
    assert result[0]["fields"][0]["type"] == "SIGNATURE"
    assert result[1]["fields"][0]["fieldMeta"]["label"] == "Puesto"
    assert all("recipient_index" not in field for recipient in result for field in recipient["fields"])


def test_signing_links_use_public_documenso_url_and_exclude_cc(settings):
    settings.DOCUMENSO_URL = "https://sign.example.com/"

    result = _signing_links_from_envelope(
        {
            "recipients": [
                {
                    "id": 10,
                    "name": "Firmante",
                    "email": "signer@example.com",
                    "role": "SIGNER",
                    "signingOrder": 1,
                    "token": "signing-token",
                },
                {
                    "id": 11,
                    "name": "Copia",
                    "email": "copy@example.com",
                    "role": "CC",
                    "signingOrder": 2,
                    "token": "copy-token",
                },
            ]
        }
    )

    assert result == [
        {
            "id": 10,
            "name": "Firmante",
            "email": "signer@example.com",
            "role": "SIGNER",
            "signing_order": 1,
            "url": "https://sign.example.com/sign/signing-token",
        }
    ]


def test_signing_details_expose_recipient_progress_and_completed_values():
    result = _signing_details_from_envelope(
        {
            "status": "PENDING",
            "recipients": [
                {
                    "id": 20,
                    "name": "Ana",
                    "email": "ana@example.com",
                    "role": "SIGNER",
                    "signingOrder": 1,
                    "signingStatus": "SIGNED",
                    "readStatus": "OPENED",
                    "sendStatus": "SENT",
                    "signedAt": "2026-08-01T10:00:00Z",
                }
            ],
            "fields": [
                {
                    "id": 30,
                    "recipientId": 20,
                    "type": "NAME",
                    "page": 1,
                    "customText": "Ana Pérez",
                    "inserted": True,
                    "fieldMeta": {"label": "Nombre legal"},
                },
                {
                    "id": 31,
                    "recipientId": 20,
                    "type": "SIGNATURE",
                    "page": 2,
                    "inserted": True,
                    "fieldMeta": {},
                },
            ],
        }
    )

    assert result["recipients"][0]["signing_status"] == "SIGNED"
    assert result["fields"][0]["label"] == "Nombre legal"
    assert result["fields"][0]["value"] == "Ana Pérez"
    assert result["fields"][1]["value"] == "Completado"


def test_webhook_recipient_state_updates_plane_signer():
    signature_request = MagicMock()

    _sync_signers_from_webhook(
        signature_request,
        {
            "recipients": [
                {
                    "email": "firma@example.com",
                    "signingStatus": "SIGNED",
                    "readStatus": "OPENED",
                    "sendStatus": "SENT",
                }
            ]
        },
    )

    signature_request.signers.filter.assert_called_once_with(email="firma@example.com")
    signature_request.signers.filter.return_value.update.assert_called_once_with(status=ContractSigner.Status.SIGNED)


def test_storage_keeps_internal_minio_endpoint_when_request_is_present(monkeypatch):
    monkeypatch.setenv("USE_MINIO", "1")
    monkeypatch.setenv("AWS_S3_ENDPOINT_URL", "http://plane-minio:9000")
    monkeypatch.setenv("AWS_S3_PUBLIC_ENDPOINT_URL", "http://localhost:9000")

    endpoints = []

    def fake_client(*args, **kwargs):
        endpoints.append(kwargs.get("endpoint_url"))
        return MagicMock()

    monkeypatch.setattr("plane.settings.storage.boto3.client", fake_client)
    request = MagicMock(scheme="http")
    request.get_host.return_value = "localhost:8000"

    S3Storage(request=request, bucket_name="plane-contracts")

    assert endpoints == ["http://plane-minio:9000", "http://localhost:9000"]


def test_signature_request_delete_requires_analysis_when_signed_file_is_deleted():
    signature_request = MagicMock(analysis_contract_id="analysis-id")

    with pytest.raises(ValueError, match="requires deleting their AI analysis"):
        _delete_signature_requests([signature_request], delete_files=True, delete_analysis=False)


def test_signature_request_delete_purges_selected_data(monkeypatch):
    def asset(asset_id, name):
        result = MagicMock()
        result.id = asset_id
        result.asset.name = name
        return result

    rendered_source = asset("source", "rendered.docx")
    rendered_pdf = asset("unsigned", "unsigned.pdf")
    signed_pdf = asset("signed", "signed.pdf")
    thumbnail = asset("thumbnail", "thumbnail.png")
    analysis_contract = MagicMock(id="analysis", thumbnail_asset=thumbnail)
    signature_request = MagicMock(
        id="request",
        rendered_source_asset=rendered_source,
        rendered_pdf_asset=rendered_pdf,
        signed_asset=signed_pdf,
        analysis_contract=analysis_contract,
        analysis_contract_id="analysis",
    )
    storage = MagicMock()
    storage.delete_files.return_value = True
    monkeypatch.setattr("plane.app.views.contract.workflow.S3Storage.for_asset", lambda _asset: storage)
    monkeypatch.setattr("plane.app.views.contract.workflow.transaction.atomic", nullcontext)

    result = _delete_signature_requests([signature_request], delete_files=True, delete_analysis=True)

    assert result == {
        "deleted": ["request"],
        "files_deleted": 4,
        "analyses_deleted": 1,
    }
    assert storage.delete_files.call_count == 4
    analysis_contract.delete.assert_called_once_with(soft=False)
    signature_request.delete.assert_called_once_with(soft=False)
    for deleted_asset in (rendered_source, rendered_pdf, signed_pdf, thumbnail):
        deleted_asset.delete.assert_called_once_with(soft=False)
