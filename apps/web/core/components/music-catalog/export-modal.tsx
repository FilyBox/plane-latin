/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * Catalog export panel: which songs (filtered or selected), the format and
 * the columns — "Básico" (the original 19), "Todo" (everything saved for
 * each song, extra data included) or a custom choice remembered per
 * workspace. The column list comes from the API's registry.
 */

import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import useSWR from "swr";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TMusicExportColumn, TMusicExportGroup, TMusicFilters } from "@plane/types";
import { Checkbox, EModalPosition, EModalWidth, ModalCore } from "@plane/ui";
import { cn } from "@plane/utils";
import { musicService } from "@/services/music.service";
import { getApiError } from "./shared";

export type TMusicExportScope = "filtered" | "selected";
type TFormat = "xlsx" | "csv";
type TPreset = "basic" | "all" | "custom";

type Props = {
  workspaceSlug: string;
  isOpen: boolean;
  initialScope: TMusicExportScope;
  /** The catalog's current filters and search */
  filters: TMusicFilters;
  filteredCount: number;
  selectedIds: string[];
  onClose: () => void;
};

/** The "Datos extra" column: one file column per extra key. */
const EXTRA = "extra";

type TSaved = { preset?: TPreset; format?: TFormat; columns?: string[] };

const storageKey = (workspaceSlug: string) => `music-export:${workspaceSlug}`;

function readSaved(workspaceSlug: string): TSaved {
  try {
    const raw = window.localStorage.getItem(storageKey(workspaceSlug));
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? (parsed as TSaved) : {};
  } catch {
    return {};
  }
}

