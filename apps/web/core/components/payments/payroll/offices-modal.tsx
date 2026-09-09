/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import { Check, Pencil, Plus, Trash2, X } from "lucide-react";
// plane imports
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { EmptyStateCompact } from "@plane/propel/empty-state";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TOffice } from "@plane/types";
import { AlertModalCore, Input } from "@plane/ui";
// services
import { payrollService } from "@/services/payroll.service";
import { PaymentsSidePanel } from "../side-panel";
// local imports
import { FIELD, LABEL } from "./shared";

type Props = {
  workspaceSlug: string;
  isOpen: boolean;
  offices: TOffice[];
  onClose: () => void;
  onChanged: () => void;
};

export function OfficesModal(props: Props) {
  const { workspaceSlug, isOpen, offices, onClose, onChanged } = props;
  const { t } = useTranslation();
  const [name, setName] = useState("");
  // Legal minimum in Mexico; an office may pay more, never less
  const [aguinaldoDays, setAguinaldoDays] = useState("15");
  const [editingOffice, setEditingOffice] = useState<TOffice | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TOffice | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const resetForm = () => {
    setName("");
    setAguinaldoDays("15");
    setEditingOffice(null);
  };

  const handleSave = async () => {
    if (!name.trim()) return;
    setIsSubmitting(true);
    try {
      const payload = {
        name: name.trim(),
        aguinaldo_days: Number(aguinaldoDays) || 15,
      };
      if (editingOffice) await payrollService.updateOffice(workspaceSlug, editingOffice.id, payload);
      else await payrollService.createOffice(workspaceSlug, payload);
      resetForm();
      onChanged();
    } catch (error: any) {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: t("payroll.toasts.error"),
        message: error?.name?.[0] ?? undefined,
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setIsSubmitting(true);
    try {
      await payrollService.deleteOffice(workspaceSlug, deleteTarget.id);
      setDeleteTarget(null);
      onChanged();
    } catch (error: any) {
      // 409 when the office still pays people — deleting it would orphan the
      // salaries and payments hanging off it
      setToast({
        type: TOAST_TYPE.ERROR,
        title: t("payroll.toasts.error"),
        message: error?.error ?? t("payroll.offices.in_use"),
      });
      setDeleteTarget(null);
    } finally {
      setIsSubmitting(false);
    }
  };

  const hasDependencies = Boolean(
    deleteTarget && (deleteTarget.salary_count || deleteTarget.payment_count || deleteTarget.variable_count)
  );

  return (
    <>
      <AlertModalCore
        isOpen={deleteTarget !== null}
        handleClose={() => setDeleteTarget(null)}
        handleSubmit={() => (hasDependencies ? setDeleteTarget(null) : void handleDelete())}
        isSubmitting={isSubmitting}
        title={t("payroll.offices.delete_title")}
        content={
          deleteTarget
            ? t(hasDependencies ? "payroll.offices.delete_blocked_impact" : "payroll.offices.delete_impact", {
                name: deleteTarget.name,
                employees: deleteTarget.employee_count,
                salaries: deleteTarget.salary_count,
                payments: deleteTarget.payment_count,
                variables: deleteTarget.variable_count,
              })
            : ""
        }
        variant={hasDependencies ? "primary" : "danger"}
        primaryButtonText={
          hasDependencies ? { default: t("payroll.actions.close"), loading: t("payroll.actions.close") } : undefined
        }
      />

      <PaymentsSidePanel
        isOpen={isOpen}
        onClose={onClose}
        width="lg"
        title={t("payroll.offices.manage")}
        description={t("payroll.offices.form_help")}
      >
        {/* Add/edit sits above the list and submits on Enter, so entities can be
            entered one after another without reaching for the mouse. */}
        <form
          className="shrink-0 border-b border-subtle px-5 py-4"
          onSubmit={(event) => {
            event.preventDefault();
            void handleSave();
          }}
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_7rem_auto] sm:items-start">
            <div className="flex-1">
              <label className={LABEL}>{t("payroll.fields.name")}</label>
              <Input value={name} onChange={(event) => setName(event.target.value)} className="w-full" />
            </div>
            <div>
              <label className={LABEL}>{t("payroll.fields.aguinaldo_days")}</label>
              <input
                type="number"
                min="15"
                className={FIELD}
                value={aguinaldoDays}
                onChange={(event) => setAguinaldoDays(event.target.value)}
              />
              <p className="mt-1 text-9 text-tertiary">{t("payroll.offices.aguinaldo_help")}</p>
            </div>
            <div className="flex gap-2 sm:pt-[1.4rem]">
              <Button type="submit" variant="primary" size="xl" disabled={!name.trim() || isSubmitting}>
                {editingOffice ? <Check className="size-4" /> : <Plus className="size-4" />}
                {t(editingOffice ? "payroll.actions.save" : "payroll.offices.new")}
              </Button>
              {editingOffice && (
                <Button type="button" variant="secondary" size="xl" onClick={resetForm}>
                  <X className="size-4" />
                </Button>
              )}
            </div>
          </div>
        </form>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
          {offices.length === 0 ? (
            <EmptyStateCompact assetKey="members" title={t("payroll.offices.empty")} />
          ) : (
            <ul className="divide-y divide-subtle">
              {offices.map((office) => (
                <li key={office.id} className="flex items-center justify-between gap-2 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-13">{office.name}</p>
                    <p className="text-11 text-tertiary">
                      {office.employee_count} {t("payroll.offices.people")} / {office.aguinaldo_days}{" "}
                      {t("payroll.aguinaldo.days").toLowerCase()}
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        setEditingOffice(office);
                        setName(office.name);
                        setAguinaldoDays(String(office.aguinaldo_days));
                      }}
                      className="rounded-sm p-1 text-tertiary hover:bg-layer-1-hover hover:text-primary"
                      title={t("payroll.actions.edit")}
                    >
                      <Pencil className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeleteTarget(office)}
                      className="rounded-sm p-1 text-tertiary hover:bg-layer-1-hover hover:text-danger-primary"
                      title={t("payroll.actions.delete")}
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-subtle bg-surface-1 px-5 py-3">
          <Button variant="secondary" size="sm" onClick={onClose}>
            {t("payroll.actions.close")}
          </Button>
        </div>
      </PaymentsSidePanel>
    </>
  );
}
