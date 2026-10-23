import type { TExpense } from "@plane/types";

/** Integer cents keep aggregation exact even for large ledgers. */
const cents = (value: string): bigint => {
  const negative = value.trim().startsWith("-");
  const [whole, fraction = ""] = value.trim().replace(/^-/, "").split(".");
  const amount = BigInt(whole || "0") * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2) || "0");
  return negative ? -amount : amount;
};
const money = (value: bigint) => {
  const absolute = value < 0n ? -value : value;
  return `${value < 0n ? "-" : ""}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
};

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

// Neutralize spreadsheet formulas in user-provided text, including leading whitespace.
const escapeCell = (value: string) => `"${(/^\s*[=+@-]/.test(value) ? "'" + value : value).replaceAll('"', '""')}"`;

export function expenseCsv(rows: string[][]): string {
  return "\uFEFF" + rows.map((row) => row.map(escapeCell).join(",")).join("\r\n");
}
