/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useMemo, useState } from "react";
import { AlertCircle, ChevronDown, Search, WandSparkles, X } from "lucide-react";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { cn } from "@plane/utils";
import { SearchableSelect } from "../searchable-select";
import { columnsOf, ESSENTIAL_FIELDS, fieldLabelKey, REQUIRED_FIELD } from "./constants";
import type { TImportFlow } from "./use-import-flow";

type Props = {
  flow: TImportFlow;
  importFields: string[];
};

export function ImportStepColumns({ flow, importFields }: Props) {
  const { t } = useTranslation();
  const { preview, mapping } = flow;
  const [query, setQuery] = useState("");
  const [showMore, setShowMore] = useState(false);
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
  const assigned = importFields.filter((field) => columnsOf(mapping[field]).length > 0);
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
            <Button variant="secondary" size="sm" loading={flow.isAiMapping} onClick={() => void flow.aiMap()}>
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
