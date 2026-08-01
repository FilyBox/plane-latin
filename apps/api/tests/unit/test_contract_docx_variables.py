# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

from io import BytesIO
from zipfile import ZIP_DEFLATED, ZipFile

import fitz

from plane.integrations.contract_docx import (
    analyse_docx_variables,
    locate_and_remove_pdf_markers,
    render_docx_variables,
)


def _docx(document_xml):
    output = BytesIO()
    with ZipFile(output, "w", ZIP_DEFLATED) as archive:
        archive.writestr("word/document.xml", document_xml)
        archive.writestr("[Content_Types].xml", "<Types />")
    return output.getvalue()


def test_detects_split_run_variables_and_dynamic_recipients():
    source = _docx(
        b"""<?xml version="1.0" encoding="UTF-8"?>
        <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
          <w:p><w:r><w:t>{{Nombre</w:t></w:r><w:r><w:t>Firmante2}}</w:t></w:r></w:p>
          <w:p><w:r><w:t>{{CorreoFirmante2}} {{FirmaFirmante2}} {{MontoTotal}}</w:t></w:r></w:p>
        </w:body></w:document>"""
    )

    schema = analyse_docx_variables(source)

    assert schema["variables"] == [
        {"key": "MontoTotal", "label": "Monto total", "type": "text", "required": True, "occurrences": 1}
    ]
    assert schema["recipients"] == [
        {
            "index": 1,
            "label": "Firmante 2",
            "requires_name": True,
            "requires_email": True,
            "field_types": ["SIGNATURE"],
        }
    ]
    assert schema["signing_fields"][0]["type"] == "SIGNATURE"


def test_renders_inline_values_and_keeps_signing_marker():
    source = _docx(
        b"""<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
          <w:p><w:r><w:t>Firma {{NombreFirmante1}} ({{CorreoFirmante1}}): {{FirmaFirmante1}}</w:t></w:r></w:p>
          <w:p><w:r><w:t>Monto: {{Monto}}</w:t></w:r></w:p>
        </w:body></w:document>"""
    )

    rendered, markers, _ = render_docx_variables(
        source,
        {"Monto": "$1,250.00"},
        [{"name": "Ana Pérez", "email": "ana@example.com"}],
    )
    with ZipFile(BytesIO(rendered), "r") as archive:
        xml = archive.read("word/document.xml").decode()

    assert "Ana Pérez" in xml
    assert "ana@example.com" in xml
    assert "$1,250.00" in xml
    assert "{{" not in xml
    assert markers == [
        {
            "key": "FirmaFirmante1",
            "label": "Firma firmante1",
            "type": "SIGNATURE",
            "recipient_index": 0,
            "marker": "PLNF0001X",
        }
    ]


def test_omitted_variable_is_removed_without_requiring_a_value():
    source = _docx(
        b"""<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
          <w:p><w:r><w:t>{{ReferenciaOpcional}} / {{Monto}}</w:t></w:r></w:p>
        </w:body></w:document>"""
    )

    rendered, _, _ = render_docx_variables(
        source,
        {"Monto": "$500"},
        [],
        omitted_keys=["ReferenciaOpcional"],
    )
    with ZipFile(BytesIO(rendered), "r") as archive:
        xml = archive.read("word/document.xml").decode()

    assert "ReferenciaOpcional" not in xml
    assert "$500" in xml


def test_locates_marker_in_pdf_and_removes_it():
    document = fitz.open()
    page = document.new_page(width=612, height=792)
    page.insert_text((72, 144), "PLNF0001X")
    pdf = document.tobytes()
    document.close()

    rendered, fields = locate_and_remove_pdf_markers(
        pdf,
        [
            {
                "key": "FirmaFirmante1",
                "label": "Firma firmante 1",
                "type": "SIGNATURE",
                "recipient_index": 0,
                "marker": "PLNF0001X",
            }
        ],
    )

    assert len(fields) == 1
    assert fields[0]["type"] == "SIGNATURE"
    assert fields[0]["recipient_index"] == 0
    assert fields[0]["page"] == 1
    assert fields[0]["fieldMeta"]["templateVariable"] == "FirmaFirmante1"
    result = fitz.open(stream=rendered, filetype="pdf")
    assert result[0].search_for("PLNF0001X") == []
    result.close()
