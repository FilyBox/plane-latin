# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""PDF changes the assistant proposes and the user applies in a card: split
one PDF into its documents, merge several into one, or extract, remove or
reorder pages.

The originals are never touched. The new files go to a new folder inside
the first original's folder (never into an existing one), in the same
bucket, and are analyzed as contracts unless the card says otherwise.
Undo sends the new files and their contracts to the bin and removes the
folder when nothing else landed in it.
"""

import hashlib
import os
import re
from io import BytesIO
from uuid import uuid4

from django.db import IntegrityError, transaction
from django.utils import timezone

from plane.db.models import AssistantAction, FileAsset, FileCategory, FileCategoryLink, FileDerivation, FileFolder
from plane.settings.storage import S3Storage
from plane.utils.assistant_actions import ActionError
from plane.utils import pdf_ops
from plane.utils.exception_logger import log_exception
from plane.utils.path_validator import sanitize_filename

ADMIN = 20
PDF_TYPE = "application/pdf"
MAX_NAME = 200

# ----------------------------------------------------------------- reading


def is_pdf(asset) -> bool:
    attributes = asset.attributes or {}
    name = str(attributes.get("name") or asset.asset.name or "")
    return attributes.get("type") == PDF_TYPE or name.lower().endswith(".pdf")


def library_file(ctx, asset_id):
    """A library file this person may open, or None (same rules as everywhere)."""
    from plane.utils.entities import REGISTRY

    definition = REGISTRY.get("file")
    if ctx is None or definition is None or not definition.allows(ctx):
        return None
    try:
        return definition.visible(ctx).filter(id=asset_id).first()
    except Exception:
        # Not a uuid
        return None


def read_bytes(asset, limit: int = pdf_ops.MAX_BYTES) -> bytes:
    """The stored object, from whichever bucket holds it, read with a cap."""
    size = int((asset.attributes or {}).get("size") or asset.size or 0)
    if size > limit:
        raise pdf_ops.PdfError(f"The file is larger than {limit // (1024 * 1024)} MB.")
    storage = S3Storage.for_asset(asset)
    body = storage.s3_client.get_object(Bucket=storage.aws_storage_bucket_name, Key=asset.asset.name)["Body"]
    content = body.read(limit + 1)
    if len(content) > limit:
        raise pdf_ops.PdfError(f"The file is larger than {limit // (1024 * 1024)} MB.")
    return content


def remember_page_count(asset, count: int):
    """Keeps the page count on the file, so lists and cards can show it.

    The attributes are re-read under a row lock right before writing: the
    caller's copy may be seconds old (a PDF download in between), and writing
    it back would undo a rename or any other change made meanwhile."""
    if (asset.attributes or {}).get("page_count") == count:
        return
    with transaction.atomic():
        current = (
            FileAsset.all_objects.select_for_update()
            .filter(id=asset.id)
            .values_list("attributes", flat=True)
            .first()
        )
        attributes = dict(current or {})
        if attributes.get("page_count") != count:
            attributes["page_count"] = count
            FileAsset.all_objects.filter(id=asset.id).update(attributes=attributes)
    asset.attributes = attributes


def _source(ctx, asset_id):
    asset = library_file(ctx, asset_id)
    if asset is None:
        raise ActionError("File not found.")
    if not is_pdf(asset):
        raise ActionError(f"«{display_name(asset)}» is not a PDF.")
    try:
        return asset, read_bytes(asset)
    except pdf_ops.PdfError as error:
        raise ActionError(str(error))
    except Exception as error:
        log_exception(error)
        raise ActionError("The file could not be read from storage.")


# ----------------------------------------------------------------- naming


def display_name(asset) -> str:
    return str((asset.attributes or {}).get("name") or os.path.basename(asset.asset.name))


def base_name(name: str) -> str:
    name = " ".join(str(name or "").split())
    return name[:-4] if name.lower().endswith(".pdf") else name


def pdf_name(name, fallback: str) -> str:
    """A clean file name ending in .pdf."""
    # A slash in a title ("Contrato A/B") is part of the name, not a folder
    spaced = " ".join(str(name or "").replace("/", "-").replace("\\", "-").split())
    cleaned = base_name(sanitize_filename(spaced) or "")
    cleaned = cleaned.strip(" .") or base_name(fallback) or "documento"
    return f"{cleaned[:MAX_NAME]}.pdf"


def _folder_name(name, fallback: str) -> str:
    cleaned = " ".join(str(name or "").replace("/", "-").split()).strip(" .")
    return (cleaned or fallback)[:240]


def unique_folder(workspace_id, parent_id, name: str) -> FileFolder:
    """A new folder named `name`, or "name (2)", "name (3)"… when one already
    exists there: the new files never mix with another folder's."""
    for number in range(1, 1000):
        candidate = name if number == 1 else f"{name} ({number})"
        if FileFolder.objects.filter(workspace_id=workspace_id, parent_id=parent_id, name__iexact=candidate).exists():
            continue
        try:
            with transaction.atomic():
                return FileFolder.objects.create(workspace_id=workspace_id, parent_id=parent_id, name=candidate)
        except IntegrityError:
            continue
    raise ActionError("Could not create the destination folder.")


