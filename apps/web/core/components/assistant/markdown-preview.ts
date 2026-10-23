/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * Preview of a page the assistant wrote, mirroring the server's converter
 * (apps/api/plane/utils/assistant_markdown.py): headings, paragraphs, lists,
 * quotes, rules, tables, bold, italics, code and links. Everything is escaped
 * first, so the result is safe to render as HTML. Mentions show as "@Name".
 */

const MENTION = /:([a-z_]{2,20})\[([^\]\n]{1,160})\]\{name=[0-9a-fA-F-]{36}\}/g;

const escape = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function inline(text: string): string {
  const kept: string[] = [];
  const keep = (fragment: string) => `${kept.push(fragment) - 1}`;
  let out = text.replace(MENTION, (_match, _type: string, label: string) => keep(`<strong>@${escape(label)}</strong>`));
  out = escape(out);
  out = out.replace(/`([^`]+)`/g, (_match, code: string) => keep(`<code>${code}</code>`));
  out = out.replace(/\[([^\]]+)\]\(((?:https?:\/\/|\/)[^)\s]+)\)/g, (_match, label: string, href: string) =>
    keep(`<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`)
  );
  out = out.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^\w*])[*_](?![\s*_])(.+?)(?<![\s*_])[*_](?![\w*])/g, "$1<em>$2</em>");
  return out.replace(/(\d+)/g, (_match, index: string) => kept[Number(index)]);
}

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());

const isDivider = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

export function markdownToPreviewHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: string[] = [];
  let paragraph: string[] = [];
  let items: string[] = [];
  let listTag: "ul" | "ol" | null = null;

  const flushParagraph = () => {
    if (paragraph.length) blocks.push(`<p>${paragraph.map(inline).join("<br>")}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (items.length && listTag)
      blocks.push(`<${listTag}>${items.map((item) => `<li>${item}</li>`).join("")}</${listTag}>`);
    items = [];
    listTag = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trimEnd();
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    // A table: a header row, a divider row, then body rows.
    if (line.trim().startsWith("|") && index + 1 < lines.length && isDivider(lines[index + 1])) {
      flushParagraph();
      flushList();
      const header = cells(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index].trim().startsWith("|")) {
        rows.push(cells(lines[index]));
        index += 1;
      }
      index -= 1;
      const head = `<tr>${header.map((cell) => `<th>${inline(cell)}</th>`).join("")}</tr>`;
      const body = rows.map(
        (row) => `<tr>${header.map((_cell, i) => `<td>${inline(row[i] ?? "")}</td>`).join("")}</tr>`
      );
      blocks.push(`<table>${head}${body.join("")}</table>`);
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
    } else if (["---", "***", "___"].includes(line.trim())) {
      flushParagraph();
      flushList();
      blocks.push("<hr>");
    } else if (line.trimStart().startsWith(">")) {
      flushParagraph();
      flushList();
      blocks.push(`<blockquote>${inline(line.trimStart().slice(1).trim())}</blockquote>`);
    } else if (bullet || numbered) {
      flushParagraph();
      const tag = bullet ? "ul" : "ol";
      if (listTag && listTag !== tag) flushList();
      listTag = tag;
      items.push(inline((bullet ?? numbered)![1]));
    } else {
      flushList();
      paragraph.push(line.trim());
    }
  }
  flushParagraph();
  flushList();
  return blocks.join("");
}
