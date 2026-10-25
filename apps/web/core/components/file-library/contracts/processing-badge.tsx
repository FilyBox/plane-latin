/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { AlertTriangle, CheckCircle2, Clock, Loader2 } from "lucide-react";
// plane imports
import { useTranslation } from "@plane/i18n";
import { Tooltip } from "@plane/propel/tooltip";
import type { TContract, TContractJob } from "@plane/types";
import { cn } from "@plane/utils";
// local imports
import { stageLabel } from "./utils";

type Props = {
  contract: Pick<TContract, "processing_status">;
  /** Latest active job for this contract, if any (drives live progress) */
  activeJob?: TContractJob;
  /** Shown as the tooltip of the "Error" chip */
  errorMessage?: string | null;
};

/** "OCR 12/40"-style detail the worker reports while waiting on long steps */
export const stageDetail = (
  t: (key: string, params?: Record<string, unknown>) => string,
  job: TContractJob | undefined
): string | null => {
  const data = job?.metadata?.detail_data;
  if (data && typeof data.pages_done === "number" && typeof data.pages_total === "number") {
    return t("file_library.contracts.stage_detail.pages", { done: data.pages_done, total: data.pages_total });
  }
  return typeof job?.metadata?.detail === "string" ? job.metadata.detail : null;
};

/** Live pipeline state chip: stage + % while running, terminal state otherwise */
export function ProcessingBadge(props: Props) {
  const { contract, activeJob, errorMessage } = props;
  const { t } = useTranslation();

  if (activeJob || contract.processing_status === "PROCESSING") {
    const stage = stageLabel(t, activeJob?.current_stage) || t("file_library.contracts.processing.processing");
    const progress = activeJob?.progress ?? 0;
    const detail = stageDetail(t, activeJob);
    return (
      <Tooltip tooltipContent={detail ? `${stage} · ${detail}` : stage}>
        <span
          role="progressbar"
          aria-label={stage}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
          className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-accent-primary/10 px-2 py-0.5 text-11 font-medium text-accent-primary"
        >
          <Loader2 className="size-3 shrink-0 animate-spin" />
          <span className="truncate">{stage}</span>
          <span className="shrink-0 tabular-nums">{progress}%</span>
        </span>
      </Tooltip>
    );
  }

  const config = {
    PENDING: {
      icon: Clock,
      className: "bg-layer-1 text-tertiary",
      label: t("file_library.contracts.processing.pending"),
    },
    COMPLETED: {
      icon: CheckCircle2,
      className: "bg-success-subtle text-success-primary",
      label: t("file_library.contracts.processing.completed"),
    },
    ERROR: {
      icon: AlertTriangle,
      className: "bg-danger-subtle text-danger-primary",
      label: t("file_library.contracts.processing.error"),
    },
  }[contract.processing_status];

  const Icon = config.icon;
  const chip = (
    <span
      className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-11 font-medium", config.className)}
    >
      <Icon className="size-3 shrink-0" />
      {config.label}
    </span>
  );
  if (contract.processing_status === "ERROR" && errorMessage) {
    return <Tooltip tooltipContent={errorMessage}>{chip}</Tooltip>;
  }
  return chip;
}
