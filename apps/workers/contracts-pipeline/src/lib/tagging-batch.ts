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

/** "A / B", "A - B", "A feat. B"…: several artists, never a spelling of one. */
const COLLABORATION = /\s[/&x-]\s|\/|\bfeat\b|\bft\b|\s+y\s+/i;
export const isCollaboration = (name: string) => COLLABORATION.test(name);

/** Letters and digits only, lowercase and without accents: "3ball Mty",
 * "3BallMTY" and "3-Ball MTY" share it. Two names with the same key are the
 * same name written differently. */
export const nameKey = (value: string) => fold(value).replace(/[^\p{L}\p{N}]+/gu, "");

/** The key without a leading article: "Los Tigres" and "Tigres". */
const looseKey = (value: string) => nameKey(fold(value).replace(/^(los|las|la|el|lo|the)\s+/, ""));

/** Edits (insert, delete, change, swap two neighbours) between `a` and `b`,
 * or `max + 1` as soon as it is clear there are more. */
export const editDistance = (a: string, b: string, max: number): number => {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (a === b) return 0;
  // Only cells within `max` of the diagonal can stay under the limit
  const far = max + 1;
  let before = Array.from({ length: b.length + 1 }, () => far);
  let previous = Array.from({ length: b.length + 1 }, (_, j) => (j <= max ? j : far));
  for (let i = 1; i <= a.length; i++) {
    const current = Array.from({ length: b.length + 1 }, () => far);
    if (i <= max) current[0] = i;
    let rowMin = far;
    for (let j = Math.max(1, i - max); j <= Math.min(b.length, i + max); j++) {
      let value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) value = Math.min(value, before[j - 2] + 1);
      current[j] = Math.min(value, far);
      rowMin = Math.min(rowMin, current[j]);
    }
    if (rowMin > max) return far;
    before = previous;
    previous = current;
  }
  return Math.min(previous[b.length], far);
};

/** Typos tolerated between two keys of this length: none for short names,
 * where one letter makes another artist ("Kany" / "Kanye"). */
const typoLimit = (length: number) => (length >= 9 ? 2 : length >= 6 ? 1 : 0);

/** Sorts indexes by the text each one has in `list` (plain code-unit order) */
const byText = (list: string[]) => (a: number, b: number) => (list[a] < list[b] ? -1 : list[a] > list[b] ? 1 : 0);

export type NameClusters = {
  /** Names with the same key: one name, no model needed */
  exact: string[][];
  /** Names that look alike (a typo, an article) and a person or the model
   * must confirm, largest first; each at most `maxCluster` names */
  review: string[][];
};

/**
 * Groups the names that may be one artist, without the model: identical keys
 * are certain; near keys (a typo or two, "Los X" / "X") are only candidates.
 * Near keys are found among neighbours in the list sorted by key and by the
 * key reversed, so a typo anywhere but at both ends is caught, in linear time.
 * Collaborations are never candidates of anyone.
 */
export const clusterNames = (names: string[], { window = 6, maxCluster = 25 } = {}): NameClusters => {
  // Every distinct spelling counts: "América Sierra" and "America Sierra"
  // may be two tags to join
  const unique = [...new Set(names.map((name) => name.trim()))].filter((name) => nameKey(name).length > 0);
  const keys = unique.map(nameKey);
  const parent = unique.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    while (parent[index] !== root) [parent[index], index] = [root, parent[index]];
    return root;
  };
  const union = (a: number, b: number) => {
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent[rb] = ra;
  };

  const exactByKey = new Map<string, string[]>();
  unique.forEach((name, index) => {
    const group = exactByKey.get(keys[index]);
    if (group) group.push(name);
    else exactByKey.set(keys[index], [name]);
  });
  const firstByKey = new Map<string, number>();
  keys.forEach((key, index) => {
    const first = firstByKey.get(key);
    if (first === undefined) firstByKey.set(key, index);
    else union(first, index);
  });

  const solo = unique.map((_, index) => index).filter((index) => !isCollaboration(unique[index]));
  const firstByLoose = new Map<string, number>();
  for (const index of solo) {
    const key = looseKey(unique[index]);
    if (key.length < 4) continue;
    const first = firstByLoose.get(key);
    if (first === undefined) firstByLoose.set(key, index);
    else union(first, index);
  }
  const reversed = keys.map((key) => [...key].reduceRight((text, char) => text + char, ""));
  for (const order of [[...solo].sort(byText(keys)), [...solo].sort(byText(reversed))]) {
    for (let p = 0; p < order.length; p++) {
      for (let q = p + 1; q < Math.min(order.length, p + 1 + window); q++) {
        const [a, b] = [order[p], order[q]];
        const limit = typoLimit(Math.min(keys[a].length, keys[b].length));
        if (limit > 0 && keys[a] !== keys[b] && editDistance(keys[a], keys[b], limit) <= limit) union(a, b);
      }
    }
  }

  const components = new Map<number, number[]>();
  unique.forEach((_, index) => {
    const root = find(index);
    const members = components.get(root);
    if (members) members.push(index);
    else components.set(root, [index]);
  });
  const review: string[][] = [];
  for (const members of components.values()) {
    if (new Set(members.map((index) => keys[index])).size < 2) continue;
    const sorted = members.sort(byText(keys)).map((index) => unique[index]);
    for (let start = 0; start < sorted.length; start += maxCluster)
      review.push(sorted.slice(start, start + maxCluster));
  }
  return {
    exact: [...exactByKey.values()].filter((group) => group.length > 1),
    review: review.sort((a, b) => b.length - a.length),
  };
};

/** Clusters packed into model calls of at most `maxNames` names each. */
export const packClusters = (clusters: string[][], maxNames = 150): string[][][] => {
  const calls: string[][][] = [];
  let current: string[][] = [];
  let size = 0;
  for (const cluster of clusters) {
    if (current.length > 0 && size + cluster.length > maxNames) {
      calls.push(current);
      current = [];
      size = 0;
    }
    current.push(cluster);
    size += cluster.length;
  }
  if (current.length > 0) calls.push(current);
  return calls;
};

/** Overlapping groups of names joined into one (each spelling as is). */
export const joinGroups = (groups: string[][]): string[][] => {
  const parent = new Map<string, string>();
  const spelling = new Map<string, string>();
  const find = (key: string): string => {
    let root = key;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(key, root);
    return root;
  };
  for (const group of groups) {
    const keys = group.map((name) => {
      const key = name.trim();
      if (!parent.has(key)) {
        parent.set(key, key);
        spelling.set(key, name);
      }
      return key;
    });
    for (const key of keys.slice(1)) {
      const [ra, rb] = [find(keys[0]), find(key)];
      if (ra !== rb) parent.set(rb, ra);
    }
  }
  const joined = new Map<string, string[]>();
  for (const key of parent.keys()) {
    const root = find(key);
    const members = joined.get(root);
    if (members) members.push(spelling.get(key)!);
    else joined.set(root, [spelling.get(key)!]);
  }
  return [...joined.values()].filter((group) => group.length > 1);
};

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
