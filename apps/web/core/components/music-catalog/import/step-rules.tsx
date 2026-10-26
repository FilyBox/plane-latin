/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useMemo } from "react";
import { Pin, X } from "lucide-react";
import { useTranslation } from "@plane/i18n";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TMusicCatalogOptions, TMusicCompany, TMusicGenre, TMusicParty, TMusicRelease } from "@plane/types";
import { cn } from "@plane/utils";
import { musicService } from "@/services/music.service";
import {
  creditRoleLabel,
  creditRoleOptions,
  creditRolesOf,
  groupCreditRoles,
  roleCategoryLabel,
} from "../credit-roles";
import { SearchableSelect } from "../searchable-select";
import { getApiError } from "../shared";
import { columnsOf, fieldLabelKey, ROLE_SKIP, TAGGED_CREDIT_FIELDS } from "./constants";
import type { TImportDefaults, TImportFlow, TImportRules } from "./use-import-flow";

/** "Add to every row" companies: one picker per kind, with plain names, and
 * the import field whose fixed value (from Columns) it also shows. */
const COMPANY_PICKERS: { kind: TMusicCompany["kind"]; label: string; field: string }[] = [
  { kind: "AGGREGATOR", label: "music_import.rules.defaults_aggregators", field: "aggregator" },
  { kind: "DISTRIBUTOR", label: "music_import.rules.defaults_distributors", field: "distributor" },
  { kind: "RECORD_LABEL", label: "music_import.rules.defaults_labels", field: "record_label" },
  { kind: "PUBLISHER", label: "music_import.rules.defaults_publishers", field: "publishers" },
];
const PICKER_KINDS = new Set<string>(COMPANY_PICKERS.map((picker) => picker.kind));

/** People fields whose fixed values show in the people picker */
const PARTY_FIELDS = [
  "artists",
  "featured_artists",
  "writers",
  "authors",
  "composers",
  "producers",
  "recording_engineers",
  "mixers",
  "mastering_engineers",
  "legal_representatives",
  "contributors",
  "performers",
  "release.artists",
];

type TDetectedTag = {
  tag: string;
  label: string;
  count: number;
  /** The role it imports as by default */
  suggested: string;
  suggestedLabel: string;
  /** The default is a new role named after the tag */
  isNew: boolean;
};

type Props = {
  flow: TImportFlow;
  workspaceSlug: string;
  options?: TMusicCatalogOptions;
  parties: TMusicParty[];
  companies: TMusicCompany[];
  genres: TMusicGenre[];
  releases: TMusicRelease[];
  onResourcesChanged: () => void;
};

type TChoice<T extends string> = { value: T; label: string; hint?: string };

