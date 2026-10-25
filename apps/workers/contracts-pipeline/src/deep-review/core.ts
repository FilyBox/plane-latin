/**
 * Deep review arithmetic, kept free of runtime imports so it can be tested
 * with node --test: estimates from text sizes, lanes, chunks and merging.
 */

/** Tokens per byte of extracted text. Measured 0.30 tokens per character on
 * Spanish contracts with DeepSeek V4's tokenizer (≈0.29 per byte); scanned
 * text carries more noise, so the range leans up. */
export const TOKENS_PER_BYTE = { low: 0.26, high: 0.34 } as const;

/** Instructions and question around each text. */
export const PROMPT_TOKENS = 700;
/** The JSON answer for one text, thinking off. */
export const OUTPUT_TOKENS = { low: 200, high: 600 } as const;

/** Texts above this go in chunks (~250k tokens each), well inside the 1M
 * context but short enough to keep the model's attention on the whole text. */
export const CHUNK_CHARS = 850_000;
export const CHUNK_OVERLAP = 5_000;
const CHUNK_BYTES = 870_000;

export type Price = { cacheHit: number; cacheMiss: number; output: number };
export type Range = { low: number; high: number };

export type DeepReviewEstimate = {
  count: number;
  total_bytes: number;
  chunks: number;
  lanes: number;
  tokens: Range;
  eta_minutes: Range;
  now_peak: boolean;
  /** When the next off-peak window starts (now if it already is) */
  next_off_peak: string | null;
  default_model: string;
  /** USD per model and time window */
  models: Record<string, { peak: Range; off_peak: Range }>;
};

export const chunkCount = (bytes: number) => Math.max(1, Math.ceil(bytes / CHUNK_BYTES));

const round = (value: number, digits = 4) => Math.round(value * 10 ** digits) / 10 ** digits;

/**
 * Cost and time ranges for reading texts of these sizes. `prices` are the
 * peak rates per model (off-peak is half).
 */
export function estimateDeepReview(
  sizes: readonly number[],
  prices: Record<string, Price>,
  options: { lanes: number; nowPeak: boolean; defaultModel: string; nextOffPeak?: string }
): DeepReviewEstimate {
  const totalBytes = sizes.reduce((sum, size) => sum + Math.max(0, size), 0);
  const chunks = sizes.reduce((sum, size) => sum + chunkCount(size), 0);
  const tokens = {
    low: totalBytes * TOKENS_PER_BYTE.low + chunks * PROMPT_TOKENS,
    high: totalBytes * TOKENS_PER_BYTE.high + chunks * PROMPT_TOKENS,
  };
  const output = { low: chunks * OUTPUT_TOKENS.low, high: chunks * OUTPUT_TOKENS.high };
  // The final pass reads the matches' reasons (thinking on): assume up to a
  // third match, ~150 tokens each.
  const synthesisInput = { low: 1_000, high: 1_000 + sizes.length * 0.34 * 150 };
  const synthesisOutput = { low: 1_500, high: 6_000 };

  const models: DeepReviewEstimate["models"] = {};
  for (const [model, price] of Object.entries(prices)) {
    // Every text differs, so only the shared instructions could hit the cache:
    // priced as cache misses.
    const usd = (bound: "low" | "high") =>
      ((tokens[bound] + synthesisInput[bound]) * price.cacheMiss +
        (output[bound] + synthesisOutput[bound]) * price.output) /
      1_000_000;
    const peak = { low: round(usd("low")), high: round(usd("high")) };
    models[model] = { peak, off_peak: { low: round(peak.low / 2), high: round(peak.high / 2) } };
  }

  // Seconds per call: a few to start plus prefill; lanes run side by side.
  const secondsFor = (size: number) => chunkCount(size) * 4 + (size * TOKENS_PER_BYTE.high) / 6_000;
  const perText = sizes.map(secondsFor);
  const lanes = Math.max(1, Math.min(options.lanes, sizes.length));
  const wall = Math.max(Math.max(0, ...perText), perText.reduce((sum, value) => sum + value, 0) / lanes) + 30;

  return {
    count: sizes.length,
    total_bytes: totalBytes,
    chunks,
    lanes,
    tokens: { low: Math.round(tokens.low), high: Math.round(tokens.high) },
    eta_minutes: { low: Math.max(1, Math.round((wall * 0.7) / 60)), high: Math.max(1, Math.ceil((wall * 1.5) / 60)) },
    now_peak: options.nowPeak,
    next_off_peak: options.nextOffPeak ?? null,
    default_model: options.defaultModel,
    models,
  };
}

