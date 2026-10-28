"""The library put in order by the assistant: duplicates by content (hashes
computed on request), the copy with the most links kept, contracts and
receipts never sent to the trash, and one undo for the whole card."""

import hashlib
from unittest.mock import patch
from uuid import uuid4

import pytest
from django.test import override_settings
from rest_framework.test import APIClient

from plane.db.models import (
    AssistantAction,
    Contract,
    Expense,
    ExpenseDocument,
    FileAsset,
    FileCategory,
    FileCategoryLink,
    FileFolder,
    FileTag,
    FileTagLink,
    WorkspaceFeature,
)
from plane.tests.factories import UserFactory, WorkspaceFactory, WorkspaceMemberFactory
from plane.utils import assistant_files

pytestmark = [pytest.mark.unit, pytest.mark.django_db]
CONTENT: dict = {}


@pytest.fixture
def setup():
    workspace = WorkspaceFactory()
    WorkspaceFeature.objects.create(workspace=workspace, key="file_library", is_enabled=True)
    admin = workspace.owner
    WorkspaceMemberFactory(workspace=workspace, member=admin, role=20)
    guest = UserFactory(username=f"guest-{uuid4().hex[:8]}")
    WorkspaceMemberFactory(workspace=workspace, member=guest, role=5)
    return {"workspace": workspace, "admin": admin, "guest": guest}


def library_file(setup, name, content=b"x", folder=None, hashed=True):
    attributes = {"name": name, "type": "application/pdf", "size": len(content)}
    if hashed:
        attributes["content_hash"] = hashlib.sha256(content).hexdigest()
    asset = FileAsset.objects.create(
        workspace=setup["workspace"],
        asset=f"{setup['workspace'].id}/{uuid4().hex}.pdf",
        attributes=attributes,
        size=len(content),
        folder=folder,
        entity_type=FileAsset.EntityTypeContext.WORKSPACE_FILE_LIBRARY,
        is_uploaded=True,
    )
    CONTENT[asset.id] = content
    return asset


def internal(setup, path, body):
    with override_settings(PLANE_INTERNAL_API_SECRET="secret"):
        return (
            APIClient()
            .post(
                f"/api/internal/workspaces/{setup['workspace'].id}/assistant/files/{path}",
                {"user_id": str(setup["admin"].id), **body},
                format="json",
                HTTP_X_PLANE_INTERNAL_KEY="secret",
            )
            .json()
        )


def client_for(user):
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def actions(setup, suffix=""):
    return f"/api/workspaces/{setup['workspace'].slug}/assistant/actions/{suffix}"


@patch.object(assistant_files, "_hash_object", side_effect=lambda asset: hashlib.sha256(CONTENT[asset.id]).hexdigest())
class TestReading:
    def test_folder_listing_by_path(self, hashed, setup):
        contratos = FileFolder.objects.create(workspace=setup["workspace"], name="Contratos")
        year = FileFolder.objects.create(workspace=setup["workspace"], name="2024", parent=contratos)
        library_file(setup, "a.pdf", folder=year)
        listed = internal(setup, "folder/", {"path": "contratos/2024"})
        assert listed["folder"]["path"] == "Contratos/2024" and listed["files"][0]["name"] == "a.pdf"
        assert internal(setup, "folder/", {"path": "Contratos"})["folders"][0]["files"] == 1

    def test_duplicates_keep_the_linked_copy_and_hash_old_files(self, hashed, setup):
        old = library_file(setup, "contrato.pdf", b"same", hashed=False)
        linked = library_file(setup, "contrato (1).pdf", b"same")
        tag = FileTag.objects.create(workspace=setup["workspace"], name="Juan")
        FileTagLink.objects.create(workspace=setup["workspace"], file_asset=linked, tag=tag)
        library_file(setup, "otro.pdf", b"different1")
        library_file(setup, "otro.pdf", b"different2")
        found = internal(setup, "duplicates/", {})
        assert found["hashed_now"] == 1
        old.refresh_from_db()
        assert old.attributes["content_hash"] == hashlib.sha256(b"same").hexdigest()
        group = found["exact"][0]["files"]
        assert group[0]["id"] == str(linked.id) and group[0]["keep"] is True
        assert found["possible"][0]["files"][0]["name"] == "otro.pdf"


