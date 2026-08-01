from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    dependencies = [("db", "0139_contract_editor_parity")]

    operations = [
        migrations.AddField(
            model_name="contracttemplaterevision",
            name="variable_schema",
            field=models.JSONField(blank=True, default=dict),
        ),
        migrations.AddField(
            model_name="contracttemplaterevision",
            name="signature_blueprint",
            field=models.JSONField(blank=True, default=list),
        ),
        migrations.AddField(
            model_name="contracttemplaterevision",
            name="signature_blueprint_layout",
            field=models.JSONField(blank=True, default=dict),
        ),
        migrations.AddField(
            model_name="contracttemplaterevision",
            name="recipient_blueprint",
            field=models.JSONField(blank=True, default=list),
        ),
        migrations.AddField(
            model_name="contracttemplaterevision",
            name="authoring_settings",
            field=models.JSONField(blank=True, default=dict),
        ),
        migrations.AddField(
            model_name="contractsignaturerequest",
            name="rendered_source_asset",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.PROTECT,
                related_name="rendered_contract_sources",
                to="db.fileasset",
            ),
        ),
        migrations.AddField(
            model_name="contractsignaturerequest",
            name="rendered_pdf_asset",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.PROTECT,
                related_name="rendered_contract_pdfs",
                to="db.fileasset",
            ),
        ),
        migrations.AddField(
            model_name="contractsignaturerequest",
            name="variable_values",
            field=models.JSONField(blank=True, default=dict),
        ),
        migrations.AddField(
            model_name="contractsignaturerequest",
            name="preparation_warnings",
            field=models.JSONField(blank=True, default=list),
        ),
        migrations.AddField(
            model_name="contractsignaturerequest",
            name="rendered_layout_signature",
            field=models.JSONField(blank=True, default=dict),
        ),
    ]
