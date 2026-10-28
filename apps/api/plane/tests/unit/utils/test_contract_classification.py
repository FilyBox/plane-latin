# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""The Django side of editorial classification and contract deletion.

The Cloudflare Worker is never called: its requests are replayed against the
internal endpoints exactly as the pipeline would send them.
"""

from datetime import date, timedelta
from io import StringIO
from unittest import mock

import pytest
from django.core.management import call_command
from django.test import TestCase, override_settings
from django.utils import timezone

from plane.app.views.contract.base import create_and_dispatch_job, is_classify_only
from plane.bgtasks.contract_task import sync_contract_status_by_date
from plane.db.models import Contract, ContractProcessingJob, FileAsset, Workspace, WorkspaceFeature

SECRET = "test-internal-secret"
DISPATCH = "plane.app.views.contract.base.dispatch_contract_pipeline.delay"


@pytest.fixture
def make_contract(workspace):
    def make(name, **fields):
        asset = FileAsset.objects.create(
            workspace=workspace,
            asset=f"{workspace.slug}/{name}.pdf",
            attributes={"name": f"{name}.pdf", "size": 1, "type": "application/pdf"},
            entity_type="FILE_LIBRARY",
        )
        fields.setdefault("processing_status", "COMPLETED")
        return Contract.objects.create(workspace=workspace, file_asset=asset, titulo=name, **fields)

    return make


def dispatch_classify(contract, options):
    # Dispatch waits for the transaction to commit
    with mock.patch(DISPATCH) as dispatch, TestCase.captureOnCommitCallbacks(execute=True):
        job = create_and_dispatch_job(
            workspace=contract.workspace,
            contract=contract,
            task_type=ContractProcessingJob.TaskType.RETRY_PARTIAL,
            metadata={"retry_options": options},
        )
    return job, dispatch


@pytest.mark.unit
class TestIsClassifyOnly:
    def test_only_classify(self):
        assert is_classify_only({"classify": True})

    def test_classify_with_other_stages_is_a_normal_run(self):
        assert not is_classify_only({"classify": True, "ai_analysis": True})

    def test_full_retry_is_a_normal_run(self):
        keys = ["extract_text", "generate_embeddings", "ai_analysis", "tags", "classify"]
        assert not is_classify_only({key: True for key in keys})

    def test_no_classify(self):
        assert not is_classify_only({})
        assert not is_classify_only({"ai_analysis": True})


@pytest.mark.unit
@pytest.mark.django_db
class TestQuietClassificationJob:
    def test_classify_only_dispatch_leaves_the_contract_alone(self, make_contract):
        contract = make_contract("quiet")
        _, dispatch = dispatch_classify(contract, {"classify": True})
        dispatch.assert_called_once()
        contract.refresh_from_db()
        assert contract.processing_status == "COMPLETED"

    def test_normal_retry_still_marks_processing(self, make_contract):
        contract = make_contract("loud")
        dispatch_classify(contract, {"ai_analysis": True})
        contract.refresh_from_db()
        assert contract.processing_status == "PROCESSING"

    @override_settings(PLANE_INTERNAL_API_SECRET=SECRET)
    def test_progress_of_a_classify_job_is_not_mirrored(self, api_client, make_contract):
        contract = make_contract("mirror-quiet")
        job, _ = dispatch_classify(contract, {"classify": True})
        url = f"/api/internal/contract-jobs/{job.id}/progress/"
        for job_status in ("RUNNING", "FAILED"):
            response = api_client.post(url, {"status": job_status}, format="json", HTTP_X_PLANE_INTERNAL_KEY=SECRET)
            assert response.status_code == 200
        contract.refresh_from_db()
        job.refresh_from_db()
        # A failed backfill fails the job, never the contract.
        assert job.status == "FAILED"
        assert contract.processing_status == "COMPLETED"

    @override_settings(PLANE_INTERNAL_API_SECRET=SECRET)
    def test_progress_of_a_normal_job_is_still_mirrored(self, api_client, make_contract):
        contract = make_contract("mirror-loud")
        job, _ = dispatch_classify(contract, {"ai_analysis": True})
        api_client.post(
            f"/api/internal/contract-jobs/{job.id}/progress/",
            {"status": "FAILED"},
            format="json",
            HTTP_X_PLANE_INTERNAL_KEY=SECRET,
        )
        contract.refresh_from_db()
        assert contract.processing_status == "ERROR"


@pytest.mark.unit
@pytest.mark.django_db
class TestClassificationIngest:
    @override_settings(PLANE_INTERNAL_API_SECRET=SECRET)
    def test_classification_payload_touches_only_the_editorial_flag(self, api_client, make_contract):
        contract = make_contract(
            "ingest",
            tipo_contrato="ARTISTAS",
            estatus_contrato="VIGENTE",
            fecha_fin=date(2026, 1, 1),
            fecha_fin_efectiva=date(2027, 1, 1),
            ai_model_used="deepseek-chat",
            resumen_general="Resumen editado a mano",
        )
        # Exactly what the Worker's "save classification" step sends.
        response = api_client.post(
            f"/api/internal/contracts/{contract.id}/extracted-data/",
            {"data": {"esEditorial": True}, "mode": "apply", "model_used": ""},
            format="json",
            HTTP_X_PLANE_INTERNAL_KEY=SECRET,
        )
        assert response.status_code == 200
        contract.refresh_from_db()
        assert contract.es_editorial is True
        assert contract.tipo_contrato == "ARTISTAS"
        assert contract.estatus_contrato == "VIGENTE"
        assert contract.fecha_fin_efectiva == date(2027, 1, 1)
        assert contract.ai_model_used == "deepseek-chat"
        assert contract.resumen_general == "Resumen editado a mano"

    @override_settings(PLANE_INTERNAL_API_SECRET=SECRET)
    def test_full_analysis_carries_the_flag_through_the_secondary_prompt(self, api_client, make_contract):
        contract = make_contract("full")
        api_client.post(
            f"/api/internal/contracts/{contract.id}/extracted-data/",
            {
                "data": {"tituloContrato": "Contrato de edición", "esNotariado": False, "esEditorial": False},
                "mode": "apply",
                "model_used": "deepseek-chat",
            },
            format="json",
            HTTP_X_PLANE_INTERNAL_KEY=SECRET,
        )
        contract.refresh_from_db()
        assert contract.es_editorial is False
        assert contract.titulo == "Contrato de edición"

    @override_settings(PLANE_INTERNAL_API_SECRET=SECRET)
    def test_internal_endpoint_rejects_requests_without_the_secret(self, api_client, make_contract):
        contract = make_contract("guarded")
        response = api_client.post(
            f"/api/internal/contracts/{contract.id}/extracted-data/",
            {"data": {"esEditorial": True}},
            format="json",
        )
        assert response.status_code in (401, 403)
        contract.refresh_from_db()
        assert contract.es_editorial is None


@pytest.mark.unit
@pytest.mark.django_db
class TestDailyStatusSync:
    def test_status_follows_the_effective_end(self, make_contract):
        today = timezone.now().date()
        ended = make_contract("ended", fecha_fin_efectiva=today - timedelta(days=1), estatus_contrato="VIGENTE")
        running = make_contract("running", fecha_fin_efectiva=today, estatus_contrato="FINALIZADO")
        no_status = make_contract("no-status", fecha_fin_efectiva=today - timedelta(days=5), estatus_contrato=None)
        undated = make_contract("undated", estatus_contrato="NO_ESPECIFICADO")

        result = sync_contract_status_by_date()

        for contract in (ended, running, no_status, undated):
            contract.refresh_from_db()
        assert ended.estatus_contrato == "FINALIZADO"
        assert running.estatus_contrato == "VIGENTE"
        assert no_status.estatus_contrato == "FINALIZADO"
        assert undated.estatus_contrato == "NO_ESPECIFICADO"
        assert result == {"finalizado": 2, "vigente": 1}

    def test_second_run_changes_nothing(self, make_contract):
        yesterday = timezone.now().date() - timedelta(days=1)
        make_contract("once", fecha_fin_efectiva=yesterday, estatus_contrato="VIGENTE")
        sync_contract_status_by_date()
        assert sync_contract_status_by_date() == {"finalizado": 0, "vigente": 0}


@pytest.mark.unit
@pytest.mark.django_db
class TestBackfillCommand:
    def test_dispatches_only_unclassified_live_contracts_with_text(self, make_contract):
        eligible = make_contract("eligible", extracted_text="CONTRATO DE EDICIÓN MUSICAL")
        make_contract("classified", extracted_text="texto", es_editorial=False)
        make_contract("no-text", extracted_text="")
        gone = make_contract("gone", extracted_text="texto")
        FileAsset.objects.filter(id=gone.file_asset_id).update(is_deleted=True)
        busy = make_contract("busy", extracted_text="texto")
        ContractProcessingJob.objects.create(
            workspace=busy.workspace,
            contract=busy,
            task_type=ContractProcessingJob.TaskType.EXTRACT_FULL,
            status=ContractProcessingJob.Status.RUNNING,
        )

        dry = StringIO()
        call_command("classify_editorial_contracts", "--dry-run", stdout=dry)
        assert "1 contracts would be classified" in dry.getvalue()

        with mock.patch(DISPATCH) as dispatch, TestCase.captureOnCommitCallbacks(execute=True):
            call_command("classify_editorial_contracts", stdout=StringIO())
        assert dispatch.call_count == 1
        job = ContractProcessingJob.objects.get(contract=eligible)
        assert job.metadata == {"retry_options": {"classify": True}}
        assert job.task_type == ContractProcessingJob.TaskType.RETRY_PARTIAL
        eligible.refresh_from_db()
        assert eligible.processing_status == "COMPLETED"

    def test_limit_and_workspace_filters(self, make_contract):
        for index in range(3):
            make_contract(f"batch-{index}", extracted_text="texto")
        with mock.patch(DISPATCH) as dispatch, TestCase.captureOnCommitCallbacks(execute=True):
            call_command("classify_editorial_contracts", "--limit", "2", stdout=StringIO())
        assert dispatch.call_count == 2
        out = StringIO()
        call_command("classify_editorial_contracts", "--dry-run", "--workspace", "no-such-workspace", stdout=out)
        assert "0 contracts would be classified" in out.getvalue()


@pytest.mark.unit
@pytest.mark.django_db
class TestContractEndpoints:
    @pytest.fixture(autouse=True)
    def file_library_enabled(self, workspace):
        # Contracts live behind the per-workspace file-library module flag.
        WorkspaceFeature.objects.create(
            workspace=workspace, key=WorkspaceFeature.FeatureKey.FILE_LIBRARY, is_enabled=True
        )

    def test_list_by_view_patch_and_delete(self, session_client, workspace, make_contract):
        today = timezone.now().date()
        active = make_contract("api-active", fecha_fin=today, fecha_fin_efectiva=today + timedelta(days=90))
        editorial = make_contract("api-editorial", es_editorial=True, fecha_fin_efectiva=today + timedelta(days=9))
        base = f"/api/workspaces/{workspace.slug}/contracts/"

        def titles(view):
            response = session_client.get(base, {"vista": view})
            assert response.status_code == 200
            return {row["titulo"] for row in response.json()}

        assert titles("vigentes") == {"api-active"}
        assert titles("editoriales") == {"api-editorial"}
        assert titles("vencidos") == set()

        # Moving the end into the past carries the 90-day extension with it.
        response = session_client.patch(
            f"{base}{active.id}/", {"fecha_fin": str(today - timedelta(days=200))}, format="json"
        )
        assert response.status_code == 200
        assert response.json()["fecha_fin_efectiva"] == str(today - timedelta(days=110))
        assert titles("vencidos") == {"api-active"}

        # Correcting the AI by hand moves the contract out of Editoriales.
        session_client.patch(f"{base}{editorial.id}/", {"es_editorial": False}, format="json")
        assert titles("editoriales") == set()
        assert titles("vigentes") == {"api-editorial"}

        assert session_client.delete(f"{base}{active.id}/").status_code == 204
        response = session_client.post(
            f"{base}bulk/", {"action": "delete", "contract_ids": [str(editorial.id)]}, format="json"
        )
        assert response.status_code == 200
        assert response.json()["deleted"] == [str(editorial.id)]
        assert session_client.get(base).json() == []
        doomed = [active.file_asset_id, editorial.file_asset_id]
        assert FileAsset.all_objects.filter(id__in=doomed, is_deleted=True).count() == 2

    def test_bulk_rejects_unknown_actions(self, session_client, workspace):
        response = session_client.post(
            f"/api/workspaces/{workspace.slug}/contracts/bulk/",
            {"action": "nuke", "contract_ids": ["x"]},
            format="json",
        )
        assert response.status_code == 400

    def test_other_workspaces_contracts_cannot_be_deleted(self, session_client, workspace, create_user):
        other = Workspace.objects.create(name="Other", owner=create_user, slug="other-ws")
        asset = FileAsset.objects.create(
            workspace=other, asset="other/x.pdf", attributes={"name": "x.pdf", "type": "application/pdf"}
        )
        foreign = Contract.objects.create(workspace=other, file_asset=asset)
        response = session_client.post(
            f"/api/workspaces/{workspace.slug}/contracts/bulk/",
            {"action": "delete", "contract_ids": [str(foreign.id)]},
            format="json",
        )
        assert response.status_code == 200
        assert response.json()["deleted"] == []
        assert Contract.objects.filter(id=foreign.id).exists()

    def test_bulk_moves_contracts_in_and_out_of_editoriales(self, session_client, workspace, make_contract):
        today = timezone.now().date()
        first = make_contract("move-1", es_editorial=False, fecha_fin_efectiva=today + timedelta(days=5))
        second = make_contract("move-2", fecha_fin_efectiva=today - timedelta(days=5))
        base = f"/api/workspaces/{workspace.slug}/contracts/"
        ids = [str(first.id), str(second.id)]

        response = session_client.post(
            f"{base}bulk/", {"action": "editorial", "contract_ids": ids, "es_editorial": True}, format="json"
        )
        assert response.status_code == 200
        assert sorted(response.json()["updated"]) == sorted(ids)
        assert {row["titulo"] for row in session_client.get(base, {"vista": "editoriales"}).json()} == {
            "move-1",
            "move-2",
        }

        session_client.post(
            f"{base}bulk/", {"action": "editorial", "contract_ids": ids, "es_editorial": False}, format="json"
        )
        assert session_client.get(base, {"vista": "editoriales"}).json() == []
        # Back out of Editoriales, each lands where its date puts it.
        assert {row["titulo"] for row in session_client.get(base, {"vista": "vigentes"}).json()} == {"move-1"}
        assert {row["titulo"] for row in session_client.get(base, {"vista": "vencidos"}).json()} == {"move-2"}

    def test_bulk_editorial_requires_a_boolean(self, session_client, workspace, make_contract):
        contract = make_contract("move-bad")
        response = session_client.post(
            f"/api/workspaces/{workspace.slug}/contracts/bulk/",
            {"action": "editorial", "contract_ids": [str(contract.id)], "es_editorial": "yes"},
            format="json",
        )
        assert response.status_code == 400
        contract.refresh_from_db()
        assert contract.es_editorial is None


@pytest.mark.unit
class TestEditorialByName:
    """The name-based stopgap in migration 0147."""

    @pytest.fixture
    def is_editorial_name(self):
        import importlib

        return importlib.import_module("plane.db.migrations.0147_contract_es_editorial_by_name").is_editorial_name

    @pytest.mark.parametrize(
        "name",
        [
            "CONTRATO EDITORIAL.pdf",
            "Contrato Editorial - Juan Pérez",
            "Publishing Agreement 2019.pdf",
            "Contrato de EDICIÓN MUSICAL",
            "Convenio de co-edición",
            "Coedicion catalogo.pdf",
            "Contrato de sub edición",
            "Contrato con editora musical",
            "Contrato de edición de obras",
        ],
    )
    def test_editorial_names_match(self, is_editorial_name, name):
        assert is_editorial_name(name)

    @pytest.mark.parametrize(
        "name",
        [
            "Contrato de artista exclusivo.pdf",
            "Cesión de derechos de grabación",
            "Contrato de edición de video",
            "Arrendamiento oficina.pdf",
            "Copia de AAR- EL BEBETO.pdf",
            "",
            None,
        ],
    )
    def test_other_names_do_not(self, is_editorial_name, name):
        assert not is_editorial_name(name)

    def test_either_title_or_file_name_is_enough(self, is_editorial_name):
        assert is_editorial_name(None, "CONTRATO EDITORIAL.pdf")
        assert is_editorial_name("Contrato editorial", "scan_001.pdf")
