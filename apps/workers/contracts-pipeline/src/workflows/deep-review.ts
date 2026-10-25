/**
 * Deep review: every contract read by the AI against one question.
 *
 * The orchestrator splits the contracts into lanes of similar total size and
 * starts one lane workflow per lane. Each lane reads one contract per step,
 * so a lane holds a single text in memory and owns its own connections; the
 * orchestrator only polls Django for progress. Django keeps the counters and
 * decides when to pause (projection over the estimate) or stop, and every
 * lane learns it from the answer to its own result report.
 *
 * Texts are fetched inside the same step that sends them to the model and
 * never returned from a step, so they are not persisted in workflow state
 * (1 MiB per step result).
 */

import { NonRetryableError } from "cloudflare:workflows";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, type WorkflowStepConfig } from "cloudflare:workers";

import {
  assignLanes,
  mergeChunkAnswers,
  parseChunkAnswer,
  splitText,
  type ChunkAnswer,
  type DeepReviewEstimate,
} from "../deep-review/core";
import { internalApi } from "../lib/internal-api";
import { parseJsonResponse } from "../lib/json-repair";
import { deepseekCallCost, isDeepseekPeak, nextDeepseekOffPeak, type DeepseekUsage } from "../lib/pricing";

export type DeepReviewParams = {
  review_id: string;
  workspace_id: string;
  model: string;
  off_peak: boolean;
};

export type DeepReviewLaneParams = {
  review_id: string;
  model: string;
  contract_ids: string[];
};

type ReviewState = {
  status: string;
  action: "continue" | "pause" | "stop";
  question: string;
  total_count: number;
  done_count: number;
  failed_count: number;
  pending_count: number;
  running_count: number;
  estimate: DeepReviewEstimate;
  estimate_usd: number | null;
};

const DEFAULT_LANES = 50;
const AI_RETRIES: WorkflowStepConfig = {
  retries: { limit: 3, delay: "15 seconds", backoff: "exponential" },
  timeout: "15 minutes",
};
const API_RETRIES: WorkflowStepConfig = { retries: { limit: 5, delay: "5 seconds", backoff: "exponential" } };

export const laneCount = (env: Env) => {
  const configured = Number(env.DEEP_REVIEW_LANES);
  return Number.isFinite(configured) && configured > 0 ? Math.min(500, Math.floor(configured)) : DEFAULT_LANES;
};

// ------------------------------------------------------------- DeepSeek call

class DeepseekError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

/** One JSON answer from DeepSeek, thinking on or off, with its token usage. */
export async function callDeepseekJson(
  env: Env,
  options: { model: string; system: string; prompt: string; maxTokens: number; thinking: boolean }
): Promise<{ text: string; usage: DeepseekUsage }> {
  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
    body: JSON.stringify({
      model: options.model,
      messages: [
        { role: "system", content: options.system },
        { role: "user", content: options.prompt },
      ],
      response_format: { type: "json_object" },
      max_tokens: options.maxTokens,
      thinking: { type: options.thinking ? "enabled" : "disabled" },
    }),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    // 402: no balance left. Other 4xx will not get better with a retry.
    if (response.status === 402) throw new NonRetryableError(`insufficient_balance: ${detail}`);
    if (response.status >= 400 && response.status < 500 && response.status !== 429) {
      throw new NonRetryableError(`deepseek ${response.status}: ${detail}`);
    }
    throw new DeepseekError(`deepseek ${response.status}: ${detail}`, "retryable");
  }
  // Non-streaming requests may be padded with blank lines while queued;
  // JSON.parse ignores the whitespace.
  const data = await response.json<{
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number; completion_tokens?: number };
  }>();
  return {
    text: data.choices?.[0]?.message?.content ?? "",
    usage: {
      cacheHit: data.usage?.prompt_cache_hit_tokens ?? 0,
      cacheMiss: data.usage?.prompt_cache_miss_tokens ?? 0,
      output: data.usage?.completion_tokens ?? 0,
    },
  };
}

const ANSWER_KEYS = "coincide, confianza, razon, cita, fechaInicio, fechaFin, fechaFinEfectiva, artistas";

