/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * Contracts chat, running on the agent instead of one-shot RAG.
 *
 * The old panel used assistant-ui's external-store runtime: it POSTed a
 * question, waited for one blocking answer built from the top-k embedding
 * neighbours, and mirrored the result back. That capped what the chat could do
 * (no multi-step lookup) and how long it could run (no streaming, so a
 * multi-document search timed out or blew the model's context).
 *
 * Now it streams from Django's agent proxy through `useChatRuntime`, like the
 * workspace assistant. Django still owns the chat list and history, so turns
 * are persisted explicitly once a run settles (`onFinish`) rather than by the
 * request that produced them.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { AssistantChatTransport, useChatRuntime } from "@assistant-ui/react-ai-sdk";
import { Bot, History, Loader2, Plus, Trash2, X } from "lucide-react";
import useSWR from "swr";
// plane imports
import { useTranslation } from "@plane/i18n";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TContractChat, TContractChatMessage, TContractChatMode } from "@plane/types";
import { cn } from "@plane/utils";
// services
import { contractService } from "@/services/contract.service";
// local imports
import { ContractAgentToolUIs } from "./agent-tools";
import { ContractDocumentContext } from "./document-reference";
import { ContractChatPreviewPanel } from "./preview-panel";
import { ContractChatThread } from "./thread";

type Props = {
  workspaceSlug: string;
  mode: TContractChatMode;
  contractId?: string;
  /** Sent automatically as the first message (Power K "search with AI") */
  initialQuery?: string;
  /** Hide the chat-history sidebar (peek panel embed) */
  compact?: boolean;
  onOpenContract?: (contractId: string) => void;
};

type TStoredMessage = { id: string; role: "user" | "assistant"; parts: { type: string }[] };

/** One mounted conversation. Remounting is how a stored chat is loaded. */
type TSession = { key: string; chatId: string | null; messages: TStoredMessage[] };

/**
 * Rehydrates a stored turn into the shape assistant-ui replays.
 *
 * Turns written before the agent landed have no `parts`, only text and a flat
 * `sources` array — those are rebuilt as a `show_documents` result so an old
 * conversation still renders its document cards instead of losing them.
 */
function toUIMessage(message: TContractChatMessage): TStoredMessage {
  const role = message.role === "USER" ? ("user" as const) : ("assistant" as const);
  if (message.parts && message.parts.length > 0) {
    return { id: message.id, role, parts: message.parts as { type: string }[] };
  }
  const parts: { type: string }[] = [{ type: "text", text: message.content } as { type: string }];
  if (message.sources && message.sources.length > 0) {
    parts.push({
      type: "tool-show_documents",
      toolCallId: `legacy-sources-${message.id}`,
      state: "output-available",
      input: { contract_ids: message.sources.map((source) => source.contract_id) },
      output: {
        note: null,
        documents: message.sources.map((source) => ({
          contract_id: source.contract_id,
          title: source.title,
          file_name: source.file_name,
          asset_id: source.asset_id,
        })),
      },
    } as unknown as { type: string });
  }
  return { id: message.id, role, parts };
}

const newSession = (): TSession => ({ key: `new-${Date.now()}`, chatId: null, messages: [] });

