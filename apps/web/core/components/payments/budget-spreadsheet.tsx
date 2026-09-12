import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Eye, EyeOff, Filter, Search } from "lucide-react";
import useSWR from "swr";
import { useTranslation } from "@plane/i18n";
import { Popover } from "@plane/propel/popover";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TBudgetForecastLine, TBudgetScenario } from "@plane/types";
import { cn } from "@plane/utils";
import { financeService } from "@/services/finance.service";
import { FinanceGrid, type FinanceGridColumn, type FinanceGridRow } from "./finance-grid";
import { BudgetRowPanel } from "./budget-row-panel";
import { CellCataloguePicker } from "./cell-catalogue-picker";
import { formatMoney, getApiErrorMessage } from "./shared";

type Props = {
  workspaceSlug: string;
  scenario: TBudgetScenario;
  refreshToken?: number;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
};
type SheetOrder = "none" | "concept" | "entity" | "category" | "total";

const ORDERS: { key: SheetOrder; labelKey: string }[] = [
  { key: "none", labelKey: "payments.ledger.none" },
  { key: "concept", labelKey: "payments.sheet.concept" },
  { key: "entity", labelKey: "payroll.fields.office" },
  { key: "category", labelKey: "payments.fields.category" },
  { key: "total", labelKey: "payments.sheet.total" },
];

/** The name a line is filed under, for grouping and ordering. */
const categoryOf = (line: TBudgetForecastLine) => line.category_name ?? "";

