import { useMemo } from "react";
import { useThread } from "@assistant-ui/react";
import { getThreadMessageTokenUsage, useThreadTokenUsage, type ThreadTokenUsage } from "@assistant-ui/react-ai-sdk";
import { Tooltip } from "@plane/propel/tooltip";

const compact = (value: number) =>
  value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(1)}M`
    : value >= 1_000
      ? `${(value / 1_000).toFixed(1)}k`
      : String(value);

const contextWindowFor = (model: string | null) => (model?.toLowerCase().includes("gemini") ? 1_000_000 : 128_000);

/** USD per 1M tokens. Provider list prices — update here when they change. */
type TModelPricing = { input: number; cachedInput: number; output: number };
const MODEL_PRICING: { match: RegExp; pricing: TModelPricing }[] = [
  { match: /gemini-2\.5-pro/i, pricing: { input: 1.25, cachedInput: 0.31, output: 10 } },
  { match: /gemini-2\.5-flash-lite/i, pricing: { input: 0.1, cachedInput: 0.025, output: 0.4 } },
  { match: /gemini-2\.5-flash/i, pricing: { input: 0.3, cachedInput: 0.075, output: 2.5 } },
  { match: /gemini-2\.0-flash/i, pricing: { input: 0.1, cachedInput: 0.025, output: 0.4 } },
  { match: /gemini/i, pricing: { input: 0.3, cachedInput: 0.075, output: 2.5 } },
  { match: /deepseek/i, pricing: { input: 0.28, cachedInput: 0.028, output: 0.42 } },
];

const pricingFor = (model: string | null): TModelPricing | null =>
  model ? (MODEL_PRICING.find((entry) => entry.match.test(model))?.pricing ?? null) : null;

const costOf = (usage: ThreadTokenUsage, pricing: TModelPricing): number => {
  const cached = usage.cachedInputTokens ?? 0;
  const freshInput = Math.max((usage.inputTokens ?? 0) - cached, 0);
  // reasoningTokens are billed as output; AI SDK counts them inside outputTokens
  const output = usage.outputTokens ?? 0;
  return (freshInput * pricing.input + cached * pricing.cachedInput + output * pricing.output) / 1_000_000;
};

const formatUsd = (value: number) => {
  if (value === 0) return "$0.00";
  if (value < 0.0001) return "<$0.0001";
  return value < 0.1 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
};

export function AssistantContextDisplay({ model }: { model: string | null }) {
  // Latest run = current context window occupancy
  const usage = useThreadTokenUsage();
  // Every assistant message keeps its own usage metadata → summing them gives
  // the real spend of the whole conversation, not just the last turn. The
  // selector must return a stable reference (messages), never a fresh object.
  const messages = useThread((thread) => thread.messages);
  const spent = useMemo(() => {
    const totals: Required<ThreadTokenUsage> = {
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cachedInputTokens: 0,
    };
    for (const message of messages) {
      const messageUsage = getThreadMessageTokenUsage(message);
      if (!messageUsage) continue;
      totals.totalTokens += messageUsage.totalTokens ?? 0;
      totals.inputTokens += messageUsage.inputTokens ?? 0;
      totals.outputTokens += messageUsage.outputTokens ?? 0;
      totals.reasoningTokens += messageUsage.reasoningTokens ?? 0;
      totals.cachedInputTokens += messageUsage.cachedInputTokens ?? 0;
    }
    return totals;
  }, [messages]);
  const total = usage?.totalTokens ?? 0;
  if (!total && !spent.totalTokens) return null;

  const pricing = pricingFor(model);
  const cost = pricing ? costOf(spent, pricing) : null;

  const contextWindow = contextWindowFor(model);
  const percent = Math.min(100, (total / contextWindow) * 100);
  const color = percent > 85 ? "stroke-red-500" : percent >= 65 ? "stroke-amber-500" : "stroke-emerald-500";
  const details = (
    <span className="grid min-w-44 grid-cols-2 gap-x-4 gap-y-1 text-11">
      <span>Uso de contexto</span>
      <span className="text-right">{percent.toFixed(1)}%</span>
      <span>Entrada</span>
      <span className="text-right">{compact(usage?.inputTokens ?? 0)}</span>
      <span>Cache</span>
      <span className="text-right">{compact(usage?.cachedInputTokens ?? 0)}</span>
      <span>Salida</span>
      <span className="text-right">{compact(usage?.outputTokens ?? 0)}</span>
      <span>Razonamiento</span>
      <span className="text-right">{compact(usage?.reasoningTokens ?? 0)}</span>
      <span>Contexto</span>
      <span className="text-right">
        {compact(total)} / {compact(contextWindow)}
      </span>
      <span className="border-t border-strong pt-1">Tokens gastados</span>
      <span className="border-t border-strong pt-1 text-right">{compact(spent.totalTokens)}</span>
      <span>Costo (est.)</span>
      <span className="text-right">{cost !== null ? formatUsd(cost) : "—"}</span>
    </span>
  );

  return (
    <Tooltip tooltipHeading="Contexto y costo de la conversación" tooltipContent={details} position="top">
      <button
        type="button"
        className="flex items-center gap-1.5 rounded-sm px-1.5 py-1 text-11 text-tertiary hover:bg-layer-1-hover"
        aria-label={`Uso de contexto ${percent.toFixed(1)}%`}
      >
        <svg viewBox="0 0 20 20" className="size-4 -rotate-90" aria-hidden="true">
          <circle cx="10" cy="10" r="7" fill="none" strokeWidth="2.5" className="stroke-subtle" />
          <circle
            cx="10"
            cy="10"
            r="7"
            fill="none"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray={`${2 * Math.PI * 7}`}
            strokeDashoffset={`${2 * Math.PI * 7 * (1 - percent / 100)}`}
            className={color}
          />
        </svg>
        <span>{compact(total)}</span>
        {cost !== null && <span className="text-tertiary">· {formatUsd(cost)}</span>}
      </button>
    </Tooltip>
  );
}
