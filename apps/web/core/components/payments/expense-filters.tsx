/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import { Check, Filter, Repeat, Search, SlidersHorizontal, Tags, Wallet, X } from "lucide-react";
import { useTranslation } from "@plane/i18n";
import { Menu } from "@plane/propel/menu";
import { Popover } from "@plane/propel/popover";
import type { TExpenseCategory, TExpenseStatus } from "@plane/types";
import { cn } from "@plane/utils";

export type TExpenseFilters = {
  from: string;
  to: string;
  categories: string[];
  currencies: string[];
  tags: string[];
  statuses: TExpenseStatus[];
  recurring: boolean;
};

export const EMPTY_EXPENSE_FILTERS: TExpenseFilters = {
  from: "",
  to: "",
  categories: [],
  currencies: [],
  tags: [],
  statuses: [],
  recurring: false,
};

export const EXPENSE_GROUPS = ["none", "category", "status", "tag"] as const;
export const EXPENSE_SORTS = ["date_desc", "date_asc", "amount_desc", "concept_asc"] as const;

/** Every filter the user has narrowed by — the badge on the button and the
 * "clear" affordances both count the same way.
 */
export const countExpenseFilters = (filters: TExpenseFilters): number =>
  (filters.from ? 1 : 0) +
  (filters.to ? 1 : 0) +
  (filters.recurring ? 1 : 0) +
  filters.categories.length +
  filters.currencies.length +
  filters.tags.length +
  filters.statuses.length;

const STATUSES: TExpenseStatus[] = ["PENDING", "PAID", "CANCELLED"];
const DATE_FIELD =
  "h-7 w-full rounded-sm border border-subtle bg-layer-1 px-1.5 text-11 text-primary outline-none focus:border-accent-primary";

type Props = {
  filters: TExpenseFilters;
  categories: TExpenseCategory[];
  currencies: string[];
  tags: string[];
  onChange: (filters: TExpenseFilters) => void;
};

/**
 * One button, everything behind it — the same shape work items use, so the
 * toolbar stays a row of verbs instead of a wall of selects.
 */