# ----------------------------------------------------------------- writing


def _store(source, *, folder, name, content, user, pages, derived, uploaded) -> FileAsset:
    """Uploads one new PDF next to the original (same bucket) and records it
    as a library file in `folder`."""
    bucket = (source.storage_metadata or {}).get("bucket")
    storage = S3Storage.for_asset(source)
    key = f"{folder.workspace_id}/{uuid4().hex}-{sanitize_filename(name) or 'documento.pdf'}"
    if not storage.upload_file(BytesIO(content), key, content_type=PDF_TYPE):
        raise ActionError("The new file could not be saved to storage.")
    uploaded.append((storage, key))
    metadata = storage.get_object_metadata(key) or {}
    if bucket:
        metadata["bucket"] = bucket
    return FileAsset.objects.create(
        workspace_id=folder.workspace_id,
        user=user,
        created_by=user,
        asset=key,
        attributes={
            "name": name,
            "type": PDF_TYPE,
            "size": len(content),
            "content_hash": hashlib.sha256(content).hexdigest(),
            "page_count": pages,
            "upload_source": "assistant",
            "derived_from": derived,
        },
        size=len(content),
        folder=folder,
        entity_type=FileAsset.EntityTypeContext.WORKSPACE_FILE_LIBRARY,
        is_uploaded=True,
        storage_metadata=metadata,
    )


def _analyze(assets, user) -> dict[str, str]:
    """Each new PDF goes into "Contratos", which starts its analysis."""
    from plane.app.views.contract.base import ensure_contract_for_asset

    contracts = {}
    category = FileCategory.objects.filter(workspace_id=assets[0].workspace_id, is_default=True).first()
    for asset in assets:
        if category is not None:
            FileCategoryLink.objects.get_or_create(
                file_asset=asset, category=category, defaults={"workspace_id": asset.workspace_id}
            )
        contract = ensure_contract_for_asset(asset, user=user)
        if contract is not None:
            contracts[str(asset.id)] = str(contract.id)
    return contracts


def _pages_label(pages: list[int]) -> str:
    """[1, 2, 3, 7, 9, 10] → "1-3, 7, 9-10"."""
    runs = []
    for page in pages:
        if runs and page == runs[-1][1] + 1:
            runs[-1][1] = page
        else:
            runs.append([page, page])
    return ", ".join(str(start) if start == end else f"{start}-{end}" for start, end in runs)


