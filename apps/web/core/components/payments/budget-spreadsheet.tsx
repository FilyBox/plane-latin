/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { RotateCcw, Search, Sigma } from "lucide-react";
import useSWR from "swr";
import { useTranslation } from "@plane/i18n";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TBudgetForecast, TBudgetForecastCell, TBudgetForecastLine, TBudgetScenario } from "@plane/types";
import { cn } from "@plane/utils";
import { financeService } from "@/services/finance.service";
import { formatMoney } from "./shared";

type Aggregate = "SUM" | "AVERAGE" | "MIN" | "MAX" | "COUNT";
type EditingCell = { rowKey: string; year: number; month: number } | null;

type Props = {
  workspaceSlug: string;
  scenario: TBudgetScenario;
  refreshToken?: number;
};

const aggregateValues = (values: number[], operation: Aggregate) => {
  if (operation === "COUNT") return values.length;
  if (values.length === 0) return 0;
  if (operation === "AVERAGE") return values.reduce((total, value) => total + value, 0) / values.length;
  if (operation === "MIN") return Math.min(...values);
  if (operation === "MAX") return Math.max(...values);
  return values.reduce((total, value) => total + value, 0);
};

const cellId = (rowKey: string, year: number, month: number) => `${rowKey}:${year}-${month}`;

