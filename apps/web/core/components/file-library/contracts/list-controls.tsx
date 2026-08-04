/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { Check, X } from "lucide-react";
// plane imports
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { cn } from "@plane/utils";

type SelectionCheckboxProps = {
  checked: boolean;
  onChange: () => void;
  label?: string;
};

export function ContractSelectionCheckbox({ checked, onChange, label }: SelectionCheckboxProps) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      aria-label={label ?? t("file_library.contracts.workflow.list.toggle_selection")}
      aria-pressed={checked}
      onClick={(event) => {
        event.stopPropagation();
        onChange();
      }}
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-sm border",
        checked ? "border-accent-strong bg-accent-primary text-on-color" : "border-strong"
      )}
    >
      {checked ? <Check className="size-3" /> : null}
    </button>
  );
}

type BulkActionsBarProps = {
  count: number;
  onClear: () => void;
  children: React.ReactNode;
};

export function ContractBulkActionsBar({ count, onClear, children }: BulkActionsBarProps) {
  const { t } = useTranslation();
  if (count === 0) return null;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-subtle bg-layer-1 px-3 py-2 sm:px-4">
      <span className="text-12 font-medium">{t("file_library.contracts.bulk.selected", { count })}</span>
      {children}
      <Button variant="tertiary" size="sm" onClick={onClear}>
        <X className="size-3.5" />
        {t("file_library.contracts.bulk.clear")}
      </Button>
    </div>
  );
}
