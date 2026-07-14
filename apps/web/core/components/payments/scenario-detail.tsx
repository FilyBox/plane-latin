/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useMemo, useState } from "react";
import {
  ArrowLeft,
  BriefcaseBusiness,
  CalendarDays,
  Download,
  Edit3,
  FileSpreadsheet,
  Library,
  Plus,
  ReceiptText,
  Settings2,
  Trash2,
  UserRoundPlus,
  Users,
  Variable,
} from "lucide-react";
import useSWR from "swr";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type {
  TBudgetScenario,
  TBudgetScenarioEmployee,
  TBudgetScenarioVariable,
  TEmployee,
  TFinancialVariable,
  TOffice,
} from "@plane/types";
import { AlertModalCore } from "@plane/ui";
import { cn } from "@plane/utils";
import { financeService } from "@/services/finance.service";
import { payrollService } from "@/services/payroll.service";
import { BudgetBonusModal } from "./bonus-modal";
import { BudgetPeekPanel } from "./budget-peek-panel";
import { BudgetResourceComposer } from "./budget-resource-composer";
import { ExpensesTab } from "./expenses-tab";
import { EmployeesTab } from "./payroll/employees";
import { OfficesModal } from "./payroll/offices-modal";
import { BudgetScenarioModal } from "./scenario-modal";
import { ScenarioEmployeeModal } from "./scenario-employee-modal";
import { formatMoney } from "./shared";
import { FinancialVariableModal } from "./variable-modal";
import { BudgetSpreadsheet } from "./budget-spreadsheet";

type Panel = "compose" | "resources";
type ResourceSection = "people" | "variables" | "expenses";

type Props = {
  workspaceSlug: string;
  scenario: TBudgetScenario;
  onBack: () => void;
  onChanged: (scenario: TBudgetScenario) => void;
  onDeleted: () => void;
};

export function BudgetScenarioDetail({ workspaceSlug, scenario, onBack, onChanged, onDeleted }: Props) {
  const { t } = useTranslation();
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
      await financeService.exportScenario(workspaceSlug, scenario.id, format);
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

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-1">
      <BudgetScenarioModal
        workspaceSlug={workspaceSlug}
        isOpen={isEditOpen}
        scenario={scenario}
        onClose={() => setIsEditOpen(false)}
        onSaved={onChanged}
      />
      <AlertModalCore
        isOpen={isDeleteOpen}
        handleClose={() => setIsDeleteOpen(false)}
        handleSubmit={() => void handleDelete()}
        isSubmitting={isDeleting}
        title={t("payments.scenarios.delete_title")}
        content={t("payments.scenarios.delete_description")}
      />

      <div className="border-b border-subtle bg-surface-1 px-3 py-3 sm:px-5 sm:py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <button
              type="button"
              onClick={onBack}
              className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-sm border border-subtle bg-layer-1 text-secondary hover:bg-layer-1-hover hover:text-primary"
              title={t("payments.scenarios.back")}
            >
              <ArrowLeft className="size-4" />
            </button>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="truncate text-18 font-semibold text-primary">{scenario.name}</h1>
                <span className="rounded-full bg-layer-2 px-2 py-0.5 text-10 font-medium text-secondary">
                  {t(`payments.scenarios.status.${scenario.status.toLowerCase()}`)}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-11 text-tertiary">
                <span className="flex items-center gap-1.5">
                  <CalendarDays className="size-3" /> {scenario.period_start} / {scenario.period_end}
                </span>
                <span>{scenario.currency}</span>
                <span>{scenario.fiscal_year}</span>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            <Button variant="primary" size="xl" onClick={() => setPanel("compose")}>
              <Plus className="size-4" />
              {t("payments.composer.open")}
            </Button>
            <Button variant="secondary" size="xl" onClick={() => setPanel("resources")}>
              <Library className="size-4" />
              {t("payments.composer.resources")}
            </Button>
            <div className="flex items-center rounded-md border border-subtle bg-layer-1">
              <button
                type="button"
                disabled={isExporting}
                onClick={() => void handleExport("xlsx")}
                className="flex h-8 items-center gap-1.5 border-r border-subtle px-2.5 text-11 text-secondary hover:bg-layer-1-hover disabled:opacity-50"
              >
                <FileSpreadsheet className="size-3.5" /> XLSX
              </button>
              <button
                type="button"
                disabled={isExporting}
                onClick={() => void handleExport("csv")}
                className="flex h-8 items-center gap-1.5 px-2.5 text-11 text-secondary hover:bg-layer-1-hover disabled:opacity-50"
              >
                <Download className="size-3.5" /> CSV
              </button>
            </div>
            <Button variant="secondary" size="xl" onClick={() => setIsEditOpen(true)}>
              <Settings2 className="size-4" />
              {t("payments.scenarios.settings")}
            </Button>
            <button
              type="button"
              onClick={() => setIsDeleteOpen(true)}
              className="flex size-8 items-center justify-center rounded-md border border-strong bg-layer-2 text-tertiary shadow-raised-100 hover:bg-danger-primary/10 hover:text-danger-primary"
              title={t("payments.actions.delete")}
            >
              <Trash2 className="size-3.5" />
            </button>
          </div>
        </div>
      </div>

      <BudgetSpreadsheet workspaceSlug={workspaceSlug} scenario={scenario} refreshToken={sheetRefreshToken} />

      {panel && (
        <BudgetPeekPanel
          title={t(panel === "compose" ? "payments.composer.title" : "payments.composer.resources_title")}
          description={t(
            panel === "compose" ? "payments.composer.description" : "payments.composer.resources_description"
          )}
          onClose={closePanel}
        >
          {panel === "compose" ? (
            <BudgetResourceComposer
              workspaceSlug={workspaceSlug}
              scenario={scenario}
              onSaved={() => setSheetRefreshToken((value) => value + 1)}
            />
          ) : (
            <BudgetResourcesPanel workspaceSlug={workspaceSlug} scenario={scenario} />
          )}
        </BudgetPeekPanel>
      )}
    </div>
  );
}

