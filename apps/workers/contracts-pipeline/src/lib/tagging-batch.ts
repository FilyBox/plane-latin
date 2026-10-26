/**
 * Pure helpers of the AI tag mapping (see workflows/tagging.ts), unit tested
 * without the model: how many items go in one call, which known names and
 * existing tags each call is shown, how the model's picks are checked against
 * them, and how the proposals are kept small enough to hand back to Django.
 */

import type { TaggingItem } from "../tagging-prompts";

/** Songs and releases: opt-in kinds, read in bigger pages. */
export const MUSIC_KINDS = new Set(["music_track", "music_release"]);

/** Items per page, and per model call. A song or release is one short line,
 * so a call takes more of them; documents carry longer summaries. Django
 * serves at most 100 per page. */
export const pageSizeFor = (entityType: string) => (MUSIC_KINDS.has(entityType) ? 40 : 20);

/** Room for one answer row per item (id, artists, tags, a short reason) with
 * margin: an answer that hits the limit comes back cut off, or empty in
 * DeepSeek's JSON mode. */
export const maxTokensFor = (_entityType: string) => 8192;

/** Splits a batch the model couldn't answer into `parts` smaller ones. */
export const splitInto = <T>(items: T[], parts: number): T[][] => {
  const size = Math.max(1, Math.ceil(items.length / Math.max(1, parts)));
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
};

/** The complete rows of a `{"items": [...]}` answer, even when it was cut off
 * mid-row (`..."confianza":}`): every `{...}` inside the array that parses on
 * its own is kept, the broken tail is dropped. */
export const salvageItems = (text: string): Record<string, unknown>[] => {
  if (!text) return [];
  try {
    const whole = JSON.parse(text) as { items?: unknown };
    if (Array.isArray(whole.items))
      return whole.items.filter((row) => row && typeof row === "object") as Record<string, unknown>[];
  } catch {
    // cut off: walk the array below
  }
  const start = text.indexOf("[", Math.max(0, text.indexOf('"items"')));
  if (start < 0) return [];
  const rows: Record<string, unknown>[] = [];
  let depth = 0;
  let rowStart = -1;
  let inString = false;
  let escape = false;
  for (let index = start + 1; index < text.length; index++) {
    const ch = text[index];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") {
      if (depth === 0) rowStart = index;
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0 && rowStart >= 0) {
        try {
          const row = JSON.parse(text.slice(rowStart, index + 1)) as unknown;
          if (row && typeof row === "object") rows.push(row as Record<string, unknown>);
        } catch {
          // a malformed row: skip it, keep the rest
        }
        rowStart = -1;
      }
      if (depth < 0) break;
    } else if (ch === "]" && depth === 0) break;
  }
  return rows;
};

/** Answers the model may give back that are worth retrying on a smaller
 * batch, not an outage: empty content or JSON it couldn't finish. */
export const isSoftModelFailure = (error: unknown) =>
  /empty response|did not return content|JSON|Unexpected token|Unterminated|Expected/i.test(
    error instanceof Error ? error.message : String(error)
  );

export const fold = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/** Folded, with every run of non-letters as one space and a space at each
 * end, so " name " only matches whole words. */
const words = (value: string) =>
  ` ${fold(value)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()} `;

/** Known names worth showing the model for this batch: those that occur in
 * it. Keeps the prompt short however large the catalog is. */
export const namesInBatch = (known: string[], items: TaggingItem[], cap = 120) => {
  const haystack = fold(items.map((item) => `${item.title} ${item.text} ${item.tags.join(" ")}`).join(" | "));
  return known.filter((name) => name.length > 2 && haystack.includes(fold(name))).slice(0, cap);
};

export type TopicTag = { name: string; kind: string; usage?: number };

const PEOPLE_AND_TYPES = new Set(["ARTIST", "GROUP", "PERSON", "TYPE"]);

/**
 * Existing tags that are neither people nor types — projects, campaigns,
 * catalogs… — the model may pick for this batch: the ones named (as whole
 * words) in its items, and for songs and releases also the most used ones,
 * since a campaign or catalog rarely appears word for word in a song's line.
 * Never more than `inText` + `popular` names, however many tags exist.
 */
export const topicsForBatch = (
  tags: TopicTag[],
  items: TaggingItem[],
  entityType: string,
  { inText = 80, popular = 60 }: { inText?: number; popular?: number } = {}
): string[] => {
  const topics = tags.filter((tag) => !PEOPLE_AND_TYPES.has(tag.kind) && fold(tag.name).length > 2);
  const haystack = words(items.map((item) => `${item.title} ${item.text}`).join(" | "));
  const named = topics.filter((tag) => haystack.includes(words(tag.name))).slice(0, inText);
  const chosen = new Map(named.map((tag) => [fold(tag.name), tag.name]));
  if (MUSIC_KINDS.has(entityType)) {
    const ranked = [...topics].sort((a, b) => (b.usage ?? 0) - (a.usage ?? 0) || a.name.localeCompare(b.name));
    for (const tag of ranked.slice(0, popular)) if (!chosen.has(fold(tag.name))) chosen.set(fold(tag.name), tag.name);
  }
  return [...chosen.values()];
};

/** The model's picks that are on the offered list, in the list's spelling:
 * anything else is dropped, so a run never invents a tag this way. */
export const pickOffered = (values: unknown, offered: string[]): string[] => {
  if (!Array.isArray(values) || offered.length === 0) return [];
  const byFold = new Map(offered.map((name) => [fold(name), name]));
  const picked = values.map((value) => byFold.get(fold(String(value)))).filter((name): name is string => !!name);
  return [...new Set(picked)];
};

export type ProposalItem = { entity_name: string; id: string; title: string; confidence: number; reason: string };
export type TagProposal = { name: string; kind: string; items: ProposalItem[] };

const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
/** One proposed (tag, item) pair. */
const key = (tag: TagProposal, item: ProposalItem) => `${tag.name}\u0000${tag.kind}|${item.entity_name}:${item.id}`;

/**
 * Keeps the proposals under `maxBytes` of JSON (Django refuses bodies over
 * its upload limit). First the reasons go, then the least confident items.
 * Returns how many items were dropped so the run can say so.
 */
export const fitProposals = (
  tags: TagProposal[],
  maxBytes: number
): { tags: TagProposal[]; dropped: number; trimmed: boolean } => {
  if (size(tags) <= maxBytes) return { tags, dropped: 0, trimmed: false };
  const bare = tags.map((tag) => ({ ...tag, items: tag.items.map((item) => ({ ...item, reason: "" })) }));
  const bareSize = size(bare);
  if (bareSize <= maxBytes) return { tags: bare, dropped: 0, trimmed: true };
  // Every item costs about the same once its reason is gone.
  const all = bare.flatMap((tag) => tag.items.map((item) => ({ key: key(tag, item), confidence: item.confidence })));
  const keep = Math.floor(all.length * (maxBytes / bareSize) * 0.95);
  const kept = new Set(
    all
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, keep)
      .map((entry) => entry.key)
  );
  const fitted = bare
    .map((tag) => ({ name: tag.name, kind: tag.kind, items: tag.items.filter((item) => kept.has(key(tag, item))) }))
    .filter((tag) => tag.items.length > 0);
  return { tags: fitted, dropped: all.length - kept.size, trimmed: true };
};