const sum = (values: string[]) => {
  const total = values.reduce((acc, value) => acc + BigInt(Math.round(Number(value) * 100)), 0n);
  const absolute = total < 0 ? -total : total;
  return `${total < 0 ? "-" : ""}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
};

export function BudgetSpreadsheet({ workspaceSlug, scenario, refreshToken = 0, meta, actions }: Props) {
  const { t } = useTranslation();
  const {
    data: forecast,
    mutate,
    error,
  } = useSWR(`BUDGET_FORECAST_${workspaceSlug}_${scenario.id}`, () =>
    financeService.getScenarioForecast(workspaceSlug, scenario.id)
  );
  const { data: counts = [] } = useSWR<{ row_key: string; cell: string; count: number }[]>(
    ["FINANCE_COMMENT_COUNTS", workspaceSlug, scenario.id],
    () =>
      financeService
        .get(`/api/workspaces/${workspaceSlug}/finance-comments/`, { params: { scenario: scenario.id, counts: 1 } })
        .then((response) => response.data)
  );
  const [peek, setPeek] = useState<{ key: string; cell: string } | null>(null);
  const [search, setSearch] = useState("");
  const [currency, setCurrency] = useState(scenario.currency);
  // Categories drive three separate things on the sheet: which lines show, which
  // are put away, and whether the rows come out grouped and ordered by them.
  const [shown, setShown] = useState<string[]>([]);
  const [hidden, setHidden] = useState<string[]>([]);
  const [group, setGroup] = useState(false);
  const [order, setOrder] = useState<SheetOrder>("none");
  // Which reference cell is open, and where to float its picker.
  const [cellPicker, setCellPicker] = useState<{ key: string; prop: string; anchor: DOMRect } | null>(null);
  const initial = useRef(refreshToken);
  useEffect(() => {
    if (refreshToken !== initial.current) {
      initial.current = refreshToken;
      void mutate();
    }
  }, [refreshToken, mutate]);
  const currencies = [...new Set((forecast?.lines ?? []).map((line) => line.currency))];
  const selectedCurrency = currencies.includes(currency) ? currency : (currencies[0] ?? scenario.currency);
  const tags = [...new Set((forecast?.lines ?? []).map((line) => line.category_name).filter(Boolean))].sort();
  const lines = useMemo(() => {
    const query = search.toLocaleLowerCase();
    const filtered = (forecast?.lines ?? []).filter((line) => {
      const category = line.category_name ?? "";
      return (
        line.currency === selectedCurrency &&
        (shown.length === 0 || shown.includes(category)) &&
        !hidden.includes(category) &&
        `${line.label} ${line.entity_name} ${category}`.toLocaleLowerCase().includes(query)
      );
    });
    if (order === "none") return filtered;
    /** Blank values sort last whatever the key, instead of first where an empty
     * string would land them. */
    const by = (line: TBudgetForecastLine) =>
      order === "category" ? (line.category_name ?? "") : order === "entity" ? line.entity_name : line.label;
    return [...filtered].sort((a, b) => {
      if (order === "total") return Number(b.total) - Number(a.total);
      const left = by(a);
      const right = by(b);
      if (!left !== !right) return left ? -1 : 1;
      return left.localeCompare(right) || a.label.localeCompare(b.label);
    });
  }, [forecast, selectedCurrency, shown, hidden, search, order]);
  const lineByKey = (row: FinanceGridRow) => lines.find((line) => line.key === row.id)!;
  const rows = useMemo<FinanceGridRow[]>(() => {
    const records = lines.map((line) => ({
      id: line.key,
      concept: line.label,
      entity: line.entity_name,
      entityId: line.entity_id,
      category: categoryOf(line),
      categoryId: line.category_id,
      total: line.total,
      ...Object.fromEntries(
        line.months.map((cell) => [`${cell.year}-${String(cell.month).padStart(2, "0")}`, cell.amount])
      ),
    }));
    if (!group) return records;
    const groups = new Map<string, FinanceGridRow[]>();
    for (const row of records) {
      const key = String(row.category || "—");
      const bucket = groups.get(key);
      if (bucket) bucket.push(row);
      else groups.set(key, [row]);
    }
    const grouped: FinanceGridRow[] = [];
    for (const [name, items] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
      grouped.push({ id: `group-${name}`, family: "group" as const, concept: name });
      grouped.push(...items);
    }
    return grouped;
  }, [lines, group]);
  const totals = useMemo<FinanceGridRow[]>(
    () => [
      {
        id: "total",
        family: "subtotal",
        concept: t("payments.flow.planned"),
        total: sum(lines.map((line) => (line.kind === "INCOME" ? `-${line.total}` : line.total))),
        ...Object.fromEntries(
          (forecast?.months ?? []).map(({ year, month }, index) => [
            `${year}-${String(month).padStart(2, "0")}`,
            sum(lines.map((line) => `${line.kind === "INCOME" ? "-" : ""}${line.months[index]?.amount ?? "0"}`)),
          ])
        ),
      },
    ],
    [lines, forecast, t]
  );
  const columns = useMemo<FinanceGridColumn[]>(
    () => [
      {
        prop: "concept",
        name: t("payments.sheet.concept"),
        size: 236,
        pin: "colPinStart",
        onClick: (row) => setPeek({ key: row.id, cell: "" }),
        flags: (row) => ({ hasThread: counts.some((count) => count.row_key === row.id && !count.cell) }),
      },
      { prop: "entity", name: t("payroll.fields.office"), size: 150, pickable: true },
      { prop: "category", name: t("payments.fields.category"), size: 150, pickable: true },
      ...(forecast?.months ?? []).map(({ year, month }, index) => {
        const prop = `${year}-${String(month).padStart(2, "0")}`;
        return {
          prop,
          name: new Intl.DateTimeFormat(undefined, { month: "short", year: "2-digit" }).format(
            new Date(year, month - 1)
          ),
          size: 106,
          amount: true,
          editable: true,
          display: (row: FinanceGridRow) =>
            row[prop] === undefined ? "" : formatMoney(String(row[prop]), selectedCurrency),
          flags: (row: FinanceGridRow) => ({
            override: lineByKey(row)?.months[index]?.is_overridden,
            isLinked: !row.family && !lineByKey(row)?.months[index]?.is_overridden,
            hasThread: counts.some((count) => count.row_key === row.id && count.cell === prop),
          }),
        };
      }),
      {
        prop: "total",
        name: t("payments.sheet.total"),
        size: 140,
        pin: "colPinEnd",
        amount: true,
        display: (row) => (row.total === undefined ? "" : formatMoney(String(row.total), selectedCurrency)),
      },
      // `lineByKey` only reads `lines`, which is already a dependency.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    ],
    [forecast, selectedCurrency, lines, t, counts]
  );
  const activeFilters = shown.length + hidden.length;
  const peekLine = forecast?.lines.find((line) => line.key === peek?.key);
  const actual = forecast?.actuals?.find((item) => item.currency === selectedCurrency);
  return (
    <div className="flex h-full min-h-0 w-full flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-subtle px-4 py-2.5">
        <div className="relative">
          <Search className="absolute top-2 left-2 size-4 text-tertiary" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("payments.sheet.search")}
            className="h-8 rounded-sm border border-subtle bg-layer-1 pr-2 pl-8 text-12"
          />
        </div>
        <Popover modal>
          <Popover.Button
            className={cn(
              "flex h-8 items-center gap-1.5 rounded-sm border border-subtle px-2.5 text-12 text-secondary hover:bg-layer-1-hover",
              activeFilters > 0 && "border-accent-strong text-accent-primary"
            )}
          >
            <Filter className="size-3.5" />
            {t("payments.filters.label")}
            {activeFilters > 0 && (
              <span className="rounded-full bg-accent-primary px-1.5 text-10 text-on-color">{activeFilters}</span>
            )}
          </Popover.Button>
          <Popover.Panel positionerClassName="z-100" side="bottom" align="start">
            <div className="w-64 rounded-md border border-subtle bg-layer-1 p-2 shadow-raised-200">
              <p className="px-1 py-0.5 text-11 font-medium text-tertiary">{t("payments.fields.category")}</p>
              <div className="max-h-52 overflow-y-auto">
                {tags.map((name) => (
                  <div key={name} className="flex items-center gap-1 rounded-sm px-1 hover:bg-layer-1-hover">
                    <button
                      type="button"
                      onClick={() =>
                        setShown((current) =>
                          current.includes(name) ? current.filter((item) => item !== name) : [...current, name]
                        )
                      }
                      className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left text-13"
                    >
                      <span
                        className={cn(
                          "flex size-4 shrink-0 items-center justify-center rounded-sm border",
                          shown.includes(name)
                            ? "border-accent-strong bg-accent-primary text-on-color"
                            : "border-strong"
                        )}
                      >
                        {shown.includes(name) && <Check className="size-3" />}
                      </span>
                      <span className={cn("truncate", hidden.includes(name) && "text-tertiary line-through")}>
                        {name}
                      </span>
                    </button>
                    {/* Hiding is not the opposite of filtering: it puts one
                      category away while everything else stays as it was. */}
                    <button
                      type="button"
                      onClick={() =>
                        setHidden((current) =>
                          current.includes(name) ? current.filter((item) => item !== name) : [...current, name]
                        )
                      }
                      aria-label={`${t("payments.sheet.hide_category")} ${name}`}
                      title={t("payments.sheet.hide_category")}
                      className="shrink-0 p-1 text-tertiary hover:text-primary"
                    >
                      {hidden.includes(name) ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                    </button>
                  </div>
                ))}
                {tags.length === 0 && (
                  <p className="px-1.5 py-1 text-11 text-tertiary">{t("payments.empty.categories")}</p>
                )}
              </div>
              <div className="mt-2 space-y-0.5 border-t border-subtle pt-2">
                <button
                  type="button"
                  onClick={() => setGroup((value) => !value)}
                  className="flex w-full items-center justify-between gap-2 rounded-sm px-1.5 py-1.5 text-left text-12 hover:bg-layer-1-hover"
                >
                  {t("payments.ledger.group_by_tag")}
                  {group && <Check className="size-3.5 text-accent-primary" />}
                </button>
              </div>
              <div className="mt-2 space-y-0.5 border-t border-subtle pt-2">
                <p className="px-1 pb-0.5 text-11 font-medium text-tertiary">{t("payments.ledger.sort")}</p>
                {ORDERS.map(({ key, labelKey }) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setOrder(key)}
                    className="flex w-full items-center justify-between gap-2 rounded-sm px-1.5 py-1.5 text-left text-12 hover:bg-layer-1-hover"
                  >
                    {t(labelKey)}
                    {order === key && <Check className="size-3.5 text-accent-primary" />}
                  </button>
                ))}
              </div>
              {currencies.length > 1 && (
                <div className="mt-2 border-t border-subtle pt-2">
                  <p className="px-1 py-0.5 text-11 font-medium text-tertiary">{t("payments.fields.currency")}</p>
                  {currencies.map((item) => (
                    <button
                      key={item}
                      type="button"
                      onClick={() => setCurrency(item)}
                      className="flex w-full items-center justify-between gap-2 rounded-sm px-1.5 py-1.5 text-left text-12 hover:bg-layer-1-hover"
                    >
                      {item}
                      {item === selectedCurrency && <Check className="size-3.5 text-accent-primary" />}
                    </button>
                  ))}
                </div>
              )}
              {activeFilters > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setShown([]);
                    setHidden([]);
                  }}
                  className="mt-2 w-full border-t border-subtle pt-2 text-12 text-accent-primary"
                >
                  {t("payments.ledger.clear")}
                </button>
              )}
            </div>
          </Popover.Panel>
        </Popover>
        {meta}
        <div className="ml-auto flex gap-2">{actions}</div>
      </div>
      <div className="flex shrink-0 flex-wrap gap-x-6 gap-y-1 border-b border-subtle px-4 py-2 text-12 text-tertiary">
        <span>
          {t("payments.flow.planned")}: {formatMoney(String(totals[0]?.total ?? "0"), selectedCurrency)}
        </span>
        <span>
          {t("payments.flow.actual")}: {formatMoney(actual?.paid ?? "0", selectedCurrency)}
        </span>
        <span>
          {t("payments.status.pending")}: {formatMoney(actual?.pending ?? "0", selectedCurrency)}
        </span>
        <span>
          {t("payments.flow.available")}:{" "}
          {formatMoney(
            sum([String(totals[0]?.total ?? "0"), `-${actual?.paid ?? "0"}`, `-${actual?.pending ?? "0"}`]),
            selectedCurrency
          )}
        </span>
      </div>
      {error && (
        <button type="button" onClick={() => void mutate()}>
          {t("payments.ledger.load_error")}
        </button>
      )}
      <div className="flex min-h-0 flex-1 flex-col">
        <FinanceGrid
          rows={rows}
          totals={totals}
          columns={columns}
          emptyLabel={t("payments.sheet.empty_title")}
          onPickCell={(row, prop, anchor) => setCellPicker({ key: row.id, prop, anchor })}
          onComment={(row, cell) => setPeek({ key: row.id, cell })}
          onEdit={async (row, prop, value) => {
            if (!/^\d+(\.\d{1,2})?$/.test(value.trim())) {
              setToast({ type: TOAST_TYPE.ERROR, title: t("payments.sheet.invalid_amount") });
              return;
            }
            const [year, month] = prop.split("-").map(Number);
            try {
              await financeService.overrideScenarioCell(workspaceSlug, scenario.id, {
                row_key: row.id,
                year,
                month,
                amount: value,
              });
              await mutate();
            } catch {
              setToast({ type: TOAST_TYPE.ERROR, title: t("payments.toasts.error") });
            }
          }}
        />
      </div>
      {cellPicker && (
        <CellCataloguePicker
          workspaceSlug={workspaceSlug}
          kind={cellPicker.prop === "entity" ? "office" : "category"}
          anchor={cellPicker.anchor}
          selected={
            cellPicker.prop === "entity"
              ? (forecast?.lines.find((line) => line.key === cellPicker.key)?.entity_id ?? "")
              : (forecast?.lines.find((line) => line.key === cellPicker.key)?.category_id ?? "")
          }
          onClose={() => setCellPicker(null)}
          onApply={async (id) => {
            const patch = cellPicker.prop === "entity" ? { entity: id } : { category: id || null };
            try {
              await financeService.updateBudgetRow(workspaceSlug, scenario.id, cellPicker.key, patch);
              await mutate();
            } catch (reason) {
              setToast({
                type: TOAST_TYPE.ERROR,
                title: t("payments.toasts.error"),
                message: getApiErrorMessage(reason),
              });
            }
            setCellPicker(null);
          }}
        />
      )}
      {peek && peekLine && (
        <BudgetRowPanel
          key={peek.key}
          workspaceSlug={workspaceSlug}
          scenario={scenario}
          line={peekLine}
          cell={peek.cell}
          onClose={() => setPeek(null)}
          onChanged={() => void mutate()}
        />
      )}
    </div>
  );
}
