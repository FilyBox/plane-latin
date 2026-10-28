# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Cutting and joining PDFs: pure functions over bytes, with PyMuPDF.

The assistant's split, merge and page tools run on these. A source PDF is
only ever read; every result is a new document. The limits live here so the
endpoints, the actions and the Worker's proposals agree on them.

Pages are numbered from 1, as people say them ("separa 1–5 y 6–12").
"""

import re

import fitz

MAX_PAGES = 300
MAX_BYTES = 80 * 1024 * 1024
MAX_MERGE_FILES = 20
MAX_SEGMENTS = 50
# A merge can join up to 20 files; past this the result is too big to read anyway.
MAX_MERGED_PAGES = 1000
MAX_MERGE_BYTES = 150 * 1024 * 1024
# Pages per preview request (the Worker reads in batches of 25 plus overlap).
MAX_PREVIEW_PAGES = 30
PREVIEW_WIDTH = 800
PREVIEW_QUALITY = 55

PAGE_OPERATIONS = ("extract", "remove", "reorder")


class PdfError(Exception):
    """A user-facing reason the PDF can't be read or cut."""


def open_pdf(data: bytes) -> fitz.Document:
    if len(data) > MAX_BYTES:
        raise PdfError(f"The PDF is larger than {MAX_BYTES // (1024 * 1024)} MB.")
    try:
        document = fitz.open(stream=data, filetype="pdf")
    except Exception:
        raise PdfError("The file is not a readable PDF.")
    if document.needs_pass:
        document.close()
        raise PdfError("The PDF is password protected.")
    if document.page_count == 0:
        document.close()
        raise PdfError("The PDF has no pages.")
    if document.page_count > MAX_PAGES:
        count = document.page_count
        document.close()
        raise PdfError(f"The PDF has {count} pages; the limit is {MAX_PAGES}.")
    return document


def _bytes(document: fitz.Document) -> bytes:
    return document.tobytes(garbage=3, deflate=True)


def page_count(data: bytes) -> int:
    with open_pdf(data) as document:
        return document.page_count


def page_texts(data: bytes) -> list[str]:
    """The text layer of each page ("" on a scanned page)."""
    with open_pdf(data) as document:
        return [page.get_text() for page in document]


def _check_page(page: int, total: int):
    if not isinstance(page, int) or isinstance(page, bool) or page < 1 or page > total:
        raise PdfError(f"Page {page} is outside the document (1–{total}).")


def preview_pdf(data: bytes, start: int, end: int, width: int = PREVIEW_WIDTH) -> bytes:
    """A light copy of pages start..end: each page becomes a grayscale JPEG
    about `width` pixels wide. A hundred scanned pages come to a few MB, which
    fits in the Worker's memory and in one vision call."""
    with open_pdf(data) as source:
        _check_page(start, source.page_count)
        _check_page(end, source.page_count)
        if end < start:
            raise PdfError("The preview range is reversed.")
        if end - start + 1 > MAX_PREVIEW_PAGES:
            raise PdfError(f"Preview at most {MAX_PREVIEW_PAGES} pages at a time.")
        with fitz.open() as preview:
            for index in range(start - 1, end):
                page = source[index]
                zoom = min(max(width / max(page.rect.width, 1), 0.2), 4)
                pixmap = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), colorspace=fitz.csGRAY, alpha=False)
                image = pixmap.tobytes("jpeg", jpg_quality=PREVIEW_QUALITY)
                target = preview.new_page(width=page.rect.width, height=page.rect.height)
                target.insert_image(target.rect, stream=image)
            return _bytes(preview)


