# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Text edits on a Word (.docx) file that change only the text asked for.

A .docx is a ZIP of XML parts. Each paragraph (w:p) holds runs (w:r) of
text (w:t) sharing one format, and Word splits a single word over several
runs for invisible reasons (spell checking, language, edit history). The
edits here work on a paragraph's joined text and map every change back to
the runs it touches, changing as few characters as possible:

- "3 años" → "5 años" changes one character inside its run;
- a name replaced by {{NombreArtista}} takes the format of the run that held
  most of the name; the other runs only lose the replaced letters (they are
  never removed, nor are their properties touched);
- a new paragraph copies only the paragraph and letter properties of its
  anchor (style, indentation, numbering), never its contents or Word's ids.

Text that crosses a tab, a line break, an image, a field or a footnote
reference is refused, as is text inside a tracked change or a field result:
those are never removed as part of a replacement. Every result is checked by
`verify_preserved` against the original before it may be saved: the same ZIP
entries in the same order, untouched entries identical, and in edited parts
nothing but the reported text and paragraphs different.

Pages and occurrences are counted from 0; paragraphs are identified as
"<part>:<index>" ("document:12", "header1:0").
"""

import copy
import re
import unicodedata
from io import BytesIO
from zipfile import ZipFile

from lxml import etree

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
MC = "http://schemas.openxmlformats.org/markup-compatibility/2006"
XML_SPACE = "{http://www.w3.org/XML/1998/namespace}space"
NS = {"w": W, "mc": MC}
TOKEN_RE = re.compile(r"{{\s*([\wÁÉÍÓÚÜÑáéíóúüñ.-]{1,100})\s*}}", re.UNICODE)
KEY_RE = re.compile(r"^[\wÁÉÍÓÚÜÑáéíóúüñ.-]{1,100}$", re.UNICODE)

MAX_DOCX_BYTES = 25 * 1024 * 1024
MAX_EDITS = 100

# Parts with text a person edits; comments, glossary and settings stay out.
TEXT_PART_RE = re.compile(r"^word/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$")

# One character in the joined text for what is not text: never crossed.
TAB, BREAK, OBJECT = "\t", "\n", "￼"
BARRIERS = {TAB, BREAK, OBJECT}


def w(tag):
    return f"{{{W}}}{tag}"


class EditError(Exception):
    """A user-facing reason an edit can't be made, with what was found."""

    def __init__(self, message, code="invalid", occurrences=None, operation=None):
        super().__init__(message)
        self.code = code
        self.occurrences = occurrences or []
        self.operation = operation

    def as_dict(self):
        return {
            "error": str(self),
            "code": self.code,
            "operation": self.operation,
            "occurrences": self.occurrences,
        }


# ----------------------------------------------------------------- reading


def _read_zip(data: bytes):
    if len(data) > MAX_DOCX_BYTES:
        raise EditError("The Word file is too large.", "too_large")
    try:
        archive = ZipFile(BytesIO(data))
        entries = [(info, archive.read(info.filename)) for info in archive.infolist()]
    except Exception:
        raise EditError("The file is not a readable Word document.", "invalid_docx")
    names = [info.filename for info, _ in entries]
    if "word/document.xml" not in names:
        raise EditError("The file is not a readable Word document.", "invalid_docx")
    return entries


def _parse(content: bytes):
    parser = etree.XMLParser(resolve_entities=False, no_network=True, huge_tree=True, remove_blank_text=False)
    return etree.fromstring(content, parser)


def _short(name: str) -> str:
    return name.rsplit("/", 1)[-1].removesuffix(".xml")


def _owner_paragraph(node):
    parent = node.getparent()
    while parent is not None and parent.tag != w("p"):
        parent = parent.getparent()
    return parent


def _in_fallback(node) -> bool:
    """Word stores text boxes twice (mc:Choice and mc:Fallback): read one."""
    parent = node.getparent()
    while parent is not None:
        if parent.tag == f"{{{MC}}}Fallback":
            return True
        parent = parent.getparent()
    return False


def _location(paragraph, part: str) -> str:
    kind = re.sub(r"\d+$", "", part)
    if kind != "document":
        return {"footnotes": "footnote", "endnotes": "endnote"}.get(kind, kind)
    parent = paragraph.getparent()
    while parent is not None:
        if parent.tag == w("txbxContent"):
            return "textbox"
        if parent.tag == w("tbl"):
            return "table"
        parent = parent.getparent()
    return "body"


