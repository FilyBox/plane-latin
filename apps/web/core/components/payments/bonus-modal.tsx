/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useEffect, useState } from "react";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TBudgetScenario, TBudgetScenarioEmployee } from "@plane/types";
import { EModalPosition, EModalWidth, Input, ModalCore } from "@plane/ui";
import { financeService } from "@/services/finance.service";

const FIELD =
  "h-9 w-full rounded-sm border border-subtle bg-layer-1 px-2.5 text-13 outline-none focus:border-accent-primary";
const LABEL = "mb-1.5 block text-11 font-medium text-secondary";

type Props = {
  workspaceSlug: string;
  scenario: TBudgetScenario;
  assignment: TBudgetScenarioEmployee | null;
  isOpen: boolean;
  onClose: () => void;
  onSaved: () => void;
};

export function BudgetBonusModal({ workspaceSlug, scenario, assignment, isOpen, onClose, onSaved }: Props) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [calculationType, setCalculationType] = useState<"FIXED" | "PERCENTAGE">("FIXED");
  const [value, setValue] = useState("");
  const [periodicity, setPeriodicity] = useState<"BIWEEKLY" | "MONTHLY">("MONTHLY");
  const [effectiveFrom, setEffectiveFrom] = useState(scenario.period_start);
  const [effectiveTo, setEffectiveTo] = useState(scenario.period_end);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const assignmentEnd = assignment?.effective_to ?? scenario.period_end;

  useEffect(() => {
    if (!isOpen) return;
    setName("");
    setCalculationType("FIXED");
    setValue("");
    setPeriodicity("MONTHLY");
    setEffectiveFrom(assignment?.effective_from ?? scenario.period_start);
    setEffectiveTo(assignment?.effective_to ?? scenario.period_end);
  }, [assignment, isOpen, scenario.period_end, scenario.period_start]);

  const handleSubmit = async () => {
    if (!assignment || !name.trim() || !value) return;
    setIsSubmitting(true);
    try {
      await financeService.createBudgetBonus(workspaceSlug, scenario.id, assignment.id, {
        name: name.trim(),
        calculation_type: calculationType,
        value,
        periodicity,
        effective_from: effectiveFrom,
        effective_to: effectiveTo || null,
      });
      setToast({ type: TOAST_TYPE.SUCCESS, title: t("payments.bonuses.saved") });
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
        <h2 className="text-16 font-semibold text-primary">{t("payments.bonuses.create")}</h2>
        <p className="mt-1 text-12 text-tertiary">
          {assignment?.employee_name} / {assignment?.office_name}
        </p>
        <div className="mt-5 space-y-4">
          <div>
            <label className={LABEL}>{t("payments.fields.name")}</label>
            <Input value={name} onChange={(event) => setName(event.target.value)} />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <label className={LABEL}>{t("payments.bonuses.calculation")}</label>
              <select
                className={FIELD}
                value={calculationType}
                onChange={(event) => setCalculationType(event.target.value as "FIXED" | "PERCENTAGE")}
              >
                <option value="FIXED">{t("payments.bonuses.fixed")}</option>
                <option value="PERCENTAGE">{t("payments.bonuses.percentage")}</option>
              </select>
            </div>
            <div>
              <label className={LABEL}>
                {calculationType === "FIXED" ? t("payments.fields.amount") : t("payments.bonuses.percent")}
              </label>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={value}
                onChange={(event) => setValue(event.target.value)}
              />
            </div>
            <div>
              <label className={LABEL}>{t("payments.bonuses.periodicity")}</label>
              <select
                className={FIELD}
                value={periodicity}
                onChange={(event) => setPeriodicity(event.target.value as "BIWEEKLY" | "MONTHLY")}
              >
                <option value="BIWEEKLY">{t("payroll.periodicity.biweekly")}</option>
                <option value="MONTHLY">{t("payroll.periodicity.monthly")}</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className={LABEL}>{t("payments.fields.period_start")}</label>
              <input
                type="date"
                className={FIELD}
                min={assignment?.effective_from ?? scenario.period_start}
                max={assignmentEnd}
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
                max={assignmentEnd}
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
            disabled={!name.trim() || !value || effectiveTo < effectiveFrom}
            onClick={() => void handleSubmit()}
          >
            {t("payments.actions.save")}
          </Button>
        </div>
      </div>
    </ModalCore>
  );
}
