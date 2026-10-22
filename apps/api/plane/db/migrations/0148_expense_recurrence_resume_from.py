# Additive only: a nullable column, no existing row is rewritten.

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("db", "0147_contract_es_editorial_by_name"),
    ]

    operations = [
        migrations.AddField(
            model_name="expense",
            name="recurrence_resume_from",
            field=models.DateField(blank=True, null=True),
        ),
    ]
