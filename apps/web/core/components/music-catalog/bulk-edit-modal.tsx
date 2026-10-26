/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * "Editar en lote": change one or more fields of every selected song at
 * once — e.g. set the aggregator of songs imported without it. Companies,
 * genres, people, releases and texts are picked with the import's fixed-value
 * editor, so an existing look-alike ("VirginAgregadora") is offered before a
 * new twin gets created. A review step lists every change before it runs;
 * the server applies all of them in one transaction.
 */

import { useEffect, useState } from "react";
import { ArrowLeft, Pencil, Plus, X } from "lucide-react";
import { useSWRConfig } from "swr";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TMusicBulkChange, TMusicBulkUpdateResult, TMusicCatalogOptions } from "@plane/types";
import { EModalPosition, EModalWidth, ModalCore } from "@plane/ui";
import { cn } from "@plane/utils";
import { musicService } from "@/services/music.service";
import { creditRoleLabel, creditRoleOptions } from "./credit-roles";
import { ImportFixedValueEditor } from "./import/fixed-value-editor";
import { SearchableSelect } from "./searchable-select";
import { getApiError } from "./shared";

type TKind = "company" | "names" | "credit" | "choice" | "date" | "bool" | "text" | "longtext" | "percent";
type TOp = "add" | "replace" | "remove" | "clear" | "set";

type TFieldDef = {
  field: TMusicBulkChange["field"];
  kind: TKind;
  /** The import field whose existing values (and look-alikes) the picker shows */
  importField?: string;
};

const FIELDS: TFieldDef[] = [
  { field: "aggregator", kind: "company", importField: "aggregator" },
  { field: "distributor", kind: "company", importField: "distributor" },
  { field: "record_label", kind: "company", importField: "record_label" },
  { field: "publisher", kind: "company", importField: "publishers" },
  { field: "credit", kind: "credit", importField: "artists" },
  { field: "genres", kind: "names", importField: "genres" },
  { field: "release", kind: "names", importField: "release.title" },
  { field: "status", kind: "choice" },
  { field: "kind", kind: "choice" },
  { field: "release_date", kind: "date" },
  { field: "original_release_date", kind: "date" },
  { field: "language", kind: "text", importField: "track.language" },
  { field: "explicit", kind: "bool" },
  { field: "instrumental", kind: "bool" },
  { field: "p_line", kind: "text", importField: "track.p_line" },
  { field: "c_line", kind: "text", importField: "track.c_line" },
  { field: "ownership", kind: "longtext" },
  { field: "us_publishing_obligations", kind: "longtext" },
  { field: "recoupment", kind: "longtext" },
  { field: "aggregator_percentage", kind: "percent" },
  { field: "distributor_percentage", kind: "percent" },
  { field: "record_label_percentage", kind: "percent" },
  { field: "artist_percentage", kind: "percent" },
  { field: "writer_percentage", kind: "percent" },
];

const OPS: Record<TKind, TOp[]> = {
  company: ["add", "replace", "remove", "clear"],
  names: ["add", "replace", "remove", "clear"],
  credit: ["add", "replace", "remove", "clear"],
  choice: ["set"],
  bool: ["set"],
  date: ["set", "clear"],
  text: ["set", "clear"],
  longtext: ["set", "clear"],
  percent: ["set", "clear"],
};

/** Relation fields can repeat (two roles, two companies); plain fields can't */
const REPEATABLE = new Set<TKind>(["company", "names", "credit"]);

type TRow = {
  id: string;
  def: TFieldDef;
  op: TOp;
  /** Names (relations, credit people) */
  names: string[];
  /** Plain value (choice, date, text, bool, percent) */
  value: string;
  /** Credit role key */
  role: string;
};

const SELECT =
  "h-7 rounded-sm border border-subtle bg-transparent px-1.5 text-12 text-primary outline-none hover:bg-layer-1-hover focus:border-accent-strong";
const INPUT =
  "w-full rounded-sm border border-subtle bg-transparent px-2 py-1 text-12 text-primary outline-none focus:border-accent-strong";

