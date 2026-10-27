/**
 * AI mapping of a workspace into shared tags.
 *
 * One agent per kind of item runs in parallel (contracts, files, work items,
 * expenses and, when chosen, songs and releases), each paging through its
 * items and classifying a batch per step. Besides what an item is and whose
 * it is, an agent may pick existing workspace tags (projects, campaigns,
 * catalogs…) the item clearly belongs to — never new ones.
 * A normalization pass then folds spelling variants of artist names together.
 * The result goes back to Django as proposals: nothing is tagged until a
 * person reviews and applies them.
 */

import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";

import { generateStructuredJson } from "../lib/ai";
import { internalApi } from "../lib/internal-api";
import { parseJsonResponse } from "../lib/json-repair";
import {
  TagProposal,
  clusterNames,
  fitProposals,
  fold,
  isCollaboration,
  isSoftModelFailure,
  joinGroups,
  maxTokensFor,
  nameKey,
  namesInBatch,
  packClusters,
  pageSizeFor,
  pickOffered,
  salvageItems,
  splitInto,
  topicsForBatch,
} from "../lib/tagging-batch";
import { CLASSIFY_KEYS, NORMALIZE_KEYS, classifyPrompt, normalizePrompt } from "../tagging-prompts";

export type TaggingParams = {
  run_id: string;
  workspace_id: string;
  types: string[];
  /** "merge": only look for duplicated existing tags and propose joining
   * them ("Combinar con IA"); no item is read. */
  mode?: "map" | "merge";
};

type Classified = {
  entity_name: string;
  id: string;
  title: string;
  tipo: string | null;
  artistas: string[];
  /** Existing workspace tags (projects, campaigns…) the item belongs to */
  etiquetas: string[];
  confianza: number;
  razon: string;
  tags: string[];
};

type TagKind = "ARTIST" | "GROUP" | "PERSON" | "TYPE" | "CUSTOM";
type MergeName = { name: string; kind: string; usage: number };
type MergeProposal = { keep: string; variants: string[]; reason: string; details: MergeName[] };

const MIN_CONFIDENCE = 0.5;
/** Under Django's request body limit (DATA_UPLOAD_MAX_MEMORY_SIZE, 5 MB). */
const MAX_PROPOSALS_BYTES = 4_000_000;
/** Look-alike names per model call when joining spellings. */
const NORMALIZE_NAMES = 150;
/** How established a tag is: tied to the catalog first, then the most used. */
const rankTag = (tag: { catalog?: boolean; usage?: number }) => (tag.catalog ? 1_000_000 : 0) + (tag.usage ?? 0);
const AI_RETRIES: WorkflowStepConfig = { retries: { limit: 2, delay: "10 seconds", backoff: "exponential" } };