class Paragraph:
    """A paragraph's visible text, with where each character lives."""

    def __init__(self, element, part: str, index: int):
        self.element = element
        self.part = part
        self.index = index
        self.id = f"{part}:{index}"
        self.segments = []  # (start, end, node or None, flags)
        self.pending = []  # positions of tracked deletions
        self.text = ""
        self._read()

    def _read(self):
        pieces = []
        cursor = 0
        field_depth = []  # per complex field: "code" or "result"

        def add(text, node=None, **flags):
            nonlocal cursor
            if not text:
                return
            pieces.append(text)
            self.segments.append((cursor, cursor + len(text), node, flags))
            cursor += len(text)

        def walk(element, inserted=False, in_simple_field=False):
            for child in element:
                tag = child.tag
                if not isinstance(tag, str):
                    continue
                if tag == w("p") or tag == f"{{{MC}}}Fallback":
                    # Nested text boxes are paragraphs of their own
                    continue
                if tag in (w("del"), w("moveFrom")):
                    self.pending.append(cursor)
                    continue
                if tag == w("pPr"):
                    continue
                if tag == w("t"):
                    in_result = bool(field_depth) and field_depth[-1] == "result"
                    add(
                        child.text or "",
                        child,
                        inserted=inserted,
                        field=in_simple_field or in_result,
                    )
                    if not (child.text or ""):
                        self.segments.append((cursor, cursor, child, {"inserted": inserted, "field": False}))
                    continue
                if tag == w("tab") and child.getparent().tag == w("r"):
                    add(TAB)
                    continue
                if tag in (w("br"), w("cr")):
                    add(BREAK)
                    continue
                if tag in (
                    w("drawing"),
                    w("pict"),
                    w("object"),
                    w("footnoteReference"),
                    w("endnoteReference"),
                    w("sym"),
                    w("noBreakHyphen"),
                ):
                    # A drawing's text boxes are read as paragraphs of their own
                    add(OBJECT)
                    continue
                if tag == w("fldChar"):
                    kind = child.get(w("fldCharType"))
                    if kind == "begin":
                        field_depth.append("code")
                    elif kind == "separate" and field_depth:
                        field_depth[-1] = "result"
                    elif kind == "end" and field_depth:
                        field_depth.pop()
                    continue
                if tag == w("instrText"):
                    continue
                walk(
                    child,
                    inserted or tag in (w("ins"), w("moveTo")),
                    in_simple_field or tag == w("fldSimple"),
                )

        walk(self.element)
        self.text = "".join(pieces)

    def nodes(self):
        return [segment for segment in self.segments if segment[2] is not None]

    @property
    def has_image(self) -> bool:
        return bool(self.element.xpath(".//w:drawing|.//w:pict", namespaces=NS))


class Document:
    """The .docx opened for reading and editing: entries in their order, the
    text parts parsed, and every paragraph in reading order."""

    def __init__(self, data: bytes):
        self.source = data
        self.entries = _read_zip(data)
        self.trees = {}
        self.originals = {}
        for info, content in self.entries:
            if TEXT_PART_RE.match(info.filename):
                self.trees[info.filename] = _parse(content)
                self.originals[info.filename] = content
        self.track_changes = self._settings_flag("trackRevisions")
        self.numbering = _Numbering(self._entry("word/numbering.xml"), self._entry("word/styles.xml"))
        self.paragraphs = self._paragraphs()
        self.dirty = set()

    def _entry(self, name):
        for info, content in self.entries:
            if info.filename == name:
                return content
        return None

    def _settings_flag(self, flag) -> bool:
        content = self._entry("word/settings.xml")
        if not content:
            return False
        try:
            root = _parse(content)
        except Exception:
            return False
        element = root.find(w(flag))
        return element is not None and element.get(w("val"), "true") not in ("false", "0")

    def _paragraphs(self):
        ordered = sorted(self.trees, key=lambda name: (0 if name.endswith("document.xml") else 1, name))
        paragraphs = []
        for name in ordered:
            part = _short(name)
            for index, element in enumerate(self.trees[name].iter(w("p"))):
                if _in_fallback(element):
                    continue
                paragraphs.append(Paragraph(element, part, index))
        return paragraphs

    def paragraph(self, paragraph_id):
        for paragraph in self.paragraphs:
            if paragraph.id == paragraph_id:
                return paragraph
        return None

    def to_bytes(self) -> bytes:
        output = BytesIO()
        with ZipFile(output, "w") as archive:
            for info, content in self.entries:
                if info.filename in self.trees and info.filename in self.dirty:
                    content = etree.tostring(
                        self.trees[info.filename], xml_declaration=True, encoding="UTF-8", standalone=True
                    )
                archive.writestr(info, content)
        return output.getvalue()


# ----------------------------------------------------------------- numbering


