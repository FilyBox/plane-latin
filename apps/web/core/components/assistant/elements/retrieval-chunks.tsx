/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * The passages an answer stands on: source, where in it, how relevant, and
 * the text. Adapted from assistant-ui's retrieval-chunks element.
 */

import { cn } from "@plane/utils";
import { AssistantLink } from "../links";
import { mono, paper, pct } from "./surfaces";

export type RetrievalChunk = {
  id: string;
  source: string;
  /** Where in the source: matched terms, a distance… */
  locator?: string;
  /** 0–1 relevance; omitted for literal matches */
  score?: number;
  text: string;
  path?: string;
};

export function RetrievalChunks({ chunks, className }: { chunks: readonly RetrievalChunk[]; className?: string }) {
  if (chunks.length === 0) return null;
  return (
    <div data-slot="retrieval-chunks" className={cn("flex w-full flex-col gap-1.5", className)}>
      {chunks.map((chunk) => (
        <div key={chunk.id} className={cn(paper, "flex flex-col gap-1 rounded-lg px-2.5 py-2")}>
          <div className="flex min-w-0 items-baseline gap-2">
            {chunk.path ? (
              <AssistantLink href={chunk.path} className="min-w-0 flex-1 truncate text-12 font-medium text-primary">
                {chunk.source}
              </AssistantLink>
            ) : (
              <span className="min-w-0 flex-1 truncate text-12 font-medium text-primary">{chunk.source}</span>
            )}
            {chunk.locator && <span className={cn(mono, "shrink-0 text-tertiary")}>{chunk.locator}</span>}
            {chunk.score !== undefined && (
              <span
                className={cn(
                  mono,
                  "shrink-0 tabular-nums",
                  chunk.score >= 0.8 ? "text-success-primary" : "text-tertiary"
                )}
              >
                {chunk.score.toFixed(2)}
              </span>
            )}
          </div>
          <p className="line-clamp-3 text-11 leading-relaxed break-words text-secondary">{chunk.text}</p>
          {chunk.score !== undefined && (
            <span
              role="meter"
              aria-label={chunk.source}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(pct(chunk.score, 1))}
              className="h-[2px] w-full overflow-hidden rounded-full bg-layer-2"
            >
              <span
                className="block h-full rounded-full bg-accent-primary/70 transition-[width] duration-500"
                style={{ width: `${pct(chunk.score, 1)}%` }}
              />
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
