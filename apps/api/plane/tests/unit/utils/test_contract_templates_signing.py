# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Contract templates (drafts, revisions, warnings, field placement), WOPI
hardening and Documenso signing state. Storage, Collabora and Documenso are
replaced by in-memory fakes."""

import hashlib
from datetime import timedelta
from io import BytesIO
from unittest import mock
from zipfile import ZipFile

import pytest
from django.test import override_settings
from django.utils import timezone

from plane.app.views.contract import template_drafts, workflow
from plane.app.views.file_library.collabora import mark_content_changed, mint_access_token
from plane.db.models import (
    ContractSignatureRequest,
    ContractSigner,
    ContractTemplate,
    ContractTemplateRevision,
    ContractTemplateVariant,
    ContractWebhookEvent,
    FileAsset,
    WorkspaceFeature,
)
from plane.integrations.contract_docx import (
    analyse_docx_variables,
    analyse_docx_warnings,
    format_variable_value,
    place_auto_fields,
    schema_summary,
)

Status = ContractSignatureRequest.Status
WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def make_docx(*paragraphs):
    body = "".join(f'<w:p><w:r><w:t xml:space="preserve">{text}</w:t></w:r></w:p>' for text in paragraphs)
    xml = f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="{WORD_NS}"><w:body>{body}</w:body></w:document>'
    output = BytesIO()
    with ZipFile(output, "w") as archive:
        archive.writestr("[Content_Types].xml", "<Types/>")
        archive.writestr("word/document.xml", xml)
    return output.getvalue()


@pytest.fixture
def file_library_enabled(workspace):
    WorkspaceFeature.objects.create(workspace=workspace, key=WorkspaceFeature.FeatureKey.FILE_LIBRARY, is_enabled=True)


@pytest.fixture
def store(monkeypatch):
    """In-memory object store standing in for MinIO + Collabora."""
    objects = {}

    def create_asset(
        *, workspace, user, key, name, mime_type, content, entity_type, track=None, entity_identifier=None
    ):
        objects[key] = content
        if track is not None:
            track.append(key)
        return FileAsset.objects.create(
            workspace=workspace,
            user=user,
            asset=key,
            attributes={"name": name, "type": mime_type, "content_sha256": hashlib.sha256(content).hexdigest()},
            entity_type=entity_type,
            entity_identifier=entity_identifier,
            size=len(content),
            is_uploaded=True,
        )

    def read_asset(asset):
        return objects[asset.asset.name]

    def overwrite(asset, content):
        objects[asset.asset.name] = content
        mark_content_changed(asset, content)

    def pdf_for_content(workspace, content, name, user=None, store=True, source_asset=None):
        return b"%PDF-1.4 fake"

    for module in (workflow, template_drafts):
        monkeypatch.setattr(module, "_create_asset", create_asset, raising=False)
        monkeypatch.setattr(module, "_read_asset", read_asset, raising=False)
        monkeypatch.setattr(module, "_overwrite_asset_content", overwrite, raising=False)
        monkeypatch.setattr(module, "_pdf_for_content", pdf_for_content, raising=False)
        monkeypatch.setattr(module, "_delete_uploaded", lambda keys: None, raising=False)
    monkeypatch.setattr(template_drafts, "_dispose_draft_asset", lambda asset_id: None)
    monkeypatch.setattr(workflow, "S3Storage", mock.MagicMock())
    return objects


ORIGINAL = make_docx("Contrato con {{NombreCliente}}", "Firma: {{FirmaFirmante1}}")


@pytest.fixture
def template(workspace, create_user, store):
    source = workflow._create_asset(
        workspace=workspace,
        user=create_user,
        key="contracts/test/source.docx",
        name="source.docx",
        mime_type=workflow.DOCX_MIME,
        content=ORIGINAL,
        entity_type=FileAsset.EntityTypeContext.CONTRACT_TEMPLATE,
    )
    item = ContractTemplate.objects.create(workspace=workspace, name="Servicios")
    variant = ContractTemplateVariant.objects.create(
        workspace=workspace, template=item, name="Principal", source_asset=source, is_default=True
    )
    revision, _ = workflow._create_revision(variant, create_user, ORIGINAL, name="Original")
    return {"template": item, "variant": variant, "revision": revision}


@pytest.mark.unit
class TestWarningsAndSummary:
    def test_reserved_space_gap_and_missing_signature(self):
        docx = make_docx(
            "Fecha {{FechaFirma}} y {{Firma}}",
            "Cliente {{Nombre Cliente}}",
            "{{NombreFirmante3}} {{FirmaFirmante3}}",
            "{{CorreoFirmante2}}",
        )
        schema = analyse_docx_variables(docx)
        # Classification is unchanged: bare FechaFirma is still signer 1's date.
        reserved = next(item for item in schema["signing_fields"] if item["key"] == "FechaFirma")
        assert reserved["type"] == "DATE" and reserved["recipient_index"] == 0

        warnings = {(item["code"], item["token"]): item["params"] for item in analyse_docx_warnings(docx, schema)}
        assert warnings[("reserved_token", "FechaFirma")] == {
            "field_type": "DATE",
            "recipient_index": 0,
            "suggestion": "FechaContrato",
        }
        assert ("reserved_token", "Firma") in warnings
        assert warnings[("space_in_name", "Nombre Cliente")]["suggestion"] == "NombreCliente"
        assert ("signer_gap", "Firmante1") not in warnings  # signer 1 exists via {{Firma}}
        assert ("signer_without_signature", "Firmante2") in warnings
        assert ("signer_without_signature", "Firmante3") not in warnings

    def test_gap_when_middle_signer_missing(self):
        docx = make_docx("{{FirmaFirmante1}} {{FirmaFirmante3}}")
        codes = [(item["code"], item["params"]) for item in analyse_docx_warnings(docx)]
        assert ("signer_gap", {"missing_index": 1, "max_index": 2}) in codes

    def test_manual_signature_field_silences_warning(self):
        docx = make_docx("{{NombreFirmante1}}")
        assert analyse_docx_warnings(docx)[0]["code"] == "signer_without_signature"
        manual = [{"type": "SIGNATURE", "recipient_index": 0}]
        assert analyse_docx_warnings(docx, manual_fields=manual) == []

    def test_summary_counts_unique_items(self):
        docx = make_docx(
            "{{Ciudad}} {{Ciudad}} {{Monto}}", "{{FirmaFirmante1}} {{FirmaFirmante1}} {{FechaFirmaFirmante2}}"
        )
        schema = analyse_docx_variables(docx)
        assert schema_summary(schema) == {"data_count": 2, "signer_count": 2, "signing_field_count": 2}

    def test_labels_get_accents(self):
        schema = analyse_docx_variables(make_docx("{{DuracionMeses}} {{NumeroCodigo}}"))
        labels = {item["key"]: item["label"] for item in schema["variables"]}
        assert labels["DuracionMeses"] == "Duración meses"
        assert labels["NumeroCodigo"] == "Número código"


@pytest.mark.unit
class TestValueFormatting:
    def test_dates_long_spanish_unless_iso(self):
        assert format_variable_value("2026-10-25", "date") == "25 de octubre de 2026"
        assert format_variable_value("2026-10-25", "date", {"date_format": "iso"}) == "2026-10-25"
        assert format_variable_value("mañana", "date") == "mañana"

    def test_numbers_only_when_configured(self):
        assert format_variable_value("0123456789", "number") == "0123456789"
        assert format_variable_value("12500", "text", {"type": "currency"}) == "$12,500.00"
        assert format_variable_value("1250", "text", {"type": "number"}) == "1,250"


@pytest.mark.unit
class TestAutoFieldPlacement:
    PAGE = {"page_width": 612.0, "page_height": 792.0}

    def item(self, kind, x0, y0, x1, y1, page=1):
        return {"type": kind, "page": page, "x0": x0, "y0": y0, "x1": x1, "y1": y1, **self.PAGE}

    @staticmethod
    def box(placement):
        x = placement["positionX"] * 612 / 100
        y = placement["positionY"] * 792 / 100
        return x, y, x + placement["width"] * 612 / 100, y + placement["height"] * 792 / 100

    def test_fields_on_one_line_do_not_overlap(self):
        items = [
            self.item("SIGNATURE", 72, 500, 120, 512),
            self.item("DATE", 130, 500, 170, 512),
            self.item("SIGNATURE", 72, 514, 120, 526),
        ]
        boxes = [self.box(placement) for placement in place_auto_fields(items)]
        for index, left in enumerate(boxes):
            for right in boxes[index + 1 :]:
                overlap = not (left[2] <= right[0] or right[2] <= left[0] or left[3] <= right[1] or right[3] <= left[1])
                assert not overlap, (left, right)

    def test_field_keeps_the_token_line(self):
        signature, text = place_auto_fields(
            [self.item("SIGNATURE", 72, 500, 120, 512), self.item("TEXT", 300, 600, 340, 612)]
        )
        x0, y0, x1, y1 = self.box(signature)
        assert y0 < 512 <= y1 <= 516  # sits on the line, grows upwards
        assert y1 - y0 < 40  # not the old 5%-of-page block
        tx0, ty0, tx1, ty1 = self.box(text)
        assert ty0 <= 606 <= ty1 and ty1 - ty0 < 20

    def test_fields_stay_on_the_page(self):
        (placement,) = place_auto_fields([self.item("SIGNATURE", 590, 2, 610, 10)])
        assert placement["positionX"] + placement["width"] <= 100.0001
        assert placement["positionY"] >= 0


@pytest.mark.unit
@pytest.mark.django_db
class TestRevisionNumbering:
    def test_numbers_follow_the_highest_revision(self, template, create_user):
        variant = template["variant"]
        assert template["revision"].revision == 1
        second, created = workflow._create_revision(variant, create_user, make_docx("v2"))
        assert created and second.revision == 2
        ContractTemplateRevision.objects.filter(id=second.id).update(revision=5)
        third, _ = workflow._create_revision(variant, create_user, make_docx("v3"))
        assert third.revision == 6

    def test_same_content_creates_a_new_revision_without_renaming(self, template, create_user):
        again, created = workflow._create_revision(template["variant"], create_user, ORIGINAL, name="Copia")
        assert created and again.revision == 2
        template["revision"].refresh_from_db()
        assert template["revision"].name == "Original"


@pytest.mark.unit
@pytest.mark.django_db
class TestDrafts:
    @pytest.fixture(autouse=True)
    def editor(self, monkeypatch):
        monkeypatch.setattr(
            template_drafts,
            "build_editor_session",
            lambda asset, user, mode, origin=None: ({"asset_id": str(asset.id), "mode": mode, "origin": origin}, None),
        )

    def url(self, workspace, variant, action=""):
        return f"/api/workspaces/{workspace.slug}/contract-variants/{variant.id}/draft/{action}"

    def save_in_word(self, store, variant, content):
        variant.refresh_from_db()
        store[variant.draft_asset.asset.name] = content
        mark_content_changed(variant.draft_asset, content)

    def test_publish_creates_next_revision_and_updates_live(
        self, session_client, workspace, file_library_enabled, template, store
    ):
        variant = template["variant"]
        response = session_client.post(self.url(workspace, variant))
        assert response.status_code == 201
        assert response.data["editor"]["mode"] == "write"
        assert response.data["draft"]["changed"] is False

        edited = make_docx("Contrato con {{NombreCliente}} en {{Ciudad}}", "{{FirmaFirmante1}} {{FirmaFirmante2}}")
        self.save_in_word(store, variant, edited)
        assert session_client.post(self.url(workspace, variant)).data["draft"]["changed"] is True

        # The published document is untouched while editing.
        assert store[variant.source_asset.asset.name] == ORIGINAL

        response = session_client.post(self.url(workspace, variant, "publish/"), {"name": "Con ciudad"}, format="json")
        assert response.status_code == 201, response.data
        assert response.data["revision"]["revision"] == 2
        assert response.data["revision"]["name"] == "Con ciudad"
        assert response.data["variable_changes"] == {
            "added": ["Ciudad"],
            "removed": [],
            "signers_added": [1],
            "signers_removed": [],
        }
        variant.refresh_from_db()
        assert variant.draft_asset_id is None
        assert store[variant.source_asset.asset.name] == edited
        template["revision"].refresh_from_db()
        assert template["revision"].name == "Original"

    def test_schema_reads_the_draft_and_falls_back_to_live(
        self, session_client, workspace, file_library_enabled, template, store
    ):
        variant = template["variant"]
        url = f"/api/workspaces/{workspace.slug}/contract-variants/{variant.id}/schema/?source=draft"
        assert session_client.get(url).data["source"]["kind"] == "CURRENT"
        session_client.post(self.url(workspace, variant), HTTP_ORIGIN="http://localhost:3100")
        self.save_in_word(store, variant, make_docx("{{Pais}} {{Firma}}"))
        data = session_client.get(url).data
        assert data["source"]["kind"] == "DRAFT"
        assert [item["key"] for item in data["schema"]["variables"]] == ["Pais"]
        assert data["warnings"][0]["code"] == "reserved_token"

    def test_publish_unchanged_only_drops_the_draft(
        self, session_client, workspace, file_library_enabled, template, store
    ):
        variant = template["variant"]
        session_client.post(self.url(workspace, variant))
        response = session_client.post(self.url(workspace, variant, "publish/"), {}, format="json")
        assert response.status_code == 200 and response.data["unchanged"] is True
        assert ContractTemplateRevision.objects.filter(variant=variant).count() == 1
        variant.refresh_from_db()
        assert variant.draft_asset_id is None

    def test_publish_matching_an_old_revision_never_renames_it(
        self, session_client, workspace, file_library_enabled, template, store, create_user
    ):
        variant = template["variant"]
        workflow._create_revision(variant, create_user, make_docx("segunda"), name="Segunda")
        session_client.post(self.url(workspace, variant))
        self.save_in_word(store, variant, ORIGINAL)  # same bytes as revision 1
        response = session_client.post(self.url(workspace, variant, "publish/"), {"name": "Vuelta"}, format="json")
        assert response.status_code == 201
        assert response.data["revision"]["revision"] == 3
        template["revision"].refresh_from_db()
        assert template["revision"].name == "Original"

    def test_second_editor_is_locked_out(
        self, session_client, workspace, file_library_enabled, template, store, create_user
    ):
        from plane.db.models import User, WorkspaceMember

        other = User.objects.create(email="otra@plane.so", username="otra", first_name="Ana", last_name="Pérez")
        WorkspaceMember.objects.create(workspace=workspace, member=other, role=20)
        variant = template["variant"]
        session_client.post(self.url(workspace, variant))
        session_client.force_authenticate(user=other)
        response = session_client.post(self.url(workspace, variant))
        assert response.status_code == 409
        assert response.data["error"] == "draft_locked"
        assert response.data["by_name"] == "Test User"
        # Stale heartbeat frees it.
        ContractTemplateVariant.objects.filter(id=variant.id).update(
            draft_active_at=timezone.now() - timedelta(seconds=120)
        )
        assert session_client.post(self.url(workspace, variant)).status_code == 200

    def test_discard_and_as_variant(self, session_client, workspace, file_library_enabled, template, store):
        variant = template["variant"]
        session_client.post(self.url(workspace, variant))
        response = session_client.post(self.url(workspace, variant, "discard/"))
        assert response.status_code == 200
        assert session_client.post(self.url(workspace, variant, "discard/")).data["error"] == "no_draft"

        session_client.post(self.url(workspace, variant))
        self.save_in_word(store, variant, make_docx("Variante {{Pais}}"))
        response = session_client.post(self.url(workspace, variant, "as-variant/"), {"name": "Inglés"}, format="json")
        assert response.status_code == 201, response.data
        new_variant = ContractTemplateVariant.objects.get(id=response.data["variant_id"])
        assert new_variant.revisions.count() == 1
        assert store[new_variant.source_asset.asset.name] == make_docx("Variante {{Pais}}")
        variant.refresh_from_db()
        assert variant.draft_asset_id is None
        assert store[variant.source_asset.asset.name] == ORIGINAL


@pytest.mark.unit
@pytest.mark.django_db
class TestWopi:
    @pytest.fixture
    def asset(self, workspace, create_user):
        return FileAsset.objects.create(
            workspace=workspace,
            asset="contracts/test/draft.docx",
            attributes={"name": "draft.docx", "type": workflow.DOCX_MIME},
            entity_type=FileAsset.EntityTypeContext.CONTRACT_TEMPLATE,
            created_by=create_user,
            is_uploaded=True,
        )

    @pytest.fixture(autouse=True)
    def s3(self):
        with mock.patch("plane.app.views.file_library.collabora.S3Storage") as storage:
            storage.for_asset.return_value.upload_file.return_value = True
            yield storage

    def put(self, client, asset, token, timestamp=None):
        headers = {"HTTP_X_COOL_WOPI_TIMESTAMP": timestamp} if timestamp else {}
        return client.post(
            f"/wopi/files/{asset.id}/contents?access_token={token}",
            data=b"PK new bytes",
            content_type="application/octet-stream",
            **headers,
        )

    def test_read_token_cannot_save(self, api_client, asset, create_user):
        token = mint_access_token(asset.id, create_user.id, False, mode="read")
        assert self.put(api_client, asset, token).status_code == 401

    def test_stale_timestamp_is_a_conflict(self, api_client, asset, create_user):
        token = mint_access_token(asset.id, create_user.id, True, mode="write")
        info = api_client.get(f"/wopi/files/{asset.id}?access_token={token}").data
        assert info["UserCanWrite"] is True and info["SupportsUpdate"] and info["SupportsLocks"]
        assert info["UserFriendlyName"] == "Test User"
        assert info["PostMessageOrigin"]

        response = self.put(api_client, asset, token, timestamp="2001-01-01T00:00:00+00:00")
        assert response.status_code == 409 and response.data == {"COOLStatusCode": 1010}

        response = self.put(api_client, asset, token, timestamp=info["LastModifiedTime"])
        assert response.status_code == 200
        assert response.data["LastModifiedTime"] != info["LastModifiedTime"]
        # The old timestamp is now stale.
        assert self.put(api_client, asset, token, timestamp=info["LastModifiedTime"]).status_code == 409

    def test_old_tokens_without_mode_still_work(self, api_client, asset, create_user):
        import jwt
        from django.conf import settings

        token = jwt.encode(
            {
                "asset_id": str(asset.id),
                "user_id": str(create_user.id),
                "can_write": True,
                "exp": timezone.now() + timedelta(hours=1),
            },
            settings.SECRET_KEY,
            algorithm="HS256",
        )
        assert self.put(api_client, asset, token).status_code == 200

    @override_settings(CORS_ALLOWED_ORIGINS=["http://localhost:3100"])
    def test_post_message_origin_comes_from_the_trusted_web_origin(self, api_client, asset, create_user):
        from plane.app.views.file_library.collabora import request_origin

        token = mint_access_token(asset.id, create_user.id, True, mode="write", origin="http://localhost:3100")
        info = api_client.get(f"/wopi/files/{asset.id}?access_token={token}").data
        assert info["PostMessageOrigin"] == "http://localhost:3100"
        trusted = mock.Mock(headers={"Origin": "http://localhost:3100"})
        untrusted = mock.Mock(headers={"Origin": "https://evil.example"})
        assert request_origin(trusted) == "http://localhost:3100"
        assert request_origin(untrusted) is None

    def test_revision_assets_open_read_only(self, template, create_user):
        from plane.app.views.file_library.collabora import session_mode_for

        assert session_mode_for(template["revision"].source_asset, create_user) == "read"
        assert session_mode_for(template["variant"].source_asset, create_user) == "write"


def envelope(status="PENDING", **recipient):
    base = {"id": 7, "email": "ana@empresa.com", "role": "SIGNER", "signingStatus": "NOT_SIGNED"}
    return {"id": "env_1", "status": status, "recipients": [{**base, **recipient}]}


@pytest.mark.unit
class TestEnvelopeStatus:
    @pytest.mark.parametrize(
        "local,env,expected",
        [
            (Status.PENDING, envelope("COMPLETED"), Status.COMPLETED),
            (Status.PENDING, envelope("CANCELLED"), Status.CANCELLED),
            (Status.PENDING, envelope("REJECTED"), Status.REJECTED),
            (Status.PENDING, envelope("PENDING", signingStatus="REJECTED"), Status.REJECTED),
            (Status.PENDING, envelope("PENDING", expiresAt="2001-01-01T00:00:00Z"), Status.EXPIRED),
            (Status.PENDING, envelope("PENDING", expirationNotifiedAt="2026-01-01T00:00:00Z"), Status.EXPIRED),
            (Status.PENDING, envelope("PENDING", expiresAt="2999-01-01T00:00:00Z"), Status.PENDING),
            (
                Status.PENDING,
                envelope("PENDING", signingStatus="SIGNED", expiresAt="2001-01-01T00:00:00Z"),
                Status.PENDING,
            ),
            (Status.PREPARING, envelope("PENDING"), Status.PENDING),
            (Status.READY, envelope("DRAFT"), Status.READY),
            (Status.CANCELLED, envelope("PENDING"), Status.CANCELLED),
            (Status.COMPLETED, envelope("PENDING"), Status.COMPLETED),
        ],
    )
    def test_mapping(self, local, env, expected):
        assert workflow.envelope_request_status(local, env) == expected

    def test_webhook_key_ignores_timestamps(self):
        first = {**envelope(), "createdAt": "2026-10-25T10:00:00Z", "updatedAt": "2026-10-25T10:00:00Z"}
        second = {**envelope(), "createdAt": "2026-10-25T11:00:00Z", "updatedAt": "2026-10-25T12:00:00Z"}
        assert workflow.webhook_event_key("DOCUMENT_SIGNED", first) == workflow.webhook_event_key(
            "DOCUMENT_SIGNED", second
        )
        signed = envelope(signingStatus="SIGNED")
        assert workflow.webhook_event_key("DOCUMENT_SIGNED", first) != workflow.webhook_event_key(
            "DOCUMENT_SIGNED", signed
        )
        assert workflow.webhook_event_key("DOCUMENT_SIGNED", first) != workflow.webhook_event_key(
            "DOCUMENT_OPENED", first
        )


def fake_documenso(existing=None):
    class FakeDocumenso:
        calls = []
        envelopes = {}

        def __init__(self):
            if existing:
                self.envelopes[existing["id"]] = existing

        def find_envelope_by_external_id(self, external_id):
            self.calls.append("find")
            return existing

        def create_envelope(self, **kwargs):
            self.calls.append("create")
            item = {
                "id": "env_new",
                "status": "DRAFT",
                "externalId": kwargs["external_id"],
                "envelopeItems": [{"id": "item_1"}],
                "recipients": [
                    {"id": 1, "email": r["email"], "role": r["role"], "signingStatus": "NOT_SIGNED"}
                    for r in kwargs["recipients"]
                ],
            }
            self.envelopes[item["id"]] = item
            return item

        def get_envelope(self, envelope_id):
            return self.envelopes[envelope_id]

        def distribute_envelope(self, envelope_id):
            self.calls.append("distribute")
            self.envelopes[envelope_id]["status"] = "PENDING"

        def delete_envelope(self, envelope_id):
            self.calls.append("delete")

        def download_signed_item(self, item_id):
            self.calls.append("download")
            return b"%PDF signed"

    return FakeDocumenso


RECIPIENTS = [
    {
        "name": "Ana",
        "email": "ana@empresa.com",
        "role": "SIGNER",
        "fields": [{"type": "SIGNATURE", "page": 1, "positionX": 10, "positionY": 10, "width": 20, "height": 5}],
    }
]


@pytest.fixture
def ready_request(workspace, template, create_user):
    return ContractSignatureRequest.objects.create(
        workspace=workspace,
        revision=template["revision"],
        title="Contrato",
        status=Status.READY,
        authoring_settings=workflow._normalise_authoring_settings({}),
        created_by=create_user,
    )


@pytest.mark.unit
@pytest.mark.django_db
class TestSigning:
    def test_new_requests_default_to_mexico_and_no_ine(self):
        settings = workflow._normalise_authoring_settings({})
        assert settings["timezone"] == "America/Monterrey"
        assert settings["language"] == "es"
        assert settings["dateFormat"] == "dd/MM/yyyy"
        assert settings["identity_verification_required"] is False
        # Stored settings win over the new defaults.
        assert (
            workflow._normalise_authoring_settings({"timezone": "Etc/UTC", "language": "en"})["timezone"] == "Etc/UTC"
        )

    def test_send_is_queued_once_then_runs(
        self,
        session_client,
        workspace,
        file_library_enabled,
        ready_request,
        monkeypatch,
        django_capture_on_commit_callbacks,
    ):
        url = f"/api/workspaces/{workspace.slug}/contract-signature-requests/{ready_request.id}/send/"
        with mock.patch("plane.bgtasks.contract_signature_task.send_signature_request.delay") as delay:
            with django_capture_on_commit_callbacks(execute=True):
                response = session_client.post(url, {"recipients": RECIPIENTS}, format="json")
        assert response.status_code == 202, response.data
        assert response.data["status"] == Status.PREPARING
        assert response.data["metadata"]["send"]["step"] == "queued"
        delay.assert_called_once_with(str(ready_request.id))
        assert session_client.post(url, {"recipients": RECIPIENTS}, format="json").data["error"] == "already_sending"

        client = fake_documenso()
        monkeypatch.setattr(workflow, "DocumensoClient", client)
        workflow.run_signature_send(ready_request.id)
        ready_request.refresh_from_db()
        assert ready_request.status == Status.PENDING
        assert ready_request.documenso_envelope_id == "env_new"
        assert ready_request.metadata["send"]["step"] == "done"
        assert client.calls == ["find", "create", "distribute"]
        assert ready_request.signers.get().status == ContractSigner.Status.SENT

    def test_send_reuses_an_envelope_found_by_external_id(self, ready_request, monkeypatch):
        ready_request.recipients = workflow._normalise_authoring_payload(RECIPIENTS)
        ready_request.status = Status.PREPARING
        ready_request.save()
        existing = {
            "id": "env_old",
            "status": "DRAFT",
            "externalId": str(ready_request.id),
            "envelopeItems": [{"id": "item_old"}],
            "recipients": [{"id": 3, "email": "ana@empresa.com", "role": "SIGNER", "signingStatus": "NOT_SIGNED"}],
        }
        client = fake_documenso(existing)
        monkeypatch.setattr(workflow, "DocumensoClient", client)
        workflow.run_signature_send(ready_request.id)
        ready_request.refresh_from_db()
        assert "create" not in client.calls
        assert ready_request.documenso_envelope_id == "env_old"
        assert ready_request.status == Status.PENDING

    def test_failed_send_goes_back_to_ready(self, ready_request, monkeypatch):
        ready_request.recipients = workflow._normalise_authoring_payload(RECIPIENTS)
        ready_request.status = Status.PREPARING
        ready_request.save()
        client = fake_documenso()

        def boom(self, **kwargs):
            raise workflow.DocumensoError("down")

        client.create_envelope = boom
        monkeypatch.setattr(workflow, "DocumensoClient", client)
        workflow.run_signature_send(ready_request.id)
        ready_request.refresh_from_db()
        assert ready_request.status == Status.READY
        assert ready_request.metadata["send"]["step"] == "failed"
        assert ready_request.metadata["send"]["failed_step"] == "creating"

    def test_completion_is_idempotent(self, ready_request, monkeypatch):
        ready_request.status = Status.PENDING
        ready_request.documenso_envelope_id = "env_1"
        ready_request.documenso_envelope_item_id = "item_1"
        ready_request.save()
        client = fake_documenso()
        monkeypatch.setattr(workflow, "DocumensoClient", client)
        monkeypatch.setattr(workflow, "ensure_contract_for_asset", lambda asset, user=None: None)
        workflow._complete_signature_request(ready_request)
        workflow._complete_signature_request(ContractSignatureRequest.objects.get(id=ready_request.id))
        ready_request.refresh_from_db()
        assert client.calls == ["download"]
        assert ready_request.status == Status.COMPLETED and ready_request.signed_asset_id

    def test_apply_state_marks_expired_and_defers_completion(self, ready_request, django_capture_on_commit_callbacks):
        ready_request.status = Status.PENDING
        ready_request.documenso_envelope_id = "env_1"
        ready_request.save()
        ContractSigner.objects.create(
            workspace=ready_request.workspace, signature_request=ready_request, name="Ana", email="ana@empresa.com"
        )
        workflow.apply_envelope_state(ready_request, envelope("PENDING", expiresAt="2001-01-01T00:00:00Z"))
        ready_request.refresh_from_db()
        assert ready_request.status == Status.EXPIRED
        assert ready_request.expires_at is not None
        assert ready_request.signers.get().status == ContractSigner.Status.EXPIRED

        ready_request.status = Status.PENDING
        ready_request.save()
        with mock.patch("plane.bgtasks.contract_signature_task.complete_signature_request.delay") as delay:
            with django_capture_on_commit_callbacks(execute=True):
                workflow.apply_envelope_state(ready_request, envelope("COMPLETED", signingStatus="SIGNED"))
        ready_request.refresh_from_db()
        assert ready_request.status == Status.PENDING  # until the signed PDF is stored
        delay.assert_called_once_with(str(ready_request.id))

    @override_settings(DOCUMENSO_WEBHOOK_SECRET="secret")
    def test_webhook_redelivery_is_a_duplicate(self, api_client, ready_request):
        ready_request.status = Status.PENDING
        ready_request.documenso_envelope_id = "env_1"
        ready_request.save()
        payload = {
            "event": "DOCUMENT_REJECTED",
            "payload": {**envelope("REJECTED", signingStatus="REJECTED"), "envelopeId": "env_1"},
            "createdAt": "2026-10-25T10:00:00Z",
        }
        url = "/api/integrations/documenso/webhook/"
        first = api_client.post(url, payload, format="json", HTTP_X_DOCUMENSO_SECRET="secret")
        assert first.status_code == 200 and "duplicate" not in first.data
        payload["createdAt"] = "2026-10-25T10:05:00Z"
        second = api_client.post(url, payload, format="json", HTTP_X_DOCUMENSO_SECRET="secret")
        assert second.data == {"received": True, "duplicate": True}
        assert ContractWebhookEvent.objects.count() == 1
        ready_request.refresh_from_db()
        assert ready_request.status == Status.REJECTED

    def test_links_are_not_for_guests(self, session_client, workspace, file_library_enabled, ready_request):
        from plane.db.models import WorkspaceMember

        WorkspaceMember.objects.filter(workspace=workspace).update(role=5)
        url = f"/api/workspaces/{workspace.slug}/contract-signature-requests/{ready_request.id}/links/"
        assert session_client.get(url).status_code == 403


@pytest.mark.unit
@pytest.mark.django_db
class TestLegacyCompatibility:
    @pytest.fixture
    def session(self, workspace, template, create_user):
        return ContractSignatureRequest.objects.create(
            workspace=workspace,
            revision=template["revision"],
            title="Configurar",
            status=Status.READY,
            authoring_mode=ContractSignatureRequest.AuthoringMode.TEMPLATE,
            created_by=create_user,
        )

    def patch(self, client, workspace, session, **extra):
        url = f"/api/workspaces/{workspace.slug}/contract-signature-requests/{session.id}/"
        return client.patch(url, {"recipients": RECIPIENTS, **extra}, format="json")

    def test_patch_without_commit_still_writes_blueprints(
        self, session_client, workspace, file_library_enabled, template, session
    ):
        response = self.patch(session_client, workspace, session)
        assert response.status_code == 200
        variant = ContractTemplateVariant.objects.get(id=template["variant"].id)
        revision = ContractTemplateRevision.objects.get(id=template["revision"].id)
        assert len(variant.signature_blueprint) == 1
        assert len(revision.signature_blueprint) == 1

    def test_commit_false_saves_only_the_session(
        self, session_client, workspace, file_library_enabled, template, session
    ):
        response = self.patch(session_client, workspace, session, commit=False)
        assert response.status_code == 200 and response.data["committed"] is False
        assert ContractTemplateVariant.objects.get(id=template["variant"].id).signature_blueprint == []
        session.refresh_from_db()
        assert len(session.fields) == 1

    def test_commit_true_validates(self, session_client, workspace, file_library_enabled, template, session):
        url = f"/api/workspaces/{workspace.slug}/contract-signature-requests/{session.id}/"
        bare = [{**RECIPIENTS[0], "fields": []}]
        response = session_client.patch(url, {"recipients": bare, "commit": True}, format="json")
        assert response.status_code == 400 and response.data["error"] == "signer_without_signature"
        assert self.patch(session_client, workspace, session, commit=True).data["committed"] is True

    def test_template_fields_from_tokens_come_back_locked(self, session):
        from plane.app.serializers import ContractSignatureRequestSerializer

        session.fields = [
            {"type": "SIGNATURE", "fieldMeta": {"templateVariable": "FirmaFirmante1"}, "recipient_index": 0},
            {"type": "TEXT", "fieldMeta": {}, "recipient_index": 0},
        ]
        data = ContractSignatureRequestSerializer(session).data
        assert data["fields"][0]["locked"] is True and data["fields"][0]["source"] == "template_variable"
        assert "locked" not in data["fields"][1]
        assert data["template_name"] == "Servicios" and data["variant_name"] == "Principal"

    def test_legacy_edit_decision_still_works(self, session_client, workspace, file_library_enabled, template, store):
        variant = template["variant"]
        url = f"/api/workspaces/{workspace.slug}/contract-variants/{variant.id}/edit-session/"
        backup_id = session_client.post(url).data["backup_asset_id"]
        store[variant.source_asset.asset.name] = make_docx("editado en vivo")
        response = session_client.patch(url, {"backup_asset_id": str(backup_id), "action": "DISCARD"}, format="json")
        assert response.status_code == 200, response.data
        assert store[variant.source_asset.asset.name] == ORIGINAL

        backup_id = session_client.post(url).data["backup_asset_id"]
        store[variant.source_asset.asset.name] = make_docx("versión dos")
        response = session_client.patch(
            url, {"backup_asset_id": str(backup_id), "action": "NEW_REVISION", "name": "Dos"}, format="json"
        )
        assert response.status_code == 200, response.data
        assert ContractTemplateRevision.objects.get(id=response.data["revision_id"]).revision == 2
