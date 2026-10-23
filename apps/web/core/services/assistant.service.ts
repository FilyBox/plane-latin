/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { API_BASE_URL } from "@plane/constants";
import { APIService } from "@/services/api.service";

export type TAssistantChat = { id: string; title: string; created_at: string; updated_at: string };
export type TAssistantStoredMessage = { id: string; role: "user" | "assistant"; parts: { type: string }[] };
export type TAssistantModels = { models: { id: string; provider: string }[]; default_model: string };

export type TAssistantAction = {
  id: string;
  kind: "TAG_ITEMS" | "UNTAG_ITEMS" | "CREATE_WORK_ITEM" | "CREATE_PAGE" | "MERGE_TAGS";
  status: "APPLIED" | "UNDONE";
  summary: string;
  result: Record<string, unknown>;
  created_at: string;
  undone_at: string | null;
  /** Who made it (history across the workspace) */
  actor?: string;
};

export type TAssistantMemoryKind = "FACT" | "RULE" | "GLOSSARY" | "OWNER" | "CONTEXT";
export type TAssistantMemoryStatus = "PROPOSED" | "ACTIVE" | "REJECTED" | "ARCHIVED";
export type TAssistantMemory = {
  id: string;
  kind: TAssistantMemoryKind;
  content: string;
  details: string;
  aliases: string[];
  entities: { entity_name: string; id: string }[];
  status: TAssistantMemoryStatus;
  pinned: boolean;
  valid_until: string | null;
  supersedes: string | null;
  source: "MANUAL" | "ASSISTANT";
  evidence: string;
  created_by: string | null;
  approved_by: string | null;
  approved_at: string | null;
  use_count: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
};
export type TAssistantMemoryInput = Partial<
  Pick<
    TAssistantMemory,
    "kind" | "content" | "details" | "aliases" | "entities" | "pinned" | "valid_until" | "evidence"
  >
> & { status?: TAssistantMemoryStatus; supersedes?: string | null; source?: "MANUAL" | "ASSISTANT" };

/** Workspace assistant: per-user conversations and the models to run on. */
export class AssistantService extends APIService {
  constructor() {
    super(API_BASE_URL);
  }

  chatUrl(workspaceSlug: string): string {
    return `${API_BASE_URL}/api/workspaces/${workspaceSlug}/assistant/chat/`;
  }

  async getModels(workspaceSlug: string): Promise<TAssistantModels> {
    return this.get(`/api/workspaces/${workspaceSlug}/assistant/models/`).then((response) => response.data);
  }

  async getChats(workspaceSlug: string): Promise<TAssistantChat[]> {
    return this.get(`/api/workspaces/${workspaceSlug}/assistant/chats/`).then((response) => response.data);
  }

  async createChat(workspaceSlug: string): Promise<TAssistantChat> {
    return this.post(`/api/workspaces/${workspaceSlug}/assistant/chats/`, {}).then((response) => response.data);
  }

  async getChat(
    workspaceSlug: string,
    chatId: string
  ): Promise<TAssistantChat & { messages: TAssistantStoredMessage[] }> {
    return this.get(`/api/workspaces/${workspaceSlug}/assistant/chats/${chatId}/`).then((response) => response.data);
  }

  async renameChat(workspaceSlug: string, chatId: string, title: string): Promise<TAssistantChat> {
    return this.patch(`/api/workspaces/${workspaceSlug}/assistant/chats/${chatId}/`, { title }).then(
      (response) => response.data
    );
  }

  async deleteChat(workspaceSlug: string, chatId: string): Promise<void> {
    return this.delete(`/api/workspaces/${workspaceSlug}/assistant/chats/${chatId}/`).then(() => undefined);
  }

  /** The workspace's shared memory: admins write it, members suggest. */
  async getMemories(
    workspaceSlug: string,
    status: "active" | "proposed" | "archived" = "active"
  ): Promise<{ memories: TAssistantMemory[]; can_edit: boolean }> {
    return this.get(`/api/workspaces/${workspaceSlug}/assistant/memories/`, { params: { status } }).then(
      (response) => response.data
    );
  }

  async createMemory(workspaceSlug: string, data: TAssistantMemoryInput): Promise<TAssistantMemory> {
    return this.post(`/api/workspaces/${workspaceSlug}/assistant/memories/`, data).then((response) => response.data);
  }

  async updateMemory(workspaceSlug: string, memoryId: string, data: TAssistantMemoryInput): Promise<TAssistantMemory> {
    return this.patch(`/api/workspaces/${workspaceSlug}/assistant/memories/${memoryId}/`, data).then(
      (response) => response.data
    );
  }

  /** Approved changes from the assistant's cards; each can be undone. */
  async createAction(workspaceSlug: string, data: Record<string, unknown>): Promise<TAssistantAction> {
    return this.post(`/api/workspaces/${workspaceSlug}/assistant/actions/`, data).then((response) => response.data);
  }

  async getActions(
    workspaceSlug: string,
    scope: "mine" | "all" = "mine"
  ): Promise<{ actions: TAssistantAction[]; can_see_all: boolean }> {
    return this.get(`/api/workspaces/${workspaceSlug}/assistant/actions/`, { params: { scope } }).then(
      (response) => response.data
    );
  }

  async undoAction(workspaceSlug: string, actionId: string): Promise<TAssistantAction> {
    return this.post(`/api/workspaces/${workspaceSlug}/assistant/actions/${actionId}/undo/`, {}).then(
      (response) => response.data
    );
  }

  async saveMessages(
    workspaceSlug: string,
    chatId: string,
    messages: TAssistantStoredMessage[]
  ): Promise<TAssistantChat> {
    return this.put(`/api/workspaces/${workspaceSlug}/assistant/chats/${chatId}/messages/`, { messages }).then(
      (response) => response.data
    );
  }
}

export const assistantService = new AssistantService();