export function ContractChatPanel(props: Props) {
  const { workspaceSlug, mode, contractId, initialQuery, compact = false, onOpenContract } = props;
  const { t } = useTranslation();
  // states
  const [session, setSession] = useState<TSession>(newSession);
  const [showHistory, setShowHistory] = useState(false);
  const [previewContractId, setPreviewContractId] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [isLoadingChat, setIsLoadingChat] = useState(false);

  // chat history (scoped to the contract in CONTRACT mode)
  const { data: chats, mutate: mutateChats } = useSWR(
    `CONTRACT_CHATS_${workspaceSlug}_${mode}_${contractId ?? "all"}`,
    () => contractService.getChats(workspaceSlug, { mode, contractId }),
    { revalidateOnFocus: false }
  );

  // selectable models come from the Worker env (never hardcoded)
  const { data: modelOptions } = useSWR(
    `CONTRACT_CHAT_MODELS_${workspaceSlug}`,
    () => contractService.getChatModels(workspaceSlug),
    { revalidateOnFocus: false }
  );
  const activeModel = selectedModel ?? modelOptions?.default_model ?? null;

  const openChat = async (chatId: string) => {
    setShowHistory(false);
    setPreviewContractId(null);
    setIsLoadingChat(true);
    try {
      const { messages } = await contractService.getChatDetail(workspaceSlug, chatId);
      setSession({ key: chatId, chatId, messages: messages.map(toUIMessage) });
    } catch {
      setToast({ type: TOAST_TYPE.ERROR, title: t("file_library.contracts.chat.failed") });
    } finally {
      setIsLoadingChat(false);
    }
  };

  const startNewChat = () => {
    setSession(newSession());
    setPreviewContractId(null);
    setShowHistory(false);
  };

  const handleDeleteChat = async (chatId: string) => {
    try {
      await contractService.deleteChat(workspaceSlug, chatId);
      if (session.chatId === chatId) startNewChat();
      void mutateChats();
    } catch {
      setToast({ type: TOAST_TYPE.ERROR, title: t("file_library.contracts.chat.failed") });
    }
  };

  // In the contract peek (compact) the document is already open beside the
  // chat, so a citation there jumps to the contract instead of stacking a
  // second preview on top of the one the user is looking at.
  const documentContext = useMemo(
    () => ({ workspaceSlug, onPreview: compact ? undefined : setPreviewContractId, onOpenContract }),
    [workspaceSlug, compact, onOpenContract]
  );

  const historyList = (
    <div className="flex h-full min-h-0 flex-col">
      <button
        type="button"
        onClick={startNewChat}
        className="mx-2 mt-2 flex items-center justify-center gap-1.5 rounded-md border border-subtle px-2 py-1.5 text-12 font-medium hover:bg-layer-1-hover"
      >
        <Plus className="size-3.5" />
        {t("file_library.contracts.chat.new_chat")}
      </button>
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
        {(chats ?? []).map((chat: TContractChat) => (
          <div
            key={chat.id}
            className={cn(
              "group flex items-center gap-1 rounded-md px-2 py-1.5 text-12 hover:bg-layer-1-hover",
              session.chatId === chat.id ? "bg-layer-1" : ""
            )}
          >
            <button type="button" className="min-w-0 flex-1 truncate text-left" onClick={() => void openChat(chat.id)}>
              {chat.title || t("file_library.contracts.chat.untitled")}
            </button>
            <button
              type="button"
              onClick={() => void handleDeleteChat(chat.id)}
              className="shrink-0 rounded-sm p-1 text-tertiary opacity-0 group-hover:opacity-100 hover:text-danger-primary"
            >
              <Trash2 className="size-3" />
            </button>
          </div>
        ))}
        {(chats ?? []).length === 0 && (
          <p className="px-2 py-4 text-center text-11 text-tertiary">{t("file_library.contracts.chat.no_chats")}</p>
        )}
      </div>
    </div>
  );

  return (
    <ContractDocumentContext.Provider value={documentContext}>
      <div className="relative flex h-full min-h-0 w-full">
        {/* history — persistent column on desktop, overlay drawer on mobile/compact */}
        {!compact && <div className="hidden w-56 shrink-0 border-r border-subtle lg:block">{historyList}</div>}

        <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
          <div
            className={cn(
              "flex shrink-0 items-center justify-between border-b border-subtle px-3 py-1.5",
              compact ? "" : "lg:hidden"
            )}
          >
            <button
              type="button"
              onClick={() => setShowHistory((value) => !value)}
              className="flex items-center gap-1.5 rounded-sm px-2 py-1 text-12 hover:bg-layer-1-hover"
            >
              <History className="size-3.5" />
              {t("file_library.contracts.chat.history")}
            </button>
            {isLoadingChat && <Loader2 className="size-3.5 animate-spin text-tertiary" />}
          </div>
          <div className="min-h-0 min-w-0 flex-1">
            {/* Keyed: switching chats remounts the runtime with that chat's
                messages, since the AI SDK treats `messages` as initial state. */}
            <ChatSession
              key={session.key}
              session={session}
              workspaceSlug={workspaceSlug}
              mode={mode}
              contractId={contractId}
              model={activeModel}
              initialQuery={session.chatId === null ? initialQuery : undefined}
              onChatCreated={(chatId) => {
                setSession((current) => ({ ...current, chatId }));
                void mutateChats();
              }}
              onTurnSaved={() => void mutateChats()}
              composerAccessory={
                (modelOptions?.models.length ?? 0) > 0 ? (
                  <label className="flex min-w-0 items-center gap-1.5 text-11 text-tertiary">
                    <Bot className="size-3.5 shrink-0" />
                    <select
                      value={activeModel ?? ""}
                      onChange={(event) => setSelectedModel(event.target.value)}
                      className="min-w-0 cursor-pointer rounded-sm border border-subtle bg-transparent px-1.5 py-0.5 text-11 outline-none hover:bg-layer-1-hover"
                    >
                      {modelOptions?.models.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.id} ({option.provider})
                        </option>
                      ))}
                    </select>
                  </label>
                ) : undefined
              }
            />
          </div>
        </div>

        {/* document preview, opened from a citation card. Wide layouts get a
            column beside the thread; narrow ones take the panel over. */}
        {previewContractId && (
          <>
            <div className="hidden w-88 shrink-0 border-l border-subtle xl:block">
              <ContractChatPreviewPanel
                workspaceSlug={workspaceSlug}
                contractId={previewContractId}
                onClose={() => setPreviewContractId(null)}
                onOpenContract={onOpenContract}
              />
            </div>
            <div className="absolute inset-0 z-20 xl:hidden">
              <ContractChatPreviewPanel
                workspaceSlug={workspaceSlug}
                contractId={previewContractId}
                onClose={() => setPreviewContractId(null)}
                onOpenContract={onOpenContract}
              />
            </div>
          </>
        )}

        {/* mobile / compact history drawer */}
        {showHistory && (
          <div className="absolute inset-0 z-10 flex">
            <div className="flex h-full w-64 max-w-[85%] flex-col border-r border-subtle bg-surface-1 shadow-raised-200">
              <div className="flex items-center justify-between border-b border-subtle px-3 py-2">
                <span className="text-12 font-medium">{t("file_library.contracts.chat.history")}</span>
                <button
                  type="button"
                  onClick={() => setShowHistory(false)}
                  className="rounded-sm p-1 hover:bg-layer-1-hover"
                >
                  <X className="size-3.5" />
                </button>
              </div>
              <div className="min-h-0 flex-1">{historyList}</div>
            </div>
            <button
              type="button"
              className="flex-1 bg-black/20"
              onClick={() => setShowHistory(false)}
              aria-label="close"
            />
          </div>
        )}
      </div>
    </ContractDocumentContext.Provider>
  );
}

