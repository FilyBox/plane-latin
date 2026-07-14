/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useState } from "react";
import { Building2, Check, Loader2, Pencil, Plus, Trash2, Users, Variable } from "lucide-react";
import useSWR, { useSWRConfig } from "swr";
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
  TSalary,
} from "@plane/types";
import { AlertModalCore } from "@plane/ui";
import { cn } from "@plane/utils";
import { financeService } from "@/services/finance.service";
import { payrollService } from "@/services/payroll.service";
import { EmployeeModal } from "./payroll/employee-modal";
import { OfficesModal } from "./payroll/offices-modal";
import { SalaryModal } from "./payroll/salary-modal";
import { formatMoney } from "./shared";
import { FinancialVariableModal } from "./variable-modal";

type EmployeeSelection = {
  salary: string;
  effective_from: string;
  effective_to: string;
};

type Props = {
  workspaceSlug: string;
  scenario: TBudgetScenario;
  onSaved: () => void;
};

export function BudgetResourceComposer({ workspaceSlug, scenario, onSaved }: Props) {
  const { t } = useTranslation();
  const { mutate: mutateGlobal } = useSWRConfig();
  const [employeeSelections, setEmployeeSelections] = useState<Record<string, EmployeeSelection>>({});
  const [variableSelections, setVariableSelections] = useState<Set<string>>(new Set());
  const [editingEmployee, setEditingEmployee] = useState<TEmployee | null | undefined>(undefined);
  const [salaryTarget, setSalaryTarget] = useState<TEmployee | null>(null);
  const [isOfficesOpen, setIsOfficesOpen] = useState(false);
  const [editingVariable, setEditingVariable] = useState<TFinancialVariable | null | undefined>(undefined);
  const [removeTarget, setRemoveTarget] = useState<
    | { type: "employee"; assignment: TBudgetScenarioEmployee }
    | { type: "variable"; assignment: TBudgetScenarioVariable }
    | null
  >(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const { data: employees, mutate: mutateEmployees } = useSWR<TEmployee[]>(
    `PAYROLL_EMPLOYEES_${workspaceSlug}`,
    () => payrollService.getEmployees(workspaceSlug),
    { revalidateOnFocus: false }
  );
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

  const assignedSalaryIds = new Set((assignments ?? []).map((assignment) => assignment.salary));
  const assignedVariableIds = new Set((assignedVariables ?? []).map((assignment) => assignment.variable));
  const selectedCount = Object.keys(employeeSelections).length + variableSelections.size;

  const handleSubmit = async () => {
    if (selectedCount === 0) return;
    setIsSubmitting(true);
    try {
      await Promise.all([
        ...Object.entries(employeeSelections).map(([employee, selection]) =>
          financeService.addScenarioEmployee(workspaceSlug, scenario.id, { employee, ...selection })
        ),
        ...Array.from(variableSelections).map((variable) =>
          financeService.addScenarioVariable(workspaceSlug, scenario.id, variable)
        ),
      ]);
      setEmployeeSelections({});
      setVariableSelections(new Set());
      await Promise.all([mutateAssignments(), mutateAssignedVariables()]);
      onSaved();
      setToast({ type: TOAST_TYPE.SUCCESS, title: t("payments.composer.saved") });
    } catch (error: any) {
      setToast({ type: TOAST_TYPE.ERROR, title: t("payments.toasts.error"), message: error?.error });
    } finally {
      setIsSubmitting(false);
    }
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
    } catch {
      setToast({ type: TOAST_TYPE.ERROR, title: t("payments.toasts.error") });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <EmployeeModal
        workspaceSlug={workspaceSlug}
        isOpen={editingEmployee !== undefined}
        employee={editingEmployee ?? null}
        onClose={() => setEditingEmployee(undefined)}
        onSaved={() => void mutateEmployees()}
      />
      <SalaryModal
        workspaceSlug={workspaceSlug}
        employeeId={salaryTarget?.id ?? ""}
        offices={offices ?? []}
        isOpen={salaryTarget !== null}
        onClose={() => setSalaryTarget(null)}
        onSaved={() => {
          if (salaryTarget) void mutateGlobal(`BUDGET_COMPOSER_SALARIES_${workspaceSlug}_${salaryTarget.id}`);
          void mutateEmployees();
        }}
      />
      <OfficesModal
        workspaceSlug={workspaceSlug}
        offices={offices ?? []}
        isOpen={isOfficesOpen}
        onClose={() => setIsOfficesOpen(false)}
        onChanged={() => void mutateOffices()}
      />
      <FinancialVariableModal
        workspaceSlug={workspaceSlug}
        offices={offices ?? []}
        variable={editingVariable ?? null}
        isOpen={editingVariable !== undefined}
        onClose={() => setEditingVariable(undefined)}
        onSaved={() => void mutateVariables()}
      />
      <AlertModalCore
        isOpen={removeTarget !== null}
        handleClose={() => setRemoveTarget(null)}
        handleSubmit={() => void handleRemove()}
        isSubmitting={isSubmitting}
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

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-5">
        {((assignments?.length ?? 0) > 0 || (assignedVariables?.length ?? 0) > 0) && (
          <section>
            <div>
              <h3 className="text-13 font-semibold text-primary">{t("payments.composer.included_title")}</h3>
              <p className="mt-1 text-11 text-tertiary">{t("payments.composer.included_help")}</p>
            </div>
            <div className="mt-3 divide-y divide-subtle overflow-hidden rounded-lg border border-subtle">
              {(assignments ?? []).map((assignment) => (
                <div key={assignment.id} className="flex items-center gap-3 px-3 py-2.5">
                  <Users className="size-4 shrink-0 text-tertiary" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-11 font-medium text-primary">{assignment.employee_name}</p>
                    <p className="mt-0.5 truncate text-9 text-tertiary">
                      {assignment.office_name} / {formatMoney(assignment.salary_amount, assignment.salary_currency)}
                    </p>
                  </div>
                  <span className="hidden text-9 text-tertiary sm:inline">
                    {assignment.effective_from} / {assignment.effective_to ?? scenario.period_end}
                  </span>
                  <button
                    type="button"
                    onClick={() => setRemoveTarget({ type: "employee", assignment })}
                    className="rounded-sm p-1.5 text-tertiary hover:bg-danger-primary/10 hover:text-danger-primary"
                    aria-label={t("payments.actions.delete")}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              ))}
              {(assignedVariables ?? []).map((assignment) => (
                <div key={assignment.id} className="flex items-center gap-3 px-3 py-2.5">
                  <Variable className="size-4 shrink-0 text-tertiary" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-11 font-medium text-primary">{assignment.variable_detail.name}</p>
                    <p className="mt-0.5 truncate text-9 text-tertiary">
                      {assignment.variable_detail.office_name} /{" "}
                      {formatMoney(assignment.variable_detail.amount, assignment.variable_detail.currency)}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setRemoveTarget({ type: "variable", assignment })}
                    className="rounded-sm p-1.5 text-tertiary hover:bg-danger-primary/10 hover:text-danger-primary"
                    aria-label={t("payments.actions.delete")}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}
        <section>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="flex items-center gap-2 text-13 font-semibold text-primary">
                <Users className="size-4" /> {t("payments.composer.people")}
              </h3>
              <p className="mt-1 text-11 text-tertiary">{t("payments.composer.people_help")}</p>
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" size="lg" onClick={() => setIsOfficesOpen(true)}>
                <Building2 className="size-3.5" /> {t("payroll.offices.title")}
              </Button>
              <Button variant="secondary" size="lg" onClick={() => setEditingEmployee(null)}>
                <Plus className="size-3.5" /> {t("payroll.employees.new")}
              </Button>
            </div>
          </div>

          <div className="mt-3 space-y-2">
            {(employees ?? []).map((employee) => (
              <EmployeeComposerRow
                key={employee.id}
                workspaceSlug={workspaceSlug}
                scenario={scenario}
                employee={employee}
                offices={offices ?? []}
                assignedSalaryIds={assignedSalaryIds}
                selection={employeeSelections[employee.id]}
                onChange={(selection) =>
                  setEmployeeSelections((current) => {
                    const next = { ...current };
                    if (selection) next[employee.id] = selection;
                    else delete next[employee.id];
                    return next;
                  })
                }
                onEdit={() => setEditingEmployee(employee)}
                onAddSalary={() => setSalaryTarget(employee)}
                onAddOffice={() => setIsOfficesOpen(true)}
              />
            ))}
            {(employees?.length ?? 0) === 0 && (
              <EmptyComposerState
                icon={Users}
                title={t("payments.composer.no_people")}
                action={t("payroll.employees.new")}
                onAction={() => setEditingEmployee(null)}
              />
            )}
          </div>
        </section>

        <section>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="flex items-center gap-2 text-13 font-semibold text-primary">
                <Variable className="size-4" /> {t("payments.composer.variables")}
              </h3>
              <p className="mt-1 text-11 text-tertiary">{t("payments.composer.variables_help")}</p>
            </div>
            <Button
              variant="secondary"
              size="lg"
              onClick={() => (offices?.length ? setEditingVariable(null) : setIsOfficesOpen(true))}
            >
              <Plus className="size-3.5" />
              {t(offices?.length ? "payments.variables.create" : "payroll.offices.new")}
            </Button>
          </div>

          <div className="mt-3 space-y-2">
            {(variables ?? []).map((variable) => {
              const isAssigned = assignedVariableIds.has(variable.id);
              const isSelected = variableSelections.has(variable.id);
              return (
                <div
                  key={variable.id}
                  className={cn(
                    "flex items-center gap-3 rounded-lg border border-subtle p-3",
                    isSelected && "border-accent-primary bg-accent-primary/5",
                    isAssigned && "bg-layer-2/60"
                  )}
                >
                  <input
                    type="checkbox"
                    checked={isSelected || isAssigned}
                    disabled={isAssigned}
                    onChange={(event) =>
                      setVariableSelections((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.add(variable.id);
                        else next.delete(variable.id);
                        return next;
                      })
                    }
                    className="accent-accent-primary size-4"
                    aria-label={variable.name}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-12 font-medium text-primary">{variable.name}</p>
                    <p className="mt-0.5 truncate text-10 text-tertiary">
                      {variable.office_name} / {t(`payments.variables.recurrence.${variable.recurrence.toLowerCase()}`)}
                    </p>
                  </div>
                  <p className="text-11 font-semibold text-primary">
                    {formatMoney(variable.amount, variable.currency)}
                  </p>
                  {isAssigned && (
                    <span className="flex items-center gap-1 text-10 text-success-primary">
                      <Check className="size-3" /> {t("payments.composer.in_budget")}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => setEditingVariable(variable)}
                    className="rounded-sm p-1.5 text-tertiary hover:bg-layer-1-hover hover:text-primary"
                    aria-label={t("payments.actions.edit")}
                  >
                    <Pencil className="size-3.5" />
                  </button>
                </div>
              );
            })}
            {(variables?.length ?? 0) === 0 && (
              <EmptyComposerState
                icon={Variable}
                title={t("payments.composer.no_variables")}
                action={t(offices?.length ? "payments.variables.create" : "payroll.offices.new")}
                onAction={() => (offices?.length ? setEditingVariable(null) : setIsOfficesOpen(true))}
              />
            )}
          </div>
        </section>
      </div>

      <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-subtle bg-surface-1 px-5 py-3">
        <p className="text-11 text-tertiary">{t("payments.composer.selected", { count: selectedCount })}</p>
        <Button
          variant="primary"
          size="xl"
          disabled={selectedCount === 0}
          loading={isSubmitting}
          onClick={() => void handleSubmit()}
        >
          <Plus className="size-4" /> {t("payments.composer.add_selected")}
        </Button>
      </footer>
    </div>
  );
}

type EmployeeRowProps = {
  workspaceSlug: string;
  scenario: TBudgetScenario;
  employee: TEmployee;
  offices: TOffice[];
  assignedSalaryIds: Set<string>;
  selection?: EmployeeSelection;
  onChange: (selection?: EmployeeSelection) => void;
  onEdit: () => void;
  onAddSalary: () => void;
  onAddOffice: () => void;
};

function EmployeeComposerRow(props: EmployeeRowProps) {
  const {
    workspaceSlug,
    scenario,
    employee,
    offices,
    assignedSalaryIds,
    selection,
    onChange,
    onEdit,
    onAddSalary,
    onAddOffice,
  } = props;
  const { t } = useTranslation();
  const { data: salaries, isLoading } = useSWR<TSalary[]>(
    `BUDGET_COMPOSER_SALARIES_${workspaceSlug}_${employee.id}`,
    () => payrollService.getSalaries(workspaceSlug, employee.id),
    { revalidateOnFocus: false }
  );
  const availableSalaries = (salaries ?? []).filter((salary) => !assignedSalaryIds.has(salary.id));
  const isFullyAssigned = (salaries?.length ?? 0) > 0 && availableSalaries.length === 0;

  const toggle = () => {
    if (selection) onChange(undefined);
    else if (availableSalaries[0]) {
      onChange({
        salary: availableSalaries[0].id,
        effective_from: scenario.period_start,
        effective_to: scenario.period_end,
      });
    }
  };

  return (
    <div
      className={cn(
        "rounded-lg border border-subtle p-3",
        selection && "border-accent-primary bg-accent-primary/5",
        isFullyAssigned && "bg-layer-2/60"
      )}
    >
      <div className="flex items-center gap-3">
        {isLoading ? (
          <Loader2 className="size-4 animate-spin text-tertiary" />
        ) : (
          <input
            type="checkbox"
            checked={Boolean(selection) || isFullyAssigned}
            disabled={availableSalaries.length === 0}
            onChange={toggle}
            className="accent-accent-primary size-4"
            aria-label={employee.full_name}
          />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-12 font-medium text-primary">{employee.full_name}</p>
          <p className="mt-0.5 truncate text-10 text-tertiary">
            {employee.position || t("payments.scenarios.no_position")}
          </p>
        </div>
        {isFullyAssigned && (
          <span className="flex items-center gap-1 text-10 text-success-primary">
            <Check className="size-3" /> {t("payments.composer.in_budget")}
          </span>
        )}
        <button
          type="button"
          onClick={onEdit}
          className="rounded-sm p-1.5 text-tertiary hover:bg-layer-1-hover hover:text-primary"
          aria-label={t("payments.actions.edit")}
        >
          <Pencil className="size-3.5" />
        </button>
      </div>

      {!isLoading && (salaries?.length ?? 0) === 0 && (
        <div className="mt-3 flex items-center justify-between gap-3 rounded-md bg-layer-2 px-3 py-2">
          <p className="text-10 text-tertiary">{t("payments.composer.salary_required")}</p>
          <Button variant="secondary" size="base" onClick={offices.length ? onAddSalary : onAddOffice}>
            <Plus className="size-3" /> {t(offices.length ? "payroll.employees.new_salary" : "payroll.offices.new")}
          </Button>
        </div>
      )}

      {selection && (
        <div className="mt-3 grid grid-cols-1 gap-3 border-t border-subtle pt-3 sm:grid-cols-3">
          <div>
            <label className="mb-1 block text-10 font-medium text-secondary">
              {t("payments.scenarios.salary_to_apply")}
            </label>
            <select
              className="h-8 w-full rounded-sm border border-subtle bg-layer-1 px-2 text-11"
              value={selection.salary}
              onChange={(event) => onChange({ ...selection, salary: event.target.value })}
            >
              {availableSalaries.map((salary) => (
                <option key={salary.id} value={salary.id}>
                  {salary.office_name} / {formatMoney(salary.amount, salary.currency)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-10 font-medium text-secondary">{t("payments.fields.period_start")}</label>
            <input
              type="date"
              min={scenario.period_start}
              max={scenario.period_end}
              className="h-8 w-full rounded-sm border border-subtle bg-layer-1 px-2 text-11"
              value={selection.effective_from}
              onChange={(event) => onChange({ ...selection, effective_from: event.target.value })}
            />
          </div>
          <div>
            <label className="mb-1 block text-10 font-medium text-secondary">{t("payments.fields.period_end")}</label>
            <input
              type="date"
              min={selection.effective_from}
              max={scenario.period_end}
              className="h-8 w-full rounded-sm border border-subtle bg-layer-1 px-2 text-11"
              value={selection.effective_to}
              onChange={(event) => onChange({ ...selection, effective_to: event.target.value })}
            />
          </div>
        </div>
      )}
    </div>
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
    <div className="flex flex-col items-center rounded-lg border border-dashed border-subtle px-4 py-8 text-center">
      <Icon className="size-5 text-tertiary" />
      <p className="mt-2 text-11 text-secondary">{title}</p>
      <Button variant="secondary" size="lg" onClick={onAction} className="mt-3">
        <Plus className="size-3.5" /> {action}
      </Button>
    </div>
  );
}
