/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, FileText, Image as ImageIcon, Pencil, Trash2 } from "lucide-react";
// plane imports
import { useTranslation } from "@plane/i18n";
import type { TExpense, TExpenseStatus } from "@plane/types";
import { cn } from "@plane/utils";
// local imports
import { formatMoney } from "./shared";

const STATUS_STYLES: Record<TExpenseStatus, string> = {
  PAID: "bg-success-primary/10 text-success-primary",
  PENDING: "bg-warning-primary/10 text-warning-primary",
  CANCELLED: "bg-layer-2 text-tertiary",
};

const STATUS_KEYS: Record<TExpenseStatus, string> = {
  PAID: "payments.status.paid",
  PENDING: "payments.status.pending",
  CANCELLED: "payments.status.cancelled",
};

const PAGE_SIZES = [10, 25, 50, 100];

const isImage = (type: string) => (type ?? "").startsWith("image/");

/** One slot in the pager: a clickable page, or a gap ("…"). Each carries its
 *  own React key so rendering never has to fall back on the array index. */
type PageSlot = { key: string; page: number | null };

/** Compact page-number list with ellipses: 1 … 4 5 [6] 7 8 … 20 */
const pageWindow = (current: number, total: number): PageSlot[] => {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => ({ key: `p${i + 1}`, page: i + 1 }));
  }
  const pages = new Set<number>([1, total, current, current - 1, current + 1]);
  const sorted = [...pages].filter((page) => page >= 1 && page <= total).sort((a, b) => a - b);
  const out: PageSlot[] = [];
  let previous = 0;
  for (const page of sorted) {
    // Each gap sits after a distinct page number, so that number keys it
    // uniquely — no dependence on the loop index.
    if (page - previous > 1) out.push({ key: `gap-after-${previous}`, page: null });
    out.push({ key: `p${page}`, page });
    previous = page;
  }
  return out;
};

type Props = {
  expenses: TExpense[];
  onEdit: (expense: TExpense) => void;
  onDelete: (expense: TExpense) => void;
  /** The viewer pages through the whole expense, so it needs which one was clicked */
  onPreview: (expense: TExpense, index: number) => void;
};

