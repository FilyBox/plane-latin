/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Pencil, Repeat, Trash2 } from "lucide-react";
import { useTranslation } from "@plane/i18n";
import { Tooltip } from "@plane/propel/tooltip";
import type { TExpense } from "@plane/types";
import { cn } from "@plane/utils";
import { useIntersectionObserver } from "@/hooks/use-intersection-observer";
import { expenseTotals } from "@/lib/expense-ledger";
import { documentIcon } from "./document-kind";
import { formatMoney } from "./shared";

/** Rows rendered per batch. The ledger is already in memory, so "loading more"
 * is only about how much of it the browser is asked to lay out at once —
 * the same intersection-observer flow the work item spreadsheet uses. */
const PAGE_SIZE = 60;
const COLUMN_COUNT = 10;

type Props = {
  expenses: TExpense[];
  group?: string;
  onEdit: (expense: TExpense) => void;
  onDelete: (expense: TExpense) => void;
  onPreview: (expense: TExpense, index: number) => void;
  onQuickEdit: (expense: TExpense, patch: Partial<TExpense>) => Promise<void>;
};

function QuickCell({
  value,
  label,
  onSave,
  type = "text",
  children,
}: {
  value: string;
  label: string;
  type?: string;
  onSave: (value: string) => Promise<void>;
  /** Display for the resting state. Defaults to the raw value. */
  children?: React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (busy) return;
    if (draft === value) {
      setEditing(false);
      return;
    }
    setBusy(true);
    try {
      await onSave(draft);
      setEditing(false);
    } catch {
      /* Parent reports the error; keep the draft. */
    } finally {
      setBusy(false);
    }
  };
  return editing ? (
    <input
      aria-label={label}
      autoFocus
      type={type}
      step={type === "number" ? "0.01" : undefined}
      min={type === "number" ? "0" : undefined}
      value={draft}
      disabled={busy}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => void save()}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          event.preventDefault();
          setEditing(false);
        }
      }}
      className="border-accent-primary h-7 w-full min-w-24 rounded-sm border bg-surface-1 px-2 outline-none"
    />
  ) : (
    <button
      type="button"
      title={label}
      onClick={() => {
        setDraft(value);
        setEditing(true);
      }}
      className="focus-visible:ring-accent-primary flex h-7 w-full items-center truncate rounded-sm px-1 text-left hover:bg-layer-2 focus-visible:ring-2"
    >
      {children ?? (value || "—")}
    </button>
  );
}

/** A single chip plus "+N" for the rest — what keeps a row one line tall no
 * matter how many tags or receipts hang off it. */
function OverflowRow({
  items,
  extraLabel,
  onOverflowClick,
}: {
  items: { node: React.ReactNode; title: string }[];
  extraLabel: string;
  onOverflowClick?: () => void;
}) {
  if (items.length === 0) return <span className="text-tertiary">—</span>;
  const [first, ...rest] = items;
  return (
    <div className="flex min-w-0 items-center gap-1">
      {first.node}
      {rest.length > 0 && (
        <Tooltip tooltipContent={rest.map((item) => item.title).join(", ")}>
          <button
            type="button"
            onClick={onOverflowClick}
            aria-label={extraLabel}
            className="shrink-0 rounded-sm border border-subtle bg-layer-2 px-1.5 py-0.5 text-10 text-secondary hover:bg-layer-1-hover"
          >
            +{rest.length}
          </button>
        </Tooltip>
      )}
    </div>
  );
}

