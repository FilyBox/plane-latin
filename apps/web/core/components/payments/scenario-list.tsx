/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useMemo, useState } from "react";
import { ArrowUpDown, Filter, Loader2, Plus, Search, Trash2 } from "lucide-react";
import useSWR from "swr";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { Menu } from "@plane/propel/menu";
import { Popover } from "@plane/propel/popover";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TBudgetScenario, TBudgetScenarioStatus } from "@plane/types";
import { AlertModalCore } from "@plane/ui";
import { cn } from "@plane/utils";
import { ContractBulkActionsBar, ContractSelectionCheckbox } from "@/components/file-library/contracts/list-controls";
import { financeService } from "@/services/finance.service";
import { BudgetScenarioModal } from "./scenario-modal";
import { getApiErrorMessage } from "./shared";

type Props = {
  workspaceSlug: string;
  onOpen: (scenario: TBudgetScenario) => void;
};

const STATUSES: TBudgetScenarioStatus[] = ["DRAFT", "ACTIVE", "ARCHIVED"];
const ORDERS = ["-created_at", "name", "-fiscal_year", "fiscal_year"] as const;

export function BudgetScenarioList({ workspaceSlug, onOpen }: Props) {
  const { t } = useTranslation();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [year, setYear] = useState<number | "all">("all");
  const [statuses, setStatuses] = useState<TBudgetScenarioStatus[]>([]);
  const [order, setOrder] = useState<(typeof ORDERS)[number]>("-created_at");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [isActing, setIsActing] = useState(false);

  const {
    data: scenarios,
    mutate,
    isLoading,
  } = useSWR<TBudgetScenario[]>(`BUDGET_SCENARIOS_${workspaceSlug}`, () => financeService.getScenarios(workspaceSlug), {
    revalidateOnFocus: false,
  });

  const years = useMemo(
    () => [...new Set((scenarios ?? []).map((scenario) => scenario.fiscal_year))].sort((a, b) => b - a),
    [scenarios]
  );

  const rows = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (scenarios ?? [])
      .filter(
        (scenario) =>
          (year === "all" || scenario.fiscal_year === year) &&
          (statuses.length === 0 || statuses.includes(scenario.status)) &&
          (!query || scenario.name.toLowerCase().includes(query) || scenario.description.toLowerCase().includes(query))
      )
      .sort((a, b) =>
        order === "name"
          ? a.name.localeCompare(b.name)
          : order === "fiscal_year"
            ? a.fiscal_year - b.fiscal_year
            : order === "-fiscal_year"
              ? b.fiscal_year - a.fiscal_year
              : b.created_at.localeCompare(a.created_at)
      );
  }, [scenarios, search, year, statuses, order]);

  const activeFilters = (year === "all" ? 0 : 1) + statuses.length;
  const allSelected = rows.length > 0 && selectedIds.length === rows.length;
  const selected = rows.filter((scenario) => selectedIds.includes(scenario.id));

  const report = (error: unknown) =>
    setToast({ type: TOAST_TYPE.ERROR, title: t("payments.toasts.error"), message: getApiErrorMessage(error) });

  /** Budgets are few and the API has no bulk route, so the selection is applied
   * one call at a time and refreshed once at the end. */
  const applyToSelection = async (action: (scenario: TBudgetScenario) => Promise<unknown>) => {
    setIsActing(true);
    try {
      await Promise.all(selected.map(action));
      setSelectedIds([]);
      await mutate();
    } catch (error) {
      report(error);
    } finally {
      setIsActing(false);
      setIsDeleteOpen(false);
    }
  };

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-surface-1">
      <BudgetScenarioModal
        workspaceSlug={workspaceSlug}
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        onSaved={() => void mutate()}
      />
      <AlertModalCore
        isOpen={isDeleteOpen}
        handleClose={() => !isActing && setIsDeleteOpen(false)}
        isSubmitting={isActing}
        title={t("payments.scenarios.delete_title")}
        content={t("payments.scenarios.delete_description")}
        handleSubmit={() =>
          void applyToSelection((scenario) => financeService.deleteScenario(workspaceSlug, scenario.id))
        }
      />

      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-subtle px-3 py-2.5 sm:px-4">
        <div className="flex min-w-0 items-center gap-2">
          <div className="relative">
            <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-tertiary" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("payments.scenarios.search")}
              className="w-36 rounded-md border border-subtle bg-transparent py-1.5 pr-2 pl-8 text-12 sm:w-64"
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
              <div className="w-56 rounded-md border border-subtle bg-layer-1 p-2 shadow-raised-200">
                <p className="px-1 py-0.5 text-11 font-medium text-tertiary">{t("payments.fields.status")}</p>
                {STATUSES.map((status) => (
                  <button
                    key={status}
                    type="button"
                    onClick={() =>
                      setStatuses((current) =>
                        current.includes(status) ? current.filter((item) => item !== status) : [...current, status]
                      )
                    }
                    className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-13 hover:bg-layer-1-hover"
                  >
                    <ContractSelectionCheckbox
                      checked={statuses.includes(status)}
                      onChange={() =>
                        setStatuses((current) =>
                          current.includes(status) ? current.filter((item) => item !== status) : [...current, status]
                        )
                      }
                    />
                    {t(`payments.scenarios.status.${status.toLowerCase()}`)}
                  </button>
                ))}
                <p className="mt-2 border-t border-subtle px-1 pt-2 pb-0.5 text-11 font-medium text-tertiary">
                  {t("payments.scenarios.fiscal_year")}
                </p>
                <select
                  aria-label={t("payments.scenarios.fiscal_year")}
                  value={year}
                  onChange={(event) => setYear(event.target.value === "all" ? "all" : Number(event.target.value))}
                  className="h-8 w-full rounded-sm border border-subtle bg-transparent px-2 text-12"
                >
                  <option value="all">{t("payments.scenarios.all_years")}</option>
                  {years.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
                {activeFilters > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setStatuses([]);
                      setYear("all");
                    }}
                    className="mt-2 w-full border-t border-subtle pt-2 text-12 text-accent-primary"
                  >
                    {t("payments.ledger.clear")}
                  </button>
                )}
              </div>
            </Popover.Panel>
          </Popover>

          <label className="relative flex items-center">
            <ArrowUpDown className="pointer-events-none absolute left-2 size-3.5 text-tertiary" />
            <select
              aria-label={t("payments.ledger.sort")}
              value={order}
              onChange={(event) => setOrder(event.target.value as (typeof ORDERS)[number])}
              className="h-8 rounded-sm border border-subtle bg-surface-1 pr-7 pl-7 text-12 text-secondary hover:bg-layer-1-hover"
            >
              <option value="-created_at">{t("payments.ledger.date_desc")}</option>
              <option value="name">{t("payments.ledger.concept_asc")}</option>
              <option value="-fiscal_year">{t("payments.scenarios.year_desc")}</option>
              <option value="fiscal_year">{t("payments.scenarios.year_asc")}</option>
            </select>
          </label>
        </div>

        <Button variant="primary" size="sm" onClick={() => setIsCreateOpen(true)}>
          <Plus className="size-3.5" />
          {t("payments.scenarios.create")}
        </Button>
      </div>

      <ContractBulkActionsBar count={selectedIds.length} onClear={() => setSelectedIds([])}>
        <Menu
          customButton={
            <span className="flex h-7 items-center rounded-sm border border-subtle bg-surface-1 px-2.5 text-12">
              {t("payments.scenarios.change_status")}
            </span>
          }
          ariaLabel={t("payments.scenarios.change_status")}
        >
          {STATUSES.map((status) => (
            <Menu.MenuItem
              key={status}
              disabled={isActing}
              onClick={() =>
                void applyToSelection((scenario) =>
                  financeService.updateScenario(workspaceSlug, scenario.id, { status })
                )
              }
            >
              <span className="text-12">{t(`payments.scenarios.status.${status.toLowerCase()}`)}</span>
            </Menu.MenuItem>
          ))}
        </Menu>
        <Button variant="secondary" size="sm" disabled={isActing} onClick={() => setIsDeleteOpen(true)}>
          <Trash2 className="size-3.5" />
          {t("payments.actions.delete")}
        </Button>
      </ContractBulkActionsBar>

      <div className="min-h-0 flex-1 overflow-auto">
        {isLoading ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="size-5 animate-spin text-tertiary" />
          </div>
        ) : rows.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-tertiary">
            <p className="text-14 font-medium text-primary">{t("payments.scenarios.empty_title")}</p>
            <p className="max-w-sm text-12">{t("payments.scenarios.empty_description")}</p>
          </div>
        ) : (
          <table className="w-full min-w-205 border-collapse text-left">
            <thead className="sticky top-0 z-1 bg-surface-1">
              <tr className="border-b border-subtle text-11 font-medium text-tertiary">
                <th className="w-10 px-4 py-2">
                  <ContractSelectionCheckbox
                    checked={allSelected}
                    onChange={() => setSelectedIds(allSelected ? [] : rows.map((scenario) => scenario.id))}
                  />
                </th>
                <th className="px-2 py-2">{t("payments.scenarios.name")}</th>
                <th className="px-3 py-2">{t("payments.fields.status")}</th>
                <th className="px-3 py-2">{t("payments.scenarios.fiscal_year")}</th>
                <th className="px-3 py-2">{t("payments.fields.period")}</th>
                <th className="px-3 py-2">{t("payments.fields.currency")}</th>
                <th className="px-3 py-2 text-right">{t("payments.composer.people")}</th>
                <th className="px-3 py-2 text-right">{t("payments.composer.variables")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((scenario) => (
                <tr
                  key={scenario.id}
                  onClick={() => onOpen(scenario)}
                  className="cursor-pointer border-b border-subtle text-13 hover:bg-layer-1-hover"
                >
                  <td className="px-4 py-2.5">
                    <ContractSelectionCheckbox
                      checked={selectedIds.includes(scenario.id)}
                      onChange={() =>
                        setSelectedIds((current) =>
                          current.includes(scenario.id)
                            ? current.filter((id) => id !== scenario.id)
                            : [...current, scenario.id]
                        )
                      }
                    />
                  </td>
                  <td className="max-w-72 px-2 py-2.5">
                    <p className="truncate font-medium">{scenario.name}</p>
                    {scenario.description && <p className="truncate text-11 text-tertiary">{scenario.description}</p>}
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap text-secondary">
                    {t(`payments.scenarios.status.${scenario.status.toLowerCase()}`)}
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap tabular-nums">{scenario.fiscal_year}</td>
                  <td className="px-3 py-2.5 whitespace-nowrap text-secondary tabular-nums">
                    {scenario.period_start} / {scenario.period_end}
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap">{scenario.currency}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{scenario.employee_count}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{scenario.variable_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
