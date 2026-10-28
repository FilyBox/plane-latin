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
/** The AI provider account balance (DeepSeek), read by the Worker with its own key */
export type TAssistantBalance = {
  provider: string;
  is_available: boolean;
  balances: { currency: string; total: number }[];
};

export type TAssistantAction = {
  id: string;
  kind:
    | "TAG_ITEMS"
    | "UNTAG_ITEMS"
    | "CREATE_WORK_ITEM"
    | "CREATE_PAGE"
    | "EDIT_PAGE"
    | "MERGE_TAGS"
    | "SPLIT_PDF"
    | "MERGE_PDF"
    | "EDIT_PDF_PAGES"
    | "CREATE_TEMPLATE_VARIANT"
    | "EDIT_TEMPLATE_VARIANT"
    | "CREATE_CONTRACT_DRAFT"
    | "EDIT_CONTRACT"
    | "EDIT_WORK_ITEMS"
    | "COMMENT_WORK_ITEM"
    | "ORGANIZE_FILES"
    | "CREATE_EXPENSES"
    | "CATALOG_FIXES";
  status: "APPLIED" | "UNDONE";
  summary: string;
  result: Record<string, unknown>;
  created_at: string;
  undone_at: string | null;
  tool_call_id?: string | null;
  /** Who made it (history across the workspace) */
  actor?: string;
};

export type TDeepReviewStatus =
  | "DRAFT"
  | "SCHEDULED"
  | "RUNNING"
  | "PAUSED"
  | "STOPPING"
  | "SYNTHESIZING"
  | "COMPLETED"
  | "PARTIAL"
  | "FAILED"
  | "CANCELLED";

type TRange = { low: number; high: number };

/** Ranges the Worker priced from the texts' sizes */
export type TDeepReviewEstimate = {
  count: number;
  total_bytes: number;
  chunks: number;
  lanes: number;
  tokens: TRange;
  eta_minutes: TRange;
  now_peak: boolean;
  next_off_peak: string | null;
  default_model: string;
  models: Record<string, { peak: TRange; off_peak: TRange }>;
};

export type TDeepReviewRow = {
  contract_id: string;
  title: string;
  file_name: string | null;
  file_asset_id: string | null;
  artists: string[];
  start_date: string | null;
  end_date: string | null;
  effective_end_date: string | null;
  matches: boolean;
  selected: boolean;
  confidence: number | null;
  reason: string;
  quote: string;
};

export type TDeepReviewEvent = {
  at: string;
  kind: string;
  model?: string;
  projection?: number;
  estimate?: number | null;
  read?: number;
  dropped?: number;
  spent?: number;
};

export type TDeepReviewProcessItem = {
  contract_id: string;
  title: string;
  status: "DONE" | "FAILED";
  matches: boolean | null;
  selected: boolean;
  confidence: number | null;
  chunks: number;
  tokens: number;
  cost_usd: number;
  error: string;
  /** Why the final pass dropped it (matched, then not selected) */
  reason: string;
  finished_at: string;
};

export type TDeepReviewProcess = { events: TDeepReviewEvent[]; items: TDeepReviewProcessItem[] };

