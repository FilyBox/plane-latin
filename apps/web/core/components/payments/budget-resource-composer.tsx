/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useCallback, useEffect, useState } from "react";
import { Building2, Check, Loader2, Pencil, Plus, Trash2, Users, Variable } from "lucide-react";
import useSWR, { useSWRConfig } from "swr";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type {
  TBudgetBonus,
  TBudgetScenario,
  TBudgetScenarioEmployee,
  TBudgetScenarioVariable,
  TEmployee,
  TFinancialVariable,
  TOffice,
  TSalary,
} from "@plane/types";
import { cn } from "@plane/utils";
import useDebounce from "@/hooks/use-debounce";
import { getSalaryBudgetAvailability } from "@/lib/budget-availability";
import { financeService } from "@/services/finance.service";
import { payrollService } from "@/services/payroll.service";
import { BudgetBonusModal } from "./bonus-modal";
import { FinanceConfirmModal } from "./confirm-modal";
import { EmployeeModal } from "./payroll/employee-modal";
import { OfficesModal } from "./payroll/offices-modal";
import { SalaryModal } from "./payroll/salary-modal";
import { ResourceSearch } from "./resource-search";
import { formatMoney, formatYearRange, getApiErrorMessage } from "./shared";
import { FinancialVariableModal } from "./variable-modal";

type EmployeeSelection = {
  employee: string;
  salary: string;
  effective_from: string;
  effective_to: string;
};

type SalaryTarget = { employee: TEmployee; salary: TSalary | null };

export type ComposerTab = "variables" | "people" | "included";

type Props = {
  workspaceSlug: string;
  scenario: TBudgetScenario;
  onSaved: () => void;
  /** Which list opens first: the header's "Add" menu says what the user came for. */
  initialTab?: ComposerTab;
};

const latestDate = (...dates: (string | null | undefined)[]) =>
  dates
    .filter((date): date is string => Boolean(date))
    .sort()
    .at(-1) ?? "";

const earliestDate = (...dates: (string | null | undefined)[]) =>
  dates
    .filter((date): date is string => Boolean(date))
    .sort()
    .at(0) ?? "";

/** The stretch of a salary that falls inside the budget, clipped by hire and exit dates. */
const salaryWindow = (scenario: TBudgetScenario, employee: TEmployee, salary: TSalary): EmployeeSelection => ({
  employee: employee.id,
  salary: salary.id,
  effective_from: latestDate(scenario.period_start, employee.hire_date, salary.effective_from),
  effective_to: earliestDate(
    scenario.period_end,
    employee.termination_date ?? scenario.period_end,
    salary.effective_to ?? scenario.period_end
  ),
});

const ICON_BUTTON = "rounded-sm p-1.5 text-tertiary hover:bg-layer-1-hover hover:text-primary";
const DATE_FIELD =
  "h-8 w-full rounded-sm border border-subtle bg-surface-1 px-2 text-12 outline-none focus:border-accent-strong";

