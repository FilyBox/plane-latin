/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useEffect, useId, useState } from "react";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TFinancialRecurrence, TFinancialVariable, TFinancialVariableKind, TOffice } from "@plane/types";
import { Input, TextArea } from "@plane/ui";
import { financeService } from "@/services/finance.service";
import { CURRENCIES } from "./shared";
import { PaymentsSidePanel } from "./side-panel";

const FIELD =
  "h-9 w-full rounded-sm border border-subtle bg-layer-1 px-2.5 text-13 outline-none focus:border-accent-primary";
const LABEL = "mb-1.5 block text-11 font-medium text-secondary";
const RECURRENCES: TFinancialRecurrence[] = [
  "ONE_TIME",
  "DAILY",
  "WEEKLY",
  "BIWEEKLY",
  "MONTHLY",
  "QUARTERLY",
  "ANNUAL",
];

type Props = {
  workspaceSlug: string;
  offices: TOffice[];
  variable?: TFinancialVariable | null;
  isOpen: boolean;
  onClose: () => void;
  /** Set when this opened from another panel, so it stacks over it. */
  nested?: boolean;
  /** Starting values for a new item, e.g. the budget's currency and period. */
  defaults?: { currency?: string; effective_from?: string; effective_to?: string };
  /** Names what saving does when it does more than save, e.g. also adds it to a budget. */
  submitLabel?: string;
  onSaved: (variable: TFinancialVariable) => void;
};

