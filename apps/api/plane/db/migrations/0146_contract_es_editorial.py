# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from django.db import migrations, models


def sync_status_by_date(apps, schema_editor):
    """Brings the stored status in line with the effective end date.

    Until now the AI wrote `estatus_contrato` once, at analysis time, so every
    contract that has ended since still reads VIGENTE. Contracts with no end
    date keep whatever the AI said. The daily beat task keeps this true from
    here on.
    """
    from django.utils import timezone

    Contract = apps.get_model("db", "Contract")
    today = timezone.now().date()
    dated = Contract.objects.filter(fecha_fin_efectiva__isnull=False)
    dated.filter(fecha_fin_efectiva__lt=today).exclude(estatus_contrato="FINALIZADO").update(
        estatus_contrato="FINALIZADO"
    )
    dated.filter(fecha_fin_efectiva__gte=today).exclude(estatus_contrato="VIGENTE").update(estatus_contrato="VIGENTE")


class Migration(migrations.Migration):
    dependencies = [
        ("db", "0145_employee_office_and_budget_row_category"),
    ]

    operations = [
        migrations.AddField(
            model_name="contract",
            name="es_editorial",
            field=models.BooleanField(default=None, null=True),
        ),
        migrations.RunPython(sync_status_by_date, migrations.RunPython.noop),
    ]
