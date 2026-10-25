type AIEnvironment = Pick<
  Env,
  | "AI_PROVIDER"
  | "CHAT_DEFAULT_MODEL"
  | "DEEPSEEK_API_KEY"
  | "DEEPSEEK_MODEL"
  | "DEEPSEEK_MODEL_LIST"
  | "EMBEDDING_DIMENSIONS"
  | "GEMINI_MODEL_FALLBACK_LIST"
  | "GOOGLE_GENERATIVE_AI_API_KEY"
  | "OPENAI_API_KEY"
  | "OPENAI_EMBEDDING_MODEL"
>;

/**
 * AI provider layer — raw fetch against the providers' REST endpoints (no
 * Node SDKs; the Workers runtime is a V8 isolate). Base provider and models
 * come from env vars, never hardcoded:
 *   AI_PROVIDER=gemini|deepseek        primary provider
 *   GEMINI_MODEL_FALLBACK_LIST=a,b,c   ordered fallback chain
 *   DEEPSEEK_MODEL=deepseek-flash
 *   OPENAI_EMBEDDING_MODEL / EMBEDDING_DIMENSIONS
 * With gemini as primary, every model in the chain is tried on retryable
 * errors (429/503/overloaded) and DeepSeek runs as the last resort.
 */

export type StructuredJsonRequest = {
  prompt: string;
  /** Top-level keys the caller expects — steers DeepSeek's JSON mode */
  keys: readonly string[];
  maxTokens?: number;
};

export type StructuredJsonResult = { text: string; model: string };

const isRetryableGeminiError = (status: number, body: string): boolean =>
  status === 429 || status === 503 || /UNAVAILABLE|overloaded|RESOURCE_EXHAUSTED/i.test(body);

async function callGemini(env: AIEnvironment, model: string, req: StructuredJsonRequest): Promise<string> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GOOGLE_GENERATIVE_AI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: req.prompt }] }],
        generationConfig: {
          maxOutputTokens: req.maxTokens ?? 4096,
          responseMimeType: "application/json",
        },
      }),
    }
  );
  const bodyText = await response.text();
  if (!response.ok) {
    const error = new Error(`Gemini ${model} -> ${response.status}: ${bodyText.slice(0, 300)}`);
    (error as Error & { retryable?: boolean }).retryable = isRetryableGeminiError(response.status, bodyText);
    throw error;
  }
  const data = JSON.parse(bodyText) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  if (!text) throw new Error(`Gemini ${model} returned an empty response`);
  return text;
}

