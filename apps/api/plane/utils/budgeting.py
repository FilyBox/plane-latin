# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

"""Forecast arithmetic for named budget scenarios."""

from calendar import monthrange
from datetime import date
from decimal import Decimal

CENTS = Decimal("0.01")
FORECAST_FIELDS = ("salary", "benefits", "bonuses", "expenses", "income")


def _month_bounds(year, month):
    return date(year, month, 1), date(year, month, monthrange(year, month)[1])


def _months_between(start, end):
    current = date(start.year, start.month, 1)
    while current <= end:
        yield current.year, current.month
        current = date(
            current.year + (1 if current.month == 12 else 0),
            1 if current.month == 12 else current.month + 1,
            1,
        )


def _overlap_days(start, end, window_start, window_end):
    active_start = max(start, window_start)
    active_end = min(end or window_end, window_end)
    return max(0, (active_end - active_start).days + 1)


def _money(value):
    return str(Decimal(value).quantize(CENTS))


def _identifier(value, fallback):
    return str(getattr(value, "id", fallback))


def _line(row_key, label, category, entity_name, currency, kind, scenario_months):
    return {
        "key": row_key,
        "label": label,
        "category": category,
        "entity_name": entity_name,
        "currency": currency,
        "kind": kind,
        "values": {(year, month): Decimal(0) for year, month in scenario_months},
    }


