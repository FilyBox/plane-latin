import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Eye, EyeOff, Filter, Loader2, Search } from "lucide-react";
import useSWR from "swr";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { Popover } from "@plane/propel/popover";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TBudgetForecastLine, TBudgetScenario } from "@plane/types";
import { cn } from "@plane/utils";
import { financeService } from "@/services/finance.service";
import { FinanceGrid, type FinanceGridColumn, type FinanceGridRow } from "./finance-grid";
import { BudgetRowPanel } from "./budget-row-panel";
import { CellCataloguePicker } from "./cell-catalogue-picker";
import { formatMoney, getApiErrorMessage, negateMoney, subtractMoney, sumMoney } from "./shared";

type Props = {
  workspaceSlug: string;
  scenario: TBudgetScenario;
  refreshToken?: number;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
  /** Shown instead of the grid while the budget has no lines: what to add first. */
  emptyState?: React.ReactNode;
};
type SheetOrder = "none" | "concept" | "entity" | "category" | "total";
/** What the month cells show: the plan, the money really spent, or what is left. */
type SheetView = "planned" | "actual" | "difference";

const ORDERS: { key: SheetOrder; labelKey: string }[] = [
  { key: "none", labelKey: "payments.ledger.none" },
  { key: "concept", labelKey: "payments.sheet.concept" },
  { key: "entity", labelKey: "payroll.fields.office" },
  { key: "category", labelKey: "payments.fields.category" },
  { key: "total", labelKey: "payments.sheet.total" },
];
const VIEWS: { key: SheetView; labelKey: string }[] = [
  { key: "planned", labelKey: "payments.flow.planned" },
  { key: "actual", labelKey: "payments.flow.actual" },
  { key: "difference", labelKey: "payments.flow.difference" },
];
const UNASSIGNED = "__unassigned__";

/** The name a line is filed under, for grouping and ordering. */
const categoryOf = (line: TBudgetForecastLine) => line.category_name ?? "";
const monthKey = (year: number, month: number) => `${year}-${String(month).padStart(2, "0")}`;
/** Less than nothing left: spending went past what was planned. */
const isOverspent = (value: unknown) => Number(value) < 0;
/** Income reduces what a budget costs: its planned figures count negative. */
const signed = (line: TBudgetForecastLine, value: string) => (line.kind === "INCOME" ? negateMoney(value) : value);

