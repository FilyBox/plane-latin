/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useEffect, useState } from "react";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TFinancialRecurrence, TFinancialVariable, TFinancialVariableKind, TOffice } from "@plane/types";
import { EModalPosition, EModalWidth, Input, ModalCore, TextArea } from "@plane/ui";
import { financeService } from "@/services/finance.service";
import { CURRENCIES } from "./shared";

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
  onSaved: (variable: TFinancialVariable) => void;
};

export function FinancialVariableModal({ workspaceSlug, offices, variable, isOpen, onClose, onSaved }: Props) {
  const { t } = useTranslation();
  const year = new Date().getFullYear();
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
    setCurrency(variable?.currency ?? "MXN");
    setRecurrence(variable?.recurrence ?? "MONTHLY");
    setEffectiveFrom(variable?.effective_from ?? `${year}-01-01`);
    setEffectiveTo(variable?.effective_to ?? "");
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
      setToast({ type: TOAST_TYPE.SUCCESS, title: t("payments.variables.saved") });
      onSaved(saved);
      onClose();
    } catch (error: any) {
      setToast({ type: TOAST_TYPE.ERROR, title: t("payments.toasts.error"), message: error?.name?.[0] });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <ModalCore isOpen={isOpen} handleClose={onClose} position={EModalPosition.CENTER} width={EModalWidth.LG}>
      <div className="p-5">
        <h2 className="text-16 font-semibold text-primary">
          {t(variable ? "payments.variables.edit" : "payments.variables.create")}
        </h2>
        <p className="mt-1 text-12 text-tertiary">{t("payments.variables.form_description")}</p>
        <div className="mt-5 space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className={LABEL}>{t("payments.fields.name")}</label>
              <Input value={name} onChange={(event) => setName(event.target.value)} />
            </div>
            <div>
              <label className={LABEL}>{t("payments.variables.entity")}</label>
              <select className={FIELD} value={office} onChange={(event) => setOffice(event.target.value)}>
                {offices.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className={LABEL}>
              {t("payments.fields.description")}{" "}
              <span className="font-normal text-tertiary">({t("payments.optional")})</span>
            </label>
            <TextArea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              className="min-h-16"
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <label className={LABEL}>{t("payments.variables.kind_label")}</label>
              <select
                className={FIELD}
                value={kind}
                onChange={(event) => setKind(event.target.value as TFinancialVariableKind)}
              >
                <option value="EXPENSE">{t("payments.variables.kind.expense")}</option>
                <option value="INCOME">{t("payments.variables.kind.income")}</option>
              </select>
            </div>
            <div>
              <label className={LABEL}>{t("payments.fields.amount")}</label>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
              />
            </div>
            <div>
              <label className={LABEL}>{t("payments.fields.currency")}</label>
              <select className={FIELD} value={currency} onChange={(event) => setCurrency(event.target.value)}>
                {CURRENCIES.map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={LABEL}>{t("payments.variables.recurrence_label")}</label>
              <select
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
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className={LABEL}>{t("payments.fields.period_start")}</label>
              <input
                type="date"
                className={FIELD}
                value={effectiveFrom}
                onChange={(event) => setEffectiveFrom(event.target.value)}
              />
            </div>
            <div>
              <label className={LABEL}>
                {t("payments.fields.period_end")}{" "}
                <span className="font-normal text-tertiary">({t("payments.optional")})</span>
              </label>
              <input
                type="date"
                className={FIELD}
                value={effectiveTo}
                min={effectiveFrom}
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
            disabled={!name.trim() || !office || !amount || (!!effectiveTo && effectiveTo < effectiveFrom)}
            onClick={() => void handleSubmit()}
          >
            {t("payments.actions.save")}
          </Button>
        </div>
      </div>
    </ModalCore>
  );
}
