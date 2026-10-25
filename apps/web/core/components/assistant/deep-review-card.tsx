/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * "Analyze every contract", from start to finish in one card: decide (how
 * many contracts, cost, when), follow it live (progress, spend, time left,
 * the over-estimate alert) and use the answer (summary, matches and the rest
 * in tabs, open, download, export, save as a page). The card lives in the
 * conversation, so reopening the chat shows the review where it is.
 */

import { useState } from "react";
import type { ReactNode } from "react";
import { makeAssistantToolUI } from "@assistant-ui/react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Download,
  FileSpreadsheet,
  FileText,
  Info,
  Mail,
  MessageSquare,
  ScanSearch,
  Square,
  Wallet,
} from "lucide-react";
import useSWR from "swr";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { Popover } from "@plane/propel/popover";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import { cn } from "@plane/utils";
import { downloadAssets } from "@/components/file-library/download";
import { assistantService } from "@/services/assistant.service";
import type { TDeepReview, TDeepReviewRow, TDeepReviewStatus } from "@/services/assistant.service";
import { CARD, errorText } from "./action-cards";
import { ACTIVE_REVIEW, FINISHED_REVIEW, clock, contractPath, duration, money, range } from "./deep-review-format";
import { DeepReviewProcess } from "./deep-review-process";
import { GenerationLoader } from "./elements/generation-loader";
import { formatTokenCount, mono, pct } from "./elements/surfaces";
import { AssistantLink } from "./links";
import { PageForm } from "./page-card";
import { TraceLine } from "./steps";

const ACTIVE = ACTIVE_REVIEW;
const FINISHED = FINISHED_REVIEW;
const PAGE_ROWS = 10;

function useReview(slug: string, reviewId: string) {
  return useSWR(["ASSISTANT_DEEP_REVIEW", slug, reviewId], () => assistantService.getDeepReview(slug, reviewId), {
    revalidateOnFocus: false,
    refreshInterval: (data) => (data && ACTIVE.has(data.status) ? 2500 : 0),
  });
}

function useBusy() {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await action();
    } catch (error) {
      setToast({ type: TOAST_TYPE.ERROR, title: errorText(error, t("assistant.actions.failed")) });
    } finally {
      setBusy(null);
    }
  };
  return [busy, run] as const;
}

// ------------------------------------------------------------------- pieces

const STATUS_TONE: Record<TDeepReviewStatus, string> = {
  DRAFT: "bg-layer-2 text-secondary",
  SCHEDULED: "bg-layer-2 text-secondary",
  RUNNING: "bg-accent-primary/10 text-accent-primary",
  PAUSED: "bg-warning-subtle text-warning-primary",
  STOPPING: "bg-accent-primary/10 text-accent-primary",
  SYNTHESIZING: "bg-accent-primary/10 text-accent-primary",
  COMPLETED: "bg-success-subtle text-success-primary",
  PARTIAL: "bg-warning-subtle text-warning-primary",
  FAILED: "bg-danger-subtle text-danger-primary",
  CANCELLED: "bg-layer-2 text-tertiary",
};

function StatusPill({ status }: { status: TDeepReviewStatus }) {
  const { t } = useTranslation();
  const live = status === "RUNNING" || status === "SYNTHESIZING" || status === "STOPPING";
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-11 font-medium",
        STATUS_TONE[status]
      )}
    >
      {live && <span className="size-1.5 animate-pulse rounded-full bg-current" aria-hidden />}
      {status === "COMPLETED" && <Check className="size-3" aria-hidden />}
      {t(`assistant.deep_review.status.${status.toLowerCase()}`)}
    </span>
  );
}

function Stat({ value, label, tone }: { value: ReactNode; label: string; tone?: string }) {
  return (
    <div className="min-w-0 rounded-md bg-layer-2 px-2.5 py-2">
      <p className={cn("truncate text-14 font-semibold text-primary tabular-nums", tone)}>{value}</p>
      <p className="truncate text-11 text-tertiary">{label}</p>
    </div>
  );
}