def _create(ctx, user, *, kind, sources, outputs, folder_name, analyze, summary, payload) -> AssistantAction:
    """Writes every output in one go: a new folder, the files, their analysis
    and the action. Nothing stays behind (rows or stored objects) on failure."""
    uploaded = []
    first = sources[0]
    try:
        with transaction.atomic():
            folder = unique_folder(ctx.workspace_id, first.folder_id, folder_name)
            assets = [
                _store(
                    first,
                    folder=folder,
                    name=output["name"],
                    content=output["content"],
                    user=user,
                    pages=len(output["pages"]),
                    derived={
                        "kind": kind,
                        "asset_ids": [str(source.id) for source in sources],
                        "pages": output.get("label") or "",
                    },
                    uploaded=uploaded,
                )
                for output in outputs
            ]
            contracts = _analyze(assets, user) if analyze else {}
            files = [
                {
                    "id": str(asset.id),
                    "name": display_name(asset),
                    "pages": len(output["pages"]),
                    "source_pages": output.get("label") or "",
                    "contract_id": contracts.get(str(asset.id)),
                }
                for asset, output in zip(assets, outputs)
            ]
            action = AssistantAction.objects.create(
                workspace_id=ctx.workspace_id,
                kind=kind,
                summary=summary(folder)[:300],
                payload=payload or {},
                result={
                    "folder": {"id": str(folder.id), "name": folder.name},
                    "files": files,
                    "sources": [{"id": str(source.id), "name": display_name(source)} for source in sources],
                    "analyzed": bool(analyze),
                    "path": f"/{ctx.slug}/file-library?folder={folder.id}",
                },
            )
            _link_derived(ctx.workspace_id, kind, sources, assets, outputs, action)
            return action
    except Exception:
        for storage, key in uploaded:
            try:
                storage.delete_files([key])
            except Exception as error:
                log_exception(error)
        raise


DERIVATION_KINDS = {
    AssistantAction.Kind.SPLIT_PDF: FileDerivation.Kind.SPLIT,
    AssistantAction.Kind.MERGE_PDF: FileDerivation.Kind.MERGE,
    AssistantAction.Kind.EDIT_PDF_PAGES: FileDerivation.Kind.PAGES,
}


def _link_derived(workspace_id, kind, sources, assets, outputs, action):
    """Each new file points to what it was made from: a split part to the
    bundle (with its part number), a merge to every source in order."""
    rows = []
    for part, (asset, output) in enumerate(zip(assets, outputs), start=1):
        for place, source in enumerate(sources, start=1):
            rows.append(
                FileDerivation(
                    workspace_id=workspace_id,
                    source=source,
                    derived=asset,
                    kind=DERIVATION_KINDS[kind],
                    pages=(output.get("label") or "")[:500],
                    position=place if kind == AssistantAction.Kind.MERGE_PDF else part,
                    action=action,
                )
            )
    FileDerivation.objects.bulk_create(rows)


def lineage(workspace_id, asset) -> dict:
    """Where a library file came from and what was made out of it (live
    library files only, the ones every member can open)."""
    from plane.db.models import Contract

    def visible(queryset, side):
        return queryset.filter(
            **{
                f"{side}__workspace_id": workspace_id,
                f"{side}__entity_type": FileAsset.EntityTypeContext.WORKSPACE_FILE_LIBRARY,
                f"{side}__is_deleted": False,
                f"{side}__is_uploaded": True,
            }
        ).select_related(side, f"{side}__folder")

    links = FileDerivation.objects.filter(workspace_id=workspace_id)
    parents = list(visible(links.filter(derived=asset), "source"))
    children = list(
        visible(links.filter(source=asset), "derived").order_by("-action__created_at", "position", "created_at")
    )
    related = [link.source for link in parents] + [link.derived for link in children]
    contracts = {
        str(file_asset_id): {"id": str(contract_id), "title": title, "status": state}
        for file_asset_id, contract_id, title, state in Contract.objects.filter(file_asset__in=related).values_list(
            "file_asset_id", "id", "titulo", "processing_status"
        )
    }

    def row(link, other):
        contract = contracts.get(str(other.id))
        return {
            "id": str(other.id),
            "name": display_name(other),
            "kind": link.kind,
            "pages": link.pages,
            "position": link.position,
            "page_count": (other.attributes or {}).get("page_count"),
            "folder": {"id": str(other.folder_id), "name": other.folder.name} if other.folder_id else None,
            "contract_id": contract["id"] if contract else None,
            "contract_title": contract["title"] if contract else None,
            "contract_status": contract["status"] if contract else None,
            "created_at": link.created_at.isoformat(),
        }

    return {
        "parents": [row(link, link.source) for link in parents],
        "children": [row(link, link.derived) for link in children],
    }


