/**
 * Pure helpers for the contract analysis: page markers, evidence, output
 * validation, long-document parts, merging, usage and the works a contract
 * names. Only `zod` is imported so the file runs under node --test.
 */

import { z } from "zod";

// ------------------------------------------------------------- page markers

const MARKER = /\[\[p\. (\d+)\]\]/g;

export const pageMarker = (page: number) => `[[p. ${page}]]`;

/** Joins OCR lines, opening each page with `[[p. N]]` on its own line.
 * Lines without a page stay with the page before them. */
export function joinPageLines(lines: readonly { text: string; page?: number }[]): string {
  const out: string[] = [];
  let current: number | undefined;
  for (const line of lines) {
    if (line.page !== undefined && line.page !== current) {
      current = line.page;
      out.push(`\n${pageMarker(current)}`);
    }
    out.push(line.text);
  }
  return out.join("\n").trim();
}

/** Splits marked text into pages. Text before the first marker is page null. */
export function splitPages(text: string): { page: number | null; text: string }[] {
  const pages: { page: number | null; text: string }[] = [];
  let last = 0;
  let page: number | null = null;
  for (const match of text.matchAll(MARKER)) {
    const index = match.index ?? 0;
    if (index > last || page !== null) pages.push({ page, text: text.slice(last, index) });
    page = Number(match[1]);
    last = index + match[0].length;
  }
  pages.push({ page, text: text.slice(last) });
  return pages.filter((entry) => entry.text.trim() || entry.page !== null);
}

const COMBINING_MARKS = /[̀-ͯ]/g;
const fold = (value: string) => value.normalize("NFD").replace(COMBINING_MARKS, "").toLowerCase();
const flatten = (value: string) => fold(value).replace(MARKER, " ").replace(/\s+/g, " ").trim();

/** The page a verbatim quote sits on, or null when the text has no markers
 * or the quote is not found. Falls back to the quote's first 60 characters. */
export function locateQuote(text: string, quote: string): number | null {
  const needle = flatten(quote);
  if (needle.length < 4) return null;
  const pages = splitPages(text).filter((entry) => entry.page !== null);
  if (pages.length === 0) return null;
  const flat = pages.map((entry) => ({ page: entry.page as number, text: flatten(entry.text) }));
  for (const candidate of [needle, needle.slice(0, 60)]) {
    const hit = flat.find((entry) => entry.text.includes(candidate));
    if (hit) return hit.page;
  }
  return null;
}

const maxPage = (text: string) => {
  let max = 0;
  for (const match of text.matchAll(MARKER)) max = Math.max(max, Number(match[1]));
  return max;
};

// ----------------------------------------------------------------- evidence

export type EvidenceItem = { cita: string; pagina: number | null; aproximada?: boolean; calculada?: boolean };

const MONTHS =
  /\b(ene(ro)?|feb(rero)?|mar(zo)?|abr(il)?|may(o)?|jun(io)?|jul(io)?|ago(sto)?|sep(tiembre)?|set(iembre)?|oct(ubre)?|nov(iembre)?|dic(iembre)?|january|february|march|april|june|july|august|september|october|november|december)\b/;
const NUMERIC_DATE = /\b\d{1,2}\s*[/.-]\s*\d{1,2}\s*[/.-]\s*\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b/;

/** A quote that names a year but no day or month backs only an approximate date. */
export function isYearOnlyQuote(quote: string): boolean {
  const folded = fold(quote);
  return /\b(19|20)\d{2}\b/.test(folded) && !MONTHS.test(folded) && !NUMERIC_DATE.test(folded);
}

const DATE_KEYS = new Set(["fechaInicio", "fechaFin"]);

