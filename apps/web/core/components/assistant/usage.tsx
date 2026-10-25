/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * Balance and cost beside the send button: a small ring (after assistant-ui's
 * ContextDisplay ring) that drains as the AI provider balance is spent, with
 * a card on hover showing what the last answer cost and the balance before
 * and after it.
 *
 * DeepSeek reports the balance in whole cents and an answer costs a fraction
 * of one, so the cost comes from the Worker (tokens x DeepSeek's rates, sent
 * with the message metadata) and "after" subtracts it locally until the real
 * balance catches up.
 */

import { useEffect, useRef, useState } from "react";
import { getThreadMessageTokenUsage } from "@assistant-ui/react-ai-sdk";
import { AlertTriangle } from "lucide-react";
import useSWR from "swr";
import { useTranslation } from "@plane/i18n";
import { Popover } from "@plane/propel/popover";
import { cn } from "@plane/utils";
import { AssistantService } from "@/services/assistant.service";
import { formatTokenCount, pct } from "./elements/surfaces";

const assistantService = new AssistantService();

type TTurnCost = { usd: number; provider: string; peak: boolean };

/** What one finished answer cost, as the Worker estimated it */
export type TAssistantTurn = {
  /** Unique per answer, so two equal costs still count twice */
  seq: number;
  model: string;
  cost: number;
  peak: boolean;
  input: number;
  cached: number;
  output: number;
};

/**
 * Reads the Worker's estimate from a finished AI SDK message (useChat's
 * onFinish). assistant-ui does not copy the metadata of the stream's last
 * chunk onto its own message, so the thread state never sees it.
 * Null for models without a known price (Gemini).
 */
export function turnFromMessage(message: { metadata?: unknown } | undefined, seq: number): TAssistantTurn | null {
  const metadata = message?.metadata as { cost?: TTurnCost | null; modelId?: string } | undefined;
  const cost = metadata?.cost;
  if (!cost || typeof cost.usd !== "number") return null;
  const usage = getThreadMessageTokenUsage({ role: "assistant", metadata });
  return {
    seq,
    model: metadata?.modelId ?? cost.provider,
    cost: cost.usd,
    peak: cost.peak,
    input: usage?.inputTokens ?? 0,
    cached: usage?.cachedInputTokens ?? 0,
    output: usage?.outputTokens ?? 0,
  };
}

const money = (value: number, currency = "USD") => {
  // Cents hide the cost of a single answer, so small amounts get 4 decimals
  const digits = Math.abs(value) >= 1 ? 2 : 4;
  return `${currency === "USD" ? "$" : `${currency} `}${value.toFixed(digits)}`;
};

/**
 * The highest balance seen in this browser, the ring's "full". DeepSeek does
 * not say how much was topped up, so this is the closest stand-in.
 */
function useBalancePeak(workspaceSlug: string, total: number | undefined) {
  const key = `assistant-balance-peak:${workspaceSlug}`;
  const [peak, setPeak] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (total === undefined) return;
    let stored = 0;
    try {
      stored = Number(window.localStorage.getItem(key)) || 0;
    } catch {
      // Storage blocked: the ring just starts full
    }
    const next = Math.max(stored, total);
    if (next !== stored) {
      try {
        window.localStorage.setItem(key, String(next));
      } catch {
        // Same as above
      }
    }
    setPeak(next);
  }, [key, total]);
  return peak;
}

const RING_SIZE = 18;
const RING_STROKE = 2.5;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function ringColor(percent: number, available: boolean) {
  if (!available || percent < 15) return "var(--txt-danger-primary)";
  if (percent < 40) return "var(--txt-warning-primary)";
  return "var(--bg-accent-primary)";
}

function BalanceRing({ percent, available }: { percent: number; available: boolean }) {
  return (
    <svg
      aria-hidden
      width={RING_SIZE}
      height={RING_SIZE}
      viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
      className="-rotate-90"
    >
      <circle
        cx={RING_SIZE / 2}
        cy={RING_SIZE / 2}
        r={RING_RADIUS}
        fill="none"
        strokeWidth={RING_STROKE}
        style={{ stroke: "var(--border-subtle-1)" }}
      />
      <circle
        cx={RING_SIZE / 2}
        cy={RING_SIZE / 2}
        r={RING_RADIUS}
        fill="none"
        strokeWidth={RING_STROKE}
        strokeLinecap="round"
        strokeDasharray={RING_CIRCUMFERENCE}
        strokeDashoffset={RING_CIRCUMFERENCE - (percent / 100) * RING_CIRCUMFERENCE}
        className="transition-[stroke-dashoffset,stroke] duration-500"
        style={{ stroke: ringColor(percent, available) }}
      />
    </svg>
  );
}

function Row({ label, value, strong, hint }: { label: string; value: string; strong?: boolean; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className={strong ? "text-secondary" : "text-tertiary"}>
        {label}
        {hint && <span className="block text-11 text-placeholder tabular-nums">{hint}</span>}
      </dt>
      <dd className={cn("tabular-nums", strong ? "font-medium text-primary" : "text-secondary")}>{value}</dd>
    </div>
  );
}

