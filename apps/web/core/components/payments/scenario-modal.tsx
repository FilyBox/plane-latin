/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useEffect, useState } from "react";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TBudgetScenario, TBudgetScenarioStatus } from "@plane/types";
import { EModalPosition, EModalWidth, Input, ModalCore, TextArea } from "@plane/ui";
import { financeService } from "@/services/finance.service";
import { CURRENCIES } from "./shared";

const FIELD =
  "h-9 w-full rounded-sm border border-subtle bg-layer-1 px-2.5 text-13 outline-none focus:border-accent-primary";
const LABEL = "mb-1.5 block text-11 font-medium text-secondary";

type Props = {
  workspaceSlug: string;
  isOpen: boolean;
  scenario?: TBudgetScenario | null;
  onClose: () => void;
  onSaved: (scenario: TBudgetScenario) => void;
};

export function BudgetScenarioModal({ workspaceSlug, isOpen, scenario, onClose, onSaved }: Props) {
  const { t } = useTranslation();
  const currentYear = new Date().getFullYear();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [year, setYear] = useState(currentYear);
  const [periodStart, setPeriodStart] = useState(`${currentYear}-01-01`);
  const [periodEnd, setPeriodEnd] = useState(`${currentYear}-12-31`);
  const [currency, setCurrency] = useState("MXN");
  const [status, setStatus] = useState<TBudgetScenarioStatus>("DRAFT");
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const fiscalYear = scenario?.fiscal_year ?? currentYear;
    setName(scenario?.name ?? "");
    setDescription(scenario?.description ?? "");
    setYear(fiscalYear);
    setPeriodStart(scenario?.period_start ?? `${fiscalYear}-01-01`);
    setPeriodEnd(scenario?.period_end ?? `${fiscalYear}-12-31`);
    setCurrency(scenario?.currency ?? "MXN");
    setStatus(scenario?.status ?? "DRAFT");
  }, [currentYear, isOpen, scenario]);

  const handleYearChange = (nextYear: number) => {
    setYear(nextYear);
    setPeriodStart(`${nextYear}-01-01`);
    setPeriodEnd(`${nextYear}-12-31`);
  };

  const handleSubmit = async () => {
    if (!name.trim() || periodEnd < periodStart) return;
    setIsSubmitting(true);
    try {
      const payload = {
        name: name.trim(),
        description: description.trim(),
        fiscal_year: year,
        period_start: periodStart,
        period_end: periodEnd,
        currency,
        status,
      };
      const saved = scenario
        ? await financeService.updateScenario(workspaceSlug, scenario.id, payload)
        : await financeService.createScenario(workspaceSlug, payload);
      setToast({ type: TOAST_TYPE.SUCCESS, title: t("payments.scenarios.saved") });
      onSaved(saved);
      onClose();
    } catch (error: any) {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: t("payments.toasts.error"),
        message: error?.name?.[0] ?? error?.error,
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <ModalCore isOpen={isOpen} handleClose={onClose} position={EModalPosition.CENTER} width={EModalWidth.LG}>
      <div className="p-5">
        <div className="mb-5">
          <h2 className="text-16 font-semibold text-primary">
            {t(scenario ? "payments.scenarios.edit" : "payments.scenarios.create")}
          </h2>
          <p className="mt-1 text-12 text-tertiary">{t("payments.scenarios.form_description")}</p>
        </div>

        <div className="space-y-4">
          <div>
            <label className={LABEL}>{t("payments.scenarios.name")}</label>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t("payments.scenarios.name_placeholder")}
            />
          </div>
          <div>
            <label className={LABEL}>
              {t("payments.fields.description")}{" "}
              <span className="font-normal text-tertiary">({t("payments.optional")})</span>
            </label>
            <TextArea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder={t("payments.scenarios.description_placeholder")}
              className="min-h-20"
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <label className={LABEL}>{t("payments.scenarios.fiscal_year")}</label>
              <Input
                type="number"
                min="2000"
                max="2200"
                value={year}
                onChange={(event) => handleYearChange(Number(event.target.value) || currentYear)}
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
              <label className={LABEL}>{t("payments.scenarios.status_label")}</label>
              <select
                className={FIELD}
                value={status}
                onChange={(event) => setStatus(event.target.value as TBudgetScenarioStatus)}
              >
                {(["DRAFT", "ACTIVE", "ARCHIVED"] as const).map((item) => (
                  <option key={item} value={item}>
                    {t(`payments.scenarios.status.${item.toLowerCase()}`)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 rounded-md border border-subtle bg-layer-1 p-3 sm:grid-cols-2">
            <div>
              <label className={LABEL}>{t("payments.fields.period_start")}</label>
              <input
                type="date"
                className={FIELD}
                value={periodStart}
                onChange={(event) => setPeriodStart(event.target.value)}
              />
            </div>
            <div>
              <label className={LABEL}>{t("payments.fields.period_end")}</label>
              <input
                type="date"
                className={FIELD}
                value={periodEnd}
                onChange={(event) => setPeriodEnd(event.target.value)}
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
            disabled={!name.trim() || periodEnd < periodStart}
            onClick={() => void handleSubmit()}
          >
            {t("payments.actions.save")}
          </Button>
        </div>
      </div>
    </ModalCore>
  );
}
