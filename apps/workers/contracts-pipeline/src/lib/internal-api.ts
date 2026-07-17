/**
 * Client for Plane's Django internal API (/api/internal/). The Worker never
 * touches Postgres directly — Django owns the schema; every read/write goes
 * through these endpoints, authenticated with the shared secret.
 */

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
    reportProgress: (
      jobId: string,
      data: { progress?: number; current_stage?: string; status?: string; error?: { message: string; stage: string } }
    ) => request<{ status: string }>("POST", `/internal/contract-jobs/${jobId}/progress/`, data),
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
    getWorkspaceTags: (workspaceId: string) =>
      request<{ tags: string[]; detailed?: Array<{ name: string; kind: string }> }>(
        "GET",
        `/internal/workspaces/${workspaceId}/file-tags/`
      ),
    searchChunks: (workspaceId: string, embedding: number[], limit: number) =>
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
      }>("POST", `/internal/workspaces/${workspaceId}/chunks/search/`, { embedding, limit }),
    // Generic escape hatch for one-off internal endpoints (assistant tools)
    request,
  };
}
