# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""
Keeps the derived PDF in step with the editable document.

The .docx in the bucket is the source of truth. The PDF is a copy rendered
from it, refreshed every time the document is saved. Nothing ever edits the
PDF directly — if it did, the two would drift and neither would be trustworthy.

This runs in Celery rather than inside the WOPI save: converting a large
document takes seconds, and Collabora retries a save it considers slow.
"""

# Python imports
import io
from datetime import datetime, timezone

# Third party imports
from celery import shared_task

# Module imports
from plane.db.models import FileAsset
from plane.settings.storage import S3Storage
from plane.utils.exception_logger import log_exception


def pdf_key_for(asset: FileAsset) -> str:
    """The PDF lives beside the source object, same path with a .pdf suffix."""
    return f"{asset.asset.name}.pdf"


@shared_task
def regenerate_pdf(asset_id: str) -> None:
    from plane.app.views.file_library.collabora import convert_to_pdf

    asset = FileAsset.objects.filter(id=asset_id, deleted_at__isnull=True).first()
    if not asset:
        return

    storage = S3Storage.for_asset(asset)
    try:
        source = storage.s3_client.get_object(
            Bucket=storage.aws_storage_bucket_name,
            Key=asset.asset.name,
        )["Body"].read()
    except Exception as e:
        log_exception(e)
        return

    filename = asset.attributes.get("name", "document.docx")
    rendered = convert_to_pdf(source, filename)
    if not rendered:
        # Leave the previous PDF in place rather than deleting it. It is stale,
        # but `pdf_generated_at` below tells the UI how stale, which beats
        # showing nothing at all.
        return

    stored = storage.upload_file(
        file_obj=io.BytesIO(rendered),
        object_name=pdf_key_for(asset),
        content_type="application/pdf",
    )
    if not stored:
        return

    # Recorded on the source asset instead of a second FileAsset row, so this
    # module carries over to another project without a migration. If the PDF
    # ever needs its own permissions or lifecycle, promote it to a real
    # FileAsset with a FK back to the source.
    asset.attributes = {
        **asset.attributes,
        "pdf_key": pdf_key_for(asset),
        "pdf_generated_at": datetime.now(timezone.utc).isoformat(),
    }
    asset.save(update_fields=["attributes", "updated_at"])
