/**
 * HTTP trigger surface for the contracts pipeline. Django (celery) calls
 * these endpoints with a shared secret; the Worker creates the corresponding
 * Workflow instance and returns its id. Narrow, single-purpose surface so
 * Django never needs a broad Cloudflare account token.
 */

import { handleMusicAiMap, type AiMapRequest } from "./ai-map";
import { handleAssistantChat, listAssistantModels, type AssistantChatRequest } from "./assistant";
import { estimateDeepReview, type Price } from "./deep-review/core";
import { deepseekPrice, getDeepseekBalance, isDeepseekPeak, nextDeepseekOffPeak } from "./lib/pricing";
import { handleChat, type ChatRequest } from "./chat";
import { handleContractsAgent, listContractsAgentModels, type ContractsAgentRequest } from "./contracts-agent";
import { listChatModels } from "./lib/ai";
import { WorkerConfigurationError } from "./lib/internal-api";
import { ContractPipelineWorkflow, type PipelineParams } from "./workflows/contract-pipeline";
import { ContractQueryWorkflow, type QueryParams } from "./workflows/contract-query";
import { DeepReviewLaneWorkflow, DeepReviewWorkflow, laneCount, type DeepReviewParams } from "./workflows/deep-review";
import { TaggingWorkflow, type TaggingParams } from "./workflows/tagging";

export { ContractPipelineWorkflow, ContractQueryWorkflow, DeepReviewLaneWorkflow, DeepReviewWorkflow, TaggingWorkflow };

/** DeepSeek models a deep review can run on, priced (it calls DeepSeek directly). */
function deepReviewModels(env: Env): { prices: Record<string, Price>; defaultModel: string } {
  const prices: Record<string, Price> = {};
  for (const id of (env.DEEPSEEK_MODEL_LIST || env.DEEPSEEK_MODEL || "deepseek-flash").split(",")) {
    const model = id.trim();
    const price = model ? deepseekPrice(model) : null;
    if (price) prices[model] = price;
  }
  const configured = env.CHAT_DEFAULT_MODEL?.trim();
  const ids = Object.keys(prices);
  return { prices, defaultModel: configured && ids.includes(configured) ? configured : (ids[0] ?? "") };
}

/** Workflow instance id format (https://developers.cloudflare.com/workflows/build/workers-api/). */
const INSTANCE_ID = /^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,99}$/;

