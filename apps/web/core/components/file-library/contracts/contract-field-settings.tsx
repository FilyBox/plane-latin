/**
 * Community-compatible field settings modelled after Documenso's editor forms.
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Plus, Trash2 } from "lucide-react";
import { useTranslation } from "@plane/i18n";
import type { TContractAuthoringField, TContractFieldChoice, TContractFieldMeta } from "@plane/types";
import { ContractField, ContractSelect } from "./ui";

type Props = {
  field: TContractAuthoringField;
  onChange: (meta: TContractFieldMeta) => void;
};

const inputClass =
  "w-full rounded-md border border-subtle bg-surface-1 px-2.5 py-2 text-13 outline-none focus:border-accent-primary";
const labelClass = "space-y-1 text-11 font-medium text-tertiary";

const DEFAULT_META: Record<TContractAuthoringField["type"], TContractFieldMeta> = {
  SIGNATURE: { type: "signature", fontSize: 12, required: true, overflow: "auto" },
  INITIALS: { type: "initials", fontSize: 12, textAlign: "left" },
  NAME: { type: "name", fontSize: 12, textAlign: "left" },
  EMAIL: { type: "email", fontSize: 12, textAlign: "left", overflow: "auto" },
  DATE: { type: "date", fontSize: 12, textAlign: "left", overflow: "auto" },
  TEXT: {
    type: "text",
    fontSize: 12,
    label: "",
    placeholder: "",
    text: "",
    required: false,
    readOnly: false,
    textAlign: "left",
    verticalAlign: "middle",
  },
  NUMBER: {
    type: "number",
    fontSize: 12,
    label: "",
    placeholder: "",
    required: false,
    readOnly: false,
    textAlign: "left",
  },
  RADIO: {
    type: "radio",
    fontSize: 12,
    required: false,
    readOnly: false,
    direction: "vertical",
    values: [{ id: 1, checked: false, value: "" }],
  },
  CHECKBOX: {
    type: "checkbox",
    fontSize: 12,
    required: false,
    readOnly: false,
    direction: "vertical",
    values: [{ id: 1, checked: false, value: "" }],
    validationRule: "",
    validationLength: 0,
  },
  DROPDOWN: {
    type: "dropdown",
    fontSize: 12,
    required: false,
    readOnly: false,
    values: [{ id: 1, value: "" }],
  },
};

export const getDefaultFieldMeta = (type: TContractAuthoringField["type"]): TContractFieldMeta => ({
  ...DEFAULT_META[type],
  values: DEFAULT_META[type].values?.map((value) => ({ ...value })),
});

export function ContractFieldSettings({ field, onChange }: Props) {
  const { t } = useTranslation();
  const meta = { ...getDefaultFieldMeta(field.type), ...field.fieldMeta };
  const update = (patch: Partial<TContractFieldMeta>) => onChange({ ...meta, ...patch });
  const isChoice = field.type === "RADIO" || field.type === "CHECKBOX" || field.type === "DROPDOWN";
  const isTextual = ["INITIALS", "NAME", "EMAIL", "DATE", "TEXT", "NUMBER"].includes(field.type);

  const updateChoice = (index: number, patch: Partial<TContractFieldChoice>) =>
    update({
      values: (meta.values ?? []).map((choice, itemIndex) => (itemIndex === index ? { ...choice, ...patch } : choice)),
    });

  const addChoice = () => {
    const values = meta.values ?? [];
    update({
      values: [
        ...values,
        field.type === "DROPDOWN"
          ? {
              id: Math.max(0, ...values.map((value) => value.id ?? 0)) + 1,
              value: t("file_library.contracts.workflow.field_settings.option_number", {
                number: values.length + 1,
              }),
            }
          : { id: Math.max(0, ...values.map((value) => value.id ?? 0)) + 1, value: "", checked: false },
      ],
    });
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <label className={labelClass}>
          {t("file_library.contracts.workflow.field_settings.font_size")}
          <input
            className={inputClass}
            type="number"
            min={8}
            max={96}
            value={meta.fontSize ?? 12}
            onChange={(event) => update({ fontSize: Number(event.target.value) })}
          />
        </label>
        {isTextual ? (
          <ContractField label={t("file_library.contracts.workflow.field_settings.alignment")}>
            <ContractSelect
              value={meta.textAlign ?? "left"}
              onChange={(textAlign: NonNullable<TContractFieldMeta["textAlign"]>) => update({ textAlign })}
              options={[
                { value: "left", label: t("file_library.contracts.workflow.field_settings.left") },
                { value: "center", label: t("file_library.contracts.workflow.field_settings.center") },
                { value: "right", label: t("file_library.contracts.workflow.field_settings.right") },
              ]}
            />
          </ContractField>
        ) : null}
      </div>

      {["TEXT", "NUMBER", "RADIO", "CHECKBOX"].includes(field.type) ? (
        <label className={labelClass}>
          {t("file_library.contracts.workflow.field_settings.label")}
          <input
            className={inputClass}
            value={meta.label ?? ""}
            onChange={(event) => update({ label: event.target.value })}
          />
        </label>
      ) : null}

      {field.type === "TEXT" || field.type === "NUMBER" ? (
        <label className={labelClass}>
          {t("file_library.contracts.workflow.field_settings.placeholder")}
          <input
            className={inputClass}
            value={meta.placeholder ?? ""}
            onChange={(event) => update({ placeholder: event.target.value })}
          />
        </label>
      ) : null}

      {field.type === "TEXT" ? (
        <>
          <label className={labelClass}>
            {t("file_library.contracts.workflow.field_settings.prefilled_value")}
            <textarea
              className={`${inputClass} min-h-16`}
              value={meta.text ?? ""}
              onChange={(event) => update({ text: event.target.value })}
            />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className={labelClass}>
              {t("file_library.contracts.workflow.field_settings.character_limit")}
              <input
                className={inputClass}
                type="number"
                min={0}
                value={meta.characterLimit ?? 0}
                onChange={(event) => update({ characterLimit: Number(event.target.value) })}
              />
            </label>
            <ContractField label={t("file_library.contracts.workflow.field_settings.vertical_alignment")}>
              <ContractSelect
                value={meta.verticalAlign ?? "middle"}
                onChange={(verticalAlign: NonNullable<TContractFieldMeta["verticalAlign"]>) =>
                  update({ verticalAlign })
                }
                options={[
                  { value: "top", label: t("file_library.contracts.workflow.field_settings.top") },
                  { value: "middle", label: t("file_library.contracts.workflow.field_settings.center") },
                  { value: "bottom", label: t("file_library.contracts.workflow.field_settings.bottom") },
                ]}
              />
            </ContractField>
          </div>
        </>
      ) : null}

      {field.type === "NUMBER" ? (
        <>
          <label className={labelClass}>
            {t("file_library.contracts.workflow.field_settings.number_format")}
            <input
              className={inputClass}
              placeholder={t("file_library.contracts.workflow.field_settings.number_placeholder")}
              value={meta.numberFormat ?? ""}
              onChange={(event) => update({ numberFormat: event.target.value })}
            />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className={labelClass}>
              {t("file_library.contracts.workflow.field_settings.minimum")}
              <input
                className={inputClass}
                type="number"
                value={meta.minValue ?? ""}
                onChange={(event) => update({ minValue: event.target.value ? Number(event.target.value) : null })}
              />
            </label>
            <label className={labelClass}>
              {t("file_library.contracts.workflow.field_settings.maximum")}
              <input
                className={inputClass}
                type="number"
                value={meta.maxValue ?? ""}
                onChange={(event) => update({ maxValue: event.target.value ? Number(event.target.value) : null })}
              />
            </label>
          </div>
        </>
      ) : null}

      {field.type === "RADIO" || field.type === "CHECKBOX" ? (
        <ContractField label={t("file_library.contracts.workflow.field_settings.direction")}>
          <ContractSelect
            value={meta.direction ?? "vertical"}
            onChange={(direction: "vertical" | "horizontal") => update({ direction })}
            options={[
              { value: "vertical", label: t("file_library.contracts.workflow.field_settings.vertical") },
              { value: "horizontal", label: t("file_library.contracts.workflow.field_settings.horizontal") },
            ]}
          />
        </ContractField>
      ) : null}

      {field.type === "CHECKBOX" ? (
        <div className="grid grid-cols-2 gap-2">
          <ContractField label={t("file_library.contracts.workflow.field_settings.validation")}>
            <ContractSelect
              value={meta.validationRule ?? ""}
              onChange={(validationRule) => update({ validationRule })}
              options={[
                { value: "", label: t("file_library.contracts.workflow.field_settings.no_validation") },
                { value: "Select at least", label: t("file_library.contracts.workflow.field_settings.at_least") },
                { value: "Select at most", label: t("file_library.contracts.workflow.field_settings.at_most") },
                { value: "Select exactly", label: t("file_library.contracts.workflow.field_settings.exactly") },
              ]}
            />
          </ContractField>
          <label className={labelClass}>
            {t("file_library.contracts.workflow.field_settings.amount")}
            <input
              className={inputClass}
              type="number"
              min={0}
              value={meta.validationLength ?? 0}
              onChange={(event) => update({ validationLength: Number(event.target.value) })}
            />
          </label>
        </div>
      ) : null}

      {isChoice ? (
        <section className="space-y-2 border-t border-subtle pt-3">
          <div className="flex items-center justify-between">
            <p className="text-13 font-semibold">{t("file_library.contracts.workflow.field_settings.options")}</p>
            <button type="button" className="rounded p-1 hover:bg-layer-1-hover" onClick={addChoice}>
              <Plus className="size-3.5" />
            </button>
          </div>
          {(meta.values ?? []).map((choice, index) => (
            <div key={choice.id ?? choice.value} className="flex items-center gap-2">
              {field.type !== "DROPDOWN" ? (
                <input
                  type={field.type === "RADIO" ? "radio" : "checkbox"}
                  name={`contract-field-default-${field.clientId}`}
                  checked={Boolean(choice.checked)}
                  onChange={(event) => {
                    if (field.type === "RADIO")
                      update({
                        values: (meta.values ?? []).map((item, itemIndex) => ({
                          ...item,
                          checked: itemIndex === index,
                        })),
                      });
                    else updateChoice(index, { checked: event.target.checked });
                  }}
                />
              ) : null}
              <input
                className={inputClass}
                value={choice.value}
                onChange={(event) => updateChoice(index, { value: event.target.value })}
              />
              <button
                type="button"
                disabled={(meta.values?.length ?? 0) <= 1}
                className="rounded p-1 text-danger-primary disabled:opacity-40"
                onClick={() => update({ values: (meta.values ?? []).filter((_, itemIndex) => itemIndex !== index) })}
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))}
          {field.type === "DROPDOWN" ? (
            <ContractField label={t("file_library.contracts.workflow.field_settings.default_option")}>
              <ContractSelect
                value={meta.defaultValue ?? ""}
                onChange={(defaultValue) => update({ defaultValue })}
                options={[
                  { value: "", label: t("file_library.contracts.workflow.field_settings.no_default") },
                  ...(meta.values ?? [])
                    .filter((item) => item.value)
                    .map((item) => ({ value: item.value, label: item.value })),
                ]}
              />
            </ContractField>
          ) : null}
        </section>
      ) : null}

      <div className="grid grid-cols-2 gap-2 border-t border-subtle pt-3">
        <label className="flex items-center gap-2 text-13">
          <input
            type="checkbox"
            checked={Boolean(meta.required)}
            onChange={(event) => update({ required: event.target.checked })}
          />
          {t("file_library.contracts.workflow.field_settings.required")}
        </label>
        <label className="flex items-center gap-2 text-13">
          <input
            type="checkbox"
            checked={Boolean(meta.readOnly)}
            onChange={(event) => update({ readOnly: event.target.checked })}
          />
          {t("file_library.contracts.workflow.field_settings.read_only")}
        </label>
      </div>
    </div>
  );
}