export function ExpenseFiltersDropdown({ filters, categories, currencies, tags, onChange }: Props) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const activeCount = countExpenseFilters(filters);
  const query = search.trim().toLocaleLowerCase();

  const toggle = <K extends "categories" | "currencies" | "tags" | "statuses">(key: K, value: string) =>
    onChange({
      ...filters,
      [key]: (filters[key] as string[]).includes(value)
        ? (filters[key] as string[]).filter((item) => item !== value)
        : [...(filters[key] as string[]), value],
    });

  const sections = [
    {
      key: "statuses" as const,
      label: t("payments.fields.status"),
      icon: Wallet,
      options: STATUSES.map((status) => ({ id: status, name: t(`payments.status.${status.toLowerCase()}`) })),
    },
    {
      key: "categories" as const,
      label: t("payments.fields.category"),
      icon: Tags,
      options: [
        { id: "none", name: t("payments.ledger.uncategorized") },
        ...categories.map((category) => ({ id: category.id, name: category.name })),
      ],
    },
    {
      key: "currencies" as const,
      label: t("payments.fields.currency"),
      icon: Wallet,
      options: currencies.map((currency) => ({ id: currency, name: currency })),
    },
    {
      key: "tags" as const,
      label: t("payments.ledger.tags"),
      icon: Tags,
      options: tags.map((tag) => ({ id: tag, name: tag })),
    },
  ];

  return (
    <Popover modal>
      <Popover.Button
        className={cn(
          "flex h-8 items-center gap-1.5 rounded-sm border border-subtle px-2.5 text-12 text-secondary hover:bg-layer-1-hover",
          activeCount > 0 && "border-accent-strong text-accent-primary"
        )}
      >
        <Filter className="size-3.5" />
        {t("payments.ledger.filters")}
        {activeCount > 0 && (
          <span className="rounded-full bg-accent-primary px-1.5 text-10 text-on-color">{activeCount}</span>
        )}
      </Popover.Button>
      <Popover.Panel positionerClassName="z-100" side="bottom" align="start">
        <div className="w-72 rounded-md border border-subtle bg-layer-1 p-2 shadow-raised-200">
          <div className="relative mb-2">
            <Search className="absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-tertiary" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("payments.filters.search")}
              className="w-full rounded-sm border border-subtle bg-transparent py-1 pr-2 pl-7 text-12 outline-none focus:border-accent-primary"
            />
          </div>
          <div className="max-h-80 space-y-2 overflow-y-auto">
            {!query && (
              <div>
                <p className="px-1 py-0.5 text-11 font-medium text-tertiary">{t("payments.fields.period")}</p>
                <div className="grid grid-cols-2 gap-2 px-1 pt-1">
                  {(["from", "to"] as const).map((key) => (
                    <label key={key} className="text-10 text-tertiary">
                      {t(`payments.filters.${key}`)}
                      <input
                        type="date"
                        className={DATE_FIELD}
                        value={filters[key]}
                        onChange={(event) => onChange({ ...filters, [key]: event.target.value })}
                      />
                    </label>
                  ))}
                </div>
              </div>
            )}
            {sections.map((section) => {
              const options = section.options.filter((option) => !query || option.name.toLowerCase().includes(query));
              if (options.length === 0) return null;
              return (
                <div key={section.key}>
                  <p className="flex items-center gap-1 px-1 py-0.5 text-11 font-medium text-tertiary">
                    <section.icon className="size-3" />
                    {section.label}
                  </p>
                  {options.map((option) => {
                    const isChecked = (filters[section.key] as string[]).includes(option.id);
                    return (
                      <button
                        key={option.id}
                        type="button"
                        onClick={() => toggle(section.key, option.id)}
                        className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-13 hover:bg-layer-1-hover"
                      >
                        <span
                          className={cn(
                            "flex size-4 shrink-0 items-center justify-center rounded-sm border",
                            isChecked ? "border-accent-strong bg-accent-primary text-on-color" : "border-strong"
                          )}
                        >
                          {isChecked && <Check className="size-3" />}
                        </span>
                        <span className="truncate">{option.name}</span>
                      </button>
                    );
                  })}
                </div>
              );
            })}
            {!query && (
              <div>
                <p className="flex items-center gap-1 px-1 py-0.5 text-11 font-medium text-tertiary">
                  <Repeat className="size-3" />
                  {t("payments.ledger.recurrence")}
                </p>
                <button
                  type="button"
                  onClick={() => onChange({ ...filters, recurring: !filters.recurring })}
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-13 hover:bg-layer-1-hover"
                >
                  <span
                    className={cn(
                      "flex size-4 shrink-0 items-center justify-center rounded-sm border",
                      filters.recurring ? "border-accent-strong bg-accent-primary text-on-color" : "border-strong"
                    )}
                  >
                    {filters.recurring && <Check className="size-3" />}
                  </span>
                  <span className="truncate">{t("payments.ledger.recurring")}</span>
                </button>
              </div>
            )}
          </div>
          {activeCount > 0 && (
            <button
              type="button"
              onClick={() => onChange(EMPTY_EXPENSE_FILTERS)}
              className="mt-2 w-full rounded-sm border-t border-subtle pt-2 text-12 text-accent-primary"
            >
              {t("payments.ledger.clear")}
            </button>
          )}
        </div>
      </Popover.Panel>
    </Popover>
  );
}

/** Grouping and ordering live together under "Display", away from the filters —
 * they change how the same rows are shown, not which rows there are.
 */
