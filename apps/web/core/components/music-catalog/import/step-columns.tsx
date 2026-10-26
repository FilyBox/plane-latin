/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useMemo, useState } from "react";
import { AlertCircle, ChevronDown, Pin, RotateCcw, Search, WandSparkles, X } from "lucide-react";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TMusicCompany } from "@plane/types";
import { cn } from "@plane/utils";
import { SearchableSelect } from "../searchable-select";
import { columnsOf, ESSENTIAL_FIELDS, fieldLabelKey, REQUIRED_FIELD } from "./constants";
import { AI_PANEL_ID, ImportAiPanel } from "./ai-map-panel";
import { ImportFixedValueEditor } from "./fixed-value-editor";
import type { TImportFlow } from "./use-import-flow";

type Props = {
  flow: TImportFlow;
  importFields: string[];
  workspaceSlug: string;
  /** To tell which field each company added in Rules belongs to */
  companies?: TMusicCompany[];
};

/** The field a credit added in Rules → "Add to every row" feeds, by role */
const DEFAULT_ROLE_FIELDS: Record<string, string> = {
  PRIMARY_ARTIST: "artists",
  FEATURED_ARTIST: "featured_artists",
  WRITER: "writers",
  AUTHOR: "authors",
  COMPOSER: "composers",
  PRODUCER: "producers",
  RECORDING_ENGINEER: "recording_engineers",
  MIXER: "mixers",
  MASTERING_ENGINEER: "mastering_engineers",
  LEGAL_REPRESENTATIVE: "legal_representatives",
};
/** Provenance chip of a field row: label and tooltip keys */
const SOURCE_CHIPS = {
  auto: ["music_import.columns.source_auto", "music_import.columns.source_auto_hint"],
  manual: ["music_import.columns.source_manual", "music_import.columns.source_manual_hint"],
  ai: ["music_import.columns.source_ai", "music_import.columns.source_ai_hint"],
  fixed: ["music_import.columns.source_fixed", "music_import.columns.source_fixed_hint"],
} as const;

const COMPANY_KIND_FIELDS: Record<string, string> = {
  AGGREGATOR: "aggregator",
  DISTRIBUTOR: "distributor",
  RECORD_LABEL: "record_label",
  PUBLISHER: "publishers",
};

const valuesOf = (value: string | string[] | undefined): string[] =>
  !value ? [] : Array.isArray(value) ? value.filter(Boolean) : [value];

