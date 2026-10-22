/**
 * AI mapping of a workspace into shared tags.
 *
 * One agent per kind of item runs in parallel (contracts, files, work items,
 * expenses), each paging through its items and classifying a batch per step.
 * A normalization pass then folds spelling variants of artist names together.
 * The result goes back to Django as proposals: nothing is tagged until a
 * person reviews and applies them.
 */

import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";

import { generateStructuredJson } from "../lib/ai";
import { internalApi } from "../lib/internal-api";
import { parseJsonResponse } from "../lib/json-repair";
import { CLASSIFY_KEYS, NORMALIZE_KEYS, TaggingItem, classifyPrompt, normalizePrompt } from "../tagging-prompts";

export type TaggingParams = {
  run_id: string;
  workspace_id: string;
  types: string[];
};

type Classified = {
  entity_name: string;
  id: string;
  title: string;
  tipo: string | null;
  artistas: string[];
  confianza: number;
  razon: string;
  tags: string[];
};

type ProposalItem = { entity_name: string; id: string; title: string; confidence: number; reason: string };
type TagProposal = { name: string; kind: "ARTIST" | "GROUP" | "PERSON" | "TYPE"; items: ProposalItem[] };
type MergeProposal = { keep: string; variants: string[]; reason: string };

const PAGE_SIZE = 40;
const MIN_CONFIDENCE = 0.5;
const NORMALIZE_CHUNK = 350;
const AI_RETRIES: WorkflowStepConfig = { retries: { limit: 2, delay: "10 seconds", backoff: "exponential" } };

/** "A / B", "A - B", "A feat. B"…: several artists, never a spelling of one. */
const COLLABORATION = /\s[/&x-]\s|\/|\bfeat\b|\bft\b|\s+y\s+/i;
const isCollaboration = (name: string) => COLLABORATION.test(name);

const fold = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/** Known names worth showing the model for this batch: those that occur in
 * it. Keeps the prompt short however large the catalog is. */
const namesInBatch = (known: string[], items: TaggingItem[], cap = 120) => {
  const haystack = fold(items.map((item) => `${item.title} ${item.text} ${item.tags.join(" ")}`).join(" | "));
  return known.filter((name) => name.length > 2 && haystack.includes(fold(name))).slice(0, cap);
};

export class TaggingWorkflow extends WorkflowEntrypoint<Env, TaggingParams> {
  async run(event: WorkflowEvent<TaggingParams>, step: WorkflowStep) {
    const { run_id: runId, workspace_id: workspaceId, types } = event.payload;
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
        const found: Classified[] = [];
        let offset = 0;
        let total = Infinity;
        let page = 0;
        /* eslint-disable no-await-in-loop -- pages are read in order: each tells how many remain */
        while (offset < total) {
          const batch = await step.do(`inventory ${entityType} ${page}`, async () =>
            api.taggingInventory(workspaceId, entityType, offset, PAGE_SIZE, runId)
          );
          total = batch.total;
          if (batch.results.length > 0) {
            const classified = await step.do(`classify ${entityType} ${page}`, AI_RETRIES, async () => {
              const { text, model } = await generateStructuredJson(this.env, {
                prompt: classifyPrompt(
                  entityType,
                  vocabulary,
                  namesInBatch(knownArtists, batch.results),
                  batch.results
                ),
                keys: CLASSIFY_KEYS,
                maxTokens: 4096,
              });
              const parsed = parseJsonResponse<{ items?: Partial<Classified>[] }>(text);
              const byId = new Map(batch.results.map((item) => [item.id, item]));
              return {
                model,
                items: (parsed.items ?? [])
                  .filter((row) => row.id && byId.has(String(row.id)))
                  .map((row) => {
                    const source = byId.get(String(row.id))!;
                    return {
                      entity_name: entityType,
                      id: source.id,
                      title: source.title,
                      tipo: row.tipo && vocabulary.includes(String(row.tipo)) ? String(row.tipo) : null,
                      artistas: Array.isArray(row.artistas)
                        ? row.artistas.map((name) => String(name).trim()).filter(Boolean)
                        : [],
                      confianza: Math.max(0, Math.min(1, Number(row.confianza ?? 0))),
                      razon: String(row.razon ?? "").slice(0, 160),
                      tags: source.tags,
                    } satisfies Classified;
                  }),
              };
            });
            found.push(...classified.items);
          }
          offset += PAGE_SIZE;
          page += 1;
          await step.do(`progress ${entityType} ${page}`, async () => {
            await api.taggingProgress(runId, {
              progress: { [`done_${entityType}`]: Math.min(offset, total), stage: "classify" },
            });
          });
        }
        /* eslint-enable no-await-in-loop */
        return found;
      };

