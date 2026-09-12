/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useState } from "react";
// plane imports
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TOffice, TPeriodicity, TSalary } from "@plane/types";
import { Input } from "@plane/ui";
// services
import { payrollService } from "@/services/payroll.service";
import { PaymentsSidePanel } from "../side-panel";
// local imports
import { CURRENCIES, FIELD, LABEL, PERIODICITIES, todayIso } from "./shared";

type Props = {
  workspaceSlug: string;
  employeeId: string;
  salary?: TSalary | null;
  isOpen: boolean;
  offices: TOffice[];
  defaultEffectiveFrom?: string;
  onClose: () => void;
  /** Set when this opened from another panel, so it stacks over it. */
  nested?: boolean;
  onSaved: () => void;
};

export function SalaryModal(props: Props) {
  const { workspaceSlug, employeeId, salary, isOpen, offices, defaultEffectiveFrom, onClose, nested, onSaved } = props;
  const { t } = useTranslation();
  const [office, setOffice] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState(CURRENCIES[0]);
  const [periodicity, setPeriodicity] = useState<TPeriodicity>("MONTHLY");
  const [effectiveFrom, setEffectiveFrom] = useState(todayIso());
  const [effectiveTo, setEffectiveTo] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setOffice(salary?.office ?? offices[0]?.id ?? "");
    setAmount(salary?.amount ?? "");
    setCurrency(salary?.currency ?? CURRENCIES[0]);
    setPeriodicity(salary?.periodicity ?? "MONTHLY");
    setEffectiveFrom(salary?.effective_from ?? defaultEffectiveFrom ?? todayIso());
    setEffectiveTo(salary?.effective_to ?? "");
  }, [defaultEffectiveFrom, isOpen, offices, salary]);

  const handleSubmit = async () => {
    if (!office || !amount.trim()) return;
    setIsSubmitting(true);
    try {
      // The API inserts this record into the employee's dated salary history.
      const payload = {
        office,
        amount,
        currency,
        periodicity,
        effective_from: effectiveFrom,
        ...(salary ? { effective_to: effectiveTo || null } : {}),
      } as Partial<TSalary>;
      if (salary) await payrollService.updateSalary(workspaceSlug, employeeId, salary.id, payload);
      else await payrollService.createSalary(workspaceSlug, employeeId, payload);
      setToast({ type: TOAST_TYPE.SUCCESS, title: t("payroll.toasts.saved") });
      onSaved();
      onClose();
    } catch (error: any) {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: t("payroll.toasts.error"),
        message:
          error?.effective_from?.[0] ?? error?.effective_to?.[0] ?? error?.office?.[0] ?? error?.error ?? undefined,
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <PaymentsSidePanel
      isOpen={isOpen}
      onClose={onClose}
      nested={nested}
      width="lg"
      title={t(salary ? "payroll.employees.edit_salary" : "payroll.employees.new_salary")}
    >
      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          void handleSubmit();
        }}
      >
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label className={LABEL}>{t("payroll.fields.office")}</label>
              <select
                className={FIELD}
                value={office}
                disabled={Boolean(salary)}
                onChange={(event) => setOffice(event.target.value)}
              >
                {offices.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={LABEL}>{t("payroll.fields.amount")}</label>
              <Input
                type="number"
                step="0.01"
                min="0"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                placeholder="0.00"
                className="w-full"
              />
            </div>
            <div>
              <label className={LABEL}>{t("payroll.fields.currency")}</label>
              <select className={FIELD} value={currency} onChange={(event) => setCurrency(event.target.value)}>
                {CURRENCIES.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={LABEL}>{t("payroll.fields.periodicity")}</label>
              <select
                className={FIELD}
                value={periodicity}
                onChange={(event) => setPeriodicity(event.target.value as TPeriodicity)}
              >
                {PERIODICITIES.map((item) => (
                  <option key={item} value={item}>
                    {t(`payroll.periodicity.${item.toLowerCase()}`)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={LABEL}>{t("payroll.fields.effective_from")}</label>
              <input
                type="date"
                className={FIELD}
                value={effectiveFrom}
                onChange={(event) => setEffectiveFrom(event.target.value)}
              />
            </div>
            {salary && (
              <div>
                <label className={LABEL}>
                  {t("payroll.fields.effective_to")} ({t("payroll.optional")})
                </label>
                <input
                  type="date"
                  className={FIELD}
                  min={effectiveFrom}
                  value={effectiveTo}
                  onChange={(event) => setEffectiveTo(event.target.value)}
                />
                <p className="mt-1 text-10 text-tertiary">{t("payroll.employees.open_ended_salary_help")}</p>
              </div>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-subtle bg-surface-1 px-5 py-3">
          <Button type="button" variant="secondary" size="sm" onClick={onClose}>
            {t("payroll.actions.cancel")}
          </Button>
          <Button type="submit" variant="primary" size="sm" loading={isSubmitting} disabled={!office || !amount.trim()}>
            {t("payroll.actions.save")}
          </Button>
        </div>
      </form>
    </PaymentsSidePanel>
  );
}
