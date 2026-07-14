/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useEffect, useState } from "react";
import useSWR from "swr";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TBudgetScenario, TEmployee, TSalary } from "@plane/types";
import { EModalPosition, EModalWidth, ModalCore } from "@plane/ui";
import { financeService } from "@/services/finance.service";
import { payrollService } from "@/services/payroll.service";
import { formatMoney } from "./shared";

const FIELD =
  "h-9 w-full rounded-sm border border-subtle bg-layer-1 px-2.5 text-13 outline-none focus:border-accent-primary";
const LABEL = "mb-1.5 block text-11 font-medium text-secondary";

type Props = {
  workspaceSlug: string;
  scenario: TBudgetScenario;
  employees: TEmployee[];
  isOpen: boolean;
  onClose: () => void;
  onSaved: () => void;
};

export function ScenarioEmployeeModal({ workspaceSlug, scenario, employees, isOpen, onClose, onSaved }: Props) {
  const { t } = useTranslation();
  const [employeeId, setEmployeeId] = useState("");
  const [salaryId, setSalaryId] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState(scenario.period_start);
  const [effectiveTo, setEffectiveTo] = useState(scenario.period_end);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const { data: salaries } = useSWR<TSalary[]>(
    isOpen && employeeId ? `SCENARIO_SALARIES_${workspaceSlug}_${employeeId}` : null,
    () => payrollService.getSalaries(workspaceSlug, employeeId),
    { revalidateOnFocus: false }
  );

  useEffect(() => {
    if (!isOpen) return;
    setEmployeeId(employees[0]?.id ?? "");
    setSalaryId("");
    setEffectiveFrom(scenario.period_start);
    setEffectiveTo(scenario.period_end);
  }, [employees, isOpen, scenario.period_end, scenario.period_start]);

  useEffect(() => {
    if (salaries?.length && !salaries.some((salary) => salary.id === salaryId)) setSalaryId(salaries[0].id);
  }, [salaries, salaryId]);

  const handleSubmit = async () => {
    if (!employeeId || !salaryId) return;
    setIsSubmitting(true);
    try {
      await financeService.addScenarioEmployee(workspaceSlug, scenario.id, {
        employee: employeeId,
        salary: salaryId,
        effective_from: effectiveFrom,
        effective_to: effectiveTo || null,
      });
      setToast({ type: TOAST_TYPE.SUCCESS, title: t("payments.scenarios.employee_added") });
      onSaved();
      onClose();
    } catch (error: any) {
      setToast({ type: TOAST_TYPE.ERROR, title: t("payments.toasts.error"), message: error?.error });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <ModalCore isOpen={isOpen} handleClose={onClose} position={EModalPosition.CENTER} width={EModalWidth.LG}>
      <div className="p-5">
        <h2 className="text-16 font-semibold text-primary">{t("payments.scenarios.add_employee")}</h2>
        <p className="mt-1 text-12 text-tertiary">{t("payments.scenarios.select_salary_help")}</p>
        <div className="mt-5 space-y-4">
          <div>
            <label className={LABEL}>{t("payroll.fields.employee")}</label>
            <select className={FIELD} value={employeeId} onChange={(event) => setEmployeeId(event.target.value)}>
              {employees.map((employee) => (
                <option key={employee.id} value={employee.id}>
                  {employee.full_name} {employee.position ? `- ${employee.position}` : ""}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={LABEL}>{t("payments.scenarios.salary_to_apply")}</label>
            <div className="space-y-2">
              {(salaries ?? []).map((salary) => (
                <button
                  key={salary.id}
                  type="button"
                  onClick={() => setSalaryId(salary.id)}
                  className={`flex w-full items-center justify-between rounded-md border p-3 text-left ${
                    salaryId === salary.id ? "border-accent-primary bg-accent-primary/5" : "border-subtle bg-layer-1"
                  }`}
                >
                  <div>
                    <p className="text-13 font-medium text-primary">{salary.office_name}</p>
                    <p className="mt-0.5 text-11 text-tertiary">
                      {salary.effective_from} - {salary.effective_to ?? t("payroll.employees.current")}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-13 font-semibold text-primary">{formatMoney(salary.amount, salary.currency)}</p>
                    <p className="mt-0.5 text-10 text-tertiary">
                      {t(`payroll.periodicity.${salary.periodicity.toLowerCase()}`)}
                    </p>
                  </div>
                </button>
              ))}
              {employeeId && salaries?.length === 0 && (
                <p className="rounded-md border border-dashed border-subtle p-4 text-center text-12 text-tertiary">
                  {t("payments.scenarios.no_salaries")}
                </p>
              )}
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className={LABEL}>{t("payments.fields.period_start")}</label>
              <input
                type="date"
                className={FIELD}
                min={scenario.period_start}
                max={scenario.period_end}
                value={effectiveFrom}
                onChange={(event) => setEffectiveFrom(event.target.value)}
              />
            </div>
            <div>
              <label className={LABEL}>{t("payments.fields.period_end")}</label>
              <input
                type="date"
                className={FIELD}
                min={effectiveFrom}
                max={scenario.period_end}
                value={effectiveTo}
                onChange={(event) => setEffectiveTo(event.target.value)}
              />
            </div>
          </div>
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>
            {t("payments.actions.cancel")}
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={isSubmitting}
            disabled={!employeeId || !salaryId || effectiveTo < effectiveFrom}
            onClick={() => void handleSubmit()}
          >
            {t("payments.scenarios.add_to_budget")}
          </Button>
        </div>
      </div>
    </ModalCore>
  );
}
