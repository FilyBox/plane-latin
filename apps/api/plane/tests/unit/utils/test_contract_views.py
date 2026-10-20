# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from datetime import date

import pytest

from plane.app.views.contract.base import delete_contracts, live_contracts, shifted_effective_end
from plane.app.views.contract.internal import apply_extracted_data
from plane.db.models import Contract, FileAsset
from plane.utils.contract_views import apply_contract_view

TODAY = date(2026, 6, 15)
PAST = date(2026, 1, 1)
FUTURE = date(2027, 1, 1)


@pytest.mark.unit
@pytest.mark.django_db
class TestContractViews:
    @pytest.fixture
    def make(self, workspace):
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

    def names(self, view):
        return set(apply_contract_view(live_contracts(), view, TODAY).values_list("titulo", flat=True))

    def test_each_contract_lands_in_exactly_the_right_views(self, make):
        make("ended", fecha_fin_efectiva=PAST, estatus_contrato="VIGENTE", es_editorial=False)
        make("running", fecha_fin_efectiva=FUTURE, estatus_contrato="FINALIZADO", es_editorial=False)
        make("ends_today", fecha_fin_efectiva=TODAY, es_editorial=False)
        make("undated_finished", estatus_contrato="FINALIZADO", es_editorial=False)
        make("undated_unknown", estatus_contrato="NO_ESPECIFICADO", es_editorial=False)
        make("undated_null_status", estatus_contrato=None, es_editorial=False)
        make("unclassified_running", fecha_fin_efectiva=FUTURE)
        make("editorial_ended", fecha_fin_efectiva=PAST, es_editorial=True)
        make("editorial_running", fecha_fin_efectiva=FUTURE, es_editorial=True)
        make("uploading", processing_status="PROCESSING")
        make("failed", processing_status="ERROR", es_editorial=False, fecha_fin_efectiva=FUTURE)

        # The date wins over the status the AI wrote; without a date the status decides.
        assert self.names("vencidos") == {"ended", "undated_finished", "uploading"}
        assert self.names("vigentes") == {
            "running",
            "ends_today",
            "undated_unknown",
            "undated_null_status",
            "unclassified_running",
            "failed",
            "uploading",
        }
        assert self.names("editoriales") == {"editorial_ended", "editorial_running", "uploading"}

    def test_classified_contract_stays_in_its_view_while_rerun(self, make):
        make("rerun", processing_status="PROCESSING", es_editorial=True, fecha_fin_efectiva=FUTURE)
        assert self.names("editoriales") == {"rerun"}
        assert self.names("vigentes") == set()

    def test_deleted_file_hides_the_contract(self, make):
        contract = make("gone", fecha_fin_efectiva=FUTURE, es_editorial=False)
        FileAsset.objects.filter(id=contract.file_asset_id).update(is_deleted=True)
        assert self.names("vigentes") == set()

    def test_deleting_a_contract_removes_the_analysis_and_hides_the_pdf(self, make):
        contract = make("doomed", fecha_fin_efectiva=FUTURE, es_editorial=False)
        delete_contracts([contract])
        assert not Contract.all_objects.filter(id=contract.id).exists()
        asset = FileAsset.all_objects.get(id=contract.file_asset_id)
        assert asset.is_deleted is True and asset.deleted_at is not None


@pytest.mark.unit
class TestEffectiveEnd:
    def test_moving_the_end_keeps_the_extension_gap(self):
        assert shifted_effective_end(date(2026, 1, 1), date(2027, 1, 1), date(2026, 3, 1)) == date(2027, 3, 1)

    def test_without_a_previous_effective_end_it_is_the_end(self):
        assert shifted_effective_end(None, None, date(2026, 3, 1)) == date(2026, 3, 1)
        assert shifted_effective_end(date(2026, 1, 1), None, date(2026, 3, 1)) == date(2026, 3, 1)

    def test_clearing_the_end_clears_the_effective_end(self):
        assert shifted_effective_end(date(2026, 1, 1), date(2026, 1, 1), None) is None


@pytest.mark.unit
@pytest.mark.django_db
class TestApplyExtractedData:
    @pytest.fixture
    def contract(self, workspace):
        asset = FileAsset.objects.create(
            workspace=workspace,
            asset=f"{workspace.slug}/c.pdf",
            attributes={"name": "c.pdf", "size": 1, "type": "application/pdf"},
            entity_type="FILE_LIBRARY",
        )
        return Contract.objects.create(
            workspace=workspace,
            file_asset=asset,
            fecha_fin=date(2026, 1, 1),
            fecha_fin_efectiva=date(2027, 6, 1),
        )

    def test_editorial_false_is_stored(self, contract):
        apply_extracted_data(contract, {"esEditorial": False})
        contract.refresh_from_db()
        assert contract.es_editorial is False

    def test_editorial_accepts_string_answers(self, contract):
        apply_extracted_data(contract, {"esEditorial": "true"})
        contract.refresh_from_db()
        assert contract.es_editorial is True

    def test_classification_alone_leaves_the_effective_end(self, contract):
        apply_extracted_data(contract, {"esEditorial": True})
        contract.refresh_from_db()
        assert contract.fecha_fin_efectiva == date(2027, 6, 1)

    def test_reanalysis_without_extension_refreshes_a_stale_effective_end(self, contract):
        apply_extracted_data(contract, {"fechaFin": "2026-09-30", "esPosibleExpandirlo": "NO"})
        contract.refresh_from_db()
        assert contract.fecha_fin_efectiva == date(2026, 9, 30)
