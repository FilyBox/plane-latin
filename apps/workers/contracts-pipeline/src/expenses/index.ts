import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { generateStructuredJson } from "../lib/ai";
import { startTextDetection, getTextDetectionStatus, collectTextDetectionText } from "../lib/textract";
import { parseJsonResponse } from "../lib/json-repair";
import { RECEIPT_KEYS, receiptData, receiptPrompt } from "./extraction";

type Params = { job_id: string; workspace_id: string; attempt: string };
type Asset = { url: string; type: string; name: string; s3_key: string; s3_bucket: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function boundedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.ok) throw new Error(`Upstream failed: ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty response");
  const decoder = new TextDecoder();
  let size = 0, text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new NonRetryableError("Document exceeds the extraction limit");
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally { await reader.cancel(); }
}

export class ExpensePipelineWorkflow extends WorkflowEntrypoint<ExpenseEnv, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const { workspace_id, job_id, attempt } = event.payload;
    const endpoint = `${this.env.PLANE_INTERNAL_API_URL.replace(/\/$/, "")}/api/internal/expense-imports/${workspace_id}/${job_id}/${attempt}/`;
    const headers = { "X-Plane-Internal-Key": this.env.PLANE_INTERNAL_API_SECRET, "Content-Type": "application/json" };
    const report = async (body: Record<string, unknown>) => {
      const response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`Progress failed: ${response.status}`);
      await response.body?.cancel();
    };
    try {
      const asset = await step.do("resolve receipt", async () => {
        await report({ status: "RUNNING", stage: "Extrayendo documento" });
        return JSON.parse(await boundedText(await fetch(endpoint, { headers, signal: AbortSignal.timeout(30000) }), 10000)) as Asset;
      });
      let text: string;
      if (asset.type.includes("xml")) {
        text = await step.do("read xml", async () => boundedText(await fetch(asset.url, { signal: AbortSignal.timeout(60000) }), 1024 * 1024));
        // XML is treated as text: no entity expansion, network resolution or execution.
      } else if ((this.env.TEXT_EXTRACTION_MODE || "textract") === "textract") {
        const id = await step.do("start receipt ocr", { retries: { limit: 5, delay: "10 seconds", backoff: "exponential" } }, () => startTextDetection(this.env, asset.s3_bucket, asset.s3_key));
        let status = "IN_PROGRESS";
        for (let i = 0; i < 100 && status === "IN_PROGRESS"; i++) {
          await step.sleep(`ocr wait ${i}`, "10 seconds");
          status = await step.do(`ocr status ${i}`, async () => (await getTextDetectionStatus(this.env, id)).status);
        }
        if (status !== "SUCCEEDED") throw new NonRetryableError("Receipt OCR did not complete");
        text = await step.do("collect receipt text", () => collectTextDetectionText(this.env, id));
      } else {
        text = await step.do("extract receipt", { timeout: "5 minutes", retries: { limit: 2, delay: "10 seconds" } }, async () => {
          if (!this.env.TEXT_EXTRACTOR_API_URL) throw new NonRetryableError("TEXT_EXTRACTOR_API_URL is missing");
          const response = await fetch(this.env.TEXT_EXTRACTOR_API_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: asset.url }), signal: AbortSignal.timeout(240000) });
          const data = JSON.parse(await boundedText(response, 1024 * 1024)) as { extracted_text?: string };
          return data.extracted_text || "";
        });
      }
      if (!text.trim()) throw new NonRetryableError("No text found in receipt");
      const data = await step.do("analyze receipt", { timeout: "5 minutes", retries: { limit: 2, delay: "10 seconds" } }, async () => {
        await report({ status: "RUNNING", stage: "Identificando datos del gasto" });
        const result = await generateStructuredJson(this.env, { prompt: receiptPrompt(text), keys: RECEIPT_KEYS });
        return receiptData(parseJsonResponse(result.text));
      });
      await step.do("save draft", () => report({ status: "READY", stage: "Listo para revisar", data }));
    } catch (error) {
      await step.do("report failure", () => report({ status: "FAILED", stage: "No se pudo analizar" }));
      throw error;
    }
  }
}

export default {
  async fetch(request: Request, env: ExpenseEnv): Promise<Response> {
    if (new URL(request.url).pathname === "/health") return Response.json({ status: "ok" });
    const encoder = new TextEncoder();
    const hashes = await Promise.all([request.headers.get("X-Trigger-Secret") || "", env.CF_WORKER_TRIGGER_SECRET || ""].map(value => crypto.subtle.digest("SHA-256", encoder.encode(value))));
    if (!env.CF_WORKER_TRIGGER_SECRET || !crypto.subtle.timingSafeEqual(hashes[0], hashes[1])) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (request.method !== "POST" || new URL(request.url).pathname !== "/trigger/extract") return Response.json({ error: "Not found" }, { status: 404 });
    let params: Params;
    try {
      params = JSON.parse(await boundedText(new Response(request.body), 4096)) as Params;
      if (![params.job_id, params.workspace_id, params.attempt].every(value => typeof value === "string" && UUID.test(value))) throw new Error("Invalid ids");
    } catch { return Response.json({ error: "Invalid job" }, { status: 400 }); }
    const id = `expense-${params.attempt}`;
    try {
      await env.EXPENSE_PIPELINE.create({ id, params });
    } catch {
      // A retry after a lost response refers to the same durable instance.
      try { await (await env.EXPENSE_PIPELINE.get(id)).status(); }
      catch { return Response.json({ error: "Unable to start analysis" }, { status: 503 }); }
    }
    return Response.json({ workflow_instance_id: id });
  },
} satisfies ExportedHandler<ExpenseEnv>;