def _wants_analysis(ctx, data) -> bool:
    # On unless the card turned it off for this one; contracts are admin-only
    return ctx.role >= ADMIN and data.get("analyze") is not False


def split_pdf(ctx, user, data: dict, payload=None) -> AssistantAction:
    source, content = _source(ctx, data.get("file_id"))
    segments = [item for item in data.get("segments") or [] if isinstance(item, dict)]
    ranges = [(item.get("start_page"), item.get("end_page")) for item in segments]
    try:
        parts = pdf_ops.split(content, ranges)
    except pdf_ops.PdfError as error:
        raise ActionError(str(error))
    base = base_name(display_name(source))
    outputs = []
    for item, part in zip(segments, parts):
        start, end = int(item["start_page"]), int(item["end_page"])
        label = str(start) if start == end else f"{start}-{end}"
        outputs.append(
            {
                "name": pdf_name(item.get("name"), f"{base} (p. {label})"),
                "content": part,
                "pages": list(range(start, end + 1)),
                "label": label,
            }
        )
    remember_page_count(source, int(segments[-1]["end_page"]))
    return _create(
        ctx,
        user,
        kind=AssistantAction.Kind.SPLIT_PDF,
        sources=[source],
        outputs=outputs,
        folder_name=_folder_name(data.get("folder_name"), f"Separados de {base}"),
        analyze=_wants_analysis(ctx, data),
        summary=lambda folder: f"Separó «{display_name(source)}» en {len(outputs)} archivos en «{folder.name}»",
        payload=payload,
    )


def merge_pdf(ctx, user, data: dict, payload=None) -> AssistantAction:
    ids = [str(value) for value in data.get("file_ids") or []]
    if len(ids) != len(set(ids)):
        raise ActionError("A file appears twice in the list.")
    if not 2 <= len(ids) <= pdf_ops.MAX_MERGE_FILES:
        raise ActionError(f"Choose between 2 and {pdf_ops.MAX_MERGE_FILES} files.")
    read, total_bytes = [], 0
    for asset_id in ids:
        asset, content = _source(ctx, asset_id)
        total_bytes += len(content)
        if total_bytes > pdf_ops.MAX_MERGE_BYTES:
            raise ActionError(f"Together the files pass {pdf_ops.MAX_MERGE_BYTES // (1024 * 1024)} MB.")
        read.append((asset, content))
    try:
        merged = pdf_ops.merge([content for _asset, content in read])
        total = pdf_ops.page_count(merged)
    except pdf_ops.PdfError as error:
        raise ActionError(str(error))
    sources = [asset for asset, _content in read]
    name = pdf_name(data.get("name"), f"{base_name(display_name(sources[0]))} (unido)")
    return _create(
        ctx,
        user,
        kind=AssistantAction.Kind.MERGE_PDF,
        sources=sources,
        outputs=[{"name": name, "content": merged, "pages": list(range(1, total + 1))}],
        folder_name=_folder_name(data.get("folder_name"), f"Unidos – {base_name(name)}"),
        analyze=_wants_analysis(ctx, data),
        summary=lambda folder: f"Unió {len(sources)} archivos en «{name}»",
        payload=payload,
    )


def edit_pdf_pages(ctx, user, data: dict, payload=None) -> AssistantAction:
    source, content = _source(ctx, data.get("file_id"))
    operation = data.get("operation")
    pages = data.get("pages")
    try:
        if isinstance(pages, str):
            pages = pdf_ops.parse_pages(pages)
        if not isinstance(pages, list) or not all(isinstance(page, int) for page in pages):
            raise pdf_ops.PdfError("Pages must be numbers.")
        new, chosen = pdf_ops.select(content, operation, pages)
    except pdf_ops.PdfError as error:
        raise ActionError(str(error))
    base = base_name(display_name(source))
    label = _pages_label(chosen) if operation != "reorder" else ", ".join(str(page) for page in chosen)
    name = pdf_name(data.get("name"), f"{base} (páginas {label})"[:MAX_NAME])
    verbs = {"extract": "Extrajo", "remove": "Quitó", "reorder": "Reordenó"}
    return _create(
        ctx,
        user,
        kind=AssistantAction.Kind.EDIT_PDF_PAGES,
        sources=[source],
        outputs=[{"name": name, "content": new, "pages": chosen, "label": label[:200]}],
        folder_name=_folder_name(data.get("folder_name"), f"Páginas de {base}"),
        analyze=_wants_analysis(ctx, data),
        summary=lambda folder: f"{verbs[operation]} páginas de «{display_name(source)}» en «{name}»",
        payload=payload,
    )


