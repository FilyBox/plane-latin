# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

"""The lines of a budget, addressed by the key the forecast gives them.

A forecast line is computed, not stored: `salary:<assignment>`,
`benefit:<assignment>` (aguinaldo), `bonus:<bonus>` and `variable:<assignment>`.
An expense points at a line through a `BudgetRow`, created the first time
something needs to hang off that line. These helpers say whether a key is a
real line of a budget, what it is called and which currency it is in.
"""

from django.core.exceptions import ObjectDoesNotExist
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import transaction


def line_source(scenario, row_key):
    """(label, currency) of a line of this budget, or None if the key is not one."""
    from plane.db.models import BudgetBonus
    from plane.db.models.finance import BudgetScenarioEmployee, BudgetScenarioVariable

    kind, _, identifier = str(row_key or "").partition(":")
    if not identifier:
        return None
    try:
        if kind in ("salary", "benefit"):
            assignment = BudgetScenarioEmployee.objects.select_related("employee", "salary").get(
                id=identifier, scenario=scenario
            )
            name = assignment.employee.full_name
            return (f"Aguinaldo - {name}" if kind == "benefit" else name), assignment.salary.currency
        if kind == "bonus":
            bonus = BudgetBonus.objects.select_related("scenario_employee__salary").get(
                id=identifier, scenario_employee__scenario=scenario
            )
            return bonus.name, bonus.scenario_employee.salary.currency
        if kind == "variable":
            assignment = BudgetScenarioVariable.objects.select_related("variable").get(
                id=identifier, scenario=scenario
            )
            return assignment.variable.name, assignment.variable.currency
    except (ObjectDoesNotExist, DjangoValidationError, ValueError):
        # Unknown id, or not even a UUID: not a line of this budget
        return None
    return None


def budget_row_for(scenario, row_key):
    """The BudgetRow behind a line, created on first use (or revived if it was
    soft-deleted, since a line has exactly one row)."""
    from plane.db.models.finance import BudgetRow

    with transaction.atomic():
        row = BudgetRow.all_objects.select_for_update().filter(scenario=scenario, row_key=row_key).first()
        if row is None:
            return BudgetRow.objects.create(workspace_id=scenario.workspace_id, scenario=scenario, row_key=row_key)
        if row.deleted_at is not None:
            row.deleted_at = None
            row.save(update_fields=["deleted_at"])
        return row


def line_label(row, cache=None):
    """Display name of the line a BudgetRow stands for: its own title when the
    user renamed it, otherwise the name of what it is computed from."""
    if row is None:
        return None
    if row.title:
        return row.title
    key = (row.scenario_id, row.row_key)
    if cache is not None and key in cache:
        return cache[key]
    source = line_source(row.scenario, row.row_key)
    label = source[0] if source else None
    if cache is not None:
        cache[key] = label
    return label