      const scanned = (await Promise.all(types.map((entityType) => scan(entityType)))).flat();
      const confident = scanned.filter((item) => item.confianza >= MIN_CONFIDENCE);

      // ── Fold spelling variants of the same artist together ──────────────
      const proposedNames = [...new Set(confident.flatMap((item) => item.artistas))];
      const existingPeople = context.tags.filter((tag) => peopleKinds.has(tag.kind)).map((tag) => tag.name);
      const allNames = [...new Set([...proposedNames, ...existingPeople])].sort((a, b) =>
        fold(a).localeCompare(fold(b))
      );

      const groups: { canonico: string; variantes: string[] }[] = [];
      for (let index = 0, chunk = 0; index < allNames.length; index += NORMALIZE_CHUNK, chunk += 1) {
        const names = allNames.slice(index, index + NORMALIZE_CHUNK);
        if (names.length < 2) continue;
        // eslint-disable-next-line no-await-in-loop -- one chunk at a time keeps the AI provider under its rate limit
        const result = await step.do(`normalize ${chunk}`, AI_RETRIES, async () => {
          await api.taggingProgress(runId, { progress: { stage: "normalize" } });
          const { text } = await generateStructuredJson(this.env, {
            prompt: normalizePrompt(
              names,
              context.artists.filter((name) => names.some((n) => fold(n) === fold(name)))
            ),
            keys: NORMALIZE_KEYS,
            maxTokens: 4096,
          });
          const parsed = parseJsonResponse<{ grupos?: { canonico?: string; variantes?: string[] }[] }>(text);
          return (parsed.grupos ?? [])
            .filter((group) => group.canonico && Array.isArray(group.variantes) && group.variantes.length >= 1)
            .map((group) => ({
              canonico: String(group.canonico),
              variantes: [...new Set(group.variantes!.map(String))].filter(
                (name) => fold(name) !== fold(String(group.canonico))
              ),
            }))
            .filter((group) => group.variantes.length > 0);
        });
        groups.push(...result);
      }

      // ── Build proposals from step outputs only (deterministic) ──────────
      const existingByFold = new Map(context.tags.map((tag) => [fold(tag.name), tag]));
      const canonicalOf = new Map<string, string>();
      const merges: MergeProposal[] = [];
      for (const group of groups) {
        // Collaborations stay their own name, whatever the model grouped.
        const members = [group.canonico, ...group.variantes].filter(
          (name) => isCollaboration(name) === isCollaboration(group.canonico)
        );
        if (members.length < 2) continue;
        const existing = members.filter((name) => existingByFold.has(fold(name)));
        // The name to keep is the most established existing tag: the one tied
        // to the catalog, then the most used. The model's pick only breaks
        // ties, so a one-off typo never swallows a name used hundreds of times.
        const rank = (name: string) => {
          const tag = existingByFold.get(fold(name));
          return tag
            ? (tag.catalog ? 1_000_000 : 0) + (tag.usage ?? 0) + (fold(name) === fold(group.canonico) ? 0.5 : 0)
            : -1;
        };
        const keep = existing.length > 0 ? [...existing].sort((a, b) => rank(b) - rank(a))[0] : group.canonico;
        for (const name of members) canonicalOf.set(fold(name), keep);
        const variants = existing.filter((name) => fold(name) !== fold(keep));
        if (existingByFold.has(fold(keep)) && variants.length > 0) {
          merges.push({
            keep: existingByFold.get(fold(keep))!.name,
            variants: variants.map((name) => existingByFold.get(fold(name))!.name),
            reason: "Variantes del mismo nombre",
          });
        }
      }

      const tagMap = new Map<string, TagProposal>();
      const propose = (name: string, kind: TagProposal["kind"], item: Classified) => {
        const existing = existingByFold.get(fold(name));
        const label = existing?.name ?? name;
        // Already carries it: nothing to propose.
        if (item.tags.some((tag) => fold(tag) === fold(label))) return;
        const resolvedKind = (
          existing && (peopleKinds.has(existing.kind) || existing.kind === "TYPE") ? existing.kind : kind
        ) as TagProposal["kind"];
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
      }
      const tags = [...tagMap.values()].sort((a, b) => b.items.length - a.items.length);

      await step.do("save proposals", async () => {
        await api.taggingProgress(runId, {
          status: "REVIEW",
          provider: this.env.AI_PROVIDER || "deepseek",
          progress: { stage: "review", scanned: scanned.length },
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
