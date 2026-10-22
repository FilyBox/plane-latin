from datetime import date
from decimal import Decimal
from types import SimpleNamespace

import pytest

from plane.utils.budgeting import scenario_forecast


class RelatedList(list):
    def all(self):
        return self


@pytest.mark.unit
def test_monthly_salary_stays_constant_across_calendar_month_lengths():
    scenario = SimpleNamespace(
        fiscal_year=2026,
        period_start=date(2026, 1, 1),
        period_end=date(2026, 12, 31),
    )
    salary = SimpleNamespace(
        amount=Decimal("30000"),
        currency="MXN",
        periodicity="MONTHLY",
        office=SimpleNamespace(name="LATIN", aguinaldo_days=15),
        daily_amount=lambda: Decimal("1000"),
    )
    assignment = SimpleNamespace(
        id="assignment-1",
        employee=SimpleNamespace(full_name="Oscar"),
        salary=salary,
        effective_from=scenario.period_start,
        effective_to=scenario.period_end,
        bonuses=RelatedList(),
    )

    forecast = scenario_forecast(scenario, [assignment], [])
    salary_line = next(line for line in forecast["lines"] if line["category"] == "SALARY")
    benefit_line = next(line for line in forecast["lines"] if line["category"] == "BENEFIT")

    assert {month["amount"] for month in salary_line["months"]} == {"30000.00"}
    assert salary_line["total"] == "360000.00"
    assert salary_line["owner_name"] == "Oscar"
    assert benefit_line["label"] == "Aguinaldo - Oscar"
    assert benefit_line["owner_name"] == "Oscar"


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


@pytest.mark.unit
def test_scenario_forecast_recalculates_bonus_without_replacing_manual_cell():
    scenario = SimpleNamespace(
        fiscal_year=2026,
        period_start=date(2026, 1, 1),
        period_end=date(2026, 12, 31),
    )
    office = SimpleNamespace(name="LATIN", aguinaldo_days=15)
    salary = SimpleNamespace(currency="MXN", office=office, daily_amount=lambda: Decimal("100"))
    bonus = SimpleNamespace(
        id="bonus-1",
        name="Performance",
        calculation_type="FIXED",
        value=Decimal("500"),
        periodicity="MONTHLY",
        effective_from=scenario.period_start,
        effective_to=scenario.period_end,
    )
    assignment = SimpleNamespace(
        id="assignment-1",
        employee=SimpleNamespace(full_name="Oscar"),
        salary=salary,
        effective_from=scenario.period_start,
        effective_to=scenario.period_end,
        bonuses=RelatedList([bonus]),
    )
    override = SimpleNamespace(row_key="bonus:bonus-1", year=2026, month=1, amount=Decimal("900"))

    first_forecast = scenario_forecast(scenario, [assignment], [], overrides=[override])
    bonus.value = Decimal("750")
    updated_forecast = scenario_forecast(scenario, [assignment], [], overrides=[override])
    bonus_line = next(line for line in updated_forecast["lines"] if line["key"] == "bonus:bonus-1")

    first_bonus_line = next(line for line in first_forecast["lines"] if line["key"] == "bonus:bonus-1")
    assert first_bonus_line["months"][0]["automatic"] == "500.00"
    assert bonus_line["months"][0] == {
        "year": 2026,
        "month": 1,
        "automatic": "750.00",
        "amount": "900.00",
        "is_overridden": True,
    }
    assert bonus_line["months"][1]["amount"] == "750.00"


@pytest.mark.unit
def test_scenario_forecast_stops_salary_and_bonus_on_employee_termination():
    scenario = SimpleNamespace(
        fiscal_year=2026,
        period_start=date(2026, 1, 1),
        period_end=date(2026, 12, 31),
    )
    office = SimpleNamespace(name="LATIN", aguinaldo_days=15)
    salary = SimpleNamespace(
        currency="MXN",
        office=office,
        effective_from=date(2025, 1, 1),
        effective_to=None,
        daily_amount=lambda: Decimal("100"),
    )
    bonus = SimpleNamespace(
        id="bonus-1",
        name="Temporary",
        calculation_type="FIXED",
        value=Decimal("500"),
        periodicity="MONTHLY",
        effective_from=scenario.period_start,
        effective_to=scenario.period_end,
    )
    assignment = SimpleNamespace(
        id="assignment-1",
        employee=SimpleNamespace(
            full_name="Oscar",
            hire_date=date(2025, 1, 1),
            termination_date=date(2026, 3, 15),
        ),
        salary=salary,
        effective_from=scenario.period_start,
        effective_to=scenario.period_end,
        bonuses=RelatedList([bonus]),
    )

    forecast = scenario_forecast(scenario, [assignment], [])
    salary_line = next(line for line in forecast["lines"] if line["category"] == "SALARY")
    bonus_line = next(line for line in forecast["lines"] if line["category"] == "BONUS")

    assert salary_line["months"][2]["amount"] == "1500.00"
    assert salary_line["months"][3]["amount"] == "0.00"
    assert bonus_line["months"][2]["amount"] == "241.94"
    assert bonus_line["months"][3]["amount"] == "0.00"
    benefit_line = next(line for line in forecast["lines"] if line["category"] == "BENEFIT")
    assert benefit_line["months"][2]["amount"] == "304.11"
    assert benefit_line["months"][11]["amount"] == "0.00"


