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


# Display-only accent fixes for common words written without them in tokens.
ACCENTED_WORDS = {
    "duracion": "duración",
    "comision": "comisión",
    "artistico": "artístico",
    "artistica": "artística",
    "numero": "número",
    "codigo": "código",
    "pais": "país",
    "telefono": "teléfono",
    "direccion": "dirección",
    "razon": "razón",
    "cesion": "cesión",
    "publicacion": "publicación",
    "produccion": "producción",
    "participacion": "participación",
    "clausula": "cláusula",
    "regimen": "régimen",
    "economico": "económico",
    "politica": "política",
    "credito": "crédito",
    "pagina": "página",
    "dias": "días",
    "ano": "año",
    "anos": "años",
}

# Reserved tokens without "FirmanteN" still mean signer 1 (unchanged); the
# warning suggests an explicit name.
RESERVED_SUGGESTIONS = {
    "firma": "FirmaFirmante1",
    "iniciales": "InicialesFirmante1",
    "fechafirma": "FechaContrato",
}
LOOSE_PLACEHOLDER_RE = re.compile(r"{{\s*([^{}]{1,100}?)\s*}}", re.UNICODE)


class MissingValueError(ValueError):
    """A required variable has no value. Message kept for old callers."""

    def __init__(self, key, label):
        super().__init__(f"Missing value for {label}")
        self.key = key
        self.label = label


def _canonical(value):
    normalised = unicodedata.normalize("NFKD", value)
    return "".join(character for character in normalised if not unicodedata.combining(character)).lower()


def _restore_accents(text):
    def fix(match):
        word = match.group(0)
        replacement = ACCENTED_WORDS.get(word.lower())
        if not replacement:
            return word
        return replacement.capitalize() if word[0].isupper() else replacement

    return re.sub(r"[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+", fix, text)


def _humanise(value):
    spaced = re.sub(r"([a-záéíóúüñ])([A-ZÁÉÍÓÚÜÑ])", r"\1 \2", value)
    return _restore_accents(spaced.replace("_", " ").replace("-", " ").strip().capitalize())


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
            raise MissingValueError(item["key"], item["label"])
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
    found = []
    for marker_field in marker_fields:
        marker = marker_field["marker"]
        for page_index, page in enumerate(document):
            for rectangle in page.search_for(marker):
                found.append(
                    {
                        "marker_field": marker_field,
                        "page": page_index + 1,
                        "x0": rectangle.x0,
                        "y0": rectangle.y0,
                        "x1": rectangle.x1,
                        "y1": rectangle.y1,
                        "page_width": page.rect.width,
                        "page_height": page.rect.height,
                        "type": marker_field["type"],
                    }
                )
                page.add_redact_annot(rectangle, fill=(1, 1, 1))
    placements = place_auto_fields(found)
    fields = []
    for item, placement in zip(found, placements):
        marker_field = item["marker_field"]
        fields.append(
            {
                "identifier": 0,
                "type": marker_field["type"],
                "page": item["page"],
                **placement,
                "recipient_index": marker_field["recipient_index"],
                "fieldMeta": {
                    "type": marker_field["type"].lower(),
                    "label": marker_field["label"],
                    "required": True,
                    "templateVariable": marker_field["key"],
                },
            }
        )
    for page in document:
        page.apply_redactions()
    output = document.tobytes(garbage=4, deflate=True)
    document.close()
    return output, fields


# Auto field size in points: (min width, height in text lines, min height).
AUTO_FIELD_POINTS = {
    "SIGNATURE": (150.0, 2.4, 28.0),
    "INITIALS": (60.0, 1.8, 20.0),
    "NAME": (130.0, 1.4, 14.0),
    "EMAIL": (160.0, 1.4, 14.0),
    "DATE": (90.0, 1.4, 14.0),
    "TEXT": (130.0, 1.4, 14.0),
    "NUMBER": (70.0, 1.4, 14.0),
    "RADIO": (90.0, 1.6, 16.0),
    "CHECKBOX": (90.0, 1.6, 16.0),
    "DROPDOWN": (120.0, 1.4, 14.0),
}
AUTO_FIELD_GAP = 2.0


def _overlaps(left, right):
    return not (
        left[2] + AUTO_FIELD_GAP <= right[0]
        or right[2] + AUTO_FIELD_GAP <= left[0]
        or left[3] + AUTO_FIELD_GAP <= right[1]
        or right[3] + AUTO_FIELD_GAP <= left[1]
    )


