"""Splitting, merging and editing the pages of PDFs from the assistant's
cards: new files in a new folder, analyzed as contracts, the originals never
touched, and undo removing exactly what was created."""

import io
from unittest.mock import patch
from uuid import uuid4

import fitz
import pytest
from django.test import override_settings
from rest_framework.test import APIClient

from plane.app.views.contract.base import _retry_options
from plane.db.models import (
    AssistantAction,
    Contract,
    ContractProcessingJob,
    FileAsset,
    FileCategory,
    FileCategoryLink,
    FileFolder,
    WorkspaceFeature,
)
from plane.tests.factories import UserFactory, WorkspaceFactory, WorkspaceMemberFactory

pytestmark = [pytest.mark.unit, pytest.mark.django_db]


class FakeStorage:
    """S3 in a dict, per bucket."""

    objects: dict = {}

    def __init__(self, request=None, bucket_name=None):
        self.aws_storage_bucket_name = bucket_name or "uploads"
        self.s3_client = self

    @classmethod
    def for_asset(cls, asset, request=None):
        return cls(bucket_name=(asset.storage_metadata or {}).get("bucket"))

    def get_object(self, Bucket, Key):
        return {"Body": io.BytesIO(FakeStorage.objects[(Bucket, Key)])}

    def upload_file(self, file_obj, object_name, content_type=None):
        FakeStorage.objects[(self.aws_storage_bucket_name, object_name)] = file_obj.read()
        return True

    def get_object_metadata(self, object_name):
        return {"ContentType": "application/pdf"}

    def delete_files(self, object_names):
        for name in object_names:
            FakeStorage.objects.pop((self.aws_storage_bucket_name, name), None)
        return True


@pytest.fixture(autouse=True)
def storage():
    FakeStorage.objects = {}
    with patch("plane.utils.assistant_pdf.S3Storage", FakeStorage):
        yield FakeStorage


def make_pdf(pages: int, label: str = "Doc", lines: tuple = ()) -> bytes:
    with fitz.open() as document:
        for number in range(1, pages + 1):
            page = document.new_page(width=300, height=400)
            page.insert_text((40, 60), f"{label} p{number}")
            for row, line in enumerate(lines):
                page.insert_text((40, 80 + row * 14), line, fontsize=8)
        return document.tobytes()


def texts(data: bytes) -> list[str]:
    with fitz.open(stream=data, filetype="pdf") as document:
        return [page.get_text().strip() for page in document]


def add_pdf(workspace, name, content, folder=None, bucket=None, entity_type=None):
    key = f"{workspace.id}/{uuid4().hex}-{name}"
    FakeStorage.objects[(bucket or "uploads", key)] = content
    return FileAsset.objects.create(
        workspace=workspace,
        asset=key,
        attributes={"name": name, "type": "application/pdf", "size": len(content)},
        entity_type=entity_type or FileAsset.EntityTypeContext.WORKSPACE_FILE_LIBRARY,
        is_uploaded=True,
        folder=folder,
        storage_metadata={"bucket": bucket} if bucket else {},
    )


def stored(asset) -> bytes:
    bucket = (asset.storage_metadata or {}).get("bucket") or "uploads"
    return FakeStorage.objects[(bucket, asset.asset.name)]


@pytest.fixture
def setup():
    workspace = WorkspaceFactory()
    for key in ("file_library", "references"):
        WorkspaceFeature.objects.create(workspace=workspace, key=key, is_enabled=True)
    admin = workspace.owner
    WorkspaceMemberFactory(workspace=workspace, member=admin, role=20)
    member = UserFactory(username=f"member-{uuid4().hex[:8]}")
    WorkspaceMemberFactory(workspace=workspace, member=member, role=15)
    category = FileCategory.objects.create(workspace=workspace, name="Contratos", is_default=True, pdf_only=True)
    folder = FileFolder.objects.create(workspace=workspace, name="Paquetes")
    package = add_pdf(workspace, "Paquete 2024.pdf", make_pdf(6), folder=folder)
    return {
        "workspace": workspace,
        "admin": admin,
        "member": member,
        "category": category,
        "folder": folder,
        "package": package,
    }


def client_for(user):
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def actions_url(setup, suffix=""):
    return f"/api/workspaces/{setup['workspace'].slug}/assistant/actions/{suffix}"


