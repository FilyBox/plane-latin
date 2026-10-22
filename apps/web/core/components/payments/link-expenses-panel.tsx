/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useMemo, useState } from "react";
import { Loader2, Search } from "lucide-react";
import useSWR from "swr";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import type { TBudgetScenario, TExpense } from "@plane/types";
import { cn } from "@plane/utils";
import useDebounce from "@/hooks/use-debounce";
import { financeService } from "@/services/finance.service";
import { PaymentsSidePanel } from "./side-panel";
import { formatMoney } from "./shared";

type Props = {
  workspaceSlug: string;
  isOpen: boolean;
  scenario: TBudgetScenario;
  onClose: () => void;
  /** Files the picked expenses against the budget, and against a line if one
   * was chosen. */
  onLink: (expenses: TExpense[], budgetLine: string) => Promise<void>;
};

/**
 * Attaches expenses already on the ledger to this budget, so the sheet can show
 * spent against planned. Only expenses that can count here are offered: filed
 * against no budget, in the budget's currency and — unless asked otherwise —
 * dated inside its period. Linking never changes the plan.
 */
export function LinkExpensesPanel({ workspaceSlug, isOpen, scenario, onClose, onLink }: Props) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const query = useDebounce(search.trim(), 300);
  const [outsidePeriod, setOutsidePeriod] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [budgetLine, setBudgetLine] = useState("");
  const [busy, setBusy] = useState(false);

  const { data, isLoading } = useSWR(
    isOpen ? ["LINKABLE_EXPENSES", workspaceSlug, scenario.id, scenario.currency, query, outsidePeriod] : null,
    () =>
      financeService.getExpensePage(workspaceSlug, {
        scenario: "none",
        currencies: [scenario.currency],
        search: query || undefined,
        from: outsidePeriod ? undefined : scenario.period_start,
        to: outsidePeriod ? undefined : scenario.period_end,
        statuses: ["PENDING", "PAID"],
        limit: 300,
      })
  );
  const { data: forecast } = useSWR(isOpen ? `BUDGET_FORECAST_${workspaceSlug}_${scenario.id}` : null, () =>
    financeService.getScenarioForecast(workspaceSlug, scenario.id)
  );
  const lines = useMemo(
    () => (forecast?.lines ?? []).filter((line) => line.currency === scenario.currency),
    [forecast, scenario.currency]
  );

  const available = data?.results ?? [];
  const selected = available.filter((expense) => selectedIds.includes(expense.id));
  const toggle = (id: string) =>
    setSelectedIds((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));

  const link = async () => {
    if (selected.length === 0) return;
    setBusy(true);
    try {
      await onLink(selected, budgetLine);
      setSelectedIds([]);
      setBudgetLine("");
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <PaymentsSidePanel
      isOpen={isOpen}
      onClose={onClose}
      title={t("payments.flow.link_title")}
      description={t("payments.flow.link_help", { budget: scenario.name, currency: scenario.currency })}
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="shrink-0 space-y-2 px-6 pb-3">
          <div className="relative">
            <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-tertiary" />
            <input
              value={search}
              aria-label={t("payments.filters.search")}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("payments.filters.search")}
              className="h-8 w-full rounded-md border border-subtle bg-transparent pr-2 pl-8 text-12 outline-none focus:border-accent-strong"
            />
          </div>
          <label className="flex items-center gap-2 text-12 text-secondary">
            <input
              type="checkbox"
              className="accent-accent-primary size-3.5"
              checked={outsidePeriod}
              onChange={(event) => setOutsidePeriod(event.target.checked)}
            />
            {t("payments.flow.include_outside_period")}
          </label>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6">
          {isLoading ? (
            <Loader2 className="mx-auto my-8 size-5 animate-spin text-tertiary" />
          ) : available.length === 0 ? (
            <p className="py-8 text-center text-12 text-tertiary">{t("payments.flow.nothing_to_link")}</p>
          ) : (
            <ul>
              {available.map((expense) => {
                const isSelected = selectedIds.includes(expense.id);
                return (
                  <li key={expense.id}>
                    <label
                      className={cn(
                        "flex w-full cursor-pointer items-center gap-3 border-b border-subtle px-1 py-2.5",
                        isSelected && "bg-layer-1"
                      )}
                    >
                      <input
                        type="checkbox"
                        className="accent-accent-primary size-3.5 shrink-0"
                        checked={isSelected}
                        onChange={() => toggle(expense.id)}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-13">{expense.concept || expense.vendor}</span>
                        <span className="block truncate text-11 text-tertiary">
                          {expense.expense_date}
                          {expense.vendor && expense.concept ? ` · ${expense.vendor}` : ""}
                        </span>
                      </span>
                      <span className="font-mono shrink-0 text-12 tabular-nums">
                        {formatMoney(expense.amount, expense.currency)}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="shrink-0 space-y-2 border-t border-subtle bg-surface-1 px-6 py-3">
          <label className="flex items-center gap-2 text-12 text-secondary">
            <span className="shrink-0">{t("payments.flow.budget_line")}</span>
            <select
              value={budgetLine}
              onChange={(event) => setBudgetLine(event.target.value)}
              className="h-7 min-w-0 flex-1 rounded-sm border border-subtle bg-transparent px-1.5 text-12 outline-none focus:border-accent-strong"
            >
              <option value="">{t("payments.flow.no_line")}</option>
              {lines.map((line) => (
                <option key={line.key} value={line.key}>
                  {line.entity_name ? `${line.label} · ${line.entity_name}` : line.label}
                </option>
              ))}
            </select>
          </label>
          <div className="flex items-center justify-between gap-2">
            <span className="text-11 text-tertiary">
              {t("payments.flow.expenses_selected", { count: selected.length })}
            </span>
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" disabled={busy} onClick={onClose}>
                {t("payments.actions.cancel")}
              </Button>
              <Button
                variant="primary"
                size="sm"
                loading={busy}
                disabled={busy || selected.length === 0}
                onClick={() => void link()}
              >
                {t("payments.flow.link_action")}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </PaymentsSidePanel>
  );
}
