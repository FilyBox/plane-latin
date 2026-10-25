/**
 * Turns the names of things the assistant looked up into mentions before a
 * page is proposed, so a table of contracts reads as chips the user can open
 * even when the model wrote plain titles (or a mention with a made-up id).
 *
 * Only names the conversation actually returned are linked, and only when a
 * name points to exactly one item: a title shared by two contracts stays text.
 */

export type KnownEntity = { kind: string; id: string; names: string[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The server's mention syntax, plus the loose variants models write ({name="id"}, spaces). */
const LOOSE_MENTION = /:([a-z_]{2,20})\[([^\]\n]{1,300})\]\{\s*name\s*=\s*["']?([^"'}\s]{1,80})["']?\s*\}/g;
/** Spans never touched: mentions, markdown links, inline code and bare URLs. */
const PROTECTED = new RegExp(`${LOOSE_MENTION.source}|\\[[^\\]\\n]*\\]\\([^)\\s]*\\)|\`[^\`\\n]*\`|https?://\\S+`, "g");
/** Where an item's kind can be read from its link, for rows that only carry a path. */
const PATH_KINDS: [RegExp, string][] = [
  [/[?&]track=/, "music_track"],
  [/[?&]release=/, "music_release"],
  [/[?&]expense=/, "expense"],
  [/contracts.*[?&]peek=/, "contract"],
];
const MAX_LABEL = 160;

const fold = (value: string) => value.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const str = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
/** A mention label can't hold "]", "|" (table cells) or line breaks. */
const label = (value: string) =>
  value.replace(/\]/g, ")").replace(/\|/g, "/").replace(/\s+/g, " ").trim().slice(0, MAX_LABEL);

function entityOf(node: Record<string, unknown>, kinds: Set<string>): KnownEntity | null {
  const contractId = str(node.contract_id);
  if (contractId && UUID.test(contractId)) {
    const names = [str(node.titulo), str(node.title), str(node.file_name)].filter((n): n is string => !!n);
    return names.length ? { kind: "contract", id: contractId, names } : null;
  }
  const id = str(node.id);
  if (!id || !UUID.test(id)) return null;
  const names = [str(node.title), str(node.name), str(node.titulo), str(node.label), str(node.file_name)].filter(
    (n): n is string => !!n
  );
  if (!names.length) return null;
  const declared = str(node.entity_name) ?? str(node.type);
  if (declared && kinds.has(declared)) return { kind: declared, id, names };
  const path = str(node.path);
  const fromPath = path ? PATH_KINDS.find(([pattern]) => pattern.test(path))?.[1] : undefined;
  return fromPath && kinds.has(fromPath) ? { kind: fromPath, id, names } : null;
}

/** Every item with a real id and a name found anywhere in the given values (tool outputs, mentions). */
export function collectEntities(sources: unknown[], kinds: readonly string[]): KnownEntity[] {
  const allowed = new Set(kinds);
  const found = new Map<string, KnownEntity>();
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number) => {
    if (!value || typeof value !== "object" || depth > 12 || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    const node = value as Record<string, unknown>;
    const entity = entityOf(node, allowed);
    if (entity) {
      const key = `${entity.kind}:${entity.id.toLowerCase()}`;
      const previous = found.get(key);
      if (previous) previous.names = [...new Set([...previous.names, ...entity.names])];
      else found.set(key, entity);
    }
    for (const child of Object.values(node)) visit(child, depth + 1);
  };
  for (const source of sources) visit(source, 0);
  return [...found.values()];
}

/** Rewrites plain names into mentions and repairs mentions whose id the conversation never returned. */
export function linkMentions(markdown: string, entities: KnownEntity[]): { markdown: string; linked: number } {
  if (!markdown || !entities.length) return { markdown, linked: 0 };

  // name → the one item it names (names shared by several items are dropped)
  const byName = new Map<string, KnownEntity | null>();
  const known = new Set<string>();
  for (const entity of entities) {
    known.add(entity.id.toLowerCase());
    for (const name of entity.names) {
      const key = fold(name);
      // Too short or without letters: would match ordinary words or numbers
      if (key.length < 6 || !/\p{L}/u.test(key)) continue;
      const current = byName.get(key);
      byName.set(key, current === undefined || current?.id === entity.id ? entity : null);
    }
  }
  const names = [...byName.entries()].filter(([, entity]) => entity).map(([name]) => name);
  let linked = 0;

  // 1) Mentions: canonical syntax, and a matching item's id when the written one is unknown
  let out = markdown.replace(LOOSE_MENTION, (_match, kind: string, text: string, rawId: string) => {
    let finalId = rawId.trim().toLowerCase();
    if (!known.has(finalId)) {
      const match = byName.get(fold(text));
      if (match && match.kind === kind) {
        finalId = match.id.toLowerCase();
        linked += 1;
      }
    }
    // A broken id ("3f2c…") would show the raw syntax: keep just the name
    if (!UUID.test(finalId)) return label(text);
    return `:${kind}[${label(text)}]{name=${finalId}}`;
  });
  if (!names.length) return { markdown: out, linked };

  // 2) Plain names outside protected spans, longest first so a longer title wins
  names.sort((a, b) => b.length - a.length);
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}])(?:${names.map((name) => escapeRegex(name).replace(/ /g, "\\s+")).join("|")})(?![\\p{L}\\p{N}])`,
    "giu"
  );
  const linkPlain = (segment: string) =>
    segment.replace(pattern, (text) => {
      const entity = byName.get(fold(text));
      if (!entity) return text;
      linked += 1;
      return `:${entity.kind}[${label(text)}]{name=${entity.id.toLowerCase()}}`;
    });
  let result = "";
  let last = 0;
  for (const match of out.matchAll(PROTECTED)) {
    result += linkPlain(out.slice(last, match.index)) + match[0];
    last = (match.index ?? 0) + match[0].length;
  }
  out = result + linkPlain(out.slice(last));

  // A chip needs no bold around it
  out = out.replace(/\*\*(:[a-z_]{2,20}\[[^\]\n]+\]\{name=[0-9a-f-]{36}\})\*\*/g, "$1");
  return { markdown: out, linked };
}
