/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * Tidying shared tags from the assistant: merge spelling variants into one
 * tag, or start an AI mapping of the whole workspace. Both are admin actions
 * that run only when the user confirms in the card, and both can be undone.
 */

import { useState } from "react";
import { makeAssistantToolUI } from "@assistant-ui/react";
import { ArrowDown, ArrowRight, Check, Merge, Sparkles, Undo2, X } from "lucide-react";
import useSWR, { mutate as mutateGlobal } from "swr";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TEntityName } from "@plane/types";
import { cn } from "@plane/utils";
import { ENTITY_ICONS, entityGroupKey } from "@/components/references/entity-meta";
import { taggingService } from "@/services/references.service";
import { AssistantLink, useAssistantNavigate } from "./links";
import { TraceLine } from "./steps";

const CARD = "min-w-0 rounded-lg border border-subtle bg-layer-1 p-3";

/** Outcome of a card, kept per tool call so a reopened chat shows it. */
function useRemembered<T extends object>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = sessionStorage.getItem(key);
      return stored ? (JSON.parse(stored) as T) : initial;
    } catch {
      return initial;
    }
  });
  const remember = (next: T) => {
    setValue(next);
    try {
      sessionStorage.setItem(key, JSON.stringify(next));
    } catch {
      // The outcome then lasts for this page only.
    }
  };
  return [value, remember] as const;
}

const refreshTags = () =>
  mutateGlobal((key) => Array.isArray(key) && /^(SHARED_TAG|TAGGING|FILE_TAG)/.test(String(key[0])));

function Counts({ counts }: { counts: Partial<Record<TEntityName, number>> }) {
  const { t } = useTranslation();
  const entries = Object.entries(counts) as [TEntityName, number][];
  if (entries.length === 0) return <span className="text-11 text-tertiary">{t("assistant.merge.empty_tag")}</span>;
  return (
    <span className="flex flex-wrap gap-x-2.5 gap-y-0.5">
      {entries.map(([name, count]) => {
        const Icon = ENTITY_ICONS[name];
        return (
          <span key={name} className="inline-flex items-center gap-1 text-11 text-tertiary">
            {Icon && <Icon className="size-3" aria-hidden />}
            {t(entityGroupKey(name))}
            <span className="text-secondary tabular-nums">{count}</span>
          </span>
        );
      })}
    </span>
  );
}

// ------------------------------------------------------------------ merge

type TTagSummary = {
  id: string;
  name: string;
  kind: string;
  counts: Partial<Record<TEntityName, number>>;
  total: number;
  path?: string;
};

type TMergeProposal = {
  keep?: TTagSummary;
  variants?: TTagSummary[];
  not_found?: string[];
  total_moved?: number;
  reason?: string;
  workspace_slug?: string;
  error?: string;
};

type TMergeState = { state: "idle" | "busy" | "merged" | "undone" | "discarded"; runId?: string };

