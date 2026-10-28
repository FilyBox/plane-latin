# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Lets the assistant read a workspace file as the asking user: an attachment
dropped in the chat or a file mentioned with @.

Text comes out here when it can (an analyzed contract's text, a PDF's text
layer, a document, a spreadsheet's first rows). Scans and images can't be
read without a vision model, so the answer says so and carries a short-lived
link for the Worker to hand the file to one.
"""

import io
import os

from rest_framework import status
from rest_framework.response import Response

from plane.app.permissions import ROLE
from plane.app.views.contract.internal import InternalBaseView
from plane.db.models import Contract, FileAsset, User, Workspace, WorkspaceMember
from plane.settings.storage import S3Storage
from plane.utils import pdf_ops
from plane.utils.assistant_pdf import contract_pages, excerpt, is_pdf, read_bytes, remember_page_count

MAX_TEXT = 20_000
MAX_BYTES = 15 * 1024 * 1024
# Below this many characters a PDF is treated as a scan.
MIN_PDF_TEXT = 200
# Below this many characters a single page is treated as a scan.
MIN_PAGE_TEXT = 40

TEXT_EXTENSIONS = {".txt", ".md", ".json", ".xml", ".html", ".htm", ".log"}
SHEET_EXTENSIONS = {".csv", ".xlsx", ".xlsm", ".xls"}
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".heic"}


def _clip(text: str) -> tuple[str, bool]:
    text = text.strip()
    return (text[:MAX_TEXT], len(text) > MAX_TEXT)


def _readable_asset(request, workspace_id, asset_id):
    """The file as the asking user may open it, or the response refusing it.

    Same visibility as the rest of the app: music files are admin-only,
    library files follow the file registry's rules.
    """
    from plane.utils.entities import REGISTRY, AccessContext

    workspace = Workspace.objects.filter(id=workspace_id).first()
    user = User.objects.filter(id=request.query_params.get("user_id")).first()
    member = (
        WorkspaceMember.objects.filter(workspace=workspace, member=user, is_active=True).first()
        if workspace and user
        else None
    )
    if member is None:
        return Response({"error": "Not available"}, status=status.HTTP_403_FORBIDDEN)

    asset = FileAsset.objects.filter(id=asset_id, workspace_id=workspace.id, is_deleted=False).first()
    if asset is None or not asset.is_uploaded:
        return Response({"error": "File not found"}, status=status.HTTP_404_NOT_FOUND)

    if asset.entity_type == FileAsset.EntityTypeContext.MUSIC_CATALOG:
        if member.role < ROLE.ADMIN.value:
            return Response({"error": "File not found"}, status=status.HTTP_404_NOT_FOUND)
    else:
        ctx = AccessContext.build(workspace.slug, user)
        definition = REGISTRY.get("file")
        visible = (
            ctx is not None
            and definition is not None
            and definition.allows(ctx)
            and definition.visible(ctx).filter(id=asset.id).exists()
        )
        if not visible:
            return Response({"error": "File not found"}, status=status.HTTP_404_NOT_FOUND)
    return asset


class InternalAssistantFileReadEndpoint(InternalBaseView):
    def get(self, request, workspace_id, asset_id):
        asset = _readable_asset(request, workspace_id, asset_id)
        if isinstance(asset, Response):
            return asset

        attributes = asset.attributes or {}
        name = attributes.get("name") or os.path.basename(asset.asset.name)
        mime = str(attributes.get("type") or "")
        extension = os.path.splitext(name)[1].lower()
        result = {"asset_id": str(asset.id), "name": name, "mime": mime}

        # An analyzed contract already has its text: never pay for it twice.
        contract = Contract.objects.filter(file_asset_id=asset.id).only("id", "extracted_text").first()
        if contract is not None and (contract.extracted_text or "").strip():
            text, truncated = _clip(contract.extracted_text)
            return Response(
                {**result, "kind": "contract", "contract_id": str(contract.id), "text": text, "truncated": truncated},
                status=status.HTTP_200_OK,
            )

        size = int(attributes.get("size") or 0)
        if size and size > MAX_BYTES:
            return Response({**result, "kind": "too_large", "size": size}, status=status.HTTP_200_OK)

        # Signed contracts live in their own bucket, recorded on the asset
        storage = S3Storage.for_asset(asset)
        is_image = mime.startswith("image/") or extension in IMAGE_EXTENSIONS
        is_pdf = mime == "application/pdf" or extension == ".pdf"

        def vision(kind: str, **extra):
            url = storage.generate_presigned_url(object_name=asset.asset.name, expiration=300, filename=name)
            return Response(
                {**result, "kind": kind, "needs_vision": True, "download_url": url, **extra},
                status=status.HTTP_200_OK,
            )

        if is_image:
            return vision("image")

        content = storage.s3_client.get_object(Bucket=storage.aws_storage_bucket_name, Key=asset.asset.name)[
            "Body"
        ].read(MAX_BYTES + 1)

        if is_pdf:
            import fitz

            with fitz.open(stream=content, filetype="pdf") as document:
                pages = document.page_count
                text = "\n\n".join(page.get_text() for page in document)
            remember_page_count(asset, pages)
            if len(text.strip()) < MIN_PDF_TEXT:
                return vision("scanned_pdf", pages=pages)
            text, truncated = _clip(text)
            return Response(
                {**result, "kind": "pdf", "pages": pages, "text": text, "truncated": truncated},
                status=status.HTTP_200_OK,
            )

        if extension == ".docx":
            try:
                import docx

                document = docx.Document(io.BytesIO(content))
                text = "\n".join(paragraph.text for paragraph in document.paragraphs)
            except Exception:
                return Response({**result, "kind": "unsupported"}, status=status.HTTP_200_OK)
            text, truncated = _clip(text)
            return Response({**result, "kind": "document", "text": text, "truncated": truncated}, status=status.HTTP_200_OK)

        if extension in SHEET_EXTENSIONS:
            from plane.app.views.music.internal import _read_table, _S3Upload

            try:
                headers, rows, _sheets, _header_row = _read_table(_S3Upload(content, name), None)
            except Exception:
                return Response({**result, "kind": "unsupported"}, status=status.HTTP_200_OK)
            lines = [" | ".join(str(header) for header in headers)]
            lines += [
                " | ".join("" if row.get(header) is None else str(row.get(header)) for header in headers)
                for row in rows[:30]
            ]
            text, truncated = _clip("\n".join(lines))
            return Response(
                {
                    **result,
                    "kind": "spreadsheet",
                    "rows": len(rows),
                    "text": text,
                    "truncated": truncated,
                    "music_import": asset.entity_type == FileAsset.EntityTypeContext.MUSIC_CATALOG,
                },
                status=status.HTTP_200_OK,
            )

        if extension in TEXT_EXTENSIONS or mime.startswith("text/"):
            text, truncated = _clip(content.decode("utf-8", errors="replace"))
            return Response({**result, "kind": "text", "text": text, "truncated": truncated}, status=status.HTTP_200_OK)

        return Response({**result, "kind": "unsupported"}, status=status.HTTP_200_OK)


class InternalAssistantFilePagesEndpoint(InternalBaseView):
    """A PDF page by page, for the assistant to find where each document
    starts or to propose cuts: the page count, the start and end of each
    page's text (an analyzed contract's OCR text, else the PDF's own text
    layer, else nothing), and whether reading it needs a vision model.
    ?text=0 leaves the texts out (merging only needs names and counts)."""

    def get(self, request, workspace_id, asset_id):
        asset = _readable_asset(request, workspace_id, asset_id)
        if isinstance(asset, Response):
            return asset
        attributes = asset.attributes or {}
        name = attributes.get("name") or os.path.basename(asset.asset.name)
        contract = Contract.objects.filter(file_asset_id=asset.id).only("id", "extracted_text").first()
        result = {
            "asset_id": str(asset.id),
            "name": name,
            "size": int(attributes.get("size") or asset.size or 0),
            "folder_id": str(asset.folder_id) if asset.folder_id else None,
            "folder_name": asset.folder.name if asset.folder_id and asset.folder else None,
            "is_library_file": asset.entity_type == FileAsset.EntityTypeContext.WORKSPACE_FILE_LIBRARY,
            "is_contract": contract is not None,
            "contract_id": str(contract.id) if contract else None,
        }
        if not is_pdf(asset):
            return Response({**result, "error": "This file is not a PDF."}, status=status.HTTP_200_OK)
        try:
            texts = pdf_ops.page_texts(read_bytes(asset))
        except pdf_ops.PdfError as error:
            return Response({**result, "error": str(error)}, status=status.HTTP_200_OK)
        remember_page_count(asset, len(texts))
        result["page_count"] = len(texts)
        if request.query_params.get("text") == "0":
            return Response(result, status=status.HTTP_200_OK)

        # The contract's OCR beats an empty text layer on a scan
        ocr = contract_pages(contract.extracted_text) if contract and contract.extracted_text else {}
        pages = []
        for number, layer in enumerate(texts, start=1):
            text = ocr.get(number) or layer
            pages.append({"page": number, "chars": len(text.strip()), "text": excerpt(text)})
        readable = sum(1 for page in pages if page["chars"] >= MIN_PAGE_TEXT)
        result.update(
            {
                "text_source": "contract" if ocr else ("pdf" if readable else "none"),
                "needs_vision": readable < len(pages) * 0.8,
                "pages": pages,
            }
        )
        return Response(result, status=status.HTTP_200_OK)


class InternalAssistantFilePreviewEndpoint(InternalBaseView):
    """A light PDF of pages ?from..?to (grayscale JPEG pages, ~800 px wide)
    for the vision model: small enough for the Worker's memory and one call."""

    def get(self, request, workspace_id, asset_id):
        from django.http import HttpResponse

        asset = _readable_asset(request, workspace_id, asset_id)
        if isinstance(asset, Response):
            return asset
        if not is_pdf(asset):
            return Response({"error": "This file is not a PDF."}, status=status.HTTP_400_BAD_REQUEST)
        try:
            start = int(request.query_params.get("from") or 1)
            end = int(request.query_params.get("to") or start)
        except ValueError:
            return Response({"error": "from and to must be page numbers"}, status=status.HTTP_400_BAD_REQUEST)
        try:
            preview = pdf_ops.preview_pdf(read_bytes(asset), start, end)
        except pdf_ops.PdfError as error:
            return Response({"error": str(error)}, status=status.HTTP_400_BAD_REQUEST)
        return HttpResponse(preview, content_type="application/pdf")
