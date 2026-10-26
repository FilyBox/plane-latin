/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useState } from "react";
import { ArrowRight, Lock, RotateCcw, WandSparkles } from "lucide-react";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import { cn } from "@plane/utils";
import type { TAiDiffItem } from "./ai-diff";
import { fieldLabelKey } from "./constants";
import type { TImportFlow } from "./use-import-flow";

export const AI_PANEL_ID = "music-import-ai-panel";

function Chips({ columns, muted }: { columns: string[]; muted?: boolean }) {
  return (
    <span className="flex min-w-0 flex-wrap gap-1">
      {columns.map((column) => (
        <span
          key={column}
          className={cn(
            "max-w-48 truncate rounded-sm border px-1.5 py-px text-11",
            muted
              ? "border-subtle text-tertiary line-through"
              : "border-accent-primary/40 bg-accent-primary/5 text-primary"
          )}
          title={column}
        >
          {column}
        </span>
      ))}
    </span>
  );
}

function Confidence({ value }: { value: number | null }) {
  const { t } = useTranslation();
  if (value === null) return null;
  const percent = Math.round(value * 100);
  return (
    <span
      title={t("music_import.ai.confidence")}
      className={cn(
        "shrink-0 rounded-sm px-1 py-px text-10 font-medium tabular-nums",
        value >= 0.8
          ? "bg-success-subtle text-success-primary"
          : value >= 0.5
            ? "bg-warning-subtle text-warning-primary"
            : "bg-danger-subtle text-danger-primary"
      )}
    >
      {percent}%
    </span>
  );
}

/**
 * "Map with AI" in the Columns step: a progress card while the request runs
 * (cancellable; the user keeps editing), then the proposal as a reviewable
 * diff — new fields checked, changes to what the user had unchecked — and,
 * once applied, a way back.
 */