ROMAN = [(1000, "m"), (900, "cm"), (500, "d"), (400, "cd"), (100, "c"), (90, "xc"), (50, "l"), (40, "xl")]
ROMAN += [(10, "x"), (9, "ix"), (5, "v"), (4, "iv"), (1, "i")]


def _roman(number):
    result = ""
    for value, letters in ROMAN:
        while number >= value:
            result += letters
            number -= value
    return result


def _letters(number):
    result = ""
    while number > 0:
        number, remainder = divmod(number - 1, 26)
        result = chr(97 + remainder) + result
    return result


class _Numbering:
    """Word's automatic numbers ("Cláusula 5."), computed for reading only:
    they are not in the text, so edits never anchor on them."""

    def __init__(self, numbering_xml, styles_xml):
        self.levels = {}  # numId -> {ilvl: (start, fmt, text)}
        self.style_numbering = {}
        self.counters = {}
        try:
            if numbering_xml:
                root = _parse(numbering_xml)
                abstract = {}
                for item in root.findall(w("abstractNum")):
                    levels = {}
                    for level in item.findall(w("lvl")):
                        ilvl = int(level.get(w("ilvl"), "0"))
                        start = level.find(w("start"))
                        fmt = level.find(w("numFmt"))
                        text = level.find(w("lvlText"))
                        levels[ilvl] = (
                            int(start.get(w("val"), "1")) if start is not None else 1,
                            fmt.get(w("val"), "decimal") if fmt is not None else "decimal",
                            text.get(w("val"), "") if text is not None else "",
                        )
                    abstract[item.get(w("abstractNumId"))] = levels
                for num in root.findall(w("num")):
                    reference = num.find(w("abstractNumId"))
                    if reference is not None:
                        self.levels[num.get(w("numId"))] = abstract.get(reference.get(w("val")), {})
            if styles_xml:
                root = _parse(styles_xml)
                for style in root.findall(w("style")):
                    num = style.find(f"{w('pPr')}/{w('numPr')}")
                    if num is not None:
                        num_id = num.find(w("numId"))
                        ilvl = num.find(w("ilvl"))
                        self.style_numbering[style.get(w("styleId"))] = (
                            num_id.get(w("val")) if num_id is not None else None,
                            int(ilvl.get(w("val"), "0")) if ilvl is not None else 0,
                        )
        except Exception:
            self.levels = {}

    def label(self, paragraph_element):
        props = paragraph_element.find(w("pPr"))
        if props is None:
            return None
        num_pr = props.find(w("numPr"))
        num_id, ilvl = None, 0
        if num_pr is not None:
            node = num_pr.find(w("numId"))
            level = num_pr.find(w("ilvl"))
            num_id = node.get(w("val")) if node is not None else None
            ilvl = int(level.get(w("val"), "0")) if level is not None else 0
        else:
            style = props.find(w("pStyle"))
            if style is not None and style.get(w("val")) in self.style_numbering:
                num_id, ilvl = self.style_numbering[style.get(w("val"))]
        levels = self.levels.get(num_id)
        if not num_id or num_id == "0" or not levels or ilvl not in levels:
            return None
        counters = self.counters.setdefault(num_id, {})
        counters[ilvl] = counters.get(ilvl, levels[ilvl][0] - 1) + 1
        for deeper in [level for level in counters if level > ilvl]:
            del counters[deeper]
        _, fmt, text = levels[ilvl]
        if fmt == "bullet":
            return "•"
        if fmt == "none":
            return None

        def number(match):
            level = int(match.group(1)) - 1
            if level not in levels:
                return ""
            value = counters.get(level, levels[level][0])
            kind = levels[level][1]
            if kind == "lowerRoman":
                return _roman(value)
            if kind == "upperRoman":
                return _roman(value).upper()
            if kind == "lowerLetter":
                return _letters(value)
            if kind == "upperLetter":
                return _letters(value).upper()
            return str(value)

        return re.sub(r"%(\d)", number, text) or None


# ----------------------------------------------------------------- outline


def _display(text: str) -> str:
    return text.replace(OBJECT, "▢")


def docx_outline(data: bytes, max_paragraphs: int = 2000) -> dict:
    """The paragraphs in reading order, with their place, text, automatic
    number and the tokens they hold. This is what the assistant reads."""
    document = Document(data)
    paragraphs = []
    for paragraph in document.paragraphs:
        label = document.numbering.label(paragraph.element)
        if not paragraph.text.strip() and not label and not paragraph.has_image:
            continue
        style = paragraph.element.find(f"{w('pPr')}/{w('pStyle')}")
        paragraphs.append(
            {
                "id": paragraph.id,
                "location": _location(paragraph.element, paragraph.part),
                "number": label,
                "style": style.get(w("val")) if style is not None else None,
                "text": _display(paragraph.text),
                "tokens": [match.group(1) for match in TOKEN_RE.finditer(paragraph.text)],
                "has_image": paragraph.has_image or None,
                "tracked_changes": bool(paragraph.pending) or None,
            }
        )
        if len(paragraphs) >= max_paragraphs:
            break
    return {
        "paragraphs": [{key: value for key, value in item.items() if value is not None} for item in paragraphs],
        "track_changes": document.track_changes,
        "truncated": len(paragraphs) >= max_paragraphs,
    }


