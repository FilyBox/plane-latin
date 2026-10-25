# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Deep reviews: sizing without reading texts, counters, pausing and access."""

import pytest

from plane.db.models import AssistantDeepReview, AssistantDeepReviewItem, Contract, FileAsset
from plane.utils.deep_review import (
    contracts_with_text,
    create_draft,
    process_payload,
    record_result,
    without_text_count,
)

SECRET = "test-internal-secret"
Status = AssistantDeepReview.Status


@pytest.fixture(autouse=True)
def internal_secret(settings):
    settings.PLANE_INTERNAL_API_SECRET = SECRET


@pytest.fixture
def make_contract(workspace):
    def make(name, text):
        asset = FileAsset.objects.create(
            workspace=workspace,
            asset=f"{workspace.slug}/{name}.pdf",
            attributes={"name": f"{name}.pdf", "size": 1, "type": "application/pdf"},
            entity_type="FILE_LIBRARY",
        )
        return Contract.objects.create(workspace=workspace, file_asset=asset, titulo=name, extracted_text=text)

    return make


@pytest.fixture
def review(workspace, create_user, make_contract):
    first = make_contract("uno", "a" * 1000)
    second = make_contract("dos", "ñ" * 1000)  # two bytes per character
    make_contract("sin texto", None)
    sizes = dict(contracts_with_text(workspace.id).values_list("id", "size"))
    draft = create_draft(workspace, create_user, "¿Tiene exclusividad?", sizes)
    draft.status = Status.RUNNING
    draft.estimate_usd = 0.01
    draft.save()
    return draft, first, second


def result(**fields):
    return {"status": "done", "matches": True, "confidence": 80, "reason": "sí", "cost_usd": 0.001, **fields}


@pytest.mark.unit
@pytest.mark.django_db
class TestDeepReview:
    def test_sizes_come_from_octet_length(self, review, workspace):
        draft, first, second = review
        sizes = dict(draft.items.values_list("contract_id", "bytes"))
        assert sizes == {first.id: 1000, second.id: 2000}
        assert draft.total_bytes == 3000
        assert without_text_count(workspace.id) == 1

    def test_a_retried_report_counts_once(self, review):
        draft, first, _ = review
        assert record_result(draft.id, first.id, result()) == "continue"
        assert record_result(draft.id, first.id, result()) == "continue"
        draft.refresh_from_db()
        assert draft.done_count == 1
        assert draft.done_bytes == 1000
        assert draft.spent_usd == pytest.approx(0.001)

    def test_pauses_when_the_projection_goes_over(self, review):
        draft, first, _ = review
        # 1000 of 3000 bytes cost $0.01 → projected $0.03, estimate $0.01
        assert record_result(draft.id, first.id, result(cost_usd=0.01)) == "pause"
        draft.refresh_from_db()
        assert draft.status == Status.PAUSED
        assert draft.pause_reason == "over_estimate"
        assert draft.events[-1]["kind"] == "paused"
        assert draft.events[-1]["projection"] == pytest.approx(0.03)

    def test_process_lists_contracts_in_the_order_they_finished(self, review):
        draft, first, second = review
        record_result(draft.id, second.id, result(matches=False))
        record_result(draft.id, first.id, {"status": "failed", "error": "timeout"})
        draft.refresh_from_db()
        items = process_payload(draft)["items"]
        assert [item["contract_id"] for item in items] == [str(second.id), str(first.id)]
        assert items[1]["status"] == "FAILED" and items[1]["error"] == "timeout"

    def test_no_pause_once_the_admin_continued(self, review):
        draft, first, _ = review
        AssistantDeepReview.objects.filter(id=draft.id).update(alerts_muted=True)
        assert record_result(draft.id, first.id, result(cost_usd=0.01)) == "continue"

    def test_no_balance_stops_the_run(self, review):
        draft, first, _ = review
        payload = {"status": "failed", "error_code": "insufficient_balance"}
        assert record_result(draft.id, first.id, payload) == "stop"
        draft.refresh_from_db()
        assert draft.status == Status.STOPPING
        assert draft.failed_count == 1

    def test_text_only_for_a_running_review_and_its_own_contracts(self, review, api_client, make_contract):
        draft, first, _ = review
        other = make_contract("ajeno", "texto")
        headers = {"HTTP_X_PLANE_INTERNAL_KEY": SECRET}
        url = f"/api/internal/assistant/deep-reviews/{draft.id}/contracts/{{}}/text/"

        assert api_client.get(url.format(first.id)).status_code in (401, 403)
        response = api_client.get(url.format(first.id), **headers)
        assert response.json()["text"] == "a" * 1000
        assert AssistantDeepReviewItem.objects.get(review=draft, contract=first).status == "RUNNING"
        assert api_client.get(url.format(other.id), **headers).json() == {"action": "skip"}

        AssistantDeepReview.objects.filter(id=draft.id).update(status=Status.PAUSED)
        assert api_client.get(url.format(first.id), **headers).json() == {"action": "pause"}
