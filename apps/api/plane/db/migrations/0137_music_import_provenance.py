from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion
import uuid


class Migration(migrations.Migration):
    dependencies = [("db", "0136_musictrack_parent_track")]

    operations = [
        migrations.CreateModel(
            name="MusicImportRun",
            fields=[
                ("created_at", models.DateTimeField(auto_now_add=True, verbose_name="Created At")),
                ("updated_at", models.DateTimeField(auto_now=True, verbose_name="Last Modified At")),
                ("deleted_at", models.DateTimeField(blank=True, null=True, verbose_name="Deleted At")),
                ("id", models.UUIDField(db_index=True, default=uuid.uuid4, editable=False, primary_key=True, serialize=False, unique=True)),
                ("source_name", models.CharField(max_length=500)),
                ("source", models.CharField(choices=[("MANUAL", "Manual importer"), ("ASSISTANT", "Assistant")], default="MANUAL", max_length=20)),
                ("sheet", models.CharField(blank=True, max_length=255)),
                ("rules", models.JSONField(blank=True, default=dict)),
                ("summary", models.JSONField(blank=True, default=dict)),
                ("created_by", models.ForeignKey(null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="%(class)s_created_by", to=settings.AUTH_USER_MODEL, verbose_name="Created By")),
                ("updated_by", models.ForeignKey(null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="%(class)s_updated_by", to=settings.AUTH_USER_MODEL, verbose_name="Last Modified By")),
                ("file_asset", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="music_import_runs", to="db.fileasset")),
                ("workspace", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="music_import_runs", to="db.workspace")),
            ],
            options={"db_table": "music_import_runs", "ordering": ("-created_at",)},
        ),
        migrations.CreateModel(
            name="MusicTrackImport",
            fields=[
                ("created_at", models.DateTimeField(auto_now_add=True, verbose_name="Created At")),
                ("updated_at", models.DateTimeField(auto_now=True, verbose_name="Last Modified At")),
                ("deleted_at", models.DateTimeField(blank=True, null=True, verbose_name="Deleted At")),
                ("id", models.UUIDField(db_index=True, default=uuid.uuid4, editable=False, primary_key=True, serialize=False, unique=True)),
                ("action", models.CharField(choices=[("CREATED", "Created"), ("UPDATED", "Updated"), ("PRESERVED", "Preserved")], max_length=20)),
                ("row_number", models.PositiveIntegerField(blank=True, null=True)),
                ("created_by", models.ForeignKey(null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="%(class)s_created_by", to=settings.AUTH_USER_MODEL, verbose_name="Created By")),
                ("updated_by", models.ForeignKey(null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="%(class)s_updated_by", to=settings.AUTH_USER_MODEL, verbose_name="Last Modified By")),
                ("import_run", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="track_links", to="db.musicimportrun")),
                ("track", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="import_links", to="db.musictrack")),
                ("workspace", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="music_track_imports", to="db.workspace")),
            ],
            options={"db_table": "music_track_imports", "ordering": ("-created_at",)},
        ),
        migrations.AddIndex(
            model_name="musicimportrun",
            index=models.Index(fields=["workspace", "created_at"], name="music_import_run_date_idx"),
        ),
        migrations.AddConstraint(
            model_name="musictrackimport",
            constraint=models.UniqueConstraint(fields=("track", "import_run"), name="unique_music_track_import"),
        ),
    ]
