/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { ChevronRight, Loader2, Merge, Sparkles, Undo2 } from "lucide-react";
import useSWR, { mutate as mutateGlobal } from "swr";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TEntityName, TTaggingMergeProposal, TTaggingRun, TTaggingTagProposal } from "@plane/types";
import { cn } from "@plane/utils";
import { isPeekKind } from "@/components/entity-peek/routes";
import { useEntityPeek } from "@/components/entity-peek/use-entity-peek";
import { PaymentsSidePanel } from "@/components/payments/side-panel";
import { taggingService } from "@/services/references.service";
import { ENTITY_ICONS, entityGroupKey, tagKindKey } from "../entity-meta";
import { TAG_KIND_ICONS } from "../shared-tag-chip";
import { MappingKindList, countMappingItems, initialMappingKinds } from "./mapping-kinds";

type Props = {
  workspaceSlug: string;
  isOpen: boolean;
  onClose: () => void;
  /** "merge": look for duplicated tags and propose joining them */
  mode?: "map" | "merge";
};

const itemKey = (entity: string, id: string) => `${entity}:${id}`;

/** Start an AI scan of contracts, files, work items and expenses (songs and
 * releases when ticked), follow it, then review what it proposes: nothing is
 * tagged until it is applied. */
export function AIMappingPanel({ workspaceSlug, isOpen, onClose, mode = "map" }: Props) {
  const { t } = useTranslation();
  const [types, setTypes] = useState<TEntityName[] | null>(null);
  const [starting, setStarting] = useState(false);
  const { data: overview, mutate } = useSWR(isOpen ? ["TAGGING_OVERVIEW", workspaceSlug] : null, () =>
    taggingService.overview(workspaceSlug)
  );
  // A run in progress shows whichever button opened the panel (one at a
  // time); a review waiting shows only under its own button.
  const active =
    overview?.runs.find((run) => ["QUEUED", "RUNNING"].includes(run.status)) ??
    overview?.runs.find((run) => run.status === "REVIEW" && (run.scope.mode === "merge") === (mode === "merge"));
  const history = (overview?.runs ?? []).filter((run) => run.id !== active?.id);
  const chosen = types ?? (overview ? initialMappingKinds(overview) : []);
  // A run already going decides what the panel shows, whichever button opened it
  const merging = active ? active.scope.mode === "merge" : mode === "merge";

  const start = async () => {
    setStarting(true);
    try {
      if (merging) await taggingService.startMerge(workspaceSlug);
      else await taggingService.start(workspaceSlug, chosen);
      await mutate();
    } catch {
      setToast({ type: TOAST_TYPE.ERROR, title: t("references.ai.start_failed") });
    } finally {
      setStarting(false);
    }
  };

  const undo = async (run: TTaggingRun) => {
    try {
      await taggingService.act(workspaceSlug, run.id, "undo");
      await mutate();
      void mutateGlobal((key) => Array.isArray(key) && String(key[0]).startsWith("SHARED_TAG"));
      setToast({ type: TOAST_TYPE.SUCCESS, title: t("references.ai.undone") });
    } catch {
      setToast({ type: TOAST_TYPE.ERROR, title: t("references.toasts.error") });
    }
  };

  return (
    <PaymentsSidePanel
      isOpen={isOpen}
      onClose={onClose}
      width="xl"
      title={t(merging ? "references.ai.merge_title" : "references.ai.title")}
      description={t(merging ? "references.ai.merge_description" : "references.ai.description")}
    >
      <div className="flex min-h-0 flex-1 flex-col">
        {!overview ? (
          <Loader2 className="mx-auto my-10 size-5 animate-spin text-tertiary" />
        ) : active?.status === "REVIEW" ? (
          <Review workspaceSlug={workspaceSlug} runId={active.id} onDone={() => void mutate()} />
        ) : active ? (
          <Progress workspaceSlug={workspaceSlug} run={active} onUpdate={() => void mutate()} />
        ) : merging ? (
          <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-6 pb-6">
            <section className="rounded-md bg-layer-1 p-3 text-12 text-secondary">
              <p>{t("references.ai.merge_how")}</p>
            </section>
            <Button variant="primary" size="lg" loading={starting} onClick={() => void start()}>
              <Merge className="size-3.5" />
              {t("references.ai.merge_start")}
            </Button>
            <RunHistory runs={history} onUndo={(run) => void undo(run)} />
          </div>
        ) : (
          <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-6 pb-6">
            <section className="space-y-3">
              <h3 className="text-13 font-medium text-primary">{t("references.ai.what")}</h3>
              <MappingKindList overview={overview} chosen={chosen} onChange={setTypes} />
              {overview.scannable.some((name) => name === "music_track" || name === "music_release") && (
                <p className="text-12 text-tertiary">{t("references.ai.music_note")}</p>
              )}
            </section>
            <section className="rounded-md bg-layer-1 p-3 text-12 text-secondary">
              <p>{t("references.ai.how")}</p>
            </section>
            <Button
              variant="primary"
              size="lg"
              loading={starting}
              disabled={chosen.length === 0}
              onClick={() => void start()}
            >
              <Sparkles className="size-3.5" />
              {t("references.ai.start", { count: countMappingItems(overview, chosen) })}
            </Button>

            <RunHistory runs={history} onUndo={(run) => void undo(run)} />
          </div>
        )}
      </div>
    </PaymentsSidePanel>
  );
}

