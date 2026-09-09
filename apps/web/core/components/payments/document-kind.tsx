/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { getFileIcon } from "@/components/icons";

export type TDocumentViewerKind = "image" | "pdf" | "xlsx" | "docx" | "csv" | "xml" | "none";

const extensionOf = (name: string) => name.slice(name.lastIndexOf(".") + 1).toLowerCase();

/** Which viewer can render this receipt.
 *
 * Mirrors the file library's mapping so an invoice opens the same way whether
 * it is reached from Files or from an expense, plus XML — the format a CFDI
 * arrives in, which expenses see constantly and the library did not cover.
 */
export function documentViewerKind(name: string, contentType = ""): TDocumentViewerKind {
  const type = contentType.toLowerCase();
  const extension = extensionOf(name);
  if (type.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "tif", "tiff"].includes(extension))
    return "image";
  if (type === "application/pdf" || extension === "pdf") return "pdf";
  if (type.includes("xml") || extension === "xml") return "xml";
  if (type.includes("spreadsheetml") || type.includes("ms-excel") || ["xlsx", "xls"].includes(extension)) return "xlsx";
  if (type.includes("wordprocessingml") || type.includes("msword") || ["docx", "doc"].includes(extension)) return "docx";
  if (type === "text/csv" || type === "text/tab-separated-values" || ["csv", "tsv"].includes(extension)) return "csv";
  return "none";
}

/** The work-item attachment icon for a receipt, keyed off the extension the
 * icon set actually knows about. */
export function documentIcon(name: string, size = 28) {
  const extension = extensionOf(name);
  const known: Record<string, string> = {
    jpeg: "jpg",
    xls: "xlsx",
    docx: "doc",
    xml: "html",
    tif: "png",
    tiff: "png",
    webp: "png",
  };
  return getFileIcon(known[extension] ?? extension, size);
}
