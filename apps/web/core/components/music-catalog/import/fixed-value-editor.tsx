/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Loader2, Plus, X } from "lucide-react";
import { useTranslation } from "@plane/i18n";
import type { TMusicImportFieldValues } from "@plane/types";
import { cn } from "@plane/utils";
import { musicService } from "@/services/music.service";

type Props = {
  workspaceSlug: string;
  field: string;
  /** Values already chosen for this field (multi fields may hold several) */
  chosen: string[];
  /** Expected format of typed fields ("2023-05-01"), when there is one */
  formatExample?: string;
  onPick: (value: string) => void;
  onClose: () => void;
};

/**
 * Picks a fixed value for one import field: type to search the values the
 * catalog already has (with how often each is used), get warned when the
 * typed text looks like an existing value ("Virgin" vs "VirginAgregadora"),
 * and keep a new value only by choosing so explicitly.
 */
export function ImportFixedValueEditor({ workspaceSlug, field, chosen, formatExample, onPick, onClose }: Props) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [data, setData] = useState<TMusicImportFieldValues>();
  // The query `data` answers: warnings only show for what is typed now.
  const [answeredQuery, setAnsweredQuery] = useState<string>();
  const [isLoading, setIsLoading] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const trimmed = query.trim();

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      setIsLoading(true);
      try {
        const next = await musicService.getImportFieldValues(workspaceSlug, field, trimmed, controller.signal);
        setData(next);
        setAnsweredQuery(trimmed);
        setIsLoading(false);
      } catch {
        if (!controller.signal.aborted) setIsLoading(false);
      }
    };
    const timer = window.setTimeout(() => void load(), trimmed ? 250 : 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [field, trimmed, workspaceSlug]);

  useEffect(() => {
    inputRef.current?.focus();
  }, [data?.kind]);

  const isChosen = (value: string) => chosen.some((item) => item.toLowerCase() === value.toLowerCase());
  const pick = (value: string) => {
    if (!value.trim()) return;
    onPick(value.trim());
    setQuery("");
  };

  const isChoice = data?.kind === "choice";
  const isEntity = data ? ["company", "party", "genre", "release"].includes(data.kind) : false;
  const isFresh = answeredQuery === trimmed;
  const similar = isFresh ? (data?.similar ?? []).filter((entry) => !isChosen(entry.value)) : [];
  const exact = isFresh ? data?.exact : null;
  const choiceLabel = (value: string, label: string) =>
    field === "track.explicit"
      ? t(value === "true" ? "music_import.columns.fixed_true" : "music_import.columns.fixed_false")
      : label;

  return (
    <div className="mt-2 max-w-md rounded-md border border-subtle bg-layer-1 p-2 shadow-raised-100">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <p className="text-11 font-medium text-secondary">{t("music_import.columns.fixed_label")}</p>
        <button
          type="button"
          aria-label={t("music_import.columns.fixed_close")}
          onClick={onClose}
          className="rounded-sm p-0.5 text-tertiary hover:bg-layer-1-hover hover:text-primary"
        >
          <X className="size-3.5" />
        </button>
      </div>

      {isChoice ? (
        <div className="flex flex-wrap gap-1.5">
          {(data?.choices ?? []).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => pick(value)}
              className={cn(
                "rounded-md border px-2 py-1 text-12",
                isChosen(value)
                  ? "border-accent-primary bg-accent-primary/5 text-primary"
                  : "border-subtle text-secondary hover:bg-layer-1-hover"
              )}
            >
              {choiceLabel(value, label)}
            </button>
          ))}
        </div>
      ) : (
        <>
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                onClose();
              }
              if (event.key !== "Enter") return;
              event.preventDefault();
              // Enter reuses an exact match; a look-alike needs an explicit click.
              if (!isFresh) return;
              if (exact) pick(exact.value);
              else if (similar.length === 0) pick(trimmed);
            }}
            placeholder={t("music_import.columns.fixed_search")}
            aria-label={t("music_import.columns.fixed_search")}
            className="focus:border-accent-primary w-full rounded-sm border border-subtle bg-transparent px-2 py-1 text-12 outline-none"
          />
          {formatExample && (
            <p className="mt-1 text-11 text-tertiary">
              {t("music_import.columns.fixed_format", { example: formatExample })}
            </p>
          )}

          {trimmed && exact && (
            <p className="mt-2 flex items-center gap-1.5 text-11 text-success-primary">
              <Check className="size-3" aria-hidden />
              {t("music_import.columns.fixed_exact", { value: exact.value })}
            </p>
          )}

          {trimmed && !exact && similar.length > 0 && (
            <div className="mt-2 rounded-md border border-warning-subtle bg-warning-subtle px-2 py-1.5">
              <p className="flex items-center gap-1.5 text-12 font-medium text-primary">
                <AlertTriangle className="size-3.5 shrink-0 text-warning-primary" aria-hidden />
                {t("music_import.columns.fixed_similar_title")}
              </p>
              <p className="mt-0.5 text-11 text-secondary">{t("music_import.columns.fixed_similar_hint")}</p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {similar.slice(0, 3).map((entry) => (
                  <button
                    key={entry.value}
                    type="button"
                    onClick={() => pick(entry.value)}
                    className="rounded-md border border-subtle bg-surface-1 px-2 py-0.5 text-12 text-primary hover:bg-layer-1-hover"
                  >
                    {t("music_import.columns.fixed_use", { value: entry.value })}
                    <span className="ml-1 text-10 text-tertiary">
                      {t("music_import.columns.fixed_uses", { count: entry.count })}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {trimmed && isFresh && !exact && !isChosen(trimmed) && (
            <button
              type="button"
              onClick={() => pick(trimmed)}
              className="mt-2 flex w-full items-center gap-1.5 rounded-sm px-1.5 py-1 text-left text-12 text-accent-primary hover:bg-layer-1-hover"
            >
              <Plus className="size-3" aria-hidden />
              {t(isEntity ? "music_import.columns.fixed_create" : "music_import.columns.fixed_use", { value: trimmed })}
            </button>
          )}

          <div className="mt-2">
            {isLoading && !data ? (
              <p className="flex items-center gap-1.5 px-1.5 py-1 text-11 text-tertiary">
                <Loader2 className="size-3 animate-spin" aria-hidden />
                {t("music_import.columns.fixed_loading")}
              </p>
            ) : (data?.values.length ?? 0) > 0 ? (
              <>
                <p className="px-1.5 text-10 font-medium tracking-wide text-tertiary uppercase">
                  {t("music_import.columns.fixed_existing")}
                </p>
                <ul className="vertical-scrollbar mt-1 max-h-44 space-y-0.5 overflow-y-auto">
                  {data?.values.map((entry) => (
                    <li key={entry.value}>
                      <button
                        type="button"
                        onClick={() => pick(entry.value)}
                        className="flex w-full items-center justify-between gap-2 rounded-sm px-1.5 py-1 text-left text-12 hover:bg-layer-1-hover"
                      >
                        <span className="min-w-0 truncate">{entry.value}</span>
                        <span className="flex shrink-0 items-center gap-1 text-10 text-tertiary">
                          {t("music_import.columns.fixed_uses", { count: entry.count })}
                          {isChosen(entry.value) && <Check className="size-3 text-accent-primary" />}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              !trimmed && (
                <p className="px-1.5 py-1 text-11 text-tertiary">{t("music_import.columns.fixed_no_values")}</p>
              )
            )}
          </div>
        </>
      )}
    </div>
  );
}
