/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * Music catalog filters, built on the same primitives as the work-items
 * filters (FiltersDropdown popover + FilterHeader/FilterOption sections with
 * a shared search) plus the Tag-based applied-filters chip row. Dynamic lists
 * (artists, genres, releases, companies, import files) are searchable and
 * MULTI-select — values travel as comma-separated lists. Each applied group
 * chip is also a quick-edit popover for that category.
 */

import { useState } from "react";
import { ListFilter, Search, X } from "lucide-react";
import { CloseIcon } from "@plane/propel/icons";
import type { TMusicFilters } from "@plane/types";
import { Tag } from "@plane/ui";
import { FilterHeader, FilterOption, FiltersDropdown } from "@/components/issues/issue-layouts/filters";
import { MUSIC_FIELD } from "./shared";

export type TMusicFilterOption = { value: string; label: string };

/** Comma-joined multi values ⇄ arrays */
export const parseFilterList = (value?: string): string[] => (value ? value.split(",").filter(Boolean) : []);
const joinFilterList = (values: string[]): string => values.filter(Boolean).join(",");

const toggleValue = (values: string[], value: string): string[] =>
  values.includes(value) ? values.filter((item) => item !== value) : [...values, value];

type TOptionListProps = {
  options: TMusicFilterOption[];
  selected: string[];
  searchQuery: string;
  onToggle: (value: string) => void;
};

/** Searchable multi-select option list: applied first, 5 visible + view all */
function OptionList({ options, selected, searchQuery, onToggle }: TOptionListProps) {
  const [viewAll, setViewAll] = useState(false);
  const query = searchQuery.trim().toLowerCase();
  const filtered = query ? options.filter((option) => option.label.toLowerCase().includes(query)) : options;
  const sorted = [
    ...filtered.filter((option) => selected.includes(option.value)),
    ...filtered.filter((option) => !selected.includes(option.value)),
  ];
  const visible = viewAll ? sorted : sorted.slice(0, 5);
  return (
    <>
      {visible.map((option) => (
        <FilterOption
          key={option.value}
          isChecked={selected.includes(option.value)}
          onClick={() => onToggle(option.value)}
          title={option.label}
          multiple
        />
      ))}
      {sorted.length > 5 && (
        <button
          type="button"
          className="ml-8 text-11 font-medium text-accent-primary"
          onClick={() => setViewAll((value) => !value)}
        >
          {viewAll ? "Ver menos" : `Ver todos (${sorted.length})`}
        </button>
      )}
      {sorted.length === 0 && <p className="text-11 text-tertiary italic">Sin coincidencias</p>}
    </>
  );
}

function FilterSection({
  title,
  options,
  selected,
  searchQuery,
  onToggle,
}: TOptionListProps & { title: string }) {
  const [isPreviewEnabled, setIsPreviewEnabled] = useState(true);
  return (
    <div className="py-1">
      <FilterHeader
        title={`${title}${selected.length ? ` (${selected.length})` : ""}`}
        isPreviewEnabled={isPreviewEnabled}
        handleIsPreviewEnabled={() => setIsPreviewEnabled((value) => !value)}
      />
      {isPreviewEnabled && (
        <OptionList options={options} selected={selected} searchQuery={searchQuery} onToggle={onToggle} />
      )}
    </div>
  );
}