function contractPrompt(question: string, title: string, text: string, today: string, part?: [number, number]) {
  return `Eres un analista legal. Lee el contrato completo y decide si cumple la petición del usuario. Responde en json.
PETICIÓN: "${question}"
Fecha actual: ${today}
Claves de la respuesta:
- "coincide": true/false.
- "confianza": 0 a 100.
- "razon": por qué, en español, una o dos frases.
- "cita": fragmento textual corto (máximo 300 caracteres) copiado del contrato que lo respalda; "" si no coincide.
- "fechaInicio", "fechaFin": AAAA-MM-DD o null.
- "fechaFinEfectiva": fin considerando prórrogas automáticas, AAAA-MM-DD o null.
- "artistas": artistas o partes principales del contrato.
Básate solo en el texto; si no lo dice, no coincide.${
    part ? `\nEste es el tramo ${part[0]} de ${part[1]} del contrato: responde solo sobre este tramo.` : ""
  }
CONTRATO: ${title || "Sin título"}
${text}`;
}

type ContractOutcome =
  | { kind: "skip"; action: "pause" | "stop" | "skip" }
  | {
      kind: "done";
      answer: ChunkAnswer;
      chunks: number;
      input_tokens: number;
      output_tokens: number;
      cost_usd: number;
    };

/** Reads one contract (in chunks if long) and returns only the small answer. */
async function analyzeContract(env: Env, reviewId: string, contractId: string, model: string, question: string) {
  const api = internalApi(env);
  const source = await api.request<{ action: string; title?: string; text?: string }>(
    "GET",
    `/internal/assistant/deep-reviews/${reviewId}/contracts/${contractId}/text/`
  );
  if (source.action !== "continue") {
    return {
      kind: "skip",
      action: source.action === "pause" ? "pause" : source.action === "stop" ? "stop" : "skip",
    } as ContractOutcome;
  }
  const today = new Date().toISOString().slice(0, 10);
  const parts = splitText(source.text ?? "");
  const answers: ChunkAnswer[] = [];
  let input = 0;
  let output = 0;
  let cost = 0;
  for (const [index, part] of parts.entries()) {
    // Chunks of one contract run in order: one text in memory at a time.
    // eslint-disable-next-line no-await-in-loop
    const { text, usage } = await callDeepseekJson(env, {
      model,
      system: `Responde con un único objeto json con exactamente estas claves: ${ANSWER_KEYS}.`,
      prompt: contractPrompt(
        question,
        source.title ?? "",
        part,
        today,
        parts.length > 1 ? [index + 1, parts.length] : undefined
      ),
      maxTokens: 1_500,
      thinking: false,
    });
    answers.push(parseChunkAnswer(parseJsonResponse<Record<string, unknown>>(text) ?? {}));
    input += usage.cacheHit + usage.cacheMiss;
    output += usage.output;
    cost += deepseekCallCost(model, usage);
  }
  return {
    kind: "done",
    answer: mergeChunkAnswers(answers),
    chunks: parts.length,
    input_tokens: input,
    output_tokens: output,
    cost_usd: cost,
  } as ContractOutcome;
}

// --------------------------------------------------------------------- lane