export function FinancialVariableModal({
  workspaceSlug,
  offices,
  variable,
  isOpen,
  onClose,
  nested,
  defaults,
  submitLabel,
  onSaved,
}: Props) {
  const { t } = useTranslation();
  const year = new Date().getFullYear();
  const fieldId = useId();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [office, setOffice] = useState("");
  const [kind, setKind] = useState<TFinancialVariableKind>("EXPENSE");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("MXN");
  const [recurrence, setRecurrence] = useState<TFinancialRecurrence>("MONTHLY");
  const [effectiveFrom, setEffectiveFrom] = useState(`${year}-01-01`);
  const [effectiveTo, setEffectiveTo] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setName(variable?.name ?? "");
    setDescription(variable?.description ?? "");
    setOffice(variable?.office ?? offices[0]?.id ?? "");
    setKind(variable?.kind ?? "EXPENSE");
    setAmount(variable?.amount ?? "");
    setCurrency(variable?.currency ?? defaults?.currency ?? "MXN");
    setRecurrence(variable?.recurrence ?? "MONTHLY");
    setEffectiveFrom(variable?.effective_from ?? defaults?.effective_from ?? `${year}-01-01`);
    setEffectiveTo(variable?.effective_to ?? defaults?.effective_to ?? "");
    // `defaults` is read once on open; a new object each render must not reset the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, offices, variable, year]);

  const handleSubmit = async () => {
    if (!name.trim() || !office || !amount) return;
    setIsSubmitting(true);
    try {
      const payload = {
        name: name.trim(),
        description: description.trim(),
        office,
        kind,
        amount,
        currency,
        recurrence,
        effective_from: effectiveFrom,
        effective_to: effectiveTo || null,
      };
      const saved = variable
        ? await financeService.updateFinancialVariable(workspaceSlug, variable.id, payload)
        : await financeService.createFinancialVariable(workspaceSlug, payload);
      // A caller that does more than save (submitLabel) reports the outcome itself.
      if (!submitLabel) setToast({ type: TOAST_TYPE.SUCCESS, title: t("payments.variables.saved") });
      onSaved(saved);
      onClose();
    } catch (error: any) {
      setToast({ type: TOAST_TYPE.ERROR, title: t("payments.toasts.error"), message: error?.name?.[0] });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <PaymentsSidePanel
      isOpen={isOpen}
      onClose={onClose}
      nested={nested}
      title={t(variable ? "payments.variables.edit" : "payments.variables.create")}
      description={t("payments.variables.form_description")}
    >
      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          void handleSubmit();
        }}
      >
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <div>
            <label htmlFor={`${fieldId}-name`} className={LABEL}>
              {t("payments.fields.name")}
            </label>
            <Input
              id={`${fieldId}-name`}
              value={name}
              placeholder={t("payments.variables.name_placeholder")}
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              onChange={(event) => setName(event.target.value)}
              className="w-full"
            />
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-3">
            <div>
              <label htmlFor={`${fieldId}-amount`} className={LABEL}>
                {t("payments.fields.amount")}
              </label>
              <Input
                id={`${fieldId}-amount`}
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                placeholder="0.00"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                className="w-full text-right tabular-nums"
              />
            </div>
            <div>
              <label htmlFor={`${fieldId}-currency`} className={LABEL}>
                {t("payments.fields.currency")}
              </label>
              <select
                id={`${fieldId}-currency`}
                className={FIELD}
                value={currency}
                onChange={(event) => setCurrency(event.target.value)}
              >
                {CURRENCIES.map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor={`${fieldId}-recurrence`} className={LABEL}>
                {t("payments.variables.recurrence_label")}
              </label>
              <select
                id={`${fieldId}-recurrence`}
                className={FIELD}
                value={recurrence}
                onChange={(event) => setRecurrence(event.target.value as TFinancialRecurrence)}
              >
                {RECURRENCES.map((item) => (
                  <option key={item} value={item}>
                    {t(`payments.variables.recurrence.${item.toLowerCase()}`)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <span id={`${fieldId}-kind`} className={LABEL}>
                {t("payments.variables.kind_label")}
              </span>
              {/* Two choices read faster side by side than inside a dropdown. */}
              <div
                role="radiogroup"
                aria-labelledby={`${fieldId}-kind`}
                className="grid h-9 grid-cols-2 gap-0.5 rounded-sm bg-layer-2 p-0.5"
              >
                {(["EXPENSE", "INCOME"] as TFinancialVariableKind[]).map((item) => (
                  <button
                    key={item}
                    type="button"
                    role="radio"
                    aria-checked={kind === item}
                    onClick={() => setKind(item)}
                    className={
                      kind === item
                        ? "rounded-sm bg-surface-1 text-13 font-medium text-primary shadow-raised-100"
                        : "rounded-sm text-13 text-tertiary hover:text-primary"
                    }
                  >
                    {t(`payments.variables.kind.${item.toLowerCase()}`)}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor={`${fieldId}-from`} className={LABEL}>
                {t("payments.fields.period_start")}
              </label>
              <input
                id={`${fieldId}-from`}
                type="date"
                className={FIELD}
                value={effectiveFrom}
                onChange={(event) => setEffectiveFrom(event.target.value)}
              />
            </div>
            <div>
              <label htmlFor={`${fieldId}-to`} className={LABEL}>
                {t("payments.fields.period_end")}{" "}
                <span className="font-normal text-tertiary">({t("payments.optional")})</span>
              </label>
              <input
                id={`${fieldId}-to`}
                type="date"
                className={FIELD}
                value={effectiveTo}
                min={effectiveFrom}
                onChange={(event) => setEffectiveTo(event.target.value)}
              />
            </div>
          </div>
          <div>
            <label htmlFor={`${fieldId}-office`} className={LABEL}>
              {t("payments.variables.entity")}
            </label>
            <select
              id={`${fieldId}-office`}
              className={FIELD}
              value={office}
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
            <label htmlFor={`${fieldId}-description`} className={LABEL}>
              {t("payments.fields.description")}{" "}
              <span className="font-normal text-tertiary">({t("payments.optional")})</span>
            </label>
            <TextArea
              id={`${fieldId}-description`}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              className="min-h-16"
            />
          </div>
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-subtle bg-surface-1 px-5 py-3">
          <Button type="button" variant="secondary" size="sm" onClick={onClose}>
            {t("payments.actions.cancel")}
          </Button>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            loading={isSubmitting}
            disabled={!name.trim() || !office || !amount || (!!effectiveTo && effectiveTo < effectiveFrom)}
          >
            {submitLabel ?? t("payments.actions.save")}
          </Button>
        </div>
      </form>
    </PaymentsSidePanel>
  );
}
