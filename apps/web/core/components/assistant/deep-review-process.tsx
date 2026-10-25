/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * What a deep review did, as the chat shows any other run: a foldable block
 * of steps (prepared, split into lanes, every contract read with its outcome,
 * pauses and decisions, the final check and the answer). Open while it
 * works, folded once done, and kept in the review so a reopened chat still
 * shows it.
 */

import { useEffect, useState } from "react";
import {
  Check,
  ChevronRight,
  ClipboardList,
  Clock,
  FileSearch,
  Filter,
  Loader2,
  Minus,
  PauseCircle,
  PenLine,
  Play,
  Split,
  Square,
  Wallet,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useTranslation } from "@plane/i18n";
import { cn } from "@plane/utils";
import type { TDeepReview, TDeepReviewEvent, TDeepReviewProcessItem } from "@/services/assistant.service";
import { ACTIVE_REVIEW, contractPath, money, range, seconds } from "./deep-review-format";
import { formatTokenCount, mono, ShimmerLabel } from "./elements/surfaces";
import { AssistantLink } from "./links";
import { formatDuration, TraceLine } from "./steps";

const READING = new Set(["RUNNING", "PAUSED", "STOPPING"]);
const ITEMS_SHOWN = 30;
const LIVE_ITEMS = 6;
const DECISIONS: Record<string, LucideIcon> = {
  paused: PauseCircle,
  continued: Play,
  stopped: Square,
  no_balance: Wallet,
  pause_timeout: Clock,
};

/** The last element matching, without copying the list. */
function lastOf<T>(list: readonly T[], matches: (value: T) => boolean): T | undefined {
  for (let index = list.length - 1; index >= 0; index -= 1) if (matches(list[index])) return list[index];
  return undefined;
}

function ItemRow({ slug, item, start }: { slug: string; item: TDeepReviewProcessItem; start?: string }) {
  const { t } = useTranslation();
  const dropped = item.matches === true && !item.selected && Boolean(item.reason);
  const failed = item.status === "FAILED";
  const Icon = failed ? X : item.selected || (item.matches && !dropped) ? Check : dropped ? Filter : Minus;
  const tone = failed
    ? "text-danger-primary"
    : item.selected || (item.matches && !dropped)
      ? "text-success-primary"
      : dropped
        ? "text-warning-primary"
        : "text-placeholder";
  let outcome = t("assistant.deep_review.process.no_match");
  if (failed) outcome = item.error || t("assistant.deep_review.process.error");
  else if (dropped) outcome = t("assistant.deep_review.process.dropped_item");
  else if (item.matches)
    outcome =
      item.confidence !== null
        ? t("assistant.deep_review.process.match_confidence", { confidence: item.confidence })
        : t("assistant.deep_review.process.match");
  const offset = seconds(start, item.finished_at);
  const cost = [
    formatTokenCount(item.tokens),
    money(item.cost_usd),
    item.chunks > 1 ? t("assistant.deep_review.process.chunks", { count: item.chunks }) : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <li className="flex min-w-0 items-center gap-1.5 py-px text-11">
      <Icon className={cn("size-3 shrink-0", tone)} aria-hidden />
      <AssistantLink href={contractPath(slug, item.contract_id)} className="min-w-0 shrink truncate text-secondary">
        {item.title}
      </AssistantLink>
      <span className={cn("min-w-0 flex-1 truncate", failed ? "text-danger-primary" : "text-tertiary")} title={outcome}>
        {outcome}
      </span>
      <span className={cn(mono, "shrink-0 text-placeholder tabular-nums")}>
        {cost}
        {offset !== null && ` · +${formatDuration(offset)}`}
      </span>
    </li>
  );
}

function ItemList({
  slug,
  items,
  start,
  limit = ITEMS_SHOWN,
}: {
  slug: string;
  items: TDeepReviewProcessItem[];
  start?: string;
  limit?: number;
}) {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, limit);
  if (items.length === 0) return null;
  return (
    <ul className="min-w-0">
      {shown.map((item) => (
        <ItemRow key={item.contract_id} slug={slug} item={item} start={start} />
      ))}
      {items.length > shown.length && (
        <li>
          <button type="button" onClick={() => setAll(true)} className="text-11 text-accent-primary hover:underline">
            {t("assistant.deep_review.process.show_all", { count: items.length })}
          </button>
        </li>
      )}
    </ul>
  );
}

