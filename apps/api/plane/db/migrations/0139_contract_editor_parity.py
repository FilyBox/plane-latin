from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("db", "0138_contract_authoring_and_signatures")]

    operations = [
        migrations.AddField(
            model_name="contracttemplatevariant",
            name="recipient_blueprint",
            field=models.JSONField(blank=True, default=list),
        ),
        migrations.AddField(
            model_name="contracttemplatevariant",
            name="authoring_settings",
            field=models.JSONField(blank=True, default=dict),
        ),
        migrations.AddField(
            model_name="contractsignaturerequest",
            name="authoring_mode",
            field=models.CharField(
                choices=[("DOCUMENT", "Document"), ("TEMPLATE", "Template mapping")],
                default="DOCUMENT",
                max_length=20,
            ),
        ),
        migrations.AddField(
            model_name="contractsignaturerequest",
            name="authoring_settings",
            field=models.JSONField(blank=True, default=dict),
        ),
    ]
