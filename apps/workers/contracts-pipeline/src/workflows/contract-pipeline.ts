/**
 * Durable multi-step pipeline over one contract: text extraction → embeddings
 * → AI analysis → finalize. Each phase is an independently-retriable step.do()
 * whose return value is persisted.
 *
 * The contract text never travels between steps (a step result is capped at
 * 1 MiB): steps return its length and a short hash, and every step that needs
 * the text reads it from Django itself.
 */

import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent, WorkflowStepConfig } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";

import { generateAnalysisJson, generateEmbeddings, ProviderError, type AnalysisJsonResult } from "../lib/ai";
import { chunkText } from "../lib/chunking";
import {
  ARTISTS_EVIDENCE_KEYS,
  ARTISTS_SCHEMA,
  CLASSIFY_SCHEMA,
  PRIMARY_EVIDENCE_KEYS,
  PRIMARY_SCHEMA,
  SECONDARY_EVIDENCE_KEYS,
  SECONDARY_SCHEMA,
  WORKS_SCHEMA,
  finalizeExtracted,
  mergePartResults,
  mergeWorks,
  normalizeWorks,
  packVector,
  partRanges,
  relevantTags,
  runValidated,
  summarizeUsage,
  textFingerprint,
  toBool,
  toWorkPayload,
  unpackVector,
  withEvidence,
  worksFocus,
  type ExtractedWork,
  type UsageCall,
  type ValidatedRun,
} from "../lib/contract-analysis";
import { InternalApiError, internalApi, type JobProgress, type JobStage } from "../lib/internal-api";
import { repairTruncatedJson } from "../lib/json-repair";
import { deepseekCallCost } from "../lib/pricing";
import {
  collectTextDetectionText,
  getTextDetectionStatus,
  startTextDetection,
  type TextractError,
} from "../lib/textract";
import {
  ANALYSIS_SYSTEM,
  artistsPrompt,
  classificationPrompt,
  contractPrefix,
  primaryPrompt,
  secondaryPrompt,
  worksPrompt,
} from "../prompts";

export type PipelineParams = {
  job_id: string;
  contract_id: string;
  workspace_id: string;
  /** EXTRACT_FULL | RETRY_PARTIAL | REANALYZE */
  mode: string;
  retry_options?: {
    extract_text?: boolean;
    generate_embeddings?: boolean;
    ai_analysis?: boolean;
    extract_thumbnail?: boolean;
    /** Only the editorial classification, over the stored text — the backfill
     * for contracts analyzed before the field existed. */
    classify?: boolean;
    /** Only the works extraction, over the stored text; posts suggestions. */
    works?: boolean;
  };
  /** FileAsset id of the contract PDF */
  asset_id?: string;
};

type TextInfo = { length: number; hash: string };
type PromptKind = "primary" | "secondary" | "artists" | "works";

// Rate limits (429) are common on bulk runs: a long exponential chain
// (20s → ~5 min) lets many pipelines space themselves out.
const AI_RETRIES: WorkflowStepConfig = {
  retries: { limit: 5, delay: "20 seconds", backoff: "exponential" },
  timeout: "10 minutes",
};
const API_RETRIES: WorkflowStepConfig = { retries: { limit: 5, delay: "5 seconds", backoff: "exponential" } };

// Textract throttles under burst load (ProvisionedThroughputExceededException
// at ~5-20 async starts/second) — a deep exponential-backoff retry chain lets
// many concurrent pipelines self-space instead of failing.
const TEXTRACT_RETRIES: WorkflowStepConfig = {
  retries: { limit: 8, delay: "3 seconds", backoff: "exponential" },
  timeout: "2 minutes",
};

/** Chunks per embedding batch: ~40 × (8 KB packed vector + text) stays far
 * under the 1 MiB step result and Django's request-body limit. */
const EMBED_BATCH = 40;

const MAX_TOKENS: Record<PromptKind, number> = { primary: 6_000, secondary: 3_000, artists: 2_500, works: 4_000 };

/** Characters the works-only retry reads per part: the opening plus the
 * windows around annexes and lists (see worksFocus). */
const WORKS_FOCUS_CHARS = 120_000;

/** Maps AWS errors: throttling stays retryable, everything else aborts the step chain. */
const rethrowTextract = (error: unknown): never => {
  if ((error as TextractError).retryable) throw error;
  throw new NonRetryableError(error instanceof Error ? error.message : String(error));
};

