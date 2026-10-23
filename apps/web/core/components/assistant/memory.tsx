/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * The workspace memory: what the assistant always keeps in mind for everyone
 * (official spellings, owners, rules, glossary). The assistant proposes from
 * what a user said; an admin saves it, members can only suggest. Nothing is
 * deleted: a correction replaces the old memory, which stays archived.
 */

import { useState } from "react";
import { makeAssistantToolUI } from "@assistant-ui/react";
import { ArrowLeft, Brain, Check, Pin, PinOff, Plus, Quote, RotateCcw, Undo2, X } from "lucide-react";
import useSWR, { mutate as mutateGlobal } from "swr";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import { cn } from "@plane/utils";
import { assistantService } from "@/services/assistant.service";
import type { TAssistantMemory, TAssistantMemoryInput, TAssistantMemoryKind } from "@/services/assistant.service";
import { TraceLine } from "./steps";

const KINDS: TAssistantMemoryKind[] = ["FACT", "RULE", "GLOSSARY", "OWNER", "CONTEXT"];
const CARD = "min-w-0 rounded-lg border border-subtle bg-layer-1 p-3";
const FIELD =
  "w-full rounded-md border border-subtle bg-transparent px-2 py-1.5 text-12 text-primary outline-none focus:border-accent-strong";

const refreshMemories = () =>
  mutateGlobal((key) => Array.isArray(key) && key[0] === "ASSISTANT_MEMORIES", undefined, { revalidate: true });

const splitAliases = (value: string) =>
  value
    .split(",")
    .map((alias) => alias.trim())
    .filter(Boolean);

function KindBadge({ kind }: { kind: TAssistantMemoryKind }) {
  const { t } = useTranslation();
  return (
    <span className="shrink-0 rounded-sm bg-layer-2 px-1.5 py-0.5 text-10 font-medium text-secondary">
      {t(`assistant.memory.kinds.${kind.toLowerCase()}`)}
    </span>
  );
}

// ------------------------------------------------------------------- card

type TProposal = {
  kind?: TAssistantMemoryKind;
  content?: string;
  aliases?: string[];
  entities?: { entity_name: string; id: string }[];
  valid_until?: string;
  evidence?: string;
  similar?: { id: string; kind: TAssistantMemoryKind; content: string }[];
  can_save?: boolean;
  workspace_slug?: string;
  error?: string;
};

type TCardState = { state: "idle" | "busy" | "saved" | "suggested" | "undone" | "discarded"; id?: string };