let rowSeq = 0;
const newRow = (def: TFieldDef): TRow => ({
  id: `row-${(rowSeq += 1)}`,
  def,
  op: OPS[def.kind][0],
  names: [],
  value: def.kind === "bool" ? "true" : "",
  role: def.kind === "credit" ? "PRIMARY_ARTIST" : "",
});

const needsNames = (row: TRow) => row.op !== "clear" && ["company", "names", "credit"].includes(row.def.kind);

const isComplete = (row: TRow) => {
  if (row.def.kind === "credit" && row.op !== "remove" && !row.role) return false;
  if (needsNames(row)) return row.names.length > 0;
  if (row.op === "clear") return true;
  if (row.def.kind === "percent") {
    const number = Number(row.value);
    return row.value.trim() !== "" && Number.isFinite(number) && number >= 0 && number <= 100;
  }
  return row.value.trim() !== "";
};

const toChange = (row: TRow): TMusicBulkChange => {
  const { field, kind } = row.def;
  if (kind === "credit")
    return {
      field: "credit",
      op: row.op as "add",
      value: { role: row.role || undefined, names: row.op === "clear" ? [] : row.names },
    };
  if (kind === "company" || kind === "names")
    return { field, op: row.op, value: row.op === "clear" ? [] : row.names } as TMusicBulkChange;
  if (row.op === "clear") return { field, op: "clear" } as TMusicBulkChange;
  const value = kind === "bool" ? row.value === "true" : row.value.trim();
  return { field, op: "set", value } as TMusicBulkChange;
};

type ModalProps = {
  workspaceSlug: string;
  isOpen: boolean;
  trackIds: string[];
  options?: TMusicCatalogOptions;
  onClose: () => void;
  onDone: (result: TMusicBulkUpdateResult) => void;
};