export function ImportAiPanel({ flow }: { flow: TImportFlow }) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());
  const [showMatches, setShowMatches] = useState(false);

  useEffect(() => {
    if (!flow.isAiMapping) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [flow.isAiMapping]);

  const label = (field: string) => t(fieldLabelKey(field));

  if (flow.isAiMapping) {
    const seconds = flow.aiStartedAt ? Math.max(0, Math.round((now - flow.aiStartedAt) / 1000)) : 0;
    return (
      <section id={AI_PANEL_ID} className="rounded-lg border border-subtle bg-surface-1 px-4 py-3" aria-busy>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="flex items-center gap-2 text-13 text-primary">
            <WandSparkles className="size-3.5 animate-pulse text-accent-primary" aria-hidden />
            {t("music_import.ai.running", { count: flow.preview?.headers.length ?? 0 })}
            <span className="text-12 text-tertiary tabular-nums">{t("music_import.ai.elapsed", { seconds })}</span>
          </p>
          <Button variant="secondary" size="sm" onClick={flow.cancelAiMap}>
            {t("music_import.ai.cancel")}
          </Button>
        </div>
        <p className="mt-1 text-11 text-tertiary">{t("music_import.ai.running_hint")}</p>
        <div className="mt-3 space-y-2" aria-hidden>
          {[0, 1, 2].map((row) => (
            <div key={row} className="flex items-center gap-3">
              <span className="size-3.5 rounded-sm bg-layer-1" />
              <span className="h-3 w-32 animate-pulse rounded-sm bg-layer-1" />
              <span className="h-3 w-24 animate-pulse rounded-sm bg-layer-1" />
            </div>
          ))}
        </div>
      </section>
    );
  }

  const diff = flow.aiDiff;
  if (diff) {
    const fresh = diff.items.filter((item) => item.kind === "new");
    const changes = diff.items.filter((item) => item.kind === "change");
    const selected = diff.items.filter(flow.isAiItemChecked).length;
    const row = (item: TAiDiffItem) => (
      <li key={item.field} className="flex items-start gap-2.5 px-3 py-2">
        <input
          type="checkbox"
          className="accent-accent-primary mt-0.5 shrink-0"
          checked={flow.isAiItemChecked(item)}
          onChange={(event) => flow.toggleAiItem(item, event.target.checked)}
          aria-label={label(item.field)}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-13 text-primary">{label(item.field)}</span>
            <Confidence value={item.confidence} />
            {item.locked && (
              <span className="flex items-center gap-1 text-11 text-warning-primary">
                <Lock className="size-3" aria-hidden />
                {t("music_import.ai.locked")}
              </span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {item.kind === "change" && !item.merge && (
              <>
                <Chips columns={item.before} muted />
                <ArrowRight className="size-3 shrink-0 text-tertiary" aria-hidden />
              </>
            )}
            {item.merge ? (
              <>
                <Chips columns={item.before} />
                <span className="text-11 text-tertiary">+</span>
                <Chips columns={item.after.filter((column) => !item.before.includes(column))} />
              </>
            ) : (
              <Chips columns={item.after} />
            )}
          </div>
          {item.reason && <p className="mt-0.5 text-11 text-secondary">{item.reason}</p>}
        </div>
      </li>
    );
    return (
      <section id={AI_PANEL_ID} className="border-accent-primary/40 rounded-lg border bg-surface-1">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-subtle px-4 py-2.5">
          <h3 className="flex items-center gap-2 text-13 font-medium text-primary">
            <WandSparkles className="size-3.5 text-accent-primary" aria-hidden />
            {diff.items.length > 0
              ? t("music_import.ai.proposes", { count: diff.items.length })
              : t("music_import.ai.nothing")}
          </h3>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={flow.discardAiProposal}>
              {t("music_import.ai.discard")}
            </Button>
            {diff.items.length > 0 && (
              <Button
                variant="primary"
                size="sm"
                disabled={selected === 0}
                onClick={() => {
                  const count = flow.applyAiProposal();
                  if (count > 0)
                    setToast({
                      type: TOAST_TYPE.SUCCESS,
                      title: t("music_import.ai.applied", { count }),
                      actionItems: (
                        <button
                          type="button"
                          onClick={flow.undoAiProposal}
                          className="text-12 font-medium text-accent-primary hover:underline"
                        >
                          {t("music_import.ai.undo")}
                        </button>
                      ),
                    });
                }}
              >
                {t("music_import.ai.apply", { count: selected })}
              </Button>
            )}
          </div>
        </header>
        {fresh.length > 0 && (
          <div>
            <h4 className="px-4 pt-2.5 text-12 font-medium text-secondary">{t("music_import.ai.section_new")}</h4>
            <ul className="divide-y divide-subtle">{fresh.map(row)}</ul>
          </div>
        )}
        {changes.length > 0 && (
          <div className={cn(fresh.length > 0 && "border-t border-subtle")}>
            <h4 className="px-4 pt-2.5 text-12 font-medium text-secondary">{t("music_import.ai.section_changes")}</h4>
            <p className="px-4 text-11 text-tertiary">{t("music_import.ai.section_changes_hint")}</p>
            <ul className="divide-y divide-subtle">{changes.map(row)}</ul>
          </div>
        )}
        {(diff.matches.length > 0 || diff.unassigned.length > 0) && (
          <div className="space-y-1 border-t border-subtle px-4 py-2 text-11 text-tertiary">
            {diff.matches.length > 0 && (
              <button
                type="button"
                className="block text-left hover:text-primary"
                onClick={() => setShowMatches((open) => !open)}
              >
                {t("music_import.ai.matches", { count: diff.matches.length })}
                {showMatches && <span className="text-secondary">: {diff.matches.map(label).join(", ")}</span>}
              </button>
            )}
            {diff.unassigned.length > 0 && (
              <details>
                <summary className="cursor-pointer hover:text-primary">
                  {t("music_import.ai.unassigned", { count: diff.unassigned.length })}
                </summary>
                <p className="mt-1 text-secondary">{diff.unassigned.join(" · ")}</p>
              </details>
            )}
          </div>
        )}
      </section>
    );
  }

  if (flow.aiHistory) {
    const count = Object.keys(flow.aiHistory).length;
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-md bg-layer-1 px-3 py-2 text-12 text-secondary">
        <WandSparkles className="size-3.5 text-accent-primary" aria-hidden />
        {t("music_import.ai.applied", { count })}
        <button
          type="button"
          onClick={flow.undoAiProposal}
          className="flex items-center gap-1 text-primary underline-offset-2 hover:underline"
        >
          <RotateCcw className="size-3" aria-hidden />
          {t("music_import.ai.undo")}
        </button>
      </div>
    );
  }
  return null;
}
