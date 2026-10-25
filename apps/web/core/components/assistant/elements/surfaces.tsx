/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * Shared looks for the assistant's elements, adapted from assistant-ui's
 * registry elements (https://www.assistant-ui.com/elements) to Plane's
 * design tokens: their shadcn colors (background, muted-foreground…) do not
 * exist here, so each surface maps to the closest Plane layer.
 */

import type { ComponentProps } from "react";
import { cn } from "@plane/utils";

/** A card sitting on the panel */
export const paper = "border border-subtle bg-surface-1";
/** A recessed area inside a card (chips, request/result boxes) */
export const field = "bg-layer-2";
/** Small monospace figures: token counts, scores, durations */
export const mono = "font-mono text-11 tracking-tight";

/** Text with a light band sweeping across it while something is in progress. */
export function ShimmerLabel({ active = true, className, ...props }: ComponentProps<"span"> & { active?: boolean }) {
  return (
    <span
      className={cn(
        active &&
          // Explicit tokens: with text-transparent, currentColor would be transparent too
          "animate-shimmer bg-[linear-gradient(90deg,var(--text-color-tertiary)_40%,var(--text-color-primary)_50%,var(--text-color-tertiary)_60%)] bg-[length:200%_100%] bg-clip-text text-transparent motion-reduce:animate-none motion-reduce:bg-none motion-reduce:text-current",
        className
      )}
      {...props}
    />
  );
}

/** Token counts the way the elements print them: 950, 48.2k, 1.3M */
export function formatTokenCount(tokens: number): string {
  if (!(tokens >= 1_000)) return `${tokens}`;
  const units = [
    { size: 1_000, suffix: "k" },
    { size: 1_000_000, suffix: "M" },
    { size: 1_000_000_000, suffix: "B" },
  ];
  let label = "";
  for (const { size, suffix } of units) {
    const value = Math.round((tokens / size) * 10) / 10;
    label = `${value}${suffix}`;
    if (value < 1_000) break;
  }
  return label;
}

/** `value` as a 0–100 share of `total`, safe for widths */
export function pct(value: number, total: number): number {
  if (!(total > 0) || Number.isNaN(value)) return 0;
  return Math.min(100, Math.max(0, (value / total) * 100));
}
