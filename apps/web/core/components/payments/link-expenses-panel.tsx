/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import type { TExpense } from "@plane/types";
import { cn } from "@plane/utils";
import { ContractSelectionCheckbox } from "@/components/file-library/contracts/list-controls";
import { PaymentsSidePanel } from "./side-panel";
import { formatMoney } from "./shared";

type Props = {
  isOpen: boolean;
  /** Every expense in the workspace; the panel offers the unlinked ones. */
  expenses: TExpense[];
  budgetName: string;
  onClose: () => void;
  onLink: (expenses: TExpense[]) => Promise<void>;
};

/**
 * Attaches expenses already on the ledger to this budget, so the sheet can show
 * spent against planned. Linking never changes the plan — it only says which
 * real money answers to it.
 */
export function LinkExpensesPanel({ isOpen, expenses, budgetName, onClose, onLink }: Props) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const available = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return expenses
      .filter(
        (expense) =>
          !expense.scenario &&
          (!query || [expense.concept, expense.vendor, expense.reference].join(" ").toLocaleLowerCase().includes(query))
      )
      .sort((a, b) => b.expense_date.localeCompare(a.expense_date));
  }, [expenses, search]);

  const selected = available.filter((expense) => selectedIds.includes(expense.id));

  const link = async () => {
    if (selected.length === 0) return;
    setBusy(true);
    try {
      await onLink(selected);
      setSelectedIds([]);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <PaymentsSidePanel
      isOpen={isOpen}
      onClose={onClose}
      title={t("payments.flow.link_existing")}
      description={budgetName}
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="shrink-0 px-6 pb-3">
          <div className="relative">
            <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-tertiary" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("payments.filters.search")}
              className="h-8 w-full rounded-md border border-subtle bg-transparent pr-2 pl-8 text-12 outline-none focus:border-accent-strong"
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6">
          {available.length === 0 ? (
            <p className="py-8 text-center text-12 text-tertiary">{t("payments.ledger.no_results")}</p>
          ) : (
            available.map((expense) => {
              const isSelected = selectedIds.includes(expense.id);
              return (
                <button
                  key={expense.id}
                  type="button"
                  onClick={() =>
                    setSelectedIds((current) =>
                      current.includes(expense.id)
                        ? current.filter((id) => id !== expense.id)
                        : [...current, expense.id]
                    )
                  }
                  className={cn(
                    "flex w-full items-center gap-3 border-b border-subtle px-1 py-2.5 text-left",
                    isSelected && "bg-layer-1"
                  )}
                >
                  <ContractSelectionCheckbox
                    checked={isSelected}
                    onChange={() =>
                      setSelectedIds((current) =>
                        current.includes(expense.id)
                          ? current.filter((id) => id !== expense.id)
                          : [...current, expense.id]
                      )
                    }
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
                </button>
              );
            })
          )}
        </div>

        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-subtle bg-surface-1 px-6 py-3">
          <span className="text-11 text-tertiary">{t("payments.composer.selected", { count: selected.length })}</span>
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
              {t("payments.flow.link_existing")}
            </Button>
          </div>
        </div>
      </div>
    </PaymentsSidePanel>
  );
}