function Criteria({ text }: { text: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const long = text.length > 160;
  return (
    <div className="mt-2 text-12 text-secondary">
      <p className={cn(!open && long && "line-clamp-2")}>
        <span className="text-tertiary">{t("assistant.deep_review.criteria")}: </span>
        {text}
      </p>
      {long && (
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="mt-0.5 text-11 text-accent-primary hover:underline"
        >
          {open ? t("assistant.deep_review.less") : t("assistant.deep_review.more")}
        </button>
      )}
    </div>
  );
}

function Hint({ icon: Icon, children }: { icon: typeof Mail; children: ReactNode }) {
  return (
    <p className="mt-2.5 flex items-start gap-1.5 text-11 leading-relaxed text-tertiary">
      <Icon className="mt-0.5 size-3 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

// ------------------------------------------------------------------- decide

function WindowOption({
  selected,
  onSelect,
  title,
  badge,
  cost,
  note,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  badge?: string;
  cost: string;
  note: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        "min-w-0 flex-1 rounded-md border px-2.5 py-2 text-left transition-colors",
        selected ? "border-accent-strong bg-accent-primary/5" : "border-subtle hover:bg-layer-1-hover"
      )}
    >
      <span className="flex items-center gap-1.5">
        <span
          className={cn(
            "flex size-3 shrink-0 items-center justify-center rounded-full border",
            selected ? "border-accent-strong" : "border-strong"
          )}
          aria-hidden
        >
          {selected && <span className="size-1.5 rounded-full bg-accent-primary" />}
        </span>
        <span className="text-12 font-medium text-primary">{title}</span>
        {badge && (
          <span className="ml-auto rounded-sm bg-success-subtle px-1 text-11 font-medium text-success-primary">
            {badge}
          </span>
        )}
      </span>
      <span className="mt-1 block text-13 font-semibold text-primary tabular-nums">{cost}</span>
      <span className="block truncate text-11 text-tertiary">{note}</span>
    </button>
  );
}

function DecideView({
  slug,
  review,
  onChange,
}: {
  slug: string;
  review: TDeepReview;
  onChange: (next: TDeepReview) => void;
}) {
  const { t } = useTranslation();
  const [busy, run] = useBusy();
  const estimate = review.estimate;
  const models = Object.keys(estimate?.models ?? {});
  const [model, setModel] = useState(review.model || estimate?.default_model || models[0] || "");
  const [offPeak, setOffPeak] = useState(false);
  const { data: balance } = useSWR(["ASSISTANT_BALANCE", slug], () => assistantService.getBalance(slug), {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  });
  const prices = estimate?.models?.[model];
  const nowCost = estimate?.now_peak ? prices?.peak : prices?.off_peak;
  const chosen = offPeak ? prices?.off_peak : nowCost;
  const available = balance?.balances[0]?.total;
  const short = available !== undefined && chosen !== undefined && available < chosen.low;
  const count = estimate?.count ?? review.total_count;

  const start = () =>
    run("start", async () =>
      onChange(await assistantService.startDeepReview(slug, review.id, { model, off_peak: offPeak }))
    );

  return (
    <>
      <div className="mt-3 grid grid-cols-3 gap-1.5">
        <Stat value={count} label={t("assistant.deep_review.stat_contracts")} />
        <Stat
          value={`~${formatTokenCount(estimate?.tokens?.high ?? 0)}`}
          label={t("assistant.deep_review.stat_tokens")}
        />
        <Stat
          value={t("assistant.deep_review.minutes", { count: estimate?.eta_minutes?.high ?? 1 })}
          label={t("assistant.deep_review.stat_time")}
        />
      </div>

      {estimate?.now_peak ? (
        <div role="radiogroup" aria-label={t("assistant.deep_review.when")} className="mt-2 flex gap-1.5">
          <WindowOption
            selected={!offPeak}
            onSelect={() => setOffPeak(false)}
            title={t("assistant.deep_review.now")}
            cost={range(prices?.peak)}
            note={t("assistant.deep_review.peak_rate")}
          />
          <WindowOption
            selected={offPeak}
            onSelect={() => setOffPeak(true)}
            title={t("assistant.deep_review.off_peak")}
            badge="−50 %"
            cost={range(prices?.off_peak)}
            note={t("assistant.deep_review.starts_at", { time: clock(estimate.next_off_peak) })}
          />
        </div>
      ) : (
        <div className="mt-2 flex items-center justify-between gap-3 rounded-md border border-subtle px-2.5 py-2">
          <span className="text-12 text-secondary">{t("assistant.deep_review.estimated_cost")}</span>
          <span className="text-right">
            <span className="block text-13 font-semibold text-primary tabular-nums">{range(nowCost)}</span>
            <span className="block text-11 text-success-primary">{t("assistant.deep_review.off_peak_now")}</span>
          </span>
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-11 text-tertiary">
        {models.length > 1 ? (
          <label className="flex items-center gap-1">
            {t("assistant.deep_review.model")}
            <select
              value={model}
              onChange={(event) => setModel(event.target.value)}
              className="cursor-pointer rounded-sm bg-transparent py-0.5 text-11 text-secondary outline-none hover:bg-layer-1-hover"
            >
              {models.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span />
        )}
        {available !== undefined && (
          <span className={cn("flex items-center gap-1 tabular-nums", short && "text-danger-primary")}>
            <Wallet className="size-3" aria-hidden />
            {t("assistant.deep_review.balance", { amount: money(available) })}
          </span>
        )}
      </div>

      {short && (
        <p className="mt-2 flex items-start gap-1.5 rounded-md bg-danger-subtle px-2.5 py-1.5 text-11 text-danger-primary">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
          {t("assistant.deep_review.balance_short")}
        </p>
      )}

      <div className="mt-3 flex items-center gap-2">
        <Button size="sm" loading={busy === "start"} disabled={!!busy || short} onClick={() => void start()}>
          <ScanSearch className="size-3.5" />
          {offPeak
            ? t("assistant.deep_review.schedule", { time: clock(estimate?.next_off_peak) })
            : t("assistant.deep_review.run", { count })}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!!busy}
          onClick={() =>
            void run("cancel", async () => onChange(await assistantService.decideDeepReview(slug, review.id, "cancel")))
          }
        >
          {t("assistant.deep_review.cancel")}
        </Button>
      </div>
      <Hint icon={Info}>{t("assistant.deep_review.decide_hint")}</Hint>
    </>
  );
}

// ----------------------------------------------------------------- progress

function ProgressView({
  slug,
  review,
  onChange,
}: {
  slug: string;
  review: TDeepReview;
  onChange: (next: TDeepReview) => void;
}) {
  const { t } = useTranslation();
  const [busy, run] = useBusy();
  const decide = (action: "stop" | "continue") =>
    run(action, async () => onChange(await assistantService.decideDeepReview(slug, review.id, action)));

  if (review.status === "SCHEDULED") {
    return (
      <>
        <p className="mt-3 text-12 text-secondary">
          {t("assistant.deep_review.scheduled", { time: clock(review.estimate?.next_off_peak) })}
        </p>
        <div className="mt-2.5">
          <Button size="sm" variant="ghost" loading={busy === "stop"} onClick={() => void decide("stop")}>
            {t("assistant.deep_review.cancel")}
          </Button>
        </div>
        <Hint icon={Mail}>{t("assistant.deep_review.mail_hint")}</Hint>
      </>
    );
  }

  const share = pct(review.done_bytes, review.total_bytes);
  const settled = review.done_count + review.failed_count;
  const elapsed = review.started_at ? (Date.now() - new Date(review.started_at).getTime()) / 1000 : 0;
  const minutesLeft =
    review.status === "RUNNING" && review.done_bytes > 0 && elapsed > 15
      ? Math.max(1, Math.ceil((((review.total_bytes - review.done_bytes) / review.done_bytes) * elapsed) / 60))
      : null;
  const over =
    review.projection_usd && review.estimate_usd
      ? Math.round((review.projection_usd / review.estimate_usd - 1) * 100)
      : 0;
  const working = review.status === "RUNNING";

  return (
    <>
      <div className="mt-3 flex items-baseline justify-between gap-2">
        <p className="text-12 text-secondary">
          <span className="text-16 font-semibold text-primary tabular-nums">{settled}</span>
          <span className="text-tertiary tabular-nums"> / {review.total_count}</span>{" "}
          {t("assistant.deep_review.analyzed")}
        </p>
        <span className={cn(mono, "text-tertiary")}>{Math.round(share)} %</span>
      </div>
      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-layer-2">
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-700",
            review.status === "PAUSED" ? "bg-warning-primary" : "bg-accent-primary",
            working && "animate-pulse"
          )}
          style={{ width: `${Math.max(share, settled > 0 ? 2 : 0)}%` }}
        />
      </div>
      <div className="mt-2 grid grid-cols-3 gap-1.5">
        <Stat
          value={money(review.spent_usd)}
          label={t("assistant.deep_review.of_estimate", { estimate: money(review.estimate_usd) })}
        />
        <Stat
          value={minutesLeft ? t("assistant.deep_review.minutes", { count: minutesLeft }) : "—"}
          label={t("assistant.deep_review.left")}
        />
        <Stat
          value={review.failed_count}
          label={t("assistant.deep_review.errors")}
          tone={review.failed_count > 0 ? "text-danger-primary" : undefined}
        />
      </div>

      {review.status === "PAUSED" && (
        <div className="mt-2.5 rounded-md border border-warning-strong bg-warning-subtle px-2.5 py-2">
          <p className="flex items-center gap-1.5 text-12 font-medium text-warning-primary">
            <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
            {t("assistant.deep_review.over_title", { percent: over })}
          </p>
          <p className="mt-1 text-11 leading-relaxed text-secondary">
            {t("assistant.deep_review.over_body", {
              projection: money(review.projection_usd),
              estimate: money(review.estimate_usd),
            })}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" loading={busy === "stop"} disabled={!!busy} onClick={() => void decide("stop")}>
              {t("assistant.deep_review.answer_now")}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              loading={busy === "continue"}
              disabled={!!busy}
              onClick={() => void decide("continue")}
            >
              {t("assistant.deep_review.keep_going")}
            </Button>
          </div>
          <p className="mt-1.5 text-11 text-tertiary">{t("assistant.deep_review.over_timeout")}</p>
        </div>
      )}

      {working && (
        <div className="mt-2.5">
          <Button size="sm" variant="secondary" loading={busy === "stop"} onClick={() => void decide("stop")}>
            <Square className="size-3 fill-current" />
            {t("assistant.deep_review.stop")}
          </Button>
        </div>
      )}
      {review.status === "STOPPING" && (
        <GenerationLoader
          className="mt-2.5"
          label={
            review.pause_reason === "insufficient_balance"
              ? t("assistant.deep_review.no_balance")
              : t("assistant.deep_review.stopping")
          }
        />
      )}
      {review.status === "SYNTHESIZING" && (
        <GenerationLoader className="mt-2.5" label={t("assistant.deep_review.synthesizing")} />
      )}
      {(working || review.status === "PAUSED") && <Hint icon={Mail}>{t("assistant.deep_review.mail_hint")}</Hint>}
    </>
  );
}

// ------------------------------------------------------------------- result

function ResultRow({ slug, row }: { slug: string; row: TDeepReviewRow }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const dates = [row.start_date, row.effective_end_date ?? row.end_date].filter(Boolean).join(" → ");
  const meta = [row.artists.join(", "), dates].filter(Boolean).join(" · ");
  const expandable = Boolean(row.quote) || row.reason.length > 140;
  return (
    <li className="px-2.5 py-2">
      <div className="flex min-w-0 items-start gap-2">
        <div className="min-w-0 flex-1">
          <AssistantLink href={contractPath(slug, row.contract_id)} className="block truncate text-12 font-medium">
            {row.title}
          </AssistantLink>
          {meta && <p className={cn(mono, "mt-0.5 truncate text-tertiary")}>{meta}</p>}
        </div>
        {row.confidence !== null && (
          <span
            className={cn(mono, "shrink-0 rounded-sm bg-layer-2 px-1 py-0.5 text-tertiary")}
            title={t("assistant.deep_review.confidence")}
          >
            {row.confidence} %
          </span>
        )}
        {expandable && (
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            aria-label={t("assistant.deep_review.details")}
            className="shrink-0 rounded-sm p-0.5 text-tertiary hover:bg-layer-1-hover hover:text-secondary"
          >
            <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} aria-hidden />
          </button>
        )}
      </div>
      {row.reason && (
        <p className={cn("mt-1 text-11 leading-relaxed text-secondary", !open && "line-clamp-2")}>{row.reason}</p>
      )}
      {open && row.quote && (
        <p className="mt-1.5 border-s-2 border-accent-strong ps-2 text-11 leading-relaxed break-words text-tertiary italic">
          «{row.quote}»
        </p>
      )}
    </li>
  );
}

