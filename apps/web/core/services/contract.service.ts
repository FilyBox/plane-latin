/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// plane imports
import { API_BASE_URL } from "@plane/constants";
import type {
  TContract,
  TContractBulkUpdateFields,
  TContractDetail,
  TContractDuplicateCheck,
  TContractPage,
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
  TContractView,
} from "@plane/types";
// services
import { APIService } from "@/services/api.service";

export class ContractService extends APIService {
  constructor() {
    super(API_BASE_URL);
  }

  /** Query string shared by the list, its pages and the export */
  private contractListParams(filters?: TContractFilters, view?: TContractView): URLSearchParams {
    // Multi-value filters repeat their key (?estatus=a&estatus=b) — Django getlist()
    const params = new URLSearchParams();
    if (view) params.set("vista", view);
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
    if (filters?.vence_en) params.set("vence_en", String(filters.vence_en));
    if (filters?.order) params.set("order", filters.order);
    return params;
  }

  async getContracts(workspaceSlug: string, filters?: TContractFilters, view?: TContractView): Promise<TContract[]> {
    const query = this.contractListParams(filters, view).toString();
    return this.get(`/api/workspaces/${workspaceSlug}/contracts/${query ? `?${query}` : ""}`)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  /** One page of the list. Falls back gracefully if the server still answers with a plain array. */
  async getContractsPage(
    workspaceSlug: string,
    filters: TContractFilters | undefined,
    view: TContractView | undefined,
    perPage: number,
    cursor?: string | null
  ): Promise<TContractPage> {
    const params = this.contractListParams(filters, view);
    params.set("per_page", String(perPage));
    if (cursor) params.set("cursor", cursor);
    return this.get(`/api/workspaces/${workspaceSlug}/contracts/?${params.toString()}`)
      .then((response) => {
        const data = response?.data;
        if (Array.isArray(data)) return { results: data, next_cursor: null, total: data.length };
        return data as TContractPage;
      })
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  /** Downloads the filtered list as a spreadsheet. */
  async exportContracts(
    workspaceSlug: string,
    type: "xlsx" | "csv",
    filters?: TContractFilters,
    view?: TContractView
  ): Promise<{ blob: Blob; fileName: string | null }> {
    const params = this.contractListParams(filters, view);
    params.set("type", type);
    return this.get(
      `/api/workspaces/${workspaceSlug}/contracts/export/?${params.toString()}`,
      {},
      { responseType: "blob" }
    )
      .then((response) => {
        const disposition: string = response?.headers?.["content-disposition"] ?? "";
        const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
        return { blob: response.data as Blob, fileName: match ? decodeURIComponent(match[1]) : null };
      })
      .catch((error) => {
        throw error?.response?.data ?? error;
      });
  }

  async checkDuplicates(
    workspaceSlug: string,
    files: { name: string; size: number; hash: string }[]
  ): Promise<TContractDuplicateCheck> {
    return this.post(`/api/workspaces/${workspaceSlug}/contracts/check-duplicates/`, { files })
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async cancelJob(workspaceSlug: string, contractId: string, jobId: string): Promise<TContractJob> {
    return this.post(`/api/workspaces/${workspaceSlug}/contracts/${contractId}/jobs/${jobId}/cancel/`)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async bulkUpdate(
    workspaceSlug: string,
    contractIds: string[],
    fields: TContractBulkUpdateFields
  ): Promise<{ updated?: string[] }> {
    return this.post(`/api/workspaces/${workspaceSlug}/contracts/bulk/`, {
      action: "update",
      ids: contractIds,
      contract_ids: contractIds,
      fields,
    })
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async getContract(workspaceSlug: string, contractId: string): Promise<TContractDetail> {
    return this.get(`/api/workspaces/${workspaceSlug}/contracts/${contractId}/`)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async updateContract(
    workspaceSlug: string,
    contractId: string,
    data: TContractUpdatePayload
  ): Promise<TContractDetail> {
    return this.patch(`/api/workspaces/${workspaceSlug}/contracts/${contractId}/`, data)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  /** Deletes the contract and its PDF, the way the file library deletes a file. */
  async deleteContract(workspaceSlug: string, contractId: string): Promise<void> {
    return this.delete(`/api/workspaces/${workspaceSlug}/contracts/${contractId}/`)
      .then(() => undefined)
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

  /** `fields` applies only those proposed fields; the rest of the proposal is discarded. */
  async confirmReanalysis(
    workspaceSlug: string,
    contractId: string,
    accept: boolean,
    fields?: string[]
  ): Promise<TContractDetail> {
    return this.post(`/api/workspaces/${workspaceSlug}/contracts/${contractId}/reanalyze/confirm/`, {
      accept,
      ...(fields ? { fields } : {}),
    })
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
    action: "retry" | "reanalyze" | "delete" | "editorial",
    contractIds: string[],
    retryOptions?: TContractRetryOptions,
    /** "editorial" only: true files the contracts under Editoriales, false takes them out. */
    esEditorial?: boolean
  ): Promise<{ dispatched?: string[]; skipped?: string[]; deleted?: string[]; updated?: string[] }> {
    return this.post(`/api/workspaces/${workspaceSlug}/contracts/bulk/`, {
      action,
      contract_ids: contractIds,
      retry_options: retryOptions ?? {},
      ...(esEditorial === undefined ? {} : { es_editorial: esEditorial }),
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

  /* Template / signature-request actions. Errors carry the HTTP status so the
     UI can tell an endpoint that is not implemented yet (501) apart. */

  private rethrowWithStatus(error: any): never {
    const data = error?.response?.data;
    throw {
      ...(data && typeof data === "object" ? data : {}),
      status: error?.response?.status,
    } satisfies import("@plane/types").TContractActionError;
  }

  async updateTemplate(
    workspaceSlug: string,
    templateId: string,
    payload: import("@plane/types").TContractTemplateUpdatePayload
  ): Promise<TContractTemplate> {
    return this.patch(`/api/workspaces/${workspaceSlug}/contract-templates/${templateId}/`, payload)
      .then((response) => response.data)
      .catch((error) => this.rethrowWithStatus(error));
  }

  async updateVariant(
    workspaceSlug: string,
    variantId: string,
    payload: import("@plane/types").TContractVariantUpdatePayload
  ): Promise<import("@plane/types").TContractTemplateVariant> {
    return this.patch(`/api/workspaces/${workspaceSlug}/contract-variants/${variantId}/`, payload)
      .then((response) => response.data)
      .catch((error) => this.rethrowWithStatus(error));
  }

  async deleteVariant(workspaceSlug: string, variantId: string): Promise<void> {
    return this.delete(`/api/workspaces/${workspaceSlug}/contract-variants/${variantId}/`)
      .then(() => undefined)
      .catch((error) => this.rethrowWithStatus(error));
  }

  async cancelSignatureRequest(workspaceSlug: string, requestId: string): Promise<TContractSignatureRequest> {
    return this.post(`/api/workspaces/${workspaceSlug}/contract-signature-requests/${requestId}/cancel/`)
      .then((response) => response.data)
      .catch((error) => this.rethrowWithStatus(error));
  }

  async remindSignatureRequest(workspaceSlug: string, requestId: string): Promise<void> {
    return this.post(`/api/workspaces/${workspaceSlug}/contract-signature-requests/${requestId}/remind/`)
      .then(() => undefined)
      .catch((error) => this.rethrowWithStatus(error));
  }

  /** Returns the new request (a draft copy of the original). */
  async duplicateSignatureRequest(workspaceSlug: string, requestId: string): Promise<TContractSignatureRequest> {
    return this.post(`/api/workspaces/${workspaceSlug}/contract-signature-requests/${requestId}/duplicate/`)
      .then((response) => response.data)
      .catch((error) => this.rethrowWithStatus(error));
  }
}

export const contractService = new ContractService();
