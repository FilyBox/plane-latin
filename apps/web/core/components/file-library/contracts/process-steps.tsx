/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * The Proceso tab: each run of the pipeline as a list of steps with how long
 * each took, the total time and, once the AI has run, what it cost.
 */

import { useEffect, useState } from "react";
import { AlertTriangle, Ban, CheckCircle2, ChevronDown, ChevronRight, Circle, Loader2, XCircle } from "lucide-react";
// plane imports
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import type { TContractJob } from "@plane/types";
import { cn } from "@plane/utils";
// local imports
import { stageDetail } from "./processing-badge";
import {
  elapsedMs,
  formatContractDateTime,
  formatCost,
  formatDuration,
  isJobActive,
  isStageCode,
  stageLabel,
} from "./utils";

type TFn = (key: string, params?: Record<string, unknown>) => string;

const ERROR_STAGES = new Set([
  "extracting_text",
  "waiting_ocr",
  "collecting_text",
  "embedding",
  "analyzing",
  "saving",
  "classifying",
  "syncing_tags",
  "timeout",
  "cancelled",
]);

/** A plain sentence for a failed run, by the stage it stopped at */
export const friendlyJobError = (t: TFn, job: Pick<TContractJob, "error" | "current_stage" | "status">): string => {
  if (job.status === "CANCELLED") return t("file_library.contracts.errors.cancelled");
  const stage = job.error?.stage ?? job.current_stage ?? "";
  return ERROR_STAGES.has(stage)
    ? t(`file_library.contracts.errors.${stage}`)
    : t("file_library.contracts.errors.generic");
};

/** Re-renders every second while `on`, for live elapsed times */
const useTick = (on: boolean) => {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!on) return;
    const handle = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => window.clearInterval(handle);
  }, [on]);
};

function StatusChip({ job }: { job: TContractJob }) {
  const { t } = useTranslation();
  const active = isJobActive(job);
  return (
    <span
      className={cn(
        "flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-11 font-medium",
        active
          ? "bg-accent-primary/10 text-accent-primary"
          : job.status === "COMPLETED"
            ? "bg-success-subtle text-success-primary"
            : job.status === "CANCELLED"
              ? "bg-layer-1 text-tertiary"
              : "bg-danger-subtle text-danger-primary"
      )}
    >
      {active && <Loader2 className="size-3 animate-spin" />}
      {job.status === "FAILED" && <AlertTriangle className="size-3" />}
      {job.status === "CANCELLED" && <Ban className="size-3" />}
      {t(`file_library.contracts.job_status.${job.status.toLowerCase()}`)}
    </span>
  );
}

/** Collapsible raw error text for whoever needs to report it */
export function ErrorDetails({ message }: { message: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex items-center gap-1 text-11 text-tertiary hover:text-secondary"
      >
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        {t("file_library.contracts.errors.details")}
      </button>
      {open && (
        <pre className="font-mono mt-1 max-h-40 overflow-auto rounded-sm bg-layer-1 px-2 py-1.5 text-10 break-words whitespace-pre-wrap text-secondary">
          {message}
        </pre>
      )}
    </div>
  );
}

type JobProps = {
  job: TContractJob;
  /** Shows the cancel action (active jobs, editors only) */
  onCancel?: () => void;
  isCancelling?: boolean;
  defaultOpen?: boolean;
};

