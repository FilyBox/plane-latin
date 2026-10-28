/**
 * The model that reads scans and images: the first declared Gemini model
 * (DeepSeek has no vision). Gemini 3.1 Flash-Lite takes a PDF directly, at
 * about 258 tokens a page.
 */

import { createGoogleGenerativeAI } from "@ai-sdk/google";

export function visionModel(env: Pick<Env, "GEMINI_MODEL_FALLBACK_LIST" | "GOOGLE_GENERATIVE_AI_API_KEY">) {
  const id = (env.GEMINI_MODEL_FALLBACK_LIST || "")
    .split(",")
    .map((value) => value.trim())
    .find(Boolean);
  if (!id || !env.GOOGLE_GENERATIVE_AI_API_KEY) return null;
  return { id, model: createGoogleGenerativeAI({ apiKey: env.GOOGLE_GENERATIVE_AI_API_KEY })(id) };
}
