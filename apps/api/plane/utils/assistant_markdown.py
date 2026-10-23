# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Markdown written by the assistant → the page editor's HTML.

Small on purpose: headings, paragraphs, bullet and numbered lists, quotes,
rules, bold, italics, inline code and links. Everything else is escaped, so
nothing the model writes can inject markup. Mentions in the assistant's
format (:contract[Name]{name=<id>}) become the editor's own mention nodes,
which render as chips and create references like a person's mention would.
"""

import html
import re
import uuid

MENTION_RE = re.compile(r":([a-z_]{2,20})\[([^\]\n]{1,160})\]\{name=([0-9a-fA-F-]{36})\}")
_BOLD = re.compile(r"\*\*(.+?)\*\*")
_ITALIC = re.compile(r"(?<![\w*])[*_](?![\s*_])(.+?)(?<![\s*_])[*_](?![\w*])")
_CODE = re.compile(r"`([^`]+)`")
_LINK = re.compile(r"\[([^\]]+)\]\(((?:https?://|/)[^)\s]+)\)")
_HEADING = re.compile(r"^(#{1,3})\s+(.*)$")
_BULLET = re.compile(r"^\s*[-*•]\s+(.*)$")
_NUMBERED = re.compile(r"^\s*\d+[.)]\s+(.*)$")
_DIVIDER = re.compile(r"^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$")


def _cells(line: str) -> list[str]:
    return [cell.strip() for cell in line.strip().strip("|").split("|")]


def _inline(text: str, mention_types: set[str], allowed, tag_href=None) -> str:
    placeholders: list[str] = []

    def keep(fragment: str) -> str:
        placeholders.append(fragment)
        return f"\x00{len(placeholders) - 1}\x00"

    def mention(match):
        kind, label, identifier = match.group(1), match.group(2), match.group(3)
        if kind in mention_types and allowed(kind, identifier):
            return keep(
                f'<mention-component id="{uuid.uuid4()}" entity_name="{kind}" '
                f'entity_identifier="{identifier.lower()}"></mention-component>'
            )
        # A tag has no mention node in the editor: it links to its tag view.
        if kind == "tag" and tag_href:
            return keep(f'<a href="{html.escape(tag_href(identifier.lower()))}">{html.escape(label)}</a>')
        # Anything the reader can't open stays as a plain name.
        return keep(f"<strong>{html.escape(label)}</strong>")

    text = MENTION_RE.sub(mention, text)
    text = html.escape(text, quote=False)
    text = _CODE.sub(lambda match: keep(f"<code>{match.group(1)}</code>"), text)
    text = _LINK.sub(
        lambda match: keep(
            f'<a href="{html.escape(match.group(2))}" target="_blank" rel="noopener noreferrer">{match.group(1)}</a>'
        ),
        text,
    )
    text = _BOLD.sub(r"<strong>\1</strong>", text)
    text = _ITALIC.sub(r"<em>\1</em>", text)
    return re.sub(r"\x00(\d+)\x00", lambda match: placeholders[int(match.group(1))], text)


def markdown_to_html(
    markdown: str, mention_types: set[str], allowed=lambda kind, identifier: True, tag_href=None
) -> str:
    blocks: list[str] = []
    paragraph: list[str] = []
    items: list[str] = []
    list_tag: str | None = None

    def inline(value: str) -> str:
        return _inline(value, mention_types, allowed, tag_href)

    def flush_paragraph():
        if paragraph:
            blocks.append(f"<p>{'<br>'.join(inline(line) for line in paragraph)}</p>")
            paragraph.clear()

    def flush_list():
        nonlocal list_tag
        if items:
            body = "".join(f"<li><p>{item}</p></li>" for item in items)
            blocks.append(f"<{list_tag}>{body}</{list_tag}>")
            items.clear()
        list_tag = None

    lines = str(markdown or "").replace("\r\n", "\n").split("\n")
    index = 0
    while index < len(lines):
        line = lines[index].rstrip()
        index += 1
        # A table: header row, divider row, body rows (the editor's table nodes).
        if line.strip().startswith("|") and index < len(lines) and _DIVIDER.match(lines[index]):
            flush_paragraph()
            flush_list()
            header = _cells(line)
            index += 1
            body = []
            while index < len(lines) and lines[index].strip().startswith("|"):
                body.append(_cells(lines[index]))
                index += 1
            head = "".join(f'<th colspan="1" rowspan="1"><p>{inline(cell)}</p></th>' for cell in header)
            rows = "".join(
                "<tr>"
                + "".join(
                    f'<td colspan="1" rowspan="1"><p>{inline(row[i] if i < len(row) else "")}</p></td>'
                    for i in range(len(header))
                )
                + "</tr>"
                for row in body
            )
            blocks.append(f"<table><tbody><tr>{head}</tr>{rows}</tbody></table>")
            continue
        if not line.strip():
            flush_paragraph()
            flush_list()
            continue
        heading = _HEADING.match(line)
        bullet = _BULLET.match(line)
        numbered = _NUMBERED.match(line)
        if heading:
            flush_paragraph()
            flush_list()
            level = len(heading.group(1))
            blocks.append(f"<h{level}>{inline(heading.group(2))}</h{level}>")
        elif line.strip() in ("---", "***", "___"):
            flush_paragraph()
            flush_list()
            blocks.append("<hr>")
        elif line.lstrip().startswith(">"):
            flush_paragraph()
            flush_list()
            blocks.append(f"<blockquote><p>{inline(line.lstrip()[1:].strip())}</p></blockquote>")
        elif bullet or numbered:
            flush_paragraph()
            tag = "ul" if bullet else "ol"
            if list_tag and list_tag != tag:
                flush_list()
            list_tag = tag
            items.append(inline((bullet or numbered).group(1)))
        else:
            flush_list()
            paragraph.append(line.strip())
    flush_paragraph()
    flush_list()
    return "".join(blocks) or "<p></p>"


def plain_text(value: str) -> str:
    """Words only, to tell whether a page was edited after it was created."""
    text = re.sub(r"<[^>]+>", " ", str(value or ""))
    return " ".join(html.unescape(text).split())
