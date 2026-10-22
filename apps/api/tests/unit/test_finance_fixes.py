"""Budgets and expenses: imports as reviewed drafts, office moves that never
rewrite other budgets, recurring series, payroll scoping and validation."""

from datetime import date, timedelta
from decimal import Decimal
from unittest.mock import patch

import pytest
from django.utils import timezone
from rest_framework import serializers as drf_serializers

from plane.db.models import (
    BudgetScenario,
    Employee,
    Expense,
    ExpenseCategory,
    FinancialVariable,
    Office,
    Salary,
    Workspace,
)
from plane.db.models.finance import BudgetScenarioEmployee, BudgetScenarioVariable, ExpenseImport
from plane.tests.factories import WorkspaceFactory

pytestmark = [pytest.mark.unit, pytest.mark.django_db]


def scenario(workspace, name="Plan 2026", currency="MXN", status="DRAFT"):
    return BudgetScenario.objects.create(
        workspace=workspace,
        name=name,
        fiscal_year=2026,
        period_start=date(2026, 1, 1),
        period_end=date(2026, 12, 31),
        currency=currency,
        status=status,
    )


def office(workspace, name="LATIN"):
    return Office.objects.create(workspace=workspace, name=name)


def person_with_salary(workspace, at_office):
    employee = Employee.objects.create(
        workspace=workspace, office=at_office, full_name="Ana", hire_date=date(2024, 1, 1)
    )
    salary = Salary.objects.create(
        workspace=workspace,
        employee=employee,
        office=at_office,
        amount=Decimal("30000"),
        currency="MXN",
        effective_from=date(2024, 1, 1),
    )
    return employee, salary


class TestImportReview:
    def job(self, workspace, budget=None):
        from plane.db.models import FileAsset

        asset = FileAsset.objects.create(workspace=workspace, attributes={"name": "f.xml"}, asset="f.xml")
        return ExpenseImport.objects.create(workspace=workspace, asset=asset, scenario=budget)

    def test_suggests_the_active_budget_holding_the_date_and_a_matching_category(self):
        from plane.app.views.finance.imports import _suggestions

        workspace = WorkspaceFactory()
        scenario(workspace, "Draft")
        active = scenario(workspace, "Active", status="ACTIVE")
        scenario(workspace, "Dollars", currency="USD", status="ACTIVE")
        rent = ExpenseCategory.objects.create(workspace=workspace, name="Renta")
        ExpenseCategory.objects.create(workspace=workspace, name="Viáticos")

        suggestion = _suggestions(
            self.job(workspace),
            {"expense_date": "2026-10-05", "currency": "mxn", "tags": ["renta", "oficina"], "concept": "Renta"},
        )

        assert suggestion == {"scenario": str(active.id), "category": str(rent.id)}

    def test_keeps_the_budget_the_upload_was_started_from(self):
        from plane.app.views.finance.imports import _suggestions

        workspace = WorkspaceFactory()
        chosen = scenario(workspace, "Chosen")
        scenario(workspace, "Active", status="ACTIVE")

        suggestion = _suggestions(self.job(workspace, chosen), {"expense_date": "2026-10-05", "currency": "MXN"})

        assert suggestion["scenario"] == str(chosen.id)

    def test_flags_an_invoice_already_in_the_ledger(self):
        from plane.app.views.finance.imports import _duplicates

        workspace = WorkspaceFactory()
        recorded = Expense.objects.create(
            workspace=workspace,
            amount=Decimal("21460.00"),
            currency="MXN",
            expense_date=date(2026, 10, 5),
            vendor="Inmobiliaria",
            reference="6F1D2A3B",
        )

        by_reference = _duplicates(self.job(workspace), {"reference": "6f1d2a3b"})
        by_details = _duplicates(
            self.job(workspace),
            {"vendor": "INMOBILIARIA", "amount": "21460.00", "expense_date": "2026-10-05"},
        )

        assert [row["id"] for row in by_reference] == [str(recorded.id)]
        assert [row["id"] for row in by_details] == [str(recorded.id)]
        assert _duplicates(self.job(workspace), {"reference": "OTHER"}) == []