export function ExpenseDisplayMenu({
  group,
  sort,
  onGroupChange,
  onSortChange,
}: {
  group: string;
  sort: string;
  onGroupChange: (group: string) => void;
  onSortChange: (sort: string) => void;
}) {
  const { t } = useTranslation();

  return (
    <Menu
      customButton={
        <span className="flex h-8 items-center gap-1.5 rounded-sm border border-subtle px-2.5 text-12 text-secondary hover:bg-layer-1-hover">
          <SlidersHorizontal className="size-3.5" />
          {t("payments.ledger.display")}
        </span>
      }
      optionsClassName="w-56"
      maxHeight="lg"
      ariaLabel={t("payments.ledger.display")}
    >
      <p className="px-1 pb-1 text-11 font-medium text-tertiary">{t("payments.ledger.group")}</p>
      {EXPENSE_GROUPS.map((key) => (
        <Menu.MenuItem key={key} onClick={() => onGroupChange(key)}>
          <span className="flex items-center justify-between gap-2 text-12">
            {t(key === "none" ? "payments.ledger.none" : `payments.ledger.group_by_${key}`)}
            {group === key && <Check className="size-3.5 text-accent-primary" />}
          </span>
        </Menu.MenuItem>
      ))}
      <p className="mt-2 border-t border-subtle px-1 pt-2 pb-1 text-11 font-medium text-tertiary">
        {t("payments.ledger.sort")}
      </p>
      {EXPENSE_SORTS.map((key) => (
        <Menu.MenuItem key={key} onClick={() => onSortChange(key)}>
          <span className="flex items-center justify-between gap-2 text-12">
            {t(`payments.ledger.${key}`)}
            {sort === key && <Check className="size-3.5 text-accent-primary" />}
          </span>
        </Menu.MenuItem>
      ))}
    </Menu>
  );
}

/** Applied filters as removable chips, so what is narrowing the table is
 * visible without reopening the dropdown.
 */
export function AppliedExpenseFilters({
  filters,
  categories,
  onChange,
}: {
  filters: TExpenseFilters;
  categories: TExpenseCategory[];
  onChange: (filters: TExpenseFilters) => void;
}) {
  const { t } = useTranslation();
  if (countExpenseFilters(filters) === 0) return null;

  const categoryName = (id: string) =>
    id === "none" ? t("payments.ledger.uncategorized") : (categories.find((item) => item.id === id)?.name ?? id);

  const chips: { key: string; label: string; onRemove: () => void }[] = [
    ...filters.statuses.map((status) => ({
      key: `status-${status}`,
      label: t(`payments.status.${status.toLowerCase()}`),
      onRemove: () => onChange({ ...filters, statuses: filters.statuses.filter((item) => item !== status) }),
    })),
    ...filters.categories.map((category) => ({
      key: `category-${category}`,
      label: categoryName(category),
      onRemove: () => onChange({ ...filters, categories: filters.categories.filter((item) => item !== category) }),
    })),
    ...filters.currencies.map((currency) => ({
      key: `currency-${currency}`,
      label: currency,
      onRemove: () => onChange({ ...filters, currencies: filters.currencies.filter((item) => item !== currency) }),
    })),
    ...filters.tags.map((tag) => ({
      key: `tag-${tag}`,
      label: tag,
      onRemove: () => onChange({ ...filters, tags: filters.tags.filter((item) => item !== tag) }),
    })),
  ];
  if (filters.from)
    chips.push({
      key: "from",
      label: `${t("payments.filters.from")}: ${filters.from}`,
      onRemove: () => onChange({ ...filters, from: "" }),
    });
  if (filters.to)
    chips.push({
      key: "to",
      label: `${t("payments.filters.to")}: ${filters.to}`,
      onRemove: () => onChange({ ...filters, to: "" }),
    });
  if (filters.recurring)
    chips.push({
      key: "recurring",
      label: t("payments.ledger.recurring"),
      onRemove: () => onChange({ ...filters, recurring: false }),
    });

  return (
    <div className="flex flex-wrap items-center gap-1.5 px-4 pb-3 sm:px-5">
      {chips.map((chip) => (
        <span
          key={chip.key}
          className="flex items-center gap-1 rounded-sm border border-subtle bg-layer-1 px-2 py-1 text-11 text-secondary"
        >
          {chip.label}
          <button
            type="button"
            onClick={chip.onRemove}
            aria-label={`${t("payments.ledger.clear")} ${chip.label}`}
            className="text-tertiary hover:text-danger-primary"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <button
        type="button"
        onClick={() => onChange(EMPTY_EXPENSE_FILTERS)}
        className="px-1 text-11 text-accent-primary hover:underline"
      >
        {t("payments.ledger.clear")}
      </button>
    </div>
  );
}
