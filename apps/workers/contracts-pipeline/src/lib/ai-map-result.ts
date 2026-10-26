/**
 * Validation of the AI column mapping (music import). Pure, so it is unit
 * tested without the model: only real fields and real headers survive, a
 * single-column field keeps one column, and every suggestion carries a
 * confidence (0..1 or null) and a short reason.
 */

export type AiMapRequest = {
  columns: Record<string, { non_empty: number; total: number; examples: string[] }>;
  canonical_fields: string[];
  multi_fields: string[];
  locale?: string | null;
  /** What is mapped now: field -> column | columns */
  current_mapping?: Record<string, string | string[]>;
  /** Fields the user mapped by hand: never changed unless clearly wrong */
  locked_fields?: string[];
  /** Fixed values per field (no column needed for those) */
  constants?: Record<string, string | string[]>;
  /** One line per field saying what it holds */
  field_descriptions?: Record<string, string>;
};

/** The model's input: everything it needs, nothing it doesn't. */
export function buildAiMapQuery(body: AiMapRequest): string {
  const language = String(body.locale || "es")
    .toLowerCase()
    .startsWith("en")
    ? "en (English)"
    : "es (español)";
  return JSON.stringify({
    locale: language,
    canonical_fields: body.canonical_fields,
    field_descriptions: body.field_descriptions ?? {},
    multi_fields: body.multi_fields,
    current_mapping: body.current_mapping ?? {},
    locked_fields: body.locked_fields ?? [],
    constants: Object.keys(body.constants ?? {}),
    columns: body.columns,
  });
}

export type AiMapSuggestion = {
  columns: string[];
  /** 0..1, or null when the model gave none */
  confidence: number | null;
  /** Why, in the user's language; "" when the model gave none */
  reason: string;
  /** Multi-column field: the columns replace the current ones instead of
   * being added to them */
  replace: boolean;
  /** The user set this field by hand: shown as a flagged suggestion only */
  locked: boolean;
};

export type AiMapContext = {
  headers: Iterable<string>;
  fields: Iterable<string>;
  multi: Iterable<string>;
  locked?: Iterable<string>;
};

export type AiMapResult = {
  /** field -> column | columns (backward compatible shape) */
  mapping: Record<string, string | string[]>;
  suggestions: Record<string, AiMapSuggestion>;
};

const REASON_LIMIT = 200;

const confidenceOf = (value: unknown): number | null => {
  const number = typeof value === "string" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isFinite(number)) return null;
  // Some models answer in percent
  const scaled = number > 1 && number <= 100 ? number / 100 : number;
  return Math.min(1, Math.max(0, Math.round(scaled * 100) / 100));
};

const columnsOf = (value: unknown): unknown[] => {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    const entry = value as { columns?: unknown; column?: unknown };
    return columnsOf(entry.columns ?? entry.column);
  }
  return value === undefined || value === null ? [] : [value];
};

/** `raw` is the model's `mapping` object. Each value may be a column, a list
 * of columns, or `{ columns, confidence, reason, replace }`. */
export function normalizeAiMapping(raw: unknown, context: AiMapContext): AiMapResult {
  const headers = new Set(context.headers);
  const fields = new Set(context.fields);
  const multi = new Set(context.multi);
  const locked = new Set(context.locked ?? []);
  const mapping: Record<string, string | string[]> = {};
  const suggestions: Record<string, AiMapSuggestion> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { mapping, suggestions };

  for (const [field, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!fields.has(field)) continue;
    const columns = [
      ...new Set(
        columnsOf(value).filter((column): column is string => typeof column === "string" && headers.has(column))
      ),
    ];
    if (columns.length === 0) continue;
    const isMulti = multi.has(field);
    const kept = isMulti ? columns : columns.slice(0, 1);
    const details =
      value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
    mapping[field] = isMulti ? kept : kept[0];
    suggestions[field] = {
      columns: kept,
      confidence: confidenceOf(details.confidence),
      reason: typeof details.reason === "string" ? details.reason.trim().slice(0, REASON_LIMIT) : "",
      replace: isMulti && details.replace === true,
      locked: locked.has(field),
    };
  }
  return { mapping, suggestions };
}
