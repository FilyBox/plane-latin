/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * localStorage-backed thread persistence for the workspace assistant.
 *
 * `useChatRuntime` alone keeps threads in memory only — a refresh wiped the
 * whole history. Wrapping it in `useRemoteThreadListRuntime` with this adapter
 * persists the thread list and every thread's messages per workspace, in the
 * AI SDK UIMessage format (lossless round-trip through the stream format).
 *
 * The history adapter implements `withFormat` because that is the only path
 * `useChatRuntime` consumes (it throws without it); the raw load/append pair
 * is never called for AI-SDK runtimes.
 */

import { useMemo, type FC, type PropsWithChildren } from "react";
import {
  RuntimeAdapterProvider,
  useThreadListItemRuntime,
  type RemoteThreadListAdapter,
  type ThreadHistoryAdapter,
  type ThreadListItemRuntime,
  type MessageFormatAdapter,
  type MessageFormatItem,
  type MessageFormatRepository,
  type MessageStorageEntry,
} from "@assistant-ui/react";

const THREAD_TITLE_MAX = 48;

type StoredThread = {
  remoteId: string;
  status: "regular" | "archived";
  title?: string;
  updatedAt?: number;
};

type StoredEntry = MessageStorageEntry<Record<string, unknown>>;

type StoredRepository = {
  headId?: string | null;
  entries: StoredEntry[];
};