type SessionProps = {
  session: TSession;
  workspaceSlug: string;
  mode: TContractChatMode;
  contractId?: string;
  model: string | null;
  initialQuery?: string;
  onChatCreated: (chatId: string) => void;
  onTurnSaved: () => void;
  composerAccessory?: React.ReactNode;
};

/** The runtime-bearing half of the panel; remounted per conversation. */
function ChatSession(props: SessionProps) {
  const { session, workspaceSlug, mode, contractId, model, initialQuery, onChatCreated, onTurnSaved } = props;
  const { t } = useTranslation();

  // Read through refs so changing the model or gaining a chat id never
  // invalidates the transport (which would drop an in-flight stream).
  const modelRef = useRef<string | null>(model);
  modelRef.current = model;
  const chatIdRef = useRef<string | null>(session.chatId);
  const initialQuerySent = useRef(false);

  /** Creates the chat row on demand so the first turn has somewhere to live. */
  const ensureChat = useCallback(async () => {
    if (chatIdRef.current) return chatIdRef.current;
    const chat = await contractService.createChat(workspaceSlug, { mode, contract_id: contractId });
    chatIdRef.current = chat.id;
    onChatCreated(chat.id);
    return chat.id;
  }, [workspaceSlug, mode, contractId, onChatCreated]);

  const transport = useMemo(
    () =>
      new AssistantChatTransport({
        api: contractService.getAgentChatUrl(workspaceSlug),
        credentials: "include",
        body: () => ({
          model: modelRef.current ?? undefined,
          locale: typeof navigator === "undefined" ? undefined : navigator.language,
          chat_id: chatIdRef.current ?? undefined,
          mode,
          contract_id: contractId,
        }),
      }),
    [workspaceSlug, mode, contractId]
  );

  const runtime = useChatRuntime({
    transport,
    messages: session.messages as never,
    // A settled run is the only point where a turn is complete (text + tool
    // parts). The whole transcript goes up, not just the new pair: the browser
    // holds the authoritative thread, so a regenerated or edited turn rewrites
    // history server-side instead of leaving the superseded answer behind.
    onFinish: ({ messages, isError, isAbort }) => {
      if (isError || isAbort) return;
      const transcript = messages.filter((message) => message.role !== "system");
      if (transcript.length === 0) return;
      void (async () => {
        try {
          const chatId = await ensureChat();
          await contractService.saveChatTurn(
            workspaceSlug,
            chatId,
            transcript.map((message) => ({
              id: message.id,
              role: message.role === "user" ? ("user" as const) : ("assistant" as const),
              parts: message.parts ?? [],
            }))
          );
          onTurnSaved();
        } catch {
          // The answer is already on screen; a failed save must not eat it.
          setToast({ type: TOAST_TYPE.WARNING, title: t("file_library.contracts.chat.not_saved") });
        }
      })();
    },
  });

  // Power K entry: fire the search as the first turn of a fresh chat
  useEffect(() => {
    if (!initialQuery || initialQuerySent.current) return;
    initialQuerySent.current = true;
    void runtime.thread.append({ role: "user", content: [{ type: "text", text: initialQuery }] });
  }, [initialQuery, runtime]);

  const suggestions =
    mode === "CONTRACT"
      ? [t("file_library.contracts.chat.suggestions.summary"), t("file_library.contracts.chat.suggestions.obligations")]
      : [
          t("file_library.contracts.chat.suggestions.by_artist"),
          t("file_library.contracts.chat.suggestions.expiring"),
          t("file_library.contracts.chat.suggestions.contains"),
        ];

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ContractAgentToolUIs />
      <ContractChatThread
        emptyTitle={t(
          mode === "CONTRACT"
            ? "file_library.contracts.chat.empty_contract_title"
            : "file_library.contracts.chat.empty_general_title"
        )}
        emptyDescription={t(
          mode === "CONTRACT"
            ? "file_library.contracts.chat.empty_contract_description"
            : "file_library.contracts.chat.empty_general_description"
        )}
        suggestions={suggestions}
        composerAccessory={props.composerAccessory}
      />
    </AssistantRuntimeProvider>
  );
}