function decisionLabel(event: TDeepReviewEvent, t: (key: string, params?: Record<string, unknown>) => string) {
  const key = `assistant.deep_review.process.${event.kind}`;
  if (event.kind === "paused") {
    const percent = event.projection && event.estimate ? Math.round((event.projection / event.estimate - 1) * 100) : 0;
    return {
      label: t(key, { percent }),
      detail: t("assistant.deep_review.process.projection", {
        projection: money(event.projection),
        estimate: money(event.estimate),
      }),
    };
  }
  return { label: t(key, { count: event.read ?? 0 }), detail: undefined };
}

export function DeepReviewProcess({ slug, review }: { slug: string; review: TDeepReview }) {
  const { t } = useTranslation();
  const events = review.process?.events ?? [];
  const items = review.process?.items ?? [];
  const active = ACTIVE_REVIEW.has(review.status);
  const [open, setOpen] = useState(active);
  useEffect(() => setOpen(active), [active]);

  const first = (kind: string) => events.find((event) => event.kind === kind);
  const last = (kind: string) => lastOf(events, (event) => event.kind === kind);
  const started = first("started") ?? first("scheduled");
  if (!started) return null;

  const scheduled = first("scheduled");
  const running = first("running");
  const synthesis = last("synthesizing");
  const finished = lastOf(events, (event) => ["completed", "partial", "failed"].includes(event.kind));
  const reading = READING.has(review.status);
  // Reviews started right away may lack the "running" event: contracts read prove it
  const readingStarted = Boolean(running) || reading || items.length > 0;
  const settled = review.done_count + review.failed_count;
  const matched = items.filter((item) => item.matches).length;
  const droppedItems = items.filter((item) => item.matches && !item.selected && item.reason);
  const lanes = Math.min(review.estimate?.lanes ?? 1, review.total_count) || 1;
  const readStart = running?.at ?? started.at;
  const readEnd = synthesis?.at ?? items[items.length - 1]?.finished_at;
  const estimateText = review.estimate_usd
    ? t("assistant.deep_review.process.estimate", { amount: `~${money(review.estimate_usd)}` })
    : t("assistant.deep_review.process.estimate", {
        amount: range(review.estimate?.models?.[review.model]?.[review.estimate?.now_peak ? "peak" : "off_peak"]),
      });
  const decisions = events.filter((event) => event.kind in DECISIONS);

  let activity = t("assistant.deep_review.process.reading", { done: settled, total: review.total_count });
  if (review.status === "SCHEDULED") activity = t("assistant.deep_review.process.waiting");
  if (review.status === "SYNTHESIZING") activity = t("assistant.deep_review.process.writing");
  const took = seconds(started.at, finished?.at);
  const summary = t("assistant.deep_review.process.summary", {
    count: review.done_count,
    time: took !== null ? formatDuration(took) : "",
  });
  // Newest first while it reads, so what just finished is on top
  const liveItems = items.slice(-LIVE_ITEMS).map((_, index, tail) => tail[tail.length - 1 - index]);

  return (
    <div className="my-1.5 min-w-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-busy={active}
        className="flex w-full min-w-0 items-center gap-1.5 rounded-sm py-0.5 text-left text-12 text-tertiary hover:text-secondary"
      >
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 transition-transform duration-200 motion-reduce:transition-none",
            open && "rotate-90"
          )}
          aria-hidden
        />
        {active ? (
          <ShimmerLabel className="min-w-0 truncate">{activity}</ShimmerLabel>
        ) : (
          <span className="min-w-0 truncate tabular-nums">{summary}</span>
        )}
        <span className={cn(mono, "ms-auto flex shrink-0 items-center gap-1 tabular-nums")}>
          {active || review.failed_count === 0
            ? `${settled}/${review.total_count}`
            : t("assistant.steps.failed_count", { count: review.failed_count })}
          {active ? (
            <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-hidden />
          ) : review.failed_count > 0 || review.status === "FAILED" ? (
            <X className="size-3 text-danger-primary" aria-hidden />
          ) : (
            <Check className="size-3 text-success-primary" aria-hidden />
          )}
        </span>
      </button>

      {open && (
        <div className="mt-1 ml-1.5 flex min-w-0 animate-fade-in flex-col gap-0.5 border-l border-subtle pl-3">
          <TraceLine
            live={false}
            icon={ClipboardList}
            label={t("assistant.deep_review.process.prepared")}
            chip={t("assistant.deep_review.process.contracts", { count: review.total_count })}
            detail={estimateText}
          />
          {scheduled && (
            <TraceLine
              live={review.status === "SCHEDULED"}
              icon={Clock}
              label={t("assistant.deep_review.process.waited")}
              elapsed={seconds(scheduled.at, running?.at)}
            />
          )}
          {readingStarted && (
            <TraceLine
              live={false}
              icon={Split}
              label={t("assistant.deep_review.process.lanes", { count: lanes })}
              detail={review.model}
            />
          )}

          {readingStarted &&
            (reading ? (
              <>
                <TraceLine
                  live={review.status === "RUNNING"}
                  icon={FileSearch}
                  label={t("assistant.deep_review.process.reading_label")}
                  chip={`${settled}/${review.total_count}`}
                  detail={t("assistant.deep_review.process.matched_spent", {
                    count: matched,
                    spent: money(review.spent_usd),
                  })}
                />
                <div className="mb-1 ml-5">
                  <ItemList slug={slug} items={liveItems} start={readStart} limit={LIVE_ITEMS} />
                </div>
              </>
            ) : (
              <TraceLine
                live={false}
                failed={review.failed_count > 0}
                icon={FileSearch}
                label={t("assistant.deep_review.process.read_label", { count: settled })}
                chip={`${review.done_count}/${review.total_count}`}
                detail={t("assistant.deep_review.process.matched_spent", {
                  count: matched,
                  spent: money(review.spent_usd),
                })}
                elapsed={seconds(readStart, readEnd)}
              >
                <ItemList slug={slug} items={items} start={readStart} />
              </TraceLine>
            ))}

          {decisions.map((event) => {
            const { label, detail } = decisionLabel(event, t);
            return (
              <TraceLine
                key={`${event.kind}:${event.at}`}
                live={false}
                icon={DECISIONS[event.kind]}
                label={label}
                detail={detail}
                showOutcome={false}
              />
            );
          })}

          {synthesis && (
            <TraceLine
              live={review.status === "SYNTHESIZING"}
              icon={Filter}
              label={
                review.status === "SYNTHESIZING"
                  ? t("assistant.deep_review.process.checking")
                  : droppedItems.length > 0
                    ? t("assistant.deep_review.process.dropped", { count: droppedItems.length })
                    : t("assistant.deep_review.process.checked", { count: matched })
              }
              elapsed={seconds(synthesis.at, finished?.at)}
            >
              {droppedItems.length > 0 ? (
                <ul className="space-y-1">
                  {droppedItems.map((item) => (
                    <li key={item.contract_id} className="text-11">
                      <AssistantLink href={contractPath(slug, item.contract_id)} className="text-secondary">
                        {item.title}
                      </AssistantLink>
                      <p className="text-tertiary">{item.reason}</p>
                    </li>
                  ))}
                </ul>
              ) : undefined}
            </TraceLine>
          )}

          {finished &&
            (review.status === "FAILED" ? (
              <TraceLine
                live={false}
                failed
                icon={PenLine}
                label={t("assistant.deep_review.process.failed")}
                detail={review.error?.message}
              />
            ) : (
              <TraceLine
                live={false}
                icon={PenLine}
                label={
                  review.status === "PARTIAL"
                    ? t("assistant.deep_review.process.wrote_partial", {
                        done: review.done_count,
                        total: review.total_count,
                      })
                    : t("assistant.deep_review.process.wrote")
                }
              />
            ))}
        </div>
      )}
    </div>
  );
}