export function BudgetSpreadsheet({ workspaceSlug, scenario, refreshToken = 0 }: Props) {
  const { t } = useTranslation();
  const {
    data: forecast,
    mutate,
    isLoading,
  } = useSWR<TBudgetForecast>(
    `BUDGET_FORECAST_${workspaceSlug}_${scenario.id}`,
    () => financeService.getScenarioForecast(workspaceSlug, scenario.id),
    { revalidateOnFocus: false }
  );
  const [editing, setEditing] = useState<EditingCell>(null);
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [operation, setOperation] = useState<Aggregate>("SUM");
  const [currency, setCurrency] = useState(scenario.currency);
  const cancelledEdit = useRef(false);
  const initialRefreshToken = useRef(refreshToken);

  useEffect(() => {
    if (refreshToken !== initialRefreshToken.current) void mutate();
  }, [mutate, refreshToken]);

  const currencies = useMemo(
    () => Array.from(new Set((forecast?.lines ?? []).map((line) => line.currency))),
    [forecast?.lines]
  );
  const visibleCurrency = currencies.includes(currency) ? currency : (currencies[0] ?? scenario.currency);
  const lines = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return (forecast?.lines ?? []).filter(
      (line) =>
        line.currency === visibleCurrency &&
        (!query || `${line.label} ${line.entity_name} ${line.category}`.toLocaleLowerCase().includes(query))
    );
  }, [forecast?.lines, search, visibleCurrency]);

  const openEditor = (line: TBudgetForecastLine, cell: TBudgetForecastCell) => {
    cancelledEdit.current = false;
    setDraft(cell.amount);
    setEditing({ rowKey: line.key, year: cell.year, month: cell.month });
  };

  const saveCell = async (line: TBudgetForecastLine, cell: TBudgetForecastCell) => {
    if (cancelledEdit.current) {
      cancelledEdit.current = false;
      return;
    }
    const normalized = draft.trim().replace(/,/g, "");
    const amount = Number(normalized);
    setEditing(null);
    if (!Number.isFinite(amount) || amount < 0 || normalized === "") {
      setToast({ type: TOAST_TYPE.ERROR, title: t("payments.sheet.invalid_amount") });
      return;
    }
    try {
      await financeService.overrideScenarioCell(workspaceSlug, scenario.id, {
        row_key: line.key,
        year: cell.year,
        month: cell.month,
        amount: amount.toFixed(2),
      });
      await mutate();
    } catch {
      setToast({ type: TOAST_TYPE.ERROR, title: t("payments.toasts.error") });
    }
  };

  const restoreCell = async (line: TBudgetForecastLine, cell: TBudgetForecastCell) => {
    await financeService.restoreScenarioCell(workspaceSlug, scenario.id, {
      row_key: line.key,
      year: cell.year,
      month: cell.month,
    });
    await mutate();
  };

  if (isLoading) {
    return <div className="m-4 h-72 animate-pulse rounded-xl border border-subtle bg-layer-1 sm:m-6" />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col p-3 sm:p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="relative min-w-48 flex-1 sm:max-w-80">
          <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-tertiary" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("payments.sheet.search")}
            className="focus:border-accent-primary h-8 w-full rounded-md border border-subtle bg-layer-1 pr-3 pl-8 text-12 text-primary outline-none"
          />
        </div>
        <div className="flex items-center gap-2">
          {currencies.length > 1 && (
            <select
              value={visibleCurrency}
              onChange={(event) => setCurrency(event.target.value)}
              className="h-8 rounded-md border border-subtle bg-layer-1 px-2 text-11 text-secondary"
            >
              {currencies.map((item) => (
                <option key={item}>{item}</option>
              ))}
            </select>
          )}
          <span className="hidden text-11 text-tertiary sm:inline">{t("payments.sheet.edit_help")}</span>
        </div>
      </div>

      <div className="shadow-sm min-h-0 flex-1 overflow-auto rounded-lg border border-subtle bg-layer-1">
        <table className="w-max min-w-full border-separate border-spacing-0 text-11">
          <thead className="sticky top-0 z-[3] bg-layer-2">
            <tr>
              <th className="sticky left-0 z-[4] h-10 min-w-52 border-r border-b border-subtle bg-layer-2 px-3 text-left font-medium text-secondary sm:min-w-64">
                {t("payments.sheet.concept")}
              </th>
              <th className="h-10 min-w-32 border-r border-b border-subtle px-3 text-left font-medium text-secondary">
                {t("payments.sheet.entity")}
              </th>
              {(forecast?.months ?? []).map(({ year, month }) => (
                <th
                  key={`${year}-${month}`}
                  className="h-10 min-w-28 border-r border-b border-subtle px-3 text-right font-medium text-secondary"
                >
                  {new Intl.DateTimeFormat(undefined, { month: "short" }).format(new Date(year, month - 1, 1))}
                  <span className="ml-1 text-9 text-tertiary">{year}</span>
                </th>
              ))}
              <th className="h-10 min-w-32 border-b border-subtle px-3 text-right font-semibold text-primary">
                {t("payments.sheet.total")}
              </th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr key={line.key} className="group hover:bg-layer-1-hover">
                <td className="sticky left-0 z-[2] h-11 max-w-64 border-r border-b border-subtle bg-layer-1 px-3 group-hover:bg-layer-1-hover">
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        "size-1.5 shrink-0 rounded-full",
                        line.kind === "INCOME" ? "bg-success-primary" : "bg-warning-primary"
                      )}
                    />
                    <div className="min-w-0">
                      <p className="truncate font-medium text-primary">{line.label}</p>
                      <p className="text-9 text-tertiary">
                        {t(`payments.sheet.category.${line.category.toLowerCase()}`)}
                      </p>
                    </div>
                  </div>
                </td>
                <td className="h-11 max-w-40 truncate border-r border-b border-subtle px-3 text-secondary">
                  {line.entity_name || "-"}
                </td>
                {line.months.map((cell) => {
                  const isEditing =
                    editing?.rowKey === line.key && editing.year === cell.year && editing.month === cell.month;
                  return (
                    <td
                      key={cellId(line.key, cell.year, cell.month)}
                      className={cn(
                        "relative h-11 border-r border-b border-subtle p-0 text-right tabular-nums",
                        cell.is_overridden && "bg-accent-primary/5"
                      )}
                    >
                      {isEditing ? (
                        <input
                          ref={(input) => input?.focus()}
                          inputMode="decimal"
                          value={draft}
                          onChange={(event) => setDraft(event.target.value)}
                          onBlur={() => void saveCell(line, cell)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === "Tab") event.currentTarget.blur();
                            if (event.key === "Escape") {
                              cancelledEdit.current = true;
                              setEditing(null);
                            }
                          }}
                          className="border-accent-primary h-full w-full border-2 bg-surface-1 px-2 text-right text-11 font-medium text-primary outline-none"
                        />
                      ) : (
                        <>
                          {cell.is_overridden && (
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                void restoreCell(line, cell);
                              }}
                              className="absolute top-1/2 left-1 z-10 flex size-6 -translate-y-1/2 items-center justify-center rounded-sm opacity-0 transition-opacity group-hover:opacity-100 hover:bg-layer-2 focus:opacity-100"
                              title={t("payments.sheet.restore")}
                            >
                              <RotateCcw className="size-3 text-accent-primary" />
                            </button>
                          )}
                          <button
                            type="button"
                            onDoubleClick={() => openEditor(line, cell)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" || event.key === "F2") openEditor(line, cell);
                            }}
                            onClick={() => {
                              if (window.matchMedia("(max-width: 767px)").matches) openEditor(line, cell);
                            }}
                            className="focus:ring-accent-primary flex h-full w-full items-center justify-end px-2 text-right text-secondary outline-none hover:bg-accent-primary/5 focus:ring-2 focus:ring-inset"
                            title={
                              cell.is_overridden
                                ? `${t("payments.sheet.automatic")}: ${formatMoney(cell.automatic, line.currency)}`
                                : t("payments.sheet.edit_help")
                            }
                          >
                            <span className={cn(cell.is_overridden && "font-semibold text-accent-primary")}>
                              {formatMoney(cell.amount, line.currency)}
                            </span>
                          </button>
                        </>
                      )}
                    </td>
                  );
                })}
                <td className="h-11 border-b border-subtle bg-layer-2/50 px-3 text-right font-semibold text-primary tabular-nums">
                  {formatMoney(line.total, line.currency)}
                </td>
              </tr>
            ))}
          </tbody>
          {lines.length > 0 && (
            <tfoot className="sticky bottom-0 z-[3] bg-layer-2">
              <tr>
                <td className="sticky left-0 z-[4] h-11 border-t border-r border-subtle bg-layer-2 px-3">
                  <label className="flex items-center gap-2">
                    <Sigma className="size-3.5 text-accent-primary" />
                    <select
                      value={operation}
                      onChange={(event) => setOperation(event.target.value as Aggregate)}
                      className="bg-transparent text-10 font-semibold text-primary outline-none"
                    >
                      {(["SUM", "AVERAGE", "MIN", "MAX", "COUNT"] as Aggregate[]).map((item) => (
                        <option key={item} value={item}>
                          {t(`payments.sheet.aggregate.${item.toLowerCase()}`)}
                        </option>
                      ))}
                    </select>
                  </label>
                </td>
                <td className="border-t border-r border-subtle px-3 text-10 text-tertiary">
                  {lines.length} {t("payments.sheet.rows")}
                </td>
                {(forecast?.months ?? []).map(({ year, month }, index) => {
                  const value = aggregateValues(
                    lines.map((line) => Number(line.months[index]?.amount ?? 0)),
                    operation
                  );
                  return (
                    <td
                      key={`${year}-${month}`}
                      className="border-t border-r border-subtle px-3 text-right font-semibold text-primary tabular-nums"
                    >
                      {operation === "COUNT" ? value : formatMoney(String(value), visibleCurrency)}
                    </td>
                  );
                })}
                <td className="border-t border-subtle px-3 text-right font-semibold text-primary tabular-nums">
                  {operation === "COUNT"
                    ? lines.length
                    : formatMoney(
                        String(
                          aggregateValues(
                            lines.map((line) => Number(line.total)),
                            operation
                          )
                        ),
                        visibleCurrency
                      )}
                </td>
              </tr>
            </tfoot>
          )}
        </table>
        {lines.length === 0 && (
          <div className="flex min-h-64 flex-col items-center justify-center p-6 text-center">
            <Sigma className="size-6 text-tertiary" />
            <p className="mt-3 text-13 font-medium text-primary">{t("payments.sheet.empty_title")}</p>
            <p className="mt-1 max-w-sm text-11 text-tertiary">{t("payments.sheet.empty_description")}</p>
          </div>
        )}
      </div>
    </div>
  );
}