function writeSaved(workspaceSlug: string, value: TSaved) {
  try {
    window.localStorage.setItem(storageKey(workspaceSlug), JSON.stringify(value));
  } catch {
    // Private mode or storage blocked: the choice just isn't remembered
  }
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string; disabled?: boolean }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-md border border-subtle bg-layer-1 p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          disabled={option.disabled}
          onClick={() => onChange(option.value)}
          className={cn(
            "rounded-sm px-2.5 py-1 text-12 whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-50",
            value === option.value
              ? "bg-surface-1 font-medium text-primary shadow-raised-100"
              : "text-secondary hover:text-primary"
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function MusicExportModal({
  workspaceSlug,
  isOpen,
  initialScope,
  filters,
  filteredCount,
  selectedIds,
  onClose,
}: Props) {
  const { t } = useTranslation();
  const [scope, setScope] = useState<TMusicExportScope>(initialScope);
  const [format, setFormat] = useState<TFormat>("xlsx");
  const [preset, setPreset] = useState<TPreset>("basic");
  const [custom, setCustom] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [isExporting, setIsExporting] = useState(false);

  const { data, error, isLoading } = useSWR(isOpen ? ["MUSIC_EXPORT_COLUMNS", workspaceSlug] : null, () =>
    musicService.getExportColumns(workspaceSlug)
  );

  // Each opening starts from the last choice made in this workspace.
  useEffect(() => {
    if (!isOpen) return;
    const saved = readSaved(workspaceSlug);
    setScope(initialScope === "selected" && selectedIds.length ? "selected" : "filtered");
    setFormat(saved.format === "csv" ? "csv" : "xlsx");
    setPreset(saved.preset === "all" || saved.preset === "custom" ? saved.preset : "basic");
    setCustom(Array.isArray(saved.columns) ? saved.columns.filter((key) => typeof key === "string") : []);
    setSearch("");
    // Only when the panel opens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const columns = useMemo(() => data?.columns ?? [], [data]);
  const order = useMemo(() => new Map(columns.map((column, index) => [column.key, index])), [columns]);
  const extraKeys = useMemo(() => data?.extra_keys ?? [], [data]);

  const selected = useMemo(() => {
    if (preset === "basic") return data?.presets.basic ?? [];
    if (preset === "all") return data?.presets.all ?? [];
    // File columns follow the registry's order, whatever order they were checked in
    return [...new Set(custom)]
      .filter((key) => order.has(key))
      .sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  }, [preset, custom, data, order]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  // Columns in the file: "Datos extra" is one column per extra key
  const fileColumnCount = selected.length - (selectedSet.has(EXTRA) ? 1 - extraKeys.length : 0);

  const groupLabel = (group: TMusicExportGroup) => t(`music_export.group.${group}`);
  const columnLabel = (column: TMusicExportColumn) =>
    column.key === EXTRA ? t("music_export.extra_label", { count: extraKeys.length }) : column.header;

  const query = search.trim().toLowerCase();
  const groups = useMemo(() => {
    const result: { group: TMusicExportGroup; columns: TMusicExportColumn[]; all: TMusicExportColumn[] }[] = [];
    for (const group of data?.groups ?? []) {
      const all = columns.filter((column) => column.group === group);
      const label = t(`music_export.group.${group}`).toLowerCase();
      const visible =
        !query || label.includes(query)
          ? all
          : all.filter(
              (column) =>
                column.header.toLowerCase().includes(query) ||
                column.key.includes(query) ||
                (column.key === EXTRA && extraKeys.some((key) => key.toLowerCase().includes(query)))
            );
      if (visible.length) result.push({ group, columns: visible, all });
    }
    return result;
  }, [data, columns, query, extraKeys, t]);

  // Any change to the checkboxes turns the current columns into a custom set.
  const editSelection = (change: (current: Set<string>) => void) => {
    const next = new Set(selected);
    change(next);
    setCustom([...next]);
    setPreset("custom");
  };
  const toggleColumn = (key: string) =>
    editSelection((current) => {
      if (current.has(key)) current.delete(key);
      else current.add(key);
    });
  const toggleGroup = (keys: string[]) =>
    editSelection((current) => {
      const allOn = keys.every((key) => current.has(key));
      keys.forEach((key) => (allOn ? current.delete(key) : current.add(key)));
    });

  const songCount = scope === "selected" ? selectedIds.length : filteredCount;

  const runExport = async () => {
    if (!selected.length) return;
    setIsExporting(true);
    try {
      await musicService.exportCatalog(workspaceSlug, {
        format,
        columns: preset === "all" ? "all" : selected,
        filters: scope === "selected" ? { ids: selectedIds.join(",") } : filters,
        fileName: scope === "selected" ? "music-catalog-selected" : "music-catalog",
      });
      writeSaved(workspaceSlug, {
        preset,
        format,
        columns: preset === "custom" ? selected : readSaved(workspaceSlug).columns,
      });
      onClose();
    } catch (exportError) {
      setToast({ type: TOAST_TYPE.ERROR, title: t("music_export.error_title"), message: getApiError(exportError) });
    } finally {
      setIsExporting(false);
    }
  };

  const presetHint =
    preset === "basic"
      ? t("music_export.preset_basic_hint")
      : preset === "all"
        ? t("music_export.preset_all_hint")
        : t("music_export.preset_custom_hint");

  return (
    <ModalCore
      isOpen={isOpen}
      handleClose={() => !isExporting && onClose()}
      position={EModalPosition.CENTER}
      width={EModalWidth.XXXXL}
    >
      <div className="flex max-h-[85vh] flex-col">
        <div className="shrink-0 space-y-1 border-b border-subtle px-5 pt-5 pb-4">
          <h3 className="text-16 font-medium text-primary">{t("music_export.title")}</h3>
          <p className="text-12 text-secondary">{t("music_export.description")}</p>
        </div>

        <div className="shrink-0 space-y-3 border-b border-subtle px-5 py-4">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <div className="flex items-center gap-2">
              <span className="text-11 text-tertiary">{t("music_export.scope_label")}</span>
              <Segmented
                label={t("music_export.scope_label")}
                value={scope}
                onChange={setScope}
                options={[
                  { value: "filtered", label: `${t("music_export.scope_filtered")}: ${filteredCount}` },
                  ...(selectedIds.length
                    ? [
                        {
                          value: "selected" as const,
                          label: `${t("music_export.scope_selected")}: ${selectedIds.length}`,
                        },
                      ]
                    : []),
                ]}
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-11 text-tertiary">{t("music_export.format_label")}</span>
              <Segmented
                label={t("music_export.format_label")}
                value={format}
                onChange={setFormat}
                options={[
                  { value: "xlsx", label: t("music_export.format_excel") },
                  { value: "csv", label: t("music_export.format_csv") },
                ]}
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-11 text-tertiary">{t("music_export.preset_label")}</span>
            <Segmented
              label={t("music_export.preset_label")}
              value={preset}
              onChange={(next) => {
                // "Personalizado" starts from what is on screen when nothing was saved yet
                if (next === "custom" && !custom.length) setCustom(selected);
                setPreset(next);
              }}
              options={[
                { value: "basic", label: t("music_export.preset_basic") },
                { value: "all", label: t("music_export.preset_all") },
                { value: "custom", label: t("music_export.preset_custom") },
              ]}
            />
            <span className="text-11 text-tertiary">{presetHint}</span>
          </div>
          <div className="flex items-center gap-3">
            <div className="relative min-w-0 flex-1">
              <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-tertiary" />
              <input
                className="focus:border-accent-primary h-8 w-full rounded-md border border-subtle bg-layer-1 pr-2.5 pl-8 text-12 text-primary outline-none"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t("music_export.search")}
              />
            </div>
            <span className="shrink-0 text-12 font-medium text-secondary">
              {t("music_export.columns_count", { count: Math.max(0, fileColumnCount) })}
            </span>
          </div>
        </div>

        <div className="vertical-scrollbar min-h-0 flex-1 overflow-y-auto px-5 py-3">
          {isLoading && <p className="py-10 text-center text-12 text-tertiary">{t("music_export.loading")}</p>}
          {error && !isLoading && (
            <p className="py-10 text-center text-12 text-danger-primary">{t("music_export.load_failed")}</p>
          )}
          {data && !groups.length && (
            <p className="py-10 text-center text-12 text-tertiary">{t("music_export.no_match")}</p>
          )}
          <div className="space-y-4">
            {groups.map(({ group, columns: visible, all }) => {
              const keys = all.map((column) => column.key);
              const count = keys.filter((key) => selectedSet.has(key)).length;
              return (
                <section key={group}>
                  <div className="mb-1.5 flex items-center gap-2 border-b border-subtle pb-1.5">
                    <Checkbox
                      id={`music-export-group-${group}`}
                      checked={count === keys.length}
                      indeterminate={count > 0 && count < keys.length}
                      onChange={() => toggleGroup(keys)}
                      aria-label={t("music_export.select_group", { group: groupLabel(group) })}
                    />
                    <label
                      htmlFor={`music-export-group-${group}`}
                      className="cursor-pointer text-12 font-medium text-primary"
                    >
                      {groupLabel(group)}
                    </label>
                    <span className="text-11 text-tertiary">
                      {t("music_export.group_count", { selected: count, total: keys.length })}
                    </span>
                  </div>
                  {group === "credits" && (
                    <p className="mb-1.5 text-11 text-tertiary">{t("music_export.credits_hint")}</p>
                  )}
                  <div className="grid grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-2 lg:grid-cols-3">
                    {visible.map((column) => {
                      const id = `music-export-column-${column.key}`;
                      const extraHint =
                        column.key === EXTRA
                          ? extraKeys.length
                            ? t("music_export.extra_hint", { keys: extraKeys.slice(0, 8).join(", ") })
                            : t("music_export.extra_none")
                          : undefined;
                      return (
                        <div
                          key={column.key}
                          className="flex min-w-0 items-center gap-2 rounded-sm px-1 py-1 hover:bg-layer-1-hover"
                          title={extraHint ?? column.header}
                        >
                          <Checkbox
                            id={id}
                            checked={selectedSet.has(column.key)}
                            onChange={() => toggleColumn(column.key)}
                          />
                          <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer truncate text-12 text-secondary">
                            {columnLabel(column)}
                          </label>
                        </div>
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-subtle px-5 py-3">
          <span className={cn("text-11", selected.length ? "text-secondary" : "text-danger-primary")}>
            {selected.length
              ? `${t("music_export.columns_count", { count: Math.max(0, fileColumnCount) })} · ${t("music_export.songs_count", { count: songCount })}`
              : t("music_export.none_selected")}
          </span>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={onClose} disabled={isExporting}>
              {t("music_export.cancel")}
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={isExporting}
              disabled={!data || !selected.length || songCount === 0}
              onClick={() => void runExport()}
            >
              {t("music_export.export")}
            </Button>
          </div>
        </div>
      </div>
    </ModalCore>
  );
}