def split_body(setup, **extra):
    return {
        "kind": "SPLIT_PDF",
        "file_id": str(setup["package"].id),
        "segments": [
            {"start_page": 1, "end_page": 2, "name": "Contrato Pérez"},
            {"start_page": 3, "end_page": 6, "name": "Adendum 1.pdf"},
        ],
        **extra,
    }


class TestSplit:
    def test_new_files_in_a_new_folder_analyzed_as_contracts(self, setup):
        original = stored(setup["package"])
        response = client_for(setup["member"]).post(actions_url(setup), split_body(setup), format="json")
        assert response.status_code == 201, response.content
        result = response.json()["result"]

        folder = FileFolder.objects.get(id=result["folder"]["id"])
        assert folder.name == "Separados de Paquete 2024" and folder.parent_id == setup["folder"].id
        files = list(FileAsset.objects.filter(folder=folder).order_by("attributes__name"))
        assert [file.attributes["name"] for file in files] == ["Adendum 1.pdf", "Contrato Pérez.pdf"]
        assert texts(stored(files[1])) == ["Doc p1", "Doc p2"]
        assert texts(stored(files[0])) == ["Doc p3", "Doc p4", "Doc p5", "Doc p6"]
        assert files[1].attributes["page_count"] == 2
        assert files[1].attributes["derived_from"]["pages"] == "1-2"
        assert files[1].created_by_id == setup["member"].id

        # Each one is a contract in "Contratos" with its analysis queued
        contracts = Contract.objects.filter(file_asset__in=files)
        assert contracts.count() == 2
        assert ContractProcessingJob.objects.filter(contract__in=contracts).count() == 2
        assert FileCategoryLink.objects.filter(file_asset__in=files, category=setup["category"]).count() == 2
        assert sorted(item["contract_id"] for item in result["files"]) == sorted(
            str(contract.id) for contract in contracts
        )

        # The original stays where and as it was
        setup["package"].refresh_from_db()
        assert setup["package"].folder_id == setup["folder"].id and not setup["package"].is_deleted
        assert stored(setup["package"]) == original
        assert setup["package"].attributes["page_count"] == 6
        assert result["path"] == f"/{setup['workspace'].slug}/file-library?folder={folder.id}"

    def test_undo_removes_files_contracts_and_the_empty_folder(self, setup):
        client = client_for(setup["member"])
        action = client.post(actions_url(setup), split_body(setup), format="json").json()
        ids = [item["id"] for item in action["result"]["files"]]
        with patch("plane.bgtasks.contract_task.terminate_contract_pipeline_task.delay"):
            undone = client.post(actions_url(setup, f"{action['id']}/undo/"), format="json")
        assert undone.status_code == 200, undone.content
        assert undone.json()["status"] == "UNDONE"
        assert FileAsset.objects.filter(id__in=ids, is_deleted=False).count() == 0
        assert not Contract.objects.filter(file_asset_id__in=ids).exists()
        assert not FileFolder.objects.filter(id=action["result"]["folder"]["id"]).exists()
        assert not FileAsset.objects.get(id=setup["package"].id).is_deleted

    def test_undo_keeps_a_folder_someone_added_to(self, setup):
        client = client_for(setup["member"])
        action = client.post(actions_url(setup), split_body(setup, analyze=False), format="json").json()
        folder = FileFolder.objects.get(id=action["result"]["folder"]["id"])
        added = add_pdf(setup["workspace"], "otro.pdf", make_pdf(1), folder=folder)
        client.post(actions_url(setup, f"{action['id']}/undo/"), format="json")
        assert FileFolder.objects.filter(id=folder.id).exists()
        assert not FileAsset.objects.get(id=added.id).is_deleted

    def test_the_folder_name_never_mixes_with_an_existing_one(self, setup):
        FileFolder.objects.create(
            workspace=setup["workspace"], parent=setup["folder"], name="separados de paquete 2024"
        )
        body = split_body(setup, analyze=False)
        result = client_for(setup["member"]).post(actions_url(setup), body, format="json").json()["result"]
        assert result["folder"]["name"] == "Separados de Paquete 2024 (2)"
        renamed = client_for(setup["member"]).post(
            actions_url(setup), {**body, "folder_name": "Contratos 2024"}, format="json"
        )
        assert renamed.json()["result"]["folder"]["name"] == "Contratos 2024"

    def test_without_analysis_no_contract_is_created(self, setup):
        result = (
            client_for(setup["member"])
            .post(actions_url(setup), split_body(setup, analyze=False), format="json")
            .json()["result"]
        )
        assert result["analyzed"] is False
        assert not Contract.objects.filter(file_asset_id__in=[item["id"] for item in result["files"]]).exists()

    def test_invalid_ranges_leave_nothing_behind(self, setup):
        before = (FileFolder.objects.count(), FileAsset.objects.count(), len(FakeStorage.objects))
        body = split_body(setup, segments=[{"start_page": 1, "end_page": 3}, {"start_page": 3, "end_page": 6}])
        response = client_for(setup["member"]).post(actions_url(setup), body, format="json")
        assert response.status_code == 400 and "overlap" in response.json()["error"]
        assert (FileFolder.objects.count(), FileAsset.objects.count(), len(FakeStorage.objects)) == before

    def test_a_failed_save_removes_what_was_uploaded(self, setup):
        before = len(FakeStorage.objects)
        with patch("plane.utils.assistant_pdf._analyze", side_effect=RuntimeError("boom")):
            with pytest.raises(RuntimeError):
                from plane.utils.assistant_pdf import split_pdf
                from plane.utils.entities import AccessContext

                ctx = AccessContext.build(setup["workspace"].slug, setup["member"])
                split_pdf(ctx, setup["member"], split_body(setup))
        assert len(FakeStorage.objects) == before
        assert not FileFolder.objects.filter(name__startswith="Separados").exists()

    def test_only_library_pdfs_the_user_can_open(self, setup):
        client = client_for(setup["member"])
        other = WorkspaceFactory(owner=UserFactory(username=f"other-{uuid4().hex[:8]}"))
        foreign = add_pdf(other, "ajeno.pdf", make_pdf(2))
        music = add_pdf(
            setup["workspace"], "musica.pdf", make_pdf(2), entity_type=FileAsset.EntityTypeContext.MUSIC_CATALOG
        )
        for asset in (foreign, music):
            response = client.post(actions_url(setup), split_body(setup, file_id=str(asset.id)), format="json")
            assert response.status_code == 400 and response.json()["error"] == "File not found."
        sheet = FileAsset.objects.create(
            workspace=setup["workspace"],
            asset="x.csv",
            attributes={"name": "x.csv", "type": "text/csv"},
            entity_type=FileAsset.EntityTypeContext.WORKSPACE_FILE_LIBRARY,
            is_uploaded=True,
        )
        response = client.post(actions_url(setup), split_body(setup, file_id=str(sheet.id)), format="json")
        assert "not a PDF" in response.json()["error"]


