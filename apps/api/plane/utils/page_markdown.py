# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""A page's content as the assistant reads and edits it.

The page editor's HTML becomes Markdown in the assistant's own dialect, the
one `markdown_to_html` reads back: headings, paragraphs, lists, quotes,
rules, tables, bold, italics, code, links and mentions
(:contract[Name]{name=<id>}). A block that dialect can't hold — an image, a
checklist, a code block, a callout, an embed, a nested list, colored text —
becomes a marker line `[[bloque:<key>]]` standing for the original HTML. The
assistant keeps, moves or drops markers but never rewrites them, and they
come back untouched when the page is saved, so an edit never loses what the
Markdown can't show.
"""

import hashlib
import re

from bs4 import BeautifulSoup, NavigableString, Tag

from plane.utils.assistant_markdown import markdown_to_html, plain_text

MARKER_RE = re.compile(r"^\s*\[\[bloque:([0-9a-f]{10})\]\]\s*$")
_INLINE = {"strong", "b", "em", "i", "code", "a", "br", "mention-component", "span"}
_HEADINGS = {"h1": 1, "h2": 2, "h3": 3}
_LABEL_UNSAFE = re.compile(r"[\]\|\n\r]+")


class PageChanged(Exception):
    """The page no longer has a block the edit refers to."""


def fingerprint(html: str) -> str:
    """Identifies a page's words, to tell whether it changed since it was read."""
    return hashlib.sha1(plain_text(html).encode()).hexdigest()[:16]


def _marker_key(block_html: str) -> str:
    return hashlib.sha1(block_html.encode()).hexdigest()[:10]


def _top_blocks(html: str) -> list:
    soup = BeautifulSoup(html or "", "lxml")
    root = soup.body or soup
    return [child for child in root.children if isinstance(child, Tag) or str(child).strip()]


def mention_targets(html: str) -> list[tuple[str, str]]:
    """(kind, id) of every mention in the page, each once."""
    soup = BeautifulSoup(html or "", "lxml")
    seen: dict[tuple[str, str], None] = {}
    for node in soup.find_all("mention-component"):
        kind, identifier = node.get("entity_name"), node.get("entity_identifier")
        if kind and identifier:
            seen[(str(kind), str(identifier).lower())] = None
    return list(seen)


def _inline(node, labels: dict) -> str | None:
    """Markdown for inline content, or None when it holds something Markdown can't."""
    parts: list[str] = []
    for child in node.children:
        if isinstance(child, NavigableString):
            parts.append(str(child))
            continue
        if not isinstance(child, Tag):
            continue
        name = child.name
        if name not in _INLINE:
            return None
        if name == "br":
            parts.append("\n")
        elif name == "mention-component":
            kind, identifier = child.get("entity_name"), child.get("entity_identifier")
            if not kind or not identifier:
                return None
            label = _LABEL_UNSAFE.sub(" ", labels.get((kind, identifier.lower())) or kind).strip() or kind
            parts.append(f":{kind}[{label}]{{name={identifier.lower()}}}")
        elif name == "span" and (child.attrs and set(child.attrs) - {"class"}):
            # Colors, highlights and other styling: keep the whole block as is
            return None
        else:
            inner = _inline(child, labels)
            if inner is None:
                return None
            if name in ("strong", "b"):
                parts.append(f"**{inner}**" if inner.strip() else inner)
            elif name in ("em", "i"):
                parts.append(f"*{inner}*" if inner.strip() else inner)
            elif name == "code":
                parts.append(f"`{child.get_text()}`")
            elif name == "a":
                href = str(child.get("href") or "")
                if not re.match(r"^(https?://|/)", href) or "\n" in inner:
                    return None
                parts.append(f"[{inner}]({href})")
            else:
                parts.append(inner)
    return "".join(parts)


def _single_line(node, labels: dict) -> str | None:
    text = _inline(node, labels)
    return None if text is None or "\n" in text.strip() else text.strip()


def _only_paragraph(node) -> Tag | None:
    """The single <p> a list item, quote or cell holds, or None."""
    children = [child for child in node.children if isinstance(child, Tag) or str(child).strip()]
    if len(children) == 1 and isinstance(children[0], Tag) and children[0].name == "p":
        return children[0]
    return None


def _block(block, labels: dict) -> str | None:
    name = getattr(block, "name", None)
    if name is None:
        return str(block).strip()
    if name == "p":
        text = _inline(block, labels)
        return None if text is None else "\n".join(line.strip() for line in text.strip().split("\n"))
    if name in _HEADINGS:
        text = _single_line(block, labels)
        return None if text is None else f"{'#' * _HEADINGS[name]} {text}"
    if name == "hr":
        return "---"
    if name == "blockquote":
        paragraph = _only_paragraph(block)
        text = _single_line(paragraph, labels) if paragraph is not None else None
        return None if text is None else f"> {text}"
    if name in ("ul", "ol"):
        if block.get("data-type"):  # checklists
            return None
        lines = []
        for index, item in enumerate(child for child in block.children if isinstance(child, Tag)):
            paragraph = _only_paragraph(item) if item.name == "li" else None
            text = _single_line(paragraph, labels) if paragraph is not None else None
            if not text:
                return None
            lines.append(f"{'-' if name == 'ul' else f'{index + 1}.'} {text}")
        return "\n".join(lines) or None
    if name == "table":
        rows = block.find_all("tr")
        if not rows or not all(cell.name == "th" for cell in rows[0].find_all(["th", "td"], recursive=False)):
            return None
        table = []
        for row in rows:
            cells = []
            for cell in row.find_all(["th", "td"], recursive=False):
                if cell.get("colspan", "1") != "1" or cell.get("rowspan", "1") != "1":
                    return None
                paragraph = _only_paragraph(cell)
                text = _single_line(paragraph, labels) if paragraph is not None else ""
                if text is None or "|" in text:
                    return None
                cells.append(text)
            table.append(cells)
        width = len(table[0])
        if any(len(row) != width for row in table):
            return None
        lines = ["| " + " | ".join(table[0]) + " |", "|" + "---|" * width]
        lines += ["| " + " | ".join(row) + " |" for row in table[1:]]
        return "\n".join(lines)
    return None


def page_to_markdown(html: str, labels: dict) -> tuple[str, int]:
    """The page as Markdown, and how many blocks went in as markers.

    `labels` names each mention: {(kind, id): name}.
    """
    out: list[str] = []
    kept = 0
    for block in _top_blocks(html):
        text = _block(block, labels)
        if text is None:
            out.append(f"[[bloque:{_marker_key(str(block))}]]")
            kept += 1
        elif text:
            out.append(text)
    return "\n\n".join(out), kept


def markdown_to_page_html(markdown: str, current_html: str, mention_types: set[str], allowed, tag_href=None) -> str:
    """The page's new HTML: the Markdown converted, each marker replaced by
    the block of the current page it stands for."""
    originals = {_marker_key(str(block)): str(block) for block in _top_blocks(current_html)}
    pieces: list[str] = []
    chunk: list[str] = []

    def flush():
        text = "\n".join(chunk).strip()
        if text:
            pieces.append(markdown_to_html(text, mention_types, allowed, tag_href=tag_href))
        chunk.clear()

    for line in str(markdown or "").replace("\r\n", "\n").split("\n"):
        marker = MARKER_RE.match(line)
        if marker is None:
            chunk.append(line)
            continue
        flush()
        original = originals.get(marker.group(1))
        if original is None:
            raise PageChanged(marker.group(1))
        pieces.append(original)
    flush()
    return "".join(pieces) or "<p></p>"
