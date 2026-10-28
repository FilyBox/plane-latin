/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * Corrections to the music catalog that came out of an audit: per song,
 * release or credit, field / before / after with where the value comes from
 * (the contract, another song, the user). Applies on confirm; undo puts back
 * each field that still holds the correction.
 */

import { useMemo, useState } from "react";
import { makeAssistantToolUI } from "@assistant-ui/react";
import { Wrench } from "lucide-react";
import { useTranslation } from "@plane/i18n";
import { cn } from "@plane/utils";
import { CARD, Footer, useOutcome } from "./action-cards";
import { UndoConflicts, useCardActions } from "./card-kit";
import { AssistantLink } from "./links";
import { TraceLine } from "./steps";

type TFix = {
  index: number;
  entity: "music_track" | "music_release" | "music_credit";
  id: string;
  title: string;
  changes: { field: string; before: unknown; after: unknown }[];
  add_video?: { video_url: string; release_date?: string; isrc?: string } | null;
  source: string;
  source_type?: string;
};

type TFixesProposal = {
  items?: TFix[];
  problems?: { index: number; error: string }[] | null;
  input_items?: Record<string, unknown>[];
  summary?: string;
  workspace_slug?: string;
  error?: string;
};

const PREFIX = "assistant.catalog_fixes";
const show = (value: unknown) => (value === null || value === undefined || value === "" ? "—" : String(value));

function FixesForm({ proposal, toolCallId }: { proposal: TFixesProposal; toolCallId: string }) {
  const { t } = useTranslation();
  const slug = proposal.workspace_slug!;
  const items = useMemo(() => proposal.items ?? [], [proposal.items]);
  const [outcome, remember, meta] = useOutcome(`assistant-catalog-fixes:${toolCallId}`);
  const { apply, undo } = useCardActions(slug, outcome, remember, meta);
  const [off, setOff] = useState<Set<number>>(new Set());
  const busy = outcome.state === "busy";
  const done = outcome.state !== "idle" && outcome.state !== "busy";
  const chosen = items.filter((item) => !off.has(item.index));
  const href = (item: TFix) =>
    item.entity === "music_release" ? `/${slug}/music?release=${item.id}` : `/${slug}/music?track=${item.id}`;

  return (
    <div className={CARD}>
      <div className="flex items-center gap-2">
        <Wrench className="size-4 shrink-0 text-tertiary" aria-hidden />
        <p className="min-w-0 flex-1 truncate text-13 font-medium text-primary">
          {t(`${PREFIX}.title`, { count: items.length })}
        </p>
      </div>
      {proposal.summary && <p className="mt-1 text-12 text-secondary">{proposal.summary}</p>}
      <div className="mt-2 max-h-96 space-y-2 overflow-y-auto">
        {items.map((item) => (
          <label
            key={item.index}
            className={cn("flex items-start gap-2 rounded-md px-1 py-0.5", off.has(item.index) && "opacity-50")}
          >
            <input
              type="checkbox"
              className="accent-accent-primary mt-1"
              checked={!off.has(item.index)}
              disabled={done || busy}
              onChange={() =>
                setOff((current) => {
                  const next = new Set(current);
                  if (next.has(item.index)) next.delete(item.index);
                  else next.add(item.index);
                  return next;
                })
              }
            />
            <span className="min-w-0 flex-1">
              {item.entity === "music_credit" ? (
                <span className="text-12 font-medium">{item.title}</span>
              ) : (
                <AssistantLink href={href(item)} className="text-12 font-medium">
                  {item.title}
                </AssistantLink>
              )}
              {item.changes.map((change) => (
                <span key={change.field} className="block text-11">
                  <span className="text-tertiary">{t(`${PREFIX}.fields.${change.field}`)}: </span>
                  <span className="text-danger-primary line-through">{show(change.before)}</span>
                  <span className="mx-1 text-tertiary">→</span>
                  <span className="text-success-primary">{show(change.after)}</span>
                </span>
              ))}
              {item.add_video ? (
                <span className="block text-11 text-success-primary">
                  + {t(`${PREFIX}.video`)} {item.add_video.video_url}
                </span>
              ) : null}
              <span className="block text-10 text-tertiary">{t(`${PREFIX}.source`, { source: item.source })}</span>
            </span>
          </label>
        ))}
      </div>
      {(proposal.problems ?? []).map((problem) => (
        <p key={problem.index} className="mt-1 text-11 text-warning-primary">
          {problem.error}
        </p>
      ))}
      <UndoConflicts outcome={outcome} label={(field) => t(`${PREFIX}.fields.${field}`)} />
      <Footer
        outcome={outcome}
        busy={busy}
        doneLabel={t(`${PREFIX}.done`, { count: chosen.length })}
        applyLabel={t(`${PREFIX}.apply`, { count: chosen.length })}
        disabled={chosen.length === 0}
        onApply={() =>
          void apply({
            kind: "CATALOG_FIXES",
            items: chosen.map((item) => proposal.input_items?.[item.index]).filter(Boolean),
          })
        }
        onDiscard={() => remember({ state: "discarded" })}
        onUndo={() => void undo()}
      />
    </div>
  );
}

export const CatalogFixesCard = makeAssistantToolUI<Record<string, unknown>, TFixesProposal>({
  toolName: "propose_catalog_fixes",
  render: function CatalogFixesRender({ result, status, toolCallId }) {
    const { t } = useTranslation();
    if (status.type === "running" || !result) {
      return <TraceLine live icon={Wrench} label={t("assistant.steps.propose_catalog_fixes.running")} />;
    }
    if (result.error || !result.items || !result.workspace_slug) {
      return (
        <div className="text-12 text-tertiary">
          <p>{result.error ?? t("assistant.actions.failed")}</p>
          {(result.problems ?? []).map((problem) => (
            <p key={problem.index} className="text-11">
              {problem.error}
            </p>
          ))}
        </div>
      );
    }
    return <FixesForm proposal={result} toolCallId={toolCallId} />;
  },
});