def place_auto_fields(items):
    """Place fields found from tokens without covering each other.

    Each item has page, x0/y0/x1/y1 (the token's box in points), page_width,
    page_height and type. The field keeps the token's line: signatures sit on
    the line and grow upwards into the usual blank space, other fields are
    centred on it. Clashes move a field right, then down, then shrink it.
    Returns positionX/positionY/width/height in page percent, in input order.
    """
    order = sorted(range(len(items)), key=lambda index: (items[index]["page"], items[index]["y0"], items[index]["x0"]))
    placed = {}
    result = [None] * len(items)
    for index in order:
        item = items[index]
        page_width = float(item["page_width"]) or 1.0
        page_height = float(item["page_height"]) or 1.0
        min_width, lines, min_height = AUTO_FIELD_POINTS.get(item["type"], AUTO_FIELD_POINTS["TEXT"])
        line_height = max(float(item["y1"]) - float(item["y0"]), 6.0)
        width = min(max(float(item["x1"]) - float(item["x0"]), min_width), page_width)
        height = min(max(line_height * lines, min_height), page_height)
        x0 = float(item["x0"])
        if item["type"] in {"SIGNATURE", "INITIALS"}:
            y0 = float(item["y1"]) + line_height * 0.25 - height
        else:
            y0 = (float(item["y0"]) + float(item["y1"])) / 2 - height / 2
        x0 = max(0.0, min(page_width - width, x0))
        y0 = max(0.0, min(page_height - height, y0))
        origin_x = x0
        others = placed.setdefault(item["page"], [])
        for _ in range(25):
            box = (x0, y0, x0 + width, y0 + height)
            blocker = next((other for other in others if _overlaps(box, other)), None)
            if blocker is None:
                break
            if blocker[2] + AUTO_FIELD_GAP + width <= page_width:
                x0 = blocker[2] + AUTO_FIELD_GAP
            elif blocker[3] + AUTO_FIELD_GAP + height <= page_height:
                x0 = origin_x
                y0 = blocker[3] + AUTO_FIELD_GAP
            else:
                width = max(width * 0.8, 20.0)
                height = max(height * 0.8, 8.0)
        others.append((x0, y0, x0 + width, y0 + height))
        result[index] = {
            "positionX": round(x0 / page_width * 100, 4),
            "positionY": round(y0 / page_height * 100, 4),
            "width": round(width / page_width * 100, 4),
            "height": round(height / page_height * 100, 4),
        }
    return result


def schema_changes(old_schema, new_schema):
    """What publishing a new Word version changes in its variables."""
    old_keys = {item["key"] for item in old_schema.get("variables") or []}
    new_keys = {item["key"] for item in new_schema.get("variables") or []}
    old_signers = {item["index"] for item in old_schema.get("recipients") or []}
    new_signers = {item["index"] for item in new_schema.get("recipients") or []}
    return {
        "added": sorted(new_keys - old_keys),
        "removed": sorted(old_keys - new_keys),
        "signers_added": sorted(new_signers - old_signers),
        "signers_removed": sorted(old_signers - new_signers),
    }


def schema_summary(schema):
    return {
        "data_count": len({item["key"] for item in schema.get("variables") or []}),
        "signer_count": len(schema.get("recipients") or []),
        "signing_field_count": len({item["key"] for item in schema.get("signing_fields") or []}),
    }


def _camel_suggestion(text):
    words = re.split(r"[\s_-]+", text.strip())
    return "".join(word[:1].upper() + word[1:] for word in words if word)


def analyse_docx_warnings(docx_bytes, schema=None, manual_fields=None):
    """Advisory checks shown at creation and on the detail page. They never
    change how tokens are classified."""
    schema = schema or analyse_docx_variables(docx_bytes)
    warnings = []
    seen = set()

    def add(code, token, params):
        marker = (code, token)
        if marker in seen:
            return
        seen.add(marker)
        warnings.append({"code": code, "token": token, "params": params})

    texts = [text for _, xml_bytes in _word_xml_entries(docx_bytes) for _, text in _paragraph_texts(xml_bytes)]
    for text in texts:
        for match in PLACEHOLDER_RE.finditer(text):
            key = match.group(1)
            canonical = _canonical(key)
            if canonical in RESERVED_SUGGESTIONS:
                add(
                    "reserved_token",
                    key,
                    {
                        "field_type": FIELD_PREFIXES[canonical],
                        "recipient_index": 0,
                        "suggestion": RESERVED_SUGGESTIONS[canonical],
                    },
                )
        for match in LOOSE_PLACEHOLDER_RE.finditer(text):
            if PLACEHOLDER_RE.fullmatch(match.group(0)):
                continue
            raw = match.group(1).strip()
            if raw and re.search(r"\s", raw):
                add("space_in_name", raw, {"suggestion": _camel_suggestion(raw)})

    indexes = sorted(item["index"] for item in schema.get("recipients") or [])
    if indexes:
        for missing in sorted(set(range(indexes[-1] + 1)) - set(indexes)):
            add("signer_gap", f"Firmante{missing + 1}", {"missing_index": missing, "max_index": indexes[-1]})

    manual_signatures = {
        int(field.get("recipient_index") or 0)
        for field in manual_fields or []
        if isinstance(field, dict) and str(field.get("type") or "").upper() == "SIGNATURE"
    }
    for recipient in schema.get("recipients") or []:
        has_contact = recipient.get("requires_name") or recipient.get("requires_email")
        if has_contact and "SIGNATURE" not in (recipient.get("field_types") or []):
            if recipient["index"] not in manual_signatures:
                add(
                    "signer_without_signature",
                    f"Firmante{recipient['index'] + 1}",
                    {"recipient_index": recipient["index"]},
                )
    return warnings


