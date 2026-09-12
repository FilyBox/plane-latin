import { useMemo } from "react";
import { useTranslation } from "@plane/i18n";
import type { TExpense } from "@plane/types";
import { expenseTotals } from "@/lib/expense-ledger";
import { FinanceGrid, type FinanceGridColumn, type FinanceGridRow } from "./finance-grid";
import { formatMoney } from "./shared";

type Props = {
  expenses: TExpense[];
  group?: string;
  onEdit: (expense: TExpense) => void;
  onDelete: (expense: TExpense) => void;
  onPreview: (expense: TExpense, index: number) => void;
  onQuickEdit: (expense: TExpense, patch: Partial<TExpense>) => Promise<void>;
  onComment?: (expense: TExpense, cell: string) => void;
  emptyLabel?: string;
};

export function ExpenseTable({
  expenses,
  group = "none",
  onEdit,
  onPreview,
  onQuickEdit,
  onComment,
  emptyLabel,
}: Props) {
  const { t } = useTranslation();
  const rows = useMemo<FinanceGridRow[]>(() => {
    const groups = new Map<string, TExpense[]>();
    for (const expense of expenses) {
      const key =
        group === "category"
          ? expense.category_name || "—"
          : group === "status"
            ? t(`payments.status.${expense.status.toLowerCase()}`)
            : group === "tag"
              ? [...expense.tags].sort().join(", ") || "—"
              : "";
      const bucket = groups.get(key);
      if (bucket) bucket.push(expense);
      else groups.set(key, [expense]);
    }
    const flattened: FinanceGridRow[] = [];
    for (const [name, items] of groups) {
      if (name) flattened.push({ id: `group-${name}`, family: "group" as const, concept: name });
      for (const expense of items)
        flattened.push({
          ...expense,
          tagsText: expense.tags.join(", "),
          documentsText: expense.documents.map((doc) => doc.name).join(", "),
        });
    }
    return flattened;
  }, [expenses, group, t]);
  // The closing line is pinned by the grid, so it must exist even for an empty
  // ledger — otherwise the sheet loses its footer exactly when it is emptiest.
  const totals = useMemo<FinanceGridRow[]>(() => {
    const perCurrency = expenseTotals(expenses);
    const lines = perCurrency.length ? perCurrency : [{ currency: "", total: "0" }];
    return lines.map((total) => ({
      id: `total-${total.currency || "none"}`,
      family: "subtotal",
      concept: total.currency ? `${t("payments.sheet.total")} · ${total.currency}` : t("payments.sheet.total"),
      amount: total.total,
      currency: total.currency,
    }));
  }, [expenses, t]);
  const expenseFor = (row: FinanceGridRow) => expenses.find((expense) => expense.id === row.id)!;
  const columns = useMemo<FinanceGridColumn[]>(
    () => [
      {
        prop: "concept",
        name: t("payments.sheet.concept"),
        size: 236,
        pin: "colPinStart",
        onClick: (row) => onEdit(expenseFor(row)),
      },
      { prop: "expense_date", name: t("payments.fields.date"), size: 105, editable: true },
      { prop: "vendor", name: t("payments.fields.vendor"), size: 170, editable: true },
      { prop: "description", name: t("payments.fields.description"), size: 220, editable: true },
      {
        prop: "category_name",
        name: t("payments.fields.category"),
        size: 140,
        onClick: (row) => onEdit(expenseFor(row)),
      },
      { prop: "tagsText", name: t("payments.ledger.tags"), size: 155, onClick: (row) => onEdit(expenseFor(row)) },
      {
        prop: "status",
        name: t("payments.fields.status"),
        size: 110,
        display: (row) => (row.status ? t(`payments.status.${String(row.status).toLowerCase()}`) : ""),
        onClick: (row) => onEdit(expenseFor(row)),
      },
      {
        prop: "documentsText",
        name: t("payments.fields.documents"),
        size: 185,
        onClick: (row) => {
          const expense = expenseFor(row);
          if (expense.documents.length) onPreview(expense, 0);
          else onEdit(expense);
        },
      },
      { prop: "reference", name: t("payments.fields.reference"), size: 125, editable: true },
      {
        prop: "amount",
        name: t("payments.fields.amount"),
        pin: "colPinEnd",
        size: 140,
        amount: true,
        editable: true,
        display: (row) => (row.amount === undefined ? "" : formatMoney(String(row.amount), String(row.currency))),
        flags: (row) => ({ isLocked: row.status === "CANCELLED", isLinked: row.status === "PAID" }),
      },
      // `expenseFor` only reads `expenses`, which is already a dependency.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    ],
    [expenses, t, onEdit, onPreview]
  );
  return (
    <FinanceGrid
      rows={rows}
      totals={totals}
      columns={columns}
      emptyLabel={emptyLabel}
      onComment={(row, cell) => onComment?.(expenseFor(row), cell)}
      onEdit={async (row, prop, value) => {
        try {
          await onQuickEdit(expenseFor(row), { [prop]: value });
        } catch {
          /* The ledger reports save errors. */
        }
      }}
    />
  );
}