class TestOrganize:
    def test_rename_move_tag_trash_and_one_undo(self, setup):
        first = library_file(setup, "scan001.pdf")
        second = library_file(setup, "scan001 (copia).pdf")
        category = FileCategory.objects.create(workspace=setup["workspace"], name="Edición")
        ops = [
            {"op": "rename", "file_id": str(first.id), "name": "Contrato de edición – Juan Pérez – 2024.pdf"},
            {"op": "move", "file_id": str(first.id), "path": "Contratos/2024/Juan Pérez"},
            {"op": "tag", "file_id": str(first.id), "tag": "Juan Pérez"},
            {"op": "categorize", "file_id": str(first.id), "category": "edición"},
            {"op": "trash", "file_id": str(second.id)},
        ]
        planned = internal(setup, "organize-plan/", {"ops": ops})
        assert planned["problems"] is None and planned["ops"][1]["to"] == "Contratos/2024/Juan Pérez"
        assert planned["ops"][2]["new_tag"] is True
        client = client_for(setup["admin"])
        response = client.post(actions(setup), {"kind": "ORGANIZE_FILES", "ops": ops}, format="json")
        assert response.status_code == 201, response.content
        first.refresh_from_db()
        assert first.attributes["name"].startswith("Contrato de edición") and first.folder.name == "Juan Pérez"
        assert first.folder.parent.parent.name == "Contratos"
        assert FileTagLink.objects.filter(file_asset=first, tag__name="Juan Pérez").exists()
        assert FileCategoryLink.objects.filter(file_asset=first, category=category).exists()
        assert FileAsset.all_objects.get(id=second.id).is_deleted

        undone = client.post(actions(setup, f"{response.json()['id']}/undo/"), format="json")
        assert undone.status_code == 200, undone.content
        first = FileAsset.objects.get(id=first.id)
        assert first.attributes["name"] == "scan001.pdf" and first.folder_id is None
        assert not FileFolder.objects.filter(workspace=setup["workspace"]).exists()
        assert not FileTag.objects.filter(name="Juan Pérez").exists()
        assert not FileCategoryLink.objects.filter(file_asset=first).exists()
        restored = FileAsset.objects.get(id=second.id)
        assert restored.is_deleted is False

    def test_contracts_receipts_never_go_to_the_trash(self, setup):
        contract_file = library_file(setup, "contrato.pdf")
        Contract.objects.create(workspace=setup["workspace"], file_asset=contract_file, titulo="X")
        receipt = library_file(setup, "factura.pdf")
        expense = Expense.objects.create(workspace=setup["workspace"], amount="1", expense_date="2026-01-01")
        ExpenseDocument.objects.create(workspace=setup["workspace"], expense=expense, asset=receipt)
        ops = [{"op": "trash", "file_id": str(contract_file.id)}, {"op": "trash", "file_id": str(receipt.id)}]
        planned = internal(setup, "organize-plan/", {"ops": ops})
        assert [problem["index"] for problem in planned["problems"]] == [0, 1]
        response = client_for(setup["admin"]).post(actions(setup), {"kind": "ORGANIZE_FILES", "ops": ops}, format="json")
        assert response.status_code == 400 and "contract" in response.json()["error"]
        assert FileAsset.objects.filter(id=contract_file.id).exists()

    def test_undo_leaves_a_name_someone_changed(self, setup):
        item = library_file(setup, "a.pdf")
        client = client_for(setup["admin"])
        action = client.post(
            actions(setup),
            {"kind": "ORGANIZE_FILES", "ops": [{"op": "rename", "file_id": str(item.id), "name": "b.pdf"}]},
            format="json",
        ).json()
        FileAsset.objects.filter(id=item.id).update(attributes={**item.attributes, "name": "c.pdf"})
        undone = client.post(actions(setup, f"{action['id']}/undo/"), format="json").json()
        assert FileAsset.objects.get(id=item.id).attributes["name"] == "c.pdf"
        assert undone["result"]["undo_conflicts"][0]["field"] == "name"

    def test_guests_cannot(self, setup):
        item = library_file(setup, "a.pdf")
        response = client_for(setup["guest"]).post(
            actions(setup),
            {"kind": "ORGANIZE_FILES", "ops": [{"op": "rename", "file_id": str(item.id), "name": "b.pdf"}]},
            format="json",
        )
        assert response.status_code in (400, 403) and not AssistantAction.objects.exists()
