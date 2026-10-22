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