class TestMergeAndPages:
    def test_merge_in_order_next_to_the_first_file_and_in_its_bucket(self, setup):
        signed = add_pdf(setup["workspace"], "Firmado.pdf", make_pdf(1, "S"), bucket="contracts")
        body = {
            "kind": "MERGE_PDF",
            "file_ids": [str(signed.id), str(setup["package"].id)],
            "name": "Expediente completo",
        }
        response = client_for(setup["member"]).post(actions_url(setup), body, format="json")
        assert response.status_code == 201, response.content
        result = response.json()["result"]
        assert result["folder"]["name"] == "Unidos – Expediente completo"
        assert FileFolder.objects.get(id=result["folder"]["id"]).parent_id is None
        merged = FileAsset.objects.get(id=result["files"][0]["id"])
        assert merged.attributes["name"] == "Expediente completo.pdf"
        assert merged.storage_metadata["bucket"] == "contracts"
        assert texts(stored(merged))[:2] == ["S p1", "Doc p1"] and result["files"][0]["pages"] == 7

    def test_merge_refuses_repeats(self, setup):
        body = {"kind": "MERGE_PDF", "file_ids": [str(setup["package"].id)] * 2, "name": "x"}
        response = client_for(setup["member"]).post(actions_url(setup), body, format="json")
        assert response.status_code == 400

    @pytest.mark.parametrize(
        "operation, pages, expected, label",
        [
            ("extract", "1-2, 5", ["Doc p1", "Doc p2", "Doc p5"], "1-2, 5"),
            ("remove", [1, 6], ["Doc p2", "Doc p3", "Doc p4", "Doc p5"], "2-5"),
            ("reorder", [6, 5, 4, 3, 2, 1], ["Doc p6", "Doc p5", "Doc p4", "Doc p3", "Doc p2", "Doc p1"], None),
        ],
    )
    def test_page_operations(self, setup, operation, pages, expected, label):
        body = {
            "kind": "EDIT_PDF_PAGES",
            "file_id": str(setup["package"].id),
            "operation": operation,
            "pages": pages,
            "analyze": False,
        }
        response = client_for(setup["member"]).post(actions_url(setup), body, format="json")
        assert response.status_code == 201, response.content
        result = response.json()["result"]
        assert result["folder"]["name"] == "Páginas de Paquete 2024"
        created = FileAsset.objects.get(id=result["files"][0]["id"])
        assert texts(stored(created)) == expected
        if label:
            assert created.attributes["name"] == f"Paquete 2024 (páginas {label}).pdf"

    def test_history_lists_the_new_kinds(self, setup):
        client = client_for(setup["member"])
        client.post(actions_url(setup), split_body(setup, analyze=False), format="json")
        rows = client.get(actions_url(setup)).json()["actions"]
        assert rows[0]["kind"] == AssistantAction.Kind.SPLIT_PDF
        assert rows[0]["summary"].startswith("Separó «Paquete 2024.pdf» en 2 archivos")


