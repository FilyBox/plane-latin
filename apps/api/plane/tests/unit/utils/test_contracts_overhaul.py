# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Contracts overhaul: normalizing AI output, job progress, proposals,
stuck jobs, expiry alerts and the list API. The Worker is never called."""

from datetime import date, timedelta
from unittest import mock

import pytest
from django.test import TestCase, override_settings
from django.utils import timezone

from plane.app.views.contract.internal import apply_extracted_data
from plane.bgtasks.contract_task import (
    pending_expiry_alert,
    reap_stuck_contract_jobs,
    send_contract_expiry_alerts,
)
from plane.db.models import Contract, ContractProcessingJob, FileAsset, WorkspaceFeature
from plane.utils.contract_extraction import as_months, normalize_extracted, normalize_type, normalize_yes_no

SECRET = "test-internal-secret"
DISPATCH = "plane.app.views.contract.base.dispatch_contract_pipeline.delay"
TERMINATE = "plane.bgtasks.contract_task.terminate_contract_pipeline_task.delay"
Status = ContractProcessingJob.Status


@pytest.fixture
def make_contract(workspace, create_user):
    def make(name, **fields):
        asset = FileAsset.objects.create(
            workspace=workspace,
            asset=f"{workspace.slug}/{name}.pdf",
            attributes={"name": f"{name}.pdf", "size": 10, "type": "application/pdf"},
            entity_type="FILE_LIBRARY",
            created_by=create_user,
        )
        fields.setdefault("processing_status", "COMPLETED")
        return Contract.objects.create(workspace=workspace, file_asset=asset, titulo=name, **fields)

    return make


@pytest.fixture
def file_library_enabled(workspace):
    WorkspaceFeature.objects.create(workspace=workspace, key=WorkspaceFeature.FeatureKey.FILE_LIBRARY, is_enabled=True)


def make_job(contract, **fields):
    fields.setdefault("task_type", ContractProcessingJob.TaskType.EXTRACT_FULL)
    fields.setdefault("status", Status.RUNNING)
    return ContractProcessingJob.objects.create(workspace=contract.workspace, contract=contract, **fields)


@pytest.mark.unit
class TestLooseAnswers:
    @pytest.mark.parametrize(
        "raw,expected",
        [
            ("SI, por 2 años", "SI"),
            ("sí", "SI"),
            ("No", "NO"),
            ("No especificado", "NO_ESPECIFICADO"),
            ("tal vez", "NO_ESPECIFICADO"),
            (True, "SI"),
        ],
    )
    def test_yes_no(self, raw, expected):
        assert normalize_yes_no(raw) == expected

    @pytest.mark.parametrize(
        "raw,expected",
        [
            ("ARTISTAS", "ARTISTAS"),
            ("arrendamiento", "ARRENDAMIENTOS"),
            ("Contrato de management", "REPRESENTACION"),
            ("cesión de derechos", "CESION_DERECHOS"),
            ("xyz", "OTRO"),
        ],
    )
    def test_contract_type(self, raw, expected):
        assert normalize_type(raw) == expected

    @pytest.mark.parametrize(
        "raw,expected", [(24, 24), ("24", 24), (24.0, 24), ("24 meses", 24), ("nunca", None), (True, None), (-3, None)]
    )
    def test_extension_months(self, raw, expected):
        assert as_months(raw) == expected


@pytest.mark.unit
@pytest.mark.django_db
class TestApplyNormalized:
    def test_notarized_false_string_is_false(self, make_contract):
        contract = make_contract("notario", es_notariado=True)
        apply_extracted_data(contract, {"esNotariado": "false"})
        contract.refresh_from_db()
        assert contract.es_notariado is False

    def test_bad_enum_falls_back_without_raising(self, make_contract):
        contract = make_contract("enum")
        warnings = apply_extracted_data(
            contract, {"esPosibleExpandirlo": "quizá", "tipoContrato": "raro", "periodoColeccion": "???"}
        )
        contract.refresh_from_db()
        assert contract.es_posible_expandirlo == "NO_ESPECIFICADO"
        assert contract.tipo_contrato == "OTRO"
        assert contract.periodo_coleccion == "NO_ESPECIFICADO"
        assert {warning["field"] for warning in warnings} >= {"es_posible_expandirlo", "tipo_contrato"}

    def test_long_strings_are_cut_to_the_column(self, make_contract):
        contract = make_contract("largo")
        apply_extracted_data(contract, {"tituloContrato": "x" * 900, "duracionPeriodoColeccion": "y" * 400})
        contract.refresh_from_db()
        assert len(contract.titulo) == 500
        assert len(contract.collection_period_duration) == 255

    def test_reversed_and_implausible_dates_are_dropped(self, make_contract):
        contract = make_contract("fechas")
        warnings = apply_extracted_data(contract, {"fechaInicio": "2020-05-01", "fechaFin": "2019-01-01"})
        contract.refresh_from_db()
        assert contract.fecha_inicio == date(2020, 5, 1)
        assert contract.fecha_fin is None
        assert any(warning["code"] == "end_before_start" for warning in warnings)
        warnings = apply_extracted_data(contract, {"fechaFin": "2999-01-01"})
        assert any(warning["code"] == "date_out_of_range" for warning in warnings)

    def test_string_extension_months_extend_the_effective_end(self, make_contract):
        contract = make_contract("prorroga")
        apply_extracted_data(
            contract, {"fechaFin": "2030-01-31", "esPosibleExpandirlo": "SI", "tiempoExtensionMeses": "24"}
        )
        contract.refresh_from_db()
        assert contract.fecha_fin_efectiva == date(2032, 1, 31)
        assert contract.estatus_contrato == "VIGENTE"

    def test_term_in_months_computes_the_end_with_evidence(self, make_contract):
        contract = make_contract("duracion")
        apply_extracted_data(
            contract,
            {
                "fechaInicio": "2010-03-15",
                "fechaFin": None,
                "duracionMeses": 36,
                "_evidence": {
                    "fechaInicio": {"cita": "firmado el 15 de marzo de 2010", "pagina": 1},
                    "duracionMeses": {"cita": "por un plazo de tres años", "pagina": 2},
                    "esNotariado": {"cita": "ante notario", "pagina": None},
                },
            },
        )
        contract.refresh_from_db()
        assert contract.fecha_fin == date(2013, 3, 15)
        assert contract.fecha_fin_efectiva == date(2013, 3, 15)
        # Status follows the date, not the AI
        assert contract.estatus_contrato == "FINALIZADO"
        assert contract.evidence["fecha_inicio"] == {"quote": "firmado el 15 de marzo de 2010", "page": 1}
        assert contract.evidence["fecha_fin"] == {"quote": "por un plazo de tres años", "page": 2, "computed": True}
        # No evidence kept for a field the payload did not set
        assert "es_notariado" not in contract.evidence

    def test_plain_extraction_keeps_values_the_ai_left_empty(self, make_contract):
        contract = make_contract("vacio", nombre_grupo="Los Tigres")
        apply_extracted_data(contract, {"nombreGrupo": None, "tituloContrato": ""})
        contract.refresh_from_db()
        assert contract.nombre_grupo == "Los Tigres"
        assert contract.titulo == "vacio"

    @override_settings(PLANE_INTERNAL_API_SECRET=SECRET)
    def test_warnings_land_on_the_job(self, api_client, make_contract):
        contract = make_contract("avisos")
        job = make_job(contract)
        api_client.post(
            f"/api/internal/contracts/{contract.id}/extracted-data/",
            {"data": {"fechaFin": "1800-01-01"}, "mode": "apply", "job_id": str(job.id)},
            format="json",
            HTTP_X_PLANE_INTERNAL_KEY=SECRET,
        )
        job.refresh_from_db()
        assert job.metadata["warnings"][0]["code"] == "date_out_of_range"


@pytest.mark.unit
@pytest.mark.django_db
class TestJobProgress:
    @pytest.fixture(autouse=True)
    def internal_secret(self, settings):
        settings.PLANE_INTERNAL_API_SECRET = SECRET

    def post(self, client, job, payload):
        return client.post(
            f"/api/internal/contract-jobs/{job.id}/progress/", payload, format="json", HTTP_X_PLANE_INTERNAL_KEY=SECRET
        )

    def test_steps_are_timed_and_a_finished_job_stays_finished(self, api_client, make_contract):
        contract = make_contract("pasos", processing_status="PROCESSING")
        job = make_job(contract, status=Status.QUEUED)
        self.post(
            api_client,
            job,
            {"stage": "extracting_text", "current_stage": "extracting_text", "status": "RUNNING", "progress": 10},
        )
        self.post(api_client, job, {"stage": "extracting_text", "progress": 20, "detail_data": {"waited_seconds": 5}})
        self.post(api_client, job, {"stage": "analyzing", "progress": 60})
        usage = {
            "calls": [
                {
                    "prompt": "primary",
                    "model": "m",
                    "input_tokens": 1,
                    "cached_tokens": 0,
                    "output_tokens": 1,
                    "cost_usd": 0.01,
                    "part": 1,
                }
            ],
            "total_cost_usd": 0.01,
        }
        self.post(api_client, job, {"stage": "done", "progress": 100, "usage": usage})
        job.refresh_from_db()
        assert job.status == Status.COMPLETED
        assert job.finished_at is not None
        steps = job.metadata["steps"]
        assert [step["code"] for step in steps] == ["extracting_text", "analyzing"]
        assert all(step["status"] == "done" and step["finished_at"] for step in steps)
        assert job.metadata["usage"] == usage

        response = self.post(api_client, job, {"stage": "analyzing", "status": "RUNNING", "progress": 50})
        assert response.json()["status"] == "ignored"
        job.refresh_from_db()
        contract.refresh_from_db()
        assert job.status == Status.COMPLETED and job.progress == 100
        assert contract.processing_status == "COMPLETED"

    def test_failure_marks_the_failing_step(self, api_client, make_contract):
        contract = make_contract("falla")
        job = make_job(contract)
        self.post(api_client, job, {"stage": "embedding"})
        self.post(
            api_client, job, {"stage": "failed", "status": "FAILED", "error": {"message": "boom", "stage": "embedding"}}
        )
        job.refresh_from_db()
        contract.refresh_from_db()
        assert job.metadata["steps"][-1]["status"] == "failed"
        assert job.error == {"message": "boom", "stage": "embedding"}
        assert contract.processing_status == "ERROR"


@pytest.mark.unit
@pytest.mark.django_db
@pytest.mark.usefixtures("file_library_enabled")
class TestProposals:
    def test_accepting_some_fields_applies_only_those(self, session_client, workspace, make_contract):
        contract = make_contract(
            "propuesta", nombre_grupo="Viejo", fecha_fin=date(2030, 1, 1), fecha_fin_efectiva=date(2030, 1, 1)
        )
        contract.proposed_data = {
            "tituloContrato": "Nuevo título",
            "fechaFin": "2031-06-30",
            "nombreGrupo": None,
            "_model_used": "deepseek-v9",
        }
        contract.save()
        base = f"/api/workspaces/{workspace.slug}/contracts/{contract.id}/"

        changes = {row["field"]: row for row in session_client.get(base).json()["proposed_changes"]}
        assert changes["titulo"] == {"field": "titulo", "current": "propuesta", "proposed": "Nuevo título"}
        assert changes["fecha_fin"]["proposed"] == "2031-06-30"

        response = session_client.post(
            f"{base}reanalyze/confirm/", {"accept": True, "fields": ["titulo", "nombre_grupo"]}, format="json"
        )
        assert response.status_code == 200
        contract.refresh_from_db()
        assert contract.titulo == "Nuevo título"
        # An explicit null on an accepted field clears it
        assert contract.nombre_grupo is None
        assert contract.fecha_fin == date(2030, 1, 1)
        assert contract.proposed_data is None
        assert contract.ai_model_used == "deepseek-v9"
        assert contract.processed_at is not None

    def test_discarding_leaves_the_contract_as_it_was(self, session_client, workspace, make_contract):
        contract = make_contract("descartar", ai_model_used="old")
        contract.proposed_data = {"tituloContrato": "Otro"}
        contract.save()
        session_client.post(
            f"/api/workspaces/{workspace.slug}/contracts/{contract.id}/reanalyze/confirm/",
            {"accept": False},
            format="json",
        )
        contract.refresh_from_db()
        assert contract.titulo == "descartar" and contract.ai_model_used == "old" and contract.proposed_data is None


@pytest.mark.unit
@pytest.mark.django_db
@pytest.mark.usefixtures("file_library_enabled")
class TestRetryAndCancel:
    def test_single_retry_refuses_while_a_job_runs(self, session_client, workspace, make_contract):
        contract = make_contract("ocupado")
        make_job(contract)
        response = session_client.post(
            f"/api/workspaces/{workspace.slug}/contracts/{contract.id}/retry/", {}, format="json"
        )
        assert response.status_code == 409
        assert response.json() == {"error": "job_active"}

    def test_full_retry_skips_ocr_when_text_exists(self, session_client, workspace, make_contract):
        contract = make_contract("con-texto", extracted_text="texto", proposed_data={"tituloContrato": "x"})
        with mock.patch(DISPATCH) as dispatch, TestCase.captureOnCommitCallbacks(execute=True):
            response = session_client.post(
                f"/api/workspaces/{workspace.slug}/contracts/{contract.id}/retry/", {}, format="json"
            )
        assert response.status_code == 201
        dispatch.assert_called_once()
        options = response.json()["metadata"]["retry_options"]
        assert options["extract_text"] is False and options["ai_analysis"] is True
        contract.refresh_from_db()
        # A new run drops the pending proposal
        assert contract.proposed_data is None

    def test_cancel_restores_the_contract(self, session_client, workspace, make_contract):
        contract = make_contract("cancelar", processing_status="PROCESSING", processed_at=timezone.now())
        job = make_job(contract, workflow_instance_id="abc")
        with mock.patch(TERMINATE) as terminate, TestCase.captureOnCommitCallbacks(execute=True):
            response = session_client.post(
                f"/api/workspaces/{workspace.slug}/contracts/{contract.id}/jobs/{job.id}/cancel/"
            )
        assert response.status_code == 200
        terminate.assert_called_once_with(str(job.id))
        job.refresh_from_db()
        contract.refresh_from_db()
        assert job.status == Status.CANCELLED and job.current_stage == "cancelled"
        assert contract.processing_status == "COMPLETED"


@pytest.mark.unit
@pytest.mark.django_db
class TestReaper:
    def test_stuck_jobs_fail_and_live_ones_stay(self, make_contract):
        now = timezone.now()
        never_sent = make_job(make_contract("nunca", processing_status="PROCESSING"), status=Status.QUEUED)
        silent = make_job(
            make_contract("mudo", processing_status="PROCESSING", processed_at=now), workflow_instance_id="x"
        )
        alive = make_job(make_contract("vivo", processing_status="PROCESSING"), workflow_instance_id="y")
        ContractProcessingJob.objects.filter(id=never_sent.id).update(created_at=now - timedelta(minutes=31))
        ContractProcessingJob.objects.filter(id=silent.id).update(updated_at=now - timedelta(minutes=46))

        with mock.patch(TERMINATE) as terminate:
            reaped = reap_stuck_contract_jobs()

        assert sorted(reaped) == sorted([str(never_sent.id), str(silent.id)])
        terminate.assert_called_once_with(str(silent.id))
        for job in (never_sent, silent, alive):
            job.refresh_from_db()
        assert never_sent.status == Status.FAILED and never_sent.current_stage == "timeout"
        assert never_sent.error == {"message": "Sin avance; se detuvo", "stage": "timeout"}
        assert alive.status == Status.RUNNING
        assert Contract.objects.get(id=never_sent.contract_id).processing_status == "ERROR"
        assert Contract.objects.get(id=silent.contract_id).processing_status == "COMPLETED"


@pytest.mark.unit
class TestExpiryThresholds:
    today = date(2026, 1, 1)

    def test_thresholds(self):
        end = self.today + timedelta(days=45)
        assert pending_expiry_alert(end, {}, self.today) == (45, [60])
        assert pending_expiry_alert(end, {"for": end.isoformat(), "sent": [60]}, self.today) is None
        # First seen inside two windows: one alert covering both
        assert pending_expiry_alert(self.today + timedelta(days=20), {}, self.today) == (20, [60, 30])
        assert pending_expiry_alert(self.today + timedelta(days=90), {}, self.today) is None
        assert pending_expiry_alert(self.today - timedelta(days=1), {}, self.today) is None

    def test_a_moved_date_starts_over(self):
        end = self.today + timedelta(days=5)
        assert pending_expiry_alert(end, {"for": "2025-01-01", "sent": [60, 30, 7]}, self.today) == (5, [60, 30, 7])


@pytest.mark.unit
@pytest.mark.django_db
class TestExpiryAlertTask:
    def test_digest_once_per_threshold(self, make_contract, create_user):
        today = timezone.now().date()
        soon = make_contract("pronto", fecha_fin_efectiva=today + timedelta(days=25))
        make_contract("lejos", fecha_fin_efectiva=today + timedelta(days=200))
        with mock.patch("plane.bgtasks.contract_task._send_html_email") as send:
            assert send_contract_expiry_alerts() == {"contracts": 1, "recipients": 1}
            assert send.call_args.args[2] == create_user.email
            soon.refresh_from_db()
            assert soon.expiry_alerts == {"for": soon.fecha_fin_efectiva.isoformat(), "sent": [60, 30]}
            assert send_contract_expiry_alerts() == {"contracts": 0, "recipients": 0}


@pytest.mark.unit
@pytest.mark.django_db
@pytest.mark.usefixtures("file_library_enabled")
class TestContractList:
    def test_pagination_filters_and_order(self, session_client, workspace, make_contract):
        today = timezone.now().date()
        make_contract("a", fecha_fin_efectiva=today + timedelta(days=10), tipo_contrato="ARTISTAS")
        make_contract("b", fecha_fin_efectiva=today + timedelta(days=40), tipo_contrato="EDICION")
        make_contract("c", fecha_fin_efectiva=today + timedelta(days=400), tipo_contrato="OTRO", proposed_data={})
        make_contract("d", tipo_contrato="SERVICIOS")
        base = f"/api/workspaces/{workspace.slug}/contracts/"

        # Without per_page the plain array stays
        assert isinstance(session_client.get(base).json(), list)

        first = session_client.get(base, {"per_page": 2, "order": "fin_efectiva"}).json()
        assert [row["titulo"] for row in first["results"]] == ["a", "b"]
        assert first["total"] == 4 and first["next_cursor"] == "2"
        assert first["results"][0]["days_to_expiry"] == 10
        second = session_client.get(
            base, {"per_page": 2, "order": "fin_efectiva", "cursor": first["next_cursor"]}
        ).json()
        # Undated contracts sort last
        assert [row["titulo"] for row in second["results"]] == ["c", "d"]
        assert second["next_cursor"] is None
        assert second["results"][0]["has_proposal"] is True

        expiring = session_client.get(base, {"vence_en": 30}).json()
        assert [row["titulo"] for row in expiring] == ["a"]
        typed = session_client.get(base, {"tipo": "ARTISTAS,EDICION"}).json()
        assert {row["titulo"] for row in typed} == {"a", "b"}

    def test_duplicates_bulk_update_and_export(self, session_client, workspace, make_contract):
        hashed = make_contract("hash", content_hash="a" * 64)
        legacy = make_contract("legacy")
        base = f"/api/workspaces/{workspace.slug}/contracts/"
        response = session_client.post(
            f"{base}check-duplicates/",
            {
                "files": [
                    {"name": "x.pdf", "size": 1, "hash": "A" * 64},
                    {"name": "legacy.pdf", "size": 10, "hash": "b" * 64},
                    {"name": "new.pdf", "size": 3, "hash": "c" * 64},
                ]
            },
            format="json",
        )
        results = [row["duplicate_of"]["id"] if row["duplicate_of"] else None for row in response.json()["results"]]
        assert results == [str(hashed.id), str(legacy.id), None]

        response = session_client.post(
            f"{base}bulk/",
            {
                "action": "update",
                "ids": [str(hashed.id), str(legacy.id)],
                "fields": {"tipo_contrato": "LICENCIA", "fecha_fin": "2001-01-01"},
            },
            format="json",
        )
        assert response.status_code == 200
        hashed.refresh_from_db()
        assert hashed.tipo_contrato == "LICENCIA" and hashed.estatus_contrato == "FINALIZADO"
        bad = session_client.post(
            f"{base}bulk/", {"action": "update", "ids": [str(hashed.id)], "fields": {"titulo": "x"}}, format="json"
        )
        assert bad.status_code == 400

        export = session_client.get(f"{base}export/", {"type": "csv", "tipo": "LICENCIA"})
        assert export.status_code == 200
        body = export.content.decode("utf-8-sig")
        assert body.splitlines()[0].startswith("Título,Archivo")
        assert "hash.pdf" in body and "legacy.pdf" in body


@pytest.mark.unit
@pytest.mark.django_db
@pytest.mark.usefixtures("file_library_enabled")
class TestTemplatesAndRequests:
    @pytest.fixture
    def template(self, workspace):
        from plane.db.models import ContractTemplate, ContractTemplateVariant

        template = ContractTemplate.objects.create(workspace=workspace, name="Licencia")
        for index, name in enumerate(("Principal", "Corta")):
            asset = FileAsset.objects.create(workspace=workspace, asset=f"t/{name}.docx", attributes={"name": name})
            ContractTemplateVariant.objects.create(
                workspace=workspace, template=template, name=name, source_asset=asset, is_default=index == 0
            )
        return template

    def test_rename_template_and_delete_variants(self, session_client, workspace, template):
        base = f"/api/workspaces/{workspace.slug}"
        response = session_client.patch(
            f"{base}/contract-templates/{template.id}/", {"name": "Licencia 2026", "description": "Uso"}, format="json"
        )
        assert response.status_code == 200
        assert response.json()["name"] == "Licencia 2026" and response.json()["description"] == "Uso"

        principal, short = template.variants.order_by("created_at")
        response = session_client.delete(f"{base}/contract-variants/{principal.id}/")
        assert response.status_code == 200
        remaining = response.json()["variants"]
        assert [variant["name"] for variant in remaining] == ["Corta"]
        assert remaining[0]["is_default"] is True
        assert session_client.delete(f"{base}/contract-variants/{short.id}/").status_code == 409

    def test_cancel_an_unsent_request_and_require_the_module(self, session_client, workspace, template):
        from plane.db.models import ContractSignatureRequest, ContractTemplateRevision

        variant = template.variants.first()
        revision = ContractTemplateRevision.objects.create(
            workspace=workspace,
            variant=variant,
            revision=1,
            source_asset=variant.source_asset,
            pdf_asset=variant.source_asset,
            content_sha256="0" * 64,
        )
        request = ContractSignatureRequest.objects.create(
            workspace=workspace, revision=revision, title="Doc", status=ContractSignatureRequest.Status.READY
        )
        url = f"/api/workspaces/{workspace.slug}/contract-signature-requests/{request.id}/cancel/"
        assert session_client.post(url).json()["status"] == "CANCELLED"
        assert session_client.post(url).status_code == 409

        WorkspaceFeature.objects.filter(workspace=workspace).update(is_enabled=False)
        assert session_client.get(f"/api/workspaces/{workspace.slug}/contract-templates/").status_code == 403
