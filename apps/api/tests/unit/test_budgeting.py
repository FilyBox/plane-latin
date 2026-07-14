from datetime import date
from decimal import Decimal
from types import SimpleNamespace

import pytest

from plane.utils.budgeting import scenario_forecast


class RelatedList(list):
    def all(self):
        return self


@pytest.mark.unit
def test_scenario_forecast_combines_salary_benefits_bonus_and_variables():
    scenario = SimpleNamespace(
        fiscal_year=2026,
        period_start=date(2026, 1, 1),
        period_end=date(2026, 12, 31),
    )
    office = SimpleNamespace(aguinaldo_days=15)
    salary = SimpleNamespace(
        amount=Decimal("30000"),
        currency="MXN",
        office=office,
        daily_amount=lambda: Decimal("1000"),
    )
    bonus = SimpleNamespace(
        name="Performance",
        calculation_type="PERCENTAGE",
        value=Decimal("10"),
        periodicity="MONTHLY",
        effective_from=date(2026, 1, 1),
        effective_to=date(2026, 12, 31),
    )
    employee_assignment = SimpleNamespace(
        salary=salary,
        effective_from=date(2026, 1, 1),
        effective_to=date(2026, 12, 31),
        bonuses=RelatedList([bonus]),
    )
    rent = SimpleNamespace(
        currency="MXN",
        kind="EXPENSE",
        amount=Decimal("1000"),
        recurrence="MONTHLY",
        effective_from=date(2026, 1, 1),
        effective_to=date(2026, 12, 31),
    )
    grant = SimpleNamespace(
        currency="MXN",
        kind="INCOME",
        amount=Decimal("5000"),
        recurrence="ONE_TIME",
        effective_from=date(2026, 1, 1),
        effective_to=date(2026, 1, 1),
    )

    forecast = scenario_forecast(
        scenario,
        [employee_assignment],
        [SimpleNamespace(variable=rent), SimpleNamespace(variable=grant)],
    )

    row = forecast["results"][0]
    assert row["annual"] == {
        "salary": "365000.00",
        "benefits": "15000.00",
        "bonuses": "36000.00",
        "expenses": "12000.00",
        "income": "5000.00",
        "total": "423000.00",
    }
    assert row["months"][0]["total"] == "30000.00"
    assert row["months"][11]["benefits"] == "15000.00"


@pytest.mark.unit
def test_scenario_forecast_supports_cross_year_fiscal_periods():
    scenario = SimpleNamespace(
        fiscal_year=2026,
        period_start=date(2026, 7, 1),
        period_end=date(2027, 6, 30),
    )
    salary = SimpleNamespace(
        currency="MXN",
        office=SimpleNamespace(aguinaldo_days=15),
        daily_amount=lambda: Decimal("100"),
    )
    assignment = SimpleNamespace(
        salary=salary,
        effective_from=scenario.period_start,
        effective_to=scenario.period_end,
        bonuses=RelatedList(),
    )

    row = scenario_forecast(scenario, [assignment], [])["results"][0]

    assert len(row["months"]) == 12
    assert (row["months"][0]["year"], row["months"][0]["month"]) == (2026, 7)
    assert (row["months"][-1]["year"], row["months"][-1]["month"]) == (2027, 6)
    assert row["months"][5]["benefits"] == "756.16"


@pytest.mark.unit
def test_scenario_forecast_keeps_automatic_value_when_cell_is_overridden():
    scenario = SimpleNamespace(
        fiscal_year=2026,
        period_start=date(2026, 1, 1),
        period_end=date(2026, 12, 31),
    )
    office = SimpleNamespace(name="LATIN", aguinaldo_days=15)
    salary = SimpleNamespace(currency="MXN", office=office, daily_amount=lambda: Decimal("100"))
    assignment = SimpleNamespace(
        id="assignment-1",
        employee=SimpleNamespace(full_name="Oscar"),
        salary=salary,
        effective_from=scenario.period_start,
        effective_to=scenario.period_end,
        bonuses=RelatedList(),
    )
    override = SimpleNamespace(
        row_key="salary:assignment-1",
        year=2026,
        month=1,
        amount=Decimal("2500"),
    )

    forecast = scenario_forecast(scenario, [assignment], [], overrides=[override])
    salary_line = next(line for line in forecast["lines"] if line["category"] == "SALARY")

    assert salary_line["months"][0] == {
        "year": 2026,
        "month": 1,
        "automatic": "3100.00",
        "amount": "2500.00",
        "is_overridden": True,
    }
    assert forecast["results"][0]["months"][0]["salary"] == "2500.00"
