/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * Cards for changes the assistant proposes: tag or untag items in bulk, and
 * create a work item with references. Everything is editable before it is
 * applied (with the user's own session) and every change can be undone.
 */

import { useMemo, useState } from "react";
import { makeAssistantToolUI } from "@assistant-ui/react";
import { Check, ListTodo, Tag, Undo2, X } from "lucide-react";
import { observer } from "mobx-react";
import { mutate as mutateGlobal } from "swr";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TEntityName } from "@plane/types";
import { cn } from "@plane/utils";
import { ENTITY_ICONS, entityGroupKey } from "@/components/references/entity-meta";
import { useMember } from "@/hooks/store/use-member";
import { useProject } from "@/hooks/store/use-project";
import { assistantService } from "@/services/assistant.service";
import { AssistantLink } from "./links";
import { outcomeFromAction, setServerOutcome, useChatId, useServerOutcome } from "./outcome-store";
import type { TOutcome } from "./outcome-store";
import { TraceLine } from "./steps";

export const CARD = "min-w-0 rounded-lg border border-subtle bg-layer-1 p-3";
export const FIELD =
  "w-full rounded-md border border-subtle bg-transparent px-2 py-1.5 text-12 text-primary outline-none focus:border-accent-strong";

/**
 * Card outcome per tool call. The server's record wins (a card applied in
 * another tab shows as applied); sessionStorage only caches it. The third
 * value goes with every apply: the server refuses to apply a card twice.
 */
export function useOutcome(key: string) {
  const toolCallId = key.slice(key.indexOf(":") + 1);
  const chatId = useChatId();
  const server = useServerOutcome(toolCallId);
  const [local, setLocal] = useState<TOutcome>(() => {
    try {
      return JSON.parse(sessionStorage.getItem(key) ?? "null") ?? { state: "idle" };
    } catch {
      return { state: "idle" };
    }
  });
  const remember = (next: TOutcome) => {
    setLocal(next);
    if (next.state === "applied" || next.state === "undone") setServerOutcome(toolCallId, next);
    try {
      sessionStorage.setItem(key, JSON.stringify(next));
    } catch {
      // The outcome then lasts for this page only.
    }
  };
  const outcome = local.state === "busy" || !server ? local : server;
  const meta = { tool_call_id: toolCallId, chat_id: chatId() ?? undefined };
  return [outcome, remember, meta] as const;
}

export const alreadyUndone = (error: unknown) => /already undone/i.test(errorText(error, ""));

export const errorText = (error: unknown, fallback: string) => {
  const failure = error as { error?: string; response?: { data?: { error?: string } } };
  return failure?.response?.data?.error ?? failure?.error ?? fallback;
};