export function ExpenseTable({ expenses, group = "none", onEdit, onDelete, onPreview, onQuickEdit }: Props) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [sentinel, setSentinel] = useState<HTMLTableSectionElement | null>(null);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  // A new filter or ordering is a new list; start it from the top again.
  useEffect(() => setVisibleCount(PAGE_SIZE), [expenses, group]);

  const canLoadMore = visibleCount < expenses.length;
  useIntersectionObserver(
    scrollRef,
    canLoadMore ? sentinel : null,
    () => setVisibleCount((current) => current + PAGE_SIZE),
    "100% 0% 100% 0%"
  );

  const groups = useMemo(() => {
    const result = new Map<string, TExpense[]>();
    for (const expense of expenses.slice(0, visibleCount)) {
      const key =
        group === "category"
          ? expense.category_name || "—"
          : group === "status"
            ? t(`payments.status.${expense.status.toLowerCase()}`)
            : group === "tag"
              ? expense.tags?.[0] || "—"
              : "";
      result.set(key, [...(result.get(key) ?? []), expense]);
    }
    return [...result];
  }, [expenses, visibleCount, group, t]);

  // Totals always cover every filtered expense, not just the rendered window.
  const totals = expenseTotals(expenses);

  const th =
    "h-10 border-b border-r border-subtle bg-layer-2 px-3 text-left text-11 font-medium text-tertiary whitespace-nowrap";
  const td = "h-11 border-b border-r border-subtle px-3 text-11 text-secondary";

  return (
    <div className="shadow-sm min-h-0 flex-1 overflow-auto rounded-lg border border-subtle bg-layer-1" ref={scrollRef}>
      <table className="h-full w-max min-w-full border-separate border-spacing-0 text-11">
        <thead className="sticky top-0 z-3 bg-layer-2">
          <tr>
            <th className={cn(th, "sticky left-0 z-4 min-w-56")}>{t("payments.sheet.concept")}</th>
            <th className={cn(th, "min-w-28")}>{t("payments.fields.date")}</th>
            <th className={cn(th, "min-w-32")}>{t("payments.fields.vendor")}</th>
            <th className={cn(th, "min-w-40")}>{t("payments.fields.description")}</th>
            <th className={cn(th, "min-w-32")}>{t("payments.fields.category")}</th>
            <th className={cn(th, "min-w-36")}>{t("payments.ledger.tags")}</th>
            <th className={cn(th, "min-w-32")}>{t("payments.fields.reference")}</th>
            <th className={cn(th, "min-w-28")}>{t("payments.fields.status")}</th>
            <th className={cn(th, "min-w-40")}>{t("payments.fields.documents")}</th>
            <th className={cn(th, "sticky right-0 z-4 min-w-44 border-l text-right")}>
              {t("payments.fields.amount")}
            </th>
          </tr>
        </thead>
        <tbody>
          {groups.map(([key, rows]) => (
            <Fragment key={key}>
              {key && (
                <tr>
                  <td colSpan={COLUMN_COUNT} className="h-9 border-b border-subtle bg-layer-2 px-3 text-11 font-medium">
                    <span className="sticky left-3">
                      {key} · {rows.length}
                    </span>
                  </td>
                </tr>
              )}
              {rows.map((expense) => (
                <tr key={expense.id} className="group hover:bg-layer-1-hover">
                  <td
                    className={cn(td, "sticky left-0 z-2 max-w-64 bg-layer-1 group-hover:bg-layer-1-hover")}
                  >
                    <div className="flex items-center gap-1">
                      <QuickCell
                        value={expense.concept || expense.vendor || expense.description}
                        label={t("payments.sheet.concept")}
                        onSave={(concept) => onQuickEdit(expense, { concept })}
                      >
                        <span className="truncate font-medium text-primary">
                          {expense.concept || expense.vendor || expense.description || "—"}
                        </span>
                      </QuickCell>
                      {(expense.recurrence !== "ONE_TIME" || expense.series) && (
                        <Repeat className="size-3.5 shrink-0 text-tertiary" aria-label={t("payments.ledger.recurring")} />
                      )}
                    </div>
                  </td>
                  <td className={td}>
                    <QuickCell
                      value={expense.expense_date}
                      type="date"
                      label={t("payments.fields.date")}
                      onSave={(expense_date) => onQuickEdit(expense, { expense_date })}
                    />
                  </td>
                  <td className={cn(td, "max-w-40")}>
                    <QuickCell
                      value={expense.vendor}
                      label={t("payments.fields.vendor")}
                      onSave={(vendor) => onQuickEdit(expense, { vendor })}
                    />
                  </td>
                  <td className={cn(td, "max-w-56")}>
                    <QuickCell
                      value={expense.description}
                      label={t("payments.fields.description")}
                      onSave={(description) => onQuickEdit(expense, { description })}
                    />
                  </td>
                  <td className={cn(td, "max-w-40 truncate")}>{expense.category_name || "—"}</td>
                  <td className={cn(td, "max-w-44")}>
                    <QuickCell
                      value={(expense.tags ?? []).join(", ")}
                      label={t("payments.ledger.tags")}
                      onSave={(tags) =>
                        onQuickEdit(expense, {
                          tags: tags
                            .split(",")
                            .map((tag) => tag.trim())
                            .filter(Boolean),
                        })
                      }
                    >
                      <OverflowRow
                        extraLabel={t("payments.ledger.tags")}
                        items={(expense.tags ?? []).map((tag) => ({
                          title: tag,
                          node: (
                            <span className="flex min-w-0 items-center gap-1.5 rounded-sm border border-subtle bg-layer-2 px-1.5 py-0.5 text-10 text-secondary">
                              <span className="size-1.5 shrink-0 rounded-full bg-accent-primary" />
                              <span className="truncate">{tag}</span>
                            </span>
                          ),
                        }))}
                      />
                    </QuickCell>
                  </td>
                  <td className={cn(td, "max-w-40")}>
                    <QuickCell
                      value={expense.reference}
                      label={t("payments.fields.reference")}
                      onSave={(reference) => onQuickEdit(expense, { reference })}
                    />
                  </td>
                  <td className={td}>
                    <select
                      aria-label={t("payments.fields.status")}
                      value={expense.status}
                      className="h-7 rounded-sm border border-subtle bg-layer-1 px-1 text-11"
                      onChange={(event) =>
                        void onQuickEdit(expense, {
                          status: event.target.value as TExpense["status"],
                          paid_at: event.target.value === "PAID" ? expense.paid_at || expense.expense_date : null,
                        }).catch(() => undefined)
                      }
                    >
                      {(["PENDING", "PAID", "CANCELLED"] as const).map((status) => (
                        <option key={status} value={status}>
                          {t(`payments.status.${status.toLowerCase()}`)}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className={cn(td, "max-w-44")}>
                    <OverflowRow
                      extraLabel={t("payments.fields.documents")}
                      onOverflowClick={() => onPreview(expense, 1)}
                      items={expense.documents.map((doc, index) => ({
                        title: doc.name,
                        node: (
                          <button
                            type="button"
                            onClick={() => onPreview(expense, index)}
                            title={doc.name}
                            className="flex min-w-0 max-w-32 items-center gap-1.5 rounded-sm border border-subtle bg-layer-1 py-0.5 pr-2 pl-1 hover:bg-layer-2"
                          >
                            <span className="size-4 shrink-0">{documentIcon(doc.name, 16)}</span>
                            <span className="truncate">{doc.name}</span>
                          </button>
                        ),
                      }))}
                    />
                  </td>
                  <td className={cn(td, "sticky right-0 z-2 border-l bg-layer-1 group-hover:bg-layer-1-hover")}>
                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => onEdit(expense)}
                        className={cn(
                          "font-semibold whitespace-nowrap tabular-nums",
                          expense.status === "CANCELLED" ? "text-tertiary line-through" : "text-primary"
                        )}
                      >
                        {formatMoney(expense.amount, expense.currency)}
                      </button>
                      <button
                        type="button"
                        onClick={() => onEdit(expense)}
                        aria-label={t("payments.edit_expense")}
                        className="rounded p-1 opacity-0 group-hover:opacity-100 hover:bg-layer-2 focus:opacity-100"
                      >
                        <Pencil className="size-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => onDelete(expense)}
                        aria-label={t("payments.actions.delete")}
                        className="rounded p-1 opacity-0 group-hover:opacity-100 hover:text-danger-primary focus:opacity-100"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </Fragment>
          ))}
          {/* Absorbs the leftover height so the totals row stays welded to the
              bottom edge even when the ledger holds a single expense. */}
          <tr aria-hidden="true" className="h-full">
            <td colSpan={COLUMN_COUNT} />
          </tr>
        </tbody>
        {canLoadMore && (
          <tbody ref={setSentinel}>
            {Array.from({ length: 3 }).map((_, index) => (
              <tr key={index} className="animate-pulse">
                <td colSpan={COLUMN_COUNT} className="h-11 border-b border-subtle px-3">
                  <span className="block h-3 w-40 rounded bg-layer-2" />
                </td>
              </tr>
            ))}
          </tbody>
        )}
        <tfoot className="sticky bottom-0 z-3 bg-layer-2">
          {totals.map((total, index) => (
            <tr key={total.currency}>
              <td className="sticky left-0 z-4 h-11 border-t border-r border-subtle bg-layer-2 px-3 font-semibold text-primary">
                {t("payments.ledger.total")} · {total.currency}
              </td>
              <td colSpan={COLUMN_COUNT - 2} className="border-t border-r border-subtle px-3 text-10 text-tertiary">
                <span className="sticky left-3 flex flex-wrap items-center gap-x-4 gap-y-1">
                  {index === 0 && (
                    <span className="font-medium text-secondary">
                      {expenses.length} {t("payments.expenses").toLowerCase()}
                    </span>
                  )}
                  <span>
                    {t("payments.ledger.paid")}: {formatMoney(total.paid, total.currency)}
                  </span>
                  <span>
                    {t("payments.ledger.pending")}: {formatMoney(total.pending, total.currency)}
                  </span>
                  {index === 0 && <span className="hidden lg:inline">{t("payments.ledger.totals_help")}</span>}
                </span>
              </td>
              <td className="sticky right-0 z-4 h-11 border-t border-l border-subtle bg-layer-2 px-3 text-right font-semibold text-primary tabular-nums">
                {formatMoney(total.total, total.currency)}
              </td>
            </tr>
          ))}
        </tfoot>
      </table>
    </div>
  );
}
