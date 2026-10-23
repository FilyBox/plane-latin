/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useMemo, useState } from "react";
import { useDropzone } from "react-dropzone";
import { Eye, FileSpreadsheet, History, Info, RefreshCcw, Search, Upload } from "lucide-react";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TMusicImportAsset } from "@plane/types";
import { cn } from "@plane/utils";
import { SearchableSelect } from "../searchable-select";
import { formatDate } from "./constants";
import type { TImportFlow } from "./use-import-flow";

type Props = {
  flow: TImportFlow;
  savedAssets: TMusicImportAsset[];
  onViewFile: () => void;
};

const ACCEPT = {
  "text/csv": [".csv"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
  "application/vnd.ms-excel.sheet.macroEnabled.12": [".xlsm"],
};

export function ImportStepFile({ flow, savedAssets, onViewFile }: Props) {
  const { t, currentLocale } = useTranslation();
  const { preview, sourceName, phase } = flow;
  const [query, setQuery] = useState("");
  const isBusy = phase !== "idle";

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    accept: ACCEPT,
    multiple: false,
    noClick: true,
    disabled: isBusy,
    onDropAccepted: ([selected]) => void flow.chooseFile(selected),
    onDropRejected: () => setToast({ type: TOAST_TYPE.ERROR, title: t("music_import.file.only_spreadsheets") }),
  });

  const filteredAssets = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return normalized ? savedAssets.filter((asset) => asset.name.toLowerCase().includes(normalized)) : savedAssets;
  }, [query, savedAssets]);

  if (!preview) {
    return (
      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <section>
          <h2 className="text-15 font-semibold text-primary">{t("music_import.file.title")}</h2>
          <p className="mt-1 text-13 text-secondary">{t("music_import.file.description")}</p>
          <div
            {...getRootProps()}
            className={cn(
              "mt-4 flex min-h-56 flex-col items-center justify-center rounded-lg border border-dashed px-6 py-10 text-center transition-colors",
              isDragActive ? "border-accent-primary bg-accent-primary/5" : "border-strong bg-layer-1"
            )}
          >
            <input {...getInputProps()} aria-label={t("music_import.file.drop")} />
            <FileSpreadsheet className="size-8 text-tertiary" aria-hidden />
            <p className="mt-3 text-13 text-primary">
              {isDragActive ? t("music_import.file.drop_active") : (sourceName ?? t("music_import.file.drop"))}
            </p>
            <Button variant="primary" size="sm" className="mt-4" onClick={open} disabled={isBusy}>
              <Upload className="size-3.5" />
              {t("music_import.file.title")}
            </Button>
          </div>
        </section>

        <section className="lg:pt-[3.25rem]">
          <h3 className="text-13 font-medium text-primary">{t("music_import.file.saved_title")}</h3>
          <p className="mt-1 text-12 text-secondary">{t("music_import.file.saved_description")}</p>
          <label className="relative mt-3 block">
            <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-tertiary" aria-hidden />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("music_import.file.saved_search")}
              aria-label={t("music_import.file.saved_search")}
              className="focus:border-accent-primary w-full rounded-md border border-subtle bg-layer-1 py-1.5 pr-2 pl-8 text-13 outline-none"
            />
          </label>
          <ul className="mt-2 max-h-72 divide-y divide-subtle overflow-y-auto rounded-md border border-subtle">
            {filteredAssets.length === 0 && (
              <li className="px-3 py-6 text-center text-12 text-tertiary">{t("music_import.file.saved_empty")}</li>
            )}
            {filteredAssets.map((asset) => (
              <li key={asset.id} className="flex items-center gap-3 px-3 py-2.5">
                <FileSpreadsheet className="size-4 shrink-0 text-tertiary" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-13 text-primary" title={asset.name}>
                    {asset.name}
                  </p>
                  <p className="text-11 text-tertiary">
                    {asset.run_count
                      ? `${t("music_import.file.runs", { count: asset.run_count })} · ${t(
                          "music_import.file.last_run",
                          {
                            date: formatDate(asset.last_run?.imported_at ?? asset.created_at, currentLocale),
                          }
                        )}`
                      : t("music_import.history.never_imported")}
                  </p>
                </div>
                <Button variant="secondary" size="sm" disabled={isBusy} onClick={() => void flow.reimport(asset)}>
                  <RefreshCcw className="size-3.5" />
                  {t(asset.run_count ? "music_import.actions.reimport" : "music_import.actions.import_saved")}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      </div>
    );
  }

  const previous = preview.previous_imports ?? [];
  const isrcTotal = preview.isrc_count ?? 0;
  const isrcExisting = preview.existing_isrc_count ?? 0;
  const headers = preview.headers;

  return (
    <div className="space-y-5">
      <section className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-subtle bg-layer-1 px-4 py-3">
        <FileSpreadsheet className="size-5 shrink-0 text-tertiary" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="truncate text-13 font-medium text-primary" title={sourceName}>
            {sourceName}
          </p>
          <p className="text-12 text-secondary">
            {t("music_import.file.summary", { rows: preview.total_rows, header: preview.header_row })}
          </p>
        </div>
        {preview.sheets.length > 1 && (
          <label className="flex items-center gap-2 text-12 text-secondary">
            {t("music_import.file.sheet")}
            <SearchableSelect
              className="w-48"
              options={preview.sheets.map((sheet) => ({ value: sheet, label: sheet }))}
              value={preview.selected_sheet}
              onSelect={flow.changeSheet}
            />
          </label>
        )}
        <Button variant="secondary" size="sm" onClick={onViewFile} disabled={!flow.assetId}>
          <Eye className="size-3.5" />
          {t("music_import.actions.view_file")}
        </Button>
        <Button variant="secondary" size="sm" onClick={flow.reset} disabled={isBusy}>
          {t("music_import.actions.change_file")}
        </Button>
      </section>

      {!preview.database_ready && (
        <p className="rounded-md border border-danger-subtle bg-danger-subtle px-3 py-2 text-12 text-danger-primary">
          {t("music_import.file.database_not_ready")}
        </p>
      )}

      {(previous.length > 0 || isrcExisting > 0) && (
        <section className="space-y-2">
          {previous.length > 0 && (
            <div className="flex gap-2.5 rounded-md border border-subtle bg-layer-1 px-3 py-2.5 text-12">
              <History className="mt-0.5 size-3.5 shrink-0 text-tertiary" aria-hidden />
              <div>
                <p className="text-primary">
                  {t("music_import.file.previous_import", {
                    count: previous.length,
                    date: formatDate(previous[0].imported_at, currentLocale),
                  })}
                </p>
                <p className="mt-0.5 text-secondary">{t("music_import.file.previous_import_hint")}</p>
              </div>
            </div>
          )}
          {isrcExisting > 0 && (
            <div className="flex gap-2.5 rounded-md border border-subtle bg-layer-1 px-3 py-2.5 text-12">
              <Info className="mt-0.5 size-3.5 shrink-0 text-tertiary" aria-hidden />
              <div>
                <p className="text-primary">
                  {t("music_import.file.existing_isrcs", {
                    existing: isrcExisting.toLocaleString(),
                    total: isrcTotal.toLocaleString(),
                  })}
                </p>
                {flow.rules.strategy !== "update" && (
                  <p className="mt-0.5 text-secondary">{t("music_import.file.existing_isrcs_hint")}</p>
                )}
              </div>
            </div>
          )}
        </section>
      )}

      <section>
        <h2 className="text-13 font-medium text-primary">{t("music_import.file.preview_title")}</h2>
        <p className="mt-0.5 text-12 text-secondary">{t("music_import.file.preview_description")}</p>
        <div className="mt-3 overflow-x-auto rounded-md border border-subtle">
          <table className="min-w-full text-left text-12">
            <thead className="bg-layer-1 text-secondary">
              <tr>
                {headers.map((header) => (
                  <th key={header} scope="col" className="px-3 py-2 font-medium whitespace-nowrap">
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-subtle">
              {preview.rows.map((row, index) => (
                // A fixed, never-reordered sample of the file: position is its identity.
                // eslint-disable-next-line react/no-array-index-key
                <tr key={index}>
                  {headers.map((header) => (
                    <td
                      key={header}
                      className="max-w-64 truncate px-3 py-2 text-primary"
                      title={String(row[header] ?? "")}
                    >
                      {String(row[header] ?? "")}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
