/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useMemo, useState } from "react";
import {
  BriefcaseBusiness,
  CalendarDays,
  ChevronDown,
  Link2,
  Download,
  Edit3,
  FileSpreadsheet,
  Library,
  MoreHorizontal,
  Plus,
  ReceiptText,
  Settings2,
  Trash2,
  Users,
  Variable,
  Wallet,
} from "lucide-react";
import useSWR, { useSWRConfig } from "swr";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { Menu } from "@plane/propel/menu";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TBudgetScenario, TBudgetScenarioVariable, TExpense, TFinancialVariable, TOffice } from "@plane/types";
import { cn } from "@plane/utils";
import useDebounce from "@/hooks/use-debounce";
import { financeService } from "@/services/finance.service";
import { payrollService } from "@/services/payroll.service";
import { BudgetPeekPanel } from "./budget-peek-panel";
import { BudgetResourceComposer, type ComposerTab } from "./budget-resource-composer";
import { ExpensesTab } from "./expenses-tab";
import { LinkExpensesPanel } from "./link-expenses-panel";
import { EmployeesTab } from "./payroll/employees";
import { PayrollSection } from "./payroll/payroll-section";
import { OfficesModal } from "./payroll/offices-modal";
import { BudgetScenarioModal } from "./scenario-modal";
import { formatMoney, formatYearRange, getApiErrorMessage } from "./shared";
import { FinancialVariableModal } from "./variable-modal";
import { BudgetSpreadsheet } from "./budget-spreadsheet";
import { ResourceSearch } from "./resource-search";
import { FinanceConfirmModal } from "./confirm-modal";

type Panel = { kind: "compose"; tab: ComposerTab } | { kind: "resources" } | { kind: "link" };
type ResourceSection = "people" | "variables" | "expenses" | "payroll";

type Props = {
  workspaceSlug: string;
  scenario: TBudgetScenario;
  onChanged: (scenario: TBudgetScenario) => void;
  onDeleted: () => void;
};