# ----------------------------------------------------------------- finding


def _fold_char(character: str) -> str:
    decomposed = unicodedata.normalize("NFD", character)
    return "".join(c for c in decomposed if not unicodedata.combining(c)).casefold()


def _folded(text: str):
    """Text without case, accents or repeated spaces, and where each folded
    character came from."""
    folded, positions = [], []
    previous_space = False
    for index, character in enumerate(text):
        if character.isspace() and character not in BARRIERS:
            if previous_space:
                continue
            previous_space = True
            folded.append(" ")
            positions.append(index)
            continue
        previous_space = False
        for piece in _fold_char(character):
            folded.append(piece)
            positions.append(index)
    return "".join(folded), positions


def _matches(text: str, query: str, match: str):
    if not query:
        return []
    if match == "exact":
        found, start = [], 0
        while True:
            index = text.find(query, start)
            if index < 0:
                return found
            found.append((index, index + len(query)))
            start = index + max(1, len(query))
    folded, positions = _folded(text)
    needle, _ = _folded(query.strip())
    found, start = [], 0
    while needle:
        index = folded.find(needle, start)
        if index < 0:
            break
        end_index = index + len(needle) - 1
        found.append((positions[index], positions[end_index] + 1))
        start = index + max(1, len(needle))
    return found


def _context(paragraph: Paragraph, start: int, end: int, width: int = 40) -> dict:
    return {
        "before": _display(paragraph.text[max(0, start - width) : start]),
        "text": _display(paragraph.text[start:end]),
        "after": _display(paragraph.text[end : end + width]),
    }


def _occurrences(document: Document, query: str, match: str = "exact", paragraph_id=None):
    found = []
    for paragraph in document.paragraphs:
        if paragraph_id and paragraph.id != paragraph_id:
            continue
        for start, end in _matches(paragraph.text, query, match):
            found.append((paragraph, start, end))
    return found


def _occurrence_payload(index, paragraph, start, end, query, match):
    exact = paragraph.text[start:end] == query
    return {
        "index": index,
        "paragraph": paragraph.id,
        "location": _location(paragraph.element, paragraph.part),
        **_context(paragraph, start, end),
        "loose": None if exact or match == "exact" else True,
    }


def find_text(data: bytes, text: str, match: str = "exact") -> list[dict]:
    """Every appearance of `text`, with ~40 letters around it. "loose"
    ignores case, accents and repeated spaces: "JUAN PÉREZ" in the header and
    "Juan Perez" in the body both appear."""
    document = Document(data)
    return [
        {key: value for key, value in _occurrence_payload(index, *item, text, match).items() if value is not None}
        for index, item in enumerate(_occurrences(document, text, match))
    ]


# ----------------------------------------------------------------- editing


def _run_props(node):
    run = node.getparent()
    while run is not None and run.tag != w("r"):
        run = run.getparent()
    if run is None:
        return b""
    props = run.find(w("rPr"))
    return etree.tostring(props) if props is not None else b""


def _set_text(node, text: str):
    node.text = text
    if text != text.strip() or "  " in text:
        node.set(XML_SPACE, "preserve")


def _check_range(paragraph: Paragraph, start: int, end: int, operation: int):
    piece = paragraph.text[start:end]
    if any(character in piece for character in BARRIERS):
        raise EditError(
            "The text crosses a tab, a line break, an image, a field or a note; use a shorter anchor.",
            "crosses_barrier",
            [{"paragraph": paragraph.id, **_context(paragraph, start, end)}],
            operation,
        )
    if any(start < position < end for position in paragraph.pending):
        raise EditError(
            "The text is inside a tracked change; accept or reject the changes in Word first.",
            "tracked_change",
            [{"paragraph": paragraph.id, **_context(paragraph, start, end)}],
            operation,
        )
    for seg_start, seg_end, node, flags in paragraph.nodes():
        if seg_end <= start or seg_start >= end:
            continue
        if flags.get("inserted"):
            raise EditError(
                "The text is inside a tracked change; accept or reject the changes in Word first.",
                "tracked_change",
                [{"paragraph": paragraph.id, **_context(paragraph, start, end)}],
                operation,
            )
        if flags.get("field"):
            raise EditError(
                "The text is the result of a Word field (a date, an index, a reference) and can't be edited.",
                "field",
                [{"paragraph": paragraph.id, **_context(paragraph, start, end)}],
                operation,
            )