export function MusicBulkEditModal({ workspaceSlug, isOpen, trackIds, options, onClose, onDone }: ModalProps) {
  const { t } = useTranslation();
  const { mutate } = useSWRConfig();
  const [rows, setRows] = useState<TRow[]>([]);
  const [pickerRowId, setPickerRowId] = useState<string | null>(null);
  const [step, setStep] = useState<"edit" | "review">("edit");
  const [isSaving, setIsSaving] = useState(false);
  const [errors, setErrors] = useState<Record<number, string>>({});
  const count = trackIds.length;

  useEffect(() => {
    if (isOpen) return;
    setRows([]);
    setPickerRowId(null);
    setStep("edit");
    setErrors({});
  }, [isOpen]);

  const roles = options?.credit_role_details ?? [];
  const fieldLabel = (def: TFieldDef) => t(`music_catalog.bulk_edit.fields.${def.field}`);
  const opLabel = (op: TOp) => t(`music_catalog.bulk_edit.ops.${op}`);
  const used = new Set(rows.filter((row) => !REPEATABLE.has(row.def.kind)).map((row) => row.def.field));
  const canReview = rows.length > 0 && rows.every(isComplete);

  const update = (id: string, patch: Partial<TRow>) =>
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  const addRow = (field: string) => {
    const def = FIELDS.find((item) => item.field === field);
    if (!def) return;
    const row = newRow(def);
    setRows((current) => [...current, row]);
    if (def.importField && def.kind !== "text") setPickerRowId(row.id);
  };
  const removeRow = (id: string) => setRows((current) => current.filter((row) => row.id !== id));

  const createRole = async (label: string) => {
    try {
      const role = await musicService.createCreditRole(workspaceSlug, label);
      await mutate(`MUSIC_OPTIONS_${workspaceSlug}`);
      return role.key;
    } catch (error) {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: t("music_catalog.credits.role_create_failed"),
        message: getApiError(error),
      });
      return undefined;
    }
  };

  const choiceOptions = (def: TFieldDef) =>
    (def.field === "status" ? options?.track_statuses : options?.track_kinds) ?? [];

  const valueText = (row: TRow) => {
    const { kind } = row.def;
    if (row.op === "clear") return "";
    if (kind === "credit")
      return `${row.names.map((name) => `«${name}»`).join(", ")}${row.role ? ` · ${creditRoleLabel(roles, row.role)}` : ""}`;
    if (kind === "company" || kind === "names") return row.names.map((name) => `«${name}»`).join(", ");
    if (kind === "bool") return t(row.value === "true" ? "music_catalog.bulk_edit.yes" : "music_catalog.bulk_edit.no");
    if (kind === "choice") return choiceOptions(row.def).find(([value]) => value === row.value)?.[1] ?? row.value;
    if (kind === "percent") return `${row.value} %`;
    return `«${row.value.length > 60 ? `${row.value.slice(0, 60)}…` : row.value}»`;
  };

  const apply = async () => {
    setIsSaving(true);
    setErrors({});
    try {
      const result = await musicService.bulkUpdateTracks(workspaceSlug, trackIds, rows.map(toChange));
      onDone(result);
      onClose();
    } catch (error) {
      const failure = error as { errors?: { index: number | null; error: string }[] } | undefined;
      const byRow: Record<number, string> = {};
      (failure?.errors ?? []).forEach((item) => {
        if (typeof item.index === "number") byRow[item.index] = item.error;
      });
      setErrors(byRow);
      setStep("edit");
      setToast({ type: TOAST_TYPE.ERROR, title: t("music_catalog.bulk_edit.failed"), message: getApiError(error) });
    } finally {
      setIsSaving(false);
    }
  };

  const namesEditor = (row: TRow) => (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1">
        {row.names.map((name) => (
          <span
            key={name}
            className="inline-flex items-center gap-1 rounded-sm border border-subtle bg-layer-1 px-1.5 py-0.5 text-12"
          >
            {name}
            <button
              type="button"
              aria-label={t("music_catalog.bulk_edit.remove_value", { value: name })}
              onClick={() => update(row.id, { names: row.names.filter((item) => item !== name) })}
              className="text-tertiary hover:text-primary"
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        {pickerRowId !== row.id && (
          <button
            type="button"
            onClick={() => setPickerRowId(row.id)}
            className="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-12 text-accent-primary hover:bg-layer-1-hover"
          >
            <Plus className="size-3" />
            {t(row.names.length ? "music_catalog.bulk_edit.add_another" : "music_catalog.bulk_edit.choose")}
          </button>
        )}
      </div>
      {pickerRowId === row.id && row.def.importField && (
        <ImportFixedValueEditor
          workspaceSlug={workspaceSlug}
          field={row.def.importField}
          label={t("music_catalog.bulk_edit.value_label")}
          chosen={row.names}
          onPick={(value) => {
            if (!row.names.some((item) => item.toLowerCase() === value.toLowerCase()))
              update(row.id, { names: [...row.names, value] });
          }}
          onClose={() => setPickerRowId(null)}
        />
      )}
    </div>
  );

  const valueEditor = (row: TRow) => {
    const { kind } = row.def;
    if (row.op === "clear") return <p className="text-12 text-tertiary">{t("music_catalog.bulk_edit.clear_hint")}</p>;
    if (kind === "company" || kind === "names") return namesEditor(row);
    if (kind === "credit")
      return (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="shrink-0 text-11 text-tertiary">{t("music_catalog.bulk_edit.role")}</span>
            <SearchableSelect
              className="w-52"
              options={[
                ...(row.op === "remove" ? [{ value: "", label: t("music_catalog.bulk_edit.any_role") }] : []),
                ...creditRoleOptions(t, roles),
              ]}
              value={row.role}
              onSelect={(role) => update(row.id, { role })}
              onCreate={(label) =>
                void createRole(label).then((role) => {
                  if (role) update(row.id, { role });
                  return undefined;
                })
              }
              placeholder={t("music_catalog.credits.role_placeholder")}
            />
          </div>
          {namesEditor(row)}
        </div>
      );
    if (kind === "choice")
      return (
        <select
          value={row.value}
          onChange={(event) => update(row.id, { value: event.target.value })}
          className={cn(SELECT, "min-w-40")}
          aria-label={fieldLabel(row.def)}
        >
          <option value="">{t("music_catalog.bulk_edit.choose")}</option>
          {choiceOptions(row.def).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      );
    if (kind === "bool")
      return (
        <select
          value={row.value}
          onChange={(event) => update(row.id, { value: event.target.value })}
          className={SELECT}
          aria-label={fieldLabel(row.def)}
        >
          <option value="true">{t("music_catalog.bulk_edit.yes")}</option>
          <option value="false">{t("music_catalog.bulk_edit.no")}</option>
        </select>
      );
    if (kind === "date")
      return (
        <input
          type="date"
          value={row.value}
          onChange={(event) => update(row.id, { value: event.target.value })}
          className={cn(INPUT, "w-44")}
          aria-label={fieldLabel(row.def)}
        />
      );
    if (kind === "percent")
      return (
        <div className="flex items-center gap-1">
          <input
            type="number"
            min="0"
            max="100"
            step="0.01"
            value={row.value}
            onChange={(event) => update(row.id, { value: event.target.value })}
            className={cn(INPUT, "w-24 text-right")}
            aria-label={fieldLabel(row.def)}
          />
          <span className="text-12 text-tertiary">%</span>
        </div>
      );
    if (kind === "longtext")
      return (
        <textarea
          value={row.value}
          onChange={(event) => update(row.id, { value: event.target.value })}
          className={cn(INPUT, "min-h-16")}
          aria-label={fieldLabel(row.def)}
        />
      );
    // Short text with the catalog's existing values one click away
    return (
      <div className="space-y-1.5">
        <div className="flex items-center gap-1.5">
          <input
            value={row.value}
            onChange={(event) => update(row.id, { value: event.target.value })}
            className={INPUT}
            aria-label={fieldLabel(row.def)}
          />
          {row.def.importField && pickerRowId !== row.id && (
            <button
              type="button"
              onClick={() => setPickerRowId(row.id)}
              className="shrink-0 rounded-sm px-1.5 py-1 text-11 text-accent-primary hover:bg-layer-1-hover"
            >
              {t("music_catalog.bulk_edit.existing_values")}
            </button>
          )}
        </div>
        {pickerRowId === row.id && row.def.importField && (
          <ImportFixedValueEditor
            workspaceSlug={workspaceSlug}
            field={row.def.importField}
            label={t("music_catalog.bulk_edit.value_label")}
            chosen={row.value ? [row.value] : []}
            onPick={(value) => {
              update(row.id, { value });
              setPickerRowId(null);
            }}
            onClose={() => setPickerRowId(null)}
          />
        )}
      </div>
    );
  };

  return (
    <ModalCore
      isOpen={isOpen}
      handleClose={() => !isSaving && onClose()}
      position={EModalPosition.TOP}
      width={EModalWidth.XXL}
    >
      <div className="flex max-h-[80vh] flex-col">
        <div className="border-b border-subtle px-4 py-3">
          <h3 className="text-14 font-medium text-primary">{t("music_catalog.bulk_edit.title")}</h3>
          <p className="mt-0.5 text-12 text-tertiary">{t("music_catalog.bulk_edit.subtitle", { count })}</p>
        </div>

        {step === "edit" ? (
          <div className="min-h-40 flex-1 space-y-2 overflow-y-auto p-4">
            {rows.length === 0 && <p className="text-12 text-tertiary">{t("music_catalog.bulk_edit.empty")}</p>}
            {rows.map((row, index) => (
              <div key={row.id} className="rounded-md border border-subtle p-2.5">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-13 font-medium text-primary">
                    {fieldLabel(row.def)}
                  </span>
                  {OPS[row.def.kind].length > 1 && (
                    <select
                      value={row.op}
                      onChange={(event) => update(row.id, { op: event.target.value as TOp })}
                      className={SELECT}
                      aria-label={t("music_catalog.bulk_edit.op_label")}
                    >
                      {OPS[row.def.kind].map((op) => (
                        <option key={op} value={op}>
                          {opLabel(op)}
                        </option>
                      ))}
                    </select>
                  )}
                  <button
                    type="button"
                    onClick={() => removeRow(row.id)}
                    aria-label={t("music_catalog.bulk_edit.remove_field")}
                    className="rounded-sm p-1 text-tertiary hover:bg-layer-1-hover hover:text-primary"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
                {(row.op === "replace" || row.op === "remove") && (
                  <p className="mt-1 text-11 text-tertiary">
                    {t(`music_catalog.bulk_edit.op_hints.${row.def.kind === "credit" ? "credit_" : ""}${row.op}`)}
                  </p>
                )}
                <div className="mt-2">{valueEditor(row)}</div>
                {errors[index] && <p className="mt-1.5 text-11 text-danger-primary">{errors[index]}</p>}
              </div>
            ))}
            <select
              value=""
              onChange={(event) => {
                // Let go of the select so typing lands in the new row's value picker
                event.currentTarget.blur();
                addRow(event.target.value);
              }}
              className={cn(SELECT, "w-full text-accent-primary")}
              aria-label={t("music_catalog.bulk_edit.add_field")}
            >
              <option value="">{t("music_catalog.bulk_edit.add_field")}</option>
              {FIELDS.map((def) => (
                <option key={def.field} value={def.field} disabled={used.has(def.field)}>
                  {fieldLabel(def)}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <div className="min-h-40 flex-1 overflow-y-auto p-4">
            <p className="text-13 font-medium text-primary">{t("music_catalog.bulk_edit.review_title", { count })}</p>
            <ul className="mt-2 divide-y divide-subtle rounded-md border border-subtle">
              {rows.map((row) => (
                <li key={row.id} className="px-3 py-2 text-12">
                  <span className="font-medium text-primary">{fieldLabel(row.def)}</span>
                  <span className="text-secondary">
                    {" · "}
                    {opLabel(row.op)} {valueText(row)}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-11 text-tertiary">{t("music_catalog.bulk_edit.review_hint")}</p>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t border-subtle px-4 py-3">
          {step === "review" && (
            <Button variant="secondary" size="sm" onClick={() => setStep("edit")} disabled={isSaving}>
              <ArrowLeft className="size-3.5" />
              {t("music_catalog.bulk_edit.back")}
            </Button>
          )}
          <span className="ml-auto flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={onClose} disabled={isSaving}>
              {t("cancel")}
            </Button>
            {step === "edit" ? (
              <Button variant="primary" size="sm" onClick={() => setStep("review")} disabled={!canReview}>
                {t("music_catalog.bulk_edit.review", { count })}
              </Button>
            ) : (
              <Button variant="primary" size="sm" onClick={() => void apply()} loading={isSaving}>
                {t("music_catalog.bulk_edit.apply", { count })}
              </Button>
            )}
          </span>
        </div>
      </div>
    </ModalCore>
  );
}

type ActionProps = {
  workspaceSlug: string;
  trackIds: string[];
  options?: TMusicCatalogOptions;
  disabled?: boolean;
  triggerClassName?: string;
  labelClassName?: string;
  /** After applying: refresh the list and the resources it shows */
  onDone: () => void;
};

/** Selection toolbar button + modal */
export function MusicBulkEditAction({
  workspaceSlug,
  trackIds,
  options,
  disabled,
  triggerClassName,
  labelClassName,
  onDone,
}: ActionProps) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);

  const finished = (result: TMusicBulkUpdateResult) => {
    const created = Object.values(result.created ?? {}).flat();
    setToast({
      type: TOAST_TYPE.SUCCESS,
      title: t("music_catalog.bulk_edit.done", { count: result.updated }),
      message:
        [
          result.unchanged ? t("music_catalog.bulk_edit.done_unchanged", { count: result.unchanged }) : "",
          result.skipped ? t("music_catalog.bulk_edit.done_skipped", { count: result.skipped }) : "",
          created.length ? t("music_catalog.bulk_edit.done_created", { names: created.join(", ") }) : "",
        ]
          .filter(Boolean)
          .join(" ") || undefined,
    });
    onDone();
  };

  return (
    <>
      <button
        type="button"
        disabled={disabled || trackIds.length === 0}
        onClick={() => setIsOpen(true)}
        className={triggerClassName}
        aria-label={t("music_catalog.bulk_edit.action")}
        title={t("music_catalog.bulk_edit.action")}
      >
        <Pencil className="size-3.5" />
        <span className={labelClassName}>{t("music_catalog.bulk_edit.action")}</span>
      </button>
      <MusicBulkEditModal
        workspaceSlug={workspaceSlug}
        isOpen={isOpen}
        trackIds={trackIds}
        options={options}
        onClose={() => setIsOpen(false)}
        onDone={finished}
      />
    </>
  );
}