function DateSection({
  title,
  fields,
  filters,
  onSet,
}: {
  title: string;
  fields: { key: keyof TMusicFilters; label: string }[];
  filters: TMusicFilters;
  onSet: (key: keyof TMusicFilters, value: string) => void;
}) {
  const [isPreviewEnabled, setIsPreviewEnabled] = useState(false);
  const appliedCount = fields.filter((field) => filters[field.key]).length;
  return (
    <div className="py-1">
      <FilterHeader
        title={`${title}${appliedCount ? ` (${appliedCount})` : ""}`}
        isPreviewEnabled={isPreviewEnabled}
        handleIsPreviewEnabled={() => setIsPreviewEnabled((value) => !value)}
      />
      {isPreviewEnabled && (
        <div className="grid grid-cols-2 gap-2 px-1 py-1">
          {fields.map((field) => (
            <label key={String(field.key)} className="text-10 text-tertiary">
              {field.label}
              <input
                type="date"
                className={`${MUSIC_FIELD} mt-1`}
                value={(filters[field.key] as string | undefined) ?? ""}
                onChange={(event) => onSet(field.key, event.target.value)}
              />
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

export type TMusicFiltersData = {
  statuses: TMusicFilterOption[];
  kinds: TMusicFilterOption[];
  artists: TMusicFilterOption[];
  genres: TMusicFilterOption[];
  releases: TMusicFilterOption[];
  companies: TMusicFilterOption[];
  importFiles: TMusicFilterOption[];
};

/** Multi-select (comma list) filter keys and their option list + label */
const LIST_FILTERS: { key: keyof TMusicFilters; label: string; list: keyof TMusicFiltersData }[] = [
  { key: "status", label: "Estado", list: "statuses" },
  { key: "artist", label: "Artista", list: "artists" },
  { key: "genre", label: "Género", list: "genres" },
  { key: "release", label: "Release", list: "releases" },
  { key: "company", label: "Compañía", list: "companies" },
  { key: "import_file", label: "Archivo de importación", list: "importFiles" },
];

const YEARS: TMusicFilterOption[] = Array.from({ length: new Date().getFullYear() + 1 - 1989 }, (_, index) => {
  const year = String(new Date().getFullYear() + 1 - index);
  return { value: year, label: year };
});

type TDropdownProps = {
  filters: TMusicFilters;
  data: TMusicFiltersData;
  hasActiveFilters: boolean;
  onSet: (key: keyof TMusicFilters, value: string) => void;
};

export function MusicFiltersDropdown({ filters, data, hasActiveFilters, onSet }: TDropdownProps) {
  const [searchQuery, setSearchQuery] = useState("");

  const trigger = (
    <span
      className={`relative flex items-center gap-1 rounded-sm border px-2 py-1.5 text-12 hover:bg-layer-1-hover ${
        hasActiveFilters ? "border-accent-strong text-accent-primary" : "border-subtle"
      }`}
    >
      <ListFilter className="size-3.5" />
      <span className="hidden sm:inline">Filtros</span>
      {hasActiveFilters && <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-accent-primary" />}
    </span>
  );

  return (
    <FiltersDropdown menuButton={trigger} placement="bottom-start">
      <div className="flex h-full w-full flex-col overflow-hidden">
        <div className="bg-surface-1 sticky top-0 z-10 p-2.5 pb-0">
          <div className="flex items-center gap-1.5 rounded-sm border-[0.5px] border-strong bg-surface-1 px-1.5 py-1 text-11">
            <Search className="size-3 text-tertiary" />
            <input
              className="w-full bg-transparent outline-none placeholder:text-placeholder"
              placeholder="Buscar artistas, géneros, releases…"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              autoFocus
            />
            {searchQuery !== "" && (
              <button type="button" onClick={() => setSearchQuery("")} aria-label="Limpiar búsqueda">
                <X className="size-3 text-tertiary" />
              </button>
            )}
          </div>
        </div>
        <div className="vertical-scrollbar scrollbar-sm h-full w-full divide-y divide-subtle overflow-y-auto px-2.5">
          {LIST_FILTERS.map((entry) => (
            <FilterSection
              key={String(entry.key)}
              title={entry.label}
              options={data[entry.list]}
              selected={parseFilterList(filters[entry.key] as string | undefined)}
              searchQuery={searchQuery}
              onToggle={(value) =>
                onSet(entry.key, joinFilterList(toggleValue(parseFilterList(filters[entry.key] as string | undefined), value)))
              }
            />
          ))}
          <FilterSection
            title="Año de lanzamiento"
            options={YEARS}
            selected={parseFilterList(filters.year)}
            searchQuery={searchQuery}
            onToggle={(value) => onSet("year", joinFilterList(toggleValue(parseFilterList(filters.year), value)))}
          />
          <DateSection
            title="Fechas"
            filters={filters}
            onSet={onSet}
            fields={[
              { key: "from", label: "Canción desde" },
              { key: "to", label: "Canción hasta" },
              { key: "video_from", label: "Video desde" },
              { key: "video_to", label: "Video hasta" },
            ]}
          />
          <div className="py-1">
            <FilterOption
              isChecked={filters.has_video === "true"}
              onClick={() => onSet("has_video", filters.has_video === "true" ? "" : "true")}
              title="Con video musical"
              multiple
            />
            <FilterOption
              isChecked={filters.has_links === "true"}
              onClick={() => onSet("has_links", filters.has_links === "true" ? "" : "true")}
              title="Con links"
              multiple
            />
            <FilterOption
              isChecked={filters.has_lyrics === "true"}
              onClick={() => onSet("has_lyrics", filters.has_lyrics === "true" ? "" : "true")}
              title="Con letra"
              multiple
            />
          </div>
        </div>
      </div>
    </FiltersDropdown>
  );
}

const SCALAR_LABELS: Partial<Record<keyof TMusicFilters, string>> = {
  from: "Desde",
  to: "Hasta",
  video_from: "Video desde",
  video_to: "Video hasta",
  has_video: "Con video",
  has_links: "Con links",
  has_lyrics: "Con letra",
};

/** Applied chip for one multi-select category. The label is ALSO the quick
 * edit: clicking it opens a searchable popover with that category's options,
 * so applied filters can be adjusted without reopening the main dropdown. */
function AppliedListFilterGroup({
  label,
  options,
  selected,
  onChange,
  onClear,
}: {
  label: string;
  options: TMusicFilterOption[];
  selected: string[];
  onChange: (values: string[]) => void;
  onClear: () => void;
}) {
  const [searchQuery, setSearchQuery] = useState("");

  return (
    <Tag>
      <FiltersDropdown
        placement="bottom-start"
        menuButton={
          <span className="text-11 text-tertiary underline-offset-2 hover:text-primary hover:underline" title="Editar este filtro">
            {label}
          </span>
        }
      >
        <div className="flex h-full w-full flex-col overflow-hidden">
          <div className="bg-surface-1 sticky top-0 z-10 p-2.5 pb-0">
            <div className="flex items-center gap-1.5 rounded-sm border-[0.5px] border-strong bg-surface-1 px-1.5 py-1 text-11">
              <Search className="size-3 text-tertiary" />
              <input
                className="w-full bg-transparent outline-none placeholder:text-placeholder"
                placeholder={`Buscar ${label.toLowerCase()}…`}
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                autoFocus
              />
            </div>
          </div>
          <div className="vertical-scrollbar scrollbar-sm h-full w-full overflow-y-auto px-2.5 py-1">
            <OptionList
              options={options}
              selected={selected}
              searchQuery={searchQuery}
              onToggle={(value) => onChange(toggleValue(selected, value))}
            />
          </div>
        </div>
      </FiltersDropdown>
      {selected.map((value) => (
        <div key={value} className="flex items-center gap-1 rounded-sm bg-layer-1 p-1 text-11">
          {options.find((option) => option.value === value)?.label ?? value}
          <button
            type="button"
            className="text-tertiary hover:text-primary"
            onClick={() => onChange(selected.filter((item) => item !== value))}
            aria-label={`Quitar ${label}`}
          >
            <CloseIcon height={10} width={10} strokeWidth={2} />
          </button>
        </div>
      ))}
      <button type="button" className="text-tertiary hover:text-primary" onClick={onClear} aria-label={`Limpiar ${label}`}>
        <CloseIcon height={12} width={12} strokeWidth={2} />
      </button>
    </Tag>
  );
}

type TAppliedProps = {
  filters: TMusicFilters;
  data: TMusicFiltersData;
  onSet: (key: keyof TMusicFilters, value: string) => void;
  onClearAll: () => void;
};

/** Chip row mirroring the work-items applied filters, with quick edit per group */
export function MusicAppliedFilters({ filters, data, onSet, onClearAll }: TAppliedProps) {
  const listEntries = LIST_FILTERS.map((entry) => ({
    ...entry,
    selected: parseFilterList(filters[entry.key] as string | undefined),
  })).filter((entry) => entry.selected.length > 0);

  const scalarEntries = (Object.entries(SCALAR_LABELS) as [keyof TMusicFilters, string][]).filter(
    ([key]) => Boolean(filters[key])
  );
  const yearSelected = parseFilterList(filters.year);

  if (listEntries.length === 0 && scalarEntries.length === 0 && yearSelected.length === 0) return null;

  return (
    <div className="flex flex-wrap items-stretch gap-2">
      {listEntries.map((entry) => (
        <AppliedListFilterGroup
          key={String(entry.key)}
          label={entry.label}
          options={data[entry.list]}
          selected={entry.selected}
          onChange={(values) => onSet(entry.key, joinFilterList(values))}
          onClear={() => onSet(entry.key, "")}
        />
      ))}
      {yearSelected.length > 0 && (
        <AppliedListFilterGroup
          label="Año"
          options={YEARS}
          selected={yearSelected}
          onChange={(values) => onSet("year", joinFilterList(values))}
          onClear={() => onSet("year", "")}
        />
      )}
      {scalarEntries.map(([key, label]) => (
        <Tag key={String(key)}>
          <span className="text-11 text-tertiary">{label}</span>
          <div className="flex items-center gap-1 rounded-sm bg-layer-1 p-1 text-11">
            {key === "has_video" || key === "has_links" ? "Sí" : (filters[key] as string)}
            <button
              type="button"
              className="text-tertiary hover:text-primary"
              onClick={() => onSet(key, "")}
              aria-label={`Quitar ${label}`}
            >
              <CloseIcon height={10} width={10} strokeWidth={2} />
            </button>
          </div>
        </Tag>
      ))}
      <button type="button" onClick={onClearAll}>
        <Tag>
          Limpiar todo
          <CloseIcon height={12} width={12} strokeWidth={2} />
        </Tag>
      </button>
    </div>
  );
}