export function BudgetScenarioDetail({ workspaceSlug, scenario, onChanged, onDeleted }: Props) {
  const { t } = useTranslation();
  const { mutate: mutateGlobal } = useSWRConfig();
  const [panel, setPanel] = useState<Panel | null>(null);
  const [sheetRefreshToken, setSheetRefreshToken] = useState(0);
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isExporting, setIsExporting] = useState(false);

  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      await financeService.deleteScenario(workspaceSlug, scenario.id);
      onDeleted();
    } catch {
      setToast({ type: TOAST_TYPE.ERROR, title: t("payments.toasts.error") });
    } finally {
      setIsDeleting(false);
    }
  };

  const handleExport = async (format: "csv" | "xlsx") => {
    setIsExporting(true);
    try {
      await financeService.exportScenario(
        workspaceSlug,
        scenario.id,
        format,
        `${scenario.name}-${scenario.fiscal_year}`
      );
    } catch {
      setToast({ type: TOAST_TYPE.ERROR, title: t("payments.toasts.error") });
    } finally {
      setIsExporting(false);
    }
  };

  const closePanel = () => {
    setPanel(null);
    setSheetRefreshToken((value) => value + 1);
  };

  /** Files expenses already on the ledger against this budget, one by one so a
   * failure leaves the rest untouched. */
  const linkExpenses = async (expenses: TExpense[], budgetLine: string) => {
    try {
      for (const expense of expenses)
        // eslint-disable-next-line no-await-in-loop
        await financeService.updateExpense(workspaceSlug, expense.id, {
          scenario: scenario.id,
          budget_line: budgetLine || null,
        });
      setToast({ type: TOAST_TYPE.SUCCESS, title: t("payments.flow.linked", { count: expenses.length }) });
    } catch (error) {
      setToast({ type: TOAST_TYPE.ERROR, title: t("payments.toasts.error"), message: getApiErrorMessage(error) });
    } finally {
      void mutateGlobal((key) => Array.isArray(key) && ["PAYMENT_EXPENSES", "LINKABLE_EXPENSES"].includes(key[0]));
      void mutateGlobal(`BUDGET_SCENARIOS_${workspaceSlug}_TOTALS`);
      setSheetRefreshToken((value) => value + 1);
    }
  };

  const openComposer = (tab: ComposerTab) => setPanel({ kind: "compose", tab });
  const addOptions: { tab: ComposerTab | "link"; icon: typeof Users; title: string; help: string }[] = [
    {
      tab: "variables",
      icon: Variable,
      title: t("payments.composer.menu_item"),
      help: t("payments.composer.menu_item_help"),
    },
    {
      tab: "people",
      icon: Users,
      title: t("payments.composer.menu_people"),
      help: t("payments.composer.menu_people_help"),
    },
    { tab: "link", icon: Link2, title: t("payments.composer.menu_link"), help: t("payments.composer.menu_link_help") },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-1">
      <BudgetScenarioModal
        workspaceSlug={workspaceSlug}
        isOpen={isEditOpen}
        scenario={scenario}
        onClose={() => setIsEditOpen(false)}
        onSaved={(next) => {
          // A new period or currency changes every column of the sheet and the
          // name in the breadcrumb: both are fetched again.
          onChanged(next);
          void mutateGlobal(`BUDGET_FORECAST_${workspaceSlug}_${scenario.id}`);
          void mutateGlobal(`BUDGET_SCENARIO_${workspaceSlug}_${scenario.id}`);
          void mutateGlobal(`BUDGET_SCENARIOS_${workspaceSlug}`);
        }}
      />
      <FinanceConfirmModal
        isOpen={isDeleteOpen}
        handleClose={() => setIsDeleteOpen(false)}
        handleSubmit={() => void handleDelete()}
        isSubmitting={isDeleting}
        title={t("payments.scenarios.delete_title")}
        content={t("payments.scenarios.delete_description")}
      />

      <BudgetSpreadsheet
        workspaceSlug={workspaceSlug}
        scenario={scenario}
        refreshToken={sheetRefreshToken}
        emptyState={
          <div className="mx-auto flex max-w-3xl flex-col items-center px-6 py-16 text-center">
            <h2 className="text-15 font-medium text-primary">{t("payments.sheet.empty_title")}</h2>
            <p className="mt-1 max-w-md text-13 text-tertiary">{t("payments.sheet.empty_description")}</p>
            <div className="mt-6 grid w-full gap-3 sm:grid-cols-3">
              {addOptions.map(({ tab, icon: Icon, title, help }) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => (tab === "link" ? setPanel({ kind: "link" }) : openComposer(tab))}
                  className="focus-visible:outline-accent-primary flex flex-col items-start gap-2 rounded-lg border border-subtle p-4 text-left hover:border-strong hover:bg-layer-1-hover focus-visible:outline-2"
                >
                  <Icon className="size-4 text-tertiary" />
                  <span className="text-13 font-medium text-primary">{title}</span>
                  <span className="text-12 text-tertiary">{help}</span>
                </button>
              ))}
            </div>
          </div>
        }
        meta={
          <span className="hidden items-center gap-1.5 text-11 whitespace-nowrap text-tertiary md:flex">
            <CalendarDays className="size-3" />
            {scenario.period_start} / {scenario.period_end} · {scenario.currency}
          </span>
        }
        actions={
          <>
            {/* One entry point, and the first thing it asks is what is being
                added: each kind has its own form and its own list. */}
            <Menu
              customButton={
                <span className="flex h-6 items-center gap-1 rounded-md bg-accent-primary px-2 text-body-xs-medium text-on-color hover:bg-accent-primary-hover">
                  <Plus className="size-3.5" />
                  {t("payments.composer.open")}
                  <ChevronDown className="size-3" />
                </span>
              }
              optionsClassName="w-72"
              ariaLabel={t("payments.composer.title")}
            >
              {addOptions.map(({ tab, icon: Icon, title, help }) => (
                <Menu.MenuItem
                  key={tab}
                  onClick={() => (tab === "link" ? setPanel({ kind: "link" }) : openComposer(tab))}
                >
                  <span className="flex items-start gap-2.5 py-0.5">
                    <Icon className="mt-0.5 size-4 shrink-0 text-tertiary" />
                    <span className="min-w-0">
                      <span className="block text-13 text-primary">{title}</span>
                      <span className="block text-11 text-tertiary">{help}</span>
                    </span>
                  </span>
                </Menu.MenuItem>
              ))}
            </Menu>
            <Button variant="secondary" size="base" onClick={() => setPanel({ kind: "resources" })}>
              <Library className="size-3.5" />
              {t("payments.composer.resources")}
            </Button>
            <Menu
              customButton={
                <span className="flex size-8 items-center justify-center rounded-md border border-subtle text-secondary hover:bg-layer-1-hover">
                  <MoreHorizontal className="size-4" />
                </span>
              }
              optionsClassName="w-56"
              ariaLabel={t("payments.ledger.more_actions")}
            >
              <Menu.MenuItem onClick={() => setIsEditOpen(true)}>
                <span className="flex items-center gap-2 text-12">
                  <Settings2 className="size-3.5" />
                  {t("payments.scenarios.settings")}
                </span>
              </Menu.MenuItem>
              <Menu.MenuItem disabled={isExporting} onClick={() => void handleExport("xlsx")}>
                <span className="flex items-center gap-2 text-12">
                  <FileSpreadsheet className="size-3.5" />
                  {t("payments.sheet.export_xlsx")}
                </span>
              </Menu.MenuItem>
              <Menu.MenuItem disabled={isExporting} onClick={() => void handleExport("csv")}>
                <span className="flex items-center gap-2 text-12">
                  <Download className="size-3.5" />
                  {t("payments.sheet.export_csv")}
                </span>
              </Menu.MenuItem>
              <Menu.MenuItem onClick={() => setIsDeleteOpen(true)}>
                <span className="flex items-center gap-2 text-12 text-danger-primary">
                  <Trash2 className="size-3.5" />
                  {t("payments.actions.delete")}
                </span>
              </Menu.MenuItem>
            </Menu>
          </>
        }
      />

      <LinkExpensesPanel
        workspaceSlug={workspaceSlug}
        isOpen={panel?.kind === "link"}
        scenario={scenario}
        onClose={() => setPanel(null)}
        onLink={linkExpenses}
      />
      {panel && panel.kind !== "link" && (
        <BudgetPeekPanel
          title={t(panel.kind === "compose" ? "payments.composer.title" : "payments.composer.resources_title")}
          description={t(
            panel.kind === "compose" ? "payments.composer.description" : "payments.composer.resources_description"
          )}
          onClose={closePanel}
        >
          {panel.kind === "compose" ? (
            <BudgetResourceComposer
              key={panel.tab}
              workspaceSlug={workspaceSlug}
              scenario={scenario}
              initialTab={panel.tab}
              onSaved={() => setSheetRefreshToken((value) => value + 1)}
            />
          ) : (
            <BudgetResourcesPanel
              workspaceSlug={workspaceSlug}
              scenario={scenario}
              onChanged={() => setSheetRefreshToken((value) => value + 1)}
            />
          )}
        </BudgetPeekPanel>
      )}
    </div>
  );
}

