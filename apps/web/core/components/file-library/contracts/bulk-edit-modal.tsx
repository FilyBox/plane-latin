/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * Edits the same fields on every selected contract. Only the ticked fields
 * are sent; the rest stay as they are on each contract.
 */

import { useEffect, useState } from "react";
import { Loader2, PencilLine } from "lucide-react";
// plane imports
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TContractBulkUpdateFields } from "@plane/types";
import { EModalPosition, EModalWidth, ModalCore } from "@plane/ui";
// services
import { contractService } from "@/services/contract.service";
// local imports
import { CONTRACT_STATUS_OPTIONS, CONTRACT_TYPE_OPTIONS } from "./constants";

type TFieldKey = keyof TContractBulkUpdateFields;

type Props = {
  workspaceSlug: string;
  isOpen: boolean;
  contractIds: string[];
  onClose: () => void;
  onDone: () => void;
};

const INPUT = "h-8 w-full rounded-sm border border-subtle bg-surface-1 px-2 text-12 disabled:opacity-50";

export function ContractBulkEditModal(props: Props) {
  const { workspaceSlug, isOpen, contractIds, onClose, onDone } = props;
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState<Partial<Record<TFieldKey, boolean>>>({});
  const [values, setValues] = useState<TContractBulkUpdateFields>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setEnabled({});
    setValues({});
  }, [isOpen]);

  const fields = (Object.keys(enabled) as TFieldKey[]).filter((key) => enabled[key]);

  const handleSubmit = async () => {
    if (fields.length === 0 || isSubmitting) return;
    const payload: TContractBulkUpdateFields = {};
    fields.forEach((key) => {
      const value = values[key];
      if (key === "es_editorial" || key === "es_notariado") payload[key] = value === true;
      else (payload as Record<string, unknown>)[key] = value === "" || value === undefined ? null : value;
    });
    setIsSubmitting(true);
    try {
      const { updated } = await contractService.bulkUpdate(workspaceSlug, contractIds, payload);
      setToast({
        type: TOAST_TYPE.SUCCESS,
        title: t("file_library.contracts.bulk_edit.success", { count: updated?.length ?? contractIds.length }),
      });
      onDone();
      onClose();
    } catch {
      setToast({ type: TOAST_TYPE.ERROR, title: t("file_library.contracts.bulk_edit.failed") });
    } finally {
      setIsSubmitting(false);
    }
  };

  const set = (key: TFieldKey, value: unknown) => setValues((current) => ({ ...current, [key]: value }));

  const row = (key: TFieldKey, label: string, control: React.ReactNode) => (
    <div key={key} className="grid grid-cols-[minmax(0,10rem)_1fr] items-center gap-3 py-1">
      <label className="flex items-center gap-2 text-12">
        <input
          type="checkbox"
          checked={!!enabled[key]}
          onChange={(event) => setEnabled((current) => ({ ...current, [key]: event.target.checked }))}
        />
        <span className="truncate">{label}</span>
      </label>
      <div className="min-w-0">{control}</div>
    </div>
  );

  const select = (key: TFieldKey, options: { value: string; i18nKey: string }[], label: string) => (
    <select
      aria-label={label}
      disabled={!enabled[key]}
      value={(values[key] as string | undefined) ?? ""}
      onChange={(event) => set(key, event.target.value)}
      className={INPUT}
    >
      <option value="">—</option>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {t(option.i18nKey)}
        </option>
      ))}
    </select>
  );

  const yesNo = (key: "es_editorial" | "es_notariado", label: string) => (
    <select
      aria-label={label}
      disabled={!enabled[key]}
      value={values[key] === true ? "yes" : "no"}
      onChange={(event) => set(key, event.target.value === "yes")}
      className={INPUT}
    >
      <option value="yes">{t("file_library.contracts.yes")}</option>
      <option value="no">{t("file_library.contracts.no")}</option>
    </select>
  );

  const text = (key: TFieldKey, label: string, type: "text" | "date" = "text") => (
    <input
      type={type}
      aria-label={label}
      disabled={!enabled[key]}
      value={(values[key] as string | undefined) ?? ""}
      onChange={(event) => set(key, event.target.value)}
      className={INPUT}
    />
  );

  const label = (key: string) => t(`file_library.contracts.fields.${key}`);

  return (
    <ModalCore
      isOpen={isOpen}
      handleClose={() => !isSubmitting && onClose()}
      position={EModalPosition.CENTER}
      width={EModalWidth.LG}
    >
      <div className="p-4">
        <div className="flex items-center gap-2">
          <PencilLine className="size-4 text-accent-primary" />
          <h3 className="text-14 font-medium">
            {t("file_library.contracts.bulk_edit.title", { count: contractIds.length })}
          </h3>
        </div>
        <p className="mt-1 text-12 text-tertiary">{t("file_library.contracts.bulk_edit.description")}</p>
        <div className="mt-3 divide-y divide-subtle">
          {row(
            "tipo_contrato",
            label("tipo_contrato"),
            select("tipo_contrato", CONTRACT_TYPE_OPTIONS, label("tipo_contrato"))
          )}
          {row(
            "estatus_contrato",
            label("estatus_contrato"),
            select("estatus_contrato", CONTRACT_STATUS_OPTIONS, label("estatus_contrato"))
          )}
          {row("es_editorial", label("es_editorial"), yesNo("es_editorial", label("es_editorial")))}
          {row("es_notariado", label("es_notariado"), yesNo("es_notariado", label("es_notariado")))}
          {row("artistas", label("artistas"), text("artistas", label("artistas")))}
          {row("nombre_grupo", label("nombre_grupo"), text("nombre_grupo", label("nombre_grupo")))}
          {row("fecha_inicio", label("fecha_inicio"), text("fecha_inicio", label("fecha_inicio"), "date"))}
          {row("fecha_fin", label("fecha_fin"), text("fecha_fin", label("fecha_fin"), "date"))}
        </div>
        <div className="mt-4 flex items-center justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={isSubmitting}>
            {t("cancel")}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void handleSubmit()}
            disabled={isSubmitting || fields.length === 0}
          >
            {isSubmitting ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              t("file_library.contracts.bulk_edit.apply", { count: fields.length })
            )}
          </Button>
        </div>
      </div>
    </ModalCore>
  );
}