export function BudgetResourceComposer({ workspaceSlug, scenario, onSaved, initialTab = "variables" }: Props) {
  const { t } = useTranslation();
  const { mutate: mutateGlobal } = useSWRConfig();
  const [employeeSelections, setEmployeeSelections] = useState<Record<string, EmployeeSelection>>({});
  const [variableSelections, setVariableSelections] = useState<Set<string>>(new Set());
  const [editingEmployee, setEditingEmployee] = useState<TEmployee | null | undefined>(undefined);
  const [salaryTarget, setSalaryTarget] = useState<SalaryTarget | null>(null);
  const [isOfficesOpen, setIsOfficesOpen] = useState(false);
  const [editingVariable, setEditingVariable] = useState<TFinancialVariable | null | undefined>(undefined);
  const [bonusTarget, setBonusTarget] = useState<TBudgetScenarioEmployee | null>(null);
  const [deleteBonusTarget, setDeleteBonusTarget] = useState<{
    assignment: TBudgetScenarioEmployee;
    bonus: TBudgetBonus;
  } | null>(null);
  const [removeTarget, setRemoveTarget] = useState<
    | { type: "employee"; assignment: TBudgetScenarioEmployee }
    | { type: "variable"; assignment: TBudgetScenarioVariable }
    | null
  >(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [onlyInPeriod, setOnlyInPeriod] = useState(true);
  const [tab, setTab] = useState<ComposerTab>(initialTab);
  // Rows own the per-employee salary fetch; they report back the salaries that
  // would land in this budget so the header can offer to take them all at once.
  const [addableByEmployee, setAddableByEmployee] = useState<Record<string, EmployeeSelection[]>>({});
  const [employeeSearch, setEmployeeSearch] = useState("");
  const [variableSearch, setVariableSearch] = useState("");
  const debouncedEmployeeSearch = useDebounce(employeeSearch.trim(), 300);
  const debouncedVariableSearch = useDebounce(variableSearch.trim(), 300);

  const { data: employees, mutate: mutateEmployees } = useSWR<TEmployee[]>(
    `PAYROLL_EMPLOYEES_${workspaceSlug}_${debouncedEmployeeSearch || "ALL"}`,
    () => payrollService.getEmployees(workspaceSlug, debouncedEmployeeSearch),
    { revalidateOnFocus: false }
  );
  const { data: offices, mutate: mutateOffices } = useSWR<TOffice[]>(
    `PAYROLL_OFFICES_${workspaceSlug}`,
    () => payrollService.getOffices(workspaceSlug),
    { revalidateOnFocus: false }
  );
  const { data: variables, mutate: mutateVariables } = useSWR<TFinancialVariable[]>(
    `FINANCIAL_VARIABLES_${workspaceSlug}_${debouncedVariableSearch || "ALL"}`,
    () => financeService.getFinancialVariables(workspaceSlug, debouncedVariableSearch),
    { revalidateOnFocus: false }
  );
  const { data: assignments, mutate: mutateAssignments } = useSWR<TBudgetScenarioEmployee[]>(
    `BUDGET_SCENARIO_EMPLOYEES_${workspaceSlug}_${scenario.id}`,
    () => financeService.getScenarioEmployees(workspaceSlug, scenario.id),
    { revalidateOnFocus: false }
  );
  const { data: assignedVariables, mutate: mutateAssignedVariables } = useSWR<TBudgetScenarioVariable[]>(
    `SCENARIO_VARIABLES_${workspaceSlug}_${scenario.id}`,
    () => financeService.getScenarioVariables(workspaceSlug, scenario.id),
    { revalidateOnFocus: false }
  );

  const hasOffices = (offices?.length ?? 0) > 0;
  const assignedSalaryIds = new Set((assignments ?? []).map((assignment) => assignment.salary));
  const assignedVariableById = new Map(
    (assignedVariables ?? []).map((assignment) => [assignment.variable, assignment])
  );
  const selectedCount = Object.keys(employeeSelections).length + variableSelections.size;
  const includedCount = (assignments?.length ?? 0) + (assignedVariables?.length ?? 0);
  const inPeriod = (from: string, to?: string | null) =>
    from <= scenario.period_end && (!to || to >= scenario.period_start);
  const TABS: { key: ComposerTab; label: string; count: number }[] = [
    { key: "variables", label: t("payments.composer.variables"), count: variableSelections.size },
    { key: "people", label: t("payments.composer.people"), count: Object.keys(employeeSelections).length },
    { key: "included", label: t("payments.composer.included_title"), count: includedCount },
  ];
  // Salaries still running inside the budget window that nobody has picked yet.
  const addableSalaries = Object.values(addableByEmployee)
    .flat()
    .filter((selection) => !assignedSalaryIds.has(selection.salary) && !employeeSelections[selection.salary]);

  useEffect(() => {
    setEmployeeSelections({});
    setVariableSelections(new Set());
    setAddableByEmployee({});
  }, [scenario.id]);

  const reportAddable = useCallback(
    (employeeId: string, selections: EmployeeSelection[]) =>
      setAddableByEmployee((current) => {
        const previous = current[employeeId];
        const isSame =
          previous?.length === selections.length &&
          previous.every((item, index) => item.salary === selections[index]?.salary);
        return isSame ? current : { ...current, [employeeId]: selections };
      }),
    []
  );

  const reportError = (error: unknown) =>
    setToast({ type: TOAST_TYPE.ERROR, title: t("payments.toasts.error"), message: getApiErrorMessage(error) });

  /** Something created from this panel goes straight into the budget: the user
   * opened the panel to add it, so a second "tick and add" step is busywork. */
  const addCreatedVariable = async (variable: TFinancialVariable) => {
    if (!inPeriod(variable.effective_from, variable.effective_to)) {
      setToast({ type: TOAST_TYPE.INFO, title: t("payments.composer.outside_period") });
      return;
    }
    try {
      await financeService.addScenarioVariable(workspaceSlug, scenario.id, variable.id);
      await mutateAssignedVariables();
      onSaved();
      setToast({ type: TOAST_TYPE.SUCCESS, title: t("payments.composer.item_added", { name: variable.name }) });
    } catch (error) {
      reportError(error);
    }
  };

  const addCreatedSalary = async (employee: TEmployee, salary: TSalary) => {
    const stretch = salaryWindow(scenario, employee, salary);
    if (!stretch.effective_from || stretch.effective_from > stretch.effective_to) {
      setToast({ type: TOAST_TYPE.INFO, title: t("payments.composer.salary_outside_period") });
      return;
    }
    try {
      await financeService.addScenarioEmployee(workspaceSlug, scenario.id, stretch);
      await mutateAssignments();
      onSaved();
      setToast({ type: TOAST_TYPE.SUCCESS, title: t("payments.composer.item_added", { name: employee.full_name }) });
    } catch (error) {
      reportError(error);
    }
  };

  const handleSubmit = async () => {
    if (selectedCount === 0) return;
    setIsSubmitting(true);
    // Each item is added on its own: what went in leaves the selection, what
    // failed stays selected to retry — so a retry never adds anything twice.
    const employeeEntries = Object.entries(employeeSelections);
    const variableIds = Array.from(variableSelections);
    const [employeeResults, variableResults] = await Promise.all([
      Promise.allSettled(
        employeeEntries.map(([, selection]) =>
          financeService.addScenarioEmployee(workspaceSlug, scenario.id, selection)
        )
      ),
      Promise.allSettled(
        variableIds.map((variable) => financeService.addScenarioVariable(workspaceSlug, scenario.id, variable))
      ),
    ]);
    setEmployeeSelections(
      Object.fromEntries(employeeEntries.filter((_, index) => employeeResults[index].status === "rejected"))
    );
    setVariableSelections(new Set(variableIds.filter((_, index) => variableResults[index].status === "rejected")));
    await Promise.all([mutateAssignments(), mutateAssignedVariables()]);
    onSaved();
    const failure = [...employeeResults, ...variableResults].find((result) => result.status === "rejected");
    if (failure && failure.status === "rejected")
      setToast({
        type: TOAST_TYPE.ERROR,
        title: t("payments.composer.partial_error"),
        message: getApiErrorMessage(failure.reason),
      });
    else setToast({ type: TOAST_TYPE.SUCCESS, title: t("payments.composer.saved") });
    setIsSubmitting(false);
  };

  const handleRemove = async () => {
    if (!removeTarget) return;
    setIsSubmitting(true);
    try {
      if (removeTarget.type === "employee") {
        await financeService.removeScenarioEmployee(workspaceSlug, scenario.id, removeTarget.assignment.id);
        await mutateAssignments();
      } else {
        await financeService.removeScenarioVariable(workspaceSlug, scenario.id, removeTarget.assignment.id);
        await mutateAssignedVariables();
      }
      setRemoveTarget(null);
      onSaved();
    } catch (error) {
      reportError(error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteBonus = async () => {
    if (!deleteBonusTarget) return;
    setIsSubmitting(true);
    try {
      await financeService.deleteBudgetBonus(
        workspaceSlug,
        scenario.id,
        deleteBonusTarget.assignment.id,
        deleteBonusTarget.bonus.id
      );
      setDeleteBonusTarget(null);
      await mutateAssignments();
      onSaved();
    } catch (error) {
      reportError(error);
    } finally {
      setIsSubmitting(false);
    }
  };

  // A partida needs an office to belong to; with none yet, that comes first.
  const startNewVariable = () => (hasOffices ? setEditingVariable(null) : setIsOfficesOpen(true));
  const startNewPerson = () => setEditingEmployee(null);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <EmployeeModal
        nested
        workspaceSlug={workspaceSlug}
        offices={offices ?? []}
        isOpen={editingEmployee !== undefined}
        employee={editingEmployee ?? null}
        onClose={() => setEditingEmployee(undefined)}
        onSaved={(saved) => {
          void mutateEmployees();
          onSaved();
          // A new person is only useful here with a salary: ask for it next.
          if (editingEmployee === null && saved) {
            if (hasOffices) setSalaryTarget({ employee: saved, salary: null });
            else setIsOfficesOpen(true);
          }
        }}
      />
      <SalaryModal
        nested
        workspaceSlug={workspaceSlug}
        employeeId={salaryTarget?.employee.id ?? ""}
        salary={salaryTarget?.salary ?? null}
        offices={offices ?? []}
        defaultEffectiveFrom={latestDate(scenario.period_start, salaryTarget?.employee.hire_date)}
        isOpen={salaryTarget !== null}
        onClose={() => setSalaryTarget(null)}
        onSaved={(saved) => {
          if (salaryTarget) {
            void mutateGlobal(`BUDGET_COMPOSER_SALARIES_${workspaceSlug}_${salaryTarget.employee.id}`);
            setEmployeeSelections((current) =>
              Object.fromEntries(
                Object.entries(current).filter(([, selection]) => selection.employee !== salaryTarget.employee.id)
              )
            );
            if (!salaryTarget.salary && saved) void addCreatedSalary(salaryTarget.employee, saved);
          }
          void mutateEmployees();
          onSaved();
        }}
      />
      <OfficesModal
        nested
        workspaceSlug={workspaceSlug}
        offices={offices ?? []}
        isOpen={isOfficesOpen}
        onClose={() => setIsOfficesOpen(false)}
        onChanged={() => {
          void mutateOffices();
          onSaved();
        }}
      />
      <FinancialVariableModal
        nested
        workspaceSlug={workspaceSlug}
        offices={offices ?? []}
        variable={editingVariable ?? null}
        isOpen={editingVariable !== undefined}
        defaults={{ currency: scenario.currency, effective_from: scenario.period_start }}
        submitLabel={editingVariable === null ? t("payments.composer.create_and_add") : undefined}
        onClose={() => setEditingVariable(undefined)}
        onSaved={(saved) => {
          void mutateVariables();
          if (editingVariable === null) void addCreatedVariable(saved);
          else onSaved();
        }}
      />
      <BudgetBonusModal
        nested
        workspaceSlug={workspaceSlug}
        scenario={scenario}
        assignment={bonusTarget}
        isOpen={bonusTarget !== null}
        onClose={() => setBonusTarget(null)}
        onSaved={() => {
          void mutateAssignments();
          onSaved();
        }}
      />
      <FinanceConfirmModal
        isOpen={removeTarget !== null}
        handleClose={() => setRemoveTarget(null)}
        handleSubmit={() => void handleRemove()}
        isSubmitting={isSubmitting}
        primaryButtonText={{ default: t("payments.variables.remove"), loading: t("payments.ledger.loading") }}
        title={t("payments.composer.remove_title")}
        content={
          removeTarget
            ? t("payments.composer.remove_description", {
                name:
                  removeTarget.type === "employee"
                    ? removeTarget.assignment.employee_name
                    : removeTarget.assignment.variable_detail.name,
              })
            : ""
        }
      />
      <FinanceConfirmModal
        isOpen={deleteBonusTarget !== null}
        handleClose={() => setDeleteBonusTarget(null)}
        handleSubmit={() => void handleDeleteBonus()}
        isSubmitting={isSubmitting}
        title={t("payments.bonuses.delete_title")}
        content={
          deleteBonusTarget ? t("payments.bonuses.delete_description", { name: deleteBonusTarget.bonus.name }) : ""
        }
      />

      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-subtle px-5 py-2.5">
        <nav
          className="flex items-center gap-0.5 rounded-md bg-layer-2 p-0.5"
          aria-label={t("payments.composer.title")}
        >
          {TABS.map(({ key, label, count }) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              aria-pressed={tab === key}
              className={cn(
                "flex items-center gap-1.5 rounded-sm px-2.5 py-1 text-12 whitespace-nowrap",
                tab === key
                  ? "bg-surface-1 font-medium text-primary shadow-raised-100"
                  : "text-tertiary hover:text-primary"
              )}
            >
              {label}
              {count > 0 && <span className="text-11 text-tertiary tabular-nums">{count}</span>}
            </button>
          ))}
        </nav>
        {tab !== "included" && (
          <label
            className="flex items-center gap-2 text-12 text-secondary"
            title={t("payments.composer.period_filter_help", {
              from: scenario.period_start,
              to: scenario.period_end,
            })}
          >
            <input
              type="checkbox"
              className="accent-accent-primary size-3.5"
              checked={onlyInPeriod}
              onChange={(event) => setOnlyInPeriod(event.target.checked)}
            />
            {t("payments.composer.period_filter")}
          </label>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {tab === "variables" && (
          <section className="space-y-3">
            <div className="flex items-center gap-2">
              <ResourceSearch
                value={variableSearch}
                onChange={setVariableSearch}
                placeholder={t("payments.composer.search_variables")}
                clearLabel={t("payments.composer.clear_search")}
                className="min-w-0 flex-1"
              />
              <Button variant="primary" size="lg" onClick={startNewVariable}>
                <Plus className="size-3.5" />
                {t(hasOffices ? "payments.composer.new_item" : "payroll.offices.new")}
              </Button>
            </div>
            <p className="text-12 text-tertiary">{t("payments.composer.variables_help")}</p>

            {(variables?.length ?? 0) > 0 && (
              <ul className="divide-y divide-subtle overflow-hidden rounded-lg border border-subtle">
                {(variables ?? []).map((variable) => {
                  const assignment = assignedVariableById.get(variable.id);
                  const isSelected = variableSelections.has(variable.id);
                  const isEligible = inPeriod(variable.effective_from, variable.effective_to);
                  if (onlyInPeriod && !isEligible && !assignment) return null;
                  return (
                    <li
                      key={variable.id}
                      className={cn("flex items-center gap-3 px-3 py-2.5", isSelected && "bg-accent-primary/5")}
                    >
                      <input
                        type="checkbox"
                        checked={isSelected || Boolean(assignment)}
                        disabled={!isEligible && !assignment}
                        onChange={(event) => {
                          if (!event.target.checked && assignment) {
                            setRemoveTarget({ type: "variable", assignment });
                            return;
                          }
                          setVariableSelections((current) => {
                            const next = new Set(current);
                            if (event.target.checked) next.add(variable.id);
                            else next.delete(variable.id);
                            return next;
                          });
                        }}
                        className="accent-accent-primary size-4 shrink-0"
                        aria-label={variable.name}
                      />
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
                      {assignment ? (
                        <span className="flex shrink-0 items-center gap-1 text-11 text-secondary">
                          <Check className="size-3" /> {t("payments.composer.in_budget")}
                        </span>
                      ) : (
                        !isEligible && (
                          <span className="shrink-0 text-11 text-tertiary">
                            {t("payments.composer.outside_period")}
                          </span>
                        )
                      )}
                      <span className="shrink-0 text-13 font-medium text-primary tabular-nums">
                        {formatMoney(variable.amount, variable.currency)}
                      </span>
                      <button
                        type="button"
                        onClick={() => setEditingVariable(variable)}
                        className={ICON_BUTTON}
                        aria-label={t("payments.variables.edit")}
                        title={t("payments.variables.edit")}
                      >
                        <Pencil className="size-3.5" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {(variables?.length ?? 0) === 0 && (
              <EmptyComposerState
                icon={Variable}
                title={t(
                  variableSearch.trim() ? "payments.composer.no_search_results" : "payments.composer.no_variables"
                )}
                action={t(
                  variableSearch.trim()
                    ? "payments.composer.clear_search"
                    : hasOffices
                      ? "payments.composer.new_item"
                      : "payroll.offices.new"
                )}
                onAction={() => (variableSearch.trim() ? setVariableSearch("") : startNewVariable())}
              />
            )}
          </section>
        )}

        {tab === "people" && (
          <section className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <ResourceSearch
                value={employeeSearch}
                onChange={setEmployeeSearch}
                placeholder={t("payments.composer.search_people")}
                clearLabel={t("payments.composer.clear_search")}
                className="min-w-48 flex-1"
              />
              <Button variant="secondary" size="lg" onClick={() => setIsOfficesOpen(true)}>
                <Building2 className="size-3.5" /> {t("payroll.offices.title")}
              </Button>
              <Button variant="primary" size="lg" onClick={startNewPerson}>
                <Plus className="size-3.5" /> {t("payments.composer.new_person")}
              </Button>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-12 text-tertiary">{t("payments.composer.people_help")}</p>
              {addableSalaries.length > 0 && (
                <button
                  type="button"
                  onClick={() =>
                    setEmployeeSelections((current) => ({
                      ...current,
                      ...Object.fromEntries(addableSalaries.map((selection) => [selection.salary, selection])),
                    }))
                  }
                  className="flex items-center gap-1 text-12 font-medium text-accent-primary hover:underline"
                >
                  <Check className="size-3.5" />
                  {t("payments.composer.select_active", { count: addableSalaries.length })}
                </button>
              )}
            </div>

            {(employees?.length ?? 0) > 0 && (
              <ul className="divide-y divide-subtle overflow-hidden rounded-lg border border-subtle">
                {(employees ?? []).map((employee) => (
                  <EmployeeComposerRow
                    key={employee.id}
                    workspaceSlug={workspaceSlug}
                    scenario={scenario}
                    employee={employee}
                    hasOffices={hasOffices}
                    assignedSalaryIds={assignedSalaryIds}
                    selections={employeeSelections}
                    onChange={(salaryId, selection) =>
                      setEmployeeSelections((current) => {
                        const next = { ...current };
                        if (selection) next[salaryId] = selection;
                        else delete next[salaryId];
                        return next;
                      })
                    }
                    onEdit={() => setEditingEmployee(employee)}
                    onAddSalary={() => setSalaryTarget({ employee, salary: null })}
                    onEditSalary={(salary) => setSalaryTarget({ employee, salary })}
                    onAddOffice={() => setIsOfficesOpen(true)}
                    onlyInPeriod={onlyInPeriod}
                    onAddableChange={reportAddable}
                  />
                ))}
              </ul>
            )}
            {(employees?.length ?? 0) === 0 && (
              <EmptyComposerState
                icon={Users}
                title={t(employeeSearch.trim() ? "payments.composer.no_search_results" : "payments.composer.no_people")}
                action={t(employeeSearch.trim() ? "payments.composer.clear_search" : "payments.composer.new_person")}
                onAction={() => (employeeSearch.trim() ? setEmployeeSearch("") : startNewPerson())}
              />
            )}
          </section>
        )}

        {tab === "included" && (
          <section className="space-y-3">
            <p className="text-12 text-tertiary">{t("payments.composer.included_help")}</p>
            {includedCount > 0 ? (
              <ul className="divide-y divide-subtle overflow-hidden rounded-lg border border-subtle">
                {(assignedVariables ?? []).map((assignment) => (
                  <li key={assignment.id} className="flex items-center gap-3 px-3 py-2.5">
                    <Variable className="size-4 shrink-0 text-tertiary" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-13 font-medium text-primary">{assignment.variable_detail.name}</p>
                      <p className="mt-0.5 truncate text-11 text-tertiary">
                        {[
                          assignment.variable_detail.office_name,
                          formatYearRange(
                            assignment.variable_detail.effective_from,
                            assignment.variable_detail.effective_to
                          ),
                        ].join(" · ")}
                      </p>
                    </div>
                    <span className="shrink-0 text-13 font-medium tabular-nums">
                      {formatMoney(assignment.variable_detail.amount, assignment.variable_detail.currency)}
                    </span>
                    <button
                      type="button"
                      onClick={() => setRemoveTarget({ type: "variable", assignment })}
                      className="rounded-sm p-1.5 text-tertiary hover:bg-danger-primary/10 hover:text-danger-primary"
                      aria-label={t("payments.composer.remove_title")}
                      title={t("payments.composer.remove_title")}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </li>
                ))}
                {(assignments ?? []).map((assignment) => (
                  <li key={assignment.id} className="px-3 py-2.5">
                    <div className="flex items-center gap-3">
                      <Users className="size-4 shrink-0 text-tertiary" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-13 font-medium text-primary">{assignment.employee_name}</p>
                        <p className="mt-0.5 truncate text-11 text-tertiary">
                          {[
                            assignment.office_name,
                            `${assignment.effective_from} → ${assignment.effective_to ?? scenario.period_end}`,
                          ].join(" · ")}
                        </p>
                      </div>
                      <span className="shrink-0 text-13 font-medium tabular-nums">
                        {formatMoney(assignment.salary_amount, assignment.salary_currency)}
                      </span>
                      <button
                        type="button"
                        onClick={() => setBonusTarget(assignment)}
                        className={ICON_BUTTON}
                        aria-label={t("payments.bonuses.add")}
                        title={t("payments.bonuses.add")}
                      >
                        <Plus className="size-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setRemoveTarget({ type: "employee", assignment })}
                        className="rounded-sm p-1.5 text-tertiary hover:bg-danger-primary/10 hover:text-danger-primary"
                        aria-label={t("payments.composer.remove_title")}
                        title={t("payments.composer.remove_title")}
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                    {assignment.bonuses.length > 0 && (
                      <ul className="mt-2 space-y-1 pl-7">
                        {assignment.bonuses.map((bonus) => (
                          <li key={bonus.id} className="flex items-center gap-2 text-12 text-secondary">
                            <span className="min-w-0 flex-1 truncate">
                              {bonus.name} ·{" "}
                              {bonus.calculation_type === "PERCENTAGE"
                                ? `${bonus.value}%`
                                : formatMoney(bonus.value, assignment.salary_currency)}
                            </span>
                            <button
                              type="button"
                              onClick={() => setDeleteBonusTarget({ assignment, bonus })}
                              className="rounded-sm p-1 text-tertiary hover:text-danger-primary"
                              aria-label={t("payments.bonuses.delete_title")}
                            >
                              <Trash2 className="size-3" />
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyComposerState
                icon={Variable}
                title={t("payments.sheet.empty_title")}
                action={t("payments.composer.new_item")}
                onAction={() => {
                  setTab("variables");
                  startNewVariable();
                }}
              />
            )}
          </section>
        )}
      </div>

      {tab !== "included" && (
        <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-subtle bg-surface-1 px-5 py-3">
          <p className="text-12 text-tertiary">
            {selectedCount > 0
              ? t("payments.composer.selected", { count: selectedCount })
              : t("payments.composer.select_hint")}
          </p>
          <Button
            variant="primary"
            size="lg"
            disabled={selectedCount === 0}
            loading={isSubmitting}
            onClick={() => void handleSubmit()}
          >
            {t("payments.composer.add_selected")}
          </Button>
        </footer>
      )}
    </div>
  );
}

type EmployeeRowProps = {
  workspaceSlug: string;
  scenario: TBudgetScenario;
  employee: TEmployee;
  hasOffices: boolean;
  assignedSalaryIds: Set<string>;
  selections: Record<string, EmployeeSelection>;
  onChange: (salaryId: string, selection?: EmployeeSelection) => void;
  onEdit: () => void;
  onAddSalary: () => void;
  onEditSalary: (salary: TSalary) => void;
  onAddOffice: () => void;
  onlyInPeriod: boolean;
  onAddableChange: (employeeId: string, selections: EmployeeSelection[]) => void;
};

/** One person and, under them, each salary that can go into the budget. */
function EmployeeComposerRow(props: EmployeeRowProps) {
  const {
    workspaceSlug,
    scenario,
    employee,
    hasOffices,
    assignedSalaryIds,
    selections,
    onChange,
    onEdit,
    onAddSalary,
    onEditSalary,
    onAddOffice,
    onlyInPeriod,
    onAddableChange,
  } = props;
  const { t } = useTranslation();
  const { data: salaries, isLoading } = useSWR<TSalary[]>(
    `BUDGET_COMPOSER_SALARIES_${workspaceSlug}_${employee.id}`,
    () => payrollService.getSalaries(workspaceSlug, employee.id),
    { revalidateOnFocus: false }
  );
  const salaryAvailability = (salary: TSalary) =>
    getSalaryBudgetAvailability({
      budgetStart: scenario.period_start,
      budgetEnd: scenario.period_end,
      salaryStart: salary.effective_from,
      salaryEnd: salary.effective_to,
      employeeStart: employee.hire_date,
      employeeEnd: employee.termination_date,
    });
  const eligibleSalaries = (salaries ?? []).filter((salary) => salaryAvailability(salary).isEligible);
  const visibleSalaries = onlyInPeriod ? eligibleSalaries : (salaries ?? []);

  // The row is the only place that knows this employee's salaries; hand the
  // eligible ones upward so the section header can offer them in bulk.
  useEffect(() => {
    onAddableChange(
      employee.id,
      (salaries ?? [])
        .filter((salary) => salaryAvailability(salary).isEligible)
        .map((salary) => salaryWindow(scenario, employee, salary))
    );
    // `salaryAvailability` is pure over these inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [salaries, employee, scenario, onAddableChange]);

  if (onlyInPeriod && !isLoading && (salaries?.length ?? 0) > 0 && visibleSalaries.length === 0) return null;

  const addSalary = hasOffices ? onAddSalary : onAddOffice;

  return (
    <li className="px-3 py-2.5">
      <div className="flex items-center gap-3">
        {isLoading ? (
          <Loader2 className="size-4 shrink-0 animate-spin text-tertiary" />
        ) : (
          <Users className="size-4 shrink-0 text-tertiary" />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-13 font-medium text-primary">{employee.full_name}</p>
          <p className="mt-0.5 truncate text-11 text-tertiary">
            {employee.position || t("payments.scenarios.no_position")}
          </p>
        </div>
        {(salaries?.length ?? 0) > 0 && (
          <button
            type="button"
            onClick={addSalary}
            className={ICON_BUTTON}
            aria-label={t("payroll.employees.new_salary")}
            title={t("payroll.employees.new_salary")}
          >
            <Plus className="size-3.5" />
          </button>
        )}
        <button
          type="button"
          onClick={onEdit}
          className={ICON_BUTTON}
          aria-label={t("payments.actions.edit")}
          title={t("payments.actions.edit")}
        >
          <Pencil className="size-3.5" />
        </button>
      </div>

      {!isLoading && (salaries?.length ?? 0) === 0 && (
        <div className="mt-2 flex items-center justify-between gap-3 pl-7">
          <p className="text-12 text-tertiary">{t("payments.composer.salary_required")}</p>
          <Button variant="secondary" size="base" onClick={addSalary}>
            <Plus className="size-3" /> {t(hasOffices ? "payroll.employees.new_salary" : "payroll.offices.new")}
          </Button>
        </div>
      )}

      {!isLoading && visibleSalaries.length > 0 && (
        <ul className="mt-2 space-y-1 pl-7">
          {visibleSalaries.map((salary) => {
            const availability = salaryAvailability(salary);
            const isEligible = availability.isEligible;
            const isAssigned = assignedSalaryIds.has(salary.id);
            const selection = selections[salary.id];
            const stretch = salaryWindow(scenario, employee, salary);
            return (
              <li key={salary.id} className={cn("rounded-md px-2 py-1.5", selection && "bg-accent-primary/5")}>
                <div className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    checked={isAssigned || Boolean(selection)}
                    disabled={isAssigned || !isEligible}
                    onChange={(event) => onChange(salary.id, event.target.checked ? stretch : undefined)}
                    className="accent-accent-primary size-4 shrink-0"
                    aria-label={`${employee.full_name} · ${salary.office_name}`}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-12 text-primary">
                      {salary.office_name}
                      <span className="text-tertiary">
                        {" · "}
                        {salary.effective_from} → {salary.effective_to ?? t("payroll.employees.current")}
                      </span>
                    </p>
                    {!isEligible && (
                      <p className="mt-0.5 text-11 text-tertiary">
                        {t(`payments.composer.availability.${availability.reason.toLowerCase()}`, {
                          date: availability.conflictingDate,
                        })}
                      </p>
                    )}
                  </div>
                  {isAssigned && (
                    <span className="flex shrink-0 items-center gap-1 text-11 text-secondary">
                      <Check className="size-3" /> {t("payments.composer.in_budget")}
                    </span>
                  )}
                  <span className="shrink-0 text-12 font-medium tabular-nums">
                    {formatMoney(salary.amount, salary.currency)}
                  </span>
                  <button
                    type="button"
                    onClick={() => onEditSalary(salary)}
                    className={ICON_BUTTON}
                    aria-label={t("payroll.employees.edit_salary")}
                    title={t("payroll.employees.edit_salary")}
                  >
                    <Pencil className="size-3.5" />
                  </button>
                </div>
                {selection && (
                  // Picked salaries can start late or end early in this budget.
                  <div className="mt-2 grid grid-cols-2 gap-2 pl-7">
                    <label className="text-11 text-secondary">
                      {t("payments.fields.period_start")}
                      <input
                        type="date"
                        min={stretch.effective_from}
                        max={stretch.effective_to}
                        className={cn(DATE_FIELD, "mt-1")}
                        value={selection.effective_from}
                        onChange={(event) => onChange(salary.id, { ...selection, effective_from: event.target.value })}
                      />
                    </label>
                    <label className="text-11 text-secondary">
                      {t("payments.fields.period_end")}
                      <input
                        type="date"
                        min={selection.effective_from}
                        max={stretch.effective_to}
                        className={cn(DATE_FIELD, "mt-1")}
                        value={selection.effective_to}
                        onChange={(event) => onChange(salary.id, { ...selection, effective_to: event.target.value })}
                      />
                    </label>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

type EmptyProps = {
  icon: typeof Users;
  title: string;
  action: string;
  onAction: () => void;
};

function EmptyComposerState({ icon: Icon, title, action, onAction }: EmptyProps) {
  return (
    <div className="flex flex-col items-center rounded-lg border border-dashed border-subtle px-4 py-10 text-center">
      <Icon className="size-5 text-tertiary" />
      <p className="mt-2 max-w-sm text-13 text-secondary">{title}</p>
      <Button variant="secondary" size="lg" onClick={onAction} className="mt-3">
        <Plus className="size-3.5" /> {action}
      </Button>
    </div>
  );
}
