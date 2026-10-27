/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useMemo, useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import type { TMusicImportResult, TMusicImportRowOutcome } from "@plane/types";
import { cn } from "@plane/utils";
import { humanizeRoleKey } from "../credit-roles";
import { columnsOf, errorLabelKey, fieldLabelKey, MATCH_LABEL_KEY, ROW_OUTCOME_LABEL_KEY, SKIP_ROW } from "./constants";
import { ImportInferredTypes } from "./inferred-types";
import { ImportLinkedTags } from "./linked-tags";
import { ImportLiveCounts } from "./live-counts";
import type { TImportFlow, TValueDecision } from "./use-import-flow";

type Props = {
  flow: TImportFlow;
  onValidate: () => void;
};

type TFilter = "all" | TMusicImportRowOutcome | "possible_duplicate";

const PAGE_SIZE = 50;

const valueKey = (field: string, value: string) => `${field}::${value}`;

const FILTERS: { key: TFilter; label: string; count: (review: TMusicImportResult) => number }[] = [
  { key: "created", label: "music_import.review.outcome_created", count: (review) => review.created },
  { key: "updated", label: "music_import.review.outcome_updated", count: (review) => review.updated },
  { key: "unchanged", label: "music_import.review.outcome_unchanged", count: (review) => review.unchanged },
  { key: "skipped", label: "music_import.review.outcome_skipped", count: (review) => review.skipped },
  {
    key: "possible_duplicate",
    label: "music_import.review.outcome_possible_duplicate",
    count: (review) => review.possible_duplicate_count,
  },
  { key: "error", label: "music_import.review.outcome_error", count: (review) => review.errors.length },
  { key: "omitted", label: "music_import.review.outcome_omitted", count: (review) => review.omitted },
];

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-subtle">
      <header className="border-b border-subtle px-4 py-3">
        <h4 className="text-13 font-medium text-primary">{title}</h4>
        {description && <p className="mt-0.5 text-12 text-secondary">{description}</p>}
      </header>
      <div className="px-4 py-3">{children}</div>
    </section>
  );
}

/** "Replace with…/leave empty/omit rows" for one value — or, from the bulk
 * bar, for every selected value at once. */
function DecisionPicker({
  decision,
  onChange,
  placeholder,
}: {
  decision: TValueDecision;
  onChange: (decision: TValueDecision) => void;
  placeholder?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        aria-label={t("music_import.review.decision")}
        value={decision.mode}
        onChange={(event) => onChange({ ...decision, mode: event.target.value as TValueDecision["mode"] })}
        className="focus:border-accent-primary h-7 rounded-md border border-subtle bg-layer-1 px-2 text-12 text-primary outline-none"
      >
        <option value="">{t("music_import.review.decision_pending")}</option>
        <option value="empty">{t("music_import.review.decision_empty")}</option>
        <option value="skip">{t("music_import.review.decision_skip")}</option>
        <option value="assign">{t("music_import.review.decision_assign")}</option>
      </select>
      {decision.mode === "assign" && (
        <input
          value={decision.value}
          onChange={(event) => onChange({ ...decision, value: event.target.value })}
          placeholder={placeholder ?? t("music_import.review.decision_value")}
          aria-label={t("music_import.review.decision_value")}
          className="focus:border-accent-primary h-7 w-32 rounded-md border border-subtle bg-layer-1 px-2 text-12 outline-none"
        />
      )}
    </div>
  );
}

