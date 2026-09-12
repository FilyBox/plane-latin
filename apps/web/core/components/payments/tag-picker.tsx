/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import { ChevronsUpDown, X } from "lucide-react";
import { useTranslation } from "@plane/i18n";
import {
  CataloguePanel,
  useCatalogueOutsideClose,
  useCategorySource,
  useOfficeSource,
  type CatalogueSource,
} from "./catalogue-picker";

/** Many names on one record — the work item label pattern. Stores names, so a
 * budget line and an expense can carry the same tag without sharing a row. */
export function FinanceTagPicker({
  workspaceSlug,
  value,
  onChange,
}: {
  workspaceSlug: string;
  value: string[];
  onChange: (tags: string[]) => void;
}) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const ref = useCatalogueOutsideClose(isOpen, () => setIsOpen(false));
  const source = useCategorySource(workspaceSlug);

  const toggle = (name: string) =>
    onChange(value.includes(name) ? value.filter((item) => item !== name) : [...value, name]);
  const selectedIds = source.items.filter((item) => value.includes(item.name)).map((item) => item.id);

  return (
    <div ref={ref} className="relative w-full">
      <div className="flex min-h-7.5 flex-wrap items-center gap-1">
        {value.map((tag) => (
          <span
            key={tag}
            className="flex items-center gap-1 rounded-sm bg-layer-1 px-1.5 py-0.5 text-body-xs-regular text-secondary"
          >
            {tag}
            <button
              type="button"
              onClick={() => toggle(tag)}
              aria-label={`${t("common.remove")} ${tag}`}
              className="text-tertiary hover:text-danger-primary"
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        <button
          type="button"
          onClick={() => setIsOpen((open) => !open)}
          className="flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-body-xs-regular text-tertiary hover:bg-layer-1 hover:text-primary"
        >
          {value.length === 0 && t("payments.ledger.tags")}
          <ChevronsUpDown className="size-3" />
        </button>
      </div>

      {isOpen && (
        <CataloguePanel
          className="absolute top-full left-0 z-30 mt-1"
          source={source}
          selected={selectedIds}
          allowClear={value.length > 0}
          onPick={(item) => toggle(item.name)}
          onClear={() => onChange([])}
          onRenamed={(item, name) => onChange(value.map((entry) => (entry === item.name ? name : entry)))}
          onRemoved={(item) => onChange(value.filter((entry) => entry !== item.name))}
          onClose={() => setIsOpen(false)}
        />
      )}
    </div>
  );
}

type SingleProps = {
  workspaceSlug: string;
  /** The id currently set, or "" for none. */
  value: string;
  onChange: (id: string) => void;
  placeholderKey?: string;
  /** Whether "none" is a legal answer. An office is not. */
  clearable?: boolean;
};

function SingleSelect({
  source,
  value,
  onChange,
  placeholderKey,
  clearable = true,
}: SingleProps & { source: CatalogueSource }) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const ref = useCatalogueOutsideClose(isOpen, () => setIsOpen(false));
  const selected = source.items.find((item) => item.id === value);

  return (
    <div ref={ref} className="relative w-full">
      <button
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        className="flex h-7.5 w-full items-center justify-between gap-1 rounded-sm border border-transparent px-1.5 text-body-xs-medium hover:border-subtle hover:bg-layer-1"
      >
        <span className={selected ? "truncate" : "truncate text-tertiary"}>
          {selected?.name ?? t(placeholderKey ?? "payments.ledger.uncategorized")}
        </span>
        <ChevronsUpDown className="size-3 shrink-0 text-tertiary" />
      </button>

      {isOpen && (
        <CataloguePanel
          className="absolute top-full left-0 z-30 mt-1"
          source={source}
          selected={value ? [value] : []}
          allowClear={clearable}
          onPick={(item) => {
            onChange(item.id);
            setIsOpen(false);
          }}
          onClear={() => {
            onChange("");
            setIsOpen(false);
          }}
          onRemoved={(item) => item.id === value && onChange("")}
          onClose={() => setIsOpen(false)}
        />
      )}
    </div>
  );
}

/** One category per record, stored by id — what the budget-versus-spent report
 * groups on. Clearing it is a first-class choice, not "pick another". */
export function FinanceCategorySelect(props: SingleProps) {
  return <SingleSelect {...props} source={useCategorySource(props.workspaceSlug)} />;
}

/** The office a salary or a concept is charged to. */
export function FinanceOfficeSelect(props: SingleProps) {
  return (
    <SingleSelect
      {...props}
      clearable={false}
      source={useOfficeSource(props.workspaceSlug)}
      placeholderKey="payroll.fields.office"
    />
  );
}