type Props = {
  workspaceSlug: string;
  /** This conversation's priced answers, oldest first */
  turns: readonly TAssistantTurn[];
  /** Bumped after every finished run, priced or not, to re-read the balance */
  finishedRuns: number;
};

export function AssistantUsageMeter({ workspaceSlug, turns, finishedRuns }: Props) {
  const { t } = useTranslation();
  const {
    data: balance,
    error,
    mutate,
  } = useSWR(["ASSISTANT_BALANCE", workspaceSlug], () => assistantService.getBalance(workspaceSlug), {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  });

  // Spend that the provider's balance does not show yet
  const [pending, setPending] = useState(0);
  const counted = useRef(new Set<number>());
  useEffect(() => {
    let added = 0;
    for (const turn of turns) {
      if (counted.current.has(turn.seq)) continue;
      counted.current.add(turn.seq);
      added += turn.cost;
    }
    if (added > 0) setPending((value) => value + added);
  }, [turns]);

  useEffect(() => {
    if (finishedRuns === 0) return;
    void assistantService
      .getBalance(workspaceSlug, true)
      .then((fresh) => mutate(fresh, { revalidate: false }))
      .catch(() => undefined);
  }, [finishedRuns, mutate, workspaceSlug]);

  const account = balance?.balances[0];
  const total = account?.total;
  // A new figure from the provider already includes what was pending
  const seenTotal = useRef(total);
  useEffect(() => {
    if (seenTotal.current !== undefined && total !== undefined && total !== seenTotal.current) setPending(0);
    seenTotal.current = total;
  }, [total]);

  const peak = useBalancePeak(workspaceSlug, total);

  if (error) {
    return (
      <span
        className="flex size-7 shrink-0 items-center justify-center text-danger-primary"
        title={t("assistant.usage.error")}
      >
        <AlertTriangle className="size-3.5" aria-hidden />
        <span className="sr-only">{t("assistant.usage.error")}</span>
      </span>
    );
  }
  if (!balance || !account || total === undefined) return null;

  const currency = account.currency;
  const available = balance.is_available;
  const after = Math.max(0, total - pending);
  const lastTurn = turns.at(-1) ?? null;
  const before = lastTurn ? after + lastTurn.cost : after;
  const sessionTotal = turns.reduce((sum, turn) => sum + turn.cost, 0);
  const percent = peak ? pct(after, peak) : 100;
  const provider = balance.provider === "deepseek" ? "DeepSeek" : balance.provider;
  const approx = pending > 0 ? "≈ " : "";

  return (
    <Popover openOnHover delay={150} closeDelay={150}>
      <Popover.Button
        className="flex size-7 shrink-0 items-center justify-center rounded-lg outline-none hover:bg-layer-1-hover focus-visible:ring-1 focus-visible:ring-accent-strong"
        aria-label={`${t("assistant.usage.label")}: ${money(after, currency)}`}
      >
        <BalanceRing percent={percent} available={available} />
      </Popover.Button>
      <Popover.Panel side="top" align="end" sideOffset={10} positionerClassName="z-[40]">
        <div className="w-60 rounded-lg border border-subtle bg-surface-1 p-3 text-12 shadow-raised-200">
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-medium text-primary">{t("assistant.usage.balance", { provider })}</span>
            {!available && <span className="text-11 text-danger-primary">{t("assistant.usage.unavailable")}</span>}
          </div>
          <span className="mt-0.5 block text-11 text-placeholder">
            {t("assistant.usage.gauge", { percent: Math.round(percent) })}
          </span>

          <dl className="mt-2.5 space-y-1.5">
            {lastTurn ? (
              <>
                <Row
                  label={t("assistant.usage.last_message")}
                  value={money(lastTurn.cost, currency)}
                  hint={`${formatTokenCount(lastTurn.input)} ${t("assistant.usage.in")} · ${formatTokenCount(lastTurn.output)} ${t("assistant.usage.out")}`}
                />
                {turns.length > 1 && <Row label={t("assistant.usage.session")} value={money(sessionTotal, currency)} />}
                <div className="border-t border-subtle" />
                <Row label={t("assistant.usage.before")} value={money(before, currency)} />
                <Row label={t("assistant.usage.after")} value={`${approx}${money(after, currency)}`} strong />
              </>
            ) : (
              <>
                <Row label={t("assistant.usage.available")} value={money(after, currency)} strong />
                <p className="text-11 text-tertiary">{t("assistant.usage.no_messages")}</p>
              </>
            )}
          </dl>

          <p className="mt-2.5 border-t border-subtle pt-2 text-11 leading-relaxed text-placeholder">
            {lastTurn && `${lastTurn.peak ? t("assistant.usage.peak") : t("assistant.usage.off_peak")}. `}
            {t("assistant.usage.estimate_note")}
          </p>
        </div>
      </Popover.Panel>
    </Popover>
  );
}