const safeParse = <T,>(raw: string | null, fallback: T): T => {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

class AssistantThreadStore {
  constructor(private prefix: string) {}

  private get threadsKey() {
    return `${this.prefix}:threads`;
  }

  private messagesKey(remoteId: string) {
    return `${this.prefix}:messages:${remoteId}`;
  }

  listThreads(): StoredThread[] {
    return safeParse<StoredThread[]>(localStorage.getItem(this.threadsKey), []).filter(
      (thread) => typeof thread?.remoteId === "string"
    );
  }

  saveThreads(threads: StoredThread[]) {
    localStorage.setItem(this.threadsKey, JSON.stringify(threads));
  }

  upsertThread(remoteId: string, patch: Partial<StoredThread> = {}) {
    const threads = this.listThreads();
    const existing = threads.find((thread) => thread.remoteId === remoteId);
    if (existing) {
      Object.assign(existing, patch, { updatedAt: Date.now() });
    } else {
      threads.unshift({ remoteId, status: "regular", updatedAt: Date.now(), ...patch });
    }
    this.saveThreads(threads);
  }

  deleteThread(remoteId: string) {
    this.saveThreads(this.listThreads().filter((thread) => thread.remoteId !== remoteId));
    localStorage.removeItem(this.messagesKey(remoteId));
  }

  loadRepository(remoteId: string): StoredRepository {
    return safeParse<StoredRepository>(localStorage.getItem(this.messagesKey(remoteId)), { entries: [] });
  }

  saveRepository(remoteId: string, repository: StoredRepository) {
    localStorage.setItem(this.messagesKey(remoteId), JSON.stringify(repository));
  }
}

/** First user text becomes the thread title ("Nueva conversación" otherwise) */
const titleFromMessage = (message: unknown): string | null => {
  const parts = (message as { role?: string; parts?: { type?: string; text?: string }[] } | null) ?? null;
  if (!parts || parts.role !== "user" || !Array.isArray(parts.parts)) return null;
  const text = parts.parts
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join(" ")
    .trim();
  if (!text) return null;
  return text.length > THREAD_TITLE_MAX ? `${text.slice(0, THREAD_TITLE_MAX)}…` : text;
};

class LocalHistoryAdapter implements ThreadHistoryAdapter {
  constructor(
    private store: AssistantThreadStore,
    private threadListItem: ThreadListItemRuntime
  ) {}

  // Raw ExportedMessageRepository path — unused by the AI-SDK runtime, which
  // always goes through withFormat (and throws if it is missing).
  async load() {
    return { messages: [] };
  }

  async append() {
    // no-op: withFormat handles persistence
  }

  withFormat<TMessage, TStorageFormat extends Record<string, unknown>>(
    format: MessageFormatAdapter<TMessage, TStorageFormat>
  ) {
    const { store, threadListItem } = this;
    return {
      async load(): Promise<MessageFormatRepository<TMessage>> {
        const remoteId = threadListItem.getState().remoteId;
        if (!remoteId) return { messages: [] };
        const repository = store.loadRepository(remoteId);
        const messages = repository.entries
          .filter((entry) => entry.format === format.format)
          .map((entry) => format.decode(entry as MessageStorageEntry<TStorageFormat>));
        return { headId: repository.headId ?? null, messages };
      },
      async append(item: MessageFormatItem<TMessage>): Promise<void> {
        const { remoteId } = await threadListItem.initialize();
        const repository = store.loadRepository(remoteId);
        const id = format.getId(item.message);
        const entry: StoredEntry = {
          id,
          parent_id: item.parentId,
          format: format.format,
          content: format.encode(item),
        };
        const index = repository.entries.findIndex((existing) => existing.id === id);
        if (index >= 0) repository.entries[index] = entry;
        else repository.entries.push(entry);
        repository.headId = id;
        store.saveRepository(remoteId, repository);
        store.upsertThread(remoteId);

        // Title the thread after its first user message so the rail shows
        // something meaningful; rename() also updates the runtime state.
        const title = titleFromMessage(item.message);
        if (title && !threadListItem.getState().title) {
          void threadListItem.rename(title).catch(() => {});
        }
      },
      async update(item: MessageFormatItem<TMessage>, localMessageId: string): Promise<void> {
        const remoteId = threadListItem.getState().remoteId;
        if (!remoteId) return;
        const repository = store.loadRepository(remoteId);
        const id = format.getId(item.message) || localMessageId;
        const index = repository.entries.findIndex((existing) => existing.id === id || existing.id === localMessageId);
        const entry: StoredEntry = {
          id,
          parent_id: item.parentId,
          format: format.format,
          content: format.encode(item),
        };
        if (index >= 0) repository.entries[index] = entry;
        else repository.entries.push(entry);
        store.saveRepository(remoteId, repository);
      },
      async delete(items: MessageFormatItem<TMessage>[]): Promise<void> {
        const remoteId = threadListItem.getState().remoteId;
        if (!remoteId) return;
        const repository = store.loadRepository(remoteId);
        const ids = new Set(items.map((item) => format.getId(item.message)));
        repository.entries = repository.entries.filter((entry) => !ids.has(entry.id));
        if (repository.headId && ids.has(repository.headId)) {
          repository.headId = repository.entries.at(-1)?.id ?? null;
        }
        store.saveRepository(remoteId, repository);
      },
    };
  }
}

const createHistoryProvider = (store: AssistantThreadStore): FC<PropsWithChildren> => {
  const HistoryProvider: FC<PropsWithChildren> = ({ children }) => {
    const threadListItem = useThreadListItemRuntime();
    const adapters = useMemo(() => ({ history: new LocalHistoryAdapter(store, threadListItem) }), [threadListItem]);
    return <RuntimeAdapterProvider adapters={adapters}>{children}</RuntimeAdapterProvider>;
  };
  return HistoryProvider;
};

export const createAssistantThreadListAdapter = (workspaceSlug: string): RemoteThreadListAdapter => {
  const store = new AssistantThreadStore(`plane-assistant:${workspaceSlug}`);

  return {
    unstable_Provider: createHistoryProvider(store),

    async list() {
      const threads = store.listThreads();
      return {
        threads: threads.map((thread) => ({
          remoteId: thread.remoteId,
          externalId: undefined,
          status: thread.status,
          title: thread.title,
        })),
      };
    },

    async initialize(threadId) {
      store.upsertThread(threadId);
      return { remoteId: threadId, externalId: undefined };
    },

    async rename(remoteId, newTitle) {
      store.upsertThread(remoteId, { title: newTitle });
    },

    async archive(remoteId) {
      store.upsertThread(remoteId, { status: "archived" });
    },

    async unarchive(remoteId) {
      store.upsertThread(remoteId, { status: "regular" });
    },

    async delete(remoteId) {
      store.deleteThread(remoteId);
    },

    async fetch(threadId) {
      const thread = store.listThreads().find((candidate) => candidate.remoteId === threadId);
      if (!thread) throw new Error(`Thread ${threadId} not found`);
      return { remoteId: thread.remoteId, externalId: undefined, status: thread.status, title: thread.title };
    },

    // Titles are set from the first user message in the history adapter; the
    // runtime never needs a streamed title. An immediately-closed stream keeps
    // the contract without pulling in the assistant-stream package.
    async generateTitle() {
      return new ReadableStream({
        start(controller) {
          controller.close();
        },
      }) as unknown as Awaited<ReturnType<RemoteThreadListAdapter["generateTitle"]>>;
    },
  };
};