export function BudgetSpreadsheet({ workspaceSlug, scenario, refreshToken = 0, meta, actions, emptyState }: Props) {
  const { t } = useTranslation();
  const {
    data: forecast,
    mutate,
    error,
    isLoading,
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
  const [peek, setPeek] = useState<{ key: string; cell: string; month?: string } | null>(null);
  const [search, setSearch] = useState("");
  const [view, setView] = useState<SheetView>("planned");
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
  const months = useMemo(() => forecast?.months ?? [], [forecast]);
  const currencies = [...new Set((forecast?.lines ?? []).map((line) => line.currency))];
  const selectedCurrency = currencies.includes(currency) ? currency : (currencies[0] ?? scenario.currency);
  const tags = [...new Set((forecast?.lines ?? []).map((line) => line.category_name).filter(Boolean))].sort();
  const unassigned = forecast?.unassigned?.find((item) => item.currency === selectedCurrency);

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
  const lineByKey = (row: FinanceGridRow) => lines.find((line) => line.key === row.id);

  /** The three readings of one line, month by month. */
  const cellsOf = (line: TBudgetForecastLine) => {
    const planned = line.months.map((cell) => cell.amount);
    const actual = months.map(
      ({ year, month }) => (line.actual ?? []).find((cell) => cell.year === year && cell.month === month)?.amount ?? "0"
    );
    const difference = planned.map((value, index) => subtractMoney(value, actual[index]));
    return { planned, actual, difference };
  };

  const rows = useMemo<FinanceGridRow[]>(() => {
    const records: FinanceGridRow[] = lines.map((line) => {
      const cells = cellsOf(line)[view];
      const total =
        view === "planned"
          ? line.total
          : view === "actual"
            ? (line.actual_total ?? "0")
            : subtractMoney(line.total, line.actual_total ?? "0");
      return {
        id: line.key,
        concept: line.label,
        entity: line.entity_name,
        entityId: line.entity_id,
        category: categoryOf(line),
        categoryId: line.category_id,
        total,
        ...Object.fromEntries(months.map(({ year, month }, index) => [monthKey(year, month), cells[index]])),
      };
    });
    // Money filed against the budget without a line is still money spent: it
    // shows as its own row whenever the sheet reads real figures.
    if (view !== "planned" && unassigned && Number(unassigned.total) !== 0) {
      const values = months.map(
        ({ year, month }) => unassigned.months.find((cell) => cell.year === year && cell.month === month)?.amount ?? "0"
      );
      records.push({
        id: UNASSIGNED,
        family: "reference",
        concept: t("payments.flow.unassigned"),
        total: view === "actual" ? unassigned.total : negateMoney(unassigned.total),
        ...Object.fromEntries(
          months.map(({ year, month }, index) => [
            monthKey(year, month),
            view === "actual" ? values[index] : negateMoney(values[index]),
          ])
        ),
      });
    }
    if (!group) return records;
    const groups = new Map<string, FinanceGridRow[]>();
    for (const row of records) {
      const key = row.id === UNASSIGNED ? "—" : String(row.category || "—");
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
    // `cellsOf` only reads `months`, which is already a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, group, view, months, unassigned, t]);

  /** Planned, real and difference for the visible lines, month by month. */
  const summary = useMemo(() => {
    const extra = unassigned
      ? months.map(
          ({ year, month }) =>
            unassigned.months.find((cell) => cell.year === year && cell.month === month)?.amount ?? "0"
        )
      : months.map(() => "0");
    const planned = months.map((_, index) =>
      sumMoney(lines.map((line) => signed(line, line.months[index]?.amount ?? "0")))
    );
    const actual = months.map((_, index) =>
      sumMoney([...lines.map((line) => cellsOf(line).actual[index]), extra[index]])
    );
    const difference = planned.map((value, index) => subtractMoney(value, actual[index]));
    const plannedTotal = sumMoney(planned);
    const actualTotal = sumMoney(actual);
    return {
      planned,
      actual,
      difference,
      plannedTotal,
      actualTotal,
      differenceTotal: subtractMoney(plannedTotal, actualTotal),
    };
    // `cellsOf` only reads `months`, which is already a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, months, unassigned]);

  const totals = useMemo<FinanceGridRow[]>(() => {
    const row = (id: string, label: string, values: string[], total: string): FinanceGridRow => ({
      id,
      family: "subtotal",
      concept: label,
      total,
      ...Object.fromEntries(months.map(({ year, month }, index) => [monthKey(year, month), values[index]])),
    });
    return [
      row("total-planned", t("payments.flow.planned"), summary.planned, summary.plannedTotal),
      row("total-actual", t("payments.flow.actual"), summary.actual, summary.actualTotal),
      row("total-difference", t("payments.flow.difference"), summary.difference, summary.differenceTotal),
    ];
  }, [summary, months, t]);

  const columns = useMemo<FinanceGridColumn[]>(
    () => [
      {
        prop: "concept",
        name: t("payments.sheet.concept"),
        size: 236,
        pin: "colPinStart",
        onClick: (row) => row.id !== UNASSIGNED && setPeek({ key: row.id, cell: "" }),
        flags: (row) => ({ hasThread: counts.some((count) => count.row_key === row.id && !count.cell) }),
      },
      { prop: "entity", name: t("payroll.fields.office"), size: 150, pickable: true },
      { prop: "category", name: t("payments.fields.category"), size: 150, pickable: true },
      ...months.map(({ year, month }, index) => {
        const prop = monthKey(year, month);
        return {
          prop,
          name: new Intl.DateTimeFormat("es-MX", { month: "short", year: "2-digit" }).format(new Date(year, month - 1)),
          size: 106,
          amount: true,
          // Only the plan is typed in; real figures come from the ledger.
          editable: view === "planned",
          display: (row: FinanceGridRow) =>
            row[prop] === undefined ? "" : formatMoney(String(row[prop]), selectedCurrency),
          // In the real readings a cell opens the expenses behind it.
          onClick:
            view === "planned"
              ? undefined
              : (row: FinanceGridRow) => {
                  if (!row.family && row.id !== UNASSIGNED) setPeek({ key: row.id, cell: prop, month: prop });
                },
          flags: (row: FinanceGridRow) => {
            const line = lineByKey(row);
            return {
              override: view === "planned" && line?.months[index]?.is_overridden,
              isLinked: view === "planned" && !row.family && !line?.months[index]?.is_overridden,
              hasThread: counts.some((count) => count.row_key === row.id && count.cell === prop),
              tone: view === "difference" && isOverspent(row[prop]) ? ("danger" as const) : undefined,
            };
          },
        };
      }),
      {
        prop: "total",
        name: t("payments.sheet.total"),
        size: 140,
        pin: "colPinEnd",
        amount: true,
        display: (row) => (row.total === undefined ? "" : formatMoney(String(row.total), selectedCurrency)),
        flags: (row) => ({
          tone:
            (view === "difference" || row.id === "total-difference") && isOverspent(row.total)
              ? ("danger" as const)
              : undefined,
        }),
      },
    ],
    // `lineByKey` only reads `lines`, which is already a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [months, selectedCurrency, lines, t, counts, view]
  );

  const activeFilters = shown.length + hidden.length;
  const peekLine = forecast?.lines.find((line) => line.key === peek?.key);
  const actual = forecast?.actuals?.find((item) => item.currency === selectedCurrency);
  const plannedTotal = summary.plannedTotal;
  const spentTotal = sumMoney([actual?.paid ?? "0", actual?.pending ?? "0"]);
  const available = subtractMoney(plannedTotal, spentTotal);
  const consumed =
    Number(plannedTotal) > 0 ? Math.min(999, Math.round((Number(spentTotal) / Number(plannedTotal)) * 100)) : 0;

  return (
    <div className="flex h-full min-h-0 w-full flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-subtle px-4 py-2.5">
        <div className="relative">
          <Search className="absolute top-2 left-2 size-4 text-tertiary" />
          <input
            value={search}
            aria-label={t("payments.sheet.search")}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("payments.sheet.search")}
            className="h-8 rounded-sm border border-subtle bg-layer-1 pr-2 pl-8 text-12 outline-none focus:border-accent-strong"
          />
        </div>
        {/* Which reading the month cells show. */}
        <div
          role="radiogroup"
          aria-label={t("payments.flow.view")}
          className="flex h-8 rounded-sm border border-subtle p-0.5"
        >
          {VIEWS.map(({ key, labelKey }) => (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={view === key}
              onClick={() => setView(key)}
              className={cn(
                "rounded-xs px-2.5 text-12",
                view === key ? "bg-layer-2 font-medium text-primary" : "text-secondary hover:text-primary"
              )}
            >
              {t(labelKey)}
            </button>
          ))}
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
        <div className="ml-auto flex items-center gap-2">{actions}</div>
      </div>

      {/* The one reading the whole page is for: what was planned, what really
          went out, and how much of the plan is used. */}
      <div className="flex shrink-0 flex-wrap items-end gap-x-8 gap-y-2 border-b border-subtle px-4 py-3">
        <dl className="flex flex-wrap items-end gap-x-8 gap-y-2">
          <div className="flex flex-col-reverse">
            <dt className="text-11 text-tertiary">{t("payments.flow.planned")}</dt>
            <dd className="font-mono text-15 font-semibold text-primary tabular-nums">
              {formatMoney(plannedTotal, selectedCurrency)}
            </dd>
          </div>
          <div className="flex flex-col-reverse">
            <dt className="text-11 text-tertiary">
              {t("payments.flow.actual_breakdown", {
                paid: formatMoney(actual?.paid ?? "0", selectedCurrency),
                pending: formatMoney(actual?.pending ?? "0", selectedCurrency),
              })}
            </dt>
            <dd className="font-mono text-15 font-semibold text-primary tabular-nums">
              {formatMoney(spentTotal, selectedCurrency)}
            </dd>
          </div>
          <div className="flex flex-col-reverse">
            <dt className="text-11 text-tertiary">{t("payments.flow.available")}</dt>
            <dd
              className={cn(
                "font-mono text-15 font-semibold tabular-nums",
                Number(available) < 0 ? "text-danger-primary" : "text-primary"
              )}
            >
              {formatMoney(available, selectedCurrency)}
            </dd>
          </div>
        </dl>
        <div className="flex min-w-48 flex-1 flex-col gap-1 sm:max-w-80">
          <div className="flex justify-between text-11 text-tertiary">
            <span>{t("payments.flow.consumed")}</span>
            <span className={cn("tabular-nums", consumed > 100 && "text-danger-primary")}>{consumed}%</span>
          </div>
          <div
            className="h-1.5 overflow-hidden rounded-full bg-layer-3"
            role="progressbar"
            aria-valuenow={consumed}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={t("payments.flow.consumed")}
          >
            <div
              className={cn("h-full rounded-full", consumed > 100 ? "bg-danger-primary" : "bg-accent-primary")}
              style={{ width: `${Math.min(100, consumed)}%` }}
            />
          </div>
        </div>
      </div>

      {error && (
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-subtle bg-danger-subtle px-4 py-2 text-12">
          <span className="text-danger-primary">{t("payments.sheet.load_error")}</span>
          <Button variant="secondary" size="sm" onClick={() => void mutate()}>
            {t("payments.ledger.retry")}
          </Button>
        </div>
      )}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {isLoading && !forecast ? (
          <div className="flex flex-1 items-center justify-center" role="status">
            <Loader2 className="size-5 animate-spin text-tertiary" aria-label={t("payments.ledger.loading")} />
          </div>
        ) : forecast && forecast.lines.length === 0 && emptyState ? (
          <div className="flex-1 overflow-y-auto">{emptyState}</div>
        ) : (
          <FinanceGrid
            rows={rows}
            totals={totals}
            columns={columns}
            emptyLabel={t("payments.sheet.empty_title")}
            onPickCell={(row, prop, anchor) => row.id !== UNASSIGNED && setCellPicker({ key: row.id, prop, anchor })}
            onComment={(row, cell) => row.id !== UNASSIGNED && setPeek({ key: row.id, cell })}
            onEdit={async (row, prop, value) => {
              const [year, month] = prop.split("-").map(Number);
              const clean = value.trim().replaceAll(",", "");
              try {
                // An emptied cell goes back to the calculated figure.
                if (!clean) {
                  await financeService.restoreScenarioCell(workspaceSlug, scenario.id, {
                    row_key: row.id,
                    year,
                    month,
                  });
                } else if (/^\d+(\.\d{1,2})?$/.test(clean)) {
                  await financeService.overrideScenarioCell(workspaceSlug, scenario.id, {
                    row_key: row.id,
                    year,
                    month,
                    amount: clean,
                  });
                } else {
                  setToast({ type: TOAST_TYPE.ERROR, title: t("payments.sheet.invalid_amount") });
                  return;
                }
                await mutate();
              } catch (reason) {
                setToast({
                  type: TOAST_TYPE.ERROR,
                  title: t("payments.toasts.error"),
                  message: getApiErrorMessage(reason),
                });
              }
            }}
          />
        )}
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
          key={`${peek.key}-${peek.month ?? ""}`}
          workspaceSlug={workspaceSlug}
          scenario={scenario}
          line={peekLine}
          cell={peek.month ? "" : peek.cell}
          month={peek.month}
          onClose={() => setPeek(null)}
          onChanged={() => void mutate()}
        />
      )}
    </div>
  );
}