/** Keeps evidence for known keys only, with a verbatim-checked page. */
export function normalizeEvidence(
  raw: unknown,
  text: string,
  keys: readonly string[],
  data: Record<string, unknown> = {}
): Record<string, EvidenceItem> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const source = raw as Record<string, unknown>;
  const pagesInText = maxPage(text);
  const out: Record<string, EvidenceItem> = {};
  for (const key of keys) {
    const value = source[key];
    const entry =
      typeof value === "string"
        ? { cita: value }
        : value && typeof value === "object"
          ? (value as Record<string, unknown>)
          : null;
    if (!entry) continue;
    const cita = String(entry.cita ?? entry.quote ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 400);
    if (!cita) continue;
    let pagina: number | null = pagesInText > 0 ? locateQuote(text, cita) : null;
    if (pagina === null && pagesInText > 0) {
      const claimed = Number(entry.pagina ?? entry.page);
      if (Number.isInteger(claimed) && claimed >= 1 && claimed <= pagesInText) pagina = claimed;
    }
    const item: EvidenceItem = { cita, pagina };
    const dateValue = data[key];
    const yearOnly =
      DATE_KEYS.has(key) && typeof dateValue === "string" && dateValue.endsWith("-01-01") && isYearOnlyQuote(cita);
    if (entry.aproximada === true || entry.aproximada === "true" || yearOnly) item.aproximada = true;
    out[key] = item;
  }
  return out;
}

// --------------------------------------------------------------- validation

const text = z.union([z.string(), z.number().transform(String), z.null()]).optional();
const list = z
  .union([
    z.array(z.union([z.string(), z.number().transform(String)])),
    z.string().transform((v) => (v ? [v] : [])),
    z.null(),
  ])
  .optional();
const flag = z.union([z.boolean(), z.string(), z.null()]).optional();
const months = z.union([z.number(), z.string(), z.null()]).optional();
const evidenceField = z.record(z.unknown()).optional();

export const PRIMARY_SCHEMA = z
  .object({
    tituloContrato: text,
    involucrados: list,
    nombreGrupo: text,
    fechaInicio: text,
    fechaFin: text,
    duracionMeses: months,
    esPosibleExpandirlo: text,
    tiempoExtensionPosible: text,
    tiempoExtensionMeses: months,
    tipoContrato: z.union([z.string(), z.null()]),
    periodoColeccion: text,
    descripcionPeriodoColeccion: text,
    duracionPeriodoColeccion: text,
    periodoRetencion: text,
    descripcionPeriodoRetencion: text,
    duracionPeriodoRetencion: text,
    resumenGeneral: z.union([z.string(), z.null()]),
    _evidence: evidenceField,
  })
  .passthrough();

export const SECONDARY_SCHEMA = z
  .object({
    testigos: list,
    clausulaRenovacion: text,
    esNotariado: z.union([z.boolean(), z.string(), z.null()]),
    esEditorial: z.union([z.boolean(), z.string(), z.null()]),
    _evidence: evidenceField,
  })
  .passthrough();

export const ARTISTS_SCHEMA = z
  .object({
    artistas: z.union([z.array(z.union([z.string(), z.number().transform(String)])), z.null()]),
    _evidence: evidenceField,
  })
  .passthrough();

export const CLASSIFY_SCHEMA = z.object({ esEditorial: flag }).passthrough();

export type ModelOutput = { text: string; truncated: boolean };
export type ValidationResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; reason: "truncated" | "invalid_json" | "schema"; detail: string };