def _replace_range(paragraph: Paragraph, start: int, end: int, new: str) -> dict:
    """Replaces text[start:end] by `new` touching as few characters as
    possible. Returns what changed (for the report and the format notes)."""
    old = paragraph.text[start:end]
    prefix = 0
    while prefix < min(len(old), len(new)) and old[prefix] == new[prefix]:
        prefix += 1
    suffix = 0
    while suffix < min(len(old), len(new)) - prefix and old[len(old) - 1 - suffix] == new[len(new) - 1 - suffix]:
        suffix += 1
    change_start, change_end = start + prefix, end - suffix
    inserted = new[prefix : len(new) - suffix]
    nodes = [segment for segment in paragraph.nodes() if segment[1] > segment[0] or segment[0] == segment[1]]
    touched = [segment for segment in nodes if segment[0] < change_end and segment[1] > change_start]
    note = None
    if not touched:
        # A pure insertion: into the run that ends (or holds) the position
        holder = next(
            (segment for segment in nodes if segment[0] < change_start <= segment[1]),
            next((segment for segment in nodes if segment[0] <= change_start < segment[1]), None),
        )
        holder = holder or (nodes[0] if nodes else None)
        if holder is None:
            raise EditError("Nowhere to put the new text in this paragraph.", "no_run")
        seg_start, _, node, _ = holder
        text = node.text or ""
        offset = change_start - seg_start
        _set_text(node, text[:offset] + inserted + text[offset:])
        return {"runs": 1, "note": None}
    # The new text goes where most of the old text was
    overlap = lambda segment: min(segment[1], change_end) - max(segment[0], change_start)  # noqa: E731
    keeper = max(touched, key=overlap)
    if len({_run_props(segment[2]) for segment in touched}) > 1 and inserted:
        note = "mixed_format"
    for segment in touched:
        seg_start, seg_end, node, _ = segment
        text = node.text or ""
        cut_start = max(change_start, seg_start) - seg_start
        cut_end = min(change_end, seg_end) - seg_start
        replacement = inserted if segment is keeper else ""
        _set_text(node, text[:cut_start] + replacement + text[cut_end:])
    return {"runs": len(touched), "note": note}


def _reread(document: Document, paragraph: Paragraph) -> Paragraph:
    fresh = Paragraph(paragraph.element, paragraph.part, paragraph.index)
    document.paragraphs[document.paragraphs.index(paragraph)] = fresh
    return fresh


def _mirror(document: Document, paragraph: Paragraph):
    """The mc:Fallback copy of a text box paragraph, if Word wrote one."""
    alternate = paragraph.element.getparent()
    while alternate is not None and alternate.tag != f"{{{MC}}}AlternateContent":
        alternate = alternate.getparent()
    if alternate is None:
        return None
    choice = alternate.find(f"{{{MC}}}Choice")
    fallback = alternate.find(f"{{{MC}}}Fallback")
    if choice is None or fallback is None:
        return None
    choices = list(choice.iter(w("p")))
    fallbacks = list(fallback.iter(w("p")))
    if len(choices) != len(fallbacks) or paragraph.element not in choices:
        return None
    return Paragraph(fallbacks[choices.index(paragraph.element)], paragraph.part, -1)


def _replace_mirrored(document, report, paragraph, start, end, new):
    """Replaces in a paragraph and, for a text box, in Word's second copy."""
    mirror = _mirror(document, paragraph)
    mirror_same = mirror is not None and mirror.text == paragraph.text
    result = _replace_range(paragraph, start, end, new)
    report.paragraphs_changed.add(paragraph.element)
    if mirror_same:
        _replace_range(mirror, start, end, new)
        report.paragraphs_changed.add(mirror.element)
    report.runs_changed += result["runs"]
    return result


class _Report:
    def __init__(self):
        self.operations = []
        self.warnings = []
        self.paragraphs_changed = set()
        self.runs_changed = 0
        self.inserted = 0
        self.deleted = 0
        self.renamed = {}
        self.upper_tokens = set()
        self.new_paragraphs = set()


