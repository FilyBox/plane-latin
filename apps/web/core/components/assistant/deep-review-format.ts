/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * Formatting shared by the deep review card and its process block.
 */

import type { TDeepReviewStatus } from "@/services/assistant.service";

export const ACTIVE_REVIEW = new Set<TDeepReviewStatus>(["SCHEDULED", "RUNNING", "PAUSED", "STOPPING", "SYNTHESIZING"]);
export const FINISHED_REVIEW = new Set<TDeepReviewStatus>(["COMPLETED", "PARTIAL", "FAILED"]);

/** Fractions of a cent need more decimals than a whole bill. */
export const money = (value: number | null | undefined) => {
  const amount = value ?? 0;
  if (amount >= 1) return `$${amount.toFixed(2)}`;
  if (amount >= 0.01) return `$${amount.toFixed(3)}`;
  return `$${amount.toFixed(4)}`;
};

export const range = (value: { low: number; high: number } | undefined) =>
  value ? `${money(value.low)} – ${money(value.high)}` : "—";

export const contractPath = (slug: string, contractId: string) =>
  `/${slug}/file-library/contracts/analyzed?peek=${contractId}`;

/** A time of day, with the weekday when it is not today. */
export const clock = (iso: string | null | undefined) => {
  if (!iso) return "";
  const date = new Date(iso);
  const sameDay = date.toDateString() === new Date().toDateString();
  return date.toLocaleString(
    [],
    sameDay ? { hour: "2-digit", minute: "2-digit" } : { weekday: "short", hour: "2-digit", minute: "2-digit" }
  );
};

/** Seconds between two ISO timestamps, or null when either is missing. */
export const seconds = (from: string | null | undefined, to: string | null | undefined) =>
  from && to ? Math.max(0, (new Date(to).getTime() - new Date(from).getTime()) / 1000) : null;

export const duration = (from: string | null | undefined, to: string | null | undefined) => {
  const value = seconds(from, to);
  if (value === null) return "";
  return value < 90 ? `${Math.round(value)} s` : `${Math.round(value / 60)} min`;
};
