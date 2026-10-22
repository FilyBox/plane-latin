# Additive only: a nullable foreign key; no existing expense is touched.

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("db", "0148_expense_recurrence_resume_from"),
    ]

    operations = [
        migrations.AddField(
            model_name="expense",
            name="budget_row",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="expenses",
                to="db.budgetrow",
            ),
        ),
    ]
