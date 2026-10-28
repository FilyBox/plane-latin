# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Splitting, merging and picking pages of PDFs, on PDFs generated here."""

import fitz
import pytest

from plane.utils import pdf_ops
from plane.utils.pdf_ops import PdfError


def make_pdf(pages: int, label: str = "Doc") -> bytes:
    with fitz.open() as document:
        for number in range(1, pages + 1):
            page = document.new_page(width=300, height=400)
            page.insert_text((40, 60), f"{label} p{number}")
        return document.tobytes()


def texts(data: bytes) -> list[str]:
    with fitz.open(stream=data, filetype="pdf") as document:
        return [page.get_text().strip() for page in document]


@pytest.mark.unit
class TestSplit:
    def test_each_part_holds_its_pages(self):
        parts = pdf_ops.split(make_pdf(6), [(1, 2), (3, 3), (4, 6)])
        assert [texts(part) for part in parts] == [
            ["Doc p1", "Doc p2"],
            ["Doc p3"],
            ["Doc p4", "Doc p5", "Doc p6"],
        ]

    @pytest.mark.parametrize(
        "ranges, message",
        [
            ([(1, 3), (3, 6)], "overlap"),
            ([(1, 2), (4, 6)], "leave pages out"),
            ([(1, 2), (3, 7)], "outside"),
            ([(1, 4)], "at least two"),
            ([(2, 3), (4, 6)], "page 1"),
            ([(1, 2), (3, 5)], "end at page 5"),
            ([(1, 2), ("x", 6)], "start and an end"),
        ],
    )
    def test_parts_must_cover_the_document_once(self, ranges, message):
        with pytest.raises(PdfError, match=message):
            pdf_ops.split(make_pdf(6), ranges)

    def test_at_most_fifty_parts(self):
        ranges = [(page, page) for page in range(1, pdf_ops.MAX_SEGMENTS + 2)]
        with pytest.raises(PdfError, match="at most"):
            pdf_ops.split(make_pdf(pdf_ops.MAX_SEGMENTS + 1), ranges)


@pytest.mark.unit
class TestMergeAndPages:
    def test_merge_keeps_the_given_order(self):
        merged = pdf_ops.merge([make_pdf(1, "B"), make_pdf(2, "A")])
        assert texts(merged) == ["B p1", "A p1", "A p2"]

    def test_merge_needs_two_to_twenty_files(self):
        with pytest.raises(PdfError):
            pdf_ops.merge([make_pdf(1)])
        with pytest.raises(PdfError, match="at most"):
            pdf_ops.merge([make_pdf(1)] * (pdf_ops.MAX_MERGE_FILES + 1))

    def test_extract_remove_and_reorder(self):
        source = make_pdf(5)
        extracted, pages = pdf_ops.select(source, "extract", [4, 2, 2])
        assert pages == [2, 4] and texts(extracted) == ["Doc p2", "Doc p4"]
        removed, pages = pdf_ops.select(source, "remove", [1, 5])
        assert pages == [2, 3, 4] and texts(removed) == ["Doc p2", "Doc p3", "Doc p4"]
        reordered, pages = pdf_ops.select(source, "reorder", [5, 4, 3, 2, 1])
        assert texts(reordered) == ["Doc p5", "Doc p4", "Doc p3", "Doc p2", "Doc p1"]

    @pytest.mark.parametrize(
        "operation, pages, message",
        [
            ("extract", [6], "outside"),
            ("extract", [], "at least one"),
            ("remove", [1, 2, 3], "empty"),
            ("reorder", [2, 1], "every page"),
            ("reorder", [1, 1, 2], "every page"),
            ("rotate", [1], "Unknown"),
        ],
    )
    def test_invalid_page_choices(self, operation, pages, message):
        with pytest.raises(PdfError, match=message):
            pdf_ops.select(make_pdf(3), operation, pages)

    def test_parse_pages(self):
        assert pdf_ops.parse_pages("1-3, 7, 9–10") == [1, 2, 3, 7, 9, 10]
        assert pdf_ops.parse_pages("3-1") == [3, 2, 1]
        with pytest.raises(PdfError):
            pdf_ops.parse_pages("1-3, siete")


@pytest.mark.unit
class TestReadingAndLimits:
    def test_page_count_and_texts(self):
        source = make_pdf(3)
        assert pdf_ops.page_count(source) == 3
        assert [text.strip() for text in pdf_ops.page_texts(source)] == ["Doc p1", "Doc p2", "Doc p3"]

    def test_preview_is_images_of_the_range(self):
        preview = pdf_ops.preview_pdf(make_pdf(5), 2, 4)
        with fitz.open(stream=preview, filetype="pdf") as document:
            assert document.page_count == 3
            assert all(page.get_images() for page in document)
            # Images only: the text layer stays out of the vision call
            assert all(not page.get_text().strip() for page in document)
            assert document[0].rect.width == 300

    def test_preview_limits(self):
        with pytest.raises(PdfError, match="at most"):
            pdf_ops.preview_pdf(make_pdf(40), 1, pdf_ops.MAX_PREVIEW_PAGES + 1)
        with pytest.raises(PdfError, match="reversed"):
            pdf_ops.preview_pdf(make_pdf(5), 4, 2)
        with pytest.raises(PdfError, match="outside"):
            pdf_ops.preview_pdf(make_pdf(5), 4, 9)

    def test_rejects_what_it_cannot_cut(self, monkeypatch):
        with pytest.raises(PdfError, match="not a readable PDF"):
            pdf_ops.page_count(b"not a pdf")
        with pytest.raises(PdfError, match="limit"):
            pdf_ops.page_count(make_pdf(pdf_ops.MAX_PAGES + 1))
        with fitz.open(stream=make_pdf(1), filetype="pdf") as document:
            locked = document.tobytes(encryption=fitz.PDF_ENCRYPT_AES_256, user_pw="x", owner_pw="y")
        with pytest.raises(PdfError, match="password"):
            pdf_ops.page_count(locked)
        monkeypatch.setattr(pdf_ops, "MAX_BYTES", 100)
        with pytest.raises(PdfError, match="larger"):
            pdf_ops.page_count(make_pdf(2))
