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
import type { TEmployee } from "@plane/types";
import { Input } from "@plane/ui";
// services
import { payrollService } from "@/services/payroll.service";
import { PaymentsSidePanel } from "../side-panel";
// local imports
import { FIELD, LABEL, todayIso } from "./shared";

type Props = {
  workspaceSlug: string;
  isOpen: boolean;
  employee: TEmployee | null;
  onClose: () => void;
  onSaved: () => void;
};

type FormState = {
  full_name: string;
  email: string;
  national_id: string;
  position: string;
  hire_date: string;
  termination_date: string;
  notes: string;
};

const emptyForm = (): FormState => ({
  full_name: "",
  email: "",
  national_id: "",
  position: "",
  hire_date: todayIso(),
  termination_date: "",
  notes: "",
});

export function EmployeeModal(props: Props) {
  const { workspaceSlug, isOpen, employee, onClose, onSaved } = props;
  const { t } = useTranslation();
  const [form, setForm] = useState<FormState>(emptyForm());
  const [hasTerminationDate, setHasTerminationDate] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setForm(
      employee
        ? {
            full_name: employee.full_name,
            email: employee.email,
            national_id: employee.national_id,
            position: employee.position,
            hire_date: employee.hire_date,
            termination_date: employee.termination_date ?? "",
            notes: employee.notes,
          }
        : emptyForm()
    );
    setHasTerminationDate(Boolean(employee?.termination_date));
  }, [isOpen, employee]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((previous) => ({ ...previous, [key]: value }));

  const handleSubmit = async () => {
    if (!form.full_name.trim() || !form.hire_date) return;
    setIsSubmitting(true);
    try {
      const payload = {
        ...form,
        // "" is not a date; the API wants null for someone still employed
        termination_date: form.termination_date || null,
      } as Partial<TEmployee>;
      if (employee) await payrollService.updateEmployee(workspaceSlug, employee.id, payload);
      else await payrollService.createEmployee(workspaceSlug, payload);
      setToast({ type: TOAST_TYPE.SUCCESS, title: t("payroll.toasts.saved") });
      onSaved();
      onClose();
    } catch (error: any) {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: t("payroll.toasts.error"),
        message: error?.termination_date?.[0] ?? error?.full_name?.[0] ?? undefined,
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <PaymentsSidePanel
      isOpen={isOpen}
      onClose={onClose}
      width="xl"
      title={t(employee ? "payroll.employees.edit" : "payroll.employees.new")}
      description={t("payroll.employees.form_help")}
    >
      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          void handleSubmit();
        }}
      >
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label className={LABEL}>{t("payroll.fields.full_name")}</label>
              <Input
                value={form.full_name}
                onChange={(event) => set("full_name", event.target.value)}
                className="w-full"
              />
            </div>
            <div>
              <label className={LABEL}>
                {t("payroll.fields.position")}{" "}
                <span className="font-normal text-tertiary">({t("payroll.optional")})</span>
              </label>
              <Input value={form.position} onChange={(event) => set("position", event.target.value)} className="w-full" />
            </div>
            <div>
              <label className={LABEL}>
                {t("payroll.fields.national_id")}{" "}
                <span className="font-normal text-tertiary">({t("payroll.optional")})</span>
              </label>
              <Input
                value={form.national_id}
                onChange={(event) => set("national_id", event.target.value)}
                className="w-full"
              />
              <p className="mt-1 text-10 text-tertiary">{t("payroll.employees.national_id_help")}</p>
            </div>
            <div>
              <label className={LABEL}>
                {t("payroll.fields.email")} <span className="font-normal text-tertiary">({t("payroll.optional")})</span>
              </label>
              <Input
                type="email"
                value={form.email}
                onChange={(event) => set("email", event.target.value)}
                className="w-full"
              />
            </div>
            <div>
              <label className={LABEL}>{t("payroll.fields.hire_date")}</label>
              <input
                type="date"
                className={FIELD}
                value={form.hire_date}
                onChange={(event) => set("hire_date", event.target.value)}
              />
            </div>
            {employee && (
              <div className="rounded-md border border-subtle bg-layer-1 p-3 sm:col-span-2">
                <label
                  aria-label={t("payroll.employees.left_company")}
                  className="flex cursor-pointer items-start gap-2 text-12 text-secondary"
                >
                  <input
                    type="checkbox"
                    checked={hasTerminationDate}
                    onChange={(event) => {
                      setHasTerminationDate(event.target.checked);
                      if (!event.target.checked) set("termination_date", "");
                    }}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="font-medium text-primary">{t("payroll.employees.left_company")}</span>
                    <span className="mt-0.5 block text-10 text-tertiary">{t("payroll.employees.termination_help")}</span>
                  </span>
                </label>
                {hasTerminationDate && (
                  <div className="mt-3 max-w-xs">
                    <label className={LABEL}>{t("payroll.fields.termination_date")}</label>
                    <input
                      type="date"
                      min={form.hire_date}
                      className={FIELD}
                      value={form.termination_date}
                      onChange={(event) => set("termination_date", event.target.value)}
                    />
                  </div>
                )}
              </div>
            )}
            <div className="sm:col-span-2">
              <label className={LABEL}>
                {t("payroll.fields.notes")} <span className="font-normal text-tertiary">({t("payroll.optional")})</span>
              </label>
              <textarea
                className={FIELD}
                rows={2}
                value={form.notes}
                onChange={(event) => set("notes", event.target.value)}
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
            disabled={!form.full_name.trim() || !form.hire_date}
          >
            {t("payroll.actions.save")}
          </Button>
        </div>
      </form>
    </PaymentsSidePanel>
  );
}
