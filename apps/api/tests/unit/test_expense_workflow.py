from datetime import date
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import patch
from django.utils import timezone

import pytest
from plane.utils.expense_recurrence import expense_dates, materialize_expenses
from plane.utils.budgeting import scenario_forecast

pytestmark = pytest.mark.unit


def test_month_end_and_leap_year_recurrence_remain_anchored():
    assert list(expense_dates(date(2024, 1, 31), "MONTHLY", date(2024, 4, 30))) == [
        date(2024, 1, 31), date(2024, 2, 29), date(2024, 3, 31), date(2024, 4, 30)
    ]
    assert list(expense_dates(date(2024, 2, 29), "ANNUAL", date(2028, 2, 29)))[-1] == date(2028, 2, 29)


@pytest.mark.parametrize("recurrence, count", [("ONE_TIME", 1), ("DAILY", 31), ("WEEKLY", 5), ("BIWEEKLY", 3)])
def test_recurrence_end_is_inclusive(recurrence, count):
    assert len(list(expense_dates(date(2026, 1, 1), recurrence, date(2026, 1, 31)))) == count


def test_forecast_projects_series_without_double_counting_real_occurrences():
    scenario = SimpleNamespace(fiscal_year=2026, period_start=date(2026, 1, 1), period_end=date(2026, 3, 31))
    root = SimpleNamespace(id="root", expense_date=date(2025, 12, 31), recurrence="MONTHLY", recurrence_end=None,
                           recurrence_paused=False, amount=Decimal("100.00"), currency="MXN", description="Rent", vendor="", reference="")
    actual = SimpleNamespace(id="actual", series_id="root", expense_date=date(2026, 1, 31), recurrence="ONE_TIME",
                             amount=Decimal("120.00"), currency="MXN", description="Rent", vendor="", reference="")
    forecast = scenario_forecast(scenario, [], [], [root, actual])
    assert forecast["results"][0]["annual"]["expenses"] == "320.00"
    root.recurrence_paused = True
    assert scenario_forecast(scenario, [], [], [root, actual])["results"][0]["annual"]["expenses"] == "120.00"


@pytest.mark.django_db
def test_materialization_is_idempotent_pending_and_does_not_restore_deleted_rows():
    from plane.db.models import Expense, Workspace
    workspace = Workspace.objects.create(name="Expense tests", slug="expense-workflow-tests")
    root = Expense.objects.create(workspace=workspace, expense_date=date(2026, 1, 31), amount="100.00",
                                  currency="MXN", recurrence="MONTHLY", recurrence_end=date(2026, 3, 31),
                                  status="PAID", concept="Rent", tags=["Office"])
    with patch("django.utils.timezone.localdate", return_value=date(2026, 6, 1)):
        materialize_expenses(workspace.id)
        materialize_expenses(workspace.id)
        assert root.occurrences.count() == 2
        assert set(root.occurrences.values_list("status", flat=True)) == {"PENDING"}
        assert set(root.occurrences.values_list("paid_at", flat=True)) == {None}
        Expense.objects.filter(series=root, expense_date=date(2026, 2, 28)).update(deleted_at=timezone.now())
        materialize_expenses(workspace.id)
        assert root.occurrences.count() == 1


@pytest.mark.django_db
def test_serializer_rejects_cross_workspace_categories_and_invalid_recurrence():
    from plane.db.models import Workspace, ExpenseCategory
    from plane.app.serializers.finance import ExpenseSerializer
    workspace = Workspace.objects.create(name="A", slug="expense-tests-a")
    other = Workspace.objects.create(name="B", slug="expense-tests-b")
    category = ExpenseCategory.objects.create(workspace=other, name="Private")
    payload = {"amount": "12.30", "expense_date": "2026-01-31", "category": str(category.id)}
    serializer = ExpenseSerializer(data=payload, context={"workspace_id": workspace.id})
    assert not serializer.is_valid()
    assert "category" in serializer.errors
    serializer = ExpenseSerializer(data={**payload, "category": None, "recurrence_end": "2026-01-01"}, context={"workspace_id": workspace.id})
    assert not serializer.is_valid()
    assert "recurrence_end" in serializer.errors