/**
 * Splits contracts into lanes of about the same total size: largest first,
 * each to the lightest lane, so one lane does not get every 200-page contract.
 */
export function assignLanes(items: readonly { id: string; bytes: number }[], lanes: number): string[][] {
  const count = Math.max(1, Math.min(lanes, items.length));
  const buckets = Array.from({ length: count }, () => ({ bytes: 0, ids: [] as string[] }));
  for (const item of [...items].sort((a, b) => b.bytes - a.bytes)) {
    let lightest = buckets[0];
    for (const bucket of buckets) if (bucket.bytes < lightest.bytes) lightest = bucket;
    lightest.ids.push(item.id);
    lightest.bytes += item.bytes;
  }
  return buckets.map((bucket) => bucket.ids).filter((ids) => ids.length > 0);
}

/** The text in chunks with a small overlap, so a clause cut at a boundary
 * still appears whole in one of them. */
export function splitText(text: string, size = CHUNK_CHARS, overlap = CHUNK_OVERLAP): string[] {
  if (text.length <= size) return [text];
  const chunks: string[] = [];
  for (let start = 0; start < text.length; start += size - overlap) {
    chunks.push(text.slice(start, start + size));
    if (start + size >= text.length) break;
  }
  return chunks;
}

export type ChunkAnswer = {
  matches: boolean;
  confidence: number;
  reason: string;
  quote: string;
  start_date: string | null;
  end_date: string | null;
  effective_end_date: string | null;
  artists: string[];
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isoDate = (value: unknown) => (typeof value === "string" && ISO_DATE.test(value.trim()) ? value.trim() : null);

/** One chunk's JSON answer, with the model's Spanish keys normalized. */
export function parseChunkAnswer(raw: Record<string, unknown>): ChunkAnswer {
  const confidence = Number(raw.confianza ?? 0);
  return {
    matches: raw.coincide === true || raw.coincide === "true",
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(100, Math.round(confidence))) : 0,
    reason: String(raw.razon ?? "").slice(0, 1_000),
    quote: String(raw.cita ?? "").slice(0, 600),
    start_date: isoDate(raw.fechaInicio),
    end_date: isoDate(raw.fechaFin),
    effective_end_date: isoDate(raw.fechaFinEfectiva),
    artists: Array.isArray(raw.artistas) ? raw.artistas.map(String).filter(Boolean).slice(0, 20) : [],
  };
}

/** A contract matches when any chunk does; its reason and quote come from
 * the most confident matching chunk. */
export function mergeChunkAnswers(answers: readonly ChunkAnswer[]): ChunkAnswer {
  const matching = answers.filter((answer) => answer.matches);
  const best = [...(matching.length > 0 ? matching : answers)].sort((a, b) => b.confidence - a.confidence)[0];
  const first = <K extends "start_date" | "end_date" | "effective_end_date">(key: K) =>
    answers.find((answer) => answer[key])?.[key] ?? null;
  return {
    matches: matching.length > 0,
    confidence: best?.confidence ?? 0,
    reason: best?.reason ?? "",
    quote: best?.quote ?? "",
    start_date: first("start_date"),
    end_date: first("end_date"),
    effective_end_date: first("effective_end_date"),
    artists: [...new Set(answers.flatMap((answer) => answer.artists))].slice(0, 20),
  };
}