class TestInternalPages:
    def get(self, setup, path, user=None, **params):
        user = user or setup["member"]
        with override_settings(PLANE_INTERNAL_API_SECRET="secret"):
            return APIClient().get(
                f"/api/internal/workspaces/{setup['workspace'].id}/assistant/files/{path}",
                {"user_id": str(user.id), **params},
                HTTP_X_PLANE_INTERNAL_KEY="secret",
            )

    def test_pages_with_text_and_count(self, setup):
        response = self.get(setup, f"{setup['package'].id}/pages/")
        assert response.status_code == 200, response.content
        data = response.json()
        assert data["page_count"] == 6 and data["folder_name"] == "Paquetes"
        # A few characters per page read as a scan
        assert data["text_source"] == "none" and data["needs_vision"] is True
        assert data["pages"][2] == {"page": 3, "chars": 6, "text": "Doc p3"}
        setup["package"].refresh_from_db()
        assert setup["package"].attributes["page_count"] == 6

        digital = add_pdf(
            setup["workspace"],
            "digital.pdf",
            make_pdf(2, "CONTRATO", lines=("Entre las partes", "que suscriben el presente")),
        )
        data = self.get(setup, f"{digital.id}/pages/").json()
        assert data["text_source"] == "pdf" and data["needs_vision"] is False

    def test_an_analyzed_contract_brings_its_ocr_text(self, setup):
        scan = add_pdf(setup["workspace"], "escaneo.pdf", make_pdf(2, ""))
        Contract.objects.create(
            workspace=setup["workspace"],
            file_asset=scan,
            extracted_text="[[p. 1]]\nCONTRATO DE EDICIÓN\nEntre las partes " + "x" * 50 + "\n[[p. 2]]\nANEXO A",
        )
        data = self.get(setup, f"{scan.id}/pages/").json()
        assert data["text_source"] == "contract" and data["is_contract"] is True
        assert data["pages"][0]["text"].startswith("CONTRATO DE EDICIÓN")
        assert data["pages"][1]["text"] == "ANEXO A"
        assert self.get(setup, f"{scan.id}/pages/", text="0").json().get("pages") is None

    def test_preview_is_a_light_pdf_of_the_range(self, setup):
        response = self.get(setup, f"{setup['package'].id}/preview-pdf/", **{"from": 2, "to": 3})
        assert response.status_code == 200 and response["Content-Type"] == "application/pdf"
        with fitz.open(stream=response.content, filetype="pdf") as document:
            assert document.page_count == 2
        too_many = self.get(setup, f"{setup['package'].id}/preview-pdf/", **{"from": 1, "to": 9})
        assert too_many.status_code == 400

    def test_someone_outside_the_workspace_gets_nothing(self, setup):
        outsider = UserFactory(username=f"out-{uuid4().hex[:8]}")
        assert self.get(setup, f"{setup['package'].id}/pages/", user=outsider).status_code == 403


class TestThumbnailCleanup:
    def test_old_jobs_with_the_thumbnail_option_still_retry(self):
        options = _retry_options({"extract_thumbnail": True, "tags": True}, contract_has_text=True)
        assert "extract_thumbnail" not in options and options["tags"] is True