/** Past runs, newest first, with undo for the applied ones. */
function RunHistory({ runs, onUndo }: { runs: TTaggingRun[]; onUndo: (run: TTaggingRun) => void }) {
  const { t } = useTranslation();
  const skippedNote = useSkippedNote();
  return (
    <>
      {runs.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-13 font-medium text-primary">{t("references.ai.history")}</h3>
          <ul className="divide-y divide-subtle rounded-md border border-subtle">
            {runs.map((run) => (
              <li key={run.id} className="flex items-center gap-3 px-3 py-2">
                <span className="min-w-0 flex-1">
                  <span className="block text-13 text-primary">
                    {t(`references.ai.status.${run.status.toLowerCase()}`)}
                    {run.scope.auto && <span className="text-tertiary"> · {t("references.ai.auto_label")}</span>}
                    {run.scope.mode === "merge" && (
                      <span className="text-tertiary"> · {t("references.ai.merge_label")}</span>
                    )}
                    {run.scope.source === "assistant" && (
                      <span className="text-tertiary"> · {t("references.ai.assistant_label")}</span>
                    )}
                  </span>
                  <span className="block text-11 text-tertiary">
                    {new Date(run.created_at).toLocaleString()}
                    {run.scope.merge
                      ? ` · ${t("references.ai.merge_summary", {
                          variants: run.scope.merge.variants.join(", "),
                          keep: run.scope.merge.keep,
                        })}`
                      : run.status === "COMPLETED" &&
                        (run.scope.mode === "merge"
                          ? ` · ${t("references.ai.merged_count", { count: run.counts.applied_merges ?? 0 })}`
                          : ` · ${t("references.ai.applied_count", { count: run.counts.applied_links })}`)}
                    {run.error && ` · ${run.error}`}
                    {run.scope.skipped && run.scope.skipped.length > 0 && ` · ${skippedNote(run)}`}
                  </span>
                </span>
                {run.status === "COMPLETED" && (
                  <Button variant="secondary" size="base" onClick={() => onUndo(run)}>
                    <Undo2 className="size-3" /> {t("references.ai.undo")}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

/** Items the model never answered, after retrying them in smaller batches */
const unansweredCount = (run: TTaggingRun) =>
  Object.entries(run.progress)
    .filter(([key]) => key.startsWith("unanswered_"))
    .reduce((sum, [, value]) => sum + (Number(value) || 0), 0);

/** Kinds whose pages kept failing; the rest of the run went on */
const failedKinds = (run: TTaggingRun) =>
  String(run.progress.failed_kinds ?? "")
    .split(",")
    .filter(Boolean) as TEntityName[];

/** "Not reviewed: Songs, Releases…" for kinds a run had to leave out. */
function useSkippedNote() {
  const { t } = useTranslation();
  return (run: TTaggingRun) =>
    t("references.ai.skipped", {
      names: (run.scope.skipped ?? []).map((name) => t(entityGroupKey(name))).join(", "),
    });
}

/** part of whole, as a whole percent (0 when there is no whole yet) */
const share = (part: number, whole: number) => (whole > 0 ? Math.min(100, Math.round((part / whole) * 100)) : 0);

function Progress({ workspaceSlug, run, onUpdate }: { workspaceSlug: string; run: TTaggingRun; onUpdate: () => void }) {
  const { t } = useTranslation();
  const { data } = useSWR(["TAGGING_RUN", workspaceSlug, run.id], () => taggingService.getRun(workspaceSlug, run.id), {
    refreshInterval: 2500,
  });
  const current = data ?? run;
  const skippedNote = useSkippedNote();
  useEffect(() => {
    if (current.status !== run.status) onUpdate();
  }, [current.status, run.status, onUpdate]);

  const total = Number(current.progress.total ?? 0);
  const done = Object.entries(current.progress)
    .filter(([key]) => key.startsWith("done_"))
    .reduce((sum, [, value]) => sum + Number(value), 0);
  const stage = String(current.progress.stage ?? "classify");
  // Joining spellings: its own count of model calls, after reading is done
  const joinTotal = Number(current.progress.normalize_total ?? 0);
  const joinDone = Number(current.progress.normalize_done ?? 0);
  let percent = share(done, total);
  let label = t("references.ai.reading", { done, total });
  if (stage === "save") {
    percent = 100;
    label = t("references.ai.saving");
  } else if (stage === "normalize" && joinTotal > 0) {
    percent = share(joinDone, joinTotal);
    label = t("references.ai.normalizing_count", { done: Math.min(joinDone + 1, joinTotal), total: joinTotal });
  } else if (stage === "normalize") {
    // Until the looking-alike sets are counted, the bar waits at the start
    percent = current.progress.normalize_total === undefined ? 0 : 100;
    label = t("references.ai.normalizing");
  }

  return (
    <div className="space-y-4 px-6 py-4">
      <div className="flex items-center gap-2 text-13 text-primary">
        <Loader2 className="size-4 animate-spin text-secondary" />
        {label}
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-layer-3"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className="h-full rounded-full bg-accent-primary transition-[width]" style={{ width: `${percent}%` }} />
      </div>
      {stage === "normalize" && (
        <p className="text-12 text-secondary">
          {t(
            current.scope.mode === "merge" ? "references.ai.normalizing_help_tags" : "references.ai.normalizing_help",
            {
              count: Number(current.progress.names_total ?? 0),
            }
          )}
        </p>
      )}
      {current.scope.skipped && current.scope.skipped.length > 0 && (
        <p className="text-12 text-tertiary">{skippedNote(current)}</p>
      )}
      <p className="text-12 text-tertiary">{t("references.ai.can_close")}</p>
    </div>
  );
}

const tagId = (tag: TTaggingTagProposal) => `${tag.kind}:${tag.name}`;

type MergeEdit = { name: string; apart: string[] };

/** One proposed merge: the final name (editable) and the names it joins,
 * each with its kind and how many items carry it; unticking one leaves it
 * as its own tag. */
function MergeRow({
  merge,
  accepted,
  edit,
  onToggle,
  onEdit,
}: {
  merge: TTaggingMergeProposal;
  accepted: boolean;
  edit: MergeEdit;
  onToggle: () => void;
  onEdit: (edit: MergeEdit) => void;
}) {
  const { t } = useTranslation();
  const details = new Map((merge.details ?? []).map((detail) => [detail.name, detail]));
  const names = [merge.keep, ...merge.variants];
  const joined = names.filter((name) => !edit.apart.includes(name)).length;
  return (
    <li className="space-y-2 px-3 py-2.5">
      <div className="flex items-center gap-3">
        <input
          type="checkbox"
          aria-label={t("references.ai.merge_accept", { name: edit.name || merge.keep })}
          className="accent-accent-primary size-4 shrink-0"
          checked={accepted}
          onChange={onToggle}
        />
        <input
          value={edit.name}
          disabled={!accepted}
          onChange={(event) => onEdit({ ...edit, name: event.target.value })}
          aria-label={t("references.ai.merge_name")}
          placeholder={merge.keep}
          className="h-8 min-w-0 flex-1 rounded-md border border-subtle bg-transparent px-2 text-13 font-medium text-primary outline-none focus:border-accent-strong disabled:opacity-60"
        />
      </div>
      <ul className="flex flex-wrap gap-1.5 pl-7" aria-label={t("references.ai.merge_names")}>
        {names.map((name) => {
          const detail = details.get(name);
          const Icon = detail ? TAG_KIND_ICONS[detail.kind] : null;
          const included = !edit.apart.includes(name);
          return (
            <li key={name}>
              <label
                className={cn(
                  "flex cursor-pointer items-center gap-1.5 rounded-md border border-subtle px-2 py-1 text-12",
                  included ? "text-primary" : "text-tertiary line-through"
                )}
              >
                <input
                  type="checkbox"
                  className="accent-accent-primary size-3"
                  checked={included}
                  disabled={!accepted}
                  onChange={() =>
                    onEdit({
                      ...edit,
                      apart: included ? [...edit.apart, name] : edit.apart.filter((value) => value !== name),
                    })
                  }
                />
                {Icon && <Icon className="size-3 text-secondary" aria-hidden />}
                <span>{name}</span>
                {detail && <span className="text-tertiary tabular-nums">· {detail.usage}</span>}
              </label>
            </li>
          );
        })}
      </ul>
      {accepted && joined < 2 && (
        <p className="pl-7 text-11 text-warning-primary">{t("references.ai.merge_too_few")}</p>
      )}
    </li>
  );
}

/** Ticks or unticks one proposal in a set of rejected keys. */
const toggle = (setter: Dispatch<SetStateAction<Set<string>>>, key: string) =>
  setter((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });

function Review({ workspaceSlug, runId, onDone }: { workspaceSlug: string; runId: string; onDone: () => void }) {
  const { t } = useTranslation();
  const { data: run } = useSWR(["TAGGING_RUN", workspaceSlug, runId, "full"], () =>
    taggingService.getRun(workspaceSlug, runId)
  );
  const tags = useMemo(() => run?.proposals?.tags ?? [], [run]);
  const merges = useMemo(() => run?.proposals?.merges ?? [], [run]);
  // Everything starts accepted; a person unticks what is wrong.
  const [rejectedItems, setRejectedItems] = useState<Set<string>>(new Set());
  const [rejectedTags, setRejectedTags] = useState<Set<string>>(new Set());
  const [rejectedMerges, setRejectedMerges] = useState<Set<string>>(new Set());
  // Per merge (by its kept name): the final name and the names left apart
  const [mergeEdits, setMergeEdits] = useState<Record<string, MergeEdit>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const skippedNote = useSkippedNote();
  const { open: openPeek } = useEntityPeek();

  const groups = useMemo(() => {
    const order = ["ARTIST", "GROUP", "PERSON", "TYPE", "CUSTOM"] as const;
    return order
      .map((kind) => ({ kind, tags: tags.filter((tag) => tag.kind === kind) }))
      .filter((group) => group.tags.length > 0);
  }, [tags]);

  const approvedTags = tags
    .filter((tag) => !rejectedTags.has(tagId(tag)))
    .map((tag) => ({
      name: tag.name,
      kind: tag.kind,
      items: tag.items.filter((item) => !rejectedItems.has(`${tagId(tag)}|${itemKey(item.entity_name, item.id)}`)),
    }))
    .filter((tag) => tag.items.length > 0);
  const approvedMerges = merges.flatMap((merge) => {
    if (rejectedMerges.has(merge.keep)) return [];
    const edit = mergeEdits[merge.keep];
    const apart = new Set(edit?.apart ?? []);
    const joined = [merge.keep, ...merge.variants].filter((name) => !apart.has(name));
    if (joined.length < 2) return [];
    const [keep, ...variants] = joined;
    const name = (edit?.name ?? "").trim() || merge.keep;
    return [{ ...merge, keep, variants, ...(name !== keep ? { name } : {}) }];
  });
  const changeCount = approvedTags.reduce((sum, tag) => sum + tag.items.length, 0) + approvedMerges.length;

  const finish = async (action: "apply" | "discard") => {
    setBusy(true);
    try {
      if (action === "apply")
        await taggingService.apply(workspaceSlug, runId, { tags: approvedTags, merges: approvedMerges });
      else await taggingService.act(workspaceSlug, runId, "discard");
      void mutateGlobal((key) => Array.isArray(key) && String(key[0]).startsWith("SHARED_TAG"));
      setToast({
        type: TOAST_TYPE.SUCCESS,
        title: t(action === "apply" ? "references.ai.applied" : "references.ai.discarded"),
      });
      onDone();
    } catch {
      setToast({ type: TOAST_TYPE.ERROR, title: t("references.toasts.error") });
    } finally {
      setBusy(false);
    }
  };

  if (!run) return <Loader2 className="mx-auto my-10 size-5 animate-spin text-tertiary" />;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-6 pb-6">
        {run.scope.auto && (
          <p className="rounded-md bg-layer-1 p-3 text-12 text-secondary">
            {t("references.ai.auto_review", { count: run.scope.ids?.length ?? 0 })}
          </p>
        )}
        {run.scope.skipped && run.scope.skipped.length > 0 && (
          <p className="rounded-md bg-layer-1 p-3 text-12 text-secondary">{skippedNote(run)}</p>
        )}
        {Number(run.progress.dropped ?? 0) > 0 && (
          <p className="rounded-md bg-layer-1 p-3 text-12 text-secondary">
            {t("references.ai.dropped", { count: Number(run.progress.dropped) })}
          </p>
        )}
        {unansweredCount(run) > 0 && (
          <p className="rounded-md bg-layer-1 p-3 text-12 text-secondary">
            {t("references.ai.unanswered", { count: unansweredCount(run) })}
          </p>
        )}
        {failedKinds(run).length > 0 && (
          <p className="rounded-md bg-warning-subtle p-3 text-12 text-secondary">
            {t("references.ai.failed_kinds", {
              names: failedKinds(run)
                .map((name) => t(entityGroupKey(name)))
                .join(", "),
            })}
          </p>
        )}
        {tags.length === 0 && merges.length === 0 && (
          <p className="py-10 text-center text-13 text-tertiary">
            {t(run.scope.mode === "merge" ? "references.ai.merge_nothing" : "references.ai.nothing")}
          </p>
        )}

        {merges.length > 0 && (
          <section className="space-y-2">
            <h3 className="flex items-center gap-1.5 text-13 font-medium text-primary">
              <Merge className="size-4 text-secondary" aria-hidden />
              {t("references.ai.merges")}
            </h3>
            <p className="text-12 text-tertiary">{t("references.ai.merges_help")}</p>
            <ul className="divide-y divide-subtle rounded-md border border-subtle">
              {merges.map((merge) => (
                <MergeRow
                  key={merge.keep}
                  merge={merge}
                  accepted={!rejectedMerges.has(merge.keep)}
                  edit={mergeEdits[merge.keep] ?? { name: merge.keep, apart: [] }}
                  onToggle={() => toggle(setRejectedMerges, merge.keep)}
                  onEdit={(edit) => setMergeEdits((current) => ({ ...current, [merge.keep]: edit }))}
                />
              ))}
            </ul>
          </section>
        )}

        {groups.map(({ kind, tags: items }) => {
          const KindIcon = TAG_KIND_ICONS[kind];
          return (
            <section key={kind} className="space-y-2">
              <h3 className="flex items-center gap-1.5 text-13 font-medium text-primary">
                <KindIcon className="size-4 text-secondary" aria-hidden />
                {t(tagKindKey(kind))}
              </h3>
              <ul className="divide-y divide-subtle rounded-md border border-subtle">
                {items.map((tag) => {
                  const id = tagId(tag);
                  const accepted = tag.items.filter(
                    (item) => !rejectedItems.has(`${id}|${itemKey(item.entity_name, item.id)}`)
                  ).length;
                  const isOpen = open === id;
                  return (
                    <li key={id}>
                      <div className="flex items-center gap-3 px-3 py-2">
                        <input
                          type="checkbox"
                          aria-label={tag.name}
                          className="accent-accent-primary size-4"
                          checked={!rejectedTags.has(id)}
                          onChange={() => toggle(setRejectedTags, id)}
                        />
                        <button
                          type="button"
                          onClick={() => setOpen(isOpen ? null : id)}
                          aria-expanded={isOpen}
                          className="flex min-w-0 flex-1 items-center gap-2 text-left"
                        >
                          <ChevronRight
                            className={cn(
                              "size-3.5 shrink-0 text-tertiary transition-transform",
                              isOpen && "rotate-90"
                            )}
                          />
                          <span className="truncate text-13 text-primary">{tag.name}</span>
                          <span className="ml-auto shrink-0 text-12 text-tertiary tabular-nums">
                            {accepted}/{tag.items.length}
                          </span>
                        </button>
                      </div>
                      {isOpen && (
                        <ul className="space-y-0.5 pb-2 pl-10">
                          {tag.items.map((item) => {
                            const key = `${id}|${itemKey(item.entity_name, item.id)}`;
                            const Icon = ENTITY_ICONS[item.entity_name];
                            const peekKind = isPeekKind(item.entity_name) ? item.entity_name : null;
                            // A contract, song, release or expense opens over the panel; the
                            // row's checkbox still decides whether it gets the tag.
                            const Row = peekKind ? "div" : "label";
                            return (
                              <li key={key}>
                                <Row className={cn("flex items-center gap-2 py-1 pr-3", !peekKind && "cursor-pointer")}>
                                  <input
                                    type="checkbox"
                                    aria-label={item.title || undefined}
                                    className="accent-accent-primary size-3.5"
                                    checked={!rejectedItems.has(key)}
                                    disabled={rejectedTags.has(id)}
                                    onChange={() => toggle(setRejectedItems, key)}
                                  />
                                  <Icon className="size-3.5 shrink-0 text-secondary" aria-hidden />
                                  <span className="min-w-0 flex-1">
                                    {peekKind ? (
                                      <button
                                        type="button"
                                        title={t("references.ai.open_item", { name: item.title || "—" })}
                                        onClick={() => openPeek({ kind: peekKind, id: item.id })}
                                        className="block max-w-full truncate text-left text-12 text-primary hover:underline"
                                      >
                                        {item.title || "—"}
                                      </button>
                                    ) : (
                                      <span className="block truncate text-12 text-primary">{item.title || "—"}</span>
                                    )}
                                    {item.reason && (
                                      <span className="block truncate text-11 text-tertiary">{item.reason}</span>
                                    )}
                                  </span>
                                  <span className="shrink-0 text-11 text-tertiary tabular-nums">
                                    {Math.round(item.confidence * 100)}%
                                  </span>
                                </Row>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
      <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-subtle bg-surface-1 px-6 py-3">
        <Button variant="secondary" size="lg" disabled={busy} onClick={() => void finish("discard")}>
          {t("references.ai.discard")}
        </Button>
        <Button
          variant="primary"
          size="lg"
          loading={busy}
          disabled={changeCount === 0}
          onClick={() => void finish("apply")}
        >
          {t("references.ai.apply", { count: changeCount })}
        </Button>
      </footer>
    </div>
  );
}
