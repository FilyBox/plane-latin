/**
 * Client for Plane's Django internal API (/api/internal/). The Worker never
 * touches Postgres directly — Django owns the schema; every read/write goes
 * through these endpoints, authenticated with the shared secret.
 */

import type { WorkPayload } from "./contract-analysis";

export class InternalApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "InternalApiError";
    this.status = status;
  }
}

export class WorkerConfigurationError extends Error {
  readonly code = "WORKER_CONFIGURATION_ERROR";
  readonly missing: string[];

  constructor(missing: string[]) {
    super(`Missing required Worker configuration: ${missing.join(", ")}`);
    this.name = "WorkerConfigurationError";
    this.missing = missing;
  }
}

/** Stage codes a contract job moves through (shown translated in the UI). */
export type JobStage =
  | "queued"
  | "starting"
  | "extracting_text"
  | "waiting_ocr"
  | "collecting_text"
  | "embedding"
  | "analyzing"
  | "saving"
  | "classifying"
  | "syncing_tags"
  | "done"
  | "failed"
  | "cancelled"
  | "timeout";

export type JobProgress = {
  progress?: number;
  /** Stage code (`JobStage` for contract jobs; query jobs still send text).
   * Sent both as `current_stage` (what Django reads today) and `stage`. */
  current_stage?: string;
  stage?: string;
  status?: string;
  detail?: string;
  detail_data?: Record<string, number | boolean | string>;
  error?: { message: string; stage: string };
  usage?: { calls: unknown[]; total_cost_usd: number };
};

/** A contract ⇄ song/release link (GET .../assistant/contracts/{id}/works/). */
export type ContractWorkLink = {
  id: string;
  status: "LINKED" | "SUGGESTED" | "DISMISSED";
  source?: string;
  rights_type?: string | null;
  entity_type: "music_track" | "music_release";
  entity_id: string | null;
  entity?: { title?: string; subtitle?: string; path?: string; isrc?: string | null } | null;
  suggested?: { title?: string; artists?: string[] | string; isrc?: string; upc?: string } | null;
  evidence?: { quote?: string; page?: number | null } | null;
  confidence?: number | null;
};

/** A song's contract link (GET .../assistant/music/tracks/{id}/contracts/). */
export type TrackContractLink = {
  id: string;
  status: "LINKED" | "SUGGESTED" | "DISMISSED";
  rights_type?: string | null;
  contract: {
    id: string;
    titulo?: string | null;
    file_name?: string | null;
    estatus_contrato?: string | null;
    fecha_fin_efectiva?: string | null;
    days_to_expiry?: number | null;
    path?: string;
  };
  evidence?: { quote?: string; page?: number | null } | null;
  confidence?: number | null;
  via_release?: { id: string; title?: string } | null;
};

type InternalApiEnv = Pick<Env, "PLANE_INTERNAL_API_URL" | "PLANE_INTERNAL_API_SECRET">;

export function resolveInternalApiConfig(env: InternalApiEnv): { baseUrl: string; secret: string } {
  const rawUrl = typeof env.PLANE_INTERNAL_API_URL === "string" ? env.PLANE_INTERNAL_API_URL.trim() : "";
  const secret = typeof env.PLANE_INTERNAL_API_SECRET === "string" ? env.PLANE_INTERNAL_API_SECRET.trim() : "";
  const missing = [!rawUrl && "PLANE_INTERNAL_API_URL", !secret && "PLANE_INTERNAL_API_SECRET"].filter(
    (key): key is string => Boolean(key)
  );
  if (missing.length > 0) throw new WorkerConfigurationError(missing);

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new WorkerConfigurationError(["PLANE_INTERNAL_API_URL (invalid URL)"]);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WorkerConfigurationError(["PLANE_INTERNAL_API_URL (must use http or https)"]);
  }

  return { baseUrl: rawUrl.replace(/\/+$/, ""), secret };
}