class TestOfficeMoves:
    def test_a_salary_shared_with_another_budget_is_not_moved(self):
        from plane.app.views.finance.records import BudgetRowEndpoint

        workspace = WorkspaceFactory()
        here, there = office(workspace), office(workspace, "SEANALYTICS")
        employee, salary = person_with_salary(workspace, here)
        first, second = scenario(workspace, "A"), scenario(workspace, "B")
        assignment = BudgetScenarioEmployee.objects.create(
            workspace=workspace, scenario=first, employee=employee, salary=salary, effective_from=date(2026, 1, 1)
        )
        BudgetScenarioEmployee.objects.create(
            workspace=workspace, scenario=second, employee=employee, salary=salary, effective_from=date(2026, 1, 1)
        )

        with pytest.raises(drf_serializers.ValidationError):
            BudgetRowEndpoint.move_to_office(first, f"salary:{assignment.id}", str(there.id))

        salary.refresh_from_db()
        assert salary.office_id == here.id

    def test_a_salary_only_this_budget_uses_moves(self):
        from plane.app.views.finance.records import BudgetRowEndpoint

        workspace = WorkspaceFactory()
        here, there = office(workspace), office(workspace, "SEANALYTICS")
        employee, salary = person_with_salary(workspace, here)
        budget = scenario(workspace)
        assignment = BudgetScenarioEmployee.objects.create(
            workspace=workspace, scenario=budget, employee=employee, salary=salary, effective_from=date(2026, 1, 1)
        )

        BudgetRowEndpoint.move_to_office(budget, f"salary:{assignment.id}", str(there.id))

        salary.refresh_from_db()
        assert salary.office_id == there.id

    def test_a_variable_name_clash_is_a_clear_error_not_a_crash(self):
        from plane.app.views.finance.records import BudgetRowEndpoint

        workspace = WorkspaceFactory()
        here, there = office(workspace), office(workspace, "SEANALYTICS")
        common = {"workspace": workspace, "name": "Renta", "amount": Decimal("1000"), "effective_from": date(2026, 1, 1)}
        variable = FinancialVariable.objects.create(office=here, **common)
        FinancialVariable.objects.create(office=there, **common)
        budget = scenario(workspace)
        assignment = BudgetScenarioVariable.objects.create(workspace=workspace, scenario=budget, variable=variable)

        with pytest.raises(drf_serializers.ValidationError):
            BudgetRowEndpoint.move_to_office(budget, f"variable:{assignment.id}", str(there.id))


class TestRecurringSeries:
    def series(self, workspace, **extra):
        return Expense.objects.create(
            workspace=workspace,
            expense_date=date(2026, 1, 15),
            amount=Decimal("100.00"),
            currency="MXN",
            recurrence="MONTHLY",
            concept="Renta",
            **extra,
        )

    def test_resuming_a_paused_series_does_not_backfill_the_pause(self):
        from plane.app.serializers.finance import ExpenseSerializer
        from plane.utils.expense_recurrence import materialize_expenses

        workspace = WorkspaceFactory()
        root = self.series(workspace, recurrence_paused=True)
        with patch("django.utils.timezone.localdate", return_value=date(2026, 6, 20)):
            serializer = ExpenseSerializer(root, data={"recurrence_paused": False}, partial=True)
            assert serializer.is_valid(), serializer.errors
            serializer.save()
            materialize_expenses(workspace.id)

        root.refresh_from_db()
        assert root.recurrence_resume_from == date(2026, 6, 20)
        assert list(root.occurrences.values_list("expense_date", flat=True)) == []
        with patch("django.utils.timezone.localdate", return_value=date(2026, 8, 1)):
            materialize_expenses(workspace.id)
        assert sorted(root.occurrences.values_list("expense_date", flat=True)) == [date(2026, 7, 15)]

    def test_runs_only_create_dates_after_the_latest_occurrence(self):
        from plane.utils.expense_recurrence import materialize_expenses

        workspace = WorkspaceFactory()
        root = self.series(workspace)
        with patch("django.utils.timezone.localdate", return_value=date(2026, 3, 20)):
            materialize_expenses(workspace.id)
        # A hard-removed February (no tombstone) is not brought back by later runs
        Expense.all_objects.filter(series=root, expense_date=date(2026, 2, 15)).delete()
        with patch("django.utils.timezone.localdate", return_value=date(2026, 4, 20)):
            materialize_expenses(workspace.id)

        assert sorted(root.occurrences.values_list("expense_date", flat=True)) == [
            date(2026, 3, 15),
            date(2026, 4, 15),
        ]


class TestPayrollScoping:
    def test_unknown_year_is_a_bad_request(self):
        from rest_framework.test import APIRequestFactory

        from plane.app.views.payroll.base import _requested_year

        request = APIRequestFactory().get("/", {"year": "abc"})
        request.query_params = request.GET
        year, refused = _requested_year(request)
        assert year is None and refused.status_code == 400

    def test_records_from_another_workspace_are_refused(self):
        from plane.app.views.payroll.base import _foreign

        workspace = WorkspaceFactory()
        other = Workspace.objects.create(name="Other", slug="payroll-other", owner=workspace.owner)
        assert _foreign(workspace.id, office=office(other)).status_code == 400
        assert _foreign(workspace.id, office=office(workspace)) is None


class TestValidation:
    def test_currency_is_stored_uppercase(self):
        from plane.app.serializers.finance import BudgetScenarioSerializer

        serializer = BudgetScenarioSerializer(
            data={
                "name": "Plan",
                "fiscal_year": 2026,
                "period_start": "2026-01-01",
                "period_end": "2026-12-31",
                "currency": "usd",
            }
        )
        assert serializer.is_valid(), serializer.errors
        assert serializer.validated_data["currency"] == "USD"

    def test_percentage_bonus_cannot_exceed_100(self):
        from plane.app.serializers.finance import BudgetBonusSerializer

        serializer = BudgetBonusSerializer(
            data={
                "name": "Bono",
                "calculation_type": "PERCENTAGE",
                "value": "150",
                "periodicity": "MONTHLY",
                "effective_from": "2026-01-01",
            }
        )
        assert not serializer.is_valid()
        assert "value" in serializer.errors


