/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * Edits to what exists: corrections to a contract's extracted data (field,
 * before, after, with the quote it comes from), changes to work items (one
 * row per field, a picker where a name matched several things) and a
 * comment on a work item. Each applies on confirm and can be undone.
 */

import { useMemo, useState } from "react";
import { makeAssistantToolUI } from "@assistant-ui/react";
import { FilePen, ListChecks, MessageSquare } from "lucide-react";
import { useTranslation } from "@plane/i18n";
import { cn } from "@plane/utils";
import {
  CONTRACT_FIELD_LABEL_KEYS,
  CONTRACT_FIELD_OPTIONS,
  DATE_FIELD_KEYS,
} from "@/components/file-library/contracts/constants";
import { formatContractDate } from "@/components/file-library/contracts/utils";
import { CARD, FIELD, Footer, useOutcome } from "./action-cards";
import { UndoConflicts, useCardActions } from "./card-kit";
import { AssistantLink } from "./links";
import { markdownToPreviewHtml } from "./markdown-preview";
import { PREVIEW } from "./page-card";
import { TraceLine } from "./steps";

// ------------------------------------------------------------- contracts

type TContractRow = {
  contract_id: string;
  titulo?: string | null;
  changes?: { field: string; before: unknown; after: unknown }[];
  errors?: Record<string, string[]> | null;
  unknown_fields?: string[] | null;
  reason?: string | null;
  quote?: string | null;
  page?: number | null;
  pending_reanalysis?: boolean | null;
  manual_before?: string[] | null;
  error?: string;
};

type TContractEditProposal = {
  contracts?: TContractRow[];
  summary?: string;
  workspace_slug?: string;
  error?: string;
};

function useContractValue() {
  const { t, currentLocale } = useTranslation();
  return useMemo(() => {
    const label = (field: string) => (CONTRACT_FIELD_LABEL_KEYS[field] ? t(CONTRACT_FIELD_LABEL_KEYS[field]) : field);
    const value = (field: string, raw: unknown): string => {
      if (raw === null || raw === undefined || raw === "") return "—";
      if (typeof raw === "boolean") return t(raw ? "file_library.contracts.yes" : "file_library.contracts.no");
      const text = String(raw);
      if (DATE_FIELD_KEYS.has(field)) return formatContractDate(text, currentLocale);
      const option = CONTRACT_FIELD_OPTIONS[field]?.find((entry) => entry.value === text);
      return option ? t(option.i18nKey) : text;
    };
    return { label, value };
  }, [t, currentLocale]);
}

