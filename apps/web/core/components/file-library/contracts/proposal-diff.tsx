/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * A finished re-analysis, as "current → proposed" per field. Each field can
 * be kept or taken; nothing changes until the user applies.
 */

import { useEffect, useMemo, useState } from "react";
import { ArrowRight, ChevronDown, ChevronUp, GitCompareArrows, Loader2 } from "lucide-react";
// plane imports
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import type { TContractProposedChange } from "@plane/types";
import { cn } from "@plane/utils";
// local imports
import { CONTRACT_FIELD_LABEL_KEYS, CONTRACT_FIELD_OPTIONS, DATE_FIELD_KEYS } from "./constants";
import { formatContractDate } from "./utils";

type Props = {
  changes: TContractProposedChange[];
  /** Applies only these fields; the rest of the proposal is discarded */
  onApply: (fields: string[]) => Promise<void> | void;
  onDiscard: () => Promise<void> | void;
  isActing: boolean;
  /** Guests see the proposal but can't act on it */
  readOnly?: boolean;
};

export function ProposalDiff({ changes, onApply, onDiscard, isActing, readOnly }: Props) {
  const { t, currentLocale } = useTranslation();
  const [open, setOpen] = useState(true);
  const fieldsKey = changes.map((change) => change.field).join(",");
  const [selected, setSelected] = useState<Set<string>>(() => new Set(changes.map((change) => change.field)));
  useEffect(() => {
    setSelected(new Set(changes.map((change) => change.field)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fieldsKey]);

  const format = useMemo(
    () =>
      (field: string, value: unknown): string => {
        if (value === null || value === undefined || value === "") return "—";
        if (typeof value === "boolean") return t(value ? "file_library.contracts.yes" : "file_library.contracts.no");
        if (Array.isArray(value)) return value.map((entry) => format(field, entry)).join(", ");
        if (typeof value === "object") return JSON.stringify(value);
        const text = String(value);
        if (DATE_FIELD_KEYS.has(field)) return formatContractDate(text, currentLocale);
        const option = CONTRACT_FIELD_OPTIONS[field]?.find((entry) => entry.value === text);
        return option ? t(option.i18nKey) : text;
      },
    [currentLocale, t]
  );

  if (changes.length === 0) return null;

  const toggle = (field: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(field)) next.delete(field);
      else next.add(field);
      return next;
    });
  const allSelected = selected.size === changes.length;

  return (
    <section
      aria-label={t("file_library.contracts.proposal.title")}
      className="shrink-0 border-b border-subtle bg-accent-primary/5"
    >
      <div className="flex items-center gap-2 px-4 py-2">
        <GitCompareArrows className="size-3.5 shrink-0 text-accent-primary" />
        <p className="min-w-0 flex-1 truncate text-12 font-medium">
          {t("file_library.contracts.proposal.title_count", { count: changes.length })}
        </p>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-11 text-tertiary hover:bg-layer-1-hover"
        >
          {open ? t("file_library.contracts.proposal.hide") : t("file_library.contracts.proposal.review")}
          {open ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
        </button>
      </div>
      {open && (
        <div className="px-4 pb-2.5">
          <div className="max-h-56 overflow-y-auto rounded-sm border border-subtle bg-surface-1">
            <table className="w-full text-left text-12">
              <thead className="sticky top-0 bg-surface-1 text-11 text-tertiary">
                <tr className="border-b border-subtle">
                  {!readOnly && (
                    <th className="w-8 px-2 py-1">
                      <input
                        type="checkbox"
                        aria-label={t("file_library.contracts.proposal.select_all")}
                        checked={allSelected}
                        onChange={() =>
                          setSelected(allSelected ? new Set() : new Set(changes.map((change) => change.field)))
                        }
                      />
                    </th>
                  )}
                  <th className="px-2 py-1 font-medium">{t("file_library.contracts.proposal.field")}</th>
                  <th className="px-2 py-1 font-medium">{t("file_library.contracts.proposal.change")}</th>
                </tr>
              </thead>
              <tbody>
                {changes.map((change) => {
                  const label = CONTRACT_FIELD_LABEL_KEYS[change.field]
                    ? t(CONTRACT_FIELD_LABEL_KEYS[change.field])
                    : change.field;
                  const checked = selected.has(change.field);
                  return (
                    <tr
                      key={change.field}
                      className={cn(
                        "border-b border-subtle align-top last:border-b-0",
                        !checked && !readOnly && "opacity-60"
                      )}
                    >
                      {!readOnly && (
                        <td className="px-2 py-1.5">
                          <input
                            type="checkbox"
                            aria-label={label}
                            checked={checked}
                            onChange={() => toggle(change.field)}
                          />
                        </td>
                      )}
                      <td className="px-2 py-1.5 whitespace-nowrap text-secondary">{label}</td>
                      <td className="px-2 py-1.5">
                        <span className="flex flex-wrap items-baseline gap-x-1.5">
                          <span className="break-words text-tertiary line-through decoration-1">
                            {format(change.field, change.current)}
                          </span>
                          <ArrowRight className="size-3 shrink-0 self-center text-tertiary" aria-hidden />
                          <span className="font-medium break-words">{format(change.field, change.proposed)}</span>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {!readOnly && (
            <div className="mt-2 flex items-center gap-2">
              <Button
                variant="primary"
                size="sm"
                onClick={() => void onApply([...selected])}
                disabled={isActing || selected.size === 0}
              >
                {isActing ? <Loader2 className="size-3.5 animate-spin" /> : null}
                {t("file_library.contracts.proposal.apply", { count: selected.size })}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => void onDiscard()} disabled={isActing}>
                {t("file_library.contracts.reanalyze.discard")}
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
