# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""How the chats find people, IDs and dates across many contracts."""

from datetime import date

import pytest

from plane.db.models import Contract, FileAsset
from plane.utils.contract_text_search import Term, closest_cluster, fold_aligned

SECRET = "test-internal-secret"


def hits(keyword, text):
    folded = fold_aligned(text)
    return [text[start:end] for start, end in Term(keyword).occurrences(folded)]


@pytest.mark.unit
class TestTerms:
    def test_acronym_is_a_whole_word(self):
        text = "La línea de cine que determinen. Identificación: INE 123."
        assert hits("INE", text) == ["INE"]

    def test_dotted_acronym(self):
        assert hits("INE", "presenta su I.N.E. vigente") == ["I.N.E."]

    def test_ine_finds_its_other_names(self):
        text = "credencial para votar expedida por el Instituto Federal Electoral (IFE)"
        assert hits("INE", text) == ["credencial para votar", "Instituto Federal Electoral", "IFE"]

    def test_ife_is_not_found_inside_words(self):
        assert hits("INE", "manifestar su voluntad") == []

    def test_accents_and_line_breaks(self):
        assert hits("jose serrano", "JOSÉ\nSERRANO MONTOYA") == ["JOSÉ\nSERRANO"]

    def test_long_terms_match_inside_words(self):
        assert hits("regalia", "las regalías del artista") == ["regalía"]

    def test_folded_text_keeps_positions(self):
        text = "Montoyá INE"
        assert len(fold_aligned(text)) == len(text)

    def test_closest_cluster(self):
        assert closest_cluster([[(0, 5), (100, 105)], [(110, 113)]]) == (100, 113)
        assert closest_cluster([[(0, 5)], []]) is None


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


def post(api_client, workspace, path, payload):
    response = api_client.post(
        f"/api/internal/workspaces/{workspace.id}/contracts/{path}/",
        payload,
        format="json",
        HTTP_X_PLANE_INTERNAL_KEY=SECRET,
    )
    assert response.status_code == 200, response.content
    return response.json()


@pytest.mark.unit
@pytest.mark.django_db
class TestSearchAndScan:
    @pytest.fixture(autouse=True)
    def internal_secret(self, settings):
        settings.PLANE_INTERNAL_API_SECRET = SECRET

    def test_person_filter_ignores_accents(self, api_client, workspace, make_contract):
        make_contract("accented", involucrados="José Serrano Montoya")
        for spelling in ("jose serrano montoya", "JOSÉ SERRANO"):
            assert post(api_client, workspace, "search", {"person": spelling})["total"] == 1
        assert post(api_client, workspace, "search", {"names": ["jose serrano montoya"]})["total"] == 1

    def test_undated_contracts_are_reported_and_can_be_included(self, api_client, workspace, make_contract):
        make_contract("old", involucrados="Serrano", fecha_inicio=date(2016, 5, 1))
        make_contract("undated", involucrados="Serrano")
        make_contract("new", involucrados="Serrano", fecha_inicio=date(2020, 1, 1))
        payload = {"person": "serrano", "date_field": "inicio", "date_to": "2017-12-31"}
        data = post(api_client, workspace, "search", payload)
        assert (data["total"], data["without_date"]) == (1, 1)
        data = post(api_client, workspace, "search", {**payload, "include_undated": True})
        assert (data["total"], data["without_date"]) == (2, 0)

    def test_scan_ignores_ine_inside_words(self, api_client, workspace, make_contract):
        make_contract("noise", extracted_text="Firmado en línea por José Serrano Montoya. Cine.")
        make_contract("real", extracted_text="SERRANO MONTOYA JOSE se identifica con credencial para votar.")
        data = post(api_client, workspace, "scan", {"keywords": ["Serrano Montoya", "INE"], "match": "all"})
        assert [row["file_name"] for row in data["results"]] == ["real.pdf"]

    def test_scan_near_requires_terms_together(self, api_client, workspace, make_contract):
        far = "Comparece Serrano Montoya. " + "Cláusula de pago. " * 200 + "Testigo: Ana Ruiz, INE 999."
        make_contract("far", extracted_text=far)
        make_contract("close", extracted_text="Serrano Montoya, quien presenta su INE número 123.")
        data = post(api_client, workspace, "scan", {"keywords": ["Serrano Montoya", "INE"], "near": 300})
        assert [row["file_name"] for row in data["results"]] == ["close.pdf"]
        assert "INE" in data["results"][0]["excerpts"][0]["text"]