def _salary(daily, start, end=None):
    return SimpleNamespace(
        amount=daily * 30,
        currency="MXN",
        periodicity="MONTHLY",
        office=SimpleNamespace(name="LATIN", aguinaldo_days=15),
        office_id="office-1",
        daily_amount=lambda: daily,
        effective_from=start,
        effective_to=end,
    )


def _assignment(identifier, salary, start, end, employee=None):
    return SimpleNamespace(
        id=identifier,
        employee=employee or SimpleNamespace(full_name="Ana", hire_date=None, termination_date=None),
        salary=salary,
        effective_from=start,
        effective_to=end,
        bonuses=RelatedList(),
    )


def _benefit_total(forecast):
    return sum(
        Decimal(month["amount"])
        for line in forecast["lines"]
        if line["category"] == "BENEFIT"
        for month in line["months"]
    )


YEAR_2026 = SimpleNamespace(fiscal_year=2026, period_start=date(2026, 1, 1), period_end=date(2026, 12, 31))


@pytest.mark.unit
def test_aguinaldo_keeps_the_share_of_a_salary_replaced_mid_year():
    # 1,000/day Jan–Jun, then 2,000/day Jul–Dec: both shares are owed
    first = _salary(Decimal("1000"), date(2026, 1, 1), date(2026, 6, 30))
    second = _salary(Decimal("2000"), date(2026, 7, 1))
    forecast = scenario_forecast(
        YEAR_2026,
        [
            _assignment("a1", first, date(2026, 1, 1), date(2026, 6, 30)),
            _assignment("a2", second, date(2026, 7, 1), None),
        ],
        [],
    )

    expected = (Decimal("1000") * 15 * 181 + Decimal("2000") * 15 * 184) / 365
    # Each line is rounded to cents before adding up
    assert abs(_benefit_total(forecast) - expected) <= Decimal("0.02")
    december = [line["months"][11]["amount"] for line in forecast["lines"] if line["category"] == "BENEFIT"]
    assert all(Decimal(value) > 0 for value in december)


@pytest.mark.unit
def test_aguinaldo_counts_the_whole_calendar_year_in_a_july_june_budget():
    scenario = SimpleNamespace(fiscal_year=2026, period_start=date(2026, 7, 1), period_end=date(2027, 6, 30))
    salary = _salary(Decimal("1000"), date(2020, 1, 1))
    forecast = scenario_forecast(scenario, [_assignment("a1", salary, scenario.period_start, None)], [])

    benefit = next(line for line in forecast["lines"] if line["category"] == "BENEFIT")
    december_2026 = next(month for month in benefit["months"] if (month["year"], month["month"]) == (2026, 12))
    assert december_2026["amount"] == "15000.00"


@pytest.mark.unit
def test_aguinaldo_is_settled_once_in_the_termination_month():
    employee = SimpleNamespace(full_name="Ana", hire_date=date(2024, 1, 1), termination_date=date(2026, 9, 30))
    first = _salary(Decimal("1000"), date(2024, 1, 1), date(2026, 6, 30))
    second = _salary(Decimal("1000"), date(2026, 7, 1))
    forecast = scenario_forecast(
        YEAR_2026,
        [
            _assignment("a1", first, date(2026, 1, 1), None, employee),
            _assignment("a2", second, date(2026, 1, 1), None, employee),
        ],
        [],
    )

    benefits = [line for line in forecast["lines"] if line["category"] == "BENEFIT"]
    booked = {
        (month["year"], month["month"])
        for line in benefits
        for month in line["months"]
        if Decimal(month["amount"]) > 0
    }
    assert booked == {(2026, 9)}
    # Jan 1 – Sep 30 is 273 days at 1,000/day
    expected = Decimal("1000") * 15 * 273 / 365
    assert _benefit_total(forecast).quantize(Decimal("0.01")) == expected.quantize(Decimal("0.01"))


def _variable(recurrence, start, end=None, amount="1000"):
    return SimpleNamespace(
        variable=SimpleNamespace(
            name="Item",
            currency="MXN",
            kind="EXPENSE",
            amount=Decimal(amount),
            recurrence=recurrence,
            effective_from=start,
            effective_to=end,
            office=None,
        )
    )


def _variable_months(forecast):
    line = next(line for line in forecast["lines"] if line["category"] == "VARIABLE")
    return {(month["year"], month["month"]) for month in line["months"] if Decimal(month["amount"]) > 0}


@pytest.mark.unit
def test_one_time_variable_from_a_previous_year_is_not_charged_again():
    forecast = scenario_forecast(YEAR_2026, [], [_variable("ONE_TIME", date(2025, 3, 10))])
    assert _variable_months(forecast) == set()


@pytest.mark.unit
def test_annual_variable_lands_on_its_anniversary_month():
    forecast = scenario_forecast(YEAR_2026, [], [_variable("ANNUAL", date(2024, 8, 15))])
    assert _variable_months(forecast) == {(2026, 8)}


@pytest.mark.unit
def test_quarterly_variable_counts_quarters_from_its_first_payment():
    forecast = scenario_forecast(YEAR_2026, [], [_variable("QUARTERLY", date(2025, 11, 1))])
    assert _variable_months(forecast) == {(2026, 2), (2026, 5), (2026, 8), (2026, 11)}


@pytest.mark.unit
def test_biweekly_variable_is_twice_a_month():
    forecast = scenario_forecast(YEAR_2026, [], [_variable("BIWEEKLY", date(2026, 1, 1))])
    line = next(line for line in forecast["lines"] if line["category"] == "VARIABLE")
    assert line["total"] == "24000.00"