/** Provider errors that a retry won't fix (bad key, no balance) stop the run. */
const rethrowProvider = (error: unknown): never => {
  if (error instanceof ProviderError && !error.retryable) throw new NonRetryableError(error.message);
  throw error;
};

/** Progress posts inside long steps must not fail the step. */
const bestEffort = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    console.warn(JSON.stringify({ message: "progress post failed", error: String(error).slice(0, 200) }));
  }
};

/** Token usage and cost of the calls behind one prompt (retries included). */
function usageOf(
  prompt: string,
  outputs: readonly AnalysisJsonResult[],
  extra: { part?: number; attempts: number; repaired: boolean }
): UsageCall {
  const at = new Date();
  const usage: UsageCall = {
    prompt,
    model: outputs[outputs.length - 1]?.model ?? "",
    input_tokens: 0,
    cached_tokens: 0,
    output_tokens: 0,
    cost_usd: 0,
    attempts: extra.attempts,
  };
  for (const output of outputs) {
    usage.input_tokens += output.usage.input;
    usage.cached_tokens += output.usage.cached;
    usage.output_tokens += output.usage.output;
    // Gemini runs only as a fallback; its cost is not tracked (0).
    if (output.provider === "deepseek") {
      usage.cost_usd += deepseekCallCost(
        output.model,
        {
          cacheHit: output.usage.cached,
          cacheMiss: Math.max(0, output.usage.input - output.usage.cached),
          output: output.usage.output,
        },
        at
      );
    }
  }
  if (extra.part !== undefined) usage.part = extra.part;
  if (extra.repaired) usage.repaired = true;
  return usage;
}

