/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { Download, Loader2, MoreHorizontal, Plus, RefreshCw, Search, Tags } from "lucide-react";
import useSWR, { useSWRConfig } from "swr";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { EmptyStateCompact } from "@plane/propel/empty-state";
import { Menu } from "@plane/propel/menu";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TExpense, TExpenseCategory, TBudgetScenario, TExpenseFilters as TExpenseQuery } from "@plane/types";
import { cn } from "@plane/utils";
import useDebounce from "@/hooks/use-debounce";
import { financeService } from "@/services/finance.service";
import { LinkExpensesPanel } from "./link-expenses-panel";
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
import { FinanceConfirmModal } from "./confirm-modal";

/** How many expenses each "load more" brings in. */
const PAGE = 200;

export function ExpensesTab({
  workspaceSlug,
  onChanged,
  scenario,
}: {
  workspaceSlug: string;
  onChanged?: () => void;
  scenario?: TBudgetScenario;
}) {
  const { t } = useTranslation();
  const { mutate: mutateGlobal } = useSWRConfig();
  const [linkOpen, setLinkOpen] = useState(false);
  const [commentCell, setCommentCell] = useState("");
  const [search, setSearch] = useState("");
  const query = useDebounce(search.trim(), 300);
  const [filters, setFilters] = useState<TExpenseFilters>(EMPTY_EXPENSE_FILTERS);
  const [group, setGroup] = useState("none");
  const [sort, setSort] = useState("date_desc");
  const [limit, setLimit] = useState(PAGE);
  const [editing, setEditing] = useState<TExpense | null | undefined>(undefined);
  // The open expense lives in the URL (?expense=<id>), so the page can be
  // shared with it open; mentions, shared tags and Back/Forward drive it too.
  const [searchParams, setSearchParams] = useSearchParams();
  const expenseParam = searchParams.get("expense");
  const shownExpense = useRef<string | null>(null);
  useEffect(() => {
    if (!expenseParam) {
      // Closed from the URL (Back); a new expense being created has no id
      setEditing((current) => (current?.id ? undefined : current));
      return;
    }
    if (editing?.id === expenseParam) return;
    void financeService
      .getExpense(workspaceSlug, expenseParam)
      .then(setEditing)
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expenseParam, workspaceSlug]);
  useEffect(() => {
    const id = editing?.id ?? null;
    const previous = shownExpense.current;
    shownExpense.current = id;
    if (id && id !== expenseParam) {
      setSearchParams((current) => {
        const next = new URLSearchParams(current);
        next.set("expense", id);
        return next;
      });
    } else if (!id && previous && expenseParam === previous) {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          next.delete("expense");
          return next;
        },
        { replace: true }
      );
    }
    // Follows the open expense only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing?.id]);
  const [categoriesOpen, setCategoriesOpen] = useState(false);
  const [deleting, setDeleting] = useState<TExpense | null>(null);
  const [busy, setBusy] = useState(false);
  const [viewing, setViewing] = useState<{ expense: TExpense; index: number } | null>(null);
  const { data: categories, mutate: mutateCategories } = useSWR<TExpenseCategory[]>(
    `PAYMENT_CATEGORIES_${workspaceSlug}`,
    () => financeService.getCategories(workspaceSlug)
  );

  // The ledger is filtered, sorted and totalled by the server: only a window
  // travels, and the totals always describe everything that matches.
  const request: TExpenseQuery = {
    scenario: scenario?.id,
    search: query || undefined,
    from: filters.from || undefined,
    to: filters.to || undefined,
    categories: filters.categories,
    currencies: filters.currencies,
    tags: filters.tags,
    statuses: filters.statuses,
    recurring: filters.recurring,
    sort: sort as TExpenseQuery["sort"],
    limit,
  };
  const {
    data: page,
    error,
    isLoading,
    isValidating,
    mutate,
  } = useSWR(["PAYMENT_EXPENSES", workspaceSlug, JSON.stringify(request)], () =>
    financeService.getExpensePage(workspaceSlug, request)
  );
  const rows = page?.results ?? [];
  const refresh = () => {
    void mutateGlobal((key) => Array.isArray(key) && (key[0] === "PAYMENT_EXPENSES" || key[0] === "LINKABLE_EXPENSES"));
    void mutateGlobal(
      (key) =>
        typeof key === "string" &&
        (key.startsWith(`BUDGET_FORECAST_${workspaceSlug}_`) || key.startsWith(`BUDGET_SCENARIOS_${workspaceSlug}`))
    );
    onChanged?.();
  };
  const reportError = (reason: unknown) =>
    setToast({ type: TOAST_TYPE.ERROR, title: t("payments.toasts.error"), message: getApiErrorMessage(reason) });
  const isNarrowed = countExpenseFilters(filters) > 0 || search.trim().length > 0;
  const changeFilters = (next: TExpenseFilters) => {
    setFilters(next);
    setLimit(PAGE);
  };
  const quickEdit = async (expense: TExpense, patch: Partial<TExpense>) => {
    try {
      await financeService.updateExpense(workspaceSlug, expense.id, patch);
      refresh();
    } catch (reason) {
      reportError(reason);
      throw reason;
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
  /** Exports everything that matches, not only the rows loaded so far. */
  const exportRows = async (format: "csv" | "xlsx") => {
    try {
      const ids = rows.map((row) => row.id);
      const total = page?.count ?? ids.length;
      for (let offset = ids.length; offset < total; offset += 500) {
        // eslint-disable-next-line no-await-in-loop
        const more = await financeService.getExpensePage(workspaceSlug, { ...request, offset, limit: 500 });
        ids.push(...more.results.map((row) => row.id));
      }
      await financeService.exportExpenses(workspaceSlug, ids, format);
    } catch (reason) {
      reportError(reason);
    }
  };
  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-1">
      <ExpenseModal
        workspaceSlug={workspaceSlug}
        isOpen={editing !== undefined}
        expense={editing ?? null}
        initialData={scenario ? { scenario: scenario.id, currency: scenario.currency } : undefined}
        commentCell={commentCell}
        onDelete={editing ? () => setDeleting(editing) : undefined}
        onClose={() => {
          setEditing(undefined);
          setCommentCell("");
        }}
        onSaved={refresh}
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
      <FinanceConfirmModal
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
              setEditing(undefined);
              return refresh();
            })
            .catch(reportError)
            .finally(() => setBusy(false));
        }}
      />
      {/* One toolbar: the narrowing controls and the actions share a line,
          leaving the height for the ledger itself. */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-subtle px-4 py-2 sm:px-5">
        <div className="relative">
          <Search className="absolute top-2 left-2 size-4 text-tertiary" />
          <input
            aria-label={t("payments.filters.search")}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setLimit(PAGE);
            }}
            placeholder={t("payments.filters.search")}
            className="h-8 w-full max-w-52 rounded-sm border border-subtle bg-layer-1 pr-2 pl-8 text-12 text-primary outline-none focus:border-accent-strong"
          />
        </div>
        <ExpenseFiltersDropdown
          filters={filters}
          categories={categories ?? []}
          currencies={page?.facets.currencies ?? []}
          tags={page?.facets.tags ?? []}
          onChange={changeFilters}
        />
        <ExpenseDisplayMenu
          group={group}
          sort={sort}
          onGroupChange={setGroup}
          onSortChange={(value) => {
            setSort(value);
            setLimit(PAGE);
          }}
        />
        <div className="ml-auto flex items-center gap-2">
          <ExpenseImports
            workspaceSlug={workspaceSlug}
            onChanged={refresh}
            scenarioId={scenario?.id}
            onOpenExpense={(id) => {
              const loaded = rows.find((expense) => expense.id === id);
              if (loaded) setEditing(loaded);
              else void financeService.getExpense(workspaceSlug, id).then(setEditing).catch(reportError);
            }}
          />
          {scenario && (
            <Button variant="secondary" size="sm" onClick={() => setLinkOpen(true)}>
              {t("payments.flow.link_existing")}
            </Button>
          )}
          <Menu
            customButton={
              <span className="flex size-8 items-center justify-center rounded-sm border border-subtle text-secondary hover:bg-layer-1-hover">
                <MoreHorizontal className="size-4" />
              </span>
            }
            optionsClassName="w-56"
            ariaLabel={t("payments.ledger.more_actions")}
          >
            {/* Workspace-wide actions stay on the ledger page, not inside a
                single budget where they would read as budget-only. */}
            {!scenario && (
              <Menu.MenuItem onClick={() => setCategoriesOpen(true)}>
                <span className="flex items-center gap-2 text-12">
                  <Tags className="size-3.5" />
                  {t("payments.manage_categories")}
                </span>
              </Menu.MenuItem>
            )}
            {!scenario && (
              <Menu.MenuItem onClick={generate} disabled={busy}>
                <span className="flex items-center gap-2 text-12">
                  <RefreshCw className={cn("size-3.5", busy && "animate-spin")} />
                  {t("payments.ledger.generate")}
                </span>
              </Menu.MenuItem>
            )}
            <Menu.MenuItem onClick={() => void exportRows("csv")} disabled={!rows.length}>
              <span className="flex items-center gap-2 text-12">
                <Download className="size-3.5" />
                {t("payments.sheet.export_csv")}
              </span>
            </Menu.MenuItem>
            <Menu.MenuItem onClick={() => void exportRows("xlsx")} disabled={!rows.length}>
              <span className="flex items-center gap-2 text-12">
                <Download className="size-3.5" />
                {t("payments.sheet.export_xlsx")}
              </span>
            </Menu.MenuItem>
          </Menu>
          <Button variant="primary" size="sm" onClick={() => setEditing(null)}>
            <Plus className="size-3.5" />
            {t("payments.new_expense")}
          </Button>
        </div>
      </div>
      <AppliedExpenseFilters filters={filters} categories={categories ?? []} onChange={changeFilters} />
      <div className="flex min-h-0 flex-1 flex-col">
        {isLoading && !page ? (
          <div className="flex flex-1 items-center justify-center" role="status">
            <Loader2 className="size-5 animate-spin text-tertiary" aria-label={t("payments.ledger.loading")} />
          </div>
        ) : error ? (
          <EmptyStateCompact
            title={t("payments.ledger.failed")}
            // `actions` renders its row full-width, which leaves the button
            // hanging on the left of a centred empty state.
            customButton={
              <div className="flex justify-center">
                <Button variant="secondary" size="sm" onClick={() => void mutate()}>
                  {t("payments.ledger.retry")}
                </Button>
              </div>
            }
          />
        ) : (
          /* The grid stays mounted with no rows so its pinned totals line keeps
             closing the ledger; the toolbar already offers "new expense". */
          <ExpenseTable
            expenses={rows}
            totals={page?.totals}
            group={group}
            emptyLabel={t(isNarrowed ? "payments.ledger.no_results" : "payments.ledger.empty_title")}
            onEdit={(expense) => {
              setCommentCell("");
              setEditing(expense);
            }}
            onComment={(expense, cell) => {
              setCommentCell(cell);
              setEditing(expense);
            }}
            onDelete={setDeleting}
            onPreview={(expense, index) => setViewing({ expense, index })}
            onQuickEdit={quickEdit}
          />
        )}
        {page && page.count > rows.length && (
          <div className="flex shrink-0 items-center justify-between gap-3 border-t border-subtle px-4 py-2 text-12 text-tertiary sm:px-5">
            <span>{t("payments.ledger.showing", { shown: rows.length, total: page.count })}</span>
            <Button
              variant="secondary"
              size="sm"
              loading={isValidating}
              onClick={() => setLimit((value) => value + PAGE)}
            >
              {t("payments.ledger.load_more")}
            </Button>
          </div>
        )}
      </div>
      {scenario && (
        <LinkExpensesPanel
          workspaceSlug={workspaceSlug}
          isOpen={linkOpen}
          scenario={scenario}
          onClose={() => setLinkOpen(false)}
          onLink={async (picked, budgetLine) => {
            // Sequential on purpose: each write refreshes the ledger, and a
            // parallel burst would race those refreshes against each other.
            for (const expense of picked)
              // eslint-disable-next-line no-await-in-loop
              await quickEdit(expense, { scenario: scenario.id, budget_line: budgetLine || null });
          }}
        />
      )}
    </div>
  );
}
