/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * The assistant inside its panel: header (conversation, history, new chat,
 * close), the thread, and what the assistant knows about the current page.
 *
 * Conversations live on the server, per user. Each one mounts its own chat
 * runtime (keyed), since the AI SDK treats `messages` as initial state; the
 * transcript is saved once a run settles.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { observer } from "mobx-react";
import { Popover, Transition } from "@headlessui/react";
import { AssistantRuntimeProvider, CompositeAttachmentAdapter } from "@assistant-ui/react";
import { AssistantChatTransport, useChatRuntime } from "@assistant-ui/react-ai-sdk";
import { Brain, ChevronDown, History, Loader2, Plus, ScrollText, Sparkles, Trash2, X } from "lucide-react";
import useSWR from "swr";
import { EUserPermissions, EUserPermissionsLevel } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import { cn } from "@plane/utils";
import { ENTITY_ICONS, entityLabelKey } from "@/components/references/entity-meta";
import { useEntityCard } from "@/components/references/use-entity-card";
import { useSharedTags } from "@/components/references/use-shared-tags";
import { useWorkspace } from "@/hooks/store/use-workspace";
import { useUserPermissions } from "@/hooks/store/user";
import { assistantService } from "@/services/assistant.service";
import type { TAssistantChat, TAssistantStoredMessage } from "@/services/assistant.service";
import { TaggingCard, WorkItemCard } from "./action-cards";
import { ActionsView } from "./actions-view";
import { DeepReviewCard } from "./deep-review-card";
import { AssistantHelp } from "./help";
import { PageCard, ReportCard } from "./page-card";
import { AssistantAttachmentAdapter } from "./attachments";
import {
  AskUserCard,
  ExportMusicExcelCard,
  PlanMusicImportCard,
  ShowDocumentsCard,
  UpdateMusicTrackCard,
} from "./cards";
import { MemoryView, ProposeMemoryCard } from "./memory";
import { MergeTagsCard, StartTagMappingCard } from "./tag-cards";
import { useAssistantPageContext } from "./page-context";
import type { TAssistantPageContext, TContextItem } from "./page-context";
import { buildTraceToolUIs } from "./steps";
import { AssistantThread } from "./thread";
import { AssistantUsageMeter, turnFromMessage } from "./usage";
import type { TAssistantTurn } from "./usage";

/** Tools without a server-side execute: the run pauses until the user
 * answers in the card, which stores a result and resumes it. */
const HUMAN_INPUT_TOOLS = ["ask_user"];

type TSession = { key: string; chatId: string | null; messages: TAssistantStoredMessage[] };
const newSession = (): TSession => ({ key: `new-${Date.now()}`, chatId: null, messages: [] });

type Props = { workspaceSlug: string; onClose: () => void };