def scenario_forecast(
    scenario,
    employee_assignments,
    variable_assignments,
    expenses=(),
    overrides=(),
):
    """Return aggregate totals and the source rows behind every month.

    Overrides are applied after calculation. Both values are emitted so the UI
    can explain the change and restore the generated value at any time.
    """

    scenario_months = list(_months_between(scenario.period_start, scenario.period_end))
    lines = []

    for assignment_index, assignment in enumerate(employee_assignments):
        salary = assignment.salary
        employee = getattr(assignment, "employee", None)
        employee_name = getattr(employee, "full_name", "Employee")
        office_name = getattr(salary.office, "name", "")
        assignment_id = _identifier(assignment, f"employee-{assignment_index}")
        assignment_start = max(assignment.effective_from, scenario.period_start)
        assignment_end = min(assignment.effective_to or scenario.period_end, scenario.period_end)
        if assignment_start > assignment_end:
            continue

        salary_line = _line(
            f"salary:{assignment_id}",
            employee_name,
            "SALARY",
            office_name,
            salary.currency,
            "EXPENSE",
            scenario_months,
        )
        benefit_line = _line(
            f"benefit:{assignment_id}",
            f"Aguinaldo - {employee_name}",
            "BENEFIT",
            office_name,
            salary.currency,
            "EXPENSE",
            scenario_months,
        )

        for year, month in scenario_months:
            month_start, month_end = _month_bounds(year, month)
            active_days = _overlap_days(assignment_start, assignment_end, month_start, month_end)
            if active_days:
                salary_line["values"][(year, month)] += salary.daily_amount() * Decimal(active_days)
            if month == 12 and active_days:
                calendar_start = max(assignment_start, date(year, 1, 1))
                calendar_end = min(assignment_end, date(year, 12, 31))
                worked_days = Decimal((calendar_end - calendar_start).days + 1)
                days_in_year = Decimal((date(year, 12, 31) - date(year, 1, 1)).days + 1)
                benefit_line["values"][(year, month)] += (
                    salary.daily_amount() * Decimal(salary.office.aguinaldo_days) * worked_days / days_in_year
                )

        lines.extend((salary_line, benefit_line))

        for bonus_index, bonus in enumerate(assignment.bonuses.all()):
            bonus_id = _identifier(bonus, f"{assignment_id}-{bonus_index}")
            bonus_line = _line(
                f"bonus:{bonus_id}",
                bonus.name,
                "BONUS",
                office_name,
                salary.currency,
                "EXPENSE",
                scenario_months,
            )
            bonus_start = max(bonus.effective_from, assignment_start)
            bonus_end = min(bonus.effective_to or assignment_end, assignment_end)
            for year, month in scenario_months:
                month_start, month_end = _month_bounds(year, month)
                active_days = _overlap_days(bonus_start, bonus_end, month_start, month_end)
                if not active_days:
                    continue
                month_days = Decimal((month_end - month_start).days + 1)
                occurrences = Decimal(2 if bonus.periodicity == "BIWEEKLY" else 1)
                if bonus.calculation_type == "PERCENTAGE":
                    amount = salary.daily_amount() * Decimal(30) * bonus.value / Decimal(100)
                else:
                    amount = bonus.value * occurrences
                bonus_line["values"][(year, month)] += amount * Decimal(active_days) / month_days
            lines.append(bonus_line)

    for assignment_index, assignment in enumerate(variable_assignments):
        variable = assignment.variable
        assignment_id = _identifier(assignment, f"variable-{assignment_index}")
        variable_line = _line(
            f"variable:{assignment_id}",
            getattr(variable, "name", "Financial variable"),
            "VARIABLE",
            getattr(getattr(variable, "office", None), "name", ""),
            variable.currency,
            variable.kind,
            scenario_months,
        )
        active_start = max(variable.effective_from, scenario.period_start)
        active_end = min(variable.effective_to or scenario.period_end, scenario.period_end)
        if active_start > active_end:
            continue
        for year, month in scenario_months:
            month_start, month_end = _month_bounds(year, month)
            active_days = _overlap_days(active_start, active_end, month_start, month_end)
            if not active_days:
                continue
            if variable.recurrence == "ONE_TIME":
                occurrences = Decimal(active_start.year == year and active_start.month == month)
            elif variable.recurrence == "DAILY":
                occurrences = Decimal(active_days)
            elif variable.recurrence == "WEEKLY":
                occurrences = Decimal(active_days) / Decimal(7)
            elif variable.recurrence == "BIWEEKLY":
                occurrences = Decimal(active_days) / Decimal(15)
            elif variable.recurrence == "MONTHLY":
                occurrences = Decimal(1)
            elif variable.recurrence == "QUARTERLY":
                offset = (year * 12 + month) - (active_start.year * 12 + active_start.month)
                occurrences = Decimal(offset % 3 == 0)
            else:
                occurrences = Decimal(year == active_start.year and month == active_start.month)
            variable_line["values"][(year, month)] += variable.amount * occurrences
        lines.append(variable_line)

    for expense_index, expense in enumerate(expenses):
        if not (scenario.period_start <= expense.expense_date <= scenario.period_end):
            continue
        expense_id = _identifier(expense, f"expense-{expense_index}")
        label = expense.description or expense.vendor or expense.reference or "Expense"
        expense_line = _line(
            f"expense:{expense_id}",
            label,
            "EXPENSE",
            getattr(getattr(expense, "category", None), "name", ""),
            expense.currency,
            "EXPENSE",
            scenario_months,
        )
        expense_line["values"][(expense.expense_date.year, expense.expense_date.month)] = expense.amount
        lines.append(expense_line)

    override_map = {
        (override.row_key, override.year, override.month): Decimal(override.amount)
        for override in overrides
    }
    aggregate = {}
    serialized_lines = []
    category_field = {
        "SALARY": "salary",
        "BENEFIT": "benefits",
        "BONUS": "bonuses",
        "VARIABLE": "expenses",
        "EXPENSE": "expenses",
    }

    for line in lines:
        serialized_months = []
        total = Decimal(0)
        for year, month in scenario_months:
            automatic = line["values"][(year, month)]
            override = override_map.get((line["key"], year, month))
            amount = automatic if override is None else override
            total += amount
            serialized_months.append(
                {
                    "year": year,
                    "month": month,
                    "automatic": _money(automatic),
                    "amount": _money(amount),
                    "is_overridden": override is not None,
                }
            )
            currency_months = aggregate.setdefault(
                line["currency"],
                {(item_year, item_month): {field: Decimal(0) for field in FORECAST_FIELDS} for item_year, item_month in scenario_months},
            )
            field = "income" if line["kind"] == "INCOME" else category_field[line["category"]]
            currency_months[(year, month)][field] += amount
        serialized_lines.append(
            {
                "key": line["key"],
                "label": line["label"],
                "category": line["category"],
                "entity_name": line["entity_name"],
                "currency": line["currency"],
                "kind": line["kind"],
                "months": serialized_months,
                "total": _money(total),
            }
        )

    results = []
    for currency, currency_months in aggregate.items():
        annual = {field: Decimal(0) for field in FORECAST_FIELDS}
        months = []
        for year, month in scenario_months:
            values = currency_months[(year, month)]
            for field in FORECAST_FIELDS:
                annual[field] += values[field]
            total = values["salary"] + values["benefits"] + values["bonuses"] + values["expenses"] - values["income"]
            months.append({"year": year, "month": month, **{field: _money(values[field]) for field in FORECAST_FIELDS}, "total": _money(total)})
        annual_total = annual["salary"] + annual["benefits"] + annual["bonuses"] + annual["expenses"] - annual["income"]
        results.append({"currency": currency, "months": months, "annual": {**{field: _money(value) for field, value in annual.items()}, "total": _money(annual_total)}})

    results.sort(key=lambda item: item["currency"])
    serialized_lines.sort(key=lambda item: (item["currency"], item["category"], item["entity_name"], item["label"]))
    return {"year": scenario.fiscal_year, "months": [{"year": year, "month": month} for year, month in scenario_months], "results": results, "lines": serialized_lines}