SPANISH_MONTHS = (
    "enero",
    "febrero",
    "marzo",
    "abril",
    "mayo",
    "junio",
    "julio",
    "agosto",
    "septiembre",
    "octubre",
    "noviembre",
    "diciembre",
)
ISO_DATE_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})$")


def format_long_spanish_date(value):
    match = ISO_DATE_RE.match(str(value).strip())
    if not match:
        return None
    year, month, day = (int(part) for part in match.groups())
    if not 1 <= month <= 12 or not 1 <= day <= 31:
        return None
    return f"{day} de {SPANISH_MONTHS[month - 1]} de {year}"


def _parse_number(value):
    text = str(value).strip().replace("$", "").replace(" ", "")
    if not re.fullmatch(r"-?[\d,]*\.?\d+", text):
        return None
    try:
        return float(text.replace(",", ""))
    except ValueError:
        return None


def format_number_es_mx(value, currency=False):
    number = _parse_number(value)
    if number is None:
        return None
    if currency:
        return f"${number:,.2f}"
    if number == int(number):
        return f"{int(number):,}"
    return f"{number:,.2f}"


def format_variable_value(value, value_type, setting=None):
    """Format a value for the document. Dates typed as YYYY-MM-DD become
    long Spanish dates unless date_format is "iso"; numbers and currency are
    formatted only when the variable settings say so. Anything that does not
    parse is inserted as typed."""
    setting = setting if isinstance(setting, dict) else {}
    text = str(value or "").strip()
    if not text:
        return text
    kind = setting.get("type") or value_type
    if kind == "date" and setting.get("date_format") != "iso":
        text = format_long_spanish_date(text) or text
    elif setting.get("type") in {"number", "currency"}:
        text = format_number_es_mx(text, currency=setting.get("type") == "currency") or text
    # Written in capitals where the template had them ("JUAN PÉREZ")
    return text.upper() if setting.get("case") == "upper" else text


SAMPLE_BY_WORD = (
    ("correo", "nombre@empresa.com"),
    ("email", "nombre@empresa.com"),
    ("nombre", "Nombre Apellido Apellido"),
    ("direccion", "Av. Constitución 1234, Col. Centro"),
    ("domicilio", "Av. Constitución 1234, Col. Centro"),
    ("ciudad", "Monterrey"),
    ("estado", "Nuevo León"),
    ("pais", "México"),
    ("telefono", "81 1234 5678"),
    ("celular", "81 1234 5678"),
    ("rfc", "XAXX010101000"),
    ("curp", "XAXX010101HNLXXX09"),
    ("monto", "$12,500.00"),
    ("precio", "$12,500.00"),
    ("importe", "$12,500.00"),
    ("comision", "15%"),
    ("porcentaje", "15%"),
    ("duracion", "12 meses"),
    ("plazo", "12 meses"),
    ("meses", "12"),
)
SAMPLE_WORDS = "Texto de ejemplo con la longitud aproximada del dato real".split()


def sample_value(item, setting=None):
    """Realistic stand-in used to lay out the configure PDF."""
    setting = setting if isinstance(setting, dict) else {}
    if setting.get("default"):
        return str(setting["default"])
    kind = setting.get("type") or item.get("type")
    if kind == "date":
        return "25 de octubre de 2026"
    if kind == "currency":
        return "$12,500.00"
    if kind == "number":
        return "1,250"
    if kind == "choice" and setting.get("options"):
        return str(setting["options"][0])
    canonical = _canonical(str(item.get("key") or ""))
    for word, sample in SAMPLE_BY_WORD:
        if word in canonical:
            return sample
    label = str(setting.get("label") or item.get("label") or item.get("key") or "")
    count = max(2, min(len(SAMPLE_WORDS), len(label) // 4 + 1))
    return " ".join(SAMPLE_WORDS[:count])