export const AssistantChat = observer(function AssistantChat({ workspaceSlug, onClose }: Props) {
  const { t } = useTranslation();
  const [session, setSession] = useState<TSession>(newSession);
  const [loadingChat, setLoadingChat] = useState(false);
  const [model, setModel] = useState<string | null>(null);
  const [view, setView] = useState<"chat" | "memory" | "actions">("chat");
  const toggleView = (next: "memory" | "actions") => setView((current) => (current === next ? "chat" : next));

  const { data: chats, mutate: mutateChats } = useSWR(["ASSISTANT_CHATS", workspaceSlug], () =>
    assistantService.getChats(workspaceSlug)
  );
  const { data: models } = useSWR(
    ["ASSISTANT_MODELS", workspaceSlug],
    () => assistantService.getModels(workspaceSlug),
    {
      revalidateOnFocus: false,
    }
  );
  const activeModel = model ?? models?.default_model ?? null;
  const current = chats?.find((chat) => chat.id === session.chatId);

  const openChat = async (chatId: string) => {
    setLoadingChat(true);
    try {
      const chat = await assistantService.getChat(workspaceSlug, chatId);
      setSession({ key: chatId, chatId, messages: chat.messages });
    } catch {
      setToast({ type: TOAST_TYPE.ERROR, title: t("assistant.load_failed") });
    } finally {
      setLoadingChat(false);
    }
  };

  const removeChat = async (chatId: string) => {
    try {
      await assistantService.deleteChat(workspaceSlug, chatId);
      if (session.chatId === chatId) setSession(newSession());
      void mutateChats();
    } catch {
      setToast({ type: TOAST_TYPE.ERROR, title: t("assistant.load_failed") });
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-11 shrink-0 items-center gap-1 border-b border-subtle px-2">
        <Sparkles className="ml-1 size-4 shrink-0 text-accent-primary" aria-hidden />
        <HistoryMenu
          title={current?.title || t("assistant.title")}
          chats={chats ?? []}
          activeId={session.chatId}
          onOpen={(chatId) => void openChat(chatId)}
          onDelete={(chatId) => void removeChat(chatId)}
        />
        {loadingChat && <Loader2 className="size-3.5 animate-spin text-tertiary" aria-hidden />}
        <div className="ml-auto flex items-center">
          <button
            type="button"
            onClick={() => toggleView("actions")}
            className={cn(
              "rounded-md p-1.5 hover:bg-layer-1-hover hover:text-secondary",
              view === "actions" ? "bg-layer-1-hover text-accent-primary" : "text-tertiary"
            )}
            title={t("assistant.history_view.title")}
            aria-label={t("assistant.history_view.title")}
            aria-pressed={view === "actions"}
          >
            <ScrollText className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => toggleView("memory")}
            className={cn(
              "rounded-md p-1.5 hover:bg-layer-1-hover hover:text-secondary",
              view === "memory" ? "bg-layer-1-hover text-accent-primary" : "text-tertiary"
            )}
            title={t("assistant.memory.title")}
            aria-label={t("assistant.memory.title")}
            aria-pressed={view === "memory"}
          >
            <Brain className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => {
              setView("chat");
              setSession(newSession());
            }}
            className="rounded-md p-1.5 text-tertiary hover:bg-layer-1-hover hover:text-secondary"
            title={t("assistant.new_chat")}
            aria-label={t("assistant.new_chat")}
          >
            <Plus className="size-4" />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-tertiary hover:bg-layer-1-hover hover:text-secondary"
            title={`${t("assistant.close")} (${t("assistant.shortcut")})`}
            aria-label={t("assistant.close")}
          >
            <X className="size-4" />
          </button>
        </div>
      </header>
      {view === "memory" && (
        <div className="min-h-0 flex-1">
          <MemoryView workspaceSlug={workspaceSlug} onBack={() => setView("chat")} />
        </div>
      )}
      {view === "actions" && (
        <div className="min-h-0 flex-1">
          <ActionsView workspaceSlug={workspaceSlug} onBack={() => setView("chat")} />
        </div>
      )}
      {/* Stays mounted under the other views, so an answer keeps streaming. */}
      <div className={cn("min-h-0 flex-1", view !== "chat" && "hidden")}>
        <ChatSession
          key={session.key}
          session={session}
          workspaceSlug={workspaceSlug}
          model={activeModel}
          onChatCreated={(chatId) => {
            setSession((value) => ({ ...value, chatId }));
            void mutateChats();
          }}
          onSaved={() => void mutateChats()}
          modelPicker={
            (models?.models.length ?? 0) > 1 ? (
              <label className="flex min-w-0 items-center">
                <span className="sr-only">{t("assistant.composer.model")}</span>
                <select
                  value={activeModel ?? ""}
                  onChange={(event) => setModel(event.target.value)}
                  title={t("assistant.composer.model")}
                  className="max-w-full min-w-0 cursor-pointer truncate rounded-md bg-transparent px-1.5 py-1 text-11 text-tertiary outline-none hover:bg-layer-1-hover"
                >
                  {models?.models.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.id}
                    </option>
                  ))}
                </select>
              </label>
            ) : undefined
          }
        />
      </div>
    </div>
  );
});

