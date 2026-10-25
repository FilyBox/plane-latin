/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * Parser warnings for a template ({{FechaFirma}} becoming a signing field,
 * names with spaces, missing signers…), worded for the person writing it.
 */

import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { useTranslation } from "@plane/i18n";
import type { TContractTemplateWarning } from "@plane/types";
import { cn } from "@plane/utils";
import { warningMessage } from "./template-utils";

const COLLAPSED_COUNT = 3;

export function TemplateWarnings({
  warnings,
  className,
  compact = false,
}: {
  warnings: TContractTemplateWarning[];
  className?: string;
  /** Smaller type for side panels. */
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  if (warnings.length === 0) return null;
  const visible = expanded ? warnings : warnings.slice(0, COLLAPSED_COUNT);

  return (
    <div className={cn("rounded-lg bg-warning-primary/10 px-3 py-2.5", className)}>
      <p className={cn("flex items-center gap-1.5 font-medium text-warning-primary", compact ? "text-11" : "text-12")}>
        <AlertTriangle className="size-3.5 shrink-0" />
        {t("file_library.contracts.workflow.warnings.title", { count: warnings.length })}
      </p>
      <ul className="mt-1.5 space-y-1">
        {visible.map((warning) => (
          <li
            key={`${warning.code}:${warning.token ?? ""}:${JSON.stringify(warning.params ?? {})}`}
            className={cn("leading-snug text-secondary", compact ? "text-11" : "text-12")}
          >
            {warningMessage(t, warning)}
          </li>
        ))}
      </ul>
      {warnings.length > COLLAPSED_COUNT ? (
        <button
          type="button"
          className="mt-1.5 text-11 font-medium text-warning-primary hover:underline"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded
            ? t("file_library.contracts.workflow.warnings.show_less")
            : t("file_library.contracts.workflow.warnings.show_all", { count: warnings.length })}
        </button>
      ) : null}
    </div>
  );
}