export function internalApi(env: Env) {
  const { baseUrl, secret } = resolveInternalApiConfig(env);

  const request = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${baseUrl}/api${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Plane-Internal-Key": secret,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new InternalApiError(
        `Internal API ${method} ${path} -> ${response.status}: ${text.slice(0, 300)}`,
        response.status
      );
    }
    return response.json<T>();
  };

  return {
    getPresignedUrl: (assetId: string) =>
      request<{
        url: string;
        name: string | null;
        type: string | null;
        s3_key: string | null;
        s3_bucket: string | null;
      }>("GET", `/internal/assets/${assetId}/presigned-url/`),
    reportProgress: (jobId: string, data: JobProgress) =>
      request<{ status: string }>("POST", `/internal/contract-jobs/${jobId}/progress/`, data),
    getContractText: (contractId: string) =>
      request<{ extracted_text: string | null; has_text: boolean }>("GET", `/internal/contracts/${contractId}/text/`),
    saveContractText: (contractId: string, extractedText: string) =>
      request<{ status: string }>("POST", `/internal/contracts/${contractId}/text/`, { extracted_text: extractedText }),
    saveExtractedData: (
      contractId: string,
      data: Record<string, unknown>,
      mode: "apply" | "proposed",
      modelUsed: string
    ) =>
      request<{ status: string }>("POST", `/internal/contracts/${contractId}/extracted-data/`, {
        data,
        mode,
        model_used: modelUsed,
      }),
    chunksExist: (contractId: string) =>
      request<{ exists: boolean; count: number }>("GET", `/internal/contracts/${contractId}/chunks/`),
    saveChunks: (
      contractId: string,
      chunks: Array<{ index: number; content: string; token_count: number; embedding: number[] }>,
      mode: "replace" | "append" = "replace"
    ) => request<{ status: string }>("POST", `/internal/contracts/${contractId}/chunks/`, { chunks, mode }),
    createThumbnailUpload: (contractId: string) =>
      request<{ upload_data: { url: string; fields: Record<string, string> }; asset_id: string }>(
        "POST",
        `/internal/contracts/${contractId}/thumbnail/`
      ),
    confirmThumbnail: (contractId: string, assetId: string) =>
      request<{ status: string }>("PATCH", `/internal/contracts/${contractId}/thumbnail/`, { asset_id: assetId }),
    listContracts: (workspaceId: string, offset: number, limit: number) =>
      request<{
        total: number;
        offset: number;
        results: Array<{ id: string; titulo: string | null; file_name: string | null; extracted_text: string }>;
      }>("GET", `/internal/workspaces/${workspaceId}/contracts/?offset=${offset}&limit=${limit}`),
    saveQueryResult: (queryId: string, result: Record<string, unknown>, status: "COMPLETED" | "FAILED") =>
      request<{ status: string }>("POST", `/internal/contract-queries/${queryId}/result/`, { result, status }),
    taggingContext: (workspaceId: string) =>
      request<{
        tags: Array<{ name: string; kind: string; usage?: number; catalog?: boolean }>;
        artists: string[];
        vocabulary: Record<string, string[]>;
      }>("GET", `/internal/workspaces/${workspaceId}/tagging/context/`),
    taggingInventory: (workspaceId: string, entityType: string, offset: number, limit: number, runId: string) =>
      request<{
        total: number;
        results: Array<{ id: string; title: string; text: string; tags: string[] }>;
      }>(
        "GET",
        `/internal/workspaces/${workspaceId}/tagging/inventory/?type=${encodeURIComponent(entityType)}&offset=${offset}&limit=${limit}&run_id=${runId}`
      ),
    taggingProgress: (runId: string, body: Record<string, unknown>) =>
      request<{ status: string }>("POST", `/internal/tagging-runs/${runId}/`, body),
    getWorkspaceTags: (workspaceId: string) =>
      request<{ tags: string[]; detailed?: Array<{ name: string; kind: string }> }>(
        "GET",
        `/internal/workspaces/${workspaceId}/file-tags/`
      ),
    // contract_id narrows the search to one contract on the server
    searchChunks: (workspaceId: string, embedding: number[], limit: number, contractId?: string) =>
      request<{
        results: Array<{
          content: string;
          chunk_index: number;
          similarity: number;
          contract_id: string;
          title: string | null;
          file_name: string | null;
          asset_id: string | null;
        }>;
      }>("POST", `/internal/workspaces/${workspaceId}/chunks/search/`, {
        embedding,
        limit,
        ...(contractId ? { contract_id: contractId } : {}),
      }),
    // Saves the analysis' works as SUGGESTED links (never touches LINKED/DISMISSED)
    suggestContractWorks: (workspaceId: string, contractId: string, works: WorkPayload[]) =>
      request<{ linked: number; suggested: number; unmatched: number }>(
        "POST",
        `/internal/workspaces/${workspaceId}/contracts/${contractId}/works/suggest/`,
        { works, source: "AI" }
      ),
    // The assistant's reads run as the asking user
    contractWorks: (workspaceId: string, contractId: string, userId: string) =>
      request<{ links: ContractWorkLink[] }>(
        "GET",
        `/internal/workspaces/${workspaceId}/assistant/contracts/${contractId}/works/?user_id=${encodeURIComponent(userId)}`
      ),
    // Match candidates only: nothing is written
    matchContractWorks: (workspaceId: string, contractId: string, userId: string, works: WorkPayload[]) =>
      request<unknown>("POST", `/internal/workspaces/${workspaceId}/assistant/contract-works/match/`, {
        user_id: userId,
        contract_id: contractId,
        works,
      }),
    trackContracts: (workspaceId: string, trackId: string, userId: string) =>
      request<{ links: TrackContractLink[] }>(
        "GET",
        `/internal/workspaces/${workspaceId}/assistant/music/tracks/${trackId}/contracts/?user_id=${encodeURIComponent(userId)}`
      ),
    // Generic escape hatch for one-off internal endpoints (assistant tools)
    request,
  };
}
