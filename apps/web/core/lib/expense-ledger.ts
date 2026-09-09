import type { TExpense } from "@plane/types";

/** Integer cents keep aggregation exact even for large ledgers. */
const cents = (value: string): bigint => {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole || "0") * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2));
};
const money = (value: bigint) => `${value / 100n}.${String(value % 100n).padStart(2, "0")}`;

export function expenseTotals(expenses: TExpense[]) {
  const totals = new Map<string, { paid: bigint; pending: bigint }>();
  for (const expense of expenses) {
    if (expense.status === "CANCELLED") continue;
    const total = totals.get(expense.currency) ?? { paid: 0n, pending: 0n };
    total[expense.status === "PAID" ? "paid" : "pending"] += cents(expense.amount);
    totals.set(expense.currency, total);
  }
  return [...totals]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, total]) => ({
      currency,
      paid: money(total.paid),
      pending: money(total.pending),
      total: money(total.paid + total.pending),
    }));
}

export function expenseCsv(rows: string[][]): string {
  // Neutralize spreadsheet formulas in user-provided text, including leading whitespace.
  const escape = (value: string) => `"${(/^[\s]*[=+@\-]/.test(value) ? "'" + value : value).replaceAll('"', '""')}"`;
  return "\uFEFF" + rows.map((row) => row.map(escape).join(",")).join("\r\n");
}
