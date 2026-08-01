/**
 * Community-compatible field settings modelled after Documenso's editor forms.
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Plus, Trash2 } from "lucide-react";
import type { TContractAuthoringField, TContractFieldChoice, TContractFieldMeta } from "@plane/types";

type Props = {
  field: TContractAuthoringField;
  onChange: (meta: TContractFieldMeta) => void;
};

const inputClass =
  "w-full rounded-md border border-subtle bg-surface-1 px-2.5 py-2 text-11 outline-none focus:border-accent-primary";
const labelClass = "space-y-1 text-10 font-medium text-tertiary";

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
    values: [{ id: 1, value: "Opción 1" }],
  },
};

export const getDefaultFieldMeta = (type: TContractAuthoringField["type"]): TContractFieldMeta => ({
  ...DEFAULT_META[type],
  values: DEFAULT_META[type].values?.map((value) => ({ ...value })),
});

export function ContractFieldSettings({ field, onChange }: Props) {
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
              value: `Opción ${values.length + 1}`,
            }
          : { id: Math.max(0, ...values.map((value) => value.id ?? 0)) + 1, value: "", checked: false },
      ],
    });
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <label className={labelClass}>
          Tamaño de fuente
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
          <label className={labelClass}>
            Alineación
            <select
              className={inputClass}
              value={meta.textAlign ?? "left"}
              onChange={(event) => update({ textAlign: event.target.value as TContractFieldMeta["textAlign"] })}
            >
              <option value="left">Izquierda</option>
              <option value="center">Centro</option>
              <option value="right">Derecha</option>
            </select>
          </label>
        ) : null}
      </div>

      {["TEXT", "NUMBER", "RADIO", "CHECKBOX"].includes(field.type) ? (
        <label className={labelClass}>
          Etiqueta
          <input
            className={inputClass}
            value={meta.label ?? ""}
            onChange={(event) => update({ label: event.target.value })}
          />
        </label>
      ) : null}

      {field.type === "TEXT" || field.type === "NUMBER" ? (
        <label className={labelClass}>
          Placeholder
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
            Valor prellenado
            <textarea
              className={`${inputClass} min-h-16`}
              value={meta.text ?? ""}
              onChange={(event) => update({ text: event.target.value })}
            />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className={labelClass}>
              Límite de caracteres
              <input
                className={inputClass}
                type="number"
                min={0}
                value={meta.characterLimit ?? 0}
                onChange={(event) => update({ characterLimit: Number(event.target.value) })}
              />
            </label>
            <label className={labelClass}>
              Alineación vertical
              <select
                className={inputClass}
                value={meta.verticalAlign ?? "middle"}
                onChange={(event) =>
                  update({ verticalAlign: event.target.value as TContractFieldMeta["verticalAlign"] })
                }
              >
                <option value="top">Arriba</option>
                <option value="middle">Centro</option>
                <option value="bottom">Abajo</option>
              </select>
            </label>
          </div>
        </>
      ) : null}

      {field.type === "NUMBER" ? (
        <>
          <label className={labelClass}>
            Formato numérico
            <input
              className={inputClass}
              placeholder="Ej. 0,0.00"
              value={meta.numberFormat ?? ""}
              onChange={(event) => update({ numberFormat: event.target.value })}
            />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className={labelClass}>
              Mínimo
              <input
                className={inputClass}
                type="number"
                value={meta.minValue ?? ""}
                onChange={(event) => update({ minValue: event.target.value ? Number(event.target.value) : null })}
              />
            </label>
            <label className={labelClass}>
              Máximo
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
        <label className={labelClass}>
          Dirección
          <select
            className={inputClass}
            value={meta.direction ?? "vertical"}
            onChange={(event) => update({ direction: event.target.value as "vertical" | "horizontal" })}
          >
            <option value="vertical">Vertical</option>
            <option value="horizontal">Horizontal</option>
          </select>
        </label>
      ) : null}

      {field.type === "CHECKBOX" ? (
        <div className="grid grid-cols-2 gap-2">
          <label className={labelClass}>
            Validación
            <select
              className={inputClass}
              value={meta.validationRule ?? ""}
              onChange={(event) => update({ validationRule: event.target.value })}
            >
              <option value="">Sin validación</option>
              <option value="Select at least">Seleccionar al menos</option>
              <option value="Select at most">Seleccionar como máximo</option>
              <option value="Select exactly">Seleccionar exactamente</option>
            </select>
          </label>
          <label className={labelClass}>
            Cantidad
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
            <p className="text-11 font-semibold">Opciones</p>
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
            <label className={labelClass}>
              Opción predeterminada
              <select
                className={inputClass}
                value={meta.defaultValue ?? ""}
                onChange={(event) => update({ defaultValue: event.target.value })}
              >
                <option value="">Sin valor predeterminado</option>
                {(meta.values ?? [])
                  .filter((item) => item.value)
                  .map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.value}
                    </option>
                  ))}
              </select>
            </label>
          ) : null}
        </section>
      ) : null}

      <div className="grid grid-cols-2 gap-2 border-t border-subtle pt-3">
        <label className="flex items-center gap-2 text-11">
          <input
            type="checkbox"
            checked={Boolean(meta.required)}
            onChange={(event) => update({ required: event.target.checked })}
          />
          Obligatorio
        </label>
        <label className="flex items-center gap-2 text-11">
          <input
            type="checkbox"
            checked={Boolean(meta.readOnly)}
            onChange={(event) => update({ readOnly: event.target.checked })}
          />
          Solo lectura
        </label>
      </div>
    </div>
  );
}