function HistoryMenu({
  title,
  chats,
  activeId,
  onOpen,
  onDelete,
}: {
  title: string;
  chats: TAssistantChat[];
  activeId: string | null;
  onOpen: (chatId: string) => void;
  onDelete: (chatId: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <Popover className="relative min-w-0">
      <Popover.Button
        className="flex max-w-full min-w-0 items-center gap-1 rounded-md px-1.5 py-1 text-13 font-medium text-primary hover:bg-layer-1-hover"
        title={t("assistant.history")}
      >
        <span className="truncate">{title}</span>
        <ChevronDown className="size-3.5 shrink-0 text-tertiary" aria-hidden />
      </Popover.Button>
      <Transition
        as={Fragment}
        enter="transition duration-100 ease-out"
        enterFrom="opacity-0 -translate-y-1"
        enterTo="opacity-100 translate-y-0"
        leave="transition duration-75 ease-in"
        leaveFrom="opacity-100"
        leaveTo="opacity-0"
      >
        <Popover.Panel className="absolute top-full left-0 z-30 mt-1 w-72 max-w-[calc(100vw-2rem)] rounded-lg border border-strong bg-surface-1 p-1 shadow-raised-200">
          {({ close }) => (
            <>
              <p className="flex items-center gap-1.5 px-2 pt-1 pb-1.5 text-11 font-medium text-tertiary">
                <History className="size-3" aria-hidden />
                {t("assistant.history")}
              </p>
              <ul className="max-h-80 overflow-y-auto">
                {chats.map((chat) => (
                  <li key={chat.id} className="group flex items-center rounded-md hover:bg-layer-1-hover">
                    <button
                      type="button"
                      onClick={() => {
                        onOpen(chat.id);
                        close();
                      }}
                      className={cn(
                        "min-w-0 flex-1 truncate px-2 py-1.5 text-left text-12",
                        chat.id === activeId ? "font-medium text-primary" : "text-secondary"
                      )}
                    >
                      {chat.title || t("assistant.untitled")}
                    </button>
                    <button
                      type="button"
                      onClick={() => onDelete(chat.id)}
                      className="mr-1 shrink-0 rounded-sm p-1 text-tertiary opacity-0 group-hover:opacity-100 hover:text-danger-primary focus:opacity-100"
                      title={t("assistant.delete_chat")}
                      aria-label={t("assistant.delete_chat")}
                    >
                      <Trash2 className="size-3" />
                    </button>
                  </li>
                ))}
                {chats.length === 0 && <li className="px-2 py-3 text-12 text-tertiary">{t("assistant.no_chats")}</li>}
              </ul>
            </>
          )}
        </Popover.Panel>
      </Transition>
    </Popover>
  );
}

type SessionProps = {
  session: TSession;
  workspaceSlug: string;
  model: string | null;
  onChatCreated: (chatId: string) => void;
  onSaved: () => void;
  modelPicker?: ReactNode;
};

const contextKey = (item: TContextItem) => `${item.entity_name}:${item.id}`;

const ChatSession = observer(function ChatSession(props: SessionProps) {
  const { session, workspaceSlug, model, onChatCreated, onSaved, modelPicker } = props;
  const { t } = useTranslation();
  const { isWorkspaceFeatureEnabled } = useWorkspace();
  const { allowPermissions } = useUserPermissions();
  const isAdmin = allowPermissions([EUserPermissions.ADMIN], EUserPermissionsLevel.WORKSPACE);
  const musicEnabled = isWorkspaceFeatureEnabled(workspaceSlug, "music_catalog");
  const libraryEnabled = isWorkspaceFeatureEnabled(workspaceSlug, "file_library");
  const musicImport = musicEnabled && isAdmin;
  const referencesEnabled = isWorkspaceFeatureEnabled(workspaceSlug, "references");

  // What the user is looking at, minus anything they removed from it.
  const pageContext = useAssistantPageContext();
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const pageKey = `${pageContext.page}|${pageContext.issue_key ?? ""}|${pageContext.tag_id ?? ""}|${pageContext.items.map(contextKey).join(",")}`;
  useEffect(() => setRemoved(new Set()), [pageKey]);
  const effectiveContext = useMemo<TAssistantPageContext>(
    () => ({
      ...pageContext,
      issue_key: removed.has("issue") ? undefined : pageContext.issue_key,
      tag_id: removed.has("tag") ? undefined : pageContext.tag_id,
      items: pageContext.items.filter((item) => !removed.has(contextKey(item))),
    }),
    [pageContext, removed]
  );

  // Read through refs so a new model or context never rebuilds the transport
  // (which would drop an in-flight stream).
  const modelRef = useRef(model);
  modelRef.current = model;
  const contextRef = useRef(effectiveContext);
  contextRef.current = effectiveContext;
  const chatIdRef = useRef<string | null>(session.chatId);

  const ensureChat = useCallback(async () => {
    if (chatIdRef.current) return chatIdRef.current;
    const chat = await assistantService.createChat(workspaceSlug);
    chatIdRef.current = chat.id;
    onChatCreated(chat.id);
    return chat.id;
  }, [workspaceSlug, onChatCreated]);

  // Failed requests read as a sentence, not the proxy's raw JSON body.
  const errorText = useRef({
    unavailable: t("assistant.errors.unavailable"),
    forbidden: t("assistant.errors.forbidden"),
    generic: t("assistant.errors.generic"),
  });
  const transport = useMemo(
    () =>
      new AssistantChatTransport({
        api: assistantService.chatUrl(workspaceSlug),
        credentials: "include",
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const response = await fetch(input, init);
          if (response.ok) return response;
          const messages = errorText.current;
          if (response.status === 403) throw new Error(messages.forbidden);
          if (response.status >= 500) throw new Error(messages.unavailable);
          throw new Error(messages.generic);
        },
        body: () => ({
          model: modelRef.current ?? undefined,
          locale: typeof navigator === "undefined" ? undefined : navigator.language,
          context: contextRef.current,
        }),
      }),
    [workspaceSlug]
  );
  const adapters = useMemo(
    () => ({
      attachments: new CompositeAttachmentAdapter([
        new AssistantAttachmentAdapter(workspaceSlug, { musicImport, library: libraryEnabled }),
      ]),
    }),
    [workspaceSlug, musicImport, libraryEnabled]
  );

  // Answers that already resumed the run. The continuation is appended to the
  // same message, which still holds the answered question: without this every
  // finished continuation would look like a fresh answer and send again.
  const resumed = useRef(
    new Set(
      // A stored chat's answered questions resumed long ago; an unanswered
      // one still may, once the user answers it.
      (session.messages as { parts?: { toolCallId?: string; state?: string }[] }[]).flatMap((message) =>
        (message.parts ?? []).flatMap((part) =>
          part.toolCallId && (part.state === "output-available" || part.state === "output-error")
            ? [part.toolCallId]
            : []
        )
      )
    )
  );

  // Cost of the last answer and a run counter, for the balance meter
  const [turns, setTurns] = useState<TAssistantTurn[]>([]);
  const [finishedRuns, setFinishedRuns] = useState(0);

  const runtime = useChatRuntime({
    transport,
    adapters,
    messages: session.messages as never,
    // Only a human answer resumes a paused run, and each answer only once;
    // resuming after server tools would loop with empty requests.
    sendAutomaticallyWhen: ({ messages }) => {
      const last = messages[messages.length - 1];
      if (!last || last.role !== "assistant") return false;
      const human = last.parts.filter((part) =>
        HUMAN_INPUT_TOOLS.some(
          (name) => part.type === `tool-${name}` || (part.type === "dynamic-tool" && part.toolName === name)
        )
      ) as { state?: string; toolCallId: string }[];
      if (human.length === 0) return false;
      const answered = human.every((part) => part.state === "output-available" || part.state === "output-error");
      const fresh = human.filter((part) => !resumed.current.has(part.toolCallId));
      if (!answered || fresh.length === 0) return false;
      for (const part of fresh) resumed.current.add(part.toolCallId);
      return true;
    },
    onFinish: ({ message: finished, messages, isError, isAbort }) => {
      setFinishedRuns((count) => count + 1);
      const priced = turnFromMessage(finished, Date.now());
      if (priced) setTurns((value) => [...value, priced]);
      if (isError || isAbort) return;
      const transcript = messages.filter((message) => message.role !== "system");
      if (transcript.length === 0) return;
      void (async () => {
        try {
          const chatId = await ensureChat();
          await assistantService.saveMessages(
            workspaceSlug,
            chatId,
            transcript.map((message) => ({
              id: message.id,
              role: message.role === "user" ? "user" : "assistant",
              parts: (message.parts ?? []) as { type: string }[],
            }))
          );
          onSaved();
        } catch {
          // The answer is on screen; a failed save must not eat it.
          setToast({ type: TOAST_TYPE.WARNING, title: t("assistant.not_saved") });
        }
      })();
    },
  });

  const traceTools = useMemo(() => buildTraceToolUIs(workspaceSlug), [workspaceSlug]);
  const suggestions = useSuggestions(workspaceSlug, effectiveContext, {
    music: musicEnabled && isAdmin,
    resolve: referencesEnabled,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {traceTools.map(({ name, ToolUI }) => (
        <ToolUI key={name} />
      ))}
      <ExportMusicExcelCard />
      <PlanMusicImportCard />
      <UpdateMusicTrackCard />
      <MergeTagsCard />
      <ProposeMemoryCard />
      <TaggingCard />
      <WorkItemCard />
      <PageCard />
      <ReportCard />
      <DeepReviewCard />
      <StartTagMappingCard />
      <AskUserCard />
      <ShowDocumentsCard />
      <AssistantThread
        suggestions={suggestions}
        allowAttachments={libraryEnabled || musicImport}
        composerAccessory={modelPicker}
        composerTrailing={
          <>
            <AssistantHelp music={musicEnabled} />
            {isAdmin && <AssistantUsageMeter workspaceSlug={workspaceSlug} turns={turns} finishedRuns={finishedRuns} />}
          </>
        }
        contextBar={
          <ContextBar
            workspaceSlug={workspaceSlug}
            context={effectiveContext}
            resolveNames={referencesEnabled}
            onRemove={(key) => setRemoved((value) => new Set(value).add(key))}
          />
        }
      />
    </AssistantRuntimeProvider>
  );
});

// ------------------------------------------------------------- context

function ContextBar({
  workspaceSlug,
  context,
  resolveNames,
  onRemove,
}: {
  workspaceSlug: string;
  context: TAssistantPageContext;
  resolveNames: boolean;
  onRemove: (key: string) => void;
}) {
  const { t } = useTranslation();
  const { data: tags } = useSharedTags(workspaceSlug, resolveNames && Boolean(context.tag_id));
  const tag = tags?.find((item) => item.id === context.tag_id);
  const hasChips = Boolean(context.issue_key || tag || context.items.length > 0);
  if (!hasChips) return null;
  const visible = context.items.slice(0, 3);
  const hidden = context.items.length - visible.length;
  return (
    <div className="flex flex-wrap items-center gap-1 px-2 pt-2" title={t("assistant.composer.context_hint")}>
      {context.issue_key && (
        <Chip label={context.issue_key} prefix={t("assistant.context.work_item")} onRemove={() => onRemove("issue")} />
      )}
      {tag && <Chip label={tag.name} prefix={t("assistant.context.tag")} onRemove={() => onRemove("tag")} />}
      {visible.map((item) => (
        <EntityChip
          key={contextKey(item)}
          workspaceSlug={workspaceSlug}
          item={item}
          resolve={resolveNames}
          onRemove={() => onRemove(contextKey(item))}
        />
      ))}
      {hidden > 0 && <span className="px-1 text-11 text-tertiary">+{hidden}</span>}
    </div>
  );
}

function EntityChip({
  workspaceSlug,
  item,
  resolve,
  onRemove,
}: {
  workspaceSlug: string;
  item: TContextItem;
  resolve: boolean;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const { data } = useEntityCard(resolve ? workspaceSlug : undefined, item.entity_name, item.id);
  const Icon = ENTITY_ICONS[item.entity_name];
  return (
    <Chip
      icon={<Icon className="size-3 shrink-0" />}
      label={data?.title || t(entityLabelKey(item.entity_name))}
      onRemove={onRemove}
    />
  );
}

function Chip({
  label,
  prefix,
  icon,
  onRemove,
}: {
  label: string;
  prefix?: string;
  icon?: ReactNode;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  return (
    <span className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-md bg-layer-2 py-0.5 pr-0.5 pl-1.5 text-11 text-secondary">
      {icon}
      {prefix && <span className="shrink-0 text-tertiary">{prefix}</span>}
      <span className="max-w-40 truncate">{label}</span>
      <button
        type="button"
        onClick={onRemove}
        className="rounded-sm p-0.5 text-tertiary hover:bg-layer-1-hover hover:text-secondary"
        aria-label={t("assistant.composer.remove_context", { name: label })}
      >
        <X className="size-2.5" />
      </button>
    </span>
  );
}

/** Prompts that fit where the user is (Twenty keeps them static; here the
 * page already says what is likely to be asked). */
function useSuggestions(
  workspaceSlug: string,
  context: TAssistantPageContext,
  caps: { music: boolean; resolve: boolean }
): string[] {
  const { t } = useTranslation();
  const { data: tags } = useSharedTags(workspaceSlug, caps.resolve && Boolean(context.tag_id));
  const tagName = tags?.find((item) => item.id === context.tag_id)?.name;
  const single = context.items.length === 1 ? context.items[0] : undefined;
  const { data: card } = useEntityCard(
    caps.resolve ? workspaceSlug : undefined,
    single?.entity_name ?? "contract",
    single?.id
  );

  if (tagName) {
    return [
      t("assistant.suggestions.tag_summary", { name: tagName }),
      t("assistant.suggestions.tag_releases", { name: tagName }),
    ];
  }
  if (single && card?.title) {
    return [
      t("assistant.suggestions.item_summary", { name: card.title }),
      t("assistant.suggestions.item_references", { name: card.title }),
    ];
  }
  if (context.issue_key) {
    return [
      t("assistant.suggestions.item_summary", { name: context.issue_key }),
      t("assistant.suggestions.item_references", { name: context.issue_key }),
    ];
  }
  if (context.items.length > 1 && context.items.every((item) => item.entity_name === "music_track")) {
    return [t("assistant.suggestions.selection", { count: context.items.length })];
  }
  if (context.page === "contracts") {
    return [
      t("assistant.suggestions.contracts_expiring"),
      t("assistant.suggestions.contracts_by_status"),
      t("assistant.suggestions.contracts_mention"),
    ];
  }
  if (context.page === "music" && caps.music) {
    return [t("assistant.suggestions.music_year"), t("assistant.suggestions.music_videos")];
  }
  return [
    t("assistant.suggestions.contracts_by_status"),
    ...(caps.music ? [t("assistant.suggestions.music_year")] : []),
    t("assistant.suggestions.workspace"),
  ];
}