def _anchor(document, edit, operation):
    """The one paragraph (and place in it) an anchor names."""
    query = str(edit.get("anchor") or "")
    if not query.strip():
        raise EditError("The anchor is empty.", "empty_anchor", operation=operation)
    match = edit.get("match") or "exact"
    found = _occurrences(document, query, match, edit.get("paragraph"))
    if not found:
        raise EditError(f"«{query[:60]}» does not appear in the document.", "not_found", operation=operation)
    pick = edit.get("occurrence")
    if pick is None and len(found) > 1:
        raise EditError(
            f"«{query[:60]}» appears {len(found)} times; say which one (occurrence).",
            "ambiguous",
            [_occurrence_payload(index, *item, query, match) for index, item in enumerate(found)],
            operation,
        )
    index = int(pick or 0)
    if not 0 <= index < len(found):
        raise EditError("That occurrence does not exist.", "bad_occurrence", operation=operation)
    return found[index]


def _replace_text(document, report, edit, operation):
    query = str(edit.get("find") or "")
    new = str(edit.get("replace") if edit.get("replace") is not None else "")
    match = edit.get("match") or "exact"
    if not query:
        raise EditError("Nothing to find.", "empty_find", operation=operation)
    found = _occurrences(document, query, match, edit.get("paragraph"))
    if not found:
        raise EditError(f"«{query[:60]}» does not appear in the document.", "not_found", operation=operation)
    wanted = edit.get("occurrences", "all")
    indexes = list(range(len(found))) if wanted in (None, "all") else [int(value) for value in wanted]
    if any(not 0 <= index < len(found) for index in indexes):
        raise EditError("That occurrence does not exist.", "bad_occurrence", operation=operation)
    applied = []
    # Right to left inside each paragraph, so earlier positions stay valid
    for index in sorted(indexes, key=lambda value: (found[value][0].id, -found[value][1])):
        paragraph, start, end = found[index]
        paragraph = next(item for item in document.paragraphs if item.element is paragraph.element)
        _check_range(paragraph, start, end, operation)
        original = paragraph.text[start:end]
        context = _context(paragraph, start, end)
        result = _replace_mirrored(document, report, paragraph, start, end, new)
        if result["note"] == "mixed_format":
            report.warnings.append({"code": "mixed_format", "paragraph": paragraph.id, "text": original})
        token = TOKEN_RE.fullmatch(new.strip())
        letters = [character for character in original if character.isalpha()]
        if token and letters and all(character.isupper() for character in letters):
            report.upper_tokens.add(token.group(1))
        applied.append(
            {
                "index": index,
                "paragraph": paragraph.id,
                "location": _location(paragraph.element, paragraph.part),
                **context,
                "replacement": new,
                "loose": original != query or None,
            }
        )
        _reread(document, paragraph)
    applied.sort(key=lambda item: item["index"])
    return applied


def _insert_text(document, report, edit, operation):
    paragraph, start, end = _anchor(document, edit, operation)
    text = str(edit.get("text") or "")
    if not text or any(character in text for character in "\n\r"):
        raise EditError("insert_text takes one line of text.", "bad_text", operation=operation)
    _check_range(paragraph, start, end, operation)
    position = end if edit.get("position", "after") == "after" else start
    context = _context(paragraph, start, end)
    _replace_mirrored(document, report, paragraph, position, position, text)
    _reread(document, paragraph)
    return [{"paragraph": paragraph.id, **context, "inserted": text, "position": edit.get("position", "after")}]


PARAGRAPH_PROPS_DROP = ("sectPr", "pPrChange")
RUN_PROPS_DROP = ("rPrChange",)


def _new_paragraph(anchor: Paragraph, text: str):
    element = etree.Element(w("p"), nsmap=anchor.element.nsmap)
    props = anchor.element.find(w("pPr"))
    if props is not None:
        props = copy.deepcopy(props)
        for tag in PARAGRAPH_PROPS_DROP:
            for child in props.findall(w(tag)):
                props.remove(child)
        element.append(props)
    run = etree.SubElement(element, w("r"))
    first = next((segment[2] for segment in anchor.nodes()), None)
    if first is not None:
        source = first.getparent()
        while source is not None and source.tag != w("r"):
            source = source.getparent()
        run_props = source.find(w("rPr")) if source is not None else None
        if run_props is not None:
            run_props = copy.deepcopy(run_props)
            for tag in RUN_PROPS_DROP:
                for child in run_props.findall(w(tag)):
                    run_props.remove(child)
            run.append(run_props)
    node = etree.SubElement(run, w("t"))
    _set_text(node, text)
    return element