def test_stale_jobs_helper_window_is_thirty_minutes():
    from plane.app.views.finance.imports import STALE_AFTER

    assert STALE_AFTER == timedelta(minutes=30)
    assert timezone.now() - STALE_AFTER < timezone.now()


class TestPlannedVersusActual:
    def budget_with_rent(self, workspace, currency="MXN"):
        budget = scenario(workspace)
        variable = FinancialVariable.objects.create(
            workspace=workspace,
            office=office(workspace),
            name="Renta",
            amount=Decimal("1000"),
            currency=currency,
            effective_from=date(2026, 1, 1),
        )
        assignment = BudgetScenarioVariable.objects.create(workspace=workspace, scenario=budget, variable=variable)
        return budget, f"variable:{assignment.id}"

    def expense(self, workspace, budget, **extra):
        from plane.app.serializers.finance import ExpenseSerializer

        payload = {
            "concept": "Renta",
            "amount": "1200.00",
            "currency": "MXN",
            "expense_date": "2026-03-10",
            "scenario": str(budget.id),
            **extra,
        }
        serializer = ExpenseSerializer(data=payload, context={"workspace_id": workspace.id})
        assert serializer.is_valid(), serializer.errors
        return serializer.save(workspace_id=workspace.id)

    def test_an_expense_on_a_line_shows_as_that_line_and_month_actual(self):
        from plane.app.views.finance.base import _scenario_forecast_data

        workspace = WorkspaceFactory()
        budget, key = self.budget_with_rent(workspace)
        self.expense(workspace, budget, budget_line=key)
        self.expense(workspace, budget, amount="50.00")  # filed to the budget, no line
        self.expense(workspace, budget, budget_line=key, status="CANCELLED")

        forecast = _scenario_forecast_data(budget)
        line = next(line for line in forecast["lines"] if line["key"] == key)

        assert line["actual_total"] == "1200.00"
        assert next(cell for cell in line["actual"] if cell["month"] == 3)["amount"] == "1200.00"
        assert forecast["unassigned"] == [
            {
                "currency": "MXN",
                "months": [
                    {"year": 2026, "month": month, "amount": "50.00" if month == 3 else "0.00"}
                    for month in range(1, 13)
                ],
                "total": "50.00",
            }
        ]

    def test_a_line_from_another_budget_or_currency_is_refused(self):
        from plane.app.serializers.finance import ExpenseSerializer

        workspace = WorkspaceFactory()
        budget, key = self.budget_with_rent(workspace)
        other = scenario(workspace, "Other")
        common = {"concept": "Renta", "amount": "10", "expense_date": "2026-03-10", "budget_line": key}

        wrong_budget = ExpenseSerializer(
            data={**common, "currency": "MXN", "scenario": str(other.id)}, context={"workspace_id": workspace.id}
        )
        wrong_currency = ExpenseSerializer(
            data={**common, "currency": "USD", "scenario": str(budget.id)}, context={"workspace_id": workspace.id}
        )
        no_budget = ExpenseSerializer(data={**common, "currency": "MXN"}, context={"workspace_id": workspace.id})

        for serializer in (wrong_budget, wrong_currency, no_budget):
            assert not serializer.is_valid()
            assert "budget_line" in serializer.errors

    def test_moving_to_another_budget_drops_the_line(self):
        from plane.app.serializers.finance import ExpenseSerializer

        workspace = WorkspaceFactory()
        budget, key = self.budget_with_rent(workspace)
        other = scenario(workspace, "Other")
        expense = self.expense(workspace, budget, budget_line=key)
        assert expense.budget_row.row_key == key

        serializer = ExpenseSerializer(expense, data={"scenario": str(other.id)}, partial=True)
        assert serializer.is_valid(), serializer.errors
        serializer.save()
        expense.refresh_from_db()
        assert expense.budget_row is None
        assert ExpenseSerializer(expense).data["budget_line"] is None

    def test_the_line_label_comes_back_with_the_expense(self):
        from plane.app.serializers.finance import ExpenseSerializer

        workspace = WorkspaceFactory()
        budget, key = self.budget_with_rent(workspace)
        data = ExpenseSerializer(self.expense(workspace, budget, budget_line=key)).data

        assert data["budget_line"] == key
        assert data["budget_line_label"] == "Renta"

    def test_recurring_occurrences_keep_the_line(self):
        from plane.utils.expense_recurrence import materialize_expenses

        workspace = WorkspaceFactory()
        budget, key = self.budget_with_rent(workspace)
        root = self.expense(workspace, budget, budget_line=key, recurrence="MONTHLY", expense_date="2026-01-10")
        with patch("django.utils.timezone.localdate", return_value=date(2026, 2, 20)):
            materialize_expenses(workspace.id)

        assert list(root.occurrences.values_list("budget_row_id", flat=True)) == [root.budget_row_id]
