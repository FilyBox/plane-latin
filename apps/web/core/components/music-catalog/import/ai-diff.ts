/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { TMusicImportAiSuggestion } from "@plane/types";
import { columnsOf } from "./constants";

/** Where a field's mapping came from: the system's inference (preview or a
 * restored run), the user, or an applied AI suggestion. */
export type TFieldSource = "auto" | "manual" | "ai";

export type TAiDiffItem = {
  field: string;
  /** new: the field had no column; change: it had one (or more) */
  kind: "new" | "change";
  before: string[];
  after: string[];
  /** Multi field: the AI's columns are added to the current ones */
  merge: boolean;
  confidence: number | null;
  reason: string;
  /** Set by the user by hand */
  locked: boolean;
};

export type TAiDiff = {
  items: TAiDiffItem[];
  /** Fields where the AI agrees with what is mapped */
  matches: string[];
  /** Columns with data no field takes, even after the proposal */
  unassigned: string[];
};

const sameColumns = (a: string[], b: string[]) => a.length === b.length && a.every((column) => b.includes(column));

/** The AI's proposal against the CURRENT mapping (computed on every render,
 * so edits made while the request ran are respected). */
export function diffAiSuggestions(
  suggestions: Record<string, TMusicImportAiSuggestion>,
  mapping: Record<string, string | string[]>,
  sources: Record<string, TFieldSource>,
  multiFields: Set<string>,
  columnsWithData: string[]
): TAiDiff {
  const items: TAiDiffItem[] = [];
  const matches: string[] = [];
  for (const [field, suggestion] of Object.entries(suggestions)) {
    const before = columnsOf(mapping[field]);
    const multi = multiFields.has(field);
    const base = {
      field,
      before,
      confidence: suggestion.confidence,
      reason: suggestion.reason,
      locked: suggestion.locked || sources[field] === "manual",
    };
    if (before.length === 0) {
      items.push({
        ...base,
        kind: "new",
        after: multi ? suggestion.columns : suggestion.columns.slice(0, 1),
        merge: false,
      });
      continue;
    }
    if (multi && !suggestion.replace) {
      const added = suggestion.columns.filter((column) => !before.includes(column));
      if (added.length === 0) matches.push(field);
      else items.push({ ...base, kind: "change", after: [...before, ...added], merge: true });
      continue;
    }
    const after = multi ? suggestion.columns : suggestion.columns.slice(0, 1);
    if (sameColumns(before, after)) matches.push(field);
    else items.push({ ...base, kind: "change", after, merge: false });
  }
  const used = new Set([
    ...Object.values(mapping).flatMap((value) => columnsOf(value)),
    ...items.flatMap((item) => item.after),
  ]);
  return { items, matches, unassigned: columnsWithData.filter((column) => !used.has(column)) };
}

/** Checked by default: filling an empty field. Changes to what the user
 * already has are opt-in. */
export const isCheckedByDefault = (item: TAiDiffItem) => item.kind === "new";
