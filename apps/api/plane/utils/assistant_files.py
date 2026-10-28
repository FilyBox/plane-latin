# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""The file library put in order by the assistant: read a folder, find
duplicates, and rename / move / create folders / categorize / tag / trash in
one card, undone as a whole.

- Renaming changes the visible name only; the stored object never changes.
- Duplicates: exact by content hash (computed on request for files uploaded
  before hashes existed, only in the folder looked at, and stored as a new
  attribute: the file is not touched), possible by same name and size. The
  copy with the most links stays (contract, tags, references, expense) and,
  on a tie, the oldest.
- The trash never takes an analysed contract (deleting it deletes its
  analysis, for good: that stays in the contracts panel), an expense receipt
  or a template's Word.
"""

import hashlib

from django.db import IntegrityError, transaction
from django.db.models import Count, Q
from django.utils import timezone

from plane.db.models import (
    AssistantAction,
    Contract,
    ContractSignatureRequest,
    ContractTemplateRevision,
    ContractTemplateVariant,
    ExpenseDocument,
    FileAsset,
    FileCategory,
    FileCategoryLink,
    FileFolder,
    FileTag,
    FileTagLink,
)
from plane.utils.assistant_actions import ActionError, register_undo
from plane.utils.assistant_workspace import register_apply
from plane.utils.contract_access import contract_file_q

MEMBER = 15
ADMIN = 20
MAX_OPS = 200
MAX_LIST = 500
MAX_HASH = 300
MAX_HASH_BYTES = 100 * 1024 * 1024
LIBRARY = FileAsset.EntityTypeContext.WORKSPACE_FILE_LIBRARY
# Why a file never goes to the trash from here
KEEP_REASONS = {
    "contract": "is an analysed contract: delete it from the contracts panel.",
    "expense": "is an expense receipt: it stays.",
    "template": "belongs to a contract template or a signed contract: it stays.",
}


def can_edit(ctx) -> bool:
    return ctx is not None and ctx.role >= MEMBER and "file_library" in ctx.features


def _require(ctx):
    if not can_edit(ctx):
        raise ActionError("Only workspace members with the file library can organize files.")


def _files(ctx):
    files = FileAsset.objects.filter(
        workspace_id=ctx.workspace_id, entity_type=LIBRARY, is_deleted=False, is_uploaded=True
    )
    # Contract files are for admins only
    return files if ctx.role >= ADMIN else files.exclude(contract_file_q())


# ---------------------------------------------------------------- folders


def _paths(workspace_id) -> dict:
    """folder id → "Contratos/2024/Juan Pérez"."""
    folders = {folder.id: folder for folder in FileFolder.objects.filter(workspace_id=workspace_id)}
    cache: dict = {}

    def path(folder_id, seen=()):
        if folder_id in cache:
            return cache[folder_id]
        folder = folders.get(folder_id)
        if folder is None or folder_id in seen:
            return ""
        parent = path(folder.parent_id, (*seen, folder_id)) if folder.parent_id else ""
        cache[folder_id] = f"{parent}/{folder.name}" if parent else folder.name
        return cache[folder_id]

    return {folder_id: path(folder_id) for folder_id in folders}


def _split(path: str) -> list[str]:
    return [part.strip() for part in str(path or "").replace("\\", "/").split("/") if part.strip()]


def find_folder(workspace_id, folder_id=None, path=None):
    """A folder by id or by path; (None, True) is the root."""
    if folder_id:
        folder = FileFolder.objects.filter(workspace_id=workspace_id, id=folder_id).first()
        if folder is None:
            raise ActionError("Folder not found.")
        return folder
    parts = _split(path)
    folder = None
    for part in parts:
        folder = FileFolder.objects.filter(workspace_id=workspace_id, parent=folder, name__iexact=part).first()
        if folder is None:
            raise ActionError(f"The folder «{'/'.join(parts)}» does not exist.")
    return folder


def _descendants(folder) -> set:
    collected = {folder.id}
    frontier = [folder.id]
    while frontier:
        frontier = [
            child
            for child in FileFolder.objects.filter(parent_id__in=frontier).values_list("id", flat=True)
            if child not in collected
        ]
        collected.update(frontier)
    return collected


# ------------------------------------------------------------------ links


def _links(asset_ids) -> dict:
    """What hangs off each file: the reason it is kept or protected."""
    ids = list(asset_ids)
    contracts = {
        row["file_asset_id"]: row["id"]
        for row in Contract.objects.filter(file_asset_id__in=ids).values("file_asset_id", "id")
    }
    tags = dict(
        FileTagLink.objects.filter(file_asset_id__in=ids)
        .values("file_asset_id")
        .annotate(count=Count("id"))
        .values_list("file_asset_id", "count")
    )
    expenses = set(ExpenseDocument.objects.filter(asset_id__in=ids).values_list("asset_id", flat=True))
    templates = set(
        ContractTemplateVariant.objects.filter(Q(source_asset_id__in=ids) | Q(draft_asset_id__in=ids)).values_list(
            "source_asset_id", flat=True
        )
    ) | set(ContractTemplateRevision.objects.filter(source_asset_id__in=ids).values_list("source_asset_id", flat=True))
    signed = set(
        ContractSignatureRequest.objects.filter(signed_asset_id__in=ids).values_list("signed_asset_id", flat=True)
    )
    from plane.db.models.reference import EntityReference

    references = dict(
        EntityReference.objects.filter(target_type="file", target_id__in=ids)
        .values("target_id")
        .annotate(count=Count("id"))
        .values_list("target_id", "count")
    )
    result = {}
    for asset_id in ids:
        result[asset_id] = {
            "contract_id": str(contracts[asset_id]) if asset_id in contracts else None,
            "tags": tags.get(asset_id, 0),
            "references": references.get(asset_id, 0),
            "expense": asset_id in expenses,
            "template": asset_id in templates,
            "signed_contract": asset_id in signed,
        }
    return result


def _protected(link) -> str | None:
    if link["contract_id"]:
        return "contract"
    if link["expense"]:
        return "expense"
    if link["template"] or link["signed_contract"]:
        return "template"
    return None


def _weight(link) -> int:
    return (
        (10 if link["contract_id"] else 0)
        + (5 if link["expense"] else 0)
        + (5 if link["template"] or link["signed_contract"] else 0)
        + link["tags"]
        + link["references"]
    )


# ---------------------------------------------------------------- reading


def _row(asset, paths, link=None, tags=None, categories=None) -> dict:
    attributes = asset.attributes or {}
    return {
        "id": str(asset.id),
        "name": attributes.get("name"),
        "type": attributes.get("type"),
        "size": asset.size or attributes.get("size"),
        "folder": paths.get(asset.folder_id) or "/",
        "folder_id": str(asset.folder_id) if asset.folder_id else None,
        "created_at": asset.created_at.date().isoformat(),
        **({"contract_id": link["contract_id"]} if link and link["contract_id"] else {}),
        **({"tags": tags} if tags else {}),
        **({"categories": categories} if categories else {}),
    }


def list_folder(ctx, folder_id=None, path=None, recursive=False) -> dict:
    folder = find_folder(ctx.workspace_id, folder_id, path)
    paths = _paths(ctx.workspace_id)
    files = _files(ctx)
    if recursive and folder is not None:
        files = files.filter(folder_id__in=_descendants(folder))
    elif recursive:
        pass
    else:
        files = files.filter(folder=folder)
    total = files.count()
    files = list(files.order_by("folder_id", "created_at")[:MAX_LIST])
    ids = [asset.id for asset in files]
    links = _links(ids)
    tags: dict = {}
    for row in FileTagLink.objects.filter(file_asset_id__in=ids).values("file_asset_id", "tag__name"):
        tags.setdefault(row["file_asset_id"], []).append(row["tag__name"])
    categories: dict = {}
    for row in FileCategoryLink.objects.filter(file_asset_id__in=ids).values("file_asset_id", "category__name"):
        categories.setdefault(row["file_asset_id"], []).append(row["category__name"])
    subfolders = (
        FileFolder.objects.filter(workspace_id=ctx.workspace_id, parent=folder)
        .annotate(file_count=Count("files", filter=Q(files__is_deleted=False, files__is_uploaded=True)))
        .order_by("name")
    )
    return {
        "folder": {"id": str(folder.id) if folder else None, "path": paths.get(folder.id) if folder else "/"},
        "folders": [
            {"id": str(item.id), "name": item.name, "path": paths.get(item.id), "files": item.file_count}
            for item in subfolders
        ],
        "files": [
            _row(asset, paths, links.get(asset.id), tags.get(asset.id), categories.get(asset.id)) for asset in files
        ],
        "total": total,
        "truncated": total > len(files) or None,
    }


def _hash_object(asset) -> str:
    from plane.settings.storage import S3Storage

    storage = S3Storage.for_asset(asset)
    body = storage.s3_client.get_object(Bucket=storage.aws_storage_bucket_name, Key=asset.asset.name)["Body"]
    digest = hashlib.sha256()
    for chunk in iter(lambda: body.read(1024 * 1024), b""):
        digest.update(chunk)
    return digest.hexdigest()


def _ensure_hashes(assets) -> int:
    """Hashes the files that have none (new data, the file is untouched)."""
    computed = 0
    for asset in assets:
        attributes = asset.attributes or {}
        if attributes.get("content_hash") or computed >= MAX_HASH:
            continue
        if int(asset.size or attributes.get("size") or 0) > MAX_HASH_BYTES:
            continue
        try:
            content_hash = _hash_object(asset)
        except Exception:
            continue
        # Only the attribute is added; nothing else about the file changes
        FileAsset.objects.filter(id=asset.id).update(attributes={**attributes, "content_hash": content_hash})
        asset.attributes = {**attributes, "content_hash": content_hash}
        computed += 1
    return computed


def find_duplicates(ctx, folder_id=None, path=None) -> dict:
    folder = find_folder(ctx.workspace_id, folder_id, path) if (folder_id or path) else None
    scope = _files(ctx)
    if folder is not None:
        scope = scope.filter(folder_id__in=_descendants(folder))
    assets = list(scope.order_by("created_at")[:5000])
    computed = _ensure_hashes(assets)
    paths = _paths(ctx.workspace_id)
    by_hash: dict = {}
    by_name: dict = {}
    for asset in assets:
        attributes = asset.attributes or {}
        if attributes.get("content_hash"):
            by_hash.setdefault(attributes["content_hash"], []).append(asset)
        key = (str(attributes.get("name") or "").lower(), int(asset.size or attributes.get("size") or 0))
        by_name.setdefault(key, []).append(asset)
    exact = [group for group in by_hash.values() if len(group) > 1]
    exact_ids = {asset.id for group in exact for asset in group}
    possible = [
        group for group in by_name.values() if len(group) > 1 and not {asset.id for asset in group} <= exact_ids
    ]
    links = _links([asset.id for group in (*exact, *possible) for asset in group])

    def describe(group, kind):
        ranked = sorted(group, key=lambda asset: (-_weight(links[asset.id]), asset.created_at))
        rows = []
        for index, asset in enumerate(ranked):
            link = links[asset.id]
            rows.append(
                {
                    **_row(asset, paths, link),
                    "keep": index == 0,
                    "links": {key: value for key, value in link.items() if value},
                    "protected": _protected(link),
                }
            )
        return {"kind": kind, "files": rows}

    return {
        "exact": [describe(group, "exact") for group in exact][:100],
        "possible": [describe(group, "possible") for group in possible][:100],
        "hashed_now": computed or None,
        "scanned": len(assets),
    }


# --------------------------------------------------------------- planning


def _file(ctx, file_id):
    asset = _files(ctx).filter(id=file_id).first() if file_id else None
    if asset is None:
        raise ActionError(f"File {file_id} not found in the library.")
    return asset


def _named(model, workspace_id, value):
    if not value:
        return None
    found = model.objects.filter(workspace_id=workspace_id).filter(
        Q(id__in=_uuids([value])) | Q(name__iexact=str(value).strip())
    )
    return found.first()


def _uuids(values):
    from uuid import UUID

    found = []
    for value in values:
        try:
            found.append(str(UUID(str(value))))
        except ValueError:
            continue
    return found


def plan(ctx, ops) -> dict:
    """The operations checked and described for the card. Protected files
    in the trash come back refused, with the reason."""
    _require(ctx)
    ops = [op for op in (ops or []) if isinstance(op, dict)][:MAX_OPS]
    paths = _paths(ctx.workspace_id)
    ids = [op.get("file_id") for op in ops if op.get("file_id")]
    links = _links([asset.id for asset in _files(ctx).filter(id__in=_uuids(ids))])
    rows, problems = [], []
    for index, op in enumerate(ops):
        kind = op.get("op")
        try:
            row = {"index": index, "op": kind}
            if kind == "create_folder":
                parts = _split(op.get("path"))
                if not parts:
                    raise ActionError("create_folder needs a path.")
                row.update({"path": "/".join(parts)})
            else:
                asset = _file(ctx, op.get("file_id"))
                attributes = asset.attributes or {}
                row.update(
                    {
                        "file_id": str(asset.id),
                        "name": attributes.get("name"),
                        "folder": paths.get(asset.folder_id) or "/",
                    }
                )
                if kind == "rename":
                    name = " ".join(str(op.get("name") or "").split())[:255]
                    if not name:
                        raise ActionError(f"«{attributes.get('name')}»: the new name is empty.")
                    row["to"] = name
                elif kind == "move":
                    target = "/".join(_split(op.get("path"))) if op.get("path") else None
                    if op.get("folder_id"):
                        target = paths.get(find_folder(ctx.workspace_id, op["folder_id"]).id)
                    row["to"] = target or "/"
                elif kind == "categorize":
                    category = _named(FileCategory, ctx.workspace_id, op.get("category"))
                    if category is None or (category.is_default and ctx.role < ADMIN):
                        # "Contratos" makes a contract: admins only
                        raise ActionError(f"Category «{op.get('category')}» not found.")
                    if category.pdf_only and attributes.get("type") != "application/pdf" and not op.get("remove"):
                        raise ActionError(f"«{attributes.get('name')}»: only PDFs go to «{category.name}».")
                    row.update(
                        {
                            "to": category.name,
                            "remove": bool(op.get("remove")) or None,
                            # Putting a PDF in "Contratos" starts its analysis (AI cost)
                            "starts_analysis": (
                                category.is_default
                                and not op.get("remove")
                                and not links.get(asset.id, {}).get("contract_id")
                            )
                            or None,
                        }
                    )
                elif kind == "tag":
                    tag = _named(FileTag, ctx.workspace_id, op.get("tag"))
                    row.update(
                        {
                            "to": tag.name if tag else str(op.get("tag") or "").strip()[:255],
                            "remove": bool(op.get("remove")) or None,
                        }
                    )
                    if tag is None and op.get("remove"):
                        raise ActionError(f"Tag «{op.get('tag')}» not found.")
                    if tag is None:
                        if not row["to"]:
                            raise ActionError("tag needs a name.")
                        row["new_tag"] = True
                elif kind == "trash":
                    reason = _protected(links.get(asset.id) or _links([asset.id])[asset.id])
                    if reason:
                        raise ActionError(f"«{attributes.get('name')}» {KEEP_REASONS[reason]}")
                else:
                    raise ActionError(f"Unknown operation «{kind}».")
            rows.append(row)
        except ActionError as error:
            problems.append({"index": index, "op": kind, "error": str(error)})
    return {"ops": rows, "problems": problems or None}


# ------------------------------------------------------------------ apply


def _folder_for(workspace_id, path, created: list):
    """The folder at that path, created part by part (each one recorded)."""
    folder = None
    for part in _split(path):
        existing = FileFolder.objects.filter(workspace_id=workspace_id, parent=folder, name__iexact=part).first()
        if existing is None:
            existing = FileFolder.objects.create(workspace_id=workspace_id, parent=folder, name=part[:255])
            created.append(str(existing.id))
        folder = existing
    return folder


@register_apply(AssistantAction.Kind.ORGANIZE_FILES)
def organize_files(ctx, request, data) -> AssistantAction:
    from plane.app.views.contract.base import ensure_contract_for_asset

    checked = plan(ctx, data.get("ops"))
    if checked["problems"]:
        raise ActionError(checked["problems"][0]["error"])
    ops = [op for op in (data.get("ops") or []) if isinstance(op, dict)][:MAX_OPS]
    if not ops:
        raise ActionError("Nothing to do.")
    created_folders: list = []
    created_tags: list = []
    done = []
    analyses = []
    with transaction.atomic():
        for op in ops:
            kind = op["op"]
            if kind == "create_folder":
                _folder_for(ctx.workspace_id, op["path"], created_folders)
                done.append({"op": kind, "path": "/".join(_split(op["path"]))})
                continue
            asset = FileAsset.objects.select_for_update().get(id=op["file_id"])
            attributes = dict(asset.attributes or {})
            if kind == "rename":
                name = " ".join(str(op["name"]).split())[:255]
                done.append({"op": kind, "file_id": str(asset.id), "before": attributes.get("name"), "after": name})
                FileAsset.objects.filter(id=asset.id).update(attributes={**attributes, "name": name})
            elif kind == "move":
                if op.get("folder_id"):
                    target = find_folder(ctx.workspace_id, op["folder_id"])
                else:
                    target = _folder_for(ctx.workspace_id, op.get("path"), created_folders)
                done.append(
                    {
                        "op": kind,
                        "file_id": str(asset.id),
                        "before": str(asset.folder_id) if asset.folder_id else None,
                        "after": str(target.id) if target else None,
                    }
                )
                FileAsset.objects.filter(id=asset.id).update(folder=target)
            elif kind == "categorize":
                category = _named(FileCategory, ctx.workspace_id, op["category"])
                if op.get("remove"):
                    removed = FileCategoryLink.objects.filter(file_asset=asset, category=category).delete()[0] > 0
                    done.append(
                        {"op": kind, "file_id": str(asset.id), "category_id": str(category.id), "removed": removed}
                    )
                else:
                    _, created = FileCategoryLink.objects.get_or_create(
                        file_asset=asset, category=category, defaults={"workspace_id": asset.workspace_id}
                    )
                    done.append(
                        {"op": kind, "file_id": str(asset.id), "category_id": str(category.id), "created": created}
                    )
                    if created and category.is_default:
                        analyses.append(asset)
            elif kind == "tag":
                tag = _named(FileTag, ctx.workspace_id, op["tag"])
                if op.get("remove"):
                    removed = FileTagLink.objects.filter(file_asset=asset, tag=tag).delete()[0] > 0
                    done.append({"op": kind, "file_id": str(asset.id), "tag_id": str(tag.id), "removed": removed})
                else:
                    if tag is None:
                        try:
                            tag = FileTag.objects.create(
                                workspace_id=ctx.workspace_id, name=str(op["tag"]).strip()[:255]
                            )
                        except IntegrityError:
                            raise ActionError(f"The tag «{op['tag']}» could not be created.")
                        created_tags.append(str(tag.id))
                    _, created = FileTagLink.objects.get_or_create(
                        file_asset=asset, tag=tag, defaults={"workspace_id": asset.workspace_id}
                    )
                    done.append({"op": kind, "file_id": str(asset.id), "tag_id": str(tag.id), "created": created})
            elif kind == "trash":
                done.append({"op": kind, "file_id": str(asset.id), "was_deleted": asset.is_deleted})
                FileAsset.objects.filter(id=asset.id).update(is_deleted=True, deleted_at=timezone.now())
        for asset in analyses:
            transaction.on_commit(lambda asset=asset: ensure_contract_for_asset(asset, user=request.user))
        counts: dict = {}
        for row in done:
            counts[row["op"]] = counts.get(row["op"], 0) + 1
        words = {
            "create_folder": "carpeta(s) nueva(s)",
            "rename": "renombrado(s)",
            "move": "movido(s)",
            "categorize": "cambio(s) de categoría",
            "tag": "cambio(s) de etiqueta",
            "trash": "a la papelera",
        }
        summary = "Ordenó la biblioteca: " + ", ".join(f"{count} {words[kind]}" for kind, count in counts.items())
        return AssistantAction.objects.create(
            workspace_id=ctx.workspace_id,
            kind=AssistantAction.Kind.ORGANIZE_FILES,
            summary=summary[:300],
            payload=data,
            result={
                "done": done,
                "created_folders": created_folders,
                "created_tags": created_tags,
                "counts": counts,
                "analyses_started": len(analyses) or None,
                "path": f"/{ctx.slug}/file-library",
            },
        )


@register_undo(AssistantAction.Kind.ORGANIZE_FILES)
def undo_organize_files(action, user, origin, cookie):
    """Names and folders back (where nobody changed them since), out of the
    trash, links removed or restored, and the folders it created removed if
    they are empty. An analysis it started stays: that is the contract's."""
    result = action.result or {}
    conflicts = []
    for row in reversed(result.get("done") or []):
        kind = row["op"]
        if kind == "create_folder":
            continue
        # The trash sets deleted_at: look past it
        asset = FileAsset.all_objects.filter(id=row["file_id"]).first()
        if asset is None:
            continue
        attributes = dict(asset.attributes or {})
        name = attributes.get("name")
        if kind == "rename":
            if name != row["after"]:
                conflicts.append({"field": "name", "name": name, "expected": row["after"], "current": name})
                continue
            FileAsset.all_objects.filter(id=asset.id).update(attributes={**attributes, "name": row["before"]})
        elif kind == "move":
            current = str(asset.folder_id) if asset.folder_id else None
            if current != row["after"]:
                conflicts.append({"field": "folder", "name": name, "expected": row["after"], "current": current})
                continue
            exists = row["before"] is None or FileFolder.objects.filter(id=row["before"]).exists()
            FileAsset.all_objects.filter(id=asset.id).update(folder_id=row["before"] if exists else None)
        elif kind == "categorize":
            if row.get("created"):
                FileCategoryLink.objects.filter(file_asset_id=asset.id, category_id=row["category_id"]).delete()
            elif row.get("removed"):
                FileCategoryLink.objects.get_or_create(
                    file_asset_id=asset.id,
                    category_id=row["category_id"],
                    defaults={"workspace_id": asset.workspace_id},
                )
        elif kind == "tag":
            if row.get("created"):
                FileTagLink.objects.filter(file_asset_id=asset.id, tag_id=row["tag_id"]).delete()
            elif row.get("removed"):
                FileTagLink.objects.get_or_create(
                    file_asset_id=asset.id, tag_id=row["tag_id"], defaults={"workspace_id": asset.workspace_id}
                )
        elif kind == "trash" and not row.get("was_deleted"):
            FileAsset.all_objects.filter(id=asset.id).update(is_deleted=False, deleted_at=None)
    # Tags it created that nothing uses any more
    for tag_id in result.get("created_tags") or []:
        if not FileTagLink.objects.filter(tag_id=tag_id).exists():
            FileTag.objects.filter(id=tag_id).delete()
    # Folders it created, deepest first, while empty
    for folder_id in reversed(result.get("created_folders") or []):
        empty = not FileAsset.objects.filter(folder_id=folder_id, is_deleted=False).exists() and not (
            FileFolder.objects.filter(parent_id=folder_id).exists()
        )
        if empty:
            FileFolder.objects.filter(id=folder_id).delete()
    return {"conflicts": conflicts} if conflicts else None