export const ProposeMemoryCard = makeAssistantToolUI<Record<string, unknown>, TProposal>({
  toolName: "propose_memory",
  render: function ProposeMemoryRender({ result, status, toolCallId }) {
    const { t } = useTranslation();
    const storageKey = `assistant-memory:${toolCallId}`;
    const [outcome, setOutcome] = useState<TCardState>(() => {
      try {
        return JSON.parse(sessionStorage.getItem(storageKey) ?? "null") ?? { state: "idle" };
      } catch {
        return { state: "idle" };
      }
    });
    const [content, setContent] = useState<string | null>(null);
    const [replaces, setReplaces] = useState<string | null>(null);
    const remember = (next: TCardState) => {
      setOutcome(next);
      try {
        sessionStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        // The outcome then lasts for this page only.
      }
    };

    if (status.type === "running" || !result) {
      return <TraceLine live icon={Brain} label={t("assistant.steps.propose_memory.running")} />;
    }
    if (result.error || !result.content || !result.workspace_slug) {
      return <p className="text-12 text-tertiary">{result.error ?? t("assistant.memory.failed")}</p>;
    }
    const slug = result.workspace_slug;
    const text = content ?? result.content;
    const busy = outcome.state === "busy";

    const save = async () => {
      remember({ state: "busy" });
      try {
        const saved = await assistantService.createMemory(slug, {
          kind: result.kind,
          content: text,
          aliases: result.aliases,
          entities: result.entities,
          valid_until: result.valid_until ?? null,
          evidence: result.evidence,
          supersedes: replaces,
          source: "ASSISTANT",
        });
        remember({ state: saved.status === "ACTIVE" ? "saved" : "suggested", id: saved.id });
        void refreshMemories();
      } catch {
        remember({ state: "idle" });
        setToast({ type: TOAST_TYPE.ERROR, title: t("assistant.memory.failed") });
      }
    };
    const undo = async () => {
      if (!outcome.id) return;
      remember({ ...outcome, state: "busy" });
      try {
        await assistantService.updateMemory(slug, outcome.id, { status: "ARCHIVED" });
        remember({ state: "undone", id: outcome.id });
        void refreshMemories();
      } catch {
        remember({ ...outcome, state: "saved" });
        setToast({ type: TOAST_TYPE.ERROR, title: t("assistant.memory.failed") });
      }
    };

    const done = ["saved", "suggested", "undone", "discarded"].includes(outcome.state) || (busy && outcome.id);
    return (
      <div className={CARD}>
        <div className="flex items-center gap-2">
          <Brain className="size-4 shrink-0 text-tertiary" aria-hidden />
          <p className="min-w-0 flex-1 truncate text-13 font-medium text-primary">{t("assistant.memory.card_title")}</p>
          {result.kind && <KindBadge kind={result.kind} />}
        </div>
        {done ? (
          <p className="mt-2 text-13 text-primary">{text}</p>
        ) : (
          <textarea
            value={text}
            maxLength={300}
            rows={2}
            onChange={(event) => setContent(event.target.value)}
            aria-label={t("assistant.memory.content")}
            className={cn(FIELD, "mt-2 resize-none text-13")}
          />
        )}
        {(result.aliases?.length ?? 0) > 0 && (
          <p className="mt-1 text-11 text-tertiary">
            {t("assistant.memory.aliases")}: {result.aliases!.join(", ")}
          </p>
        )}
        {result.valid_until && (
          <p className="mt-1 text-11 text-tertiary">
            {t("assistant.memory.valid_until_value", { date: result.valid_until })}
          </p>
        )}
        {result.evidence && (
          <p className="mt-1.5 flex items-start gap-1 text-11 text-tertiary">
            <Quote className="mt-0.5 size-3 shrink-0" aria-hidden />
            <span className="min-w-0 break-words">{result.evidence}</span>
          </p>
        )}
        {!done && (result.similar?.length ?? 0) > 0 && (
          <fieldset className="mt-2 rounded-md bg-layer-2 px-2.5 py-2">
            <legend className="sr-only">{t("assistant.memory.similar")}</legend>
            <p className="text-11 text-tertiary">{t("assistant.memory.similar")}</p>
            {result.similar!.map((memory) => (
              <label key={memory.id} className="mt-1 flex cursor-pointer items-start gap-2 text-12 text-secondary">
                <input
                  type="checkbox"
                  className="accent-accent-primary mt-0.5"
                  checked={replaces === memory.id}
                  onChange={() => setReplaces(replaces === memory.id ? null : memory.id)}
                />
                <span className="min-w-0 break-words">
                  {t("assistant.memory.replace")} «{memory.content}»
                </span>
              </label>
            ))}
          </fieldset>
        )}

        {outcome.state === "saved" || (busy && outcome.id) ? (
          <div className="mt-2.5 flex items-center gap-2">
            <p className="flex min-w-0 flex-1 items-center gap-1.5 text-12 text-success-primary">
              <Check className="size-3.5 shrink-0" />
              {t("assistant.memory.saved")}
            </p>
            <Button variant="secondary" size="sm" loading={busy} onClick={() => void undo()}>
              <Undo2 className="size-3" />
              {t("assistant.memory.undo")}
            </Button>
          </div>
        ) : outcome.state === "suggested" ? (
          <p className="mt-2.5 flex items-center gap-1.5 text-12 text-success-primary">
            <Check className="size-3.5" />
            {t("assistant.memory.suggested")}
          </p>
        ) : outcome.state === "undone" || outcome.state === "discarded" ? (
          <p className="mt-2.5 flex items-center gap-1.5 text-12 text-tertiary">
            <X className="size-3.5" />
            {t(outcome.state === "undone" ? "assistant.memory.undone" : "assistant.memory.discarded")}
          </p>
        ) : (
          <>
            <p className="mt-2.5 text-11 text-tertiary">
              {result.can_save ? t("assistant.memory.note_admin") : t("assistant.memory.note_member")}
            </p>
            <div className="mt-2 flex justify-end gap-1.5">
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => remember({ state: "discarded" })}>
                {t("assistant.memory.discard")}
              </Button>
              <Button variant="primary" size="sm" loading={busy} disabled={!text.trim()} onClick={() => void save()}>
                {result.can_save ? t("assistant.memory.save") : t("assistant.memory.suggest")}
              </Button>
            </div>
          </>
        )}
      </div>
    );
  },
});

// ------------------------------------------------------------------- view

type TTab = "active" | "proposed" | "archived";

