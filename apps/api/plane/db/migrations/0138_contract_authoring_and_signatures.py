from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion
import uuid


def audit_fields():
    return [
        ("created_at", models.DateTimeField(auto_now_add=True, verbose_name="Created At")),
        ("updated_at", models.DateTimeField(auto_now=True, verbose_name="Last Modified At")),
        ("deleted_at", models.DateTimeField(blank=True, null=True, verbose_name="Deleted At")),
        (
            "id",
            models.UUIDField(
                db_index=True,
                default=uuid.uuid4,
                editable=False,
                primary_key=True,
                serialize=False,
                unique=True,
            ),
        ),
        (
            "created_by",
            models.ForeignKey(
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="%(class)s_created_by",
                to=settings.AUTH_USER_MODEL,
                verbose_name="Created By",
            ),
        ),
        (
            "updated_by",
            models.ForeignKey(
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="%(class)s_updated_by",
                to=settings.AUTH_USER_MODEL,
                verbose_name="Last Modified By",
            ),
        ),
    ]


class Migration(migrations.Migration):
    dependencies = [("db", "0137_music_import_provenance")]

    operations = [
        migrations.CreateModel(
            name="ContractTemplate",
            fields=[
                *audit_fields(),
                ("name", models.CharField(max_length=255)),
                ("description", models.TextField(blank=True)),
                ("is_active", models.BooleanField(default=True)),
                (
                    "workspace",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="contract_templates",
                        to="db.workspace",
                    ),
                ),
            ],
            options={"db_table": "contract_templates", "ordering": ("name",)},
        ),
        migrations.CreateModel(
            name="ContractTemplateVariant",
            fields=[
                *audit_fields(),
                ("name", models.CharField(max_length=255)),
                ("is_default", models.BooleanField(default=False)),
                ("signature_blueprint", models.JSONField(blank=True, default=list)),
                ("signature_blueprint_layout", models.JSONField(blank=True, default=dict)),
                (
                    "source_asset",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="contract_template_variants",
                        to="db.fileasset",
                    ),
                ),
                (
                    "template",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="variants",
                        to="db.contracttemplate",
                    ),
                ),
                (
                    "workspace",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="contract_template_variants",
                        to="db.workspace",
                    ),
                ),
            ],
            options={"db_table": "contract_template_variants", "ordering": ("name",)},
        ),
        migrations.CreateModel(
            name="ContractTemplateRevision",
            fields=[
                *audit_fields(),
                ("revision", models.PositiveIntegerField()),
                ("content_sha256", models.CharField(max_length=64)),
                ("layout_signature", models.JSONField(blank=True, default=dict)),
                (
                    "pdf_asset",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="contract_revision_pdfs",
                        to="db.fileasset",
                    ),
                ),
                (
                    "source_asset",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="contract_revision_sources",
                        to="db.fileasset",
                    ),
                ),
                (
                    "variant",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="revisions",
                        to="db.contracttemplatevariant",
                    ),
                ),
                (
                    "workspace",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="contract_template_revisions",
                        to="db.workspace",
                    ),
                ),
            ],
            options={"db_table": "contract_template_revisions", "ordering": ("-revision",)},
        ),
        migrations.CreateModel(
            name="ContractSignatureRequest",
            fields=[
                *audit_fields(),
                ("title", models.CharField(max_length=500)),
                (
                    "status",
                    models.CharField(
                        choices=[
                            ("DRAFT", "Draft"),
                            ("PREPARING", "Preparing PDF"),
                            ("READY", "Ready for authoring"),
                            ("PENDING", "Sent for signature"),
                            ("COMPLETED", "Completed"),
                            ("REJECTED", "Rejected"),
                            ("CANCELLED", "Cancelled"),
                            ("ERROR", "Error"),
                        ],
                        default="DRAFT",
                        max_length=30,
                    ),
                ),
                ("recipients", models.JSONField(blank=True, default=list)),
                ("fields", models.JSONField(blank=True, default=list)),
                ("documenso_envelope_id", models.CharField(blank=True, max_length=255, null=True, unique=True)),
                ("documenso_envelope_item_id", models.CharField(blank=True, max_length=255, null=True)),
                ("error", models.JSONField(blank=True, null=True)),
                ("sent_at", models.DateTimeField(blank=True, null=True)),
                ("completed_at", models.DateTimeField(blank=True, null=True)),
                (
                    "analysis_contract",
                    models.OneToOneField(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="signature_request",
                        to="db.contract",
                    ),
                ),
                (
                    "revision",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="signature_requests",
                        to="db.contracttemplaterevision",
                    ),
                ),
                (
                    "signed_asset",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="signed_contract_requests",
                        to="db.fileasset",
                    ),
                ),
                (
                    "workspace",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="contract_signature_requests",
                        to="db.workspace",
                    ),
                ),
            ],
            options={"db_table": "contract_signature_requests", "ordering": ("-created_at",)},
        ),
        migrations.CreateModel(
            name="ContractSigner",
            fields=[
                *audit_fields(),
                ("name", models.CharField(max_length=255)),
                ("email", models.EmailField(max_length=254)),
                ("role", models.CharField(default="SIGNER", max_length=30)),
                ("signing_order", models.PositiveIntegerField(default=1)),
                (
                    "status",
                    models.CharField(
                        choices=[
                            ("NOT_SENT", "Not sent"),
                            ("SENT", "Sent"),
                            ("OPENED", "Opened"),
                            ("SIGNED", "Signed"),
                            ("REJECTED", "Rejected"),
                        ],
                        default="NOT_SENT",
                        max_length=30,
                    ),
                ),
                ("documenso_recipient_id", models.IntegerField(blank=True, null=True)),
                (
                    "signature_request",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="signers",
                        to="db.contractsignaturerequest",
                    ),
                ),
                (
                    "workspace",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="contract_signers",
                        to="db.workspace",
                    ),
                ),
            ],
            options={"db_table": "contract_signers", "ordering": ("signing_order", "created_at")},
        ),
        migrations.CreateModel(
            name="ContractWebhookEvent",
            fields=[
                *audit_fields(),
                ("event_key", models.CharField(max_length=128, unique=True)),
                ("event_type", models.CharField(max_length=80)),
                ("payload", models.JSONField(default=dict)),
                ("processed_at", models.DateTimeField(blank=True, null=True)),
                ("error", models.TextField(blank=True, null=True)),
            ],
            options={"db_table": "contract_webhook_events", "ordering": ("-created_at",)},
        ),
        migrations.CreateModel(
            name="WopiDocumentLock",
            fields=[
                *audit_fields(),
                ("lock_id", models.CharField(max_length=1024)),
                ("owner_user_id", models.CharField(max_length=255)),
                ("expires_at", models.DateTimeField(db_index=True)),
                (
                    "asset",
                    models.OneToOneField(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="wopi_lock",
                        to="db.fileasset",
                    ),
                ),
            ],
            options={"db_table": "wopi_document_locks"},
        ),
        migrations.AddConstraint(
            model_name="contracttemplate",
            constraint=models.UniqueConstraint(
                condition=models.Q(("deleted_at__isnull", True)),
                fields=("workspace", "name"),
                name="unique_contract_template_name",
            ),
        ),
        migrations.AddConstraint(
            model_name="contracttemplatevariant",
            constraint=models.UniqueConstraint(
                condition=models.Q(("deleted_at__isnull", True)),
                fields=("template", "name"),
                name="unique_contract_template_variant_name",
            ),
        ),
        migrations.AddConstraint(
            model_name="contracttemplaterevision",
            constraint=models.UniqueConstraint(
                fields=("variant", "revision"),
                name="unique_contract_variant_revision",
            ),
        ),
        migrations.AddIndex(
            model_name="contractsignaturerequest",
            index=models.Index(fields=["workspace", "status"], name="contract_sign_ws_status_idx"),
        ),
    ]
