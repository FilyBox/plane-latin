# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from django.db import migrations, models
import django.db.models.deletion


def backfill_employee_office(apps, schema_editor):
    """Gives every existing employee the office their latest salary is charged to.

    Until now the office lived only on the salary, so this is the only place the
    answer exists. Employees with no salary yet stay null and the API asks for
    an office the next time they are edited.
    """
    Employee = apps.get_model("db", "Employee")
    Salary = apps.get_model("db", "Salary")

    latest = {}
    for salary in Salary.objects.filter(deleted_at__isnull=True).order_by("employee_id", "effective_from"):
        latest[salary.employee_id] = salary.office_id

    updates = []
    for employee in Employee.objects.filter(office__isnull=True).only("id"):
        office_id = latest.get(employee.id)
        if office_id:
            employee.office_id = office_id
            updates.append(employee)
    if updates:
        Employee.objects.bulk_update(updates, ["office"], batch_size=500)


class Migration(migrations.Migration):
    dependencies = [("db", "0144_finance_rows_and_actuals")]

    operations = [
        migrations.AddField(
            model_name="employee",
            name="office",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="employees",
                to="db.office",
            ),
        ),
        migrations.AddField(
            model_name="budgetrow",
            name="category",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="budget_rows",
                to="db.expensecategory",
            ),
        ),
        migrations.RunPython(backfill_employee_office, migrations.RunPython.noop),
    ]