function ContractEditForm({ proposal, toolCallId }: { proposal: TContractEditProposal; toolCallId: string }) {
  const { t } = useTranslation();
  const slug = proposal.workspace_slug!;
  const rows = useMemo(() => proposal.contracts ?? [], [proposal.contracts]);
  const [outcome, remember, meta] = useOutcome(`assistant-contract-edit:${toolCallId}`);
  const { apply, undo } = useCardActions(slug, outcome, remember, meta);
  // A field corrected by hand before starts unchecked
  const [off, setOff] = useState<Set<string>>(
    () => new Set(rows.flatMap((row) => (row.manual_before ?? []).map((field) => `${row.contract_id}:${field}`)))
  );
  const { label, value } = useContractValue();
  const busy = outcome.state === "busy";
  const done = outcome.state !== "idle" && outcome.state !== "busy";
  const items = rows
    .map((row) => ({
      contract_id: row.contract_id,
      changes: Object.fromEntries(
        (row.changes ?? [])
          .filter((change) => !off.has(`${row.contract_id}:${change.field}`))
          .map((change) => [change.field, change.after])
      ),
      reason: row.reason ?? undefined,
      quote: row.quote ?? undefined,
      page: row.page ?? undefined,
    }))
    .filter((item) => Object.keys(item.changes).length > 0);
  const count = items.reduce((total, item) => total + Object.keys(item.changes).length, 0);
  const toggle = (key: string) =>
    setOff((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className={CARD}>
      <div className="flex items-center gap-2">
        <FilePen className="size-4 shrink-0 text-tertiary" aria-hidden />
        <p className="min-w-0 flex-1 truncate text-13 font-medium text-primary">
          {t("assistant.contract_edit.title", { count: rows.length })}
        </p>
      </div>
      {proposal.summary && <p className="mt-1 text-12 text-secondary">{proposal.summary}</p>}
      <div className="mt-2 max-h-96 space-y-2.5 overflow-y-auto">
        {rows.map((row) => (
          <div key={row.contract_id}>
            <AssistantLink
              href={`/${slug}/file-library/contracts?peek=${row.contract_id}`}
              className="block truncate text-12 font-medium"
            >
              {row.titulo ?? row.contract_id}
            </AssistantLink>
            {row.error && <p className="text-11 text-danger-primary">{row.error}</p>}
            {row.pending_reanalysis && (
              <p className="text-11 text-warning-primary">{t("assistant.contract_edit.pending_reanalysis")}</p>
            )}
            {Object.entries(row.errors ?? {}).map(([field, messages]) => (
              <p key={field} className="text-11 text-danger-primary">
                {label(field)}: {messages.join(" ")}
              </p>
            ))}
            <table className="mt-1 w-full text-11">
              <tbody>
                {(row.changes ?? []).map((change) => {
                  const key = `${row.contract_id}:${change.field}`;
                  const checked = !off.has(key);
                  return (
                    <tr key={key} className={cn("align-top", !checked && "opacity-50")}>
                      <td className="w-5 py-0.5">
                        <input
                          type="checkbox"
                          className="accent-accent-primary"
                          aria-label={label(change.field)}
                          checked={checked}
                          disabled={done || busy}
                          onChange={() => toggle(key)}
                        />
                      </td>
                      <td className="py-0.5 pr-2 text-tertiary">
                        {label(change.field)}
                        {row.manual_before?.includes(change.field) ? (
                          <span className="ml-1 rounded-sm bg-layer-2 px-1 text-10">
                            {t("file_library.contracts.evidence.manual")}
                          </span>
                        ) : null}
                      </td>
                      <td className="py-0.5 break-words">
                        <span className="text-danger-primary line-through">{value(change.field, change.before)}</span>
                        <span className="mx-1 text-tertiary">→</span>
                        <span className="text-success-primary">{value(change.field, change.after)}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {(row.quote || row.reason) && (
              <p className="mt-0.5 text-10 text-tertiary">
                {row.quote ? `“${row.quote}”` : row.reason}
                {row.page ? ` · ${t("file_library.contracts.evidence.page", { page: row.page })}` : ""}
              </p>
            )}
          </div>
        ))}
      </div>
      <UndoConflicts outcome={outcome} label={label} />
      <Footer
        outcome={outcome}
        busy={busy}
        doneLabel={t("assistant.contract_edit.done", { count })}
        applyLabel={t("assistant.contract_edit.apply", { count })}
        disabled={count === 0}
        onApply={() => void apply({ kind: "EDIT_CONTRACT", items })}
        onDiscard={() => remember({ state: "discarded" })}
        onUndo={() => void undo()}
      />
    </div>
  );
}

export const ContractEditCard = makeAssistantToolUI<Record<string, unknown>, TContractEditProposal>({
  toolName: "propose_contract_edit",
  render: function ContractEditRender({ result, status, toolCallId }) {
    const { t } = useTranslation();
    if (status.type === "running" || !result) {
      return <TraceLine live icon={FilePen} label={t("assistant.steps.propose_contract_edit.running")} />;
    }
    if (result.error || !result.contracts || !result.workspace_slug) {
      return <p className="text-12 text-tertiary">{result.error ?? t("assistant.actions.failed")}</p>;
    }
    return <ContractEditForm proposal={result} toolCallId={toolCallId} />;
  },
});

// ------------------------------------------------------------ work items

type TChange = {
  field: string;
  before?: string | null;
  after?: string | null;
  value?: string | null;
  op?: "add" | "remove";
  choices?: { id: string; label: string }[] | null;
};

type TWorkItemsProposal = {
  items?: { issue_id: string; key: string; name: string; path: string; changes: TChange[] }[];
  problems?: string[] | null;
  summary?: string;
  workspace_slug?: string;
  error?: string;
};

function WorkItemsForm({ proposal, toolCallId }: { proposal: TWorkItemsProposal; toolCallId: string }) {
  const { t } = useTranslation();
  const slug = proposal.workspace_slug!;
  const items = useMemo(() => proposal.items ?? [], [proposal.items]);
  const [outcome, remember, meta] = useOutcome(`assistant-work-items:${toolCallId}`);
  const { apply, undo } = useCardActions(slug, outcome, remember, meta);
  const [off, setOff] = useState<Set<string>>(new Set());
  // Picked ids where a name matched several things
  const [picked, setPicked] = useState<Record<string, string>>({});
  const busy = outcome.state === "busy";
  const done = outcome.state !== "idle" && outcome.state !== "busy";
  const fieldLabel = (field: string) => t(`assistant.work_items.fields.${field}`);

  const chosen = items
    .map((item) => ({
      issue_id: item.issue_id,
      changes: item.changes.flatMap((change, index) => {
        const key = `${item.issue_id}:${index}`;
        // A null value clears the field (a date, the cycle); an unpicked choice is left out
        if (off.has(key) || (change.choices && !change.value && !picked[key])) return [];
        return [
          { field: change.field, op: change.op, before: change.before, value: change.value ?? picked[key] ?? null },
        ];
      }),
    }))
    .filter((item) => item.changes.length > 0);
  const unresolved = items.some((item) =>
    item.changes.some(
      (change, index) =>
        change.choices && !change.value && !off.has(`${item.issue_id}:${index}`) && !picked[`${item.issue_id}:${index}`]
    )
  );
  const rowsCount = chosen.reduce((total, item) => total + item.changes.length, 0);

  const toggle = (key: string) =>
    setOff((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className={CARD}>
      <div className="flex items-center gap-2">
        <ListChecks className="size-4 shrink-0 text-tertiary" aria-hidden />
        <p className="min-w-0 flex-1 truncate text-13 font-medium text-primary">
          {t("assistant.work_items.title", { count: items.length })}
        </p>
      </div>
      {proposal.summary && <p className="mt-1 text-12 text-secondary">{proposal.summary}</p>}
      <div className="mt-2 max-h-96 overflow-y-auto">
        <table className="w-full text-11">
          <tbody>
            {items.map((item) =>
              item.changes.map((change, index) => {
                const key = `${item.issue_id}:${index}`;
                const checked = !off.has(key);
                return (
                  <tr
                    key={key}
                    className={cn("border-b border-subtle align-top last:border-0", !checked && "opacity-50")}
                  >
                    <td className="w-5 py-1">
                      <input
                        type="checkbox"
                        className="accent-accent-primary"
                        aria-label={`${item.key} ${fieldLabel(change.field)}`}
                        checked={checked}
                        disabled={done || busy}
                        onChange={() => toggle(key)}
                      />
                    </td>
                    <td className="py-1 pr-2 whitespace-nowrap">
                      {index === 0 ? (
                        <AssistantLink href={item.path} className="text-11" title={item.name}>
                          {item.key}
                        </AssistantLink>
                      ) : null}
                    </td>
                    <td className="py-1 pr-2 text-tertiary">{fieldLabel(change.field)}</td>
                    <td className="py-1 break-words">
                      {change.choices && !change.value ? (
                        <select
                          value={picked[key] ?? ""}
                          disabled={done || busy}
                          aria-label={fieldLabel(change.field)}
                          onChange={(event) => setPicked((current) => ({ ...current, [key]: event.target.value }))}
                          className={cn(FIELD, "py-0.5 text-11")}
                        >
                          <option value="">{t("assistant.work_items.choose")}</option>
                          {change.choices.map((choice) => (
                            <option key={choice.id} value={choice.id}>
                              {choice.label}
                            </option>
                          ))}
                        </select>
                      ) : change.op ? (
                        <span className={change.op === "add" ? "text-success-primary" : "text-danger-primary"}>
                          {change.op === "add" ? "+ " : "− "}
                          {change.after}
                        </span>
                      ) : (
                        <>
                          {change.before ? (
                            <span className="text-danger-primary line-through">{change.before}</span>
                          ) : null}
                          {change.before ? <span className="mx-1 text-tertiary">→</span> : null}
                          <span className="text-success-primary">{change.after ?? "—"}</span>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      {(proposal.problems ?? []).map((problem) => (
        <p key={problem} className="mt-1 text-11 text-warning-primary">
          {problem}
        </p>
      ))}
      <UndoConflicts outcome={outcome} label={fieldLabel} />
      <Footer
        outcome={outcome}
        busy={busy}
        doneLabel={t("assistant.work_items.done", { count: rowsCount })}
        applyLabel={t("assistant.work_items.apply", { count: rowsCount })}
        disabled={rowsCount === 0 || unresolved}
        onApply={() => void apply({ kind: "EDIT_WORK_ITEMS", items: chosen })}
        onDiscard={() => remember({ state: "discarded" })}
        onUndo={() => void undo()}
      />
    </div>
  );
}

export const WorkItemsUpdateCard = makeAssistantToolUI<Record<string, unknown>, TWorkItemsProposal>({
  toolName: "propose_work_item_update",
  render: function WorkItemsUpdateRender({ result, status, toolCallId }) {
    const { t } = useTranslation();
    if (status.type === "running" || !result) {
      return <TraceLine live icon={ListChecks} label={t("assistant.steps.propose_work_item_update.running")} />;
    }
    if (result.error || !result.items || !result.workspace_slug) {
      return (
        <div className="text-12 text-tertiary">
          <p>{result.error ?? t("assistant.actions.failed")}</p>
          {(result.problems ?? []).map((problem) => (
            <p key={problem} className="text-11">
              {problem}
            </p>
          ))}
        </div>
      );
    }
    return <WorkItemsForm proposal={result} toolCallId={toolCallId} />;
  },
});

// --------------------------------------------------------------- comment

type TCommentProposal = {
  issue_id?: string;
  key?: string;
  name?: string;
  path?: string;
  markdown?: string;
  workspace_slug?: string;
  error?: string;
};

function CommentForm({ proposal, toolCallId }: { proposal: TCommentProposal; toolCallId: string }) {
  const { t } = useTranslation();
  const slug = proposal.workspace_slug!;
  const [outcome, remember, meta] = useOutcome(`assistant-comment:${toolCallId}`);
  const { apply, undo } = useCardActions(slug, outcome, remember, meta);
  const [markdown, setMarkdown] = useState(proposal.markdown ?? "");
  const [editing, setEditing] = useState(false);
  const busy = outcome.state === "busy";
  const done = outcome.state !== "idle" && outcome.state !== "busy";
  const previewHtml = useMemo(() => markdownToPreviewHtml(markdown), [markdown]);
  return (
    <div className={CARD}>
      <div className="flex items-center gap-2">
        <MessageSquare className="size-4 shrink-0 text-tertiary" aria-hidden />
        <p className="min-w-0 flex-1 truncate text-13 font-medium text-primary">
          {t("assistant.work_items.comment_on")}{" "}
          <AssistantLink href={proposal.path} className="text-13">
            {proposal.key}
          </AssistantLink>
        </p>
        {!done && (
          <button
            type="button"
            onClick={() => setEditing((value) => !value)}
            className="text-11 text-tertiary hover:text-primary"
          >
            {t(editing ? "assistant.work_items.see_preview" : "assistant.work_items.edit")}
          </button>
        )}
      </div>
      <p className="truncate text-11 text-tertiary">{proposal.name}</p>
      {editing ? (
        <textarea
          value={markdown}
          rows={5}
          onChange={(event) => setMarkdown(event.target.value)}
          aria-label={t("assistant.work_items.comment")}
          className={cn(FIELD, "mt-1.5 [field-sizing:content] max-h-72 min-h-24 resize-y text-12")}
        />
      ) : (
        <div className="mt-1.5 max-h-60 overflow-auto rounded-md border border-subtle px-2.5 py-2">
          <div
            className={PREVIEW}
            // Escaped by the converter before any tag is added.
            // oxlint-disable-next-line react/no-danger
            dangerouslySetInnerHTML={{ __html: previewHtml }}
          />
        </div>
      )}
      <Footer
        outcome={outcome}
        busy={busy}
        doneLabel={t("assistant.work_items.commented", { key: proposal.key ?? "" })}
        applyLabel={t("assistant.work_items.publish")}
        disabled={!markdown.trim()}
        onApply={() => void apply({ kind: "COMMENT_WORK_ITEM", issue_id: proposal.issue_id, markdown })}
        onDiscard={() => remember({ state: "discarded" })}
        onUndo={() => void undo()}
      />
    </div>
  );
}

export const WorkItemCommentCard = makeAssistantToolUI<Record<string, unknown>, TCommentProposal>({
  toolName: "propose_work_item_comment",
  render: function WorkItemCommentRender({ result, status, toolCallId }) {
    const { t } = useTranslation();
    if (status.type === "running" || !result) {
      return <TraceLine live icon={MessageSquare} label={t("assistant.steps.propose_work_item_comment.running")} />;
    }
    if (result.error || !result.issue_id || !result.workspace_slug) {
      return <p className="text-12 text-tertiary">{result.error ?? t("assistant.actions.failed")}</p>;
    }
    return <CommentForm proposal={result} toolCallId={toolCallId} />;
  },
});
