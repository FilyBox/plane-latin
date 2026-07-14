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
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TOffice } from "@plane/types";
import { AlertModalCore, EModalPosition, EModalWidth, Input, ModalCore } from "@plane/ui";
// services
import { payrollService } from "@/services/payroll.service";
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

      <ModalCore isOpen={isOpen} handleClose={onClose} position={EModalPosition.CENTER} width={EModalWidth.XL}>
        <div className="p-4">
          <h3 className="text-16 font-semibold text-primary">{t("payroll.offices.manage")}</h3>
          <p className="mt-1 mb-5 text-12 text-tertiary">{t("payroll.offices.form_help")}</p>

          <div className="mb-4 grid grid-cols-1 gap-3 rounded-lg border border-subtle bg-layer-1 p-3 sm:grid-cols-[minmax(0,1fr)_9rem_auto] sm:items-start">
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
              <Button
                variant="primary"
                size="xl"
                onClick={() => void handleSave()}
                disabled={!name.trim() || isSubmitting}
              >
                {editingOffice ? <Check className="size-4" /> : <Plus className="size-4" />}
                {t(editingOffice ? "payroll.actions.save" : "payroll.offices.new")}
              </Button>
              {editingOffice && (
                <Button variant="secondary" size="xl" onClick={resetForm}>
                  <X className="size-4" />
                </Button>
              )}
            </div>
          </div>

          {offices.length === 0 ? (
            <p className="py-4 text-center text-13 text-tertiary">{t("payroll.offices.empty")}</p>
          ) : (
            <ul className="max-h-72 divide-y divide-subtle overflow-y-auto">
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

          <div className="mt-5 flex justify-end">
            <Button variant="secondary" size="sm" onClick={onClose}>
              {t("payroll.actions.close")}
            </Button>
          </div>
        </div>
      </ModalCore>
    </>
  );
}
