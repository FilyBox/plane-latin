/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { strToU8, zipSync } from "fflate";
import type { TBudgetForecast, TBudgetForecastLine } from "@plane/types";

type ExportFormat = "csv" | "xlsx";

const escapeXml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

const escapeCsv = (value: string) => `"${value.replaceAll('"', '""')}"`;

const columnName = (index: number) => {
  let value = index + 1;
  let name = "";
  while (value > 0) {
    value -= 1;
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26);
  }
  return name;
};

const downloadBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
};

const exportLabel = (line: TBudgetForecastLine, lines: TBudgetForecastLine[]) => {
  let ownerName = line.owner_name;
  if (!ownerName && line.category === "BENEFIT") {
    const assignmentId = line.key.startsWith("benefit:") ? line.key.slice("benefit:".length) : "";
    ownerName = lines.find((candidate) => candidate.key === `salary:${assignmentId}`)?.label;
  }
  if (!ownerName || line.label.toLocaleLowerCase().includes(ownerName.toLocaleLowerCase())) return line.label;
  return `${line.label} - ${ownerName}`;
};

export const budgetExportRows = (forecast: TBudgetForecast): (string | number)[][] => {
  const monthHeaders = forecast.months.map(({ year, month }) => `${year}-${String(month).padStart(2, "0")}`);
  return [
    ["Concept", "Type", "Entity", "Currency", ...monthHeaders, "Total"],
    ...forecast.lines.map((line) => [
      exportLabel(line, forecast.lines),
      line.category,
      line.entity_name,
      line.currency,
      ...line.months.map((month) => Number(month.amount)),
      Number(line.total),
    ]),
  ];
};

const createWorksheet = (rows: (string | number)[][]) => {
  const sheetRows = rows
    .map((row, rowIndex) => {
      const cells = row
        .map((value, columnIndex) => {
          const reference = `${columnName(columnIndex)}${rowIndex + 1}`;
          return typeof value === "number"
            ? `<c r="${reference}" t="n"><v>${Number.isFinite(value) ? value : 0}</v></c>`
            : `<c r="${reference}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
        })
        .join("");
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetViews><sheetView workbookViewId="0"><pane xSplit="4" ySplit="1" topLeftCell="E2" activePane="bottomRight" state="frozen"/></sheetView></sheetViews>
  <sheetData>${sheetRows}</sheetData>
</worksheet>`;
};

const createXlsx = (rows: (string | number)[][]) => {
  const files = {
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`),
    "xl/workbook.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Budget" sheetId="1" r:id="rId1"/></sheets>
</workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`),
    "xl/worksheets/sheet1.xml": strToU8(createWorksheet(rows)),
  };
  return new Blob([zipSync(files)], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
};

export function exportBudgetForecast(forecast: TBudgetForecast, baseName: string, format: ExportFormat) {
  const safeName =
    baseName
      .trim()
      .replace(/[^a-zA-Z0-9-_]+/g, "-")
      .replace(/^-+|-+$/g, "") || "budget";
  const rows = budgetExportRows(forecast);
  if (format === "csv") {
    const csv = rows.map((row) => row.map((value) => escapeCsv(String(value))).join(",")).join("\r\n");
    downloadBlob(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }), `${safeName}.csv`);
    return;
  }
  downloadBlob(createXlsx(rows), `${safeName}.xlsx`);
}
