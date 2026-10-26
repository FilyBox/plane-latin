# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Keeps EntityReference mention rows in step with saved editor HTML.

Work items, comments and pages are saved from many places (forms, the live
collaborative editor, the public API), so instead of patching each one a save
signal queues this task. The task reads the stored HTML and only writes to
entity_references — the description itself is never modified.
"""

import logging
from datetime import date

from celery import shared_task
from django.db import transaction
from django.db.models.signals import post_save

from plane.db.models import EntityReference

logger = logging.getLogger("plane.worker")

# model label -> (source type, html field)
SOURCES = {
    "db.Issue": ("issue", "description_html"),
    "db.IssueComment": ("issue_comment", "comment_html"),
    "db.Page": ("page", "description_html"),
}


@shared_task
def sync_entity_mentions(source_type: str, source_id: str):
    from plane.db.models import Issue, IssueComment, Page
    from plane.utils.references import sync_mentions

    model, field = {
        "issue": (Issue, "description_html"),
        "issue_comment": (IssueComment, "comment_html"),
        "page": (Page, "description_html"),
    }[source_type]
    row = model.all_objects.filter(id=source_id).values("workspace_id", field, "updated_by_id", "deleted_at").first()
    if row is None:
        return
    # A deleted source keeps no live mentions; restoring it re-syncs.
    html = "" if row["deleted_at"] else (row[field] or "")
    result = sync_mentions(row["workspace_id"], source_type, source_id, html, row["updated_by_id"])
    if result["added"] or result["removed"]:
        logger.info("entity mentions synced %s:%s %s", source_type, source_id, result)


def _queue_sync(sender, instance, created, update_fields=None, **kwargs):
    from plane.utils.references import has_registered_mentions

    source_type, field = SOURCES[sender._meta.label]
    if update_fields is not None and field not in update_fields and "deleted_at" not in update_fields:
        return
    html = getattr(instance, field, "") or ""
    # Most saves have nothing to do: no registered mentions now and none on
    # record to remove. Skip the queue entirely for those.
    if not has_registered_mentions(html) and (
        created
        or not EntityReference.objects.filter(
            source_type=source_type, source_id=instance.id, kind=EntityReference.Kind.MENTION
        ).exists()
    ):
        return
    source_id = str(instance.id)
    transaction.on_commit(lambda: sync_entity_mentions.delay(source_type, source_id))


def _sync_expense_tags(sender, instance, update_fields=None, **kwargs):
    """Expense.tags names are the expense's shared tags (see shared_tags)."""
    from plane.utils.shared_tags import sync_expense_tags_from_names
    from plane.utils.workspace_feature import is_workspace_feature_enabled

    if update_fields is not None and "tags" not in update_fields:
        return
    if not is_workspace_feature_enabled("references", workspace_id=instance.workspace_id):
        return
    sync_expense_tags_from_names(instance, getattr(instance, "updated_by_id", None))


def connect_signals():
    for label in SOURCES:
        post_save.connect(_queue_sync, sender=label, dispatch_uid=f"entity_mentions_{label}")
    post_save.connect(_sync_expense_tags, sender="db.Expense", dispatch_uid="shared_tags_expense")


TYPE_LABELS = {
    "issue": "Elemento de trabajo",
    "page": "Página",
    "file": "Archivo",
    "contract": "Contrato",
    "music_track": "Canción",
    "music_release": "Lanzamiento",
    "music_artist": "Artista",
    "budget": "Presupuesto",
    "expense": "Gasto",
}

TYPE_FOLDERS = {
    "contract": "Contratos",
    "file": "Archivos",
    "expense": "Comprobantes de gastos",
}