# ----------------------------------------------------------------- undo


def _stop_jobs(contract):
    from plane.app.views.contract.base import ACTIVE_JOB_STATUSES
    from plane.app.views.contract.internal import stop_job
    from plane.bgtasks.contract_task import terminate_contract_pipeline_task
    from plane.db.models import ContractProcessingJob

    for job in ContractProcessingJob.objects.select_for_update().filter(
        contract=contract, status__in=ACTIVE_JOB_STATUSES
    ):
        stop_job(job, ContractProcessingJob.Status.CANCELLED, "cancelled", None)
        job_id = str(job.id)
        transaction.on_commit(lambda job_id=job_id: terminate_contract_pipeline_task.delay(job_id))


def undo_pdf(action: AssistantAction):
    """New files (and their contracts) go to the bin; the folder goes too
    if nothing else was put in it. The originals were never changed."""
    from plane.app.views.contract.base import delete_contracts
    from plane.db.models import Contract

    result = action.result or {}
    ids = [item.get("id") for item in result.get("files") or [] if item.get("id")]
    assets = list(FileAsset.objects.filter(workspace_id=action.workspace_id, id__in=ids, is_deleted=False))
    contracts = list(Contract.objects.filter(file_asset__in=assets))
    for contract in contracts:
        _stop_jobs(contract)
    # Same as deleting a contract from its list: the analysis and its PDF go
    delete_contracts(contracts)
    FileAsset.objects.filter(id__in=[asset.id for asset in assets], is_deleted=False).update(
        is_deleted=True, deleted_at=timezone.now()
    )

    folder = FileFolder.objects.filter(
        workspace_id=action.workspace_id, id=(result.get("folder") or {}).get("id")
    ).first()
    FileDerivation.objects.filter(action=action).delete()
    if folder is None:
        return
    in_use = (
        FileAsset.objects.filter(folder=folder, is_deleted=False).exists()
        or FileFolder.objects.filter(parent=folder).exists()
    )
    if not in_use:
        FileFolder.objects.filter(id=folder.id).delete()


# ----------------------------------------------------------------- pages


MARKER = re.compile(r"\[\[p\. (\d+)\]\]")


def contract_pages(text: str) -> dict[int, str]:
    """An analyzed contract's text split on its [[p. N]] markers."""
    pages: dict[int, str] = {}
    matches = list(MARKER.finditer(text or ""))
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        number = int(match.group(1))
        pages[number] = (pages.get(number, "") + text[match.end() : end]).strip()
    return pages


def excerpt(text: str, lines: int = 15, limit: int = 1500) -> str:
    """The first and last lines of a page: where headings, signatures and
    "1 de 5" usually sit."""
    rows = [row.strip() for row in str(text or "").splitlines() if row.strip()]
    if len(rows) > lines * 2:
        rows = rows[:lines] + ["…"] + rows[-lines:]
    joined = "\n".join(rows)
    if len(joined) <= limit:
        return joined
    half = limit // 2
    return f"{joined[:half]}\n…\n{joined[-half:]}"


def lineage_summary(workspace_id, asset) -> dict:
    """The same, compact, for the assistant: names, pages and contract ids."""
    data = lineage(workspace_id, asset)

    def short(row):
        return {
            key: value
            for key, value in {
                "file_id": row["id"],
                "name": row["name"],
                "kind": row["kind"],
                "pages": row["pages"] or None,
                "contract_id": row["contract_id"],
            }.items()
            if value
        }

    result = {}
    if data["parents"]:
        result["origen"] = [short(row) for row in data["parents"]]
    if data["children"]:
        result["documentos_derivados"] = [short(row) for row in data["children"][:50]]
    return result