function RadioGroup<T extends string>({
  name,
  legend,
  description,
  value,
  choices,
  onChange,
}: {
  name: string;
  legend: string;
  description?: string;
  value: T;
  choices: TChoice<T>[];
  onChange: (value: T) => void;
}) {
  return (
    <fieldset>
      <legend className="text-13 font-medium text-primary">{legend}</legend>
      {description && <p className="mt-0.5 text-12 text-secondary">{description}</p>}
      <div className="mt-2 space-y-1.5">
        {choices.map((choice) => (
          <label
            key={choice.value}
            className={cn(
              "flex cursor-pointer gap-2.5 rounded-md border px-3 py-2 transition-colors",
              value === choice.value
                ? "border-accent-primary bg-accent-primary/5"
                : "border-subtle hover:bg-layer-1-hover"
            )}
          >
            <input
              type="radio"
              name={name}
              className="accent-accent-primary mt-0.5 shrink-0"
              checked={value === choice.value}
              onChange={() => onChange(choice.value)}
            />
            <span className="min-w-0">
              <span className="block text-13 text-primary">{choice.label}</span>
              {choice.hint && <span className="block text-12 text-secondary">{choice.hint}</span>}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function ImportStepRules({
  flow,
  workspaceSlug,
  options,
  parties,
  companies,
  genres,
  releases,
  onResourcesChanged,
}: Props) {
  const { t } = useTranslation();
  const { rules, defaults, preview, mapping, roleMap, constants } = flow;
  const setRule = <K extends keyof TImportRules>(key: K, value: TImportRules[K]) =>
    flow.setRules((current) => ({ ...current, [key]: value }));
  const setDefault = <K extends keyof TImportDefaults>(key: K, value: TImportDefaults[K]) =>
    flow.setDefaults((current) => ({ ...current, [key]: value }));

  const identifiers: TChoice<string>[] = [
    {
      value: "auto",
      label: t("music_import.rules.identifier_auto"),
      hint: t("music_import.rules.identifier_auto_hint"),
    },
    { value: "isrc", label: t("music_import.rules.identifier_isrc") },
    {
      value: "title",
      label: t("music_import.rules.identifier_title"),
      hint: t("music_import.rules.identifier_title_hint"),
    },
    { value: "upc", label: t("music_import.rules.identifier_upc") },
    { value: "catalog", label: t("music_import.rules.identifier_catalog") },
    // Only useful when the file carries the distributor's song id
    ...(columnsOf(mapping["track.external_id"]).length > 0 || rules.dedupeBy === "external_id"
      ? [
          {
            value: "external_id",
            label: t("music_import.rules.identifier_external_id"),
            hint: t("music_import.rules.identifier_external_id_hint"),
          },
        ]
      : []),
    { value: "none", label: t("music_import.rules.identifier_none") },
  ];
  const identifierLabel = identifiers.find((item) => item.value === rules.dedupeBy)?.label ?? rules.dedupeBy;
  const lookingForMatches = rules.dedupeBy !== "none";

  /** New shared resources are created on the spot from each list's
   * "Create «name»" option — no extra modal. */
  const create = async (
    type: "party" | "company" | "genre" | "release",
    name: string,
    companyKind: TMusicCompany["kind"] = "AGGREGATOR"
  ) => {
    try {
      if (type === "party") {
        const saved = await musicService.saveParty(workspaceSlug, { display_name: name, kind: "ARTIST" });
        setDefault("credits", [...defaults.credits, { party_id: saved.id, role: "PRIMARY_ARTIST" }]);
      } else if (type === "company") {
        // Created with the kind of the picker it was typed in
        const saved = await musicService.saveCompany(workspaceSlug, { name, kind: companyKind });
        setDefault("companyIds", [...defaults.companyIds, saved.id]);
      } else if (type === "release") {
        const saved = await musicService.saveRelease(workspaceSlug, {
          title: name,
          release_type: "SINGLE",
          status: "DRAFT",
        });
        setDefault("releaseIds", [...defaults.releaseIds, saved.id]);
      } else {
        const saved = await musicService.saveGenre(workspaceSlug, { name });
        setDefault("genreIds", [...defaults.genreIds, saved.id]);
      }
      onResourcesChanged();
    } catch (error) {
      setToast({ type: TOAST_TYPE.ERROR, title: t("music_import.rules.create_failed"), message: getApiError(error) });
    }
  };

  /** Fixed values set in Columns, shown where the user also looks for them.
   * They stay in `constants`: removing one here clears it there too. */
  const fixedValues = (field: string) => {
    const value = constants[field];
    return !value ? [] : Array.isArray(value) ? value.filter(Boolean) : [value];
  };
  const fixedChips = (fields: string[], withFieldLabel = false) => {
    const items = fields.flatMap((field) => fixedValues(field).map((value) => ({ field, value })));
    if (items.length === 0) return null;
    return (
      <div className="mt-2 flex flex-wrap gap-1.5">
        {items.map(({ field, value }) => {
          const blankOnly = columnsOf(mapping[field]).length > 0;
          const note = `${t("music_import.rules.fixed_from_columns")}${
            blankOnly ? ` · ${t("music_import.rules.fixed_blank_only")}` : ""
          }`;
          return (
            <span
              key={`${field}:${value}`}
              title={note}
              className="border-accent-primary/40 flex max-w-full items-center gap-1 rounded-md border bg-accent-primary/5 py-0.5 pr-1 pl-1.5 text-12"
            >
              <Pin className="size-3 shrink-0 text-accent-primary" aria-label={note} />
              <span className="truncate">{value}</span>
              {withFieldLabel && <span className="shrink-0 text-11 text-tertiary">· {t(fieldLabelKey(field))}</span>}
              {blankOnly && (
                <span className="shrink-0 text-11 text-tertiary">· {t("music_import.rules.fixed_blank_only")}</span>
              )}
              <button
                type="button"
                aria-label={t("music_import.rules.fixed_remove", { value })}
                onClick={() => {
                  const remaining = fixedValues(field).filter((item) => item !== value);
                  flow.setConstant(field, Array.isArray(constants[field]) ? remaining : undefined);
                }}
                className="rounded-sm p-0.5 text-tertiary hover:bg-layer-1-hover hover:text-primary"
              >
                <X className="size-3" />
              </button>
            </span>
          );
        })}
      </div>
    );
  };

  const chips = (
    key: "companyIds" | "genreIds" | "releaseIds",
    ids: string[],
    list: { value: string; label: string }[]
  ) => (
    <div className="mt-2 flex flex-wrap gap-1.5 empty:hidden">
      {ids.map((id) => (
        <span
          key={id}
          className="flex items-center gap-1 rounded-md border border-subtle bg-layer-1 py-0.5 pr-1 pl-2 text-12"
        >
          {list.find((option) => option.value === id)?.label ?? id}
          <button
            type="button"
            aria-label={t("music_import.rules.remove")}
            onClick={() =>
              setDefault(
                key,
                defaults[key].filter((item) => item !== id)
              )
            }
            className="rounded-sm p-0.5 text-tertiary hover:bg-layer-1-hover hover:text-primary"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
    </div>
  );

  const chipList = (
    key: "genreIds" | "releaseIds",
    label: string,
    type: "genre" | "release",
    list: { value: string; label: string }[],
    fixedField: string
  ) => {
    const selected = defaults[key];
    return (
      <div>
        <p className="text-12 font-medium text-secondary">{label}</p>
        <SearchableSelect
          className="mt-1.5"
          options={list.filter((option) => !selected.includes(option.value))}
          value=""
          onSelect={(id) => id && setDefault(key, [...selected, id])}
          onCreate={(name) => void create(type, name)}
          placeholder={t("music_import.rules.defaults_search")}
        />
        {fixedChips([fixedField])}
        {chips(key, selected, list)}
      </div>
    );
  };

  // Companies: one picker per kind, listing only that kind. A saved run's
  // companies land in their kind's picker; any other kind is listed apart.
  const companyKindOf = (id: string) => companies.find((company) => company.id === id)?.kind;
  const companyOptions = companies.map((company) => ({ value: company.id, label: company.name }));
  const otherCompanyIds = defaults.companyIds.filter((id) => !PICKER_KINDS.has(companyKindOf(id) ?? ""));
  const companyPicker = (kind: TMusicCompany["kind"], label: string, field: string) => {
    const selected = defaults.companyIds.filter((id) => companyKindOf(id) === kind);
    return (
      <div key={kind}>
        <p className="text-12 font-medium text-secondary">{t(label)}</p>
        <SearchableSelect
          className="mt-1.5"
          options={companies
            .filter((company) => company.kind === kind && !selected.includes(company.id))
            .map((company) => ({ value: company.id, label: company.name }))}
          value=""
          onSelect={(id) => id && setDefault("companyIds", [...defaults.companyIds, id])}
          onCreate={(name) => void create("company", name, kind)}
          placeholder={t("music_import.rules.defaults_search")}
        />
        {fixedChips([field])}
        {chips("companyIds", selected, companyOptions)}
      </div>
    );
  };

  // Roles detected in the columns assigned to contributors/performers: what
  // each tag imports as — its own role by default (existing, or new and
  // named after the tag), another role, or nothing.
  const roles = useMemo(() => creditRolesOf(options), [options]);
  const roleGroups = useMemo(() => groupCreditRoles(roles), [roles]);
  const roleChoices = creditRoleOptions(t, roles);
  const taggedColumnsKey = JSON.stringify(TAGGED_CREDIT_FIELDS.map((field) => columnsOf(mapping[field])));
  const taggedColumns = useMemo(
    () => TAGGED_CREDIT_FIELDS.flatMap((field) => columnsOf(mapping[field]).map((column) => ({ field, column }))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [taggedColumnsKey]
  );
  const columnRoleTags = preview?.column_role_tags;
  const detectedTags = useMemo(() => {
    const byTag = new Map<string, TDetectedTag>();
    for (const { field, column } of taggedColumns) {
      for (const entry of columnRoleTags?.[column] ?? []) {
        const current = byTag.get(entry.tag);
        if (current) {
          current.count += entry.count;
          continue;
        }
        const suggested = entry.role ?? (field === "performers" ? "PERFORMER" : "OTHER");
        byTag.set(entry.tag, {
          tag: entry.tag,
          label: entry.label,
          count: entry.count,
          suggested,
          suggestedLabel: entry.role_label ?? creditRoleLabel(roles, suggested),
          isNew: Boolean(entry.role_is_new),
        });
      }
    }
    return [...byTag.values()].sort((a, b) => b.count - a.count);
  }, [columnRoleTags, roles, taggedColumns]);
  // New roles this file brings: also valid targets for other tags
  const newRoles = useMemo(() => {
    const seen = new Map<string, string>();
    for (const entry of detectedTags)
      if (entry.isNew && !seen.has(entry.suggested)) seen.set(entry.suggested, entry.suggestedLabel);
    return [...seen.entries()].map(([key, label]) => ({ key, label }));
  }, [detectedTags]);
  // Roles that will really be created: new defaults still in use
  const createdRoles = new Set(
    detectedTags
      .map((entry) => roleMap[entry.tag] ?? entry.suggested)
      .filter((key) => newRoles.some((role) => role.key === key))
  );
  const changedTags = detectedTags.filter((entry) => roleMap[entry.tag] !== undefined).length;

  // Columns with data that no field takes (for "keep as extra data")
  const usedColumns = new Set(Object.values(mapping).flatMap((value) => columnsOf(value)));
  const unmappedWithData = (preview?.headers ?? []).filter(
    (header) => !usedColumns.has(header) && (preview?.column_samples?.[header]?.non_empty ?? 0) > 0
  );

  return (
    <div className="max-w-4xl space-y-8">
      <header>
        <h2 className="text-15 font-semibold text-primary">{t("music_import.rules.title")}</h2>
        <p className="mt-1 text-13 text-secondary">{t("music_import.rules.description")}</p>
      </header>

      <section className="space-y-5">
        <div>
          <h3 className="text-14 font-medium text-primary">{t("music_import.rules.duplicates_title")}</h3>
          <p className="mt-0.5 text-12 text-secondary">{t("music_import.rules.duplicates_description")}</p>
        </div>

        <div className="max-w-md">
          <p className="text-13 font-medium text-primary">{t("music_import.rules.identifier")}</p>
          <SearchableSelect
            className="mt-2"
            options={identifiers}
            value={rules.dedupeBy}
            onSelect={(value) => value && setRule("dedupeBy", value)}
          />
        </div>

        {lookingForMatches && (
          <div className="grid gap-6 lg:grid-cols-2">
            <RadioGroup
              name="on-match"
              legend={t("music_import.rules.on_match")}
              value={rules.strategy}
              onChange={(value) => setRule("strategy", value)}
              choices={[
                {
                  value: "update",
                  label: t("music_import.rules.on_match_update"),
                  hint: t("music_import.rules.on_match_update_hint"),
                },
                {
                  value: "skip",
                  label: t("music_import.rules.on_match_skip"),
                  hint: t("music_import.rules.on_match_skip_hint"),
                },
                {
                  value: "error",
                  label: t("music_import.rules.on_match_error"),
                  hint: t("music_import.rules.on_match_error_hint"),
                },
              ]}
            />
            {rules.dedupeBy === "auto" && (
              <RadioGroup
                name="ambiguous"
                legend={t("music_import.rules.ambiguous")}
                description={t("music_import.rules.ambiguous_description")}
                value={rules.ambiguousStrategy}
                onChange={(value) => setRule("ambiguousStrategy", value)}
                choices={[
                  { value: "create", label: t("music_import.rules.ambiguous_create") },
                  { value: "match", label: t("music_import.rules.ambiguous_match") },
                  { value: "skip", label: t("music_import.rules.ambiguous_skip") },
                ]}
              />
            )}
          </div>
        )}

        {lookingForMatches && rules.strategy === "update" && (
          <div className="max-w-2xl">
            <RadioGroup
              name="relations"
              legend={t("music_import.rules.relations")}
              value={rules.relationsMode}
              onChange={(value) => setRule("relationsMode", value)}
              choices={[
                {
                  value: "merge",
                  label: t("music_import.rules.relations_merge"),
                  hint: t("music_import.rules.relations_merge_hint"),
                },
                {
                  value: "replace",
                  label: t("music_import.rules.relations_replace"),
                  hint: t("music_import.rules.relations_replace_hint"),
                },
              ]}
            />
          </div>
        )}

        {lookingForMatches && rules.strategy === "update" && (
          <div className="max-w-2xl">
            <RadioGroup
              name="blank-cells"
              legend={t("music_import.rules.blank_cells")}
              description={t("music_import.rules.blank_cells_description")}
              value={rules.blankCells}
              onChange={(value) => setRule("blankCells", value)}
              choices={[
                {
                  value: "keep",
                  label: t("music_import.rules.blank_cells_keep"),
                  hint: t("music_import.rules.blank_cells_keep_hint"),
                },
                {
                  value: "clear",
                  label: t("music_import.rules.blank_cells_clear"),
                  hint: t("music_import.rules.blank_cells_clear_hint"),
                },
              ]}
            />
          </div>
        )}

        {lookingForMatches && (
          <label className="flex max-w-2xl cursor-pointer gap-2.5" aria-label={t("music_import.rules.within_file")}>
            <input
              type="checkbox"
              className="accent-accent-primary mt-0.5 shrink-0"
              checked={rules.dedupeWithinFile}
              onChange={(event) => setRule("dedupeWithinFile", event.target.checked)}
            />
            <span>
              <span className="block text-13 text-primary">{t("music_import.rules.within_file")}</span>
              <span className="block text-12 text-secondary">{t("music_import.rules.within_file_hint")}</span>
            </span>
          </label>
        )}

        <p className="max-w-2xl rounded-md bg-layer-1 px-3 py-2.5 text-12 text-secondary">
          {lookingForMatches
            ? t(rules.dedupeBy === "auto" ? "music_import.rules.summary_auto" : "music_import.rules.summary", {
                identifier: identifierLabel,
                action: t(`music_import.rules.summary_action_${rules.strategy}`),
              })
            : t("music_import.rules.summary_none")}
        </p>
      </section>

      <section className="space-y-4">
        <div>
          <h3 className="text-14 font-medium text-primary">{t("music_import.rules.defaults_title")}</h3>
          <p className="mt-0.5 text-12 text-secondary">{t("music_import.rules.defaults_description")}</p>
        </div>
        <div className="grid gap-5 md:grid-cols-2">
          <div>
            <p className="text-12 font-medium text-secondary">{t("music_import.rules.defaults_people")}</p>
            <SearchableSelect
              className="mt-1.5"
              options={parties
                .filter((party) => !defaults.credits.some((credit) => credit.party_id === party.id))
                .map((party) => ({ value: party.id, label: party.display_name }))}
              value=""
              onSelect={(id) =>
                id && setDefault("credits", [...defaults.credits, { party_id: id, role: "PRIMARY_ARTIST" }])
              }
              onCreate={(name) => void create("party", name)}
              placeholder={t("music_import.rules.defaults_search")}
            />
            {fixedChips(PARTY_FIELDS, true)}
            <div className="mt-2 space-y-1.5 empty:hidden">
              {defaults.credits.map((credit) => (
                <div
                  key={credit.party_id}
                  className="flex items-center gap-2 rounded-md border border-subtle bg-layer-1 px-2 py-1.5"
                >
                  <span className="min-w-0 flex-1 truncate text-12 text-primary">
                    {parties.find((party) => party.id === credit.party_id)?.display_name ?? credit.party_id}
                  </span>
                  <SearchableSelect
                    className="w-44"
                    options={roleChoices}
                    value={credit.role}
                    onSelect={(role) =>
                      setDefault(
                        "credits",
                        defaults.credits.map((item) => (item.party_id === credit.party_id ? { ...item, role } : item))
                      )
                    }
                    placeholder={t("music_import.rules.defaults_role")}
                  />
                  <button
                    type="button"
                    aria-label={t("music_import.rules.remove")}
                    onClick={() =>
                      setDefault(
                        "credits",
                        defaults.credits.filter((item) => item.party_id !== credit.party_id)
                      )
                    }
                    className="rounded-sm p-0.5 text-tertiary hover:bg-layer-1-hover hover:text-primary"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>
          {COMPANY_PICKERS.map((picker) => companyPicker(picker.kind, picker.label, picker.field))}
          {otherCompanyIds.length > 0 && (
            <div>
              <p className="text-12 font-medium text-secondary">{t("music_import.rules.defaults_other_companies")}</p>
              {chips("companyIds", otherCompanyIds, companyOptions)}
            </div>
          )}
          {chipList(
            "genreIds",
            t("music_import.rules.defaults_genres"),
            "genre",
            genres.map((item) => ({ value: item.id, label: item.name })),
            "genres"
          )}
          {chipList(
            "releaseIds",
            t("music_import.rules.defaults_releases"),
            "release",
            releases.map((item) => ({ value: item.id, label: item.title })),
            "release.title"
          )}
        </div>
      </section>

      {detectedTags.length > 0 && (
        <section className="space-y-3">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div className="max-w-2xl">
              <h3 className="text-14 font-medium text-primary">{t("music_import.rules.roles_title")}</h3>
              <p className="mt-0.5 text-12 text-secondary">
                {t("music_import.rules.roles_description", {
                  columns: [...new Set(taggedColumns.map((item) => `“${item.column}”`))].join(", "),
                })}
              </p>
            </div>
            {changedTags > 0 && (
              <button
                type="button"
                onClick={() => flow.setRoleMap({})}
                className="text-12 text-secondary underline-offset-2 hover:text-primary hover:underline"
              >
                {t("music_import.rules.roles_reset")} · {t("music_import.rules.roles_changed", { count: changedTags })}
              </button>
            )}
          </div>
          <div className="max-w-2xl overflow-hidden rounded-lg border border-subtle">
            <table className="w-full text-12">
              <thead className="bg-layer-1 text-left text-11 text-tertiary">
                <tr>
                  <th className="px-3 py-1.5 font-medium">{t("music_import.rules.roles_tag")}</th>
                  <th className="px-3 py-1.5 text-right font-medium">{t("music_import.rules.roles_count")}</th>
                  <th className="px-3 py-1.5 font-medium">{t("music_import.rules.roles_role")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-subtle">
                {detectedTags.map((entry) => {
                  const value = roleMap[entry.tag] ?? entry.suggested;
                  const otherNew = newRoles.filter((role) => role.key !== entry.suggested);
                  return (
                    <tr key={entry.tag} className={cn(roleMap[entry.tag] !== undefined && "bg-accent-primary/5")}>
                      <td className="px-3 py-1.5">
                        <span className="text-primary">
                          {entry.tag ? entry.label : t("music_import.rules.roles_untagged")}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 text-right text-secondary tabular-nums">{entry.count}</td>
                      <td className="px-3 py-1">
                        <select
                          aria-label={t("music_import.rules.roles_role")}
                          value={value}
                          onChange={(event) =>
                            flow.setTagRole(
                              entry.tag,
                              event.target.value === entry.suggested ? undefined : event.target.value
                            )
                          }
                          className={cn(
                            "focus:border-accent-primary h-7 w-full max-w-64 rounded-md border border-subtle bg-layer-1 px-2 text-12 outline-none",
                            value === ROLE_SKIP ? "text-tertiary" : "text-primary"
                          )}
                        >
                          {/* Its own role first: the default */}
                          <option value={entry.suggested}>
                            {entry.isNew
                              ? `${entry.suggestedLabel} · ${t("music_import.rules.roles_new")}`
                              : entry.suggestedLabel}
                          </option>
                          {otherNew.length > 0 && (
                            <optgroup label={t("music_import.rules.roles_group_new")}>
                              {otherNew.map((role) => (
                                <option key={role.key} value={role.key}>
                                  {role.label}
                                </option>
                              ))}
                            </optgroup>
                          )}
                          {roleGroups.map((group) => (
                            <optgroup key={group.category} label={roleCategoryLabel(t, group.category)}>
                              {group.roles
                                .filter((role) => role.key !== entry.suggested)
                                .map((role) => (
                                  <option key={role.key} value={role.key}>
                                    {role.label}
                                  </option>
                                ))}
                            </optgroup>
                          ))}
                          <option value={ROLE_SKIP}>{t("music_import.rules.roles_skip")}</option>
                        </select>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {createdRoles.size > 0 && (
            <p className="max-w-2xl text-12 text-secondary">
              {t("music_import.rules.roles_new_summary", { count: createdRoles.size })}
            </p>
          )}
          <p className="max-w-2xl text-11 text-tertiary">{t("music_import.rules.roles_detail_hint")}</p>
        </section>
      )}

      <section className="space-y-2">
        <h3 className="text-14 font-medium text-primary">{t("music_import.rules.unmapped_title")}</h3>
        <label className="flex max-w-2xl cursor-pointer gap-2.5" aria-label={t("music_import.rules.keep_unmapped")}>
          <input
            type="checkbox"
            className="accent-accent-primary mt-0.5 shrink-0"
            checked={rules.keepUnmapped}
            onChange={(event) => setRule("keepUnmapped", event.target.checked)}
          />
          <span>
            <span className="block text-13 text-primary">{t("music_import.rules.keep_unmapped")}</span>
            <span className="block text-12 text-secondary">
              {t("music_import.rules.keep_unmapped_hint", { count: unmappedWithData.length })}
            </span>
            {rules.keepUnmapped && unmappedWithData.length > 0 && (
              <span className="mt-1 block text-11 text-tertiary">{unmappedWithData.join(" · ")}</span>
            )}
          </span>
        </label>
      </section>

      {!!preview?.artist_examples.length &&
        preview.artist_examples.some(
          (example) => example.detected.length > 1 || example.detected[0] !== example.source
        ) && (
          <details className="max-w-2xl rounded-md border border-subtle px-3 py-2">
            <summary className="cursor-pointer text-13 text-primary">
              {t("music_import.rules.artist_split_title")}
            </summary>
            <p className="mt-1.5 text-12 text-secondary">{t("music_import.rules.artist_split_description")}</p>
            <ul className="mt-2 space-y-1 text-12">
              {preview.artist_examples.map((example) => (
                <li key={example.source}>
                  <span className="text-tertiary">{example.source}</span>
                  <span className="mx-2 text-tertiary" aria-hidden>
                    →
                  </span>
                  <span className="text-primary">{example.detected.join(", ")}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
    </div>
  );
}