async function callDeepseek(env: AIEnvironment, req: StructuredJsonRequest): Promise<string> {
  // DeepSeek JSON mode: response_format json_object, single object only, and
  // the word "json" must appear in the prompt (https://api-docs.deepseek.com/guides/json_mode)
  const keysHint =
    req.keys.length > 0
      ? ` Responde con un único objeto json (no un array) con exactamente estas claves: ${req.keys.join(", ")}.`
      : " Responde con un único objeto json (no un array).";
  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: env.DEEPSEEK_MODEL || "deepseek-flash",
      messages: [
        { role: "system", content: keysHint.trim() },
        { role: "user", content: req.prompt },
      ],
      response_format: { type: "json_object" },
      max_tokens: req.maxTokens ?? 4096,
    }),
  });
  if (!response.ok) {
    throw new Error(`DeepSeek -> ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  const data = await response.json<{ choices?: Array<{ message?: { content?: string } }> }>();
  const text = data.choices?.[0]?.message?.content ?? "";
  if (!text) throw new Error("DeepSeek returned an empty response");
  return text;
}

/** Walks the Gemini fallback chain; throws (with the last error) if all fail. */
async function geminiChainStructuredJson(
  env: AIEnvironment,
  req: StructuredJsonRequest
): Promise<StructuredJsonResult> {
  const models = (env.GEMINI_MODEL_FALLBACK_LIST || "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  if (models.length === 0) throw new Error("GEMINI_MODEL_FALLBACK_LIST is not configured");

  let lastError: unknown;
  for (const model of models) {
    try {
      // eslint-disable-next-line no-await-in-loop -- fallback chain: try one model at a time
      return { text: await callGemini(env, model, req), model };
    } catch (error) {
      lastError = error;
      if (!(error as Error & { retryable?: boolean }).retryable) throw error;
      console.log(JSON.stringify({ message: "gemini model unavailable, trying next", model }));
    }
  }
  throw lastError ?? new Error("All Gemini models failed");
}

/**
 * Runs the configured provider (AI_PROVIDER, default "deepseek") and returns
 * the raw JSON text + model used. Each provider falls back to the other as a
 * last resort, so a provider outage doesn't fail the pipeline.
 */
export async function generateStructuredJson(
  env: AIEnvironment,
  req: StructuredJsonRequest
): Promise<StructuredJsonResult> {
  const provider = (env.AI_PROVIDER || "deepseek").toLowerCase();

  if (provider === "deepseek") {
    try {
      return { text: await callDeepseek(env, req), model: env.DEEPSEEK_MODEL || "deepseek-flash" };
    } catch (deepseekError) {
      console.log(JSON.stringify({ message: "deepseek unavailable, falling back to gemini chain" }));
      try {
        return await geminiChainStructuredJson(env, req);
      } catch {
        throw deepseekError;
      }
    }
  }

  // gemini primary: walk the fallback chain, then DeepSeek as last resort
  try {
    return await geminiChainStructuredJson(env, req);
  } catch (geminiError) {
    try {
      console.log(JSON.stringify({ message: "all gemini models unavailable, falling back to deepseek" }));
      return { text: await callDeepseek(env, req), model: `deepseek:${env.DEEPSEEK_MODEL || "deepseek-flash"}` };
    } catch (deepseekError) {
      console.error(JSON.stringify({ message: "deepseek fallback failed", error: String(deepseekError) }));
      throw geminiError;
    }
  }
}

// ---------------------------------------------------------- analysis calls

/** Long contracts take a while to prefill; past this the call is abandoned. */
const ANALYSIS_TIMEOUT_MS = 240_000;

export type AnalysisJsonRequest = {
  /** Same for every prompt over one text, so it stays inside the cached prefix */
  system: string;
  prompt: string;
  maxTokens: number;
};

export type AnalysisJsonResult = {
  text: string;
  model: string;
  provider: "deepseek" | "gemini";
  /** The answer hit the token limit */
  truncated: boolean;
  usage: { input: number; cached: number; output: number };
};

/** Error with a hint for the step: worth retrying (429, 5xx, timeout) or not. */
export class ProviderError extends Error {
  readonly retryable: boolean;
  readonly status: number;
  constructor(message: string, status: number, retryable: boolean) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
    this.retryable = retryable;
  }
}

const providerFetch = async (label: string, url: string, init: RequestInit): Promise<Response> => {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(ANALYSIS_TIMEOUT_MS) });
  } catch (error) {
    throw new ProviderError(`${label} request failed: ${String(error).slice(0, 200)}`, 0, true);
  }
};

async function deepseekAnalysis(env: AIEnvironment, req: AnalysisJsonRequest): Promise<AnalysisJsonResult> {
  const model = env.DEEPSEEK_MODEL || "deepseek-flash";
  const response = await providerFetch("DeepSeek", "https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.prompt },
      ],
      response_format: { type: "json_object" },
      max_tokens: req.maxTokens,
      thinking: { type: "disabled" },
    }),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    const retryable = response.status === 429 || response.status >= 500;
    throw new ProviderError(`DeepSeek -> ${response.status}: ${detail}`, response.status, retryable);
  }
  const data = await response.json<{
    model?: string;
    choices?: { message?: { content?: string }; finish_reason?: string }[];
    usage?: { prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number; completion_tokens?: number };
  }>();
  const choice = data.choices?.[0];
  const cached = data.usage?.prompt_cache_hit_tokens ?? 0;
  return {
    text: choice?.message?.content ?? "",
    model: data.model || model,
    provider: "deepseek",
    truncated: choice?.finish_reason === "length",
    usage: {
      input: cached + (data.usage?.prompt_cache_miss_tokens ?? 0),
      cached,
      output: data.usage?.completion_tokens ?? 0,
    },
  };
}

async function geminiAnalysis(
  env: AIEnvironment,
  model: string,
  req: AnalysisJsonRequest
): Promise<AnalysisJsonResult> {
  const response = await providerFetch(
    `Gemini ${model}`,
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GOOGLE_GENERATIVE_AI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: req.system }] },
        contents: [{ role: "user", parts: [{ text: req.prompt }] }],
        generationConfig: { maxOutputTokens: req.maxTokens, responseMimeType: "application/json" },
      }),
    }
  );
  const bodyText = await response.text();
  if (!response.ok) {
    throw new ProviderError(
      `Gemini ${model} -> ${response.status}: ${bodyText.slice(0, 300)}`,
      response.status,
      isRetryableGeminiError(response.status, bodyText) || response.status >= 500
    );
  }
  const data = JSON.parse(bodyText) as {
    candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
    usageMetadata?: {
      promptTokenCount?: number;
      cachedContentTokenCount?: number;
      candidatesTokenCount?: number;
      thoughtsTokenCount?: number;
    };
  };
  const candidate = data.candidates?.[0];
  const meta = data.usageMetadata;
  return {
    text: candidate?.content?.parts?.map((part) => part.text ?? "").join("") ?? "",
    model,
    provider: "gemini",
    truncated: candidate?.finishReason === "MAX_TOKENS",
    usage: {
      input: meta?.promptTokenCount ?? 0,
      cached: meta?.cachedContentTokenCount ?? 0,
      output: (meta?.candidatesTokenCount ?? 0) + (meta?.thoughtsTokenCount ?? 0),
    },
  };
}

/**
 * One analysis call on the configured provider with its token usage. The
 * other provider is the fallback when the first fails; the error kept is the
 * primary one, so the step can decide whether a retry makes sense.
 */
export async function generateAnalysisJson(env: AIEnvironment, req: AnalysisJsonRequest): Promise<AnalysisJsonResult> {
  const provider = (env.AI_PROVIDER || "deepseek").toLowerCase();
  const gemini = async () => {
    let lastError: unknown = new ProviderError("GEMINI_MODEL_FALLBACK_LIST is not configured", 0, false);
    for (const model of geminiModels(env)) {
      try {
        // eslint-disable-next-line no-await-in-loop -- fallback chain: one model at a time
        return await geminiAnalysis(env, model, req);
      } catch (error) {
        lastError = error;
        if (!(error instanceof ProviderError && error.retryable)) break;
      }
    }
    throw lastError;
  };

  if (provider === "deepseek") {
    try {
      return await deepseekAnalysis(env, req);
    } catch (deepseekError) {
      console.log(
        JSON.stringify({ message: "deepseek failed, trying gemini", error: String(deepseekError).slice(0, 200) })
      );
      try {
        return await gemini();
      } catch {
        throw deepseekError;
      }
    }
  }
  try {
    return await gemini();
  } catch (geminiError) {
    try {
      return await deepseekAnalysis(env, req);
    } catch {
      throw geminiError;
    }
  }
}

export type ChatMessage = { role: "user" | "assistant"; content: string };

async function callGeminiChat(
  env: AIEnvironment,
  model: string,
  system: string,
  history: ChatMessage[],
  query: string
): Promise<string> {
  const contents = [
    ...history.map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.content }],
    })),
    { role: "user", parts: [{ text: query }] },
  ];
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GOOGLE_GENERATIVE_AI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents,
        generationConfig: { maxOutputTokens: 2048 },
      }),
    }
  );
  const bodyText = await response.text();
  if (!response.ok) {
    const error = new Error(`Gemini ${model} -> ${response.status}: ${bodyText.slice(0, 300)}`);
    (error as Error & { retryable?: boolean }).retryable = isRetryableGeminiError(response.status, bodyText);
    throw error;
  }
  const data = JSON.parse(bodyText) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  if (!text) throw new Error(`Gemini ${model} returned an empty response`);
  return text;
}

async function callDeepseekChat(
  env: AIEnvironment,
  model: string,
  system: string,
  history: ChatMessage[],
  query: string
): Promise<string> {
  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: system }, ...history, { role: "user", content: query }],
      max_tokens: 2048,
    }),
  });
  if (!response.ok) {
    throw new Error(`DeepSeek ${model} -> ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  const data = await response.json<{ choices?: Array<{ message?: { content?: string } }> }>();
  const text = data.choices?.[0]?.message?.content ?? "";
  if (!text) throw new Error(`DeepSeek ${model} returned an empty response`);
  return text;
}

export type ChatModelOption = { id: string; provider: "gemini" | "deepseek" };

const geminiModels = (env: AIEnvironment): string[] =>
  (env.GEMINI_MODEL_FALLBACK_LIST || "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);

const deepseekModels = (env: AIEnvironment): string[] => {
  const list = (env.DEEPSEEK_MODEL_LIST || env.DEEPSEEK_MODEL || "deepseek-flash")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  return list;
};

/** Selectable chat models, entirely env-driven (never hardcoded in the UI). */
export function listChatModels(env: AIEnvironment): { models: ChatModelOption[]; default_model: string } {
  const models: ChatModelOption[] = [
    ...deepseekModels(env).map((id) => ({ id, provider: "deepseek" as const })),
    ...geminiModels(env).map((id) => ({ id, provider: "gemini" as const })),
  ];
  const fallback = models[0]?.id ?? "deepseek-flash";
  const configuredDefault = env.CHAT_DEFAULT_MODEL?.trim();
  const default_model =
    configuredDefault && models.some((model) => model.id === configuredDefault) ? configuredDefault : fallback;
  return { models, default_model };
}

/**
 * Free-text chat turn. `preferredModel` (from the UI picker) runs first when
 * it is one of the env-declared models; on retryable failure the normal
 * provider chain takes over.
 */
export async function generateText(
  env: AIEnvironment,
  system: string,
  history: ChatMessage[],
  query: string,
  preferredModel?: string
): Promise<{ text: string; model: string }> {
  const provider = (env.AI_PROVIDER || "deepseek").toLowerCase();

  if (preferredModel) {
    const isDeepseek = deepseekModels(env).includes(preferredModel);
    const isGemini = geminiModels(env).includes(preferredModel);
    if (isDeepseek) {
      return { text: await callDeepseekChat(env, preferredModel, system, history, query), model: preferredModel };
    }
    if (isGemini) {
      try {
        return { text: await callGeminiChat(env, preferredModel, system, history, query), model: preferredModel };
      } catch (error) {
        if (!(error as Error & { retryable?: boolean }).retryable) throw error;
        console.log(JSON.stringify({ message: "preferred gemini model unavailable, falling back", preferredModel }));
      }
    }
    // Unknown model ids fall through to the configured chain
  }

  if (provider === "deepseek") {
    const model = deepseekModels(env)[0];
    try {
      return { text: await callDeepseekChat(env, model, system, history, query), model };
    } catch (deepseekError) {
      // Fall back to the Gemini chain so a DeepSeek outage doesn't kill chat
      const geminiFallback = geminiModels(env);
      for (const geminiModel of geminiFallback) {
        try {
          // eslint-disable-next-line no-await-in-loop -- fallback chain: try one model at a time
          return { text: await callGeminiChat(env, geminiModel, system, history, query), model: geminiModel };
        } catch (error) {
          if (!(error as Error & { retryable?: boolean }).retryable) throw error;
        }
      }
      throw deepseekError;
    }
  }

  const models = geminiModels(env);
  if (models.length === 0) throw new Error("GEMINI_MODEL_FALLBACK_LIST is not configured");

  let lastError: unknown;
  for (const model of models) {
    try {
      // eslint-disable-next-line no-await-in-loop -- fallback chain: try one model at a time
      return { text: await callGeminiChat(env, model, system, history, query), model };
    } catch (error) {
      lastError = error;
      if (!(error as Error & { retryable?: boolean }).retryable) throw error;
      console.log(JSON.stringify({ message: "gemini chat model unavailable, trying next", model }));
    }
  }
  try {
    const model = deepseekModels(env)[0];
    return { text: await callDeepseekChat(env, model, system, history, query), model: `deepseek:${model}` };
  } catch (deepseekError) {
    throw lastError ?? deepseekError;
  }
}

/** OpenAI embeddings (text-embedding-3-small @ 1536 dims by default). */
export async function generateEmbeddings(env: AIEnvironment, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small",
      input: texts,
      dimensions: parseInt(env.EMBEDDING_DIMENSIONS || "1536", 10),
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) {
    throw new Error(`OpenAI embeddings -> ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  const data = await response.json<{ data: Array<{ embedding: number[] }> }>();
  return data.data.map((item) => item.embedding);
}
