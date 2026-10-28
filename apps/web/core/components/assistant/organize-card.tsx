/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * The file library put in order: the operations grouped by kind (rename,
 * move, new folders, categories, tags, trash), one checkbox each, and the
 * trash confirmed apart. Applies on confirm; undo reverts the whole card.
 */

import { useMemo, useState } from "react";
import { makeAssistantToolUI } from "@assistant-ui/react";
import { FolderTree } from "lucide-react";
import { useTranslation } from "@plane/i18n";
import { cn } from "@plane/utils";
import { CARD, Footer, useOutcome } from "./action-cards";
import { UndoConflicts, useCardActions } from "./card-kit";
import { AssistantLink } from "./links";
import { TraceLine } from "./steps";

const KINDS = ["create_folder", "rename", "move", "categorize", "tag", "trash"] as const;
type TKind = (typeof KINDS)[number];

type TRow = {
  index: number;
  op: TKind;
  file_id?: string;
  name?: string;
  folder?: string;
  to?: string;
  path?: string;
  remove?: boolean | null;
  starts_analysis?: boolean | null;
  new_tag?: boolean;
};

type TOrganizeProposal = {
  ops?: TRow[];
  problems?: { index: number; op: string; error: string }[] | null;
  input_ops?: Record<string, unknown>[];
  summary?: string;
  workspace_slug?: string;
  error?: string;
};

const PREFIX = "assistant.organize";

function describe(row: TRow, t: (key: string, params?: Record<string, unknown>) => string) {
  if (row.op === "create_folder") return row.path ?? "";
  if (row.op === "rename") return `${row.name} → ${row.to}`;
  if (row.op === "move") return `${row.name}: ${row.folder} → ${row.to}`;
  if (row.op === "categorize" || row.op === "tag")
    return `${row.name}: ${row.remove ? "−" : "+"} ${row.to}${row.new_tag ? ` (${t(`${PREFIX}.new_tag`)})` : ""}`;
  return `${row.name} · ${row.folder}`;
}

function OrganizeForm({ proposal, toolCallId }: { proposal: TOrganizeProposal; toolCallId: string }) {
  const { t } = useTranslation();
  const slug = proposal.workspace_slug!;
  const rows = useMemo(() => proposal.ops ?? [], [proposal.ops]);
  const [outcome, remember, meta] = useOutcome(`assistant-organize:${toolCallId}`);
  const { apply, undo } = useCardActions(slug, outcome, remember, meta);
  const [off, setOff] = useState<Set<number>>(new Set());
  const [trashConfirmed, setTrashConfirmed] = useState(false);
  const busy = outcome.state === "busy";
  const done = outcome.state !== "idle" && outcome.state !== "busy";
  const chosen = rows.filter((row) => !off.has(row.index));
  const trash = chosen.filter((row) => row.op === "trash").length;
  const analyses = chosen.filter((row) => row.starts_analysis).length;
  const toggle = (index: number) =>
    setOff((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });

  const run = () =>
    void apply({
      kind: "ORGANIZE_FILES",
      ops: chosen.map((row) => proposal.input_ops?.[row.index]).filter(Boolean),
    });

  return (
    <div className={CARD}>
      <div className="flex items-center gap-2">
        <FolderTree className="size-4 shrink-0 text-tertiary" aria-hidden />
        <p className="min-w-0 flex-1 truncate text-13 font-medium text-primary">
          {t(`${PREFIX}.title`, { count: rows.length })}
        </p>
      </div>
      {proposal.summary && <p className="mt-1 text-12 text-secondary">{proposal.summary}</p>}
      <div className="mt-2 max-h-96 space-y-2 overflow-y-auto">
        {KINDS.map((kind) => {
          const group = rows.filter((row) => row.op === kind);
          if (group.length === 0) return null;
          return (
            <section key={kind}>
              <p className={cn("text-11 font-medium", kind === "trash" ? "text-danger-primary" : "text-secondary")}>
                {t(`${PREFIX}.kinds.${kind}`, { count: group.length })}
              </p>
              <ul className="mt-0.5 space-y-0.5">
                {group.map((row) => (
                  <li key={row.index}>
                    <label
                      className={cn(
                        "flex items-start gap-2 rounded-md px-1 py-0.5 text-11",
                        !done && "cursor-pointer hover:bg-layer-1-hover",
                        off.has(row.index) && "opacity-50"
                      )}
                    >
                      <input
                        type="checkbox"
                        className="accent-accent-primary mt-0.5"
                        checked={!off.has(row.index)}
                        disabled={done || busy}
                        onChange={() => toggle(row.index)}
                      />
                      <span className="min-w-0 flex-1 break-words text-secondary">{describe(row, t)}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
      {(proposal.problems ?? []).map((problem) => (
        <p key={problem.index} className="mt-1 text-11 text-warning-primary">
          {problem.error}
        </p>
      ))}
      {analyses > 0 && (
        <p className="mt-1.5 text-11 text-warning-primary">{t(`${PREFIX}.starts_analysis`, { count: analyses })}</p>
      )}
      {trash > 0 && !done && (
        <label className="mt-1.5 flex items-start gap-2 rounded-md bg-danger-subtle px-2 py-1.5 text-11 text-danger-primary">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={trashConfirmed}
            disabled={busy}
            onChange={() => setTrashConfirmed((value) => !value)}
          />
          {t(`${PREFIX}.confirm_trash`, { count: trash })}
        </label>
      )}
      <UndoConflicts outcome={outcome} label={(field) => t(`${PREFIX}.fields.${field}`)} />
      <Footer
        outcome={outcome}
        busy={busy}
        doneLabel={t(`${PREFIX}.done`, { count: chosen.length })}
        extra={
          <AssistantLink href={`/${slug}/file-library`} className="shrink-0 text-12">
            {t(`${PREFIX}.open`)}
          </AssistantLink>
        }
        applyLabel={t(`${PREFIX}.apply`, { count: chosen.length })}
        disabled={chosen.length === 0 || (trash > 0 && !trashConfirmed)}
        onApply={run}
        onDiscard={() => remember({ state: "discarded" })}
        onUndo={() => void undo()}
      />
    </div>
  );
}

export const OrganizeFilesCard = makeAssistantToolUI<Record<string, unknown>, TOrganizeProposal>({
  toolName: "propose_file_organization",
  render: function OrganizeFilesRender({ result, status, toolCallId }) {
    const { t } = useTranslation();
    if (status.type === "running" || !result) {
      return <TraceLine live icon={FolderTree} label={t("assistant.steps.propose_file_organization.running")} />;
    }
    if (result.error || !result.ops || !result.workspace_slug) {
      return <p className="text-12 text-tertiary">{result.error ?? t("assistant.actions.failed")}</p>;
    }
    return <OrganizeForm proposal={result} toolCallId={toolCallId} />;
  },
});