export function ImportStepReview({ flow, onValidate }: Props) {
  const { t } = useTranslation();
  const { review, isReviewCurrent, phase, valueOverrides, rowOverrides, preview } = flow;
  const [filter, setFilter] = useState<TFilter>("all");
  const [page, setPage] = useState(0);
  const [selectedValues, setSelectedValues] = useState<string[]>([]);
  const [bulkDecision, setBulkDecision] = useState<TValueDecision>({ mode: "empty", value: "" });
  const [openRow, setOpenRow] = useState<number>();
  const formats = preview?.format_examples ?? {};
  const limits = preview?.field_limits ?? {};
  const expected = (field: string) =>
    formats[field] ?? (limits[field] ? t("music_import.review.max_length", { max: limits[field] }) : "—");

  const decisionOf = (field: string, token: string): TValueDecision => {
    const current = valueOverrides[field]?.[token.toLowerCase()];
    if (current === undefined) return { mode: "", value: "" };
    if (current === "") return { mode: "empty", value: "" };
    if (current === SKIP_ROW) return { mode: "skip", value: "" };
    return { mode: "assign", value: current };
  };

  const unparseable = useMemo(() => review?.unparseable ?? {}, [review?.unparseable]);
  const valueEntries = useMemo(
    () => Object.entries(unparseable).flatMap(([field, tokens]) => tokens.map((token) => ({ field, ...token }))),
    [unparseable]
  );
  const pendingValues = valueEntries.filter((entry) => decisionOf(entry.field, entry.value).mode === "").length;

  const rows = useMemo(() => {
    const all = review?.rows ?? [];
    if (filter === "all") return all;
    if (filter === "possible_duplicate") return all.filter((row) => row.possible_duplicate);
    return all.filter((row) => row.outcome === filter);
  }, [filter, review?.rows]);
  const pageRows = rows.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  if (!review) {
    return (
      <div className="flex min-h-64 flex-col items-center justify-center text-center">
        {phase === "validating" ? (
          <>
            <Loader2 className="size-5 animate-spin text-accent-primary" aria-hidden />
            <p className="mt-3 text-13 text-secondary">{t("music_import.review.running")}</p>
            <ImportLiveCounts progress={flow.progress} />
          </>
        ) : (
          <>
            <p className="text-13 text-secondary">{t("music_import.review.not_run")}</p>
            <Button variant="primary" size="sm" className="mt-4" onClick={onValidate} disabled={phase !== "idle"}>
              {t("music_import.actions.validate")}
            </Button>
          </>
        )}
      </div>
    );
  }

  const fixedEntries = Object.entries(flow.constants).map(
    ([field, value]) => [field, Array.isArray(value) ? value : [value]] as const
  );
  const creditRoles = Object.entries(review.credit_roles ?? {}).sort((a, b) => b[1] - a[1]);
  // Role names as stored (the file's own words), never translated
  const roleLabel = (key: string) => review.role_labels?.[key] ?? humanizeRoleKey(key);
  const newRoleKeys = new Set((review.new_roles ?? []).map((role) => role.key));

  const hasPending =
    valueEntries.length > 0 ||
    review.errors.length > 0 ||
    review.possible_duplicate_count > 0 ||
    review.in_file_duplicates.length > 0;

  return (
    <div className={cn("space-y-6 transition-opacity", phase === "validating" && "pointer-events-none opacity-60")}>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-15 font-semibold text-primary">{t("music_import.review.title")}</h2>
          <p className="mt-1 text-13 text-secondary">{t("music_import.review.description")}</p>
        </div>
      </header>

      {!isReviewCurrent && phase === "idle" && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-warning-subtle bg-warning-subtle px-3 py-2.5">
          <p className="flex items-center gap-2 text-12 text-primary">
            <AlertCircle className="size-3.5 text-warning-primary" aria-hidden />
            {t("music_import.review.stale")}
          </p>
          <Button variant="secondary" size="sm" onClick={onValidate}>
            {t("music_import.actions.revalidate")}
          </Button>
        </div>
      )}

      <div role="tablist" aria-label={t("music_import.review.title")} className="flex flex-wrap gap-2">
        <button
          type="button"
          role="tab"
          aria-selected={filter === "all"}
          onClick={() => {
            setFilter("all");
            setPage(0);
          }}
          className={cn(
            "rounded-md border px-3 py-2 text-left transition-colors",
            filter === "all" ? "border-accent-primary bg-accent-primary/5" : "border-subtle hover:bg-layer-1-hover"
          )}
        >
          <span className="block text-16 font-semibold text-primary tabular-nums">
            {(review.total - review.empty).toLocaleString()}
          </span>
          <span className="block text-11 text-secondary">{t("music_import.review.filter_all")}</span>
        </button>
        {FILTERS.filter((item) => item.count(review) > 0).map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={filter === item.key}
            onClick={() => {
              setFilter(item.key);
              setPage(0);
            }}
            className={cn(
              "rounded-md border px-3 py-2 text-left transition-colors",
              filter === item.key ? "border-accent-primary bg-accent-primary/5" : "border-subtle hover:bg-layer-1-hover"
            )}
          >
            <span
              className={cn(
                "block text-16 font-semibold tabular-nums",
                item.key === "error" ? "text-danger-primary" : "text-primary"
              )}
            >
              {item.count(review).toLocaleString()}
            </span>
            <span className="block text-11 text-secondary">{t(item.label)}</span>
          </button>
        ))}
      </div>
      {review.empty > 0 && (
        <p className="text-12 text-tertiary">{t("music_import.review.empty_rows", { count: review.empty })}</p>
      )}
      <ImportInferredTypes inferred={review.release_types_inferred} isDryRun />
      <ImportLinkedTags linked={review.artist_tags_linked} isDryRun />

      {(fixedEntries.length > 0 || creditRoles.length > 0) && (
        <div className="grid gap-4 md:grid-cols-2">
          {fixedEntries.length > 0 && (
            <div className="rounded-lg border border-subtle px-4 py-3">
              <h4 className="text-13 font-medium text-primary">{t("music_import.review.fixed_title")}</h4>
              <ul className="mt-2 space-y-1 text-12">
                {fixedEntries.map(([field, values]) => (
                  <li key={field} className="flex flex-wrap gap-x-2">
                    <span className="text-secondary">{t(fieldLabelKey(field))}:</span>
                    <span className="text-primary">{values.join(", ")}</span>
                    {columnsOf(flow.mapping[field]).length > 0 && (
                      <span className="text-tertiary">({t("music_import.review.fixed_blank_only")})</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {creditRoles.length > 0 && (
            <div className="rounded-lg border border-subtle px-4 py-3">
              <h4 className="text-13 font-medium text-primary">{t("music_import.review.credits_title")}</h4>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {creditRoles.map(([role, count]) => (
                  <span
                    key={role}
                    className={cn(
                      "rounded-md px-2 py-0.5 text-12 text-secondary",
                      newRoleKeys.has(role) ? "border-accent-primary/40 border bg-accent-primary/5" : "bg-layer-1"
                    )}
                    title={newRoleKeys.has(role) ? t("music_import.review.new_roles_hint") : undefined}
                  >
                    {roleLabel(role)} <span className="text-primary tabular-nums">{count}</span>
                  </span>
                ))}
              </div>
              {newRoleKeys.size > 0 && (
                <p className="mt-2 text-11 text-tertiary">
                  {t("music_import.review.new_roles", { count: newRoleKeys.size })} ·{" "}
                  {t("music_import.review.new_roles_hint")}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      <div className="space-y-4">
        <h3 className="text-14 font-medium text-primary">{t("music_import.review.pending_title")}</h3>
        {!hasPending && <p className="text-12 text-tertiary">{t("music_import.review.nothing_pending")}</p>}

        {valueEntries.length > 0 && (
          <Section
            title={t("music_import.review.values_title")}
            description={t("music_import.review.values_description")}
          >
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <p className={cn("text-12", pendingValues > 0 ? "text-warning-primary" : "text-success-primary")}>
                {pendingValues > 0
                  ? t("music_import.review.values_pending", { count: pendingValues })
                  : t("music_import.review.values_all_decided")}
              </p>
              {selectedValues.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <DecisionPicker decision={bulkDecision} onChange={setBulkDecision} />
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={
                      bulkDecision.mode === "" || (bulkDecision.mode === "assign" && !bulkDecision.value.trim())
                    }
                    onClick={() => {
                      const byField: Record<string, string[]> = {};
                      for (const key of selectedValues) {
                        const [field, value] = key.split("::");
                        (byField[field] ??= []).push(value);
                      }
                      for (const [field, tokens] of Object.entries(byField))
                        flow.decideValues(field, tokens, bulkDecision);
                      setSelectedValues([]);
                    }}
                  >
                    {t("music_import.actions.apply_to_selected")}
                  </Button>
                </div>
              )}
            </div>
            <div className="space-y-4">
              {Object.entries(unparseable).map(([field, tokens]) => {
                const keys = tokens.map((token) => valueKey(field, token.value));
                const allSelected = keys.every((key) => selectedValues.includes(key));
                return (
                  <div key={field}>
                    <div className="mb-1.5 flex items-center gap-2">
                      <input
                        type="checkbox"
                        className="accent-accent-primary"
                        aria-label={t("music_import.review.select_all_values")}
                        checked={allSelected}
                        onChange={() =>
                          setSelectedValues((current) =>
                            allSelected
                              ? current.filter((key) => !keys.includes(key))
                              : [...new Set([...current, ...keys])]
                          )
                        }
                      />
                      <p className="text-12 font-medium text-secondary">
                        {t("music_import.review.values_field", {
                          field: t(fieldLabelKey(field)),
                          example: expected(field),
                        })}
                      </p>
                    </div>
                    <ul className="divide-y divide-subtle rounded-md border border-subtle">
                      {tokens.map((token) => {
                        const key = valueKey(field, token.value);
                        const others = (token.variants ?? []).filter((variant) => variant !== token.value);
                        return (
                          <li
                            key={key}
                            className="grid items-center gap-2 px-3 py-2 sm:grid-cols-[auto_minmax(0,1fr)_auto_auto]"
                          >
                            <input
                              type="checkbox"
                              className="accent-accent-primary"
                              aria-label={token.value}
                              checked={selectedValues.includes(key)}
                              onChange={() =>
                                setSelectedValues((current) =>
                                  current.includes(key) ? current.filter((item) => item !== key) : [...current, key]
                                )
                              }
                            />
                            <div className="min-w-0">
                              <p className="truncate text-13 text-primary" title={token.value}>
                                {token.value}
                              </p>
                              {others.length > 0 && (
                                <p className="truncate text-11 text-tertiary">
                                  {t("music_import.review.values_variants", { variants: others.join(", ") })}
                                </p>
                              )}
                            </div>
                            <span className="text-12 text-secondary tabular-nums">
                              {t("music_import.review.values_rows", { count: token.count })}
                            </span>
                            <DecisionPicker
                              decision={decisionOf(field, token.value)}
                              onChange={(decision) => flow.decideValues(field, [token.value], decision)}
                              placeholder={formats[field]}
                            />
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })}
            </div>
          </Section>
        )}

        {review.errors.length > 0 && (
          <Section
            title={t("music_import.review.errors_title")}
            description={t("music_import.review.errors_description")}
          >
            <div className="mb-3 grid gap-2 sm:grid-cols-2">
              {(
                [
                  ["skip", "music_import.review.invalid_skip", "music_import.review.invalid_skip_hint"],
                  ["abort", "music_import.review.invalid_abort", "music_import.review.invalid_abort_hint"],
                ] as const
              ).map(([value, label, hint]) => (
                <label
                  key={value}
                  aria-label={t(label)}
                  className={cn(
                    "flex cursor-pointer gap-2.5 rounded-md border px-3 py-2",
                    flow.invalidRowStrategy === value ? "border-accent-primary bg-accent-primary/5" : "border-subtle"
                  )}
                >
                  <input
                    type="radio"
                    name="invalid-rows"
                    className="accent-accent-primary mt-0.5"
                    checked={flow.invalidRowStrategy === value}
                    onChange={() => flow.setInvalidRowStrategy(value)}
                  />
                  <span>
                    <span className="block text-13 text-primary">{t(label)}</span>
                    <span className="block text-12 text-secondary">{t(hint)}</span>
                  </span>
                </label>
              ))}
            </div>
            <ul className="max-h-[28rem] divide-y divide-subtle overflow-y-auto rounded-md border border-subtle">
              {review.errors.map((error) => (
                <li key={`${error.row}-${error.code}`} className="px-3 py-2.5">
                  <div className="grid items-center gap-2 sm:grid-cols-[4rem_minmax(0,1fr)_minmax(0,16rem)]">
                    <span className="text-12 text-tertiary tabular-nums">
                      {t("music_import.review.col_row")} {error.row}
                    </span>
                    <div className="min-w-0">
                      <p className="text-13 text-primary">{t(errorLabelKey(error.code))}</p>
                      {error.field && (
                        <p className="text-11 text-tertiary">
                          {t("music_import.review.error_field", { field: t(fieldLabelKey(error.field)) })}
                          {error.column ? ` · ${error.column}` : ""}
                        </p>
                      )}
                    </div>
                    {error.field ? (
                      <input
                        value={rowOverrides[String(error.row)]?.[error.field] ?? String(error.value ?? "")}
                        onChange={(event) => flow.fixRow(error.row, error.field!, event.target.value)}
                        placeholder={t("music_import.review.fix_placeholder")}
                        aria-label={`${t("music_import.review.fix_placeholder")} · ${t("music_import.review.col_row")} ${error.row}`}
                        className="focus:border-accent-primary h-7 rounded-md border border-subtle bg-layer-1 px-2 text-12 outline-none"
                      />
                    ) : (
                      <span />
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => setOpenRow(openRow === error.row ? undefined : error.row)}
                    aria-expanded={openRow === error.row}
                    className="mt-1 text-11 text-secondary underline-offset-2 hover:underline"
                  >
                    {t("music_import.review.row_values")}
                  </button>
                  {openRow === error.row && (
                    <dl className="mt-1.5 grid gap-x-4 gap-y-0.5 text-11 sm:grid-cols-2">
                      {Object.entries(error.row_data ?? {}).map(([column, value]) => (
                        <div key={column} className="flex min-w-0 gap-1.5">
                          <dt className="shrink-0 text-tertiary">{column}:</dt>
                          <dd className="truncate text-primary">{String(value ?? "—")}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </li>
              ))}
            </ul>
          </Section>
        )}

        {review.possible_duplicate_count > 0 && (
          <Section
            title={t("music_import.review.duplicates_title")}
            description={t("music_import.review.duplicates_description")}
          >
            <div className="mb-3 flex flex-wrap gap-2">
              {(
                [
                  ["create", "music_import.rules.ambiguous_create"],
                  ["match", "music_import.rules.ambiguous_match"],
                  ["skip", "music_import.rules.ambiguous_skip"],
                ] as const
              ).map(([value, label]) => (
                <label
                  key={value}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-12",
                    flow.rules.ambiguousStrategy === value
                      ? "border-accent-primary bg-accent-primary/5"
                      : "border-subtle"
                  )}
                >
                  <input
                    type="radio"
                    name="ambiguous-review"
                    className="accent-accent-primary"
                    checked={flow.rules.ambiguousStrategy === value}
                    onChange={() => flow.setRules((current) => ({ ...current, ambiguousStrategy: value }))}
                  />
                  {t(label)}
                </label>
              ))}
            </div>
            <ul className="max-h-72 divide-y divide-subtle overflow-y-auto rounded-md border border-subtle">
              {review.possible_duplicates.map((item) => (
                <li
                  key={item.row}
                  className="grid gap-1 px-3 py-2 text-12 sm:grid-cols-[4rem_minmax(0,1fr)_minmax(0,1fr)]"
                >
                  <span className="text-tertiary tabular-nums">
                    {t("music_import.review.col_row")} {item.row}
                  </span>
                  <span className="truncate text-primary">{item.title}</span>
                  <span className="truncate text-secondary">
                    {item.match.title}
                    {item.match.isrc ? ` · ${item.match.isrc}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {review.in_file_duplicates.length > 0 && (
          <Section
            title={t("music_import.review.in_file_title")}
            description={t("music_import.review.in_file_description")}
          >
            <label className="mb-3 flex cursor-pointer items-center gap-2 text-12 text-primary">
              <input
                type="checkbox"
                className="accent-accent-primary"
                checked={flow.rules.dedupeWithinFile}
                onChange={(event) =>
                  flow.setRules((current) => ({ ...current, dedupeWithinFile: event.target.checked }))
                }
              />
              {t("music_import.rules.within_file")}
            </label>
            <ul className="max-h-60 divide-y divide-subtle overflow-y-auto rounded-md border border-subtle">
              {review.in_file_duplicates.map((group) => (
                <li key={group.isrc} className="flex flex-wrap justify-between gap-2 px-3 py-2 text-12">
                  <span className="text-primary tabular-nums">{group.isrc}</span>
                  <span className="text-secondary">
                    {t("music_import.review.in_file_rows", { rows: group.rows.join(", ") })}
                  </span>
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>

      <section>
        <div className="overflow-x-auto rounded-lg border border-subtle">
          <table className="min-w-full text-left text-12">
            <thead className="bg-layer-1 text-secondary">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t("music_import.review.col_row")}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t("music_import.review.col_title")}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t("music_import.review.col_isrc")}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t("music_import.review.col_outcome")}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t("music_import.review.col_match")}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-subtle">
              {pageRows.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-tertiary">
                    {t("music_import.review.no_rows")}
                  </td>
                </tr>
              )}
              {pageRows.map((row) => (
                <tr key={row.row}>
                  <td className="px-3 py-2 text-tertiary tabular-nums">{row.row}</td>
                  <td className="max-w-72 truncate px-3 py-2 text-primary" title={row.title}>
                    {row.title || "—"}
                  </td>
                  <td className="px-3 py-2 text-secondary tabular-nums">{row.isrc || "—"}</td>
                  <td className={cn("px-3 py-2", row.outcome === "error" ? "text-danger-primary" : "text-primary")}>
                    {t(ROW_OUTCOME_LABEL_KEY[row.outcome])}
                  </td>
                  <td className="max-w-72 truncate px-3 py-2 text-secondary">
                    {row.match ? `${row.match.title} · ${t(MATCH_LABEL_KEY[row.match.by])}` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length > PAGE_SIZE && (
          <div className="mt-2 flex items-center justify-between text-12 text-secondary">
            <span className="tabular-nums">
              {t("music_import.review.page", {
                from: page * PAGE_SIZE + 1,
                to: Math.min(rows.length, (page + 1) * PAGE_SIZE),
                total: rows.length,
              })}
            </span>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>
                {t("music_import.review.previous_page")}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={(page + 1) * PAGE_SIZE >= rows.length}
                onClick={() => setPage(page + 1)}
              >
                {t("music_import.review.next_page")}
              </Button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