export function ExpenseTable(props: Props) {
  const { expenses, onEdit, onDelete, onPreview } = props;
  const { t } = useTranslation();
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0]);
  const [page, setPage] = useState(1);

  const total = expenses.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  // Filters change the list under our feet: clamp the page so it never points
  // past the end (deleting the last row of page 5, say, drops us to page 4).
  useEffect(() => {
    setPage((current) => Math.min(current, pageCount));
  }, [pageCount]);

  const pageRows = useMemo(() => {
    const start = (page - 1) * pageSize;
    return expenses.slice(start, start + pageSize);
  }, [expenses, page, pageSize]);

  if (expenses.length === 0) {
    return (
      <div className="rounded-md border border-subtle px-4 py-8 text-center text-13 text-tertiary">
        {t("payments.empty.expenses")}
      </div>
    );
  }

  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  return (
    <div className="space-y-2">
      {/* The table scrolls inside its own box so the page never scrolls sideways */}
      <div className="overflow-x-auto rounded-md border border-subtle">
        <table className="w-full min-w-[720px] text-13">
          <thead className="border-b border-subtle text-11 text-tertiary uppercase">
            <tr>
              <th className="px-3 py-2 text-left font-medium">{t("payments.fields.date")}</th>
              <th className="px-3 py-2 text-left font-medium">{t("payments.fields.vendor")}</th>
              <th className="px-3 py-2 text-left font-medium">{t("payments.fields.category")}</th>
              <th className="px-3 py-2 text-left font-medium">{t("payments.fields.reference")}</th>
              <th className="px-3 py-2 text-left font-medium">{t("payments.fields.status")}</th>
              <th className="px-3 py-2 text-left font-medium">{t("payments.fields.documents")}</th>
              {/* Money is right-aligned so the decimal points line up down the column */}
              <th className="px-3 py-2 text-right font-medium">{t("payments.fields.amount")}</th>
              <th className="w-20 px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {pageRows.map((expense) => (
              <tr key={expense.id} className="border-b border-subtle last:border-0 hover:bg-layer-1-hover">
                <td className="px-3 py-2 whitespace-nowrap text-secondary">{expense.expense_date}</td>
                <td className="max-w-48 truncate px-3 py-2">{expense.vendor || "—"}</td>
                <td className="px-3 py-2 text-secondary">{expense.category_name ?? "—"}</td>
                <td className="px-3 py-2 text-secondary">{expense.reference || "—"}</td>
                <td className="px-3 py-2">
                  <span className={cn("rounded-full px-2 py-0.5 text-11", STATUS_STYLES[expense.status])}>
                    {t(STATUS_KEYS[expense.status])}
                  </span>
                </td>
                {/* One chip per document — click opens the PDF/image viewer */}
                <td className="px-3 py-2">
                  {expense.documents.length === 0 ? (
                    <span className="text-tertiary">—</span>
                  ) : (
                    <div className="flex flex-wrap items-center gap-1">
                      {expense.documents.map((document, index) => (
                        <button
                          key={document.asset_id}
                          type="button"
                          onClick={() => onPreview(expense, index)}
                          title={document.name}
                          className="flex max-w-32 items-center gap-1 rounded-full bg-layer-2 px-2 py-0.5 text-11 text-secondary hover:bg-layer-1-hover hover:text-primary"
                        >
                          {isImage(document.type) ? (
                            <ImageIcon className="size-3 shrink-0" />
                          ) : (
                            <FileText className="size-3 shrink-0" />
                          )}
                          <span className="truncate">{document.name}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </td>
                <td
                  className={cn(
                    "px-3 py-2 text-right font-medium whitespace-nowrap tabular-nums",
                    expense.status === "CANCELLED" && "text-tertiary line-through"
                  )}
                >
                  {formatMoney(expense.amount, expense.currency)}
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center justify-end gap-1">
                    <button
                      type="button"
                      onClick={() => onEdit(expense)}
                      title={t("payments.edit_expense")}
                      className="rounded-sm p-1 text-tertiary hover:bg-layer-1-hover hover:text-primary"
                    >
                      <Pencil className="size-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onDelete(expense)}
                      title={t("payments.actions.delete")}
                      className="rounded-sm p-1 text-tertiary hover:bg-layer-1-hover hover:text-danger-primary"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-1 text-11 text-tertiary">
        <div className="flex items-center gap-2">
          <span>{t("payments.pagination.per_page")}</span>
          <select
            className="focus:border-accent-primary h-7 rounded-sm border border-subtle bg-layer-1 px-1.5 text-11 outline-none"
            value={pageSize}
            onChange={(event) => {
              setPageSize(Number(event.target.value));
              setPage(1);
            }}
          >
            {PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
          <span className="tabular-nums">
            {from}–{to} {t("payments.pagination.of")} {total}
          </span>
        </div>

        {pageCount > 1 && (
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => setPage((current) => Math.max(1, current - 1))}
              disabled={page === 1}
              className="flex size-7 items-center justify-center rounded-sm hover:bg-layer-1-hover disabled:opacity-40"
              aria-label={t("payments.pagination.previous")}
            >
              <ChevronLeft className="size-4" />
            </button>
            {pageWindow(page, pageCount).map((slot) =>
              slot.page === null ? (
                <span key={slot.key} className="px-1.5">
                  …
                </span>
              ) : (
                <button
                  key={slot.key}
                  type="button"
                  onClick={() => setPage(slot.page as number)}
                  className={cn(
                    "min-w-7 rounded-sm px-2 py-1 tabular-nums hover:bg-layer-1-hover",
                    slot.page === page ? "bg-accent-primary/10 font-medium text-accent-primary" : ""
                  )}
                >
                  {slot.page}
                </button>
              )
            )}
            <button
              type="button"
              onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
              disabled={page === pageCount}
              className="flex size-7 items-center justify-center rounded-sm hover:bg-layer-1-hover disabled:opacity-40"
              aria-label={t("payments.pagination.next")}
            >
              <ChevronRight className="size-4" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