export const MergeTagsCard = makeAssistantToolUI<Record<string, unknown>, TMergeProposal>({
  toolName: "propose_tag_merge",
  render: function MergeRender({ result, status, toolCallId }) {
    const { t } = useTranslation();
    const [outcome, remember] = useRemembered<TMergeState>(`assistant-merge:${toolCallId}`, { state: "idle" });
    if (status.type === "running" || !result) {
      return <TraceLine live icon={Merge} label={t("assistant.steps.propose_tag_merge.running")} />;
    }
    if (result.error || !result.keep || !result.variants?.length) {
      return <p className="text-12 text-tertiary">{result.error ?? t("assistant.merge.not_found")}</p>;
    }
    const { keep, variants } = result;
    const slug = result.workspace_slug!;

    const merge = async () => {
      remember({ state: "busy" });
      try {
        const run = await taggingService.merge(
          slug,
          keep.id,
          variants.map((tag) => tag.id)
        );
        remember({ state: "merged", runId: run.id });
        void refreshTags();
        setToast({ type: TOAST_TYPE.SUCCESS, title: t("assistant.merge.merged", { name: keep.name }) });
      } catch {
        remember({ state: "idle" });
        setToast({ type: TOAST_TYPE.ERROR, title: t("assistant.merge.failed") });
      }
    };
    const undo = async () => {
      if (!outcome.runId) return;
      remember({ ...outcome, state: "busy" });
      try {
        await taggingService.act(slug, outcome.runId, "undo");
        remember({ state: "undone", runId: outcome.runId });
        void refreshTags();
        setToast({ type: TOAST_TYPE.SUCCESS, title: t("assistant.merge.undone") });
      } catch {
        remember({ state: "merged", runId: outcome.runId });
        setToast({ type: TOAST_TYPE.ERROR, title: t("assistant.merge.undo_failed") });
      }
    };

    const busy = outcome.state === "busy";
    return (
      <div className={CARD}>
        <div className="flex items-center gap-2">
          <Merge className="size-4 shrink-0 text-tertiary" aria-hidden />
          <p className="min-w-0 flex-1 truncate text-13 font-medium text-primary">{t("assistant.merge.title")}</p>
          <span className="shrink-0 text-12 text-tertiary">
            {t("assistant.merge.count", { count: variants.length })}
          </span>
        </div>
        {result.reason && <p className="mt-1 text-12 text-secondary">{result.reason}</p>}

        <ul className="mt-2.5 space-y-1.5">
          {variants.map((tag) => (
            <li key={tag.id} className="rounded-md bg-layer-2 px-2.5 py-1.5">
              <p
                className={cn(
                  "truncate text-12 font-medium",
                  outcome.state === "merged" ? "text-tertiary line-through decoration-1" : "text-primary"
                )}
              >
                {tag.name}
              </p>
              <Counts counts={tag.counts} />
            </li>
          ))}
        </ul>
        <ArrowDown className="mx-auto my-1 size-3.5 text-tertiary" aria-hidden />
        <div className="rounded-md border border-accent-strong/40 bg-accent-primary/5 px-2.5 py-1.5">
          <p className="truncate text-12 font-medium text-primary">
            {keep.path ? <AssistantLink href={keep.path}>{keep.name}</AssistantLink> : keep.name}
          </p>
          <Counts counts={keep.counts} />
          {outcome.state !== "merged" && (result.total_moved ?? 0) > 0 && (
            <p className="mt-0.5 text-11 text-tertiary">
              {t("assistant.merge.receives", { count: result.total_moved })}
            </p>
          )}
        </div>
        {(result.not_found?.length ?? 0) > 0 && (
          <p className="mt-1.5 text-11 text-tertiary">
            {t("assistant.merge.skipped", { names: result.not_found!.join(", ") })}
          </p>
        )}

        {outcome.state === "merged" || (busy && outcome.runId) ? (
          <div className="mt-2.5 flex items-center gap-2">
            <p className="flex min-w-0 flex-1 items-center gap-1.5 text-12 text-success-primary">
              <Check className="size-3.5 shrink-0" />
              <span className="truncate">{t("assistant.merge.merged", { name: keep.name })}</span>
            </p>
            <Button variant="secondary" size="sm" loading={busy} onClick={() => void undo()}>
              <Undo2 className="size-3" />
              {t("assistant.merge.undo")}
            </Button>
          </div>
        ) : outcome.state === "undone" || outcome.state === "discarded" ? (
          <p className="mt-2.5 flex items-center gap-1.5 text-12 text-tertiary">
            <X className="size-3.5" />
            {t(outcome.state === "undone" ? "assistant.merge.undone" : "assistant.merge.discarded")}
          </p>
        ) : (
          <>
            <p className="mt-2.5 text-11 text-tertiary">{t("assistant.merge.note")}</p>
            <div className="mt-2 flex justify-end gap-1.5">
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => remember({ state: "discarded" })}>
                {t("assistant.merge.discard")}
              </Button>
              <Button variant="primary" size="sm" loading={busy} onClick={() => void merge()}>
                {t("assistant.merge.approve")}
              </Button>
            </div>
          </>
        )}
      </div>
    );
  },
});

// ---------------------------------------------------------------- mapping

type TMappingPlan = { types?: TEntityName[]; review_path?: string; workspace_slug?: string; error?: string };