/** Every contract read by the AI against one question (admins) */
export type TDeepReview = {
  id: string;
  status: TDeepReviewStatus;
  title: string;
  question: string;
  model: string;
  off_peak: boolean;
  total_count: number;
  total_bytes: number;
  done_count: number;
  failed_count: number;
  done_bytes: number;
  pending_count: number;
  running_count: number;
  spent_usd: number;
  estimate: TDeepReviewEstimate;
  estimate_usd: number | null;
  projection_usd: number | null;
  alerts_muted: boolean;
  pause_reason: string;
  paused_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  summary: string;
  error: { message?: string };
  results?: TDeepReviewRow[];
  /** What the review did: its events and every contract read, in order */
  process?: TDeepReviewProcess;
  remaining_count?: number;
  continuation_id?: string | null;
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

  async getBalance(workspaceSlug: string, fresh = false): Promise<TAssistantBalance> {
    return this.get(`/api/workspaces/${workspaceSlug}/assistant/balance/`, {
      params: fresh ? { fresh: 1 } : undefined,
    }).then((response) => response.data);
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

  /** The template's Word with the assistant's edits, as a PDF (nothing is saved). */
  async templatePreview(
    workspaceSlug: string,
    variantId: string,
    data: { revision?: number; edits: unknown[] }
  ): Promise<{ blob: Blob; note: string | null }> {
    return this.post(
      `/api/workspaces/${workspaceSlug}/contract-templates/variants/${variantId}/assistant-preview/`,
      data,
      {
        responseType: "blob",
      }
    ).then((response) => ({
      blob: response.data as Blob,
      note: (response.headers?.["x-layout-note"] as string | undefined) ?? null,
    }));
  }

  /** The contract filled with the card's values, as a PDF (nothing is saved). */
  async contractDraftPreview(workspaceSlug: string, variantId: string, data: Record<string, unknown>): Promise<Blob> {
    return this.post(
      `/api/workspaces/${workspaceSlug}/contract-templates/variants/${variantId}/assistant-contract-preview/`,
      data,
      { responseType: "blob" }
    ).then((response) => response.data as Blob);
  }

  /** The receipts' analyses for an expenses card, paired into expenses. */
  async expenseDrafts<T>(workspaceSlug: string, jobIds: string[]): Promise<T> {
    return this.get(`/api/workspaces/${workspaceSlug}/assistant/expense-drafts/`, {
      params: { job_ids: jobIds.join(",") },
    }).then((response) => response.data);
  }

  /** What each card already did, by tool call id (cards of one chat). */
  async getOutcomes(workspaceSlug: string, toolCallIds: string[]): Promise<Record<string, TAssistantAction>> {
    return this.get(`/api/workspaces/${workspaceSlug}/assistant/actions/`, {
      params: { tool_call_ids: toolCallIds.join(",") },
    }).then((response) => response.data?.outcomes ?? {});
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

  // ------------------------------------------------------------ deep review

  async getDeepReview(workspaceSlug: string, reviewId: string): Promise<TDeepReview> {
    return this.get(`/api/workspaces/${workspaceSlug}/assistant/deep-reviews/${reviewId}/`).then(
      (response) => response.data
    );
  }

  async startDeepReview(
    workspaceSlug: string,
    reviewId: string,
    data: { model: string; off_peak: boolean }
  ): Promise<TDeepReview> {
    return this.post(`/api/workspaces/${workspaceSlug}/assistant/deep-reviews/${reviewId}/start/`, data).then(
      (response) => response.data
    );
  }

  async decideDeepReview(
    workspaceSlug: string,
    reviewId: string,
    action: "stop" | "continue" | "cancel"
  ): Promise<TDeepReview> {
    return this.post(`/api/workspaces/${workspaceSlug}/assistant/deep-reviews/${reviewId}/decision/`, {
      action,
    }).then((response) => response.data);
  }

  /** A new review, to confirm, for what a partial one did not read */
  async continueDeepReview(workspaceSlug: string, reviewId: string): Promise<TDeepReview> {
    return this.post(`/api/workspaces/${workspaceSlug}/assistant/deep-reviews/${reviewId}/remaining/`, {}).then(
      (response) => response.data
    );
  }

  async deepReviewPage(workspaceSlug: string, reviewId: string): Promise<{ title: string; markdown: string }> {
    return this.get(`/api/workspaces/${workspaceSlug}/assistant/deep-reviews/${reviewId}/page/`).then(
      (response) => response.data
    );
  }

  async downloadDeepReview(
    workspaceSlug: string,
    reviewId: string,
    format: "xlsx" | "csv",
    scope: "matches" | "all" = "matches"
  ): Promise<void> {
    const response = await this.get(`/api/workspaces/${workspaceSlug}/assistant/deep-reviews/${reviewId}/export/`, {
      params: { type: format, scope },
      responseType: "blob",
    });
    const url = URL.createObjectURL(response.data);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `revision-contratos.${format}`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
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