/** Constant-time secret comparison (hash first so length differences don't leak). */
async function verifySecret(provided: string, expected: string): Promise<boolean> {
  if (!expected) return false;
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(providedHash, expectedHash);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ status: "ok" });
    }

    const provided = request.headers.get("X-Trigger-Secret") ?? "";
    if (!(await verifySecret(provided, env.CF_WORKER_TRIGGER_SECRET))) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Env-declared chat models for the UI picker
    if (url.pathname === "/models" && request.method === "GET") {
      return Response.json(listChatModels(env));
    }

    // Same list, but the default follows ASSISTANT_AI_PROVIDER
    if (url.pathname === "/assistant/models" && request.method === "GET") {
      return Response.json(listAssistantModels(env));
    }

    // The DeepSeek account balance, read with this Worker's key so it never reaches a browser
    if (url.pathname === "/assistant/balance" && request.method === "GET") {
      if (!env.DEEPSEEK_API_KEY) return Response.json({ error: "DeepSeek is not configured" }, { status: 404 });
      try {
        return Response.json(await getDeepseekBalance(env.DEEPSEEK_API_KEY));
      } catch (error) {
        console.error(JSON.stringify({ message: "deepseek balance failed", error: String(error) }));
        return Response.json({ error: "Could not read the DeepSeek balance" }, { status: 502 });
      }
    }

    // Tool-capable models for the contracts agent
    if (url.pathname === "/contracts/models" && request.method === "GET") {
      return Response.json(listContractsAgentModels(env));
    }

    if (request.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    try {
      if (url.pathname === "/trigger/extract") {
        const params = await request.json<PipelineParams>();
        if (!params.job_id || !params.contract_id || !params.workspace_id) {
          return Response.json({ error: "job_id, contract_id and workspace_id are required" }, { status: 400 });
        }
        if (!INSTANCE_ID.test(params.job_id)) {
          return Response.json({ error: "job_id is not a valid instance id" }, { status: 400 });
        }
        // The job id is the instance id: a retried trigger gets the same instance.
        let instance: WorkflowInstance;
        let reused = false;
        try {
          instance = await env.CONTRACT_PIPELINE.create({ id: params.job_id, params });
        } catch (createError) {
          try {
            instance = await env.CONTRACT_PIPELINE.get(params.job_id);
            reused = true;
          } catch {
            throw createError;
          }
        }
        console.log(JSON.stringify({ message: "pipeline instance ready", id: instance.id, reused }));
        return Response.json({ workflow_instance_id: instance.id, reused });
      }

      const terminate = url.pathname.match(/^\/pipeline\/([^/]+)\/terminate\/?$/);
      if (terminate) {
        const jobId = decodeURIComponent(terminate[1]);
        if (!INSTANCE_ID.test(jobId)) return Response.json({ error: "Invalid job id" }, { status: 400 });
        let instance: WorkflowInstance;
        try {
          instance = await env.CONTRACT_PIPELINE.get(jobId);
        } catch {
          return Response.json({ terminated: false, status: "not_found" }, { status: 404 });
        }
        const { status } = await instance.status();
        if (["complete", "errored", "terminated"].includes(status)) {
          return Response.json({ terminated: false, status });
        }
        try {
          await instance.terminate();
        } catch (error) {
          // It finished between the status read and the terminate call
          const { status: latest } = await instance.status();
          console.log(
            JSON.stringify({ message: "terminate refused", id: jobId, status: latest, error: String(error) })
          );
          return Response.json({ terminated: false, status: latest });
        }
        console.log(JSON.stringify({ message: "pipeline instance terminated", id: jobId }));
        return Response.json({ terminated: true, status: "terminated" });
      }

      if (url.pathname === "/trigger/query") {
        const params = await request.json<QueryParams>();
        if (!params.job_id || !params.query_id || !params.workspace_id || !params.user_query) {
          return Response.json(
            { error: "job_id, query_id, workspace_id and user_query are required" },
            { status: 400 }
          );
        }
        const instance = await env.CONTRACT_QUERY.create({
          id: crypto.randomUUID(),
          params,
        });
        console.log(JSON.stringify({ message: "query instance created", id: instance.id, job: params.job_id }));
        return Response.json({ workflow_instance_id: instance.id });
      }

      // Prices a deep review from the texts' sizes (Django never sees rates)
      if (url.pathname === "/assistant/deep-review/estimate" && request.method === "POST") {
        const body = await request.json<{ sizes?: number[] }>();
        const sizes = Array.isArray(body.sizes) ? body.sizes.map(Number).filter((size) => size > 0) : [];
        const { prices, defaultModel } = deepReviewModels(env);
        if (Object.keys(prices).length === 0) {
          return Response.json({ error: "No DeepSeek model is configured" }, { status: 503 });
        }
        const now = new Date();
        return Response.json(
          estimateDeepReview(sizes, prices, {
            lanes: laneCount(env),
            nowPeak: isDeepseekPeak(now),
            defaultModel,
            nextOffPeak: nextDeepseekOffPeak(now).toISOString(),
          })
        );
      }

      if (url.pathname === "/trigger/deep-review") {
        const params = await request.json<DeepReviewParams>();
        if (!params.review_id || !params.workspace_id || !params.model) {
          return Response.json({ error: "review_id, workspace_id and model are required" }, { status: 400 });
        }
        // The review id makes a retried trigger reuse the same instance.
        const instance = await env.DEEP_REVIEW.create({ id: `deep-review-${params.review_id}`, params });
        console.log(JSON.stringify({ message: "deep review instance created", id: instance.id }));
        return Response.json({ workflow_instance_id: instance.id });
      }

      if (url.pathname === "/trigger/tagging") {
        const params = await request.json<TaggingParams>();
        const needsTypes = params.mode !== "merge";
        if (
          !params.run_id ||
          !params.workspace_id ||
          !Array.isArray(params.types) ||
          (needsTypes && params.types.length === 0)
        ) {
          return Response.json({ error: "run_id, workspace_id and types are required" }, { status: 400 });
        }
        // The run id makes a retried trigger reuse the same instance.
        const instance = await env.TAGGING_RUN.create({ id: `tagging-${params.run_id}`, params });
        console.log(JSON.stringify({ message: "tagging instance created", id: instance.id, run: params.run_id }));
        return Response.json({ workflow_instance_id: instance.id });
      }

      if (url.pathname === "/contracts/agent") {
        const body = await request.json<ContractsAgentRequest>();
        if (!body.workspace_id || !Array.isArray(body.messages) || body.messages.length === 0) {
          return Response.json({ error: "workspace_id and messages are required" }, { status: 400 });
        }
        return handleContractsAgent(env, body);
      }

      if (url.pathname === "/assistant/chat") {
        const body = await request.json<AssistantChatRequest>();
        if (!body.workspace_id || !Array.isArray(body.messages) || body.messages.length === 0) {
          return Response.json({ error: "workspace_id and messages are required" }, { status: 400 });
        }
        return handleAssistantChat(env, body);
      }

      if (url.pathname === "/music/ai-map") {
        const body = await request.json<AiMapRequest>();
        if (!body.columns || !Array.isArray(body.canonical_fields)) {
          return Response.json({ error: "columns and canonical_fields are required" }, { status: 400 });
        }
        return Response.json(await handleMusicAiMap(env, body));
      }

      if (url.pathname === "/chat") {
        const body = await request.json<ChatRequest>();
        if (!body.workspace_id || !body.query || !body.mode) {
          return Response.json({ error: "workspace_id, mode and query are required" }, { status: 400 });
        }
        const result = await handleChat(env, body);
        return Response.json(result);
      }

      return Response.json({ error: "Not found" }, { status: 404 });
    } catch (error) {
      if (error instanceof WorkerConfigurationError) {
        console.error(
          JSON.stringify({
            message: "worker configuration is incomplete",
            path: url.pathname,
            missing: error.missing,
          })
        );
        return Response.json(
          {
            error: "The assistant service is not configured correctly",
            code: error.code,
            missing: error.missing,
          },
          { status: 503 }
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ message: "trigger failed", path: url.pathname, error: message }));
      return Response.json({ error: "Internal error" }, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