function ExportMenu({ slug, review }: { slug: string; review: TDeepReview }) {
  const { t } = useTranslation();
  const [busy, run] = useBusy();
  const [everything, setEverything] = useState(false);
  const download = (format: "xlsx" | "csv") =>
    run(format, () => assistantService.downloadDeepReview(slug, review.id, format, everything ? "all" : "matches"));
  const item =
    "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-12 text-primary hover:bg-layer-1-hover disabled:opacity-50";
  return (
    <Popover>
      {/* Same look as the secondary buttons beside it */}
      <Popover.Button className="inline-flex h-5 items-center justify-center gap-1 rounded-sm border border-strong bg-layer-2 px-1.5 text-caption-md-medium whitespace-nowrap text-secondary shadow-raised-100 transition-colors hover:bg-layer-2-hover active:bg-layer-2-active">
        <FileSpreadsheet className="size-3.5" aria-hidden />
        {t("assistant.deep_review.export")}
        <ChevronDown className="size-3" aria-hidden />
      </Popover.Button>
      <Popover.Panel side="top" align="start" positionerClassName="z-[40]">
        <div className="w-64 rounded-lg border border-subtle bg-surface-1 p-1.5 shadow-raised-200">
          <button type="button" className={item} disabled={!!busy} onClick={() => void download("xlsx")}>
            <FileSpreadsheet className="size-3.5 text-success-primary" aria-hidden />
            {t("assistant.deep_review.excel")}
          </button>
          <button type="button" className={item} disabled={!!busy} onClick={() => void download("csv")}>
            <FileText className="size-3.5 text-tertiary" aria-hidden />
            {t("assistant.deep_review.csv")}
          </button>
          <label className="mt-1 flex cursor-pointer items-start gap-2 border-t border-subtle px-2 pt-2 pb-1 text-11 text-secondary">
            <input
              type="checkbox"
              className="accent-accent-primary mt-0.5"
              checked={everything}
              onChange={(event) => setEverything(event.target.checked)}
            />
            {t("assistant.deep_review.include_all")}
          </label>
        </div>
      </Popover.Panel>
    </Popover>
  );
}

