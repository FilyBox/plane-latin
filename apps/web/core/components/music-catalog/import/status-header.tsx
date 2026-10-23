/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { useTranslation } from "@plane/i18n";
import type { TMusicImportProgress } from "@plane/types";
import { cn } from "@plane/utils";
import { formatElapsed, IMPORT_STEPS, type TImportStep } from "./constants";
import type { TImportPhase } from "./use-import-flow";

type Props = {
  step: TImportStep;
  reachable: (step: TImportStep) => boolean;
  complete: (step: TImportStep) => boolean;
  onStep: (step: TImportStep) => void;
  phase: TImportPhase;
  progress?: TMusicImportProgress;
  startedAt?: number;
  /** One line describing where the user stands when nothing is running */
  idleMessage: string;
  idleTone?: "neutral" | "warning" | "success";
};

/**
 * The page's fixed top band: where you are in the import, and — the one
 * thing that must never scroll out of sight — what the server is doing right
 * now, row by row.
 */
export function ImportStatusHeader({
  step,
  reachable,
  complete,
  onStep,
  phase,
  progress,
  startedAt,
  idleMessage,
  idleTone = "neutral",
}: Props) {
  const { t } = useTranslation();
  const isBusy = phase !== "idle";
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!isBusy) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isBusy]);

  const isStreaming = phase === "validating" || phase === "importing";
  const total = progress?.total ?? 0;
  const processed = progress?.processed ?? 0;
  const percent = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
  const phaseLabel = t(`music_import.status.${phase === "idle" ? "done" : phase}`);

  return (
    <div className="shrink-0 border-b border-subtle bg-surface-1">
      <div className="mx-auto w-full max-w-6xl">
        <nav
          aria-label={t("music_import.page_title")}
          className="flex items-center gap-1 overflow-x-auto px-2 pt-3 sm:px-4"
        >
          {IMPORT_STEPS.map((item, index) => {
            const isCurrent = item === step;
            const isDone = complete(item) && !isCurrent;
            const canGo = reachable(item) && !isBusy && !isCurrent;
            return (
              <div key={item} className="flex shrink-0 items-center gap-1">
                {index > 0 && <span className="h-px w-4 bg-layer-3 sm:w-8" aria-hidden />}
                <button
                  type="button"
                  disabled={!canGo}
                  aria-current={isCurrent ? "step" : undefined}
                  onClick={() => onStep(item)}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-2 py-1.5 text-13 transition-colors",
                    isCurrent ? "font-medium text-primary" : "text-tertiary",
                    canGo && "hover:bg-layer-1-hover hover:text-secondary"
                  )}
                >
                  <span
                    className={cn(
                      "flex size-5 items-center justify-center rounded-full text-11 font-semibold",
                      isCurrent && "bg-accent-primary text-on-color",
                      isDone && "bg-success-subtle text-success-primary",
                      !isCurrent && !isDone && "bg-layer-2 text-tertiary"
                    )}
                  >
                    {isDone ? <Check className="size-3" /> : index + 1}
                  </span>
                  {/* On narrow screens only the current step keeps its name. */}
                  <span className={cn(!isCurrent && "sr-only sm:not-sr-only")}>{t(`music_import.steps.${item}`)}</span>
                </button>
              </div>
            );
          })}
        </nav>

        <div role="status" aria-live="polite" className="flex min-h-12 flex-col justify-center px-4 pt-2 pb-3 sm:px-6">
          {isBusy ? (
            <div className="space-y-1.5">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-12">
                <span className="flex items-center gap-2 font-medium text-primary">
                  <Loader2 className="size-3.5 animate-spin text-accent-primary" />
                  {phaseLabel}
                  {isStreaming && total > 0 && (
                    <span className="font-normal text-secondary tabular-nums">
                      {t("music_import.status.rows_progress", {
                        processed: processed.toLocaleString(),
                        total: total.toLocaleString(),
                      })}
                    </span>
                  )}
                </span>
                <span className="flex items-center gap-3 text-11 text-tertiary tabular-nums">
                  {isStreaming && <span>{t("music_import.status.dont_leave")}</span>}
                  {startedAt && (
                    <span>{t("music_import.status.elapsed", { time: formatElapsed(now - startedAt) })}</span>
                  )}
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-layer-2">
                {isStreaming && total > 0 ? (
                  <div
                    className="h-full rounded-full bg-accent-primary transition-[width] duration-300"
                    style={{ width: `${percent}%` }}
                  />
                ) : (
                  <div className="h-full w-1/3 animate-pulse rounded-full bg-accent-primary/60" />
                )}
              </div>
            </div>
          ) : (
            <p
              className={cn(
                "text-12",
                idleTone === "neutral" && "text-secondary",
                idleTone === "warning" && "text-warning-primary",
                idleTone === "success" && "text-success-primary"
              )}
            >
              {idleMessage}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
