# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Word edits that change only the text they report: on a document that
puts together everything that makes Word hard (runs split mid-word, mixed
formats, fields, tracked changes, text boxes written twice, notes, tables,
headers, bookmarks, links, images and section breaks)."""

import hashlib
from io import BytesIO
from zipfile import ZipFile

import pytest
from lxml import etree

from plane.integrations.contract_docx import analyse_docx_variables
from plane.tests.unit.utils.docx_samples import IMAGE, build_docx, simple_docx
from plane.utils.docx_edit import EditError, NotPreserved, apply_edits, docx_outline, find_text, verify_preserved

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
NS = {"w": W}


def read(data, name):
    with ZipFile(BytesIO(data)) as archive:
        return archive.read(name)


def texts(data, name="word/document.xml"):
    root = etree.fromstring(read(data, name))
    return ["".join(t.text or "" for t in p.iter(f"{{{W}}}t")) for p in root.iter(f"{{{W}}}p")]


def edit(data, edits):
    result, report = apply_edits(data, edits)
    summary = verify_preserved(data, result, report)
    return result, report, summary


@pytest.mark.unit
class TestReading:
    def test_outline_reads_every_place_once(self):
        outline = docx_outline(build_docx())
        by_text = {item["text"]: item for item in outline["paragraphs"]}
        assert by_text["que celebra el C. Juan Pérez en su carácter de ARTISTA"]["location"] == "body"
        assert by_text["Juan Pérez en tabla"]["location"] == "table"
        assert by_text["Juan Pérez en la caja"]["location"] == "textbox"
        assert by_text["JUAN PÉREZ"]["location"] == "header"
        assert by_text["Nota sobre Juan Pérez"]["location"] == "footnote"
        # Word's own numbers, read for orientation only
        assert by_text["Duración: 3 años"]["number"] == "Cláusula 1."
        assert by_text["Territorio: México"]["number"] == "Cláusula 2."
        # Accepted view of tracked changes; the field's visible result
        assert by_text["Antes texto insertado después"]["tracked_changes"] is True
        assert "Fecha: 25/10/2026" in by_text
        assert outline["track_changes"] is True
        # The text box is written twice by Word but read once
        assert [item["text"] for item in outline["paragraphs"]].count("Juan Pérez en la caja") == 1

    def test_find_loose_and_exact(self):
        data = build_docx()
        loose = find_text(data, "juan perez", match="loose")
        assert len(loose) == 6
        assert {item["location"] for item in loose} == {"body", "textbox", "table", "header", "footnote"}
        assert loose[0]["before"].endswith("el C. ") and loose[0]["text"] == "Juan Pérez"
        assert len(find_text(data, "Juan Pérez")) == 5


@pytest.mark.unit
class TestReplacing:
    def test_a_name_becomes_a_token_everywhere_keeping_the_format(self):
        data = build_docx()
        result, report, summary = edit(
            data, [{"op": "replace_text", "find": "Juan Pérez", "replace": "{{NombreArtista}}", "match": "loose"}]
        )
        body = texts(result)
        assert "que celebra el C. {{NombreArtista}} en su carácter de ARTISTA" in body
        assert "{{NombreArtista}} en tabla" in body and "{{NombreArtista}}" in body
        assert texts(result, "word/header1.xml") == ["{{NombreArtista}}"]
        assert "Nota sobre {{NombreArtista}}" in texts(result, "word/footnotes.xml")
        # Both copies of the text box changed
        assert body.count("{{NombreArtista}} en la caja") == 2
        # The runs are all still there, with their properties
        root = etree.fromstring(read(result, "word/document.xml"))
        proemio = [p for p in root.iter(f"{{{W}}}p") if "celebra" in "".join(p.itertext())][0]
        assert len(proemio.findall(f"{{{W}}}r")) == 5
        assert len(proemio.findall(f".//{{{W}}}b")) == 1
        assert [item["code"] for item in report["warnings"]] == ["mixed_format", "track_changes_on"]
        # Literal capitals in the header: the value will be written the same way
        assert report["upper_tokens"] == ["NombreArtista"]
        assert summary["preserved"] and summary["paragraphs_changed"] == 7
        # Untouched parts are byte for byte the same
        for name in ("word/media/image1.png", "word/styles.xml", "word/settings.xml", "docProps/core.xml"):
            assert read(result, name) == read(data, name)
        assert read(result, "word/media/image1.png") == IMAGE
        assert analyse_docx_variables(result)["variables"][0]["key"] == "NombreArtista"

    def test_minimal_change_and_choosing_occurrences(self):
        data = build_docx()
        result, report, _ = edit(data, [{"op": "replace_text", "find": "3 años", "replace": "5 años"}])
        assert "Duración: 5 años" in texts(result)
        assert report["summary"]["runs_changed"] == 1
        only_table, _, _ = edit(
            data,
            [{"op": "replace_text", "find": "Juan Pérez", "replace": "José Pérez", "occurrences": [3]}],
        )
        assert "José Pérez en tabla" in texts(only_table)
        assert texts(only_table).count("Juan Pérez") == 1

    def test_a_link_keeps_its_link(self):
        result, _, _ = edit(build_docx(), [{"op": "replace_text", "find": "ver anexo", "replace": "ver el anexo A"}])
        root = etree.fromstring(read(result, "word/document.xml"))
        link = root.find(f".//{{{W}}}hyperlink")
        assert "".join(link.itertext()) == "ver el anexo A"
        assert root.find(f".//{{{W}}}bookmarkStart") is not None

    @pytest.mark.parametrize(
        "find, code",
        [
            ("Firma\tFecha", "crosses_barrier"),
            ("25/10/2026", "field"),
            ("texto insertado", "tracked_change"),
            ("Antes después", "not_found"),
        ],
    )
    def test_what_is_never_replaced(self, find, code):
        with pytest.raises(EditError) as error:
            apply_edits(build_docx(), [{"op": "replace_text", "find": find, "replace": "x"}])
        assert error.value.code == code

    def test_spaces_at_the_edges_are_kept(self):
        result, _, _ = edit(simple_docx(["Pago de 100 pesos"]), [{"op": "replace_text", "find": "100", "replace": " 200 "}])
        node = etree.fromstring(read(result, "word/document.xml")).find(f".//{{{W}}}t")
        assert node.get("{http://www.w3.org/XML/1998/namespace}space") == "preserve"


@pytest.mark.unit
class TestParagraphs:
    def test_a_new_clause_looks_like_its_neighbour(self):
        data = build_docx()
        result, report, summary = edit(
            data,
            [{"op": "insert_paragraph", "anchor": "Territorio: México", "position": "after", "text": "Exclusividad: no"}],
        )
        root = etree.fromstring(read(result, "word/document.xml"))
        new = [p for p in root.iter(f"{{{W}}}p") if "".join(p.itertext()) == "Exclusividad: no"][0]
        assert new.find(f"{{{W}}}pPr/{{{W}}}numPr") is not None
        assert new.find(f"{{{W}}}pPr/{{{W}}}jc").get(f"{{{W}}}val") == "both"
        assert new.find(f"{{{W}}}r/{{{W}}}rPr/{{{W}}}rFonts") is not None
        # Word's internal ids are never repeated
        assert new.get("{http://schemas.microsoft.com/office/word/2010/wordml}paraId") is None
        assert summary["paragraphs_inserted"] == 1
        numbers = {item["text"]: item.get("number") for item in docx_outline(result)["paragraphs"]}
        assert numbers["Exclusividad: no"] == "Cláusula 3."

    def test_a_section_break_is_never_copied_nor_deleted(self):
        data = build_docx()
        result, _, _ = edit(data, [{"op": "insert_paragraph", "anchor": "Fin de la sección", "text": "Nota final"}])
        root = etree.fromstring(read(result, "word/document.xml"))
        assert len(root.findall(f".//{{{W}}}pPr/{{{W}}}sectPr")) == 1
        with pytest.raises(EditError) as error:
            apply_edits(data, [{"op": "delete_paragraph", "anchor": "Fin de la sección"}])
        assert error.value.code == "section_break"

    @pytest.mark.parametrize(
        "anchor, code",
        [("Cláusula de exclusividad", "anchored_content"), ("Regalías", "anchored_content")],
    )
    def test_deleting_what_holds_more_than_text_is_refused(self, anchor, code):
        with pytest.raises(EditError) as error:
            apply_edits(build_docx(), [{"op": "delete_paragraph", "anchor": anchor}])
        assert error.value.code == code

    def test_delete_a_paragraph(self):
        data = build_docx()
        result, _, summary = edit(data, [{"op": "delete_paragraph", "anchor": "Territorio: México"}])
        assert "Territorio: México" not in texts(result)
        assert summary["paragraphs_deleted"] == 1

    def test_an_ambiguous_anchor_lists_where_it_appears(self):
        with pytest.raises(EditError) as error:
            apply_edits(build_docx(), [{"op": "insert_text", "anchor": "Juan Pérez", "text": " (el Artista)"}])
        assert error.value.code == "ambiguous" and len(error.value.occurrences) == 5
        result, _, _ = edit(
            build_docx(), [{"op": "insert_text", "anchor": "Juan Pérez", "occurrence": 3, "text": " (el Artista)"}]
        )
        assert "Juan Pérez (el Artista) en tabla" in texts(result)


@pytest.mark.unit
class TestTokensAndVerification:
    def test_rename_a_token_everywhere(self):
        data, _, _ = edit(build_docx(), [{"op": "replace_text", "find": "Juan Pérez", "replace": "{{Artista}}"}])
        result, report, _ = edit(data, [{"op": "rename_token", "from": "Artista", "to": "NombreArtista"}])
        assert report["renamed_tokens"] == {"Artista": "NombreArtista"}
        assert "{{Artista}}" not in "".join(texts(result))
        with pytest.raises(EditError):
            apply_edits(data, [{"op": "rename_token", "from": "Artista", "to": "Nombre Artista"}])

    def test_any_other_difference_is_caught(self):
        data = build_docx()
        result, report = apply_edits(data, [{"op": "replace_text", "find": "3 años", "replace": "5 años"}])
        # A lost bold elsewhere in an edited part
        root = etree.fromstring(read(result, "word/document.xml"))
        bold = root.find(f".//{{{W}}}b")
        bold.getparent().remove(bold)
        tampered_xml = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)
        with pytest.raises(NotPreserved):
            verify_preserved(data, rebuild(result, "word/document.xml", tampered_xml), report)
        # A part that was not edited
        with pytest.raises(NotPreserved):
            verify_preserved(data, rebuild(result, "word/styles.xml", b"<w:styles/>"), report)

    def test_the_source_is_never_written(self):
        data = build_docx()
        before = hashlib.sha256(data).hexdigest()
        apply_edits(data, [{"op": "replace_text", "find": "3 años", "replace": "5 años"}])
        assert hashlib.sha256(data).hexdigest() == before


def rebuild(data, name, content):
    output = BytesIO()
    with ZipFile(BytesIO(data)) as source, ZipFile(output, "w") as target:
        for info in source.infolist():
            target.writestr(info, content if info.filename == name else source.read(info.filename))
    return output.getvalue()