function ResultView({ slug, review, onChange }: { slug: string; review: TDeepReview; onChange: () => void }) {
  const { t } = useTranslation();
  const [busy, run] = useBusy();
  const [tab, setTab] = useState<"matches" | "rest">("matches");
  const [limit, setLimit] = useState(PAGE_ROWS);
  const [page, setPage] = useState<{ title: string; markdown: string } | null>(null);
  const rows = review.results ?? [];
  const matches = rows.filter((row) => row.selected);
  const rest = rows.filter((row) => !row.selected);
  const list = tab === "matches" ? matches : rest;
  const visible = list.slice(0, limit);
  const files = matches
    .filter((row): row is TDeepReviewRow & { file_asset_id: string } => !!row.file_asset_id)
    .map((row) => ({ assetId: row.file_asset_id, name: row.file_name ?? `${row.title}.pdf` }));
  const took = duration(review.started_at, review.finished_at);
  const tabs = [
    { key: "matches" as const, label: t("assistant.deep_review.tab_matches"), count: matches.length },
    { key: "rest" as const, label: t("assistant.deep_review.tab_rest"), count: rest.length },
  ];

  return (
    <>
      {review.status === "PARTIAL" && (
        <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 rounded-md bg-warning-subtle px-2.5 py-2">
          <p className="text-12 text-warning-primary">
            {t("assistant.deep_review.partial_title", { done: review.done_count, total: review.total_count })}
          </p>
          {!!review.remaining_count && !review.continuation_id && (
            <Button
              size="sm"
              variant="secondary"
              loading={busy === "rest"}
              onClick={() =>
                void run("rest", async () => {
                  await assistantService.continueDeepReview(slug, review.id);
                  onChange();
                })
              }
            >
              {t("assistant.deep_review.continue_rest", { count: review.remaining_count })}
            </Button>
          )}
        </div>
      )}
      {review.status === "FAILED" && (
        <p className="mt-2.5 rounded-md bg-danger-subtle px-2.5 py-2 text-12 text-danger-primary">
          {t("assistant.deep_review.failed_title")}
          {review.error?.message ? `: ${review.error.message}` : ""}
        </p>
      )}

      {review.summary && (
        <p className="mt-2.5 text-13 leading-relaxed whitespace-pre-line text-primary">{review.summary}</p>
      )}

      <div className="mt-3 grid grid-cols-3 gap-1.5">
        <Stat value={matches.length} label={t("assistant.deep_review.stat_matches")} tone="text-accent-primary" />
        <Stat
          value={`${review.done_count}${review.done_count < review.total_count ? ` / ${review.total_count}` : ""}`}
          label={t("assistant.deep_review.stat_read")}
        />
        <Stat
          value={money(review.spent_usd)}
          label={t("assistant.deep_review.of_estimate", { estimate: money(review.estimate_usd) })}
        />
      </div>

      {rows.length > 0 && (
        <div className="mt-3 overflow-hidden rounded-md border border-subtle">
          <div role="tablist" className="flex border-b border-subtle bg-layer-2 text-12">
            {tabs.map(({ key, label, count }) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                onClick={() => {
                  setTab(key);
                  setLimit(PAGE_ROWS);
                }}
                className={cn(
                  "-mb-px flex items-center gap-1.5 border-b-2 px-3 py-1.5",
                  tab === key
                    ? "border-accent-primary font-medium text-primary"
                    : "border-transparent text-tertiary hover:text-secondary"
                )}
              >
                {label}
                <span className={cn(mono, "rounded-sm bg-layer-1 px-1")}>{count}</span>
              </button>
            ))}
          </div>
          {visible.length > 0 ? (
            <ul className="max-h-[26rem] divide-y divide-subtle overflow-y-auto bg-surface-1">
              {visible.map((row) => (
                <ResultRow key={row.contract_id} slug={slug} row={row} />
              ))}
            </ul>
          ) : (
            <p className="bg-surface-1 px-2.5 py-3 text-12 text-tertiary">
              {tab === "matches" ? t("assistant.deep_review.no_matches") : t("assistant.deep_review.no_rest")}
            </p>
          )}
          {list.length > visible.length && (
            <button
              type="button"
              onClick={() => setLimit((value) => value + PAGE_ROWS * 3)}
              className="w-full border-t border-subtle bg-surface-1 py-1.5 text-11 text-accent-primary hover:bg-layer-1-hover"
            >
              {t("assistant.deep_review.show_more", { count: list.length - visible.length })}
            </button>
          )}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {files.length > 0 && (
          <Button
            size="sm"
            variant="secondary"
            loading={busy === "files"}
            onClick={() => void run("files", () => downloadAssets(slug, files, "contratos"))}
          >
            <Download className="size-3.5" />
            {t("assistant.deep_review.download", { count: files.length })}
          </Button>
        )}
        <ExportMenu slug={slug} review={review} />
        <Button
          size="sm"
          variant="secondary"
          loading={busy === "page"}
          disabled={!!page}
          onClick={() => void run("page", async () => setPage(await assistantService.deepReviewPage(slug, review.id)))}
        >
          <FileText className="size-3.5" />
          {t("assistant.deep_review.save_page")}
        </Button>
      </div>

      {page && (
        <div className="mt-2.5">
          <PageForm proposal={{ ...page, workspace_slug: slug }} toolCallId={`deep-review-${review.id}`} />
        </div>
      )}

      <Hint icon={MessageSquare}>
        {t("assistant.deep_review.follow_up")}
        {took && ` · ${t("assistant.deep_review.took", { time: took })}`}
      </Hint>
    </>
  );
}

// -------------------------------------------------------------------- panel

function DeepReviewPanel({ slug, reviewId, withoutText }: { slug: string; reviewId: string; withoutText?: number }) {
  const { t } = useTranslation();
  const { data: review, mutate } = useReview(slug, reviewId);
  if (!review) {
    return (
      <div className={CARD}>
        <GenerationLoader label={t("assistant.deep_review.loading")} />
      </div>
    );
  }
  const update = (next: TDeepReview) => void mutate(next, { revalidate: false });

  return (
    <>
      <DeepReviewProcess slug={slug} review={review} />
      <div className={CARD}>
        <div className="flex items-start gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-accent-primary/10 text-accent-primary">
            <ScanSearch className="size-4" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-13 font-medium text-primary">
              {review.title || t("assistant.deep_review.title")}
            </p>
            <p className="truncate text-11 text-tertiary">
              {review.status === "RUNNING"
                ? t("assistant.deep_review.subtitle_running")
                : t("assistant.deep_review.subtitle")}
            </p>
          </div>
          <StatusPill status={review.status} />
        </div>
        <Criteria text={review.question} />
        {review.status === "DRAFT" && !!withoutText && (
          <p className="mt-1 text-11 text-tertiary">
            {t("assistant.deep_review.without_text", { count: withoutText })}
          </p>
        )}

        {review.status === "DRAFT" && <DecideView slug={slug} review={review} onChange={update} />}
        {ACTIVE.has(review.status) && <ProgressView slug={slug} review={review} onChange={update} />}
        {FINISHED.has(review.status) && <ResultView slug={slug} review={review} onChange={() => void mutate()} />}
      </div>
      {review.continuation_id && (
        <div className="mt-2">
          <DeepReviewPanel slug={slug} reviewId={review.continuation_id} />
        </div>
      )}
    </>
  );
}

type TProposal = { review_id?: string; workspace_slug?: string; without_text_count?: number; error?: unknown };

export const DeepReviewCard = makeAssistantToolUI<{ title?: string; question?: string }, TProposal>({
  toolName: "propose_deep_review",
  render: function DeepReviewRender({ result, status }) {
    const { t } = useTranslation();
    if (status.type === "running" || !result) {
      return <TraceLine live icon={ScanSearch} label={t("assistant.deep_review.preparing")} />;
    }
    if (!result.review_id || !result.workspace_slug) {
      const message = typeof result.error === "string" && result.error ? result.error : t("assistant.actions.failed");
      return <p className="text-12 text-tertiary">{message}</p>;
    }
    return (
      <div className="py-1">
        <DeepReviewPanel
          slug={result.workspace_slug}
          reviewId={result.review_id}
          withoutText={result.without_text_count}
        />
      </div>
    );
  },
});