export function ImportStepColumns({ flow, importFields, workspaceSlug, companies = [] }: Props) {
  const { t } = useTranslation();
  const { preview, mapping, constants, defaults } = flow;
  // What Rules → "Add to every row" adds per field, shown on the field's row
  const inRules = useMemo(() => {
    const counts: Record<string, number> = {};
    const add = (field: string | undefined) => {
      if (field) counts[field] = (counts[field] ?? 0) + 1;
    };
    for (const credit of defaults.credits) add(DEFAULT_ROLE_FIELDS[credit.role] ?? "contributors");
    for (const id of defaults.companyIds)
      add(COMPANY_KIND_FIELDS[companies.find((company) => company.id === id)?.kind ?? ""]);
    if (defaults.genreIds.length) counts.genres = defaults.genreIds.length;
    if (defaults.releaseIds.length) counts["release.title"] = defaults.releaseIds.length;
    return counts;
  }, [companies, defaults]);
  const [query, setQuery] = useState("");
  const [showMore, setShowMore] = useState(false);
  // The field whose fixed-value picker is open
  const [editingFixed, setEditingFixed] = useState<string>();
  const multiFields = useMemo(() => new Set(preview?.multi_fields ?? []), [preview?.multi_fields]);
  const samples = useMemo(() => preview?.column_samples ?? {}, [preview?.column_samples]);
  const dates = preview?.date_interpretations ?? {};

  const columnOptions = useMemo(
    () =>
      (preview?.headers ?? []).map((header) => {
        const sample = samples[header];
        const example = sample?.examples[0];
        return {
          value: header,
          label: header,
          hint: !sample
            ? undefined
            : sample.non_empty === 0
              ? t("music_import.columns.empty_column")
              : `${t("music_import.columns.column_hint", { count: sample.non_empty })}${
                  example ? ` · ${example.length > 36 ? `${example.slice(0, 36)}…` : example}` : ""
                }`,
        };
      }),
    [preview?.headers, samples, t]
  );

  const label = (field: string) => t(fieldLabelKey(field));
  const assigned = importFields.filter(
    (field) => columnsOf(mapping[field]).length > 0 || valuesOf(constants[field]).length > 0
  );
  const essentials = ESSENTIAL_FIELDS.filter((field) => importFields.includes(field) && !assigned.includes(field));
  const more = importFields.filter((field) => !assigned.includes(field) && !ESSENTIAL_FIELDS.includes(field));
  const usedColumns = new Set(Object.values(mapping).flatMap((value) => columnsOf(value)));
  const unusedColumns = (preview?.headers ?? []).filter(
    (header) => !usedColumns.has(header) && (samples[header]?.non_empty ?? 1) > 0
  );

  const normalized = query.trim().toLowerCase();
  const matches = (field: string) =>
    !normalized || label(field).toLowerCase().includes(normalized) || field.toLowerCase().includes(normalized);

  const sampleText = (columns: string[]) => {
    const examples = columns.flatMap((column) => samples[column]?.examples.slice(0, 3) ?? []).slice(0, 3);
    return examples.map((example) => (example.length > 28 ? `${example.slice(0, 28)}…` : example)).join(" · ");
  };

  const renderField = (field: string) => {
    const selected = columnsOf(mapping[field]);
    const isMulti = multiFields.has(field);
    const isRequired = field === REQUIRED_FIELD;
    const example = sampleText(selected);
    const dateReading = selected[0] ? dates[selected[0]] : undefined;
    const fixed = valuesOf(constants[field]);
    const source = selected.length > 0 ? flow.fieldSources[field] : fixed.length > 0 ? "fixed" : undefined;
    // What an AI suggestion replaced, to go back to it in one click
    const replaced = source === "ai" ? flow.aiHistory?.[field] : undefined;
    const fixedText = (value: string) =>
      field === "track.explicit"
        ? t(value === "true" ? "music_import.columns.fixed_true" : "music_import.columns.fixed_false")
        : value;
    return (
      <li
        key={field}
        className={cn(
          "grid gap-x-4 gap-y-1.5 px-4 py-2.5 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]",
          isRequired && selected.length === 0 && "bg-warning-subtle/40"
        )}
      >
        <div className="min-w-0 pt-1">
          <p className="text-13 text-primary">
            {label(field)}
            {isRequired && (
              <span className="ml-1.5 text-11 text-warning-primary">{t("music_import.columns.required")}</span>
            )}
            {source && (
              <span
                className={cn(
                  "ml-1.5 rounded-sm px-1 py-px text-10",
                  source === "ai" ? "bg-accent-primary/10 text-accent-primary" : "bg-layer-1 text-tertiary"
                )}
                title={t(SOURCE_CHIPS[source][1])}
              >
                {t(SOURCE_CHIPS[source][0])}
              </span>
            )}
            {inRules[field] > 0 && (
              <span className="ml-1.5 text-11 text-secondary" title={t("music_import.columns.in_rules_hint")}>
                {t("music_import.columns.in_rules", { count: inRules[field] })}
              </span>
            )}
          </p>
          {isMulti && <p className="text-11 text-tertiary">{t("music_import.columns.multi_hint")}</p>}
        </div>
        <div className="min-w-0">
          {isMulti ? (
            <div className="flex max-w-sm flex-wrap items-center gap-1.5">
              {selected.map((column) => (
                <span
                  key={column}
                  className="flex max-w-full items-center gap-1 rounded-md border border-subtle bg-layer-1 py-0.5 pr-1 pl-2 text-12"
                >
                  <span className="truncate">{column}</span>
                  <button
                    type="button"
                    aria-label={t("music_import.columns.remove_column", { column })}
                    onClick={() =>
                      flow.setFieldColumns(
                        field,
                        selected.filter((item) => item !== column),
                        true
                      )
                    }
                    className="rounded-sm p-0.5 text-tertiary hover:bg-layer-1-hover hover:text-primary"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
              <SearchableSelect
                className="min-w-40 flex-1"
                options={columnOptions.filter((option) => !selected.includes(option.value))}
                value=""
                onSelect={(column) => column && flow.setFieldColumns(field, [...selected, column], true)}
                placeholder={t("music_import.columns.add_column")}
              />
            </div>
          ) : (
            <SearchableSelect
              className="w-full max-w-sm"
              options={[{ value: "", label: t("music_import.columns.not_imported") }, ...columnOptions]}
              value={selected[0] ?? ""}
              onSelect={(column) => flow.setFieldColumns(field, column ? [column] : [], false)}
              placeholder={t("music_import.columns.pick_column")}
            />
          )}
          {replaced && replaced.columns.length > 0 && (
            <button
              type="button"
              onClick={() => flow.revertAiField(field)}
              className="mt-1 flex max-w-sm items-center gap-1 text-11 text-secondary hover:text-primary"
            >
              <RotateCcw className="size-3 shrink-0" aria-hidden />
              <span className="truncate">
                {t("music_import.columns.ai_revert", { columns: replaced.columns.join(", ") })}
              </span>
            </button>
          )}
          {example && (
            <p className="mt-1 truncate text-11 text-tertiary" title={example}>
              {t("music_import.columns.example", { values: example })}
            </p>
          )}
          {dateReading && (
            <p className="mt-0.5 text-11 text-secondary">
              {t(dateReading.year_only ? "music_import.columns.year_reading" : "music_import.columns.date_reading", {
                date: dateReading.year_only ? dateReading.parsed.slice(0, 4) : dateReading.parsed,
              })}
            </p>
          )}
          {/* Fixed value: the same value for the whole file (or for its empty cells) */}
          <div className="mt-1.5 flex max-w-sm flex-wrap items-center gap-1.5 empty:hidden">
            {fixed.map((value) => (
              <span
                key={value}
                className="border-accent-primary/40 flex max-w-full items-center gap-1 rounded-md border bg-accent-primary/5 py-0.5 pr-1 pl-2 text-12"
              >
                <Pin className="size-3 shrink-0 text-accent-primary" aria-hidden />
                <span className="truncate">{fixedText(value)}</span>
                <button
                  type="button"
                  aria-label={t("music_import.columns.fixed_remove", { value })}
                  onClick={() => flow.setConstant(field, isMulti ? fixed.filter((item) => item !== value) : undefined)}
                  className="rounded-sm p-0.5 text-tertiary hover:bg-layer-1-hover hover:text-primary"
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
            {editingFixed !== field && (isMulti || fixed.length === 0) && (
              <button
                type="button"
                onClick={() => setEditingFixed(field)}
                className="flex items-center gap-1 rounded-sm px-1 py-0.5 text-11 text-secondary hover:bg-layer-1-hover hover:text-primary"
              >
                <Pin className="size-3" aria-hidden />
                {t("music_import.columns.fixed_add")}
              </button>
            )}
          </div>
          {fixed.length > 0 && (
            <p className="mt-0.5 text-11 text-tertiary">
              {t(selected.length > 0 ? "music_import.columns.fixed_blank_only" : "music_import.columns.fixed_all_rows")}
            </p>
          )}
          {editingFixed === field && (
            <ImportFixedValueEditor
              workspaceSlug={workspaceSlug}
              field={field}
              chosen={fixed}
              formatExample={preview?.format_examples?.[field]}
              onPick={(value) => {
                if (isMulti) {
                  if (!fixed.some((item) => item.toLowerCase() === value.toLowerCase()))
                    flow.setConstant(field, [...fixed, value]);
                } else {
                  flow.setConstant(field, value);
                  setEditingFixed(undefined);
                }
              }}
              onClose={() => setEditingFixed(undefined)}
            />
          )}
        </div>
      </li>
    );
  };

  const group = (title: string, fields: string[]) => {
    const visible = fields.filter(matches);
    if (visible.length === 0) return null;
    return (
      <section>
        <h3 className="mb-2 text-12 font-medium text-secondary">{title}</h3>
        <ul className="divide-y divide-subtle rounded-lg border border-subtle bg-surface-1">
          {visible.map(renderField)}
        </ul>
      </section>
    );
  };

  /** Asks the AI; its proposal opens as a reviewable panel above the fields. */
  const runAiMap = async () => {
    const summary = await flow.aiMap();
    if (!summary) return;
    if (summary.fields + summary.changes === 0) {
      setToast({ type: TOAST_TYPE.INFO, title: t("music_import.ai.nothing") });
      return;
    }
    setToast({
      type: TOAST_TYPE.SUCCESS,
      title: t("music_import.ai.toast", { fields: summary.fields, changes: summary.changes }),
      actionItems: (
        <button
          type="button"
          onClick={() => document.getElementById(AI_PANEL_ID)?.scrollIntoView({ behavior: "smooth", block: "start" })}
          className="text-12 font-medium text-accent-primary hover:underline"
        >
          {t("music_import.ai.review")}
        </button>
      ),
    });
  };

  const searching = normalized.length > 0;
  const anyMatch = importFields.some(matches);

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_18rem]">
      <div className="min-w-0 space-y-5">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-15 font-semibold text-primary">{t("music_import.columns.title")}</h2>
            <p className="mt-1 text-13 text-secondary">{t("music_import.columns.description")}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-12 text-tertiary">
              {t("music_import.columns.assigned", { count: assigned.length })}
            </span>
            <Button variant="secondary" size="sm" disabled={flow.isAiMapping} onClick={() => void runAiMap()}>
              <WandSparkles className="size-3.5" />
              {t("music_import.actions.ai_map")}
            </Button>
            <label className="relative">
              <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-tertiary" aria-hidden />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("music_import.columns.search")}
                aria-label={t("music_import.columns.search")}
                className="focus:border-accent-primary w-48 rounded-md border border-subtle bg-layer-1 py-1.5 pr-2 pl-8 text-12 outline-none"
              />
            </label>
          </div>
        </header>

        <ImportAiPanel flow={flow} />

        {flow.missingTitle && (
          <div className="flex gap-2.5 rounded-md border border-warning-subtle bg-warning-subtle px-3 py-2.5 text-12">
            <AlertCircle className="mt-0.5 size-3.5 shrink-0 text-warning-primary" aria-hidden />
            <div>
              <p className="font-medium text-primary">{t("music_import.columns.title_missing")}</p>
              <p className="mt-0.5 text-secondary">{t("music_import.columns.title_missing_hint")}</p>
            </div>
          </div>
        )}

        {group(t("music_import.columns.group_assigned"), assigned)}
        {group(t("music_import.columns.group_essential"), essentials)}
        {searching || showMore ? (
          group(t("music_import.columns.group_more"), more)
        ) : (
          <button
            type="button"
            onClick={() => setShowMore(true)}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-subtle py-2.5 text-12 text-secondary hover:bg-layer-1-hover"
          >
            <ChevronDown className="size-3.5" />
            {t("music_import.columns.show_more", { count: more.length })}
          </button>
        )}
        {showMore && !searching && (
          <button
            type="button"
            onClick={() => setShowMore(false)}
            className="text-12 text-secondary underline-offset-2 hover:underline"
          >
            {t("music_import.columns.hide_more")}
          </button>
        )}
        {searching && !anyMatch && (
          <p className="py-6 text-center text-12 text-tertiary">
            {t("music_import.columns.no_results", { query: query.trim() })}
          </p>
        )}
      </div>

      <aside className="xl:sticky xl:top-0 xl:self-start">
        <h3 className="text-12 font-medium text-secondary">{t("music_import.columns.unused_columns")}</h3>
        {unusedColumns.length === 0 ? (
          <p className="mt-2 text-12 text-tertiary">{t("music_import.columns.no_unused")}</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {unusedColumns.map((column) => (
              <li key={column} className="rounded-md border border-subtle bg-layer-1 px-3 py-2">
                <p className="truncate text-12 text-primary" title={column}>
                  {column}
                </p>
                <p className="truncate text-11 text-tertiary">{sampleText([column])}</p>
              </li>
            ))}
          </ul>
        )}
      </aside>
    </div>
  );
}
