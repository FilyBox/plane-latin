# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Contract templates edited by the assistant: a new variant by default, a
new version only when asked, the base never written, and undo."""

import hashlib
from io import BytesIO
from unittest import mock
from zipfile import ZipFile

import pytest
from django.test import override_settings
from rest_framework.test import APIClient

from plane.app.views.contract import template_drafts, workflow
from plane.app.views.file_library.collabora import mark_content_changed
from plane.db.models import (
    AssistantAction,
    ContractSignatureRequest,
    ContractTemplate,
    ContractTemplateRevision,
    ContractTemplateVariant,
    FileAsset,
    WorkspaceFeature,
)
from plane.tests.unit.utils.docx_samples import simple_docx

ORIGINAL = simple_docx(
    [
        "CONTRATO DE EDICIÓN CON JUAN PÉREZ",
        "que celebra el C. Juan Pérez en su carácter de ARTISTA",
        "Duración: 3 años",
        "Firma: {{FirmaFirmante1}}",
    ]
)


def texts(data):
    with ZipFile(BytesIO(data)) as archive:
        xml = archive.read("word/document.xml").decode()
    return xml


@pytest.fixture
def store(monkeypatch):
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

    def overwrite(asset, content):
        objects[asset.asset.name] = content
        mark_content_changed(asset, content)

    for module in (workflow, template_drafts):
        monkeypatch.setattr(module, "_create_asset", create_asset, raising=False)
        monkeypatch.setattr(module, "_read_asset", lambda asset: objects[asset.asset.name], raising=False)
        monkeypatch.setattr(module, "_overwrite_asset_content", overwrite, raising=False)
        monkeypatch.setattr(module, "_pdf_for_content", lambda *args, **kwargs: b"%PDF-1.4 fake", raising=False)
        monkeypatch.setattr(module, "_delete_uploaded", lambda keys: None, raising=False)
    monkeypatch.setattr(workflow, "S3Storage", mock.MagicMock())
    return objects


@pytest.fixture
def template(workspace, create_user, store):
    WorkspaceFeature.objects.create(workspace=workspace, key="file_library", is_enabled=True)
    source = workflow._create_asset(
        workspace=workspace,
        user=create_user,
        key="contracts/test/source.docx",
        name="source.docx",
        mime_type=workflow.DOCX_MIME,
        content=ORIGINAL,
        entity_type=FileAsset.EntityTypeContext.CONTRACT_TEMPLATE,
    )
    item = ContractTemplate.objects.create(workspace=workspace, name="Edición Juan Pérez")
    variant = ContractTemplateVariant.objects.create(
        workspace=workspace,
        template=item,
        name="Principal",
        source_asset=source,
        is_default=True,
        variable_settings={"Duracion": {"label": "Duración"}},
    )
    revision, _ = workflow._create_revision(variant, create_user, ORIGINAL, name="Original")
    return {"template": item, "variant": variant, "revision": revision, "user": create_user, "workspace": workspace}


def internal(path, method="get", body=None):
    with override_settings(PLANE_INTERNAL_API_SECRET="secret"):
        client = APIClient()
        if method == "get":
            return client.get(path, body or {}, HTTP_X_PLANE_INTERNAL_KEY="secret")
        return client.post(path, body or {}, format="json", HTTP_X_PLANE_INTERNAL_KEY="secret")


def client_for(user):
    client = APIClient()
    client.force_authenticate(user=user)
    return client


NAME_TO_TOKEN = [{"op": "replace_text", "find": "Juan Pérez", "replace": "{{NombreArtista}}", "match": "loose"}]


def create_body(setup, **extra):
    return {
        "kind": "CREATE_TEMPLATE_VARIANT",
        "base": {"variant_id": str(setup["variant"].id)},
        "edits": NAME_TO_TOKEN,
        "name": "Principal – artista como variable",
        "base_sha256": hashlib.sha256(ORIGINAL).hexdigest(),
        **extra,
    }


def actions(setup, suffix=""):
    return f"/api/workspaces/{setup['workspace'].slug}/assistant/actions/{suffix}"


@pytest.mark.unit
@pytest.mark.django_db
class TestReading:
    def test_list_outline_and_dry_run(self, template):
        workspace, user = template["workspace"], template["user"]
        base = f"/api/internal/workspaces/{workspace.id}/assistant/contract-templates/"
        listed = internal(base, body={"user_id": str(user.id), "q": "juan"}).json()["templates"]
        assert listed[0]["variants"][0]["variables"] == []
        outline = internal(f"{base}variants/{template['variant'].id}/outline/", body={"user_id": str(user.id)}).json()
        assert outline["paragraphs"][1]["text"] == "que celebra el C. Juan Pérez en su carácter de ARTISTA"
        assert outline["base"]["base_sha256"] == hashlib.sha256(ORIGINAL).hexdigest()
        assert outline["can_edit"] is True

        run = internal(
            f"{base}variants/{template['variant'].id}/dry-run/",
            "post",
            {"user_id": str(user.id), "edits": NAME_TO_TOKEN},
        ).json()
        assert [item["text"] for item in run["operations"][0]["applied"]] == ["JUAN PÉREZ", "Juan Pérez"]
        assert run["schema_changes"]["added"] == ["NombreArtista"]
        assert run["variable_settings"]["NombreArtista"] == {
            "label": "Nombre artista",
            "required": True,
            "case": "upper",
        }
        assert run["verification"]["preserved"] is True

    def test_dry_run_explains_an_ambiguous_anchor(self, template):
        workspace, user = template["workspace"], template["user"]
        run = internal(
            f"/api/internal/workspaces/{workspace.id}/assistant/contract-templates/variants/{template['variant'].id}/dry-run/",
            "post",
            {
                "user_id": str(user.id),
                "edits": [{"op": "insert_text", "anchor": "Juan Pérez", "match": "loose", "text": "!"}],
            },
        ).json()
        assert run["detail"]["code"] == "ambiguous" and len(run["detail"]["occurrences"]) == 2


@pytest.mark.unit
@pytest.mark.django_db
class TestNewVariant:
    def test_a_new_variant_and_the_base_untouched(self, template, store):
        client = client_for(template["user"])
        response = client.post(actions(template), create_body(template), format="json")
        assert response.status_code == 201, response.content
        result = response.json()["result"]
        created = ContractTemplateVariant.objects.get(id=result["variant_id"])
        assert created.name == "Principal – artista como variable"
        assert created.origin["by"] == "assistant" and created.origin["action_id"] == response.json()["id"]
        assert created.variable_settings["NombreArtista"]["case"] == "upper"
        assert created.variable_settings["Duracion"] == {"label": "Duración"}
        revision = ContractTemplateRevision.objects.get(variant=created)
        assert revision.revision == 1 and "NombreArtista" in str(revision.variable_schema)
        assert "{{NombreArtista}}" in texts(store[created.source_asset.asset.name])
        # The base: same Word, same versions
        assert store["contracts/test/source.docx"] == ORIGINAL
        assert ContractTemplateRevision.objects.filter(variant=template["variant"]).count() == 1
        assert result["path"].endswith(f"?variant={created.id}")

        again = client.post(actions(template), create_body(template), format="json").json()
        assert again["result"]["variant_name"] == "Principal – artista como variable (2)"

        undone = client.post(actions(template, f"{response.json()['id']}/undo/"), format="json")
        assert undone.status_code == 200, undone.content
        assert not ContractTemplateVariant.objects.filter(id=created.id).exists()
        assert not ContractTemplateRevision.objects.filter(id=revision.id).exists()

    def test_undo_refuses_once_a_contract_used_it(self, template):
        client = client_for(template["user"])
        action = client.post(actions(template), create_body(template), format="json").json()
        revision = ContractTemplateRevision.objects.get(variant_id=action["result"]["variant_id"])
        ContractSignatureRequest.objects.create(workspace=template["workspace"], revision=revision, title="Contrato")
        response = client.post(actions(template, f"{action['id']}/undo/"), format="json")
        assert response.status_code == 409 and "archive" in response.json()["error"]

    def test_a_changed_base_is_refused(self, template):
        body = create_body(template, base_sha256="0" * 64)
        response = client_for(template["user"]).post(actions(template), body, format="json")
        assert response.status_code == 400 and "changed" in response.json()["error"]


@pytest.mark.unit
@pytest.mark.django_db
class TestEditVariant:
    def edit_body(self, template):
        return {
            **create_body(template),
            "kind": "EDIT_TEMPLATE_VARIANT",
            "edits": [{"op": "replace_text", "find": "3 años", "replace": "5 años"}],
        }

    def test_a_new_version_only_and_undo(self, template, store):
        client = client_for(template["user"])
        response = client.post(actions(template), self.edit_body(template), format="json")
        assert response.status_code == 201, response.content
        assert response.json()["result"]["revision"] == 2
        assert "5 años" in texts(store["contracts/test/source.docx"])
        first = ContractTemplateRevision.objects.get(variant=template["variant"], revision=1)
        assert first.content_sha256 == hashlib.sha256(ORIGINAL).hexdigest()

        client.post(actions(template, f"{response.json()['id']}/undo/"), format="json")
        assert store["contracts/test/source.docx"] == ORIGINAL
        assert list(
            ContractTemplateRevision.objects.filter(variant=template["variant"]).values_list("revision", flat=True)
        ) == [1]

    def test_an_open_word_draft_blocks_it(self, template):
        variant = template["variant"]
        variant.draft_asset = variant.source_asset
        variant.draft_started_by = template["user"]
        variant.save()
        response = client_for(template["user"]).post(actions(template), self.edit_body(template), format="json")
        assert response.status_code == 400 and "draft" in response.json()["error"]
        assert not AssistantAction.objects.exists()


# ----------------------------------------------------------- contract drafts

DRAFT_SOURCE = simple_docx(
    [
        "Contrato con {{NombreArtista}} por {{Duracion}}",
        "Exclusividad: sí",
        "Firma: {{FirmaFirmante1}} {{NombreFirmante1}}",
    ]
)


@pytest.fixture
def draft_template(template, store, monkeypatch):
    variant = template["variant"]
    store["contracts/test/source.docx"] = DRAFT_SOURCE
    variant.recipient_roles = {"0": "Artista"}
    variant.variable_settings = {"Duracion": {"label": "Duración", "required": False}}
    variant.save()
    ContractTemplateRevision.objects.filter(variant=variant).delete(soft=False)
    workflow._create_revision(variant, template["user"], DRAFT_SOURCE, name="Original")
    monkeypatch.setattr(workflow, "locate_and_remove_pdf_markers", lambda pdf, markers: (pdf, []))
    return template


def draft_body(setup, **extra):
    return {
        "kind": "CREATE_CONTRACT_DRAFT",
        "variant_id": str(setup["variant"].id),
        "title": "Contrato Ana",
        "values": {"NombreArtista": {"value": "Ana López", "source": "Etiqueta Ana López"}},
        "recipients": [{"name": "Ana López", "email": "ana@example.com"}],
        **extra,
    }


@pytest.mark.unit
@pytest.mark.django_db
class TestContractDraft:
    def test_the_proposal_shows_values_their_origin_and_what_is_missing(self, draft_template):
        workspace, user = draft_template["workspace"], draft_template["user"]
        run = internal(
            f"/api/internal/workspaces/{workspace.id}/assistant/contract-templates/variants/"
            f"{draft_template['variant'].id}/contract-proposal/",
            "post",
            {"user_id": str(user.id), "values": {"NombreArtista": {"value": "Ana", "source": "catálogo"}}},
        ).json()
        rows = {row["key"]: row for row in run["variables"]}
        assert rows["NombreArtista"]["source"] == "catálogo" and rows["NombreArtista"]["required"] is True
        assert rows["Duracion"]["label"] == "Duración" and rows["Duracion"]["required"] is False
        assert run["signers"][0]["role"] == "Artista" and run["signers"][0]["requires_name"] is True
        assert run["missing"] == ["signer:0"]
        assert run["revision"] == 1

    def test_a_ready_draft_never_sent_and_undo(self, draft_template, store):
        client = client_for(draft_template["user"])
        response = client.post(actions(draft_template), draft_body(draft_template), format="json")
        assert response.status_code == 201, response.content
        result = response.json()["result"]
        signature_request = ContractSignatureRequest.objects.get(id=result["request_id"])
        assert signature_request.status == ContractSignatureRequest.Status.READY
        assert signature_request.documenso_envelope_id is None and signature_request.sent_at is None
        assert signature_request.variable_values["NombreArtista"] == "Ana López"
        assert "Ana López" in texts(store[signature_request.rendered_source_asset.asset.name])
        assert result["path"].endswith(f"/documents/{signature_request.id}/editor")
        # The template is untouched
        assert store["contracts/test/source.docx"] == DRAFT_SOURCE

        undone = client.post(actions(draft_template, f"{response.json()['id']}/undo/"), format="json")
        assert undone.status_code == 200, undone.content
        assert not ContractSignatureRequest.objects.filter(id=signature_request.id).exists()

    def test_once_sent_undo_refuses(self, draft_template):
        client = client_for(draft_template["user"])
        action = client.post(actions(draft_template), draft_body(draft_template), format="json").json()
        ContractSignatureRequest.objects.filter(id=action["result"]["request_id"]).update(
            status=ContractSignatureRequest.Status.PENDING
        )
        response = client.post(actions(draft_template, f"{action['id']}/undo/"), format="json")
        assert response.status_code == 409 and "cancel" in response.json()["error"]

    def test_a_missing_value_comes_with_its_key(self, draft_template):
        body = draft_body(draft_template, values={})
        response = client_for(draft_template["user"]).post(actions(draft_template), body, format="json")
        assert response.status_code == 400
        assert response.json()["code"] == "missing_value" and response.json()["key"] == "NombreArtista"
        assert not ContractSignatureRequest.objects.exists()

    def test_text_changes_make_a_new_variant_first(self, draft_template, store):
        body = draft_body(
            draft_template,
            document_edits=[{"op": "delete_paragraph", "anchor": "Exclusividad: sí"}],
            variant_name="Principal – sin exclusividad",
            base_sha256=hashlib.sha256(DRAFT_SOURCE).hexdigest(),
        )
        client = client_for(draft_template["user"])
        response = client.post(actions(draft_template), body, format="json")
        assert response.status_code == 201, response.content
        result = response.json()["result"]
        created = ContractTemplateVariant.objects.get(id=result["variant_id"])
        assert created.name == "Principal – sin exclusividad" and created.id != draft_template["variant"].id
        signature_request = ContractSignatureRequest.objects.get(id=result["request_id"])
        assert signature_request.revision.variant_id == created.id
        assert "Exclusividad" not in texts(store[signature_request.rendered_source_asset.asset.name])
        assert store["contracts/test/source.docx"] == DRAFT_SOURCE

        client.post(actions(draft_template, f"{response.json()['id']}/undo/"), format="json")
        assert not ContractTemplateVariant.objects.filter(id=created.id).exists()
        assert AssistantAction.objects.get(id=result["variant_action_id"]).status == "UNDONE"