function ScenarioVariables({
  workspaceSlug,
  scenario,
  onChanged,
}: {
  workspaceSlug: string;
  scenario: TBudgetScenario;
  onChanged?: () => void;
}) {
  const { t } = useTranslation();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isOfficesOpen, setIsOfficesOpen] = useState(false);
  const [editing, setEditing] = useState<TFinancialVariable | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TFinancialVariable | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search.trim(), 300);
  const { data: offices, mutate: mutateOffices } = useSWR<TOffice[]>(
    `PAYROLL_OFFICES_${workspaceSlug}`,
    () => payrollService.getOffices(workspaceSlug),
    { revalidateOnFocus: false }
  );
  const { data: variables, mutate: mutateVariables } = useSWR<TFinancialVariable[]>(
    `FINANCIAL_VARIABLES_${workspaceSlug}_${debouncedSearch || "ALL"}`,
    () => financeService.getFinancialVariables(workspaceSlug, debouncedSearch),
    { revalidateOnFocus: false }
  );
  const { data: assigned, mutate: mutateAssigned } = useSWR<TBudgetScenarioVariable[]>(
    `SCENARIO_VARIABLES_${workspaceSlug}_${scenario.id}`,
    () => financeService.getScenarioVariables(workspaceSlug, scenario.id),
    { revalidateOnFocus: false }
  );
  const assignedByVariable = useMemo(() => new Map((assigned ?? []).map((item) => [item.variable, item])), [assigned]);

  const refresh = () => {
    void mutateVariables();
    void mutateAssigned();
    onChanged?.();
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    try {
      await financeService.deleteFinancialVariable(workspaceSlug, deleteTarget.id);
      setDeleteTarget(null);
      refresh();
    } catch {
      setToast({ type: TOAST_TYPE.ERROR, title: t("payments.toasts.error") });
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div className="mx-auto max-w-[1180px] p-4 sm:p-6">
      <FinancialVariableModal
        nested
        workspaceSlug={workspaceSlug}
        offices={offices ?? []}
        variable={editing}
        isOpen={isModalOpen}
        onClose={() => {
          setIsModalOpen(false);
          setEditing(null);
        }}
        onSaved={refresh}
      />
      <OfficesModal
        nested
        workspaceSlug={workspaceSlug}
        offices={offices ?? []}
        isOpen={isOfficesOpen}
        onClose={() => setIsOfficesOpen(false)}
        onChanged={() => {
          void mutateOffices();
          onChanged?.();
        }}
      />
      <FinanceConfirmModal
        isOpen={deleteTarget !== null}
        handleClose={() => setDeleteTarget(null)}
        handleSubmit={() => void handleDelete()}
        isSubmitting={isDeleting}
        title={t("payments.variables.delete_title")}
        content={t("payments.variables.delete_description")}
      />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-15 font-semibold text-primary">{t("payments.variables.title")}</h2>
          <p className="mt-1 text-12 text-tertiary">{t("payments.variables.description")}</p>
        </div>
        <Button
          variant="primary"
          size="sm"
          onClick={() => {
            if ((offices?.length ?? 0) === 0) setIsOfficesOpen(true);
            else {
              setEditing(null);
              setIsModalOpen(true);
            }
          }}
        >
          <Plus className="size-4" />
          {t((offices?.length ?? 0) === 0 ? "payroll.offices.new" : "payments.variables.create")}
        </Button>
      </div>

      {(offices?.length ?? 0) === 0 && (
        <div className="border-warning-primary/30 mt-5 rounded-lg border bg-warning-primary/5 p-4 text-12 text-secondary">
          {t("payments.variables.entity_required")}
        </div>
      )}

      <ResourceSearch
        value={search}
        onChange={setSearch}
        placeholder={t("payments.composer.search_variables")}
        clearLabel={t("payments.composer.clear_search")}
        className="mt-5"
      />

      {(variables?.length ?? 0) > 0 && (
        <ul className="mt-3 divide-y divide-subtle overflow-hidden rounded-lg border border-subtle">
          {(variables ?? []).map((variable) => {
            const assignment = assignedByVariable.get(variable.id);
            return (
              <li key={variable.id} className="flex items-center gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-13 font-medium text-primary">{variable.name}</p>
                  <p className="mt-0.5 truncate text-11 text-tertiary">
                    {[
                      variable.office_name,
                      t(`payments.variables.recurrence.${variable.recurrence.toLowerCase()}`),
                      formatYearRange(variable.effective_from, variable.effective_to),
                      variable.kind === "INCOME" ? t("payments.variables.kind.income") : "",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                <span className="shrink-0 text-13 font-medium tabular-nums">
                  {formatMoney(variable.amount, variable.currency)}
                </span>
                <Button
                  variant={assignment ? "secondary" : "primary"}
                  size="base"
                  onClick={() => {
                    const promise = assignment
                      ? financeService.removeScenarioVariable(workspaceSlug, scenario.id, assignment.id)
                      : financeService.addScenarioVariable(workspaceSlug, scenario.id, variable.id);
                    void promise.then(refresh).catch((reason) =>
                      setToast({
                        type: TOAST_TYPE.ERROR,
                        title: t("payments.toasts.error"),
                        message: getApiErrorMessage(reason),
                      })
                    );
                  }}
                >
                  {t(assignment ? "payments.variables.remove" : "payments.variables.add")}
                </Button>
                <button
                  type="button"
                  onClick={() => {
                    setEditing(variable);
                    setIsModalOpen(true);
                  }}
                  className="rounded-sm p-1.5 text-tertiary hover:bg-layer-1-hover hover:text-primary"
                  aria-label={t("payments.variables.edit")}
                  title={t("payments.variables.edit")}
                >
                  <Edit3 className="size-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setDeleteTarget(variable)}
                  className="rounded-sm p-1.5 text-tertiary hover:bg-danger-primary/10 hover:text-danger-primary"
                  aria-label={t("payments.variables.delete_title")}
                  title={t("payments.variables.delete_title")}
                >
                  <Trash2 className="size-3.5" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {(variables?.length ?? 0) === 0 && (offices?.length ?? 0) > 0 && (
        <div className="mt-5 rounded-xl border border-dashed border-subtle bg-layer-1 p-10 text-center">
          <Variable className="mx-auto size-6 text-tertiary" />
          <p className="mt-3 text-13 font-medium text-primary">
            {t(search.trim() ? "payments.composer.no_search_results" : "payments.variables.empty_title")}
          </p>
          {!search.trim() && <p className="mt-1 text-12 text-tertiary">{t("payments.variables.empty_description")}</p>}
        </div>
      )}
    </div>
  );
}

function BudgetResourcesPanel({
  workspaceSlug,
  scenario,
  onChanged,
}: {
  workspaceSlug: string;
  scenario: TBudgetScenario;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [section, setSection] = useState<ResourceSection>("people");
  const sections: { key: ResourceSection; icon: typeof Users; label: string }[] = [
    { key: "people", icon: BriefcaseBusiness, label: t("payments.composer.people_and_entities") },
    { key: "variables", icon: Variable, label: t("payments.variables.title") },
    { key: "expenses", icon: ReceiptText, label: t("payments.expenses") },
    { key: "payroll", icon: Wallet, label: t("payroll.title") },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-subtle px-4 pt-2">
        {sections.map(({ key, icon: Icon, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => setSection(key)}
            className={cn(
              "flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-11 whitespace-nowrap",
              section === key
                ? "border-accent-primary font-medium text-primary"
                : "border-transparent text-tertiary hover:text-primary"
            )}
          >
            <Icon className="size-3.5" /> {label}
          </button>
        ))}
      </nav>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {section === "people" && <ScenarioResources workspaceSlug={workspaceSlug} onChanged={onChanged} />}
        {section === "variables" && (
          <ScenarioVariables workspaceSlug={workspaceSlug} scenario={scenario} onChanged={onChanged} />
        )}
        {section === "expenses" && (
          <ExpensesTab workspaceSlug={workspaceSlug} scenario={scenario} onChanged={onChanged} />
        )}
        {section === "payroll" && <PayrollSection workspaceSlug={workspaceSlug} defaultYear={scenario.fiscal_year} />}
      </div>
    </div>
  );
}

function ScenarioResources({ workspaceSlug, onChanged }: { workspaceSlug: string; onChanged: () => void }) {
  const { data: offices, mutate } = useSWR<TOffice[]>(
    `PAYROLL_OFFICES_${workspaceSlug}`,
    () => payrollService.getOffices(workspaceSlug),
    { revalidateOnFocus: false }
  );

  return (
    <div className="mx-auto max-w-[1180px] p-4 sm:p-6">
      <EmployeesTab
        workspaceSlug={workspaceSlug}
        offices={offices ?? []}
        onOfficesChanged={() => void mutate()}
        onChanged={onChanged}
      />
    </div>
  );
}
