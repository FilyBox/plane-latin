# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("db", "0140_contract_semantic_template_variables")]

    operations = [
        migrations.AddField(
            model_name="contracttemplaterevision",
            name="name",
            field=models.CharField(blank=True, default="", max_length=255),
        ),
    ]