/** Strict check of one model answer: complete, valid JSON, right shape. */
export function validateModelOutput(output: ModelOutput, schema: z.ZodTypeAny): ValidationResult {
  if (output.truncated) return { ok: false, reason: "truncated", detail: "output hit the token limit" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      output.text
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/```\s*$/, "")
    );
  } catch (error) {
    return { ok: false, reason: "invalid_json", detail: String(error).slice(0, 200) };
  }
  if (Array.isArray(parsed) && parsed.length === 1) parsed = parsed[0];
  const result = schema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      reason: "schema",
      detail: result.error.issues
        .map((i) => i.path.join("."))
        .join(", ")
        .slice(0, 200),
    };
  }
  return { ok: true, data: result.data as Record<string, unknown> };
}

export type ValidatedRun<U> = {
  data: Record<string, unknown>;
  attempts: number;
  repaired: boolean;
  outputs: U[];
};

/**
 * Calls the model, retries once on an invalid or truncated answer (with a
 * bigger token budget), and only then tries the repair as a flagged last resort.
 */
export async function runValidated<U extends ModelOutput>(
  call: (attempt: number) => Promise<U>,
  schema: z.ZodTypeAny,
  repair: (text: string) => unknown
): Promise<ValidatedRun<U>> {
  const outputs: U[] = [];
  let last: ValidationResult | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    // Sequential: the second call only happens when the first answer is bad.
    // eslint-disable-next-line no-await-in-loop
    const output = await call(attempt);
    outputs.push(output);
    last = validateModelOutput(output, schema);
    if (last.ok) return { data: last.data, attempts: attempt, repaired: false, outputs };
  }
  try {
    const repaired = schema.safeParse(repair(outputs[outputs.length - 1].text));
    if (repaired.success)
      return { data: repaired.data as Record<string, unknown>, attempts: 2, repaired: true, outputs };
  } catch {
    // fall through to the error below
  }
  throw new Error(`invalid model output (${last && !last.ok ? `${last.reason}: ${last.detail}` : "unknown"})`);
}

// ----------------------------------------------------------- normalization

export const CONTRACT_TYPE_VALUES = [
  "ARRENDAMIENTOS",
  "ALQUILERES",
  "VEHICULOS",
  "SERVICIOS",
  "ARTISTAS",
  "REPRESENTACION",
  "PRODUCCION",
  "EDICION",
  "LICENCIA",
  "DISTRIBUCION",
  "CESION_DERECHOS",
  "COLABORACION",
  "EVENTOS",
  "PATROCINIO",
  "CONFIDENCIALIDAD",
  "LABORAL",
  "OTRO",
] as const;

const TYPE_SYNONYMS: Record<string, string> = {
  MANAGEMENT: "REPRESENTACION",
  EDITORIAL: "EDICION",
  PUBLISHING: "EDICION",
  LICENCIAS: "LICENCIA",
  SINCRONIZACION: "LICENCIA",
  CESION: "CESION_DERECHOS",
  NDA: "CONFIDENCIALIDAD",
  EMPLEO: "LABORAL",
  ARRENDAMIENTO: "ARRENDAMIENTOS",
  ALQUILER: "ALQUILERES",
  VEHICULO: "VEHICULOS",
  SERVICIO: "SERVICIOS",
  ARTISTA: "ARTISTAS",
  EVENTO: "EVENTOS",
};

export function normalizeContractType(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const key = fold(value)
    .toUpperCase()
    .trim()
    .replace(/[\s-]+/g, "_");
  if ((CONTRACT_TYPE_VALUES as readonly string[]).includes(key)) return key;
  return TYPE_SYNONYMS[key] ?? "OTRO";
}

export function toBool(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return null;
  const folded = fold(value).trim();
  if (["true", "si", "yes", "1"].includes(folded)) return true;
  if (["false", "no", "0"].includes(folded)) return false;
  return null;
}

export function toMonths(value: unknown): number | null {
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value.replace(",", ".").match(/\d+(\.\d+)?/)?.[0])
        : NaN;
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.round(number);
}

export const PRIMARY_EVIDENCE_KEYS = [
  "tituloContrato",
  "involucrados",
  "nombreGrupo",
  "fechaInicio",
  "fechaFin",
  "duracionMeses",
  "esPosibleExpandirlo",
  "tiempoExtensionPosible",
  "tipoContrato",
  "duracionPeriodoColeccion",
  "duracionPeriodoRetencion",
] as const;
export const SECONDARY_EVIDENCE_KEYS = ["testigos", "clausulaRenovacion", "esNotariado", "esEditorial"] as const;
export const ARTISTS_EVIDENCE_KEYS = ["artistas"] as const;

/** One prompt's validated answer with its evidence checked against the text. */
export function withEvidence(data: Record<string, unknown>, fullText: string, keys: readonly string[]) {
  const { _evidence: raw, ...rest } = data;
  const proof = normalizeEvidence(raw, fullText, keys, rest);
  return Object.keys(proof).length > 0 ? { ...rest, _evidence: proof } : rest;
}

/** The payload Django receives: the prompts' answers merged, computed fields
 * left to Django (no estatusContrato), types and flags normalized. */
export function finalizeExtracted(parts: readonly Record<string, unknown>[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  const evidence: Record<string, EvidenceItem> = {};
  for (const part of parts) {
    const { _evidence: partEvidence, ...rest } = part;
    Object.assign(merged, rest);
    if (partEvidence && typeof partEvidence === "object") Object.assign(evidence, partEvidence);
  }
  delete merged.estatusContrato;
  if ("tipoContrato" in merged) merged.tipoContrato = normalizeContractType(merged.tipoContrato);
  if ("duracionMeses" in merged) merged.duracionMeses = toMonths(merged.duracionMeses);
  if (typeof merged.tiempoExtensionMeses === "string")
    merged.tiempoExtensionMeses = toMonths(merged.tiempoExtensionMeses);
  for (const key of ["esNotariado", "esEditorial"]) {
    if (key in merged) merged[key] = toBool(merged[key]);
  }
  if (Object.keys(evidence).length > 0) merged._evidence = evidence;
  return merged;
}

// ------------------------------------------------------- long documents

/** Above this many characters the text is analyzed in parts. */
export const LONG_TEXT_CHARS = 400_000;
export const PART_CHARS = 350_000;
export const PART_OVERLAP = 5_000;

/** [start, end) of each part; same cuts as splitText, from the length alone. */
export function partRanges(length: number, size = PART_CHARS, overlap = PART_OVERLAP, threshold = LONG_TEXT_CHARS) {
  if (length <= threshold) return [[0, length]] as [number, number][];
  const ranges: [number, number][] = [];
  for (let start = 0; start < length; start += size - overlap) {
    ranges.push([start, Math.min(length, start + size)]);
    if (start + size >= length) break;
  }
  return ranges;
}

const isEmpty = (value: unknown) =>
  value === null ||
  value === undefined ||
  (typeof value === "string" && (!value.trim() || value.trim().toUpperCase() === "NO_ESPECIFICADO")) ||
  (Array.isArray(value) && value.length === 0);

const LIST_KEYS = new Set(["involucrados", "testigos", "artistas"]);

const evidenceOf = (part: Record<string, unknown>, key: string) =>
  (part._evidence as Record<string, unknown> | undefined)?.[key];

/**
 * Merges one prompt's answers over the parts of a long text: lists are joined,
 * notarization counts if any part says so, the summary comes from the opening
 * part and every other field from the first part that has it. Evidence
 * follows the part each value came from.
 */
export function mergePartResults(parts: readonly Record<string, unknown>[]): Record<string, unknown> {
  if (parts.length === 1) return parts[0];
  const merged: Record<string, unknown> = {};
  const evidence: Record<string, unknown> = {};
  const keys = new Set(parts.flatMap((part) => Object.keys(part).filter((key) => key !== "_evidence")));
  for (const key of keys) {
    if (LIST_KEYS.has(key)) {
      const seen = new Map<string, string>();
      for (const part of parts) {
        for (const item of Array.isArray(part[key]) ? (part[key] as unknown[]) : []) {
          const name = String(item).trim();
          if (name && !seen.has(fold(name))) seen.set(fold(name), name);
        }
      }
      merged[key] = [...seen.values()].slice(0, 50);
      const withProof = parts.find((part) => evidenceOf(part, key));
      if (withProof) evidence[key] = evidenceOf(withProof, key);
      continue;
    }
    let source: Record<string, unknown> | undefined;
    if (key === "resumenGeneral") source = parts[0];
    else if (key === "esNotariado") source = parts.find((part) => toBool(part[key]) === true);
    source ??= parts.find((part) => !isEmpty(part[key])) ?? parts.find((part) => key in part);
    if (!source) continue;
    merged[key] = source[key];
    if (evidenceOf(source, key)) evidence[key] = evidenceOf(source, key);
  }
  if (Object.keys(evidence).length > 0) merged._evidence = evidence;
  return merged;
}

// ---------------------------------------------------------------- tags

/** Artist tags that appear in the text (accents, case and spacing ignored), capped. */
export function relevantTags(tags: readonly string[], fullText: string, cap = 60): string[] {
  const folded = fold(fullText);
  const squashed = folded.replace(/[^a-z0-9]/g, "");
  const out: string[] = [];
  for (const tag of tags) {
    const name = fold(tag).trim();
    const squash = name.replace(/[^a-z0-9]/g, "");
    if (name.length < 3) continue;
    if (folded.includes(name) || (squash.length >= 4 && squashed.includes(squash))) out.push(tag);
    if (out.length >= cap) break;
  }
  return out;
}

// ---------------------------------------------------------------- usage

export type UsageCall = {
  prompt: string;
  model: string;
  input_tokens: number;
  cached_tokens: number;
  output_tokens: number;
  cost_usd: number;
  /** 1-based part of a long text */
  part?: number;
  attempts?: number;
  repaired?: boolean;
};

const round6 = (value: number) => Math.round(value * 1_000_000) / 1_000_000;

export function summarizeUsage(calls: readonly UsageCall[]) {
  return {
    calls: calls.map((call) => ({ ...call, cost_usd: round6(call.cost_usd) })),
    total_cost_usd: round6(calls.reduce((sum, call) => sum + call.cost_usd, 0)),
  };
}

// ---------------------------------------------------------------- hashing

/** Short SHA-256 of the text, to check every step reads the same version. */
export async function textFingerprint(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest).slice(0, 8), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// ------------------------------------------------------------ vectors

/** Float32 vectors as base64: ~8 KB per 1536-dim vector instead of ~30 KB of JSON. */
export function packVector(vector: readonly number[]): string {
  const bytes = new Uint8Array(Float32Array.from(vector).buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function unpackVector(packed: string): number[] {
  const binary = atob(packed);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  // 8 significant digits keep float32 precision without long JSON numbers
  return Array.from(new Float32Array(bytes.buffer), (value) => Number(value.toPrecision(8)));
}

// ---------------------------------------------------------------- works

/** What the works prompt must return: {"obras": [...]}. Items are checked one
 * by one in normalizeWorks, so one bad item doesn't fail the whole answer. */
export const WORKS_SCHEMA = z.object({ obras: z.union([z.array(z.unknown()), z.null()]) }).passthrough();

const scalar = z.union([z.string(), z.number().transform(String), z.null()]).optional();
const WORK_ITEM = z
  .object({
    titulo: scalar,
    artistas: z
      .union([z.array(z.union([z.string(), z.number().transform(String)])), z.string().transform((v) => [v]), z.null()])
      .optional(),
    isrc: scalar,
    upc: scalar,
    tipo: scalar,
    cita: scalar,
    pagina: z.union([z.number(), z.string(), z.null()]).optional(),
  })
  .passthrough();

export type ExtractedWork = {
  titulo: string;
  artistas?: string[];
  isrc?: string;
  upc?: string;
  tipo?: "cancion" | "album";
  cita?: string;
  pagina: number | null;
};

export const MAX_WORKS = 200;

export const RIGHTS_TYPES = [
  "DISTRIBUCION",
  "EDICION",
  "MASTER",
  "LICENCIA",
  "SINCRONIZACION",
  "REPRESENTACION",
  "OTRO",
] as const;

/** Letters and digits only: how a title is looked up in OCR text. */
const squash = (value: string) => fold(value.replace(MARKER, " ")).replace(/[^a-z0-9]/g, "");
const clean = (value: unknown, max: number) =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";

const ISRC = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/;

function kindOf(value: string, hasUpc: boolean, hasIsrc: boolean): ExtractedWork["tipo"] {
  const folded = fold(value);
  if (/\b(album|ep|lp|disco|lanzamiento|release)\b/.test(folded)) return "album";
  if (folded) return "cancion";
  if (hasUpc && !hasIsrc) return "album";
  return undefined;
}

const workKey = (work: ExtractedWork) => work.isrc || work.upc || `${squash(work.titulo)}|${work.tipo ?? ""}`;

/** Drops repeated works (same ISRC/UPC, or same title and kind), keeping the first. */
export function dedupeWorks(works: readonly ExtractedWork[], cap = MAX_WORKS): ExtractedWork[] {
  const seen = new Set<string>();
  const out: ExtractedWork[] = [];
  for (const work of works) {
    const key = workKey(work);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(work);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * Cleans the model's works and keeps only those grounded in the text: the
 * title, the ISRC or the quote must appear in it. Pages are re-checked
 * against the markers like the other evidence.
 */
export function normalizeWorks(raw: unknown, fullText: string): ExtractedWork[] {
  if (!Array.isArray(raw)) return [];
  const squashedText = squash(fullText);
  const pagesInText = maxPage(fullText);
  const works: ExtractedWork[] = [];
  for (const item of raw) {
    const parsed = WORK_ITEM.safeParse(item);
    if (!parsed.success) continue;
    const data = parsed.data;
    const titulo = clean(data.titulo, 200).replace(/^["'“”«»]+|["'“”«»]+$/g, "");
    if (!titulo) continue;

    const isrcRaw = clean(data.isrc, 40)
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
    const isrc = ISRC.test(isrcRaw) ? isrcRaw : undefined;
    const upcRaw = clean(data.upc, 40).replace(/\D/g, "");
    const upc = upcRaw.length >= 12 && upcRaw.length <= 14 ? upcRaw : undefined;
    const cita = clean(data.cita, 300) || undefined;

    const titleKey = squash(titulo);
    const grounded =
      (titleKey.length >= 3 && squashedText.includes(titleKey)) ||
      (isrc !== undefined && squashedText.includes(isrc.toLowerCase())) ||
      (cita !== undefined && squash(cita).length >= 8 && squashedText.includes(squash(cita)));
    if (!grounded) continue;

    let pagina: number | null = cita && pagesInText > 0 ? locateQuote(fullText, cita) : null;
    if (pagina === null && pagesInText > 0) {
      const claimed = Number(data.pagina);
      if (Number.isInteger(claimed) && claimed >= 1 && claimed <= pagesInText) pagina = claimed;
    }

    const artistas = [...new Set((data.artistas ?? []).map((name) => clean(name, 120)).filter(Boolean))].slice(0, 10);
    const work: ExtractedWork = { titulo, pagina };
    if (artistas.length > 0) work.artistas = artistas;
    if (isrc) work.isrc = isrc;
    if (upc) work.upc = upc;
    const tipo = kindOf(clean(data.tipo, 40), Boolean(upc), Boolean(isrc));
    if (tipo) work.tipo = tipo;
    if (cita) work.cita = cita;
    works.push(work);
  }
  return dedupeWorks(works);
}

/** Works merged over the parts of a long text (the overlap repeats some). */
export const mergeWorks = (parts: readonly (readonly ExtractedWork[])[]) => dedupeWorks(parts.flat());

/** One work as Django's works/suggest and match endpoints read it. */
export type WorkPayload = {
  title: string;
  artists?: string[];
  isrc?: string;
  upc?: string;
  kind?: "track" | "release";
  cita?: string;
  pagina?: number | null;
};

export const toWorkPayload = (works: readonly ExtractedWork[]): WorkPayload[] =>
  works.map((work) => {
    const out: WorkPayload = { title: work.titulo };
    if (work.artistas?.length) out.artists = work.artistas;
    if (work.isrc) out.isrc = work.isrc;
    if (work.upc) out.upc = work.upc;
    if (work.tipo) out.kind = work.tipo === "album" ? "release" : "track";
    if (work.cita) out.cita = work.cita;
    if (work.pagina !== null) out.pagina = work.pagina;
    return out;
  });

// ------------------------------------------------------------- text focus

/** Words that usually open a list of works (annexes, repertoire, codes). */
const STRONG_HINTS = /anexo|repertorio|fonograma|isrc|upc|listado de (obras|canciones|temas)/gi;
const WEAK_HINTS = /\bobras?\b|canci[oó]n|grabaci[oó]n|m[aá]ster|[aá]lbum|sencillo|composici[oó]n|cat[aá]logo/gi;

export const WORKS_FOCUS = { head: 20_000, before: 400, after: 6_000 } as const;

type Range = [number, number];

function windows(source: string, pattern: RegExp): Range[] {
  const out: Range[] = [];
  for (const match of source.matchAll(pattern)) {
    const at = match.index ?? 0;
    const start = Math.max(0, at - WORKS_FOCUS.before);
    const end = Math.min(source.length, at + WORKS_FOCUS.after);
    const last = out[out.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

function lastMarkerBefore(source: string, index: number): string | null {
  const at = source.lastIndexOf("[[p. ", index);
  if (at < 0) return null;
  const end = source.indexOf("]]", at);
  return end > at ? source.slice(at, end + 2) : null;
}

/**
 * The part of a text worth reading for works: all of it when it fits the
 * budget; otherwise the opening plus the windows around annex/list words
 * (strong hints first), in text order, each opened with its page marker.
 */
export function worksFocus(source: string, budget: number): { text: string; excerpted: boolean } {
  if (source.length <= budget) return { text: source, excerpted: false };
  const picked: Range[] = [];
  let used = 0;
  const take = ([start, end]: Range) => {
    // Only the part not already picked counts against the budget
    for (const [s, e] of picked) {
      if (start >= s && start < e) start = e;
      if (end > s && end <= e) end = s;
    }
    if (end <= start || used >= budget) return;
    const stop = Math.min(end, start + (budget - used));
    picked.push([start, stop]);
    used += stop - start;
  };
  take([0, Math.min(WORKS_FOCUS.head, source.length)]);
  for (const range of windows(source, STRONG_HINTS)) take(range);
  for (const range of windows(source, WEAK_HINTS)) take(range);

  picked.sort((a, b) => a[0] - b[0]);
  const merged: Range[] = [];
  for (const range of picked) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  const pieces = merged.map(([start, end]) => {
    const piece = source.slice(start, end);
    const marker = start > 0 ? lastMarkerBefore(source, start) : null;
    return marker && !piece.trimStart().startsWith("[[p.") ? `${marker}\n${piece}` : piece;
  });
  return { text: pieces.join("\n[…]\n"), excerpted: true };
}

// ------------------------------------------------------------ match split

/** A work as the assistant proposes it for linking. */
export type ProposedWork = {
  title: string;
  artists?: string[];
  isrc?: string;
  upc?: string;
  kind?: "track" | "release";
  rights_type?: (typeof RIGHTS_TYPES)[number];
  evidence?: { quote?: string; page?: number | null };
};

export type WorkMatch = {
  work: ProposedWork;
  entity_type: "music_track" | "music_release";
  entity_id: string;
  title: string;
  artists?: string;
  path: string;
  confidence?: number;
  /** LINKED / SUGGESTED / DISMISSED when the pair already has a link */
  link_status?: string;
};

type Row = Record<string, unknown>;
const asRow = (value: unknown): Row | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : null;
const str = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
const listText = (value: unknown) =>
  Array.isArray(value) ? value.map(String).filter(Boolean).join(", ") || undefined : str(value);

/**
 * Splits Django's match answer into matched and unmatched works. Tolerant of
 * the answer's shape: {results|matches: [{index?, work?, match|candidate|
 * best|candidates[0]?, ...}]}, the candidate flat or under `entity`.
 */
export function splitMatches(
  works: readonly ProposedWork[],
  response: unknown,
  slug: string
): { matched: WorkMatch[]; unmatched: { work: ProposedWork }[] } {
  const body = asRow(response) ?? {};
  // Django answers {matched: [{index, entity_type, entity_id, …}], unmatched}; older shapes kept
  const rows = (
    Array.isArray(body.matched)
      ? body.matched
      : Array.isArray(body.results)
        ? body.results
        : Array.isArray(body.matches)
          ? body.matches
          : []
  ) as unknown[];
  const matched: WorkMatch[] = [];
  const done = new Set<number>();
  rows.forEach((value, position) => {
    const row = asRow(value);
    if (!row) return;
    const index = typeof row.index === "number" ? row.index : position;
    const work = works[index];
    if (!work || done.has(index)) return;
    const candidates = Array.isArray(row.candidates) ? row.candidates : [];
    const candidate =
      asRow(row.match) ??
      asRow(row.candidate) ??
      asRow(row.best) ??
      asRow(candidates[0]) ??
      (row.entity_id ? row : null);
    const entityId = str(candidate?.entity_id);
    if (!candidate || !entityId) return;
    const entity = asRow(candidate.entity) ?? {};
    const entityType = candidate.entity_type === "music_release" ? "music_release" : "music_track";
    const confidence = Number(candidate.confidence);
    const status = str(candidate.link_status) ?? str(row.link_status) ?? str(row.existing_status);
    const result: WorkMatch = {
      work,
      entity_type: entityType,
      entity_id: entityId,
      title: str(candidate.title) ?? str(entity.title) ?? work.title,
      path:
        str(candidate.path) ??
        str(entity.path) ??
        `/${slug}/music?${entityType === "music_release" ? "release" : "track"}=${entityId}`,
    };
    const artists = listText(candidate.artists) ?? str(candidate.subtitle) ?? str(entity.subtitle);
    if (artists) result.artists = artists;
    if (Number.isFinite(confidence) && candidate.confidence !== null) result.confidence = confidence;
    if (status) result.link_status = status;
    matched.push(result);
    done.add(index);
  });
  const unmatched = works.flatMap((work, index) => (done.has(index) ? [] : [{ work }]));
  return { matched, unmatched };
}