export class ContractPipelineWorkflow extends WorkflowEntrypoint<Env, PipelineParams> {
  async run(event: WorkflowEvent<PipelineParams>, step: WorkflowStep) {
    const { job_id: jobId, contract_id: contractId, mode, retry_options: retryOptions } = event.payload;
    const api = internalApi(this.env);

    // Deterministic branch selection — depends only on the payload
    const isReanalysis = mode === "REANALYZE";
    const wants = (key: keyof NonNullable<PipelineParams["retry_options"]>) =>
      mode !== "RETRY_PARTIAL" || Boolean(retryOptions?.[key]);

    // Rebuilt the same way on every replay, so the failure report always
    // names the stage that was running and carries the calls already paid.
    let stage: JobStage = "starting";
    const calls: UsageCall[] = [];

    const report = (code: JobStage, progress: number, extra: Omit<JobProgress, "stage" | "current_stage"> = {}) =>
      api.reportProgress(jobId, { progress, current_stage: code, stage: code, ...extra });

    /** The stored text, read inside the step that needs it. */
    const loadText = async (expected?: TextInfo) => {
      const { extracted_text } = await api.getContractText(contractId);
      const text = extracted_text ?? "";
      if (expected && (text.length !== expected.length || (await textFingerprint(text)) !== expected.hash)) {
        console.warn(JSON.stringify({ message: "contract text changed during the run", job: jobId }));
      }
      return text;
    };
    const describe = async (text: string): Promise<TextInfo> => ({
      length: text.length,
      hash: await textFingerprint(text),
    });

    const fileNameStep = (name: string) =>
      step.do(name, API_RETRIES, async () => {
        const assetId = event.payload.asset_id;
        if (!assetId) return "contrato.pdf";
        const { name: fileName } = await api.getPresignedUrl(assetId);
        return fileName ?? "contrato.pdf";
      });

    /** Posts works as AI suggestions. A 4xx (e.g. an older Django without the
     * endpoint) stops the retries. */
    const suggestWorks = (name: string, works: ExtractedWork[]) =>
      step.do(name, API_RETRIES, async () => {
        try {
          return await api.suggestContractWorks(event.payload.workspace_id, contractId, toWorkPayload(works));
        } catch (error) {
          if (error instanceof InternalApiError && error.status >= 400 && error.status < 500 && error.status !== 429) {
            throw new NonRetryableError(error.message);
          }
          throw error;
        }
      });

    try {
      await step.do("init", API_RETRIES, async () => {
        await report("starting", 5, { status: "RUNNING" });
      });

      // ── Text ──────────────────────────────────────────────────────────
      let info = await step.do("inspect existing text", API_RETRIES, async () => describe(await loadText()));
      let textExtracted = false;

      if ((!info.length || wants("extract_text")) && !isReanalysis) {
        stage = "extracting_text";
        const extractionMode = (this.env.TEXT_EXTRACTION_MODE || "textract").toLowerCase();

        if (extractionMode === "textract") {
          // ── Textract straight from S3: no presigned URL, no download ──
          const location = await step.do("resolve asset location", API_RETRIES, async () => {
            const assetId = event.payload.asset_id;
            if (!assetId) throw new NonRetryableError("asset_id missing from payload");
            const { s3_key, s3_bucket } = await api.getPresignedUrl(assetId);
            if (!s3_key || !s3_bucket) throw new NonRetryableError("Asset S3 location unavailable");
            await report("extracting_text", 10);
            return { key: s3_key, bucket: s3_bucket };
          });

          const textractJobId = await step.do("start textract job", TEXTRACT_RETRIES, async () => {
            try {
              return await startTextDetection(this.env, location.bucket, location.key);
            } catch (error) {
              return rethrowTextract(error);
            }
          });

          // Poll with step.sleep — idle time costs no CPU, so long documents
          // (Textract can take minutes) never hit Worker wall-time limits.
          stage = "waiting_ocr";
          let textractStatus = "IN_PROGRESS";
          for (let attempt = 0; attempt < 120 && textractStatus === "IN_PROGRESS"; attempt++) {
            // Polling is sequential by nature: each check waits on the previous one.
            // eslint-disable-next-line no-await-in-loop
            await step.sleep(`textract wait ${attempt}`, attempt < 12 ? "5 seconds" : "15 seconds");
            // eslint-disable-next-line no-await-in-loop
            textractStatus = await step.do(`textract status ${attempt}`, TEXTRACT_RETRIES, async () => {
              let status: string;
              try {
                ({ status } = await getTextDetectionStatus(this.env, textractJobId));
              } catch (error) {
                return rethrowTextract(error);
              }
              // Textract gives no page progress while it runs: post a slow
              // climb (15 → ~32) with the time waited, every few polls.
              if (attempt % 3 === 0 && status === "IN_PROGRESS") {
                const waited = attempt < 12 ? (attempt + 1) * 5 : 60 + (attempt - 11) * 15;
                await bestEffort(
                  report("waiting_ocr", 15 + Math.round(17 * (1 - Math.exp(-attempt / 25))), {
                    detail_data: { waited_seconds: waited },
                  })
                );
              }
              return status;
            });
          }
          if (textractStatus !== "SUCCEEDED" && textractStatus !== "PARTIAL_SUCCESS") {
            throw new NonRetryableError(`Textract job ended with status ${textractStatus}`);
          }

          stage = "collecting_text";
          info = await step.do("collect textract text", TEXTRACT_RETRIES, async () => {
            let collected: Awaited<ReturnType<typeof collectTextDetectionText>>;
            try {
              await bestEffort(report("collecting_text", 33));
              collected = await collectTextDetectionText(this.env, textractJobId);
            } catch (error) {
              return rethrowTextract(error);
            }
            const text = collected.text.trim();
            if (!text) throw new NonRetryableError("Textract returned no text for this document");
            await api.saveContractText(contractId, text);
            const detail: Record<string, number | boolean> = {
              pages_done: collected.pages - collected.failedPages.length,
              pages_total: collected.pages,
            };
            if (textractStatus === "PARTIAL_SUCCESS") detail.partial = true;
            await bestEffort(report("collecting_text", 38, { detail_data: detail }));
            return describe(text);
          });
        } else {
          // ── Fallback: external extraction API (POST {url} -> {extracted_text}) ──
          info = await step.do(
            "extract text",
            { retries: { limit: 3, delay: "30 seconds", backoff: "exponential" }, timeout: "10 minutes" },
            async () => {
              await bestEffort(report("extracting_text", 20));
              const assetId = event.payload.asset_id;
              if (!assetId) throw new NonRetryableError("asset_id missing from payload");
              const { url } = await api.getPresignedUrl(assetId);
              if (!this.env.TEXT_EXTRACTOR_API_URL) {
                throw new NonRetryableError("TEXT_EXTRACTOR_API_URL is not configured");
              }
              const response = await fetch(this.env.TEXT_EXTRACTOR_API_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ url }),
              });
              if (!response.ok) {
                throw new Error(`Text extractor -> ${response.status}: ${(await response.text()).slice(0, 300)}`);
              }
              const data = await response.json<{ extracted_text?: string }>();
              const text = data.extracted_text?.trim();
              if (!text) throw new NonRetryableError("The extractor returned no text for this document");
              await api.saveContractText(contractId, text);
              return describe(text);
            }
          );
        }
        textExtracted = true;
      }

      if (!info.length) {
        throw new NonRetryableError("The contract has no extracted text to analyze");
      }
      const textInfo = info;

      // ── Embeddings: generate and save in separate steps per batch ────
      // New text always rebuilds the chunks, even when not asked, so search
      // never serves fragments of the old text.
      if ((wants("generate_embeddings") || textExtracted) && !isReanalysis) {
        stage = "embedding";
        const plan = await step.do("plan embeddings", API_RETRIES, async () => {
          await bestEffort(report("embedding", 45));
          const total = chunkText(await loadText(textInfo)).length;
          const { exists, count } = await api.chunksExist(contractId);
          // Fresh text always gets fresh chunks; otherwise a complete set is
          // kept unless the user asked to rebuild it.
          const keep = !textExtracted && mode !== "RETRY_PARTIAL" && exists && count === total;
          return { total, skip: keep || total === 0 };
        });

        if (!plan.skip) {
          const batches = Math.ceil(plan.total / EMBED_BATCH);
          for (let batch = 0; batch < batches; batch++) {
            // Batches run in order: the first replaces the old set, the rest append.
            // eslint-disable-next-line no-await-in-loop
            const embedded = await step.do(`embed batch ${batch}`, AI_RETRIES, async () => {
              await bestEffort(
                report("embedding", 45 + Math.round((13 * batch) / batches), {
                  detail_data: { chunks_done: batch * EMBED_BATCH, chunks_total: plan.total },
                })
              );
              const chunks = chunkText(await loadText(textInfo)).slice(batch * EMBED_BATCH, (batch + 1) * EMBED_BATCH);
              const vectors = await generateEmbeddings(
                this.env,
                chunks.map((chunk) => chunk.text)
              );
              return chunks.map((chunk, i) => ({
                index: chunk.index,
                content: chunk.text,
                tokens: chunk.tokens,
                vector: packVector(vectors[i]),
              }));
            });
            // eslint-disable-next-line no-await-in-loop
            await step.do(`save embeddings ${batch}`, API_RETRIES, async () => {
              await api.saveChunks(
                contractId,
                embedded.map((item) => ({
                  index: item.index,
                  content: item.content,
                  token_count: item.tokens,
                  embedding: unpackVector(item.vector),
                })),
                batch === 0 ? "replace" : "append"
              );
              return { saved: embedded.length };
            });
          }
        }
      }

      // ── AI analysis: primary first, then secondary + artists on the cache ──
      if (wants("ai_analysis") || isReanalysis) {
        stage = "analyzing";
        const fileName = await fileNameStep("resolve file name");
        await step.do("report analysis start", API_RETRIES, async () => {
          await report("analyzing", 60);
        });

        // Artist tags help the model reuse existing spellings; only the ones
        // that appear in the text are sent (filtered inside the artists step).
        const existingTags = await step.do("load existing tags", API_RETRIES, async () => {
          const { tags, detailed } = await api.getWorkspaceTags(event.payload.workspace_id);
          if (detailed) {
            return detailed.filter((tag) => tag.kind === "ARTIST" || tag.kind === "CUSTOM").map((tag) => tag.name);
          }
          return tags;
        });

        const ranges = partRanges(textInfo.length);
        const analyze = (kind: PromptKind, index: number) =>
          step.do(
            ranges.length > 1 ? `analyze ${kind} ${index + 1}/${ranges.length}` : `analyze ${kind}`,
            AI_RETRIES,
            async () => {
              if (kind === "primary") {
                await bestEffort(
                  report("analyzing", 60 + Math.round((20 * index) / ranges.length), {
                    detail_data: { parts_done: index, parts_total: ranges.length },
                  })
                );
              }
              const full = await loadText(textInfo);
              const [start, end] = ranges[index];
              const prefix = contractPrefix(fileName, full.slice(start, end), {
                index: index + 1,
                total: ranges.length,
              });
              type Data = Record<string, unknown>;
              const spec = {
                primary: {
                  prompt: () => primaryPrompt(prefix, PRIMARY_EVIDENCE_KEYS),
                  schema: PRIMARY_SCHEMA,
                  finish: (data: Data) => withEvidence(data, full, PRIMARY_EVIDENCE_KEYS),
                },
                secondary: {
                  prompt: () => secondaryPrompt(prefix, SECONDARY_EVIDENCE_KEYS),
                  schema: SECONDARY_SCHEMA,
                  finish: (data: Data) => withEvidence(data, full, SECONDARY_EVIDENCE_KEYS),
                },
                artists: {
                  prompt: () => artistsPrompt(prefix, relevantTags(existingTags, full), ARTISTS_EVIDENCE_KEYS),
                  schema: ARTISTS_SCHEMA,
                  finish: (data: Data) => withEvidence(data, full, ARTISTS_EVIDENCE_KEYS),
                },
                // Each work carries its own quote, checked against the text
                works: {
                  prompt: () => worksPrompt(prefix),
                  schema: WORKS_SCHEMA,
                  finish: (data: Data) => ({ obras: normalizeWorks(data.obras, full) }),
                },
              }[kind];
              const prompt = spec.prompt();
              let result: ValidatedRun<AnalysisJsonResult>;
              try {
                result = await runValidated(
                  // The retry keeps the same prompt (cache hit) with more room to answer.
                  (attempt) =>
                    generateAnalysisJson(this.env, {
                      system: ANALYSIS_SYSTEM,
                      prompt,
                      maxTokens: attempt === 1 ? MAX_TOKENS[kind] : MAX_TOKENS[kind] * 2,
                    }),
                  spec.schema,
                  repairTruncatedJson
                );
              } catch (error) {
                return rethrowProvider(error);
              }
              if (result.repaired) {
                console.warn(JSON.stringify({ message: "model output repaired", job: jobId, prompt: kind }));
              }
              return {
                data: JSON.stringify(spec.finish(result.data)),
                model: result.outputs[result.outputs.length - 1].model,
                usage: usageOf(kind, result.outputs, {
                  part: ranges.length > 1 ? index + 1 : undefined,
                  attempts: result.attempts,
                  repaired: result.repaired,
                }),
              };
            }
          );

        const answers: Record<PromptKind, Record<string, unknown>[]> = {
          primary: [],
          secondary: [],
          artists: [],
          works: [],
        };
        let primaryModel = "";
        for (let index = 0; index < ranges.length; index++) {
          // Primary first writes the prefix to DeepSeek's cache; the others
          // then read it. Parts run one after another for the same reason.
          // eslint-disable-next-line no-await-in-loop
          const primary = await analyze("primary", index);
          // eslint-disable-next-line no-await-in-loop
          const [secondary, artists, worksAnswer] = await Promise.all([
            analyze("secondary", index),
            analyze("artists", index),
            analyze("works", index),
          ]);
          primaryModel ||= primary.model;
          for (const [kind, result] of [
            ["primary", primary],
            ["secondary", secondary],
            ["artists", artists],
            ["works", worksAnswer],
          ] as const) {
            answers[kind].push(JSON.parse(result.data) as Record<string, unknown>);
            calls.push(result.usage);
          }
        }

        stage = "saving";
        await step.do("save extracted data", API_RETRIES, async () => {
          await report("saving", 85);
          const merged = finalizeExtracted([
            mergePartResults(answers.primary),
            mergePartResults(answers.secondary),
            mergePartResults(answers.artists),
          ]);
          await api.saveExtractedData(contractId, merged, isReanalysis ? "proposed" : "apply", primaryModel);
        });

        // Suggestions are saved directly, also on REANALYZE (they are not part
        // of the proposal). A failure here doesn't fail the analysis.
        const works = mergeWorks(answers.works.map((answer) => (answer.obras ?? []) as ExtractedWork[]));
        if (works.length > 0) {
          try {
            await suggestWorks("suggest works", works);
          } catch (error) {
            console.warn(
              JSON.stringify({ message: "works suggestions failed", job: jobId, error: String(error).slice(0, 200) })
            );
          }
        }
      }

      // ── Works only (retry) ────────────────────────────────────────────
      // Reads the opening plus the annex/list windows of each part; a full
      // analysis already extracts works.
      const worksOnly = mode === "RETRY_PARTIAL" && Boolean(retryOptions?.works) && !retryOptions?.ai_analysis;
      if (worksOnly) {
        stage = "analyzing";
        const fileName = await fileNameStep("resolve file name for works");
        const ranges = partRanges(textInfo.length);
        const found: ExtractedWork[][] = [];
        for (let index = 0; index < ranges.length; index++) {
          // Parts run in order, like the full analysis.
          // eslint-disable-next-line no-await-in-loop
          const part = await step.do(
            ranges.length > 1 ? `extract works ${index + 1}/${ranges.length}` : "extract works",
            AI_RETRIES,
            async () => {
              await bestEffort(
                report("analyzing", 60 + Math.round((25 * index) / ranges.length), {
                  detail_data: { parts_done: index, parts_total: ranges.length },
                })
              );
              const full = await loadText(textInfo);
              const [start, end] = ranges[index];
              const focus = worksFocus(full.slice(start, end), WORKS_FOCUS_CHARS);
              const prompt = worksPrompt(
                contractPrefix(fileName, focus.text, { index: index + 1, total: ranges.length }),
                { excerpted: focus.excerpted }
              );
              try {
                const result = await runValidated(
                  (attempt) =>
                    generateAnalysisJson(this.env, {
                      system: ANALYSIS_SYSTEM,
                      prompt,
                      maxTokens: attempt === 1 ? MAX_TOKENS.works : MAX_TOKENS.works * 2,
                    }),
                  WORKS_SCHEMA,
                  repairTruncatedJson
                );
                return {
                  works: normalizeWorks(result.data.obras, full),
                  usage: usageOf("works", result.outputs, {
                    part: ranges.length > 1 ? index + 1 : undefined,
                    attempts: result.attempts,
                    repaired: result.repaired,
                  }),
                };
              } catch (error) {
                return rethrowProvider(error);
              }
            }
          );
          found.push(part.works);
          calls.push(part.usage);
        }

        stage = "saving";
        const works = mergeWorks(found);
        await step.do("report works found", API_RETRIES, async () => {
          await report("saving", 90, { detail_data: { works_found: works.length } });
        });
        if (works.length > 0) await suggestWorks("suggest works only", works);
      }

      // ── Classification only (backfill) ───────────────────────────────
      // `wants()` is true for every stage outside RETRY_PARTIAL, so this must
      // test the mode itself; a full analysis already classifies through the
      // secondary prompt.
      const classifyOnly = mode === "RETRY_PARTIAL" && Boolean(retryOptions?.classify) && !retryOptions?.ai_analysis;
      if (classifyOnly) {
        stage = "classifying";
        const fileName = await fileNameStep("resolve file name for classification");

        const classification = await step.do("classify editorial", AI_RETRIES, async () => {
          await bestEffort(report("classifying", 60));
          const prompt = classificationPrompt(fileName, await loadText(textInfo));
          try {
            const result = await runValidated(
              (attempt) =>
                generateAnalysisJson(this.env, {
                  system: ANALYSIS_SYSTEM,
                  prompt,
                  maxTokens: attempt === 1 ? 256 : 512,
                }),
              CLASSIFY_SCHEMA,
              repairTruncatedJson
            );
            return {
              esEditorial: toBool(result.data.esEditorial),
              usage: usageOf("classify", result.outputs, { attempts: result.attempts, repaired: result.repaired }),
            };
          } catch (error) {
            return rethrowProvider(error);
          }
        });
        calls.push(classification.usage);

        stage = "saving";
        await step.do("save classification", API_RETRIES, async () => {
          // Only `esEditorial` travels, and the ingest writes only the keys it
          // receives — nothing else on the contract moves. The empty model
          // keeps `ai_model_used` naming the model of the full analysis.
          await api.saveExtractedData(contractId, { esEditorial: classification.esEditorial }, "apply", "");
        });
      }

      // ── Thumbnail ─────────────────────────────────────────────────────
      if (wants("extract_thumbnail") && !isReanalysis) {
        await step.do("thumbnail placeholder", async () => {
          // Browser Rendering spike pending. Non-fatal: the pipeline completes
          // without a thumbnail and this step can be retried selectively.
          return { skipped: true };
        });
      }

      stage = "done";
      await step.do("finalize", API_RETRIES, async () => {
        await report("done", 100, { status: "COMPLETED", usage: summarizeUsage(calls) });
      });

      return { status: "completed", contract_id: contractId };
    } catch (error) {
      // Report the failure with the stage that broke, and what was spent
      const message = error instanceof Error ? error.message : String(error);
      const failedStage = stage;
      await step.do("report failure", API_RETRIES, async () => {
        await api.reportProgress(jobId, {
          status: "FAILED",
          current_stage: "failed",
          stage: "failed",
          error: { message: message.slice(0, 500), stage: failedStage },
          ...(calls.length > 0 ? { usage: summarizeUsage(calls) } : {}),
        });
      });
      throw error;
    }
  }
}
