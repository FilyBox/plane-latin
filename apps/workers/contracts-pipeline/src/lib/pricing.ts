/**
 * What a chat turn cost, estimated from its token usage.
 *
 * DeepSeek's balance endpoint reports whole cents and a turn costs a fraction
 * of one, so the spend of a single message can only be computed from tokens
 * times price. Prices from https://api-docs.deepseek.com/quick_start/pricing
 * (checked 2026-10-24); update them here when DeepSeek changes them.
 *
 * Billing per request: cache-hit input, cache-miss input and output (thinking
 * included) each have their own rate, and every rate halves off-peak.
 */

import type { LanguageModelUsage } from "ai";

/** USD per 1M tokens at peak hours. Off-peak is half. */
type Price = { cacheHit: number; cacheMiss: number; output: number };

const DEEPSEEK_PEAK_PRICES: Record<string, Price> = {
  flash: { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 },
  pro: { cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 },
};

/**
 * Model ids → price row. deepseek-v4-pro has its own price; every other
 * DeepSeek name (deepseek-flash and the legacy deepseek-v4-flash and
 * deepseek-chat) is served by V4.1 Flash at the Flash price.
 */
function deepseekPrice(modelId: string): Price | null {
  const id = modelId.toLowerCase();
  if (!id.startsWith("deepseek")) return null;
  return id.includes("pro") ? DEEPSEEK_PEAK_PRICES.pro : DEEPSEEK_PEAK_PRICES.flash;
}

/** Peak: 01:00–04:00 and 06:00–10:00 UTC, Monday to Friday. Chinese public
 * holidays are also off-peak; they are not tracked, so those days read high. */
export function isDeepseekPeak(at: Date): boolean {
  const day = at.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = at.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

export type TurnCost = {
  /** Estimated spend in USD */
  usd: number;
  provider: "deepseek";
  peak: boolean;
};

export function estimateTurnCost(modelId: string, usage: LanguageModelUsage, at = new Date()): TurnCost | null {
  const price = deepseekPrice(modelId);
  if (!price) return null;
  const input = usage.inputTokens ?? 0;
  const cached = usage.inputTokenDetails?.cacheReadTokens ?? 0;
  const uncached = usage.inputTokenDetails?.noCacheTokens ?? Math.max(0, input - cached);
  // Reasoning tokens are billed as output and already counted in outputTokens
  const output = usage.outputTokens ?? 0;
  const peak = isDeepseekPeak(at);
  const factor = peak ? 1 : 0.5;
  const usd = ((cached * price.cacheHit + uncached * price.cacheMiss + output * price.output) * factor) / 1_000_000;
  return { usd, provider: "deepseek", peak };
}

export type ProviderBalance = {
  provider: "deepseek";
  /** False when DeepSeek says the balance can no longer pay for calls */
  is_available: boolean;
  balances: { currency: string; total: number }[];
};

/** The DeepSeek account balance, read with the Worker's own key. */
export async function getDeepseekBalance(apiKey: string): Promise<ProviderBalance> {
  const response = await fetch("https://api.deepseek.com/user/balance", {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`DeepSeek balance request failed: ${response.status}`);
  const data = await response.json<{
    is_available: boolean;
    balance_infos?: { currency: string; total_balance: string }[];
  }>();
  return {
    provider: "deepseek",
    is_available: data.is_available,
    balances: (data.balance_infos ?? []).map((info) => ({
      currency: info.currency,
      total: Number(info.total_balance),
    })),
  };
}
