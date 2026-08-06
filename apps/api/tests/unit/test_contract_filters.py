from plane.app.views.contract.base import _get_contract_ordering


def test_contract_ordering_supports_recent_and_name_options():
    assert _get_contract_ordering("-created_at") == ("-created_at",)
    assert _get_contract_ordering("-updated_at") == ("-updated_at", "-created_at")
    assert _get_contract_ordering("titulo") == ("titulo", "-created_at")
    assert _get_contract_ordering("-titulo") == ("-titulo", "-created_at")


def test_contract_ordering_falls_back_to_recently_created():
    assert _get_contract_ordering("unsupported") == ("-created_at",)