function MemoryForm({
  initial,
  canEdit,
  onSubmit,
  onCancel,
}: {
  initial?: TAssistantMemory;
  canEdit: boolean;
  onSubmit: (data: TAssistantMemoryInput) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<TAssistantMemoryKind>(initial?.kind ?? "FACT");
  const [content, setContent] = useState(initial?.content ?? "");
  const [aliases, setAliases] = useState((initial?.aliases ?? []).join(", "));
  const [validUntil, setValidUntil] = useState(initial?.valid_until ?? "");
  const [pinned, setPinned] = useState(initial?.pinned ?? false);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await onSubmit({
        kind,
        content,
        aliases: splitAliases(aliases),
        valid_until: validUntil || null,
        ...(canEdit ? { pinned } : {}),
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="space-y-2 rounded-lg border border-subtle bg-layer-1 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="flex gap-2">
        <select
          value={kind}
          onChange={(event) => setKind(event.target.value as TAssistantMemoryKind)}
          aria-label={t("assistant.memory.kind")}
          className={cn(FIELD, "w-auto")}
        >
          {KINDS.map((value) => (
            <option key={value} value={value}>
              {t(`assistant.memory.kinds.${value.toLowerCase()}`)}
            </option>
          ))}
        </select>
        <input
          type="date"
          value={validUntil}
          onChange={(event) => setValidUntil(event.target.value)}
          aria-label={t("assistant.memory.valid_until")}
          title={t("assistant.memory.valid_until")}
          className={cn(FIELD, "min-w-0 flex-1")}
        />
      </div>
      <textarea
        value={content}
        maxLength={300}
        rows={2}
        onChange={(event) => setContent(event.target.value)}
        placeholder={t("assistant.memory.content_placeholder")}
        aria-label={t("assistant.memory.content")}
        className={cn(FIELD, "resize-none text-13")}
      />
      <input
        value={aliases}
        onChange={(event) => setAliases(event.target.value)}
        placeholder={t("assistant.memory.aliases_placeholder")}
        aria-label={t("assistant.memory.aliases")}
        className={FIELD}
      />
      <div className="flex items-center gap-2">
        {canEdit && (
          <label className="flex cursor-pointer items-center gap-1.5 text-12 text-secondary">
            <input
              type="checkbox"
              className="accent-accent-primary"
              checked={pinned}
              onChange={(event) => setPinned(event.target.checked)}
            />
            {t("assistant.memory.pin_always")}
          </label>
        )}
        <div className="ml-auto flex gap-1.5">
          <Button type="button" variant="secondary" size="sm" onClick={onCancel}>
            {t("cancel")}
          </Button>
          <Button type="submit" variant="primary" size="sm" loading={busy} disabled={!content.trim()}>
            {canEdit ? t("assistant.memory.save") : t("assistant.memory.suggest")}
          </Button>
        </div>
      </div>
    </form>
  );
}

function MemoryRow({
  memory,
  canEdit,
  onChange,
}: {
  memory: TAssistantMemory;
  canEdit: boolean;
  onChange: (id: string, data: TAssistantMemoryInput) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const expired = memory.valid_until ? memory.valid_until < new Date().toISOString().slice(0, 10) : false;
  if (editing) {
    return (
      <li>
        <MemoryForm
          initial={memory}
          canEdit={canEdit}
          onCancel={() => setEditing(false)}
          onSubmit={async (data) => {
            await onChange(memory.id, data);
            setEditing(false);
          }}
        />
      </li>
    );
  }
  return (
    <li className="group/memory rounded-lg border border-subtle px-3 py-2">
      <div className="flex items-start gap-2">
        <KindBadge kind={memory.kind} />
        <p className="min-w-0 flex-1 text-13 break-words text-primary">
          {canEdit ? (
            <button type="button" className="text-left hover:underline" onClick={() => setEditing(true)}>
              {memory.content}
            </button>
          ) : (
            memory.content
          )}
        </p>
        {memory.pinned && (
          <Pin className="mt-0.5 size-3.5 shrink-0 text-accent-primary" aria-label={t("assistant.memory.pinned")} />
        )}
      </div>
      <p className="mt-1 text-11 text-tertiary">
        {[
          memory.aliases.length > 0 ? `${t("assistant.memory.aliases")}: ${memory.aliases.join(", ")}` : "",
          memory.valid_until
            ? expired
              ? t("assistant.memory.expired", { date: memory.valid_until })
              : t("assistant.memory.valid_until_value", { date: memory.valid_until })
            : "",
          memory.status === "ACTIVE" ? t("assistant.memory.used", { count: memory.use_count }) : "",
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
      {memory.evidence && (
        <p className="mt-1 flex items-start gap-1 text-11 text-tertiary">
          <Quote className="mt-0.5 size-3 shrink-0" aria-hidden />
          <span className="min-w-0 break-words">{memory.evidence}</span>
        </p>
      )}
      {canEdit && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {memory.status === "PROPOSED" && (
            <>
              <Button variant="primary" size="sm" onClick={() => void onChange(memory.id, { status: "ACTIVE" })}>
                <Check className="size-3" />
                {t("assistant.memory.approve")}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => void onChange(memory.id, { status: "REJECTED" })}>
                {t("assistant.memory.reject")}
              </Button>
            </>
          )}
          {memory.status === "ACTIVE" && (
            <>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void onChange(memory.id, { pinned: !memory.pinned })}
              >
                {memory.pinned ? <PinOff className="size-3" /> : <Pin className="size-3" />}
                {memory.pinned ? t("assistant.memory.unpin") : t("assistant.memory.pin")}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => void onChange(memory.id, { status: "ARCHIVED" })}>
                {t("assistant.memory.archive")}
              </Button>
            </>
          )}
          {(memory.status === "ARCHIVED" || memory.status === "REJECTED") && (
            <Button variant="secondary" size="sm" onClick={() => void onChange(memory.id, { status: "ACTIVE" })}>
              <RotateCcw className="size-3" />
              {t("assistant.memory.restore")}
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

/** Inside the assistant panel: browse and edit the workspace memory. */
export function MemoryView({ workspaceSlug, onBack }: { workspaceSlug: string; onBack: () => void }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<TTab>("active");
  const [adding, setAdding] = useState(false);
  const { data, mutate } = useSWR(["ASSISTANT_MEMORIES", workspaceSlug, tab], () =>
    assistantService.getMemories(workspaceSlug, tab)
  );
  const { data: proposed } = useSWR(["ASSISTANT_MEMORIES", workspaceSlug, "proposed"], () =>
    assistantService.getMemories(workspaceSlug, "proposed")
  );
  const canEdit = data?.can_edit ?? false;

  const run = async (action: () => Promise<unknown>) => {
    try {
      await action();
      await mutate();
      void refreshMemories();
    } catch (error) {
      const failure = error as { error?: string; response?: { data?: { error?: string } } };
      const message = failure?.response?.data?.error ?? failure?.error;
      setToast({ type: TOAST_TYPE.ERROR, title: message ?? t("assistant.memory.failed") });
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-subtle px-3 py-2">
        <button
          type="button"
          onClick={onBack}
          className="rounded-md p-1 text-tertiary hover:bg-layer-1-hover hover:text-secondary"
          aria-label={t("assistant.memory.back")}
          title={t("assistant.memory.back")}
        >
          <ArrowLeft className="size-4" />
        </button>
        <p className="min-w-0 flex-1 truncate text-13 font-medium text-primary">{t("assistant.memory.title")}</p>
        {!adding && (
          <Button variant="secondary" size="sm" onClick={() => setAdding(true)}>
            <Plus className="size-3" />
            {canEdit ? t("assistant.memory.add") : t("assistant.memory.suggest")}
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
        <p className="text-12 text-tertiary">
          {canEdit ? t("assistant.memory.intro_admin") : t("assistant.memory.intro_member")}
        </p>
        {adding && (
          <MemoryForm
            canEdit={canEdit}
            onCancel={() => setAdding(false)}
            onSubmit={async (input) => {
              await run(() => assistantService.createMemory(workspaceSlug, input));
              setAdding(false);
            }}
          />
        )}
        <div role="tablist" className="flex gap-1">
          {(["active", "proposed", "archived"] as TTab[]).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              onClick={() => setTab(value)}
              className={cn(
                "rounded-md px-2.5 py-1 text-12",
                tab === value ? "bg-layer-2 font-medium text-primary" : "text-tertiary hover:text-secondary"
              )}
            >
              {t(`assistant.memory.tabs.${value}`)}
              {value === "proposed" && (proposed?.memories.length ?? 0) > 0 && (
                <span className="ml-1 rounded-full bg-accent-primary px-1.5 text-10 text-on-color">
                  {proposed!.memories.length}
                </span>
              )}
            </button>
          ))}
        </div>
        {!data ? null : data.memories.length === 0 ? (
          <p className="py-6 text-center text-12 text-tertiary">{t(`assistant.memory.empty.${tab}`)}</p>
        ) : (
          <ul className="space-y-2">
            {data.memories.map((memory) => (
              <MemoryRow
                key={memory.id}
                memory={memory}
                canEdit={canEdit}
                onChange={(id, input) => run(() => assistantService.updateMemory(workspaceSlug, id, input))}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