export function ScenarioTeam({ workspaceSlug, scenario }: { workspaceSlug: string; scenario: TBudgetScenario }) {
  const { t } = useTranslation();
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [bonusTarget, setBonusTarget] = useState<TBudgetScenarioEmployee | null>(null);
  const { data: assignments, mutate } = useSWR<TBudgetScenarioEmployee[]>(
    `BUDGET_SCENARIO_EMPLOYEES_${workspaceSlug}_${scenario.id}`,
    () => financeService.getScenarioEmployees(workspaceSlug, scenario.id),
    { revalidateOnFocus: false }
  );
  const { data: employees } = useSWR<TEmployee[]>(
    `PAYROLL_EMPLOYEES_${workspaceSlug}`,
    () => payrollService.getEmployees(workspaceSlug),
    { revalidateOnFocus: false }
  );

  const refresh = () => {
    void mutate();
  };

  return (
    <div className="mx-auto max-w-[1180px] p-4 sm:p-6">
      <ScenarioEmployeeModal
        workspaceSlug={workspaceSlug}
        scenario={scenario}
        employees={employees ?? []}
        isOpen={isAddOpen}
        onClose={() => setIsAddOpen(false)}
        onSaved={refresh}
      />
      <BudgetBonusModal
        workspaceSlug={workspaceSlug}
        scenario={scenario}
        assignment={bonusTarget}
        isOpen={bonusTarget !== null}
        onClose={() => setBonusTarget(null)}
        onSaved={refresh}
      />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-15 font-semibold text-primary">{t("payments.scenarios.team_title")}</h2>
          <p className="mt-1 text-12 text-tertiary">{t("payments.scenarios.team_description")}</p>
        </div>
        <Button
          variant="primary"
          size="sm"
          onClick={() => setIsAddOpen(true)}
          disabled={(employees?.length ?? 0) === 0}
        >
          <UserRoundPlus className="size-4" />
          {t("payments.scenarios.add_employee")}
        </Button>
      </div>

      {(assignments?.length ?? 0) === 0 ? (
        <div className="mt-5 flex min-h-64 flex-col items-center justify-center rounded-xl border border-dashed border-subtle bg-layer-1 p-6 text-center">
          <Users className="size-6 text-tertiary" />
          <h3 className="mt-3 text-14 font-medium text-primary">{t("payments.scenarios.no_team_title")}</h3>
          <p className="mt-1 max-w-sm text-12 text-tertiary">{t("payments.scenarios.no_team_description")}</p>
        </div>
      ) : (
        <div className="mt-5 overflow-hidden rounded-xl border border-subtle bg-layer-1">
          {(assignments ?? []).map((assignment, index) => (
            <div key={assignment.id} className={cn("p-4", index > 0 && "border-t border-subtle")}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-layer-2 text-12 font-semibold text-secondary">
                    {assignment.employee_name
                      .split(" ")
                      .slice(0, 2)
                      .map((part) => part[0])
                      .join("")}
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-13 font-medium text-primary">{assignment.employee_name}</p>
                    <p className="mt-0.5 text-11 text-tertiary">
                      {assignment.position || t("payments.scenarios.no_position")} / {assignment.office_name}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <div className="text-right">
                    <p className="text-13 font-semibold text-primary">
                      {formatMoney(assignment.salary_amount, assignment.salary_currency)}
                    </p>
                    <p className="text-10 text-tertiary">
                      {t(`payroll.periodicity.${assignment.salary_periodicity.toLowerCase()}`)}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setBonusTarget(assignment)}
                    className="flex h-8 items-center gap-1 rounded-sm border border-subtle px-2 text-11 text-secondary hover:bg-layer-1-hover"
                  >
                    <Plus className="size-3" /> {t("payments.bonuses.add")}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void financeService
                        .removeScenarioEmployee(workspaceSlug, scenario.id, assignment.id)
                        .then(refresh);
                    }}
                    className="flex size-8 items-center justify-center rounded-sm text-tertiary hover:bg-danger-primary/10 hover:text-danger-primary"
                    title={t("payments.actions.delete")}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              </div>
              {assignment.bonuses.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2 pl-12">
                  {assignment.bonuses.map((bonus) => (
                    <span
                      key={bonus.id}
                      className="flex items-center gap-1.5 rounded-full bg-layer-2 px-2.5 py-1 text-10 text-secondary"
                    >
                      {bonus.name}: {bonus.calculation_type === "PERCENTAGE" ? `${bonus.value}%` : bonus.value}
                      <button
                        type="button"
                        onClick={() =>
                          void financeService
                            .deleteBudgetBonus(workspaceSlug, scenario.id, assignment.id, bonus.id)
                            .then(refresh)
                        }
                        className="text-tertiary hover:text-danger-primary"
                      >
                        <Trash2 className="size-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ScenarioVariables({ workspaceSlug, scenario }: { workspaceSlug: string; scenario: TBudgetScenario }) {
  const { t } = useTranslation();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isOfficesOpen, setIsOfficesOpen] = useState(false);
  const [editing, setEditing] = useState<TFinancialVariable | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TFinancialVariable | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const { data: offices, mutate: mutateOffices } = useSWR<TOffice[]>(
    `PAYROLL_OFFICES_${workspaceSlug}`,
    () => payrollService.getOffices(workspaceSlug),
    { revalidateOnFocus: false }
  );
  const { data: variables, mutate: mutateVariables } = useSWR<TFinancialVariable[]>(
    `FINANCIAL_VARIABLES_${workspaceSlug}`,
    () => financeService.getFinancialVariables(workspaceSlug),
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
        workspaceSlug={workspaceSlug}
        offices={offices ?? []}
        isOpen={isOfficesOpen}
        onClose={() => setIsOfficesOpen(false)}
        onChanged={() => void mutateOffices()}
      />
      <AlertModalCore
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
          size="xl"
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

      <div className="mt-5 grid grid-cols-1 gap-3 lg:grid-cols-2">
        {(variables ?? []).map((variable) => {
          const assignment = assignedByVariable.get(variable.id);
          return (
            <div key={variable.id} className="rounded-lg border border-subtle bg-layer-1 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="truncate text-13 font-medium text-primary">{variable.name}</h3>
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 text-9 font-medium uppercase",
                        variable.kind === "INCOME"
                          ? "bg-success-primary/10 text-success-primary"
                          : "bg-warning-primary/10 text-warning-primary"
                      )}
                    >
                      {t(`payments.variables.kind.${variable.kind.toLowerCase()}`)}
                    </span>
                  </div>
                  <p className="mt-1 text-11 text-tertiary">
                    {variable.office_name} / {t(`payments.variables.recurrence.${variable.recurrence.toLowerCase()}`)}
                  </p>
                </div>
                <p className="shrink-0 text-14 font-semibold text-primary">
                  {formatMoney(variable.amount, variable.currency)}
                </p>
              </div>
              {variable.description && (
                <p className="mt-3 line-clamp-2 text-11 text-secondary">{variable.description}</p>
              )}
              <div className="mt-4 flex items-center justify-between border-t border-subtle pt-3">
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      setEditing(variable);
                      setIsModalOpen(true);
                    }}
                    className="flex items-center gap-1 text-11 text-tertiary hover:text-primary"
                  >
                    <Edit3 className="size-3" /> {t("payments.actions.edit")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setDeleteTarget(variable)}
                    className="flex items-center gap-1 text-11 text-tertiary hover:text-danger-primary"
                  >
                    <Trash2 className="size-3" /> {t("payments.actions.delete")}
                  </button>
                </div>
                <Button
                  variant={assignment ? "secondary" : "primary"}
                  size="sm"
                  onClick={() => {
                    const promise = assignment
                      ? financeService.removeScenarioVariable(workspaceSlug, scenario.id, assignment.id)
                      : financeService.addScenarioVariable(workspaceSlug, scenario.id, variable.id);
                    void promise.then(refresh);
                  }}
                >
                  {t(assignment ? "payments.variables.remove" : "payments.variables.add")}
                </Button>
              </div>
            </div>
          );
        })}
      </div>
      {(variables?.length ?? 0) === 0 && (offices?.length ?? 0) > 0 && (
        <div className="mt-5 rounded-xl border border-dashed border-subtle bg-layer-1 p-10 text-center">
          <Variable className="mx-auto size-6 text-tertiary" />
          <p className="mt-3 text-13 font-medium text-primary">{t("payments.variables.empty_title")}</p>
          <p className="mt-1 text-12 text-tertiary">{t("payments.variables.empty_description")}</p>
        </div>
      )}
    </div>
  );
}

function BudgetResourcesPanel({ workspaceSlug, scenario }: { workspaceSlug: string; scenario: TBudgetScenario }) {
  const { t } = useTranslation();
  const [section, setSection] = useState<ResourceSection>("people");
  const sections: { key: ResourceSection; icon: typeof Users; label: string }[] = [
    { key: "people", icon: BriefcaseBusiness, label: t("payments.composer.people_and_entities") },
    { key: "variables", icon: Variable, label: t("payments.variables.title") },
    { key: "expenses", icon: ReceiptText, label: t("payments.expenses") },
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
        {section === "people" && <ScenarioResources workspaceSlug={workspaceSlug} />}
        {section === "variables" && <ScenarioVariables workspaceSlug={workspaceSlug} scenario={scenario} />}
        {section === "expenses" && <ExpensesTab workspaceSlug={workspaceSlug} />}
      </div>
    </div>
  );
}

function ScenarioResources({ workspaceSlug }: { workspaceSlug: string }) {
  const { data: offices, mutate } = useSWR<TOffice[]>(
    `PAYROLL_OFFICES_${workspaceSlug}`,
    () => payrollService.getOffices(workspaceSlug),
    { revalidateOnFocus: false }
  );

  return (
    <div className="mx-auto max-w-[1180px] p-4 sm:p-6">
      <EmployeesTab workspaceSlug={workspaceSlug} offices={offices ?? []} onOfficesChanged={() => void mutate()} />
    </div>
  );
}