export class DeepReviewLaneWorkflow extends WorkflowEntrypoint<Env, DeepReviewLaneParams> {
  async run(event: WorkflowEvent<DeepReviewLaneParams>, step: WorkflowStep) {
    const { review_id: reviewId, model, contract_ids: ids } = event.payload;
    const api = internalApi(this.env);
    const base = `/internal/assistant/deep-reviews/${reviewId}`;

    const { question } = await step.do("question", API_RETRIES, () =>
      api.request<ReviewState>("GET", `${base}/state/`)
    );

    let action: string = "continue";
    let index = 0;
    let waits = 0;
    while (index < ids.length) {
      if (action === "stop") break;
      if (action === "pause") {
        // Paused over the estimate: nothing new starts until the admin answers.
        // eslint-disable-next-line no-await-in-loop -- a lane reads its contracts one after another
        await step.sleep(`paused ${waits}`, "10 seconds");
        // eslint-disable-next-line no-await-in-loop
        const state = await step.do(`check ${waits}`, API_RETRIES, () =>
          api.request<ReviewState>("GET", `${base}/state/`)
        );
        action = state.action;
        waits += 1;
        continue;
      }

      const contractId = ids[index];
      let outcome: ContractOutcome;
      let failure: { error: string; error_code: string } | null = null;
      try {
        // eslint-disable-next-line no-await-in-loop
        outcome = await step.do(`contract ${contractId}`, AI_RETRIES, () =>
          analyzeContract(this.env, reviewId, contractId, model, question)
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failure = {
          error: message.slice(0, 500),
          error_code: message.includes("insufficient_balance") ? "insufficient_balance" : "failed",
        };
        outcome = { kind: "skip", action: "skip" };
      }

      if (outcome.kind === "skip" && !failure) {
        if (outcome.action === "skip") index += 1;
        else action = outcome.action;
        continue;
      }

      const report =
        outcome.kind === "done"
          ? {
              status: "done",
              matches: outcome.answer.matches,
              confidence: outcome.answer.confidence,
              reason: outcome.answer.reason,
              quote: outcome.answer.quote,
              details: {
                start_date: outcome.answer.start_date,
                end_date: outcome.answer.end_date,
                effective_end_date: outcome.answer.effective_end_date,
                artists: outcome.answer.artists,
              },
              chunks: outcome.chunks,
              input_tokens: outcome.input_tokens,
              output_tokens: outcome.output_tokens,
              cost_usd: outcome.cost_usd,
            }
          : { status: "failed", ...failure };
      // eslint-disable-next-line no-await-in-loop
      const answer = await step.do(`report ${contractId}`, API_RETRIES, () =>
        api.request<{ action: string }>("POST", `${base}/contracts/${contractId}/result/`, report)
      );
      action = answer.action;
      index += 1;
    }
    return { lane_done: index };
  }
}

// ------------------------------------------------------------- orchestrator

const SYNTHESIS_KEYS = "resumen, descartar";

function synthesisPrompt(question: string, read: number, total: number, candidates: unknown[]) {
  return `Eres un analista legal. Se leyó cada contrato por separado frente a esta petición y estos son los que se marcaron como coincidentes. Responde en json.
PETICIÓN: "${question}"
Contratos leídos: ${read} de ${total}.
Claves de la respuesta:
- "resumen": la respuesta para el usuario, en español, de 2 a 5 frases: qué se encontró y lo más relevante (patrones, excepciones). Si descartaste alguno, di en una frase por qué no cumple. Escribe para el usuario final: no menciones claves, ids, "candidatos", "descartar" ni cómo se hizo la revisión. No enumeres todos los contratos; la tabla se muestra aparte.
- "descartar": ids de los contratos que NO cumplen realmente la petición al revisar su razón y cita (falsos positivos). [] si todos cumplen.
CANDIDATOS:
${JSON.stringify(candidates)}`;
}

export class DeepReviewWorkflow extends WorkflowEntrypoint<Env, DeepReviewParams> {
  async run(event: WorkflowEvent<DeepReviewParams>, step: WorkflowStep) {
    const { review_id: reviewId, model, off_peak: offPeak } = event.payload;
    const api = internalApi(this.env);
    const base = `/internal/assistant/deep-reviews/${reviewId}`;

    try {
      if (offPeak) {
        const wake = await step.do("off-peak start", async () => nextDeepseekOffPeak(new Date()).toISOString());
        if (new Date(wake).getTime() > Date.now()) await step.sleepUntil("wait for off-peak", new Date(wake));
      }

      // Priced for the window it actually starts in; the projection is
      // compared against the high end.
      const started = await step.do("start", API_RETRIES, async () => {
        const state = await api.request<ReviewState>("GET", `${base}/state/`);
        const window = isDeepseekPeak(new Date()) ? "peak" : "off_peak";
        const estimateUsd = state.estimate?.models?.[model]?.[window]?.high ?? null;
        return api.request<ReviewState>("POST", `${base}/state/`, { status: "RUNNING", estimate_usd: estimateUsd });
      });
      if (started.status !== "RUNNING") {
        // Cancelled while it waited for off-peak hours.
        return { cancelled: true };
      }

      const plan = await step.do("plan", API_RETRIES, () =>
        api.request<{ items: { id: string; bytes: number }[] }>("GET", `${base}/plan/`)
      );
      const lanes = assignLanes(plan.items, laneCount(this.env));
      await step.do("start lanes", API_RETRIES, async () => {
        for (let offset = 0; offset < lanes.length; offset += 100) {
          // createBatch takes at most 100 instances per call
          // eslint-disable-next-line no-await-in-loop
          await this.env.DEEP_REVIEW_LANE.createBatch(
            lanes.slice(offset, offset + 100).map((ids, index) => ({
              id: `deep-review-${reviewId}-lane-${offset + index}`,
              params: { review_id: reviewId, model, contract_ids: ids },
            }))
          );
        }
        return { lanes: lanes.length };
      });

      // Follow the lanes through Django's counters until nothing is left to
      // read, or a stop was asked and the reads in flight have landed. A run
      // with no progress for ~20 minutes (a lane died) answers with what it has.
      let lastSettled = -1;
      let idleTicks = 0;
      for (let tick = 0; ; tick++) {
        // eslint-disable-next-line no-await-in-loop
        await step.sleep(`tick ${tick}`, tick < 24 ? "5 seconds" : "15 seconds");
        // eslint-disable-next-line no-await-in-loop
        const state = await step.do(`state ${tick}`, API_RETRIES, () =>
          api.request<ReviewState>("GET", `${base}/state/`)
        );
        const nothingLeft = state.pending_count === 0 && state.running_count === 0;
        const stopped = state.action === "stop" && state.running_count === 0;
        if (nothingLeft || stopped || state.status === "CANCELLED") break;
        const settled = state.done_count + state.failed_count;
        idleTicks = settled === lastSettled && state.status !== "PAUSED" ? idleTicks + 1 : 0;
        lastSettled = settled;
        if (idleTicks >= 80) break;
      }

      const synthesize = () =>
        step.do("synthesis", AI_RETRIES, async () => {
          await api.request<{ status: string }>("POST", `${base}/state/`, { status: "SYNTHESIZING" });
          const data = await api.request<{
            question: string;
            read_count: number;
            total_count: number;
            candidates: { id: string }[];
          }>("GET", `${base}/candidates/`);
          if (data.read_count === 0) return { summary: "", drop_ids: [] as string[] };
          if (data.candidates.length === 0) {
            return {
              summary: `Ningún contrato de los ${data.read_count} analizados cumple la petición.`,
              drop_ids: [] as string[],
            };
          }
          // Past a few hundred, the reasons alone fill the context: no pruning,
          // just the summary over the most confident ones.
          const shown = data.candidates.slice(0, 400);
          const { text } = await callDeepseekJson(this.env, {
            model,
            system: `Responde con un único objeto json con exactamente estas claves: ${SYNTHESIS_KEYS}.`,
            prompt: synthesisPrompt(data.question, data.read_count, data.total_count, shown),
            maxTokens: 8_000,
            thinking: true,
          });
          const parsed = parseJsonResponse<{ resumen?: string; descartar?: unknown[] }>(text) ?? {};
          const known = new Set(shown.map((candidate) => candidate.id));
          return {
            summary: String(parsed.resumen ?? ""),
            drop_ids: (Array.isArray(parsed.descartar) ? parsed.descartar.map(String) : []).filter((id) =>
              known.has(id)
            ),
          };
        });
      // The rows are already paid for: without a summary they are still the answer.
      let synthesis: { summary: string; drop_ids: string[] };
      try {
        synthesis = await synthesize();
      } catch {
        synthesis = { summary: "", drop_ids: [] };
      }

      await step.do("complete", API_RETRIES, () =>
        api.request<{ status: string }>("POST", `${base}/complete/`, {
          summary: synthesis.summary,
          drop_ids: synthesis.drop_ids,
        })
      );
      return { done: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await step.do("report failure", API_RETRIES, () =>
        api.request<{ status: string }>("POST", `${base}/complete/`, { failed: true, error: message.slice(0, 500) })
      );
      throw error;
    }
  }
}
