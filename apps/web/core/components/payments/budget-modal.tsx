/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
// plane imports
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TBudget, TExpenseCategory } from "@plane/types";
import { AlertModalCore, EModalPosition, EModalWidth, Input, ModalCore } from "@plane/ui";
// services
import { financeService } from "@/services/finance.service";
// local imports
import { CURRENCIES } from "./shared";

const FIELD =
  "w-full rounded-sm border border-subtle bg-layer-1 px-2 py-1.5 text-13 outline-none focus:border-accent-primary";
const LABEL = "mb-1 block text-11 font-medium uppercase text-tertiary";

type Props = {
  workspaceSlug: string;
  isOpen: boolean;
  categories: TExpenseCategory[];
  /** Prefills the period with the window currently on screen */
  defaultPeriod: { from: string; to: string };
  /** Set to edit an existing budget; null creates a new one */
  budget?: TBudget | null;
  /** Prefills the bucket when creating straight from a summary card with no budget */
  defaultCategory?: string;
  defaultCurrency?: string;
  onClose: () => void;
  onSaved: () => void;
};

export function BudgetModal(props: Props) {
  const {
    workspaceSlug,
    isOpen,
    categories,
    defaultPeriod,
    budget,
    defaultCategory,
    defaultCurrency,
    onClose,
    onSaved,
  } = props;
  const { t } = useTranslation();
  const [category, setCategory] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState(CURRENCIES[0]);
  const [periodStart, setPeriodStart] = useState(defaultPeriod.from);
  const [periodEnd, setPeriodEnd] = useState(defaultPeriod.to);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);

  const isEditing = Boolean(budget);

  useEffect(() => {
    if (!isOpen) return;
    if (budget) {
      // Editing: the form shows the budget's own period, not the window on
      // screen — otherwise saving would silently move it.
      setCategory(budget.category);
      setAmount(budget.amount);
      setCurrency(budget.currency);
      setPeriodStart(budget.period_start);
      setPeriodEnd(budget.period_end);
      return;
    }
    setCategory(defaultCategory ?? categories[0]?.id ?? "");
    setAmount("");
    setCurrency(defaultCurrency ?? CURRENCIES[0]);
    setPeriodStart(defaultPeriod.from);
    setPeriodEnd(defaultPeriod.to);
  }, [isOpen, budget, categories, defaultCategory, defaultCurrency, defaultPeriod.from, defaultPeriod.to]);

  const handleSubmit = async () => {
    if (!category || !amount.trim()) return;
    setIsSubmitting(true);
    try {
      const payload = {
        category,
        amount,
        currency,
        period_start: periodStart,
        period_end: periodEnd,
      } as Partial<TBudget>;
      if (budget) await financeService.updateBudget(workspaceSlug, budget.id, payload);
      else await financeService.createBudget(workspaceSlug, payload);
      // Budgets get their own toast: toasts.created reads "Expense recorded"
      setToast({ type: TOAST_TYPE.SUCCESS, title: t("payments.toasts.budget_saved") });
      onSaved();
      onClose();
    } catch (error: any) {
      // The API answers 409 when this bucket is already budgeted for the period
      setToast({
        type: TOAST_TYPE.ERROR,
        title: t("payments.toasts.error"),
        message: error?.error ?? t("payments.toasts.duplicate_budget"),
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!budget) return;
    setIsSubmitting(true);
    try {
      await financeService.deleteBudget(workspaceSlug, budget.id);
      setToast({ type: TOAST_TYPE.SUCCESS, title: t("payments.toasts.budget_deleted") });
      setIsDeleteOpen(false);
      onSaved();
      onClose();
    } catch {
      setToast({ type: TOAST_TYPE.ERROR, title: t("payments.toasts.error") });
    } finally {
      setIsSubmitting(false);
    }
  };

  const isPeriodInverted = Boolean(periodStart && periodEnd && periodEnd < periodStart);

  return (
    <>
      <AlertModalCore
        isOpen={isDeleteOpen}
        handleClose={() => setIsDeleteOpen(false)}
        handleSubmit={() => void handleDelete()}
        isSubmitting={isSubmitting}
        title={t("payments.delete_budget_title")}
        content={t("payments.delete_budget_description")}
      />

      <ModalCore isOpen={isOpen} handleClose={onClose} position={EModalPosition.CENTER} width={EModalWidth.XL}>
        <div className="p-4">
          <h3 className="text-15 mb-4 font-medium">{t(isEditing ? "payments.edit_budget" : "payments.new_budget")}</h3>

          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className={LABEL}>{t("payments.fields.category")}</label>
              <select className={FIELD} value={category} onChange={(event) => setCategory(event.target.value)}>
                {categories.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className={LABEL}>{t("payments.fields.amount")}</label>
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
              <label className={LABEL}>{t("payments.fields.currency")}</label>
              <select className={FIELD} value={currency} onChange={(event) => setCurrency(event.target.value)}>
                {CURRENCIES.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </div>

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

          <div className="mt-5 flex items-center justify-between gap-2">
            {isEditing ? (
              <button
                type="button"
                onClick={() => setIsDeleteOpen(true)}
                className="flex items-center gap-1 rounded-sm px-2 py-1.5 text-12 text-tertiary hover:bg-layer-1-hover hover:text-danger-primary"
              >
                <Trash2 className="size-3.5" />
                {t("payments.actions.delete")}
              </button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={onClose}>
                {t("payments.actions.cancel")}
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => void handleSubmit()}
                loading={isSubmitting}
                disabled={!category || !amount.trim() || isPeriodInverted}
              >
                {t("payments.actions.save")}
              </Button>
            </div>
          </div>
        </div>
      </ModalCore>
    </>
  );
}
