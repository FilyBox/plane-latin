/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { X } from "lucide-react";
import { useTranslation } from "@plane/i18n";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TMusicCatalogOptions, TMusicCompany, TMusicGenre, TMusicParty, TMusicRelease } from "@plane/types";
import { cn } from "@plane/utils";
import { musicService } from "@/services/music.service";
import { SearchableSelect } from "../searchable-select";
import { getApiError } from "../shared";
import type { TImportDefaults, TImportFlow, TImportRules } from "./use-import-flow";

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
  const { rules, defaults, preview } = flow;
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
    { value: "none", label: t("music_import.rules.identifier_none") },
  ];
  const identifierLabel = identifiers.find((item) => item.value === rules.dedupeBy)?.label ?? rules.dedupeBy;
  const lookingForMatches = rules.dedupeBy !== "none";

  /** New shared resources are created on the spot from each list's
   * "Create «name»" option — no extra modal. */
  const create = async (type: "party" | "company" | "genre" | "release", name: string) => {
    try {
      if (type === "party") {
        const saved = await musicService.saveParty(workspaceSlug, { display_name: name, kind: "ARTIST" });
        setDefault("credits", [...defaults.credits, { party_id: saved.id, role: "PRIMARY_ARTIST" }]);
      } else if (type === "company") {
        const saved = await musicService.saveCompany(workspaceSlug, { name, kind: "AGGREGATOR" });
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

  const chipList = (
    key: "companyIds" | "genreIds" | "releaseIds",
    label: string,
    type: "company" | "genre" | "release",
    list: { value: string; label: string }[]
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
        <div className="mt-2 flex flex-wrap gap-1.5 empty:hidden">
          {selected.map((id) => (
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
                    selected.filter((item) => item !== id)
                  )
                }
                className="rounded-sm p-0.5 text-tertiary hover:bg-layer-1-hover hover:text-primary"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      </div>
    );
  };

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
                    options={(options?.credit_roles ?? []).map(([value, roleLabel]) => ({ value, label: roleLabel }))}
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
          {chipList(
            "companyIds",
            t("music_import.rules.defaults_companies"),
            "company",
            companies.map((item) => ({ value: item.id, label: item.name }))
          )}
          {chipList(
            "genreIds",
            t("music_import.rules.defaults_genres"),
            "genre",
            genres.map((item) => ({ value: item.id, label: item.name }))
          )}
          {chipList(
            "releaseIds",
            t("music_import.rules.defaults_releases"),
            "release",
            releases.map((item) => ({ value: item.id, label: item.title }))
          )}
        </div>
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
