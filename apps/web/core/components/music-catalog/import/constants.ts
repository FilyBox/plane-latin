/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { TMusicImportError, TMusicImportMatch, TMusicImportRowOutcome } from "@plane/types";

export type TImportStep = "file" | "columns" | "rules" | "review" | "import";

export const IMPORT_STEPS: TImportStep[] = ["file", "columns", "rules", "review", "import"];

/** Backend sentinel: rows whose raw value maps to this are dropped */
export const SKIP_ROW = "__SKIP_ROW__";

export const REQUIRED_FIELD = "track.title";

/** Shown even when unassigned: what most catalog files carry. Everything
 * else waits behind "More fields" so the step isn't a wall of 48 selects. */
export const ESSENTIAL_FIELDS = [
  "track.title",
  "track.isrc",
  "artists",
  "release.title",
  "release.release_date",
  "track.duration_ms",
  "track.version",
  "featured_artists",
  "genres",
  "record_label",
  "release.upc",
];

/** i18n key of a catalog field: "track.title" → music_import.fields.track_title */
export const fieldLabelKey = (field: string) => `music_import.fields.${field.replace(/\./g, "_")}`;

export const MATCH_LABEL_KEY: Record<TMusicImportMatch["by"], string> = {
  isrc: "music_import.review.match_by_isrc",
  title: "music_import.review.match_by_title",
  title_artist: "music_import.review.match_by_title_artist",
  title_date: "music_import.review.match_by_title_date",
  upc: "music_import.review.match_by_upc",
  catalog: "music_import.review.match_by_catalog",
  ambiguous: "music_import.review.match_by_ambiguous",
};

export const ROW_OUTCOME_LABEL_KEY: Record<TMusicImportRowOutcome, string> = {
  created: "music_import.review.row_outcome_created",
  updated: "music_import.review.row_outcome_updated",
  unchanged: "music_import.review.row_outcome_unchanged",
  skipped: "music_import.review.row_outcome_skipped",
  omitted: "music_import.review.row_outcome_omitted",
  error: "music_import.review.row_outcome_error",
};

/** Error codes the backend returns, as the user reads them */
export const errorLabelKey = (code: TMusicImportError["code"]) => {
  if (code === "REQUIRED_FIELD") return "music_import.review.error_required";
  if (code === "DUPLICATE") return "music_import.review.error_duplicate";
  if (code === "DATABASE_NOT_READY") return "music_import.review.error_database";
  if (code === "TOO_LONG") return "music_import.review.error_too_long";
  return "music_import.review.error_generic";
};

export const columnsOf = (value: string | string[] | undefined): string[] =>
  !value ? [] : Array.isArray(value) ? value.filter(Boolean) : [value];

export const formatElapsed = (milliseconds: number) => {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

export const formatDate = (value: string, locale?: string) =>
  new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric" }).format(new Date(value));