def check_segments(ranges, total: int) -> list[tuple[int, int]]:
    """Ranges that cover the whole document once, in order: 1–5, 6–8, 9–20."""
    segments = []
    for item in ranges or []:
        try:
            start, end = int(item[0]), int(item[1])
        except (TypeError, ValueError, IndexError, KeyError):
            raise PdfError("Each part needs a start and an end page.")
        segments.append((start, end))
    if len(segments) < 2:
        raise PdfError("Splitting needs at least two parts.")
    if len(segments) > MAX_SEGMENTS:
        raise PdfError(f"Split into at most {MAX_SEGMENTS} parts.")
    expected = 1
    for start, end in segments:
        if start != expected:
            problem = "overlap" if start < expected else "leave pages out"
            raise PdfError(f"The parts {problem}: page {expected} should start the next part, not {start}.")
        if end < start or end > total:
            raise PdfError(f"The part {start}–{end} is outside the document (1–{total}).")
        expected = end + 1
    if expected != total + 1:
        raise PdfError(f"The parts end at page {expected - 1}; the document has {total}.")
    return segments


def _runs(pages: list[int]) -> list[tuple[int, int]]:
    """Consecutive pages grouped, so each run is copied in one call."""
    runs: list[tuple[int, int]] = []
    for page in pages:
        if runs and page == runs[-1][1] + 1:
            runs[-1] = (runs[-1][0], page)
        else:
            runs.append((page, page))
    return runs


def _copy(source: fitz.Document, pages: list[int]) -> bytes:
    with fitz.open() as out:
        for start, end in _runs(pages):
            out.insert_pdf(source, from_page=start - 1, to_page=end - 1)
        return _bytes(out)


def split(data: bytes, ranges) -> list[bytes]:
    with open_pdf(data) as source:
        segments = check_segments(ranges, source.page_count)
        return [_copy(source, list(range(start, end + 1))) for start, end in segments]


def merge(datas: list[bytes]) -> bytes:
    if len(datas) < 2:
        raise PdfError("Merging needs at least two files.")
    if len(datas) > MAX_MERGE_FILES:
        raise PdfError(f"Merge at most {MAX_MERGE_FILES} files.")
    with fitz.open() as out:
        for data in datas:
            with open_pdf(data) as source:
                if out.page_count + source.page_count > MAX_MERGED_PAGES:
                    raise PdfError(f"The merged PDF would pass {MAX_MERGED_PAGES} pages.")
                out.insert_pdf(source)
        return _bytes(out)


def parse_pages(text: str) -> list[int]:
    """ "1-3, 7, 9–12" → [1, 2, 3, 7, 9, 10, 11, 12], in the order written."""
    pages: list[int] = []
    for part in re.split(r"[,;\s]+", str(text or "").strip()):
        if not part:
            continue
        match = re.fullmatch(r"(\d+)(?:[-–—](\d+))?", part)
        if match is None:
            raise PdfError(f"«{part}» is not a page or a range of pages.")
        start = int(match.group(1))
        end = int(match.group(2) or start)
        step = 1 if end >= start else -1
        pages.extend(range(start, end + step, step))
        if len(pages) > MAX_MERGED_PAGES:
            raise PdfError("Too many pages.")
    return pages


def pages_for(operation: str, pages: list[int], total: int) -> list[int]:
    """The pages, in order, of the new document an operation produces."""
    if operation not in PAGE_OPERATIONS:
        raise PdfError("Unknown page operation.")
    if not pages:
        raise PdfError("Choose at least one page.")
    for page in pages:
        _check_page(page, total)
    if operation == "extract":
        return sorted(set(pages))
    if operation == "remove":
        kept = [page for page in range(1, total + 1) if page not in set(pages)]
        if not kept:
            raise PdfError("Removing every page would leave an empty document.")
        return kept
    if sorted(pages) != list(range(1, total + 1)):
        raise PdfError(f"A new order must list every page from 1 to {total} once.")
    return list(pages)


def select(data: bytes, operation: str, pages: list[int]) -> tuple[bytes, list[int]]:
    """Extract, remove or reorder pages into a new PDF; also returns which
    source pages it holds, in order."""
    with open_pdf(data) as source:
        chosen = pages_for(operation, pages, source.page_count)
        return _copy(source, chosen), chosen