export function Footer({
  outcome,
  busy,
  doneLabel,
  onApply,
  onDiscard,
  onUndo,
  applyLabel,
  disabled,
  extra,
}: {
  outcome: TOutcome;
  busy: boolean;
  doneLabel: string;
  onApply: () => void;
  onDiscard: () => void;
  onUndo: () => void;
  applyLabel: string;
  disabled?: boolean;
  extra?: React.ReactNode;
}) {
  const { t } = useTranslation();
  if (outcome.state === "applied" || (busy && outcome.id)) {
    return (
      <div className="mt-2.5 flex items-center gap-2">
        <p className="flex min-w-0 flex-1 items-center gap-1.5 text-12 text-success-primary">
          <Check className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">{doneLabel}</span>
          {extra}
        </p>
        <Button variant="secondary" size="sm" loading={busy} onClick={onUndo}>
          <Undo2 className="size-3" />
          {t("assistant.actions.undo")}
        </Button>
      </div>
    );
  }
  if (outcome.state === "undone" || outcome.state === "discarded") {
    return (
      <p className="mt-2.5 flex items-center gap-1.5 text-12 text-tertiary">
        <X className="size-3.5" />
        {t(outcome.state === "undone" ? "assistant.actions.undone" : "assistant.actions.discarded")}
      </p>
    );
  }
  return (
    <div className="mt-2.5 flex justify-end gap-1.5">
      <Button variant="secondary" size="sm" disabled={busy} onClick={onDiscard}>
        {t("assistant.actions.discard")}
      </Button>
      <Button variant="primary" size="sm" loading={busy} disabled={disabled} onClick={onApply}>
        {applyLabel}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------- tagging

type TTaggingProposal = {
  action?: "add" | "remove";
  tag?: { id?: string; name: string; is_new: boolean };
  items?: { entity_name: TEntityName; id: string; title?: string }[];
  workspace_slug?: string;
  error?: string;
};

const keyOf = (item: { entity_name: string; id: string }) => `${item.entity_name}:${item.id}`;

const refreshTags = () =>
  mutateGlobal((key) => Array.isArray(key) && /^(SHARED_TAG|FILE_TAG|MUSIC)/.test(String(key[0])));

export const TaggingCard = makeAssistantToolUI<Record<string, unknown>, TTaggingProposal>({
  toolName: "propose_tagging",
  render: function TaggingRender({ result, status, toolCallId }) {
    const { t } = useTranslation();
    const [outcome, remember, meta] = useOutcome(`assistant-tagging:${toolCallId}`);
    const [excluded, setExcluded] = useState<Set<string>>(new Set());
    if (status.type === "running" || !result) {
      return <TraceLine live icon={Tag} label={t("assistant.steps.propose_tagging.running")} />;
    }
    if (result.error || !result.tag || !result.items?.length || !result.workspace_slug) {
      return <p className="text-12 text-tertiary">{result.error ?? t("assistant.actions.failed")}</p>;
    }
    const slug = result.workspace_slug;
    const removing = result.action === "remove";
    const chosen = result.items.filter((item) => !excluded.has(keyOf(item)));
    const busy = outcome.state === "busy";
    const done = outcome.state !== "idle" && outcome.state !== "busy";

    const apply = async () => {
      remember({ state: "busy" });
      try {
        const action = await assistantService.createAction(slug, {
          ...meta,
          kind: removing ? "UNTAG_ITEMS" : "TAG_ITEMS",
          tag_id: result.tag!.id,
          tag_name: result.tag!.is_new ? result.tag!.name : undefined,
          items: chosen.map(({ entity_name, id }) => ({ entity_name, id })),
        });
        remember(outcomeFromAction(action));
        void refreshTags();
      } catch (error) {
        remember({ state: "idle" });
        setToast({ type: TOAST_TYPE.ERROR, title: errorText(error, t("assistant.actions.failed")) });
      }
    };
    const undo = async () => {
      if (!outcome.id) return;
      remember({ ...outcome, state: "busy" });
      try {
        await assistantService.undoAction(slug, outcome.id);
        remember({ state: "undone", id: outcome.id });
        void refreshTags();
      } catch (error) {
        // Already undone from the history view: the card just catches up.
        if (alreadyUndone(error)) remember({ state: "undone", id: outcome.id });
        else {
          remember({ ...outcome, state: "applied" });
          setToast({ type: TOAST_TYPE.ERROR, title: errorText(error, t("assistant.actions.failed")) });
        }
      }
    };

    const changed = ((outcome.result?.changed as unknown[]) ?? []).length;
    return (
      <div className={CARD}>
        <div className="flex items-center gap-2">
          <Tag className="size-4 shrink-0 text-tertiary" aria-hidden />
          <p className="min-w-0 flex-1 truncate text-13 font-medium text-primary">
            {t(removing ? "assistant.actions.untag_title" : "assistant.actions.tag_title", { tag: result.tag.name })}
          </p>
          {result.tag.is_new && (
            <span className="shrink-0 rounded-sm bg-layer-2 px-1.5 py-0.5 text-10 text-secondary">
              {t("assistant.actions.new_tag")}
            </span>
          )}
        </div>
        <ul className="mt-2 max-h-56 space-y-0.5 overflow-y-auto">
          {result.items.map((item) => {
            const Icon = ENTITY_ICONS[item.entity_name];
            const checked = !excluded.has(keyOf(item));
            return (
              <li key={keyOf(item)}>
                <label
                  className={cn(
                    "flex items-center gap-2 rounded-md px-1.5 py-1 text-12",
                    done ? "cursor-default" : "cursor-pointer hover:bg-layer-1-hover"
                  )}
                >
                  <input
                    type="checkbox"
                    className="accent-accent-primary"
                    checked={checked}
                    disabled={done || busy}
                    onChange={() =>
                      setExcluded((set) => {
                        const next = new Set(set);
                        if (checked) next.add(keyOf(item));
                        else next.delete(keyOf(item));
                        return next;
                      })
                    }
                  />
                  {Icon && <Icon className="size-3.5 shrink-0 text-tertiary" aria-hidden />}
                  <span
                    className={cn("min-w-0 flex-1 truncate", checked ? "text-primary" : "text-tertiary line-through")}
                  >
                    {item.title ?? item.id}
                  </span>
                  <span className="shrink-0 text-11 text-tertiary">{t(entityGroupKey(item.entity_name))}</span>
                </label>
              </li>
            );
          })}
        </ul>
        <Footer
          outcome={outcome}
          busy={busy}
          doneLabel={t("assistant.actions.tagged", { count: changed })}
          applyLabel={t(removing ? "assistant.actions.untag_apply" : "assistant.actions.tag_apply", {
            count: chosen.length,
          })}
          disabled={chosen.length === 0}
          onApply={() => void apply()}
          onDiscard={() => remember({ state: "discarded" })}
          onUndo={() => void undo()}
        />
      </div>
    );
  },
});

// -------------------------------------------------------------- work item

type TWorkItemProposal = {
  name?: string;
  description?: string;
  project?: string;
  assignee?: string;
  priority?: "urgent" | "high" | "medium" | "low" | "none";
  due_date?: string;
  references?: { entity_name: TEntityName; id: string; title?: string }[];
  workspace_slug?: string;
};

const PRIORITIES = ["none", "low", "medium", "high", "urgent"] as const;
export const fold = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();

const WorkItemForm = observer(function WorkItemForm({
  proposal,
  toolCallId,
}: {
  proposal: TWorkItemProposal;
  toolCallId: string;
}) {
  const { t } = useTranslation();
  const slug = proposal.workspace_slug!;
  const { joinedProjectIds, getProjectById } = useProject();
  const memberRoot = useMember();
  const [outcome, remember, meta] = useOutcome(`assistant-work-item:${toolCallId}`);

  const projects = useMemo(
    () => joinedProjectIds.map((id) => getProjectById(id)).filter((project) => !!project && !project.archived_at),
    [joinedProjectIds, getProjectById]
  );
  const memberIds = memberRoot.workspace.getWorkspaceMemberIds(slug) ?? [];
  const members = memberIds
    .map((id) => memberRoot.getUserDetails(id))
    .filter((user): user is NonNullable<typeof user> => !!user);

  // The assistant's guesses (project and person by name) become the defaults.
  const guessProject = () => {
    const wanted = fold(proposal.project ?? "");
    const match = wanted
      ? (projects.find((project) => fold(project!.name) === wanted || fold(project!.identifier) === wanted) ??
        projects.find((project) => fold(project!.name).includes(wanted)))
      : undefined;
    return (match ?? projects[0])?.id ?? "";
  };
  const guessAssignee = () => {
    const wanted = fold(proposal.assignee ?? "");
    if (!wanted) return "";
    const match = members.find((user) =>
      [user.display_name, `${user.first_name ?? ""} ${user.last_name ?? ""}`].some((name) =>
        fold(name ?? "").includes(wanted)
      )
    );
    return match?.id ?? "";
  };

  const [name, setName] = useState(proposal.name ?? "");
  const [description, setDescription] = useState(proposal.description ?? "");
  const [projectId, setProjectId] = useState<string>(guessProject);
  const [assigneeId, setAssigneeId] = useState<string>(guessAssignee);
  const [priority, setPriority] = useState<string>(proposal.priority ?? "none");
  const [dueDate, setDueDate] = useState(proposal.due_date ?? "");
  const [references, setReferences] = useState(proposal.references ?? []);
  const busy = outcome.state === "busy";
  const done = outcome.state !== "idle" && outcome.state !== "busy";

  const apply = async () => {
    remember({ state: "busy" });
    try {
      const action = await assistantService.createAction(slug, {
        ...meta,
        kind: "CREATE_WORK_ITEM",
        project_id: projectId,
        name,
        description,
        priority,
        assignee_ids: assigneeId ? [assigneeId] : [],
        target_date: dueDate || undefined,
        references: references.map(({ entity_name, id }) => ({ entity_name, id })),
      });
      remember(outcomeFromAction(action));
    } catch (error) {
      remember({ state: "idle" });
      setToast({ type: TOAST_TYPE.ERROR, title: errorText(error, t("assistant.actions.failed")) });
    }
  };
  const undo = async () => {
    if (!outcome.id) return;
    remember({ ...outcome, state: "busy" });
    try {
      await assistantService.undoAction(slug, outcome.id);
      remember({ state: "undone", id: outcome.id });
    } catch (error) {
      if (alreadyUndone(error)) remember({ state: "undone", id: outcome.id });
      else {
        remember({ ...outcome, state: "applied" });
        setToast({ type: TOAST_TYPE.ERROR, title: errorText(error, t("assistant.actions.failed")) });
      }
    }
  };

  const created = outcome.result as { key?: string; path?: string; name?: string } | undefined;
  return (
    <div className={CARD}>
      <div className="flex items-center gap-2">
        <ListTodo className="size-4 shrink-0 text-tertiary" aria-hidden />
        <p className="min-w-0 flex-1 truncate text-13 font-medium text-primary">
          {t("assistant.actions.work_item_title")}
        </p>
      </div>
      {done ? (
        <p className="mt-2 text-13 break-words text-primary">{created?.name ?? name}</p>
      ) : (
        <div className="mt-2 space-y-1.5">
          <input
            value={name}
            maxLength={255}
            onChange={(event) => setName(event.target.value)}
            aria-label={t("assistant.actions.fields.name")}
            placeholder={t("assistant.actions.fields.name")}
            className={cn(FIELD, "text-13 font-medium")}
          />
          <textarea
            value={description}
            rows={3}
            onChange={(event) => setDescription(event.target.value)}
            aria-label={t("assistant.actions.fields.description")}
            placeholder={t("assistant.actions.fields.description")}
            className={cn(FIELD, "[field-sizing:content] max-h-48 min-h-16 resize-y")}
          />
          <div className="grid grid-cols-2 gap-1.5">
            <select
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
              aria-label={t("assistant.actions.fields.project")}
              className={FIELD}
            >
              {projects.length === 0 && <option value="">{t("assistant.actions.no_projects")}</option>}
              {projects.map((project) => (
                <option key={project!.id} value={project!.id}>
                  {project!.identifier} · {project!.name}
                </option>
              ))}
            </select>
            <select
              value={assigneeId}
              onChange={(event) => setAssigneeId(event.target.value)}
              aria-label={t("assistant.actions.fields.assignee")}
              className={FIELD}
            >
              <option value="">{t("assistant.actions.fields.no_assignee")}</option>
              {members.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.display_name}
                </option>
              ))}
            </select>
            <select
              value={priority}
              onChange={(event) => setPriority(event.target.value)}
              aria-label={t("assistant.actions.fields.priority")}
              className={FIELD}
            >
              {PRIORITIES.map((value) => (
                <option key={value} value={value}>
                  {t(`assistant.actions.priorities.${value}`)}
                </option>
              ))}
            </select>
            <input
              type="date"
              value={dueDate}
              onChange={(event) => setDueDate(event.target.value)}
              aria-label={t("assistant.actions.fields.due_date")}
              title={t("assistant.actions.fields.due_date")}
              className={FIELD}
            />
          </div>
        </div>
      )}
      {references.length > 0 && (
        <div className="mt-2">
          <p className="text-11 text-tertiary">{t("assistant.actions.fields.references")}</p>
          <div className="mt-1 flex flex-wrap gap-1">
            {references.map((item) => {
              const Icon = ENTITY_ICONS[item.entity_name];
              return (
                <span
                  key={`${item.entity_name}:${item.id}`}
                  className="inline-flex max-w-full items-center gap-1 rounded-sm bg-accent-primary/10 px-1.5 py-0.5 text-11 text-accent-primary"
                >
                  {Icon && <Icon className="size-3 shrink-0" aria-hidden />}
                  <span className="truncate">{item.title ?? item.id}</span>
                  {!done && (
                    <button
                      type="button"
                      onClick={() => setReferences((list) => list.filter((entry) => entry !== item))}
                      aria-label={t("assistant.actions.remove_reference")}
                      className="rounded-sm hover:bg-accent-primary/20"
                    >
                      <X className="size-3" />
                    </button>
                  )}
                </span>
              );
            })}
          </div>
        </div>
      )}
      <Footer
        outcome={outcome}
        busy={busy}
        doneLabel={t("assistant.actions.created", { key: created?.key ?? "" })}
        extra={
          created?.path ? (
            <AssistantLink href={created.path} className="shrink-0 text-12">
              {t("assistant.actions.open")}
            </AssistantLink>
          ) : null
        }
        applyLabel={t("assistant.actions.create")}
        disabled={!name.trim() || !projectId}
        onApply={() => void apply()}
        onDiscard={() => remember({ state: "discarded" })}
        onUndo={() => void undo()}
      />
    </div>
  );
});

export const WorkItemCard = makeAssistantToolUI<Record<string, unknown>, TWorkItemProposal>({
  toolName: "propose_work_item",
  render: function WorkItemRender({ result, status, toolCallId }) {
    const { t } = useTranslation();
    if (status.type === "running" || !result) {
      return <TraceLine live icon={ListTodo} label={t("assistant.steps.propose_work_item.running")} />;
    }
    if (!result.workspace_slug) return <p className="text-12 text-tertiary">{t("assistant.actions.failed")}</p>;
    return <WorkItemForm proposal={result} toolCallId={toolCallId} />;
  },
});
