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
import type { TEmployee, TOffice, TPayrollConcept, TPayrollPayment } from "@plane/types";
import { Input } from "@plane/ui";
// services
import { payrollService } from "@/services/payroll.service";
import { PaymentsSidePanel } from "../side-panel";
// local imports
import { CURRENCIES, FIELD, LABEL, PAYROLL_CONCEPTS, todayIso } from "./shared";

type Props = {
  workspaceSlug: string;
  isOpen: boolean;
  employees: TEmployee[];
  offices: TOffice[];
  onClose: () => void;
  /** Set when this opened from another panel, so it stacks over it. */
  nested?: boolean;
  onSaved: () => void;
};

export function PayrollPaymentModal(props: Props) {
  const { workspaceSlug, isOpen, employees, offices, onClose, nested, onSaved } = props;
  const { t } = useTranslation();
  const [employee, setEmployee] = useState("");
  const [office, setOffice] = useState("");
  const [concept, setConcept] = useState<TPayrollConcept>("SALARY");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState(CURRENCIES[0]);
  const [periodStart, setPeriodStart] = useState(todayIso());
  const [periodEnd, setPeriodEnd] = useState(todayIso());
  const [scheduledDate, setScheduledDate] = useState(todayIso());
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setEmployee(employees[0]?.id ?? "");
    setOffice(offices[0]?.id ?? "");
    setConcept("SALARY");
    setAmount("");
    setCurrency(CURRENCIES[0]);
    setPeriodStart(todayIso());
    setPeriodEnd(todayIso());
    setScheduledDate(todayIso());
  }, [isOpen, employees, offices]);

  const handleSubmit = async () => {
    if (!employee || !office || !amount.trim()) return;
    setIsSubmitting(true);
    try {
      // Created PENDING: it shows up under "upcoming" until someone marks it
      // paid, which is the same row, not a second one.
      await payrollService.createPayment(workspaceSlug, {
        employee,
        office,
        concept,
        amount,
        currency,
        period_start: periodStart,
        period_end: periodEnd,
        scheduled_date: scheduledDate,
      } as Partial<TPayrollPayment>);
      setToast({ type: TOAST_TYPE.SUCCESS, title: t("payroll.toasts.saved") });
      onSaved();
      onClose();
    } catch (error: any) {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: t("payroll.toasts.error"),
        message: error?.period_end?.[0] ?? error?.amount?.[0] ?? undefined,
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const isPeriodInverted = Boolean(periodStart && periodEnd && periodEnd < periodStart);

  return (
    <PaymentsSidePanel isOpen={isOpen} onClose={onClose} nested={nested} width="xl" title={t("payroll.payments.new")}>
      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          void handleSubmit();
        }}
      >
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2 sm:col-span-1">
              <label className={LABEL}>{t("payroll.fields.employee")}</label>
              <select className={FIELD} value={employee} onChange={(event) => setEmployee(event.target.value)}>
                {employees.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.full_name}
                  </option>
                ))}
              </select>
            </div>
            <div className="col-span-2 sm:col-span-1">
              <label className={LABEL}>{t("payroll.fields.office")}</label>
              <select className={FIELD} value={office} onChange={(event) => setOffice(event.target.value)}>
                {offices.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="col-span-2 sm:col-span-1">
              <label className={LABEL}>{t("payroll.fields.concept")}</label>
              <select
                className={FIELD}
                value={concept}
                onChange={(event) => setConcept(event.target.value as TPayrollConcept)}
              >
                {PAYROLL_CONCEPTS.map((item) => (
                  <option key={item} value={item}>
                    {t(`payroll.concepts.${item.toLowerCase()}`)}
                  </option>
                ))}
              </select>
            </div>
            <div className="col-span-2 grid grid-cols-2 gap-3 sm:col-span-1">
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
            </div>

            <div className="col-span-2 sm:col-span-1">
              <label className={LABEL}>{t("payroll.fields.period_start")}</label>
              <input
                type="date"
                className={FIELD}
                value={periodStart}
                onChange={(event) => setPeriodStart(event.target.value)}
              />
            </div>
            <div className="col-span-2 sm:col-span-1">
              <label className={LABEL}>{t("payroll.fields.period_end")}</label>
              <input
                type="date"
                className={FIELD}
                value={periodEnd}
                onChange={(event) => setPeriodEnd(event.target.value)}
              />
            </div>
            <div className="col-span-2 sm:col-span-1">
              <label className={LABEL}>{t("payroll.fields.scheduled_date")}</label>
              <input
                type="date"
                className={FIELD}
                value={scheduledDate}
                onChange={(event) => setScheduledDate(event.target.value)}
              />
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-subtle bg-surface-1 px-5 py-3">
          <Button type="button" variant="secondary" size="sm" onClick={onClose}>
            {t("payroll.actions.cancel")}
          </Button>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            loading={isSubmitting}
            disabled={!employee || !office || !amount.trim() || isPeriodInverted}
          >
            {t("payroll.actions.save")}
          </Button>
        </div>
      </form>
    </PaymentsSidePanel>
  );
}