@shared_task
def shared_tag_export_task(exporter_id: str):
    """ZIP of everything under a shared tag: the files themselves, in one
    folder per kind, plus resumen.csv listing every item (songs, budgets and
    work items included) with a link back to it."""
    import csv
    import io
    import tempfile
    import uuid
    import zipfile

    from django.utils import timezone

    from plane.bgtasks.file_library_export_task import EXPORT_URL_EXPIRY_SECONDS, _unique_name
    from plane.db.models import Contract, ExpenseDocument, ExporterHistory, FileAsset, FileTag
    from plane.settings.storage import S3Storage
    from plane.utils.entities import AccessContext
    from plane.utils.exception_logger import log_exception
    from plane.utils.path_validator import sanitize_filename
    from plane.utils.shared_tags import entities_for_tag

    exporter = ExporterHistory.objects.filter(id=exporter_id).select_related("workspace", "initiated_by").first()
    if exporter is None:
        return
    try:
        exporter.status = "processing"
        exporter.save(update_fields=["status"])
        options = exporter.filters or {}
        tag = FileTag.objects.get(id=options["tag_id"], workspace_id=exporter.workspace_id)
        # Tags combined with it in the view (all of them, or any).
        extra_ids = [value for value in options.get("with") or [] if value != str(tag.id)]
        with_tags = list(FileTag.objects.filter(id__in=extra_ids, workspace_id=exporter.workspace_id))
        # Same visibility as the person who asked for it.
        ctx = AccessContext.build(exporter.workspace.slug, exporter.initiated_by)
        groups = entities_for_tag(
            ctx,
            tag,
            types=options.get("types") or None,
            query=options.get("query") or "",
            date_from=date.fromisoformat(options["date_from"]) if options.get("date_from") else None,
            date_to=date.fromisoformat(options["date_to"]) if options.get("date_to") else None,
            limit_per_type=5000,
            with_tags=with_tags,
            mode="any" if options.get("mode") == "any" else "all",
        )

        # Which library files belong to which folder.
        files: list[tuple[str, str]] = []
        for card in groups.get("file", {}).get("items", []):
            files.append((TYPE_FOLDERS["file"], card["id"]))
        contract_ids = [card["id"] for card in groups.get("contract", {}).get("items", [])]
        for asset_id in Contract.objects.filter(id__in=contract_ids).values_list("file_asset_id", flat=True):
            files.append((TYPE_FOLDERS["contract"], str(asset_id)))
        expense_ids = [card["id"] for card in groups.get("expense", {}).get("items", [])]
        for asset_id in ExpenseDocument.objects.filter(expense_id__in=expense_ids).values_list("asset_id", flat=True):
            files.append((TYPE_FOLDERS["expense"], str(asset_id)))

        assets = {
            str(asset.id): asset
            for asset in FileAsset.objects.filter(
                id__in=[asset_id for _, asset_id in files],
                workspace_id=exporter.workspace_id,
                is_uploaded=True,
                is_deleted=False,
            )
        }

        manifest = io.StringIO()
        writer = csv.writer(manifest)
        writer.writerow(["tipo", "titulo", "detalle", "fecha", "enlace"])
        base = (options.get("origin") or "").rstrip("/")
        for name, group in groups.items():
            for card in group["items"]:
                writer.writerow(
                    [
                        TYPE_LABELS.get(name, name),
                        card.get("title", ""),
                        card.get("subtitle", ""),
                        card.get("date") or "",
                        f"{base}{card.get('path', '')}",
                    ]
                )

        storage = S3Storage()
        bucket = storage.aws_storage_bucket_name
        used: set[str] = set()
        with tempfile.TemporaryFile() as scratch:
            with zipfile.ZipFile(scratch, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
                archive.writestr("resumen.csv", "\ufeff" + manifest.getvalue())
                skipped: list[str] = []
                for folder, asset_id in files:
                    asset = assets.get(asset_id)
                    if asset is None:
                        continue
                    name = sanitize_filename((asset.attributes or {}).get("name") or asset_id)
                    source = S3Storage.for_asset(asset)
                    # One unreadable file must not cost the whole download.
                    try:
                        body = source.s3_client.get_object(Bucket=source.aws_storage_bucket_name, Key=asset.asset.name)[
                            "Body"
                        ]
                    except Exception as error:  # noqa: BLE001 — storage errors vary by backend
                        log_exception(error)
                        skipped.append(f"{folder}/{name}")
                        continue
                    entry = _unique_name(f"{folder}/{name}", used)
                    try:
                        with archive.open(entry, "w") as destination:
                            for chunk in body.iter_chunks(chunk_size=1024 * 1024):
                                destination.write(chunk)
                    finally:
                        body.close()
                if skipped:
                    archive.writestr(
                        "no_incluidos.txt",
                        "Estos archivos no se pudieron leer del almacenamiento:\n" + "\n".join(skipped) + "\n",
                    )
            scratch.seek(0)
            label = sanitize_filename(" + ".join([tag.name, *(extra.name for extra in with_tags)])[:120]) or "etiqueta"
            today = timezone.now().date().isoformat()
            key = f"exports/{exporter.workspace_id}/{uuid.uuid4().hex}-{label}-{today}.zip"
            storage.s3_client.upload_fileobj(
                scratch,
                bucket,
                key,
                ExtraArgs={
                    "ContentType": "application/zip",
                    "ContentDisposition": f'attachment; filename="{label}-{today}.zip"',
                },
            )
        exporter.key = key
        exporter.url = storage.s3_presigned_client.generate_presigned_url(
            "get_object", Params={"Bucket": bucket, "Key": key}, ExpiresIn=EXPORT_URL_EXPIRY_SECONDS
        )
        exporter.status = "completed"
        exporter.save(update_fields=["key", "url", "status"])
    except Exception as error:
        log_exception(error)
        exporter.status = "failed"
        exporter.reason = "No se pudo generar la descarga."
        exporter.save(update_fields=["status", "reason"])


def schedule_auto_classify(workspace_id):
    """Called when a library upload completes: one run a few minutes later
    covers the whole batch."""
    from django.core.cache import cache

    from plane.utils.tagging import AUTO_CLASSIFY_DELAY_SECONDS

    if cache.add(f"auto-classify:{workspace_id}", 1, timeout=AUTO_CLASSIFY_DELAY_SECONDS):
        auto_classify_new_files.apply_async(args=[str(workspace_id)], countdown=AUTO_CLASSIFY_DELAY_SECONDS)


@shared_task
def auto_classify_new_files(workspace_id):
    """Proposes tags for just-uploaded library files. Like any AI mapping it
    only proposes: an admin reviews and applies it in the tags view."""
    from django.utils import timezone

    from plane.db.models import TaggingRun, WorkspaceFeature
    from plane.utils.tagging import AUTO_CLASSIFY_DELAY_SECONDS, new_uploads_to_classify
    from plane.utils.worker_client import WorkerTriggerError, trigger_tagging_run

    enabled = set(
        WorkspaceFeature.objects.filter(
            workspace_id=workspace_id, key__in=["references", "file_library"], is_enabled=True
        ).values_list("key", flat=True)
    )
    if enabled != {"references", "file_library"}:
        return
    busy = TaggingRun.objects.filter(
        workspace_id=workspace_id, status__in=[TaggingRun.Status.QUEUED, TaggingRun.Status.RUNNING]
    ).exists()
    if busy:
        # Try again once the current run is done.
        auto_classify_new_files.apply_async(args=[workspace_id], countdown=AUTO_CLASSIFY_DELAY_SECONDS)
        return
    ids = [str(value) for value in new_uploads_to_classify(workspace_id)]
    if not ids:
        return
    run = TaggingRun.objects.create(
        workspace_id=workspace_id,
        scope={"types": ["file"], "ids": ids, "auto": True, "until": timezone.now().isoformat()},
        progress={"done": 0, "total": len(ids)},
    )
    try:
        instance_id = trigger_tagging_run(run.id, workspace_id, ["file"])
    except WorkerTriggerError as error:
        logger.warning("auto classify trigger failed: %s", error)
        run.status, run.error = TaggingRun.Status.FAILED, error.public_message
        run.save(update_fields=["status", "error", "updated_at"])
        return
    run.workflow_instance_id = instance_id or ""
    run.status = TaggingRun.Status.RUNNING
    run.started_at = timezone.now()
    run.save(update_fields=["workflow_instance_id", "status", "started_at", "updated_at"])