export function ContractJobTimeline({ job, onCancel, isCancelling, defaultOpen = true }: JobProps) {
  const { t, currentLocale } = useTranslation();
  const [open, setOpen] = useState(defaultOpen);
  const active = isJobActive(job);
  useTick(active && open);

  const steps = job.metadata?.steps ?? [];
  const usage = job.metadata?.usage;
  const total = elapsedMs(job.started_at ?? job.created_at, active ? null : (job.finished_at ?? job.updated_at));
  const detail = stageDetail(t, job);
  const currentLabel = stageLabel(t, job.current_stage);

  return (
    <div className="rounded-md border border-subtle">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
      >
        {open ? (
          <ChevronDown className="size-3.5 shrink-0 text-tertiary" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-tertiary" />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-12 font-medium">
            {t(`file_library.contracts.task_type.${job.task_type.toLowerCase()}`)}
          </span>
          <span className="block truncate text-11 text-tertiary">
            {formatContractDateTime(job.created_at, currentLocale)}
            {total !== null ? ` · ${formatDuration(total)}` : ""}
            {usage?.total_cost_usd ? ` · ${formatCost(usage.total_cost_usd, currentLocale)}` : ""}
          </span>
        </span>
        <StatusChip job={job} />
      </button>

      {open && (
        <div className="space-y-2.5 border-t border-subtle px-3 py-2.5">
          {active && (
            <div aria-live="polite">
              <div
                role="progressbar"
                aria-label={currentLabel || t("file_library.contracts.processing.processing")}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={job.progress}
                className="h-1.5 overflow-hidden rounded-full bg-layer-1"
              >
                <div
                  className="h-full rounded-full bg-accent-primary transition-all"
                  style={{ width: `${job.progress}%` }}
                />
              </div>
              <div className="mt-1 flex items-center justify-between gap-2 text-11 text-tertiary">
                <span className="truncate">
                  {currentLabel}
                  {detail ? ` · ${detail}` : ""}
                </span>
                <span className="shrink-0 tabular-nums">{job.progress}%</span>
              </div>
            </div>
          )}

          {steps.length > 0 ? (
            <ol className="space-y-1">
              {steps.map((step) => {
                const duration = elapsedMs(step.started_at, step.status === "running" ? null : step.finished_at);
                const Icon = step.status === "running" ? Loader2 : step.status === "failed" ? XCircle : CheckCircle2;
                return (
                  <li key={`${step.code}-${step.started_at ?? ""}`} className="flex items-center gap-2 text-12">
                    <Icon
                      className={cn(
                        "size-3.5 shrink-0",
                        step.status === "running" && "animate-spin text-accent-primary",
                        step.status === "failed" && "text-danger-primary",
                        step.status === "done" && "text-success-primary"
                      )}
                      aria-hidden
                    />
                    <span className={cn("min-w-0 flex-1 truncate", !isStageCode(step.code) && "text-secondary")}>
                      {stageLabel(t, step.code)}
                    </span>
                    <span className="shrink-0 text-11 text-tertiary tabular-nums">
                      {duration !== null ? formatDuration(duration) : ""}
                    </span>
                  </li>
                );
              })}
            </ol>
          ) : (
            !active &&
            job.current_stage && (
              <p className="flex items-center gap-2 text-12 text-secondary">
                <Circle className="size-3 shrink-0 text-tertiary" aria-hidden />
                {currentLabel}
              </p>
            )
          )}

          {(job.status === "FAILED" || job.status === "CANCELLED") && (
            <div className="space-y-1 rounded-sm bg-danger-subtle px-2 py-1.5">
              <p className="text-12 text-danger-primary">{friendlyJobError(t, job)}</p>
              {job.error?.message && <ErrorDetails message={job.error.message} />}
            </div>
          )}

          {usage && usage.calls?.length > 0 && <UsageBreakdown usage={usage} />}

          {active && onCancel && (
            <div className="flex justify-end">
              <Button variant="secondary" size="sm" onClick={onCancel} disabled={isCancelling}>
                {isCancelling ? <Loader2 className="size-3.5 animate-spin" /> : <Ban className="size-3.5" />}
                {t("file_library.contracts.process.cancel")}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function UsageBreakdown({ usage }: { usage: NonNullable<NonNullable<TContractJob["metadata"]>["usage"]> }) {
  const { t, currentLocale } = useTranslation();
  const [open, setOpen] = useState(false);
  const tokens = (value: number) => new Intl.NumberFormat(currentLocale).format(value);
  return (
    <div className="text-11">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-1 text-tertiary hover:text-secondary"
      >
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        <span className="flex-1 text-left">{t("file_library.contracts.process.cost")}</span>
        <span className="font-medium text-secondary tabular-nums">
          {formatCost(usage.total_cost_usd ?? 0, currentLocale)}
        </span>
      </button>
      {open && (
        <table className="mt-1 w-full text-left text-10 text-tertiary">
          <thead>
            <tr>
              <th className="py-0.5 font-medium">{t("file_library.contracts.process.call")}</th>
              <th className="py-0.5 text-right font-medium">{t("file_library.contracts.process.tokens_in")}</th>
              <th className="py-0.5 text-right font-medium">{t("file_library.contracts.process.tokens_out")}</th>
              <th className="py-0.5 text-right font-medium">USD</th>
            </tr>
          </thead>
          <tbody>
            {usage.calls.map((call) => (
              <tr
                key={`${call.prompt}-${call.model}-${call.input_tokens}-${call.output_tokens}`}
                className="border-t border-subtle"
              >
                <td className="py-0.5">
                  <span className="text-secondary">{call.prompt}</span>
                  <span className="block truncate">{call.model}</span>
                </td>
                <td className="py-0.5 text-right tabular-nums">
                  {tokens(call.input_tokens)}
                  {call.cached_tokens ? (
                    <span className="block">
                      {t("file_library.contracts.process.cached", { count: tokens(call.cached_tokens) })}
                    </span>
                  ) : null}
                </td>
                <td className="py-0.5 text-right tabular-nums">{tokens(call.output_tokens)}</td>
                <td className="py-0.5 text-right tabular-nums">{formatCost(call.cost_usd ?? 0, currentLocale)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