export const StartTagMappingCard = makeAssistantToolUI<Record<string, unknown>, TMappingPlan>({
  toolName: "start_tag_mapping",
  render: function MappingRender({ result, status }) {
    const { t } = useTranslation();
    const navigate = useAssistantNavigate();
    const [starting, setStarting] = useState(false);
    const slug = result?.workspace_slug;
    const { data: overview, mutate } = useSWR(
      slug ? ["TAGGING_OVERVIEW", slug] : null,
      () => taggingService.overview(slug!),
      {
        // Follow a run while it works; stop once it waits for review.
        refreshInterval: (data) =>
          data?.runs.some((run) => run.status === "QUEUED" || run.status === "RUNNING") ? 4000 : 0,
      }
    );
    if (status.type === "running" || !result) {
      return <TraceLine live icon={Sparkles} label={t("assistant.steps.start_tag_mapping.running")} />;
    }
    if (result.error || !slug) return null;

    const types = (result.types ?? []).filter((name) => overview?.scannable.includes(name));
    const total = types.reduce((sum, name) => sum + (overview?.counts[name] ?? 0), 0);
    const active = overview?.runs.find((run) => ["QUEUED", "RUNNING", "REVIEW"].includes(run.status));
    const review = () => navigate(result.review_path ?? `/${slug}/tags?mapping=1`);

    const start = async () => {
      setStarting(true);
      try {
        await taggingService.start(slug, types);
        await mutate();
      } catch {
        setToast({ type: TOAST_TYPE.ERROR, title: t("assistant.mapping.start_failed") });
      } finally {
        setStarting(false);
      }
    };

    let body;
    if (!overview) {
      body = <p className="mt-2 text-12 text-tertiary">{t("assistant.mapping.loading")}</p>;
    } else if (active?.status === "REVIEW") {
      body = (
        <>
          <p className="mt-2 text-12 text-secondary">
            {t("assistant.mapping.ready", { tags: active.counts.tags, merges: active.counts.merges })}
          </p>
          <Button variant="primary" size="sm" className="mt-2.5 w-full" onClick={review}>
            {t("assistant.mapping.review")}
            <ArrowRight className="size-3.5" />
          </Button>
        </>
      );
    } else if (active) {
      const done = Number(active.progress.done ?? 0);
      const all = Number(active.progress.total ?? 0);
      const percent = all > 0 ? Math.min(100, Math.round((done / all) * 100)) : 0;
      body = (
        <>
          <p className="mt-2 text-12 text-secondary">{t("assistant.mapping.running", { done, total: all })}</p>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-layer-2">
            <div
              className="h-full rounded-full bg-accent-primary transition-[width]"
              style={{ width: `${percent}%` }}
            />
          </div>
          <p className="mt-1.5 text-11 text-tertiary">{t("assistant.mapping.running_note")}</p>
        </>
      );
    } else {
      body = (
        <>
          <ul className="mt-2.5 divide-y divide-subtle rounded-md border border-subtle">
            {types.map((name) => {
              const Icon = ENTITY_ICONS[name];
              return (
                <li key={name} className="flex items-center gap-2 px-2.5 py-1.5 text-12">
                  {Icon && <Icon className="size-3.5 text-tertiary" aria-hidden />}
                  <span className="flex-1 text-primary">{t(entityGroupKey(name))}</span>
                  <span className="text-tertiary tabular-nums">{overview.counts[name] ?? 0}</span>
                </li>
              );
            })}
          </ul>
          <p className="mt-2 text-11 text-tertiary">{t("assistant.mapping.note")}</p>
          <Button
            variant="primary"
            size="sm"
            className="mt-2.5 w-full"
            loading={starting}
            disabled={types.length === 0 || total === 0}
            onClick={() => void start()}
          >
            <Sparkles className="size-3.5" />
            {t("assistant.mapping.start", { count: total })}
          </Button>
        </>
      );
    }

    return (
      <div className={CARD}>
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 shrink-0 text-tertiary" aria-hidden />
          <p className="min-w-0 flex-1 truncate text-13 font-medium text-primary">{t("assistant.mapping.title")}</p>
        </div>
        {body}
      </div>
    );
  },
});