def _insert_paragraph(document, report, edit, operation):
    paragraph, start, end = _anchor(document, edit, operation)
    if _mirror(document, paragraph) is not None or _location(paragraph.element, paragraph.part) == "textbox":
        raise EditError("Paragraphs can't be added inside a text box.", "textbox", operation=operation)
    lines = [line for line in str(edit.get("text") or "").split("\n")]
    if not any(line.strip() for line in lines):
        raise EditError("The new paragraph is empty.", "bad_text", operation=operation)
    position = edit.get("position", "after")
    reference = paragraph.element
    created = []
    for line in lines:
        element = _new_paragraph(paragraph, line)
        if position == "before":
            reference.addprevious(element)
        else:
            reference.addnext(element)
            reference = element
        created.append(element)
    report.new_paragraphs.update(created)
    report.inserted += len(created)
    return [
        {
            "paragraph": paragraph.id,
            **_context(paragraph, start, end),
            "inserted_paragraphs": lines,
            "position": position,
        }
    ]


def _delete_paragraph(document, report, edit, operation):
    paragraph, start, end = _anchor(document, edit, operation)
    element = paragraph.element
    if element.find(f"{w('pPr')}/{w('sectPr')}") is not None:
        raise EditError(
            "That paragraph carries a section break (margins and page size); it is never deleted.",
            "section_break",
            operation=operation,
        )
    if element.xpath(
        ".//w:bookmarkStart|.//w:bookmarkEnd|.//w:commentRangeStart|.//w:commentRangeEnd|"
        ".//w:footnoteReference|.//w:endnoteReference",
        namespaces=NS,
    ):
        raise EditError(
            "That paragraph holds a bookmark, a comment or a note reference; delete it in Word.",
            "anchored_content",
            operation=operation,
        )
    if paragraph.has_image and not edit.get("confirm_image"):
        raise EditError(
            "That paragraph has an image; confirm deleting it separately.", "has_image", operation=operation
        )
    parent = element.getparent()
    if len(parent.findall(w("p"))) <= 1 and parent.tag in (w("tc"), w("body"), w("txbxContent"), w("hdr"), w("ftr")):
        raise EditError("Word needs at least one paragraph there.", "last_paragraph", operation=operation)
    context = _context(paragraph, start, end)
    text = _display(paragraph.text)
    parent.remove(element)
    document.paragraphs.remove(paragraph)
    report.deleted += 1
    return [{"paragraph": paragraph.id, **context, "deleted_text": text}]


def _rename_token(document, report, edit, operation):
    old, new = str(edit.get("from") or "").strip(), str(edit.get("to") or "").strip()
    old, new = old.strip("{} "), new.strip("{} ")
    if not KEY_RE.match(new):
        raise EditError(
            "A token name has no spaces: letters, numbers, _, . or -, up to 100 characters.",
            "bad_key",
            operation=operation,
        )
    applied = []
    for paragraph in list(document.paragraphs):
        for found in reversed(list(TOKEN_RE.finditer(paragraph.text))):
            if found.group(1) != old:
                continue
            current = next(item for item in document.paragraphs if item.element is paragraph.element)
            _check_range(current, found.start(), found.end(), operation)
            context = _context(current, found.start(), found.end())
            _replace_mirrored(document, report, current, found.start(), found.end(), "{{" + new + "}}")
            applied.append({"paragraph": current.id, **context, "replacement": "{{" + new + "}}"})
            paragraph = _reread(document, current)
    if not applied:
        raise EditError(f"The token {{{{{old}}}}} is not in the document.", "not_found", operation=operation)
    report.renamed[old] = new
    return applied


OPERATIONS = {
    "replace_text": _replace_text,
    "insert_text": _insert_text,
    "insert_paragraph": _insert_paragraph,
    "delete_paragraph": _delete_paragraph,
    "rename_token": _rename_token,
}


def _paragraph_index(document):
    """Where each paragraph element sits, per part, in document order."""
    index = {}
    for name, tree in document.trees.items():
        for position, element in enumerate(tree.iter(w("p"))):
            index[element] = (name, position)
    return index