export class TaggingWorkflow extends WorkflowEntrypoint<Env, TaggingParams> {
  async run(event: WorkflowEvent<TaggingParams>, step: WorkflowStep) {
    const { run_id: runId, workspace_id: workspaceId } = event.payload;
    const mergeOnly = event.payload.mode === "merge";
    const types = mergeOnly ? [] : event.payload.types;
    const api = internalApi(this.env);

    try {
      const context = await step.do("context", async () => api.taggingContext(workspaceId));
      const peopleKinds = new Set(["ARTIST", "GROUP", "PERSON"]);
      const knownArtists = [
        ...new Set([
          ...context.artists,
          ...context.tags.filter((tag) => peopleKinds.has(tag.kind)).map((tag) => tag.name),
        ]),
      ];

      // One agent per kind of item, all running at once.
      const scan = async (entityType: string): Promise<Classified[]> => {
        const vocabulary = context.vocabulary[entityType] ?? [];
        const pageSize = pageSizeFor(entityType);
        const found: Classified[] = [];
        let unanswered = 0;
        let offset = 0;
        let total = Infinity;
        let page = 0;
        /* eslint-disable no-await-in-loop -- pages are read in order: each tells how many remain */
        while (offset < total) {
          const batch = await step.do(`inventory ${entityType} ${page}`, async () =>
            api.taggingInventory(workspaceId, entityType, offset, pageSize, runId)
          );
          total = batch.total;
          if (batch.results.length > 0) {
            const classified = await step.do(`classify ${entityType} ${page}`, AI_RETRIES, async () => {
              const topics = topicsForBatch(context.tags, batch.results, entityType);
              const byId = new Map(batch.results.map((item) => [item.id, item]));
              const answered = new Map<string, Partial<Classified>>();
              let model = "";
              // A cut-off or empty answer is not an outage: keep the rows that
              // came back complete and ask again only for the missing ones, in
              // halves and then quarters. Outages (HTTP errors) still throw so
              // the step retries.
              let pending = batch.results;
              for (let round = 0; round < 3 && pending.length > 0; round += 1) {
                for (const chunk of splitInto(pending, 2 ** round)) {
                  try {
                    // eslint-disable-next-line no-await-in-loop -- one call at a time keeps the provider under its rate limit
                    const result = await generateStructuredJson(this.env, {
                      prompt: classifyPrompt(
                        entityType,
                        vocabulary,
                        namesInBatch(knownArtists, chunk),
                        chunk,
                        topicsForBatch(context.tags, chunk, entityType)
                      ),
                      keys: CLASSIFY_KEYS,
                      maxTokens: maxTokensFor(entityType),
                      thinking: false,
                    });
                    model = result.model;
                    for (const row of salvageItems(result.text)) {
                      const id = String((row as Partial<Classified>).id ?? "");
                      if (id && byId.has(id)) answered.set(id, row as Partial<Classified>);
                    }
                  } catch (error) {
                    if (!isSoftModelFailure(error)) throw error;
                  }
                }
                pending = pending.filter((item) => !answered.has(item.id));
              }
              return {
                model,
                // Items the model never answered: skipped, counted in the run
                unanswered: pending.length,
                items: [...answered.entries()].map(([id, row]) => {
                  const source = byId.get(id)!;
                  return {
                    entity_name: entityType,
                    id: source.id,
                    title: source.title,
                    tipo: row.tipo && vocabulary.includes(String(row.tipo)) ? String(row.tipo) : null,
                    artistas: Array.isArray(row.artistas)
                      ? row.artistas.map((name) => String(name).trim()).filter(Boolean)
                      : [],
                    etiquetas: pickOffered(row.etiquetas, topics),
                    confianza: Math.max(0, Math.min(1, Number(row.confianza ?? 0))),
                    razon: String(row.razon ?? "").slice(0, 160),
                    tags: source.tags,
                  } satisfies Classified;
                }),
              };
            });
            unanswered += classified.unanswered;
            found.push(...classified.items);
          }
          offset += pageSize;
          page += 1;
          await step.do(`progress ${entityType} ${page}`, async () => {
            await api.taggingProgress(runId, {
              progress: {
                [`done_${entityType}`]: Math.min(offset, total),
                [`unanswered_${entityType}`]: unanswered,
                stage: "classify",
              },
            });
          });
        }
        /* eslint-enable no-await-in-loop */
        return found;
      };

      // A kind that keeps failing (e.g. the provider down for its pages)
      // doesn't sink the others: its error is recorded and the run goes on.
      const failedKinds: Record<string, string> = {};
      const scanSafely = async (entityType: string): Promise<Classified[]> => {
        try {
          return await scan(entityType);
        } catch (error) {
          failedKinds[entityType] = (error instanceof Error ? error.message : String(error)).slice(0, 200);
          return [];
        }
      };
      const scanned = (await Promise.all(types.map((entityType) => scanSafely(entityType)))).flat();
      if (types.length > 0 && Object.keys(failedKinds).length === types.length) {
        throw new Error(Object.values(failedKinds)[0] ?? "Every kind failed");
      }
      const confident = scanned.filter((item) => item.confianza >= MIN_CONFIDENCE);

      // ── Fold spelling variants of the same artist together ──────────────
      // Names that only differ in case, spaces, accents or punctuation are one
      // name: joined without the model. Names that merely look alike (a typo,
      // "Los X" / "X") go to the model in small sets, so only they cost a
      // call. Artists, groups and people are compared together, so an artist
      // and a group spelled differently still end up as one tag.
      const proposedNames = [...new Set(confident.flatMap((item) => item.artistas))];
      // Combining compares every existing tag, whatever its kind
      const existingPeople = context.tags
        .filter((tag) => mergeOnly || peopleKinds.has(tag.kind))
        .map((tag) => tag.name);
      const clusters = await step.do("cluster names", async () => clusterNames([...proposedNames, ...existingPeople]));
      const calls = packClusters(clusters.review, NORMALIZE_NAMES);
      await step.do("normalize start", async () => {
        await api.taggingProgress(runId, {
          progress: {
            stage: "normalize",
            names_total: proposedNames.length + existingPeople.length,
            normalize_done: 0,
            normalize_total: calls.length,
          },
        });
      });

      const groups: { canonico: string; variantes: string[] }[] = [];
      for (const [index, call] of calls.entries()) {
        const names = call.flat();
        // eslint-disable-next-line no-await-in-loop -- one call at a time keeps the AI provider under its rate limit
        const result = await step.do(`normalize ${index}`, AI_RETRIES, async () => {
          let parsed: { grupos?: { canonico?: string; variantes?: string[] }[] };
          try {
            const { text } = await generateStructuredJson(this.env, {
              prompt: normalizePrompt(
                call,
                context.artists.filter((name) => names.some((n) => nameKey(n) === nameKey(name))),
                mergeOnly ? "tags" : "artists"
              ),
              keys: NORMALIZE_KEYS,
              maxTokens: 4096,
              thinking: false,
            });
            parsed = parseJsonResponse<{ grupos?: { canonico?: string; variantes?: string[] }[] }>(text);
          } catch (error) {
            // An unusable answer only costs these look-alikes' merges
            if (!isSoftModelFailure(error)) throw error;
            console.warn(JSON.stringify({ message: "normalize answer unusable", run: runId, error: String(error) }));
            parsed = { grupos: [] };
          }
          // Only names that were asked about: the model can't add any.
          const asked = new Map(names.map((name) => [fold(name), name]));
          return (parsed.grupos ?? [])
            .filter((group) => group.canonico && Array.isArray(group.variantes))
            .map((group) => {
              const members = [String(group.canonico), ...group.variantes!.map(String)]
                .map((name) => asked.get(fold(name)))
                .filter((name): name is string => !!name);
              return { canonico: members[0], variantes: [...new Set(members.slice(1))] };
            })
            .filter((group) => group.canonico && group.variantes.length > 0);
        });
        groups.push(...result);
        // eslint-disable-next-line no-await-in-loop -- reports this call before the next one starts
        await step.do(`normalize progress ${index}`, async () => {
          await api.taggingProgress(runId, { progress: { stage: "normalize", normalize_done: index + 1 } });
        });
      }

      // ── Build proposals from step outputs only (deterministic) ──────────
      await step.do("saving start", async () => {
        await api.taggingProgress(runId, { progress: { stage: "save" } });
      });
      const existingByFold = new Map(context.tags.map((tag) => [fold(tag.name), tag]));
      // Tags may differ only in case ("3ball Mty" / "3Ball Mty"): each by its own name
      const existingByName = new Map(context.tags.map((tag) => [tag.name, tag]));
      // Same name written differently: the most established tag answers for it
      const existingByKey = new Map<string, (typeof context.tags)[number]>();
      for (const tag of context.tags) {
        const key = nameKey(tag.name);
        const current = existingByKey.get(key);
        if (key && (!current || rankTag(tag) > rankTag(current))) existingByKey.set(key, tag);
      }
      const existingTag = (name: string) => existingByFold.get(fold(name)) ?? existingByKey.get(nameKey(name));
      // How often the run read each spelling: breaks ties between new names
      const mentions = new Map<string, number>();
      for (const item of confident)
        for (const name of item.artistas) mentions.set(fold(name), (mentions.get(fold(name)) ?? 0) + 1);
      const modelPick = new Set(groups.map((group) => fold(group.canonico)));

      const canonicalOf = new Map<string, string>();
      const merges: MergeProposal[] = [];
      const memberGroups = joinGroups([
        ...clusters.exact,
        // Collaborations stay their own name, whatever the model grouped.
        ...groups.map((group) =>
          [group.canonico, ...group.variantes].filter(
            (name) => isCollaboration(name) === isCollaboration(group.canonico)
          )
        ),
      ]);
      for (const members of memberGroups) {
        // Every existing tag the group stands for, each once
        const existing = [
          ...new Map(
            members
              .map((name) => existingByName.get(name) ?? existingByFold.get(fold(name)))
              .filter((tag): tag is (typeof context.tags)[number] => !!tag)
              .map((tag) => [tag.name, tag])
          ).values(),
        ];
        // The name to keep is the most established existing tag: the one tied
        // to the catalog, then the most used. The model's pick only breaks
        // ties, so a one-off typo never swallows a name used hundreds of times.
        // Among new names: the model's pick, then the most read spelling,
        // then one written in mixed case over ALL CAPS.
        const newScore = (name: string) =>
          (modelPick.has(fold(name)) ? 1_000_000 : 0) +
          (mentions.get(fold(name)) ?? 0) * 10 +
          (name !== name.toUpperCase() ? 1 : 0);
        const keep =
          existing.length > 0
            ? [...existing].sort(
                (a, b) =>
                  rankTag(b) +
                  (modelPick.has(fold(b.name)) ? 0.5 : 0) -
                  (rankTag(a) + (modelPick.has(fold(a.name)) ? 0.5 : 0))
              )[0].name
            : [...members].sort((a, b) => newScore(b) - newScore(a))[0];
        for (const name of members) canonicalOf.set(fold(name), keep);
        const variants = existing.filter((tag) => tag.name !== keep);
        if (existing.length > 0 && variants.length > 0) {
          const keepTag = existing.find((tag) => tag.name === keep)!;
          merges.push({
            keep,
            variants: variants.map((tag) => tag.name),
            reason: "Variantes del mismo nombre",
            details: [keepTag, ...variants].map((tag) => ({ name: tag.name, kind: tag.kind, usage: tag.usage ?? 0 })),
          });
        }
      }

      const tagMap = new Map<string, TagProposal>();
      const propose = (name: string, kind: TagKind, item: Classified) => {
        const existing = existingTag(name);
        const label = existing?.name ?? name;
        // Already carries it: nothing to propose.
        if (item.tags.some((tag) => nameKey(tag) === nameKey(label))) return;
        const resolvedKind = (
          existing && (peopleKinds.has(existing.kind) || existing.kind === "TYPE") ? existing.kind : kind
        ) as TagKind;
        const key = `${resolvedKind}:${fold(label)}`;
        const entry = tagMap.get(key) ?? { name: label, kind: resolvedKind, items: [] };
        if (
          !entry.items.some(
            (existingItem) => existingItem.id === item.id && existingItem.entity_name === item.entity_name
          )
        ) {
          entry.items.push({
            entity_name: item.entity_name,
            id: item.id,
            title: item.title,
            confidence: item.confianza,
            reason: item.razon,
          });
        }
        tagMap.set(key, entry);
      };

      for (const item of confident) {
        if (item.tipo) propose(item.tipo, "TYPE", item);
        for (const artist of item.artistas) propose(canonicalOf.get(fold(artist)) ?? artist, "ARTIST", item);
        for (const topic of item.etiquetas) propose(topic, "CUSTOM", item);
      }
      // A catalog of thousands of songs can propose a lot: keep the handoff
      // under Django's body limit (reasons first, then the least confident).
      const fitted = fitProposals(
        [...tagMap.values()].sort((a, b) => b.items.length - a.items.length),
        MAX_PROPOSALS_BYTES
      );
      const tags = fitted.tags;

      await step.do("save proposals", async () => {
        await api.taggingProgress(runId, {
          status: "REVIEW",
          provider: this.env.AI_PROVIDER || "deepseek",
          progress: {
            stage: "review",
            scanned: scanned.length,
            dropped: fitted.dropped,
            failed_kinds: Object.keys(failedKinds).join(","),
          },
          proposals: { tags, merges },
        });
      });
      return { scanned: scanned.length, tags: tags.length, merges: merges.length };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await step.do("report failure", async () => {
        await api.taggingProgress(runId, { status: "FAILED", error: message.slice(0, 500) });
      });
      throw error;
    }
  }
}
