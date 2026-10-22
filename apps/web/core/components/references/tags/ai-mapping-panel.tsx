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
import type { TEntityName, TTaggingRun, TTaggingTagProposal } from "@plane/types";
import { cn } from "@plane/utils";
import { PaymentsSidePanel } from "@/components/payments/side-panel";
import { taggingService } from "@/services/references.service";
import { ENTITY_ICONS, entityGroupKey, tagKindKey } from "../entity-meta";
import { TAG_KIND_ICONS } from "../shared-tag-chip";

type Props = { workspaceSlug: string; isOpen: boolean; onClose: () => void };

const itemKey = (entity: string, id: string) => `${entity}:${id}`;

/** Start an AI scan of contracts, files, work items and expenses, follow it,
 * then review what it proposes: nothing is tagged until it is applied. */
export function AIMappingPanel({ workspaceSlug, isOpen, onClose }: Props) {
  const { t } = useTranslation();
  const [types, setTypes] = useState<TEntityName[] | null>(null);
  const [starting, setStarting] = useState(false);
  const { data: overview, mutate } = useSWR(isOpen ? ["TAGGING_OVERVIEW", workspaceSlug] : null, () =>
    taggingService.overview(workspaceSlug)
  );
  const active = overview?.runs.find((run) => ["QUEUED", "RUNNING", "REVIEW"].includes(run.status));
  const history = (overview?.runs ?? []).filter((run) => run.id !== active?.id);
  const chosen = types ?? overview?.scannable ?? [];

  const start = async () => {
    setStarting(true);
    try {
      await taggingService.start(workspaceSlug, chosen);
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
      title={t("references.ai.title")}
      description={t("references.ai.description")}
    >
      <div className="flex min-h-0 flex-1 flex-col">
        {!overview ? (
          <Loader2 className="mx-auto my-10 size-5 animate-spin text-tertiary" />
        ) : active?.status === "REVIEW" ? (
          <Review workspaceSlug={workspaceSlug} runId={active.id} onDone={() => void mutate()} />
        ) : active ? (
          <Progress workspaceSlug={workspaceSlug} run={active} onUpdate={() => void mutate()} />
        ) : (
          <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-6 pb-6">
            <section className="space-y-3">
              <h3 className="text-13 font-medium text-primary">{t("references.ai.what")}</h3>
              <ul className="divide-y divide-subtle rounded-md border border-subtle">
                {overview.scannable.map((name) => {
                  const Icon = ENTITY_ICONS[name];
                  const checked = chosen.includes(name);
                  return (
                    <li key={name}>
                      <label className="flex cursor-pointer items-center gap-3 px-3 py-2.5">
                        <input
                          type="checkbox"
                          className="accent-accent-primary size-4"
                          checked={checked}
                          onChange={() =>
                            setTypes(checked ? chosen.filter((item) => item !== name) : [...chosen, name])
                          }
                        />
                        <Icon className="size-4 text-secondary" aria-hidden />
                        <span className="flex-1 text-13 text-primary">{t(entityGroupKey(name))}</span>
                        <span className="text-12 text-tertiary tabular-nums">{overview.counts[name] ?? 0}</span>
                      </label>
                    </li>
                  );
                })}
              </ul>
              <p className="text-12 text-tertiary">{t("references.ai.music_note")}</p>
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
              {t("references.ai.start", {
                count: chosen.reduce((sum, name) => sum + (overview.counts[name] ?? 0), 0),
              })}
            </Button>

            {history.length > 0 && (
              <section className="space-y-2">
                <h3 className="text-13 font-medium text-primary">{t("references.ai.history")}</h3>
                <ul className="divide-y divide-subtle rounded-md border border-subtle">
                  {history.map((run) => (
                    <li key={run.id} className="flex items-center gap-3 px-3 py-2">
                      <span className="min-w-0 flex-1">
                        <span className="block text-13 text-primary">
                          {t(`references.ai.status.${run.status.toLowerCase()}`)}
                          {run.scope.auto && <span className="text-tertiary"> · {t("references.ai.auto_label")}</span>}
                        </span>
                        <span className="block text-11 text-tertiary">
                          {new Date(run.created_at).toLocaleString()}
                          {run.status === "COMPLETED" &&
                            ` · ${t("references.ai.applied_count", { count: run.counts.applied_links })}`}
                          {run.error && ` · ${run.error}`}
                        </span>
                      </span>
                      {run.status === "COMPLETED" && (
                        <Button variant="secondary" size="base" onClick={() => void undo(run)}>
                          <Undo2 className="size-3" /> {t("references.ai.undo")}
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}
      </div>
    </PaymentsSidePanel>
  );
}

function Progress({ workspaceSlug, run, onUpdate }: { workspaceSlug: string; run: TTaggingRun; onUpdate: () => void }) {
  const { t } = useTranslation();
  const { data } = useSWR(["TAGGING_RUN", workspaceSlug, run.id], () => taggingService.getRun(workspaceSlug, run.id), {
    refreshInterval: 2500,
  });
  const current = data ?? run;
  useEffect(() => {
    if (current.status !== run.status) onUpdate();
  }, [current.status, run.status, onUpdate]);

  const total = Number(current.progress.total ?? 0);
  const done = Object.entries(current.progress)
    .filter(([key]) => key.startsWith("done_"))
    .reduce((sum, [, value]) => sum + Number(value), 0);
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const stage = String(current.progress.stage ?? "classify");

  return (
    <div className="space-y-4 px-6 py-4">
      <div className="flex items-center gap-2 text-13 text-primary">
        <Loader2 className="size-4 animate-spin text-secondary" />
        {t(stage === "normalize" ? "references.ai.normalizing" : "references.ai.reading", { done, total })}
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
      <p className="text-12 text-tertiary">{t("references.ai.can_close")}</p>
    </div>
  );
}

const tagId = (tag: TTaggingTagProposal) => `${tag.kind}:${tag.name}`;

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
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
  const approvedMerges = merges.filter((merge) => !rejectedMerges.has(merge.keep));
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
        {tags.length === 0 && merges.length === 0 && (
          <p className="py-10 text-center text-13 text-tertiary">{t("references.ai.nothing")}</p>
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
                <li key={merge.keep}>
                  <label className="grid cursor-pointer grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 px-3 py-2.5">
                    <input
                      type="checkbox"
                      className="accent-accent-primary row-span-2 mt-0.5 size-4"
                      checked={!rejectedMerges.has(merge.keep)}
                      onChange={() => toggle(setRejectedMerges, merge.keep)}
                    />
                    <span className="text-13 font-medium text-primary">{merge.keep}</span>
                    <span className="text-12 text-tertiary">
                      {t("references.ai.absorbs", { names: merge.variants.join(" · ") })}
                    </span>
                  </label>
                </li>
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
                            return (
                              <li key={key}>
                                <label className="flex cursor-pointer items-center gap-2 py-1 pr-3">
                                  <input
                                    type="checkbox"
                                    className="accent-accent-primary size-3.5"
                                    checked={!rejectedItems.has(key)}
                                    disabled={rejectedTags.has(id)}
                                    onChange={() => toggle(setRejectedItems, key)}
                                  />
                                  <Icon className="size-3.5 shrink-0 text-secondary" aria-hidden />
                                  <span className="min-w-0 flex-1">
                                    <span className="block truncate text-12 text-primary">{item.title || "—"}</span>
                                    {item.reason && (
                                      <span className="block truncate text-11 text-tertiary">{item.reason}</span>
                                    )}
                                  </span>
                                  <span className="shrink-0 text-11 text-tertiary tabular-nums">
                                    {Math.round(item.confidence * 100)}%
                                  </span>
                                </label>
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
