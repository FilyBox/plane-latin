from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("db", "0141_contract_revision_name")]

    operations = [
        migrations.AddField(
            model_name="contractchatmessage",
            name="parts",
            field=models.JSONField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="contractchatmessage",
            name="position",
            field=models.PositiveIntegerField(default=0),
        ),
        migrations.AlterModelOptions(
            name="contractchatmessage",
            options={
                "ordering": ("position", "created_at"),
                "verbose_name": "Contract Chat Message",
                "verbose_name_plural": "Contract Chat Messages",
            },
        ),
    ]
