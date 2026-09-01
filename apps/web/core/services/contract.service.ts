/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// plane imports
import { API_BASE_URL } from "@plane/constants";
import type {
  TContract,
  TContractAuthoringSettings,
  TContractAuthoringRecipient,
  TContractChat,
  TContractChatMessage,
  TContractChatMode,
  TContractFilters,
  TContractJob,
  TContractQuery,
  TContractRetryOptions,
  TContractSignatureRequest,
  TContractSigningLink,
  TContractTemplate,
  TContractTemplateRevision,
  TContractTemplateSchemaResponse,
  TContractUpdatePayload,
} from "@plane/types";
// services
import { APIService } from "@/services/api.service";

export class ContractService extends APIService {
  constructor() {
    super(API_BASE_URL);
  }

  async getContracts(workspaceSlug: string, filters?: TContractFilters): Promise<TContract[]> {
    // Multi-value filters repeat their key (?estatus=a&estatus=b) — Django getlist()
    const params = new URLSearchParams();
    if (filters?.asset_id) params.set("asset_id", filters.asset_id);
    if (filters?.search) params.set("search", filters.search);
    if (filters?.person) params.set("person", filters.person);
    if (filters?.artist) params.set("artist", filters.artist);
    if (filters?.year) params.set("year", filters.year);
    (filters?.estatus ?? []).forEach((value) => params.append("estatus", value));
    (filters?.tipo ?? []).forEach((value) => params.append("tipo", value));
    (filters?.processing_status ?? []).forEach((value) => params.append("processing_status", value));
    (filters?.tags ?? []).forEach((value) => params.append("tag", value));
    if (filters?.fecha_fin_efectiva_after) params.set("fecha_fin_efectiva_after", filters.fecha_fin_efectiva_after);
    if (filters?.fecha_fin_efectiva_before) params.set("fecha_fin_efectiva_before", filters.fecha_fin_efectiva_before);
    if (filters?.order) params.set("order", filters.order);
    const query = params.toString();
    return this.get(`/api/workspaces/${workspaceSlug}/contracts/${query ? `?${query}` : ""}`)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async getContract(workspaceSlug: string, contractId: string): Promise<TContract> {
    return this.get(`/api/workspaces/${workspaceSlug}/contracts/${contractId}/`)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async updateContract(workspaceSlug: string, contractId: string, data: TContractUpdatePayload): Promise<TContract> {
    return this.patch(`/api/workspaces/${workspaceSlug}/contracts/${contractId}/`, data)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async retryContract(
    workspaceSlug: string,
    contractId: string,
    options?: TContractRetryOptions
  ): Promise<TContractJob> {
    return this.post(`/api/workspaces/${workspaceSlug}/contracts/${contractId}/retry/`, options ?? {})
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async reanalyzeContract(workspaceSlug: string, contractId: string): Promise<TContractJob> {
    return this.post(`/api/workspaces/${workspaceSlug}/contracts/${contractId}/reanalyze/`)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async confirmReanalysis(workspaceSlug: string, contractId: string, accept: boolean): Promise<TContract> {
    return this.post(`/api/workspaces/${workspaceSlug}/contracts/${contractId}/reanalyze/confirm/`, { accept })
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async getJobs(
    workspaceSlug: string,
    options?: { contractId?: string; active?: boolean; contractIds?: string[] }
  ): Promise<TContractJob[]> {
    const params = new URLSearchParams();
    if (options?.active) params.set("active", "true");
    (options?.contractIds ?? []).forEach((id) => params.append("contract_ids", id));
    const query = params.toString();
    const base = options?.contractId
      ? `/api/workspaces/${workspaceSlug}/contracts/${options.contractId}/jobs/`
      : `/api/workspaces/${workspaceSlug}/contracts/jobs/`;
    return this.get(`${base}${query ? `?${query}` : ""}`)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async bulkAction(
    workspaceSlug: string,
    action: "retry" | "reanalyze",
    contractIds: string[],
    retryOptions?: TContractRetryOptions
  ): Promise<{ dispatched: string[]; skipped: string[] }> {
    return this.post(`/api/workspaces/${workspaceSlug}/contracts/bulk/`, {
      action,
      contract_ids: contractIds,
      retry_options: retryOptions ?? {},
    })
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  // chat

  async getChatModels(
    workspaceSlug: string
  ): Promise<{ models: Array<{ id: string; provider: "gemini" | "deepseek" }>; default_model: string }> {
    return this.get(`/api/workspaces/${workspaceSlug}/contracts/chats/models/`)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async getChats(
    workspaceSlug: string,
    options?: { mode?: TContractChatMode; contractId?: string }
  ): Promise<TContractChat[]> {
    const params = new URLSearchParams();
    if (options?.mode) params.set("mode", options.mode);
    if (options?.contractId) params.set("contract_id", options.contractId);
    const query = params.toString();
    return this.get(`/api/workspaces/${workspaceSlug}/contracts/chats/${query ? `?${query}` : ""}`)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async createChat(
    workspaceSlug: string,
    data: { mode: TContractChatMode; contract_id?: string; title?: string }
  ): Promise<TContractChat> {
    return this.post(`/api/workspaces/${workspaceSlug}/contracts/chats/`, data)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async getChatDetail(
    workspaceSlug: string,
    chatId: string
  ): Promise<{ chat: TContractChat; messages: TContractChatMessage[] }> {
    return this.get(`/api/workspaces/${workspaceSlug}/contracts/chats/${chatId}/`)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  /** URL the assistant-ui transport streams agent turns from */
  getAgentChatUrl(workspaceSlug: string): string {
    return `${API_BASE_URL}/api/workspaces/${workspaceSlug}/contracts/agent/chat/`;
  }

  /** Replaces the stored transcript with the client thread (UI messages + their parts) */
  async saveChatTurn(
    workspaceSlug: string,
    chatId: string,
    messages: { id?: string; role: "user" | "assistant"; parts: unknown[] }[]
  ): Promise<{ messages: TContractChatMessage[] }> {
    return this.post(`/api/workspaces/${workspaceSlug}/contracts/chats/${chatId}/turns/`, { messages })
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async deleteChat(workspaceSlug: string, chatId: string): Promise<void> {
    return this.delete(`/api/workspaces/${workspaceSlug}/contracts/chats/${chatId}/`)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async sendChatMessage(
    workspaceSlug: string,
    chatId: string,
    message: string,
    model?: string
  ): Promise<{ user_message: TContractChatMessage; assistant_message: TContractChatMessage }> {
    return this.post(`/api/workspaces/${workspaceSlug}/contracts/chats/${chatId}/messages/`, { message, model })
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async getQueries(workspaceSlug: string): Promise<TContractQuery[]> {
    return this.get(`/api/workspaces/${workspaceSlug}/contracts/queries/`)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async createQuery(workspaceSlug: string, query: string): Promise<TContractQuery> {
    return this.post(`/api/workspaces/${workspaceSlug}/contracts/queries/`, { query })
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async getTemplates(workspaceSlug: string): Promise<TContractTemplate[]> {
    return this.get(`/api/workspaces/${workspaceSlug}/contract-templates/`).then((response) => response.data);
  }

  async getTemplate(workspaceSlug: string, templateId: string): Promise<TContractTemplate> {
    return this.get(`/api/workspaces/${workspaceSlug}/contract-templates/${templateId}/`).then(
      (response) => response.data
    );
  }

  /**
   * Server-rendered PDF for any contract asset. Word sources are converted on
   * the API side, which the browser's .docx renderer does not do reliably.
   */
  getContractAssetPreviewPdfUrl(workspaceSlug: string, assetId: string, version?: string): string {
    const query = version ? `?v=${encodeURIComponent(version)}` : "";
    return `${API_BASE_URL}/api/workspaces/${workspaceSlug}/contract-assets/${assetId}/preview-pdf/${query}`;
  }

  /** Fetches the converted preview with Plane's authenticated HTTP client. */
  async getContractAssetPreviewPdf(workspaceSlug: string, assetId: string, version?: string): Promise<Blob> {
    const query = version ? `?v=${encodeURIComponent(version)}` : "";
    return this.get(
      `/api/workspaces/${workspaceSlug}/contract-assets/${assetId}/preview-pdf/${query}`,
      {},
      { responseType: "blob" }
    ).then((response) => response.data);
  }

  getContractAssetThumbnailUrl(workspaceSlug: string, assetId: string, version?: string): string {
    const query = version ? `?v=${encodeURIComponent(version)}` : "";
    return `${API_BASE_URL}/api/workspaces/${workspaceSlug}/contract-assets/${assetId}/thumbnail/${query}`;
  }

  async deleteTemplate(workspaceSlug: string, templateId: string): Promise<void> {
    return this.delete(`/api/workspaces/${workspaceSlug}/contract-templates/${templateId}/`).then(
      (response) => response.data
    );
  }

  async createTemplate(
    workspaceSlug: string,
    payload: { name: string; description?: string; file: File }
  ): Promise<TContractTemplate> {
    const data = new FormData();
    data.append("name", payload.name);
    data.append("description", payload.description ?? "");
    data.append("file", payload.file);
    return this.post(`/api/workspaces/${workspaceSlug}/contract-templates/`, data, {
      headers: { "Content-Type": "multipart/form-data" },
    }).then((response) => response.data);
  }

  async createVariant(
    workspaceSlug: string,
    templateId: string,
    payload: { name: string; source_variant_id: string }
  ): Promise<TContractTemplate> {
    return this.post(`/api/workspaces/${workspaceSlug}/contract-templates/${templateId}/variants/`, payload).then(
      (response) => response.data
    );
  }

  async getTemplateSchema(
    workspaceSlug: string,
    variantId: string,
    revisionId?: string
  ): Promise<TContractTemplateSchemaResponse> {
    const query = revisionId ? `?revision_id=${encodeURIComponent(revisionId)}` : "";
    return this.get(`/api/workspaces/${workspaceSlug}/contract-variants/${variantId}/schema/${query}`).then(
      (response) => response.data
    );
  }

  async saveTemplateRevision(
    workspaceSlug: string,
    variantId: string,
    name?: string
  ): Promise<TContractTemplateRevision> {
    return this.post(`/api/workspaces/${workspaceSlug}/contract-variants/${variantId}/revisions/`, { name }).then(
      (response) => response.data
    );
  }

  async startTemplateEditSession(workspaceSlug: string, variantId: string): Promise<{ backup_asset_id: string }> {
    return this.post(`/api/workspaces/${workspaceSlug}/contract-variants/${variantId}/edit-session/`).then(
      (response) => response.data
    );
  }

  async finishTemplateEditSession(
    workspaceSlug: string,
    variantId: string,
    payload: {
      backup_asset_id: string;
      action: "DISCARD" | "OVERWRITE" | "NEW_REVISION" | "NEW_VARIANT";
      name?: string;
    }
  ): Promise<{ template: TContractTemplate; variant_id: string; revision_id: string | null; action: string }> {
    return this.patch(`/api/workspaces/${workspaceSlug}/contract-variants/${variantId}/edit-session/`, payload).then(
      (response) => response.data
    );
  }

  async getSignatureRequests(workspaceSlug: string): Promise<TContractSignatureRequest[]> {
    return this.get(`/api/workspaces/${workspaceSlug}/contract-signature-requests/`).then((response) => response.data);
  }

  async deleteSignatureRequests(
    workspaceSlug: string,
    requestIds: string[],
    options: { deleteFiles: boolean; deleteAnalysis: boolean }
  ): Promise<{ deleted: string[]; not_found: string[]; files_deleted: number; analyses_deleted: number }> {
    return this.post(`/api/workspaces/${workspaceSlug}/contract-signature-requests/delete/`, {
      request_ids: requestIds,
      delete_files: options.deleteFiles,
      delete_analysis: options.deleteAnalysis,
      confirm: true,
    }).then((response) => response.data);
  }

  async getSignatureRequest(workspaceSlug: string, requestId: string): Promise<TContractSignatureRequest> {
    return this.get(`/api/workspaces/${workspaceSlug}/contract-signature-requests/${requestId}/`).then(
      (response) => response.data
    );
  }

  async prepareSignatureRequest(
    workspaceSlug: string,
    payload: {
      variant_id: string;
      title: string;
      authoring_mode?: "DOCUMENT" | "TEMPLATE";
      revision_id?: string;
      variable_values?: Record<string, string>;
      omitted_variable_keys?: string[];
      recipients?: Array<Partial<TContractAuthoringRecipient>>;
    }
  ): Promise<TContractSignatureRequest> {
    return this.post(`/api/workspaces/${workspaceSlug}/contract-signature-requests/`, payload).then(
      (response) => response.data
    );
  }

  async getSignatureRequestPdf(workspaceSlug: string, requestId: string): Promise<{ url: string }> {
    return this.get(`/api/workspaces/${workspaceSlug}/contract-signature-requests/${requestId}/pdf/`).then(
      (response) => response.data
    );
  }

  async saveSignatureRequest(
    workspaceSlug: string,
    requestId: string,
    recipients: TContractAuthoringRecipient[],
    authoringSettings?: TContractAuthoringSettings,
    title?: string
  ): Promise<TContractSignatureRequest> {
    return this.patch(`/api/workspaces/${workspaceSlug}/contract-signature-requests/${requestId}/`, {
      recipients,
      authoring_settings: authoringSettings,
      title,
    }).then((response) => response.data);
  }

  async sendSignatureRequest(
    workspaceSlug: string,
    requestId: string,
    recipients: TContractAuthoringRecipient[],
    authoringSettings?: TContractAuthoringSettings
  ): Promise<TContractSignatureRequest> {
    return this.post(`/api/workspaces/${workspaceSlug}/contract-signature-requests/${requestId}/send/`, {
      recipients,
      authoring_settings: authoringSettings,
    }).then((response) => response.data);
  }

  async syncSignatureRequest(workspaceSlug: string, requestId: string): Promise<TContractSignatureRequest> {
    return this.post(`/api/workspaces/${workspaceSlug}/contract-signature-requests/${requestId}/sync/`).then(
      (response) => response.data
    );
  }

  async getSignatureRequestLinks(workspaceSlug: string, requestId: string): Promise<TContractSigningLink[]> {
    return this.get(`/api/workspaces/${workspaceSlug}/contract-signature-requests/${requestId}/links/`).then(
      (response) => response.data.links
    );
  }
}

export const contractService = new ContractService();