def apply_edits(data: bytes, edits: list) -> tuple[bytes, dict]:
    """Applies the edits in order. Returns the new bytes and a report: per
    operation what changed (with context), the format notes, and where the
    changed, inserted and deleted paragraphs are (for verify_preserved).
    Raises EditError with the occurrences found when an edit can't apply."""
    if not isinstance(edits, list) or not edits:
        raise EditError("No edits.", "no_edits")
    if len(edits) > MAX_EDITS:
        raise EditError(f"At most {MAX_EDITS} edits at once.", "too_many")
    document = Document(data)
    before_index = _paragraph_index(document)
    report = _Report()
    removed = []
    for operation, edit in enumerate(edits):
        if not isinstance(edit, dict) or edit.get("op") not in OPERATIONS:
            raise EditError("Unknown edit.", "unknown_op", operation=operation)
        if edit["op"] == "delete_paragraph":
            target = _anchor(document, edit, operation)[0].element
            removed.append(before_index.get(target))
        applied = OPERATIONS[edit["op"]](document, report, edit, operation)
        report.operations.append({"op": edit["op"], "applied": applied})

    # Which parts changed, and where the changed/new paragraphs are now
    after_index = _paragraph_index(document)
    changed_parts = {before_index[element][0] for element in report.paragraphs_changed if element in before_index}
    changed_parts |= {name for name, _ in removed if name}
    for element, (name, _) in after_index.items():
        if element in report.new_paragraphs:
            changed_parts.add(name)
    locations = {}
    for name in changed_parts:
        locations[name] = {"changed": [], "inserted": [], "deleted": []}
    for element, (name, position) in after_index.items():
        if name not in locations:
            continue
        if element in report.new_paragraphs:
            locations[name]["inserted"].append(position)
        elif element in report.paragraphs_changed:
            locations[name]["changed"].append(position)
    for name, position in removed:
        if name:
            locations[name]["deleted"].append(position)
    for item in locations.values():
        for key in item:
            item[key].sort()
    document.dirty = set(changed_parts)
    result = document.to_bytes()
    if document.track_changes:
        report.warnings.append({"code": "track_changes_on"})
    summary = {
        "runs_changed": report.runs_changed,
        "paragraphs_changed": len(report.paragraphs_changed),
        "paragraphs_inserted": report.inserted,
        "paragraphs_deleted": report.deleted,
    }
    return result, {
        "operations": report.operations,
        "warnings": report.warnings,
        "summary": summary,
        "renamed_tokens": report.renamed,
        "upper_tokens": sorted(report.upper_tokens),
        "locations": locations,
    }


# ----------------------------------------------------------------- verifying


class NotPreserved(EditError):
    pass


def _skeleton(element, changed_positions, position_of):
    """The tree without the text of changed paragraphs' runs and without
    xml:space on them: what must stay identical."""
    clone = copy.deepcopy(element)
    originals = list(element.iter(w("p")))
    clones = list(clone.iter(w("p")))
    for original, duplicate in zip(originals, clones):
        if position_of.get(original) in changed_positions:
            for node in duplicate.iter(w("t")):
                node.text = ""
                node.attrib.pop(XML_SPACE, None)
    return clone


def verify_preserved(before: bytes, after: bytes, report: dict) -> dict:
    """Checks that `after` differs from `before` only where the report says.

    1. The ZIP has the same entries in the same order; untouched entries are
       identical (content and metadata).
    2. In edited parts, after dropping the inserted paragraphs (from after)
       and the deleted ones (from before), the trees are identical except the
       text of the changed paragraphs' runs (and their xml:space).
    Raises NotPreserved on any other difference; returns a short summary.
    """
    old = _read_zip(before)
    new = _read_zip(after)
    if [info.filename for info, _ in old] != [info.filename for info, _ in new]:
        raise NotPreserved("The edited file lost or reordered parts of the document.", "zip_changed")
    locations = report.get("locations") or {}
    for (old_info, old_content), (new_info, new_content) in zip(old, new):
        if (old_info.date_time, old_info.compress_type) != (new_info.date_time, new_info.compress_type):
            raise NotPreserved(f"{old_info.filename} changed its metadata.", "zip_changed")
        if old_info.filename not in locations:
            if old_content != new_content:
                raise NotPreserved(f"{old_info.filename} changed without being edited.", "untouched_changed")
            continue
        where = locations[old_info.filename]
        old_root, new_root = _parse(old_content), _parse(new_content)
        for position in sorted(where["deleted"], reverse=True):
            target = list(old_root.iter(w("p")))[position]
            target.getparent().remove(target)
        for position in sorted(where["inserted"], reverse=True):
            target = list(new_root.iter(w("p")))[position]
            target.getparent().remove(target)
        # Changed paragraphs, renumbered once the inserted ones are out
        inserted = sorted(where["inserted"])
        changed_now = {position - sum(1 for value in inserted if value < position) for position in where["changed"]}
        old_positions = {element: index for index, element in enumerate(old_root.iter(w("p")))}
        new_positions = {element: index for index, element in enumerate(new_root.iter(w("p")))}
        left = etree.tostring(_skeleton(old_root, changed_now, old_positions), method="c14n")
        right = etree.tostring(_skeleton(new_root, changed_now, new_positions), method="c14n")
        if left != right:
            raise NotPreserved("The edit changed more than the reported text; nothing was saved.", "format_changed")
    summary = report.get("summary") or {}
    return {
        "preserved": True,
        "runs_changed": summary.get("runs_changed", 0),
        "paragraphs_changed": summary.get("paragraphs_changed", 0),
        "paragraphs_inserted": summary.get("paragraphs_inserted", 0),
        "paragraphs_deleted": summary.get("paragraphs_deleted", 0),
    }
