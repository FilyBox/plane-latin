# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Semantic variables for editable contract DOCX templates.

Variables are intentionally stored in the Word document instead of as page
coordinates. Inline values participate in Word's normal layout before PDF
conversion, while signing fields are located in the resulting PDF and the
temporary marker is removed.
"""

import re
import unicodedata
from io import BytesIO
from zipfile import ZIP_DEFLATED, ZipFile

from lxml import etree


WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
XML_NS = "http://www.w3.org/XML/1998/namespace"
PLACEHOLDER_RE = re.compile(r"{{\s*([\wÁÉÍÓÚÜÑáéíóúüñ.-]{1,100})\s*}}", re.UNICODE)

FIELD_PREFIXES = {
    "firma": "SIGNATURE",
    "iniciales": "INITIALS",
    "fechafirma": "DATE",
    "camponombre": "NAME",
    "campocorreo": "EMAIL",
    "campofecha": "DATE",
    "texto": "TEXT",
    "numero": "NUMBER",
    "radio": "RADIO",
    "casilla": "CHECKBOX",
    "lista": "DROPDOWN",
    "desplegable": "DROPDOWN",
}

FIELD_SIZES = {
    "SIGNATURE": (22.0, 5.0),
    "INITIALS": (12.0, 4.0),
    "NAME": (20.0, 4.0),
    "EMAIL": (24.0, 4.0),
    "DATE": (16.0, 4.0),
    "TEXT": (22.0, 4.0),
    "NUMBER": (14.0, 4.0),
    "RADIO": (16.0, 5.0),
    "CHECKBOX": (16.0, 5.0),
    "DROPDOWN": (20.0, 4.0),
}


def _canonical(value):
    normalised = unicodedata.normalize("NFKD", value)
    return "".join(character for character in normalised if not unicodedata.combining(character)).lower()


def _humanise(value):
    spaced = re.sub(r"([a-záéíóúüñ])([A-ZÁÉÍÓÚÜÑ])", r"\1 \2", value)
    return spaced.replace("_", " ").replace("-", " ").strip().capitalize()


def _classify(key):
    canonical = _canonical(key)
    recipient_match = re.search(r"firmante(\d*)$", canonical)
    recipient_index = int(recipient_match.group(1) or "1") - 1 if recipient_match else None
    prefix = canonical[: recipient_match.start()] if recipient_match else canonical

    if prefix == "nombrefirmante":
        recipient_index = 0
        prefix = "nombre"
    if prefix == "correofirmante":
        recipient_index = 0
        prefix = "correo"

    if recipient_match and prefix == "nombre":
        return {"kind": "recipient_name", "recipient_index": recipient_index}
    if recipient_match and prefix == "correo":
        return {"kind": "recipient_email", "recipient_index": recipient_index}

    if recipient_match and prefix in FIELD_PREFIXES:
        return {
            "kind": "signing_field",
            "recipient_index": recipient_index,
            "field_type": FIELD_PREFIXES[prefix],
        }

    if not recipient_match and prefix in {"firma", "iniciales", "fechafirma"}:
        return {"kind": "signing_field", "recipient_index": 0, "field_type": FIELD_PREFIXES[prefix]}

    variable_type = "date" if canonical.startswith("fecha") else "number" if canonical.startswith("numero") else "text"
    return {"kind": "variable", "value_type": variable_type}


def _word_xml_entries(docx_bytes):
    with ZipFile(BytesIO(docx_bytes), "r") as archive:
        for name in archive.namelist():
            if name.startswith("word/") and name.endswith(".xml"):
                yield name, archive.read(name)


def _paragraph_texts(xml_bytes):
    root = etree.fromstring(xml_bytes)
    for paragraph in root.xpath(".//w:p", namespaces={"w": WORD_NS}):
        nodes = paragraph.xpath(".//w:t", namespaces={"w": WORD_NS})
        if nodes:
            yield nodes, "".join(node.text or "" for node in nodes)


def analyse_docx_variables(docx_bytes):
    found = []
    for _, xml_bytes in _word_xml_entries(docx_bytes):
        for _, text in _paragraph_texts(xml_bytes):
            found.extend(match.group(1) for match in PLACEHOLDER_RE.finditer(text))

    variables = {}
    signing_fields = {}
    recipients = {}
    for key in found:
        classification = _classify(key)
        kind = classification["kind"]
        if kind == "variable":
            item = variables.setdefault(
                key,
                {
                    "key": key,
                    "label": _humanise(key),
                    "type": classification["value_type"],
                    "required": True,
                    "occurrences": 0,
                },
            )
            item["occurrences"] += 1
            continue

        recipient_index = classification["recipient_index"]
        recipient = recipients.setdefault(
            recipient_index,
            {
                "index": recipient_index,
                "label": f"Firmante {recipient_index + 1}",
                "requires_name": False,
                "requires_email": False,
                "field_types": [],
            },
        )
        if kind == "recipient_name":
            recipient["requires_name"] = True
        elif kind == "recipient_email":
            recipient["requires_email"] = True
        else:
            recipient["requires_name"] = True
            recipient["requires_email"] = True
            if classification["field_type"] not in recipient["field_types"]:
                recipient["field_types"].append(classification["field_type"])
            signing_fields[key] = {
                "key": key,
                "label": _humanise(key),
                "type": classification["field_type"],
                "recipient_index": recipient_index,
            }

    return {
        "variables": list(variables.values()),
        "recipients": [recipients[index] for index in sorted(recipients)],
        "signing_fields": list(signing_fields.values()),
        "placeholder_count": len(found),
    }


def _replace_in_paragraph(nodes, replacements):
    texts = [node.text or "" for node in nodes]
    combined = "".join(texts)
    matches = [match for match in PLACEHOLDER_RE.finditer(combined) if match.group(1) in replacements]
    if not matches:
        return

    offsets = []
    cursor = 0
    for text in texts:
        offsets.append((cursor, cursor + len(text)))
        cursor += len(text)

    for match in reversed(matches):
        start, finish = match.span()
        start_index = next(index for index, (_, end) in enumerate(offsets) if end > start)
        end_index = next(index for index, (_, end) in enumerate(offsets) if end >= finish)
        start_offset = start - offsets[start_index][0]
        end_offset = finish - offsets[end_index][0]
        replacement = replacements[match.group(1)]
        if start_index == end_index:
            texts[start_index] = texts[start_index][:start_offset] + replacement + texts[start_index][end_offset:]
        else:
            suffix = texts[end_index][end_offset:]
            texts[start_index] = texts[start_index][:start_offset] + replacement
            for index in range(start_index + 1, end_index):
                texts[index] = ""
            texts[end_index] = suffix

    for node, text in zip(nodes, texts):
        node.text = text
        if text.startswith(" ") or text.endswith(" "):
            node.set(f"{{{XML_NS}}}space", "preserve")


def render_docx_variables(docx_bytes, values, recipients, omitted_keys=None):
    schema = analyse_docx_variables(docx_bytes)
    replacements = {}
    marker_fields = []
    omitted_keys = set(omitted_keys or [])
    signing_by_key = {item["key"]: item for item in schema["signing_fields"]}

    for item in schema["variables"]:
        if item["key"] in omitted_keys:
            replacements[item["key"]] = ""
            continue
        value = str(values.get(item["key"], "")).strip()
        if item["required"] and not value:
            raise ValueError(f"Missing value for {item['label']}")
        replacements[item["key"]] = value

    keys = {
        match.group(1)
        for _, xml_bytes in _word_xml_entries(docx_bytes)
        for _, text in _paragraph_texts(xml_bytes)
        for match in PLACEHOLDER_RE.finditer(text)
    }
    for key in keys:
        classification = _classify(key)
        recipient_index = classification.get("recipient_index")
        if classification["kind"] == "recipient_name":
            replacements[key] = str(
                (recipients[recipient_index] if recipient_index < len(recipients) else {}).get("name") or ""
            )
        elif classification["kind"] == "recipient_email":
            replacements[key] = str(
                (recipients[recipient_index] if recipient_index < len(recipients) else {}).get("email") or ""
            )
        elif classification["kind"] == "signing_field":
            marker = f"PLNF{len(marker_fields) + 1:04d}X"
            replacements[key] = marker
            marker_fields.append({**signing_by_key[key], "marker": marker})

    source = BytesIO(docx_bytes)
    output = BytesIO()
    with ZipFile(source, "r") as archive, ZipFile(output, "w", ZIP_DEFLATED) as rendered:
        for entry in archive.infolist():
            content = archive.read(entry.filename)
            if entry.filename.startswith("word/") and entry.filename.endswith(".xml"):
                root = etree.fromstring(content)
                for paragraph in root.xpath(".//w:p", namespaces={"w": WORD_NS}):
                    nodes = paragraph.xpath(".//w:t", namespaces={"w": WORD_NS})
                    if nodes:
                        _replace_in_paragraph(nodes, replacements)
                content = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)
            rendered.writestr(entry, content)
    return output.getvalue(), marker_fields, schema


def locate_and_remove_pdf_markers(pdf_bytes, marker_fields):
    if not marker_fields:
        return pdf_bytes, []
    import fitz

    document = fitz.open(stream=pdf_bytes, filetype="pdf")
    fields = []
    for marker_field in marker_fields:
        marker = marker_field["marker"]
        for page_index, page in enumerate(document):
            for rectangle in page.search_for(marker):
                page_width = page.rect.width
                page_height = page.rect.height
                default_width, default_height = FIELD_SIZES[marker_field["type"]]
                width = max(default_width, rectangle.width / page_width * 100)
                height = max(default_height, rectangle.height / page_height * 100)
                fields.append(
                    {
                        "identifier": 0,
                        "type": marker_field["type"],
                        "page": page_index + 1,
                        "positionX": max(0, min(100 - width, rectangle.x0 / page_width * 100)),
                        "positionY": max(0, min(100 - height, rectangle.y0 / page_height * 100)),
                        "width": min(width, 100),
                        "height": min(height, 100),
                        "recipient_index": marker_field["recipient_index"],
                        "fieldMeta": {
                            "type": marker_field["type"].lower(),
                            "label": marker_field["label"],
                            "required": True,
                            "templateVariable": marker_field["key"],
                        },
                    }
                )
                page.add_redact_annot(rectangle, fill=(1, 1, 1))
    for page in document:
        page.apply_redactions()
    output = document.tobytes(garbage=4, deflate=True)
    document.close()
    return output, fields
