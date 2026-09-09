/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useMemo, useState } from "react";
import { Download, Loader2, MoreHorizontal, Plus, RefreshCw, Search, Tags } from "lucide-react";
import useSWR, { useSWRConfig } from "swr";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { EmptyStateCompact } from "@plane/propel/empty-state";
import { Menu } from "@plane/propel/menu";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TExpense, TExpenseCategory } from "@plane/types";
import { AlertModalCore } from "@plane/ui";
import { cn } from "@plane/utils";
import { financeService } from "@/services/finance.service";
import { expenseCsv, expenseTotals } from "@/lib/expense-ledger";
import { CategoriesModal } from "./categories-modal";
import { DocumentViewer } from "./document-viewer";
import {
  AppliedExpenseFilters,
  countExpenseFilters,
  EMPTY_EXPENSE_FILTERS,
  ExpenseDisplayMenu,
  ExpenseFiltersDropdown,
  type TExpenseFilters,
} from "./expense-filters";
import { ExpenseTable } from "./expense-table";
import { ExpenseModal } from "./expense-modal";
import { ExpenseImports } from "./expense-imports";
import { getApiErrorMessage } from "./shared";

export function ExpensesTab({ workspaceSlug, onChanged }: { workspaceSlug: string; onChanged?: () => void }) {
  const { t } = useTranslation();
  const { mutate: mutateGlobal } = useSWRConfig();
  const [tab, setTab] = useState("ledger");
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<TExpenseFilters>(EMPTY_EXPENSE_FILTERS);
  const [group, setGroup] = useState("none");
  const [sort, setSort] = useState("date_desc");
  const [editing, setEditing] = useState<TExpense | null | undefined>(undefined);
  const [categoriesOpen, setCategoriesOpen] = useState(false);
  const [deleting, setDeleting] = useState<TExpense | null>(null);
  const [busy, setBusy] = useState(false);
  const [viewing, setViewing] = useState<{ expense: TExpense; index: number } | null>(null);
  const { data: categories, mutate: mutateCategories } = useSWR<TExpenseCategory[]>(
    `PAYMENT_CATEGORIES_${workspaceSlug}`,
    () => financeService.getCategories(workspaceSlug)
  );
  const {
    data: expenses,
    error,
    isLoading,
    mutate,
  } = useSWR<TExpense[]>(`PAYMENT_EXPENSES_${workspaceSlug}_ALL`, () => financeService.getExpenses(workspaceSlug));
  const refresh = () => {
    void mutate();
    void mutateGlobal(
      (key) =>
        typeof key === "string" &&
        (key.startsWith(`BUDGET_FORECAST_${workspaceSlug}_`) || key.startsWith(`PAYMENT_SUMMARY_${workspaceSlug}_`))
    );
    onChanged?.();
  };
  const reportError = (error: unknown) =>
    setToast({ type: TOAST_TYPE.ERROR, title: t("payments.toasts.error"), message: getApiErrorMessage(error) });
  const rows = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return (expenses ?? [])
      .filter(
        (expense) =>
          (!query ||
            [expense.concept, expense.vendor, expense.reference, expense.description, ...(expense.tags ?? [])]
              .join(" ")
              .toLocaleLowerCase()
              .includes(query)) &&
          (!filters.from || expense.expense_date >= filters.from) &&
          (!filters.to || expense.expense_date <= filters.to) &&
          (!filters.categories.length ||
            filters.categories.includes(expense.category ?? "none") ||
            (!expense.category && filters.categories.includes("none"))) &&
          (!filters.currencies.length || filters.currencies.includes(expense.currency)) &&
          (!filters.tags.length || (expense.tags ?? []).some((tag) => filters.tags.includes(tag))) &&
          (!filters.recurring || expense.recurrence !== "ONE_TIME" || expense.series) &&
          (!filters.statuses.length || filters.statuses.includes(expense.status))
      )
      .sort((a, b) =>
        sort === "amount_desc"
          ? a.currency.localeCompare(b.currency) || Number(b.amount) - Number(a.amount)
          : sort === "concept_asc"
            ? (a.concept || a.vendor).localeCompare(b.concept || b.vendor)
            : sort === "date_asc"
              ? a.expense_date.localeCompare(b.expense_date)
              : b.expense_date.localeCompare(a.expense_date)
      );
  }, [expenses, search, filters, sort]);
  const isNarrowed = countExpenseFilters(filters) > 0 || search.trim().length > 0;
  const tags = [...new Set((expenses ?? []).flatMap((expense) => expense.tags ?? []))].sort();
  const currencies = [...new Set((expenses ?? []).map((expense) => expense.currency))].sort();
  const quickEdit = async (expense: TExpense, patch: Partial<TExpense>) => {
    try {
      await financeService.updateExpense(workspaceSlug, expense.id, patch);
      refresh();
    } catch (error) {
      reportError(error);
      throw error;
    }
  };
  const generate = () => {
    setBusy(true);
    void financeService
      .generateExpenses(workspaceSlug)
      .then(refresh)
      .catch(reportError)
      .finally(() => setBusy(false));
  };
  const exportRows = () => {
    const headers = [
      t("payments.sheet.concept"),
      t("payments.fields.date"),
      t("payments.fields.vendor"),
      t("payments.fields.description"),
      t("payments.fields.category"),
      t("payments.ledger.tags"),
      t("payments.fields.reference"),
      t("payments.fields.status"),
      t("payments.fields.documents"),
      t("payments.fields.amount"),
      t("payments.fields.currency"),
    ];
    const data = rows.map((row) => [
      row.concept,
      row.expense_date,
      row.vendor,
      row.description,
      row.category_name || "",
      (row.tags ?? []).join("; "),
      row.reference,
      t(`payments.status.${row.status.toLowerCase()}`),
      row.documents.map((doc) => doc.name).join("; "),
      row.amount,
      row.currency,
    ]);
    for (const total of expenseTotals(rows))
      data.push([t("payments.ledger.total"), "", "", "", "", "", "", "", "", total.total, total.currency]);
    const url = URL.createObjectURL(new Blob([expenseCsv([headers, ...data])], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "gastos.csv";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-1">
      <ExpenseModal
        workspaceSlug={workspaceSlug}
        isOpen={editing !== undefined}
        categories={categories ?? []}
        expense={editing ?? null}
        onClose={() => setEditing(undefined)}
        onSaved={refresh}
        onPreview={(index) => editing && setViewing({ expense: editing, index })}
      />
      <CategoriesModal
        workspaceSlug={workspaceSlug}
        isOpen={categoriesOpen}
        categories={categories ?? []}
        onClose={() => setCategoriesOpen(false)}
        onChanged={() => {
          void mutateCategories();
          refresh();
        }}
      />
      <DocumentViewer
        workspaceSlug={workspaceSlug}
        expenseId={viewing?.expense.id ?? null}
        documents={viewing?.expense.documents ?? []}
        initialIndex={viewing?.index ?? null}
        onClose={() => setViewing(null)}
      />
      <AlertModalCore
        isOpen={deleting !== null}
        handleClose={() => !busy && setDeleting(null)}
        isSubmitting={busy}
        title={t("payments.delete_expense_title")}
        content={t("payments.delete_expense_description")}
        handleSubmit={() => {
          if (!deleting || busy) return;
          setBusy(true);
          void financeService
            .deleteExpense(workspaceSlug, deleting.id)
            .then(() => {
              setDeleting(null);
              refresh();
            })
            .catch(reportError)
            .finally(() => setBusy(false));
        }}
      />
      {/* One toolbar: the tab switch, the narrowing controls and the actions all
          share a line, leaving the height for the ledger itself. */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-subtle px-4 py-2 sm:px-5">
        <nav className="flex shrink-0 items-center gap-0.5 rounded-md bg-layer-2 p-0.5" aria-label={t("payments.expenses")}>
          {["ledger", "ai"].map((key) => (
            <button
              type="button"
              key={key}
              onClick={() => setTab(key)}
              aria-pressed={tab === key}
              className={cn(
                "rounded-sm px-2.5 py-1 text-12 whitespace-nowrap",
                tab === key ? "bg-surface-1 font-medium text-primary shadow-raised-100" : "text-tertiary hover:text-primary"
              )}
            >
              {t(`payments.ledger.${key}`)}
            </button>
          ))}
        </nav>
        {tab === "ledger" && (
          <>
            <div className="relative">
              <Search className="absolute top-2 left-2 size-4 text-tertiary" />
              <input
                aria-label={t("payments.filters.search")}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t("payments.filters.search")}
                className="h-8 w-full max-w-52 rounded-sm border border-subtle bg-layer-1 pr-2 pl-8 text-12 text-primary outline-none focus:border-accent-primary"
              />
            </div>
            <ExpenseFiltersDropdown
              filters={filters}
              categories={categories ?? []}
              currencies={currencies}
              tags={tags}
              onChange={setFilters}
            />
            <ExpenseDisplayMenu group={group} sort={sort} onGroupChange={setGroup} onSortChange={setSort} />
            <div className="ml-auto flex items-center gap-2">
              <Menu
                customButton={
                  <span className="flex size-8 items-center justify-center rounded-sm border border-subtle text-secondary hover:bg-layer-1-hover">
                    <MoreHorizontal className="size-4" />
                  </span>
                }
                optionsClassName="w-56"
                ariaLabel={t("payments.ledger.more_actions")}
              >
                <Menu.MenuItem onClick={() => setCategoriesOpen(true)}>
                  <span className="flex items-center gap-2 text-12">
                    <Tags className="size-3.5" />
                    {t("payments.manage_categories")}
                  </span>
                </Menu.MenuItem>
                <Menu.MenuItem onClick={generate} disabled={busy}>
                  <span className="flex items-center gap-2 text-12">
                    <RefreshCw className={cn("size-3.5", busy && "animate-spin")} />
                    {t("payments.ledger.generate")}
                  </span>
                </Menu.MenuItem>
                <Menu.MenuItem onClick={exportRows} disabled={!rows.length}>
                  <span className="flex items-center gap-2 text-12">
                    <Download className="size-3.5" />
                    {t("payments.ledger.export")}
                  </span>
                </Menu.MenuItem>
              </Menu>
              <Button variant="primary" size="sm" onClick={() => setEditing(null)}>
                <Plus className="size-3.5" />
                {t("payments.new_expense")}
              </Button>
            </div>
          </>
        )}
      </div>
      {tab === "ai" ? (
        <ExpenseImports workspaceSlug={workspaceSlug} categories={categories ?? []} onChanged={refresh} />
      ) : (
        <>
          <AppliedExpenseFilters filters={filters} categories={categories ?? []} onChange={setFilters} />
          <div className="flex min-h-0 flex-1 flex-col px-4 pt-2 pb-4 sm:px-5">
            {isLoading ? (
              <Loader2 className="m-auto size-5 animate-spin text-tertiary" />
            ) : error ? (
              <EmptyStateCompact
                title={t("payments.ledger.failed")}
                // `actions` renders its row full-width, which leaves the button
                // hanging on the left of a centred empty state.
                customButton={
                  <div className="flex justify-center">
                    <Button variant="secondary" size="base" onClick={() => void mutate()}>
                      {t("payments.ledger.retry")}
                    </Button>
                  </div>
                }
              />
            ) : rows.length === 0 ? (
              <EmptyStateCompact
                assetKey={isNarrowed ? "search" : "worklog"}
                title={t(isNarrowed ? "payments.ledger.no_results" : "payments.ledger.empty_title")}
                description={t(
                  isNarrowed ? "payments.ledger.no_results_description" : "payments.ledger.empty_description"
                )}
                customButton={
                  <div className="flex justify-center">
                    {isNarrowed ? (
                      <Button
                        variant="secondary"
                        size="base"
                        onClick={() => {
                          setFilters(EMPTY_EXPENSE_FILTERS);
                          setSearch("");
                        }}
                      >
                        {t("payments.ledger.clear")}
                      </Button>
                    ) : (
                      <Button variant="primary" size="base" onClick={() => setEditing(null)}>
                        <Plus className="size-4" />
                        {t("payments.new_expense")}
                      </Button>
                    )}
                  </div>
                }
              />
            ) : (
              <ExpenseTable
                expenses={rows}
                group={group}
                onEdit={setEditing}
                onDelete={setDeleting}
                onPreview={(expense, index) => setViewing({ expense, index })}
                onQuickEdit={quickEdit}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}
