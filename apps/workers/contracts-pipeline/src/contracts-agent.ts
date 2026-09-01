/**
 * Contracts agent: AI SDK `streamText` with tools over Django's internal API.
 *
 * The previous chat was one-shot RAG — embed the question, paste the top 12
 * chunks into the prompt, answer. That cannot express "contracts of artist X
 * not finished by August 2017 that carry person Y's INE", and it names
 * documents it never actually opened, because the only thing it ever saw was
 * a bag of fragments.
 *
 * This agent instead *looks things up*:
 *   resolve names -> filter structurally -> read only what it needs ->
 *   fan out per-document summaries in SEPARATE model calls -> cite.
 *
 * Two properties matter and both are load-bearing:
 *
 * - Context stays flat. Tool results are capped and compacted here (see
 *   `compact`), long readings happen in sub-agent calls whose transcripts
 *   never enter this conversation, and Django prunes old tool payloads out of
 *   the replayed history. A long chat no longer walks itself into the model's
 *   token limit.
 * - Documents are real. `show_documents` resolves ids against Django and
 *   returns the asset metadata the UI needs to open/download the file, so a
 *   cited document is always one the user can actually click.
 *
 * Read-only by construction: every tool is a GET/POST against a read endpoint
 * scoped to `workspace_id`, so a run cannot mutate or cross workspaces.
 */

import { createDeepSeek } from "@ai-sdk/deepseek";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel, ToolSet, UIMessage } from "ai";
import { convertToModelMessages, createUIMessageStreamResponse, generateText, stepCountIs, streamText, tool } from "ai";
import { z } from "zod";

import { generateEmbeddings, listChatModels } from "./lib/ai";
import { internalApi } from "./lib/internal-api";

export type ContractsAgentRequest = {
  workspace_id: string;
  workspace_slug: string;
  mode: "GENERAL" | "CONTRACT";
  contract_id?: string | null;
  messages: UIMessage[];
  model?: string | null;
  locale?: string | null;
};

/** Ceilings on what a single tool result may put back into the conversation. */
const LIMITS = {
  /** Rows returned by one find_contracts call */
  searchResults: 25,
  /** Semantic fragments per search_contract_text call */
  fragments: 10,
  /** Characters kept per semantic fragment */
  fragmentChars: 900,
  /** Characters kept per excerpt window */
  excerptChars: 700,
  /** Documents a single summarize_contracts fan-out may cover */
  summaryFanout: 8,
  /** Characters of source text handed to each sub-agent call */
  subAgentInputChars: 14_000,
  /** Reasoning steps before the run must answer */
  steps: 14,
} as const;

const truncate = (value: string | null | undefined, max: number): string | null => {
  if (!value) return null;
  return value.length > max ? `${value.slice(0, max)}…` : value;
};

/** Drops null/empty keys so tool JSON stays small in the model's context. */
function compact<T extends Record<string, unknown>>(row: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === null || value === undefined || value === "") continue;
    out[key] = value;
  }
  return out as Partial<T>;
}

const SYSTEM_PROMPT = `Eres un agente experto en el archivo de contratos de este workspace. Tu trabajo NO es responder de memoria: es BUSCAR el documento o los documentos que el usuario necesita, aunque haya cientos.

Responde SIEMPRE en el idioma del último mensaje del usuario (por defecto español), en Markdown: usa **negritas**, listas y tablas cuando ayuden a leer el resultado.

Herramientas y cómo encadenarlas:
- list_known_names: PRIMERO cuando el usuario nombre a un artista, grupo o persona. Devuelve cómo están escritos realmente en la base ("3BALLMTY", "3 Ball Monterrey"…). Úsalo para elegir el filtro correcto en vez de adivinar la ortografía.
- find_contracts: el caballo de batalla. Filtra por nombres, artista, persona, grupo, fechas (year/month/date_from/date_to sobre date_field), estatus, tipo, notariado, tags. Para "los contratos de X" úsala con names:["X"] — NO uses búsqueda semántica para eso.
  IMPORTANTE: los términos de "names" se combinan con AND (todos deben aparecer). Si list_known_names devuelve VARIAS grafías de la misma entidad ("3BALLMTY" y "3 Ball Monterrey"), haz UNA llamada por grafía y une los resultados; nunca las metas juntas en el mismo "names".
- search_contract_text: búsqueda SEMÁNTICA sobre el texto vectorizado. Úsala para preguntas CONCEPTUALES ("¿qué dice sobre regalías?"), no para localizar documentos por nombre o fecha. Sólo alcanza contratos ya vectorizados: si devuelve 0 fragmentos NO concluyas que el dato no existe, verifica con read_contract_excerpts.
- read_contract_excerpts: lee los alrededores de unas palabras clave dentro de contratos concretos. Es la herramienta CORRECTA para comprobar si aparece algo LITERAL — una INE, un CURP, un RFC, un nombre propio, un número de cláusula, un importe. Primero localiza los contratos con find_contracts y luego pásale sus contract_id. Nunca uses search_contract_text para esto.
  Los keywords se buscan TAL CUAL en el texto: pasa términos CORTOS y por separado (["INE", "Juan Perez"]), nunca una frase completa como "la INE de Juan Perez", que casi nunca aparece literal. Ante la duda pasa varias variantes y mira cuáles trae matched_keywords.
- get_contract_details: ficha completa (resumen, involucrados, periodos) de hasta 20 contratos ya localizados.
- summarize_contracts: cuando necesites revisar el CONTENIDO de varios documentos a la vez. Cada documento se resume en una llamada aparte, así que puedes pasarle varios sin miedo a quedarte sin contexto.
- show_documents: OBLIGATORIA al final de cualquier respuesta que mencione documentos concretos. Pásale los contract_id que realmente usaste; la UI muestra tarjetas para abrir, previsualizar y descargar cada archivo.

Reglas:
- NUNCA cites un documento que no venga de una tool. Si find_contracts no devuelve nada, dilo y sugiere otro filtro.
- Distingue el DOCUMENTO de lo que el documento MENCIONA. Si un contrato habla de una "solicitud de registro de marca", eso es una cláusula del contrato, no un archivo del workspace: no lo listes como documento salvo que exista su propio contract_id.
- Si una búsqueda devuelve muchos resultados (has_more), dilo y ofrece afinar el filtro o pagina con offset.
- Fechas siempre en ISO (YYYY-MM-DD) al llamar tools.
- Cuando el usuario pida "el listado de documentos de X", responde con la lista real de find_contracts (título + archivo + fechas) y cierra con show_documents.`;

const CONTRACT_MODE_PROMPT = (contractId: string) => `
MODO CONTRATO: la conversación está anclada al contrato ${contractId}. Responde sobre ÉL.
- Usa read_contract_excerpts y get_contract_details con contract_ids:["${contractId}"] para leerlo por partes.
- Sólo busca en otros contratos si el usuario lo pide explícitamente.`;

const LANGUAGE_PROMPT = (locale?: string | null) => `
IDIOMA: responde en el idioma del último mensaje del usuario. Su interfaz usa ${locale || "un locale desconocido"} como referencia secundaria. El idioma de los contratos es contenido y nunca cambia el idioma de tu respuesta.`;

function modelLists(env: Env) {
  const deepseek = (env.DEEPSEEK_MODEL_LIST || env.DEEPSEEK_MODEL || "deepseek-chat")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const gemini = (env.GEMINI_MODEL_FALLBACK_LIST || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return { deepseek, gemini };
}

function pickModel(env: Env, requested?: string | null): { model: LanguageModel; id: string } {
  const gemini = createGoogleGenerativeAI({ apiKey: env.GOOGLE_GENERATIVE_AI_API_KEY });
  const deepseek = createDeepSeek({ apiKey: env.DEEPSEEK_API_KEY });
  const lists = modelLists(env);

  if (requested) {
    if (lists.deepseek.includes(requested)) return { model: deepseek(requested), id: requested };
    if (lists.gemini.includes(requested)) return { model: gemini(requested), id: requested };
  }
  const provider = (env.ASSISTANT_AI_PROVIDER || "gemini").toLowerCase();
  if (provider === "deepseek" && lists.deepseek.length > 0) {
    return { model: deepseek(lists.deepseek[0]), id: lists.deepseek[0] };
  }
  if (lists.gemini.length > 0) return { model: gemini(lists.gemini[0]), id: lists.gemini[0] };
  return { model: deepseek(lists.deepseek[0]), id: lists.deepseek[0] };
}

/** Cheapest declared model, used for the per-document sub-agent calls. */
function pickWorkerModel(env: Env): LanguageModel {
  const lists = modelLists(env);
  const provider = (env.ASSISTANT_AI_PROVIDER || "gemini").toLowerCase();
  if (provider === "deepseek" && lists.deepseek.length > 0) {
    return createDeepSeek({ apiKey: env.DEEPSEEK_API_KEY })(lists.deepseek[0]);
  }
  if (lists.gemini.length > 0) {
    return createGoogleGenerativeAI({ apiKey: env.GOOGLE_GENERATIVE_AI_API_KEY })(lists.gemini[0]);
  }
  return createDeepSeek({ apiKey: env.DEEPSEEK_API_KEY })(lists.deepseek[0]);
}

export function listContractsAgentModels(env: Env): ReturnType<typeof listChatModels> {
  const { models, default_model } = listChatModels(env);
  const provider = (env.ASSISTANT_AI_PROVIDER || "gemini").toLowerCase();
  const preferred = models.find((model) => model.provider === provider);
  return { models, default_model: preferred?.id ?? default_model };
}

type ContractRow = {
  contract_id: string;
  titulo: string | null;
  file_name: string | null;
  asset_id: string | null;
  nombre_grupo?: string | null;
  artistas?: string | null;
  involucrados?: string | null;
  testigos?: string | null;
  es_notariado?: boolean | null;
  fecha_inicio?: string | null;
  fecha_fin?: string | null;
  fecha_fin_efectiva?: string | null;
  estatus_contrato?: string | null;
  tipo_contrato?: string | null;
  processing_status?: string | null;
  has_text?: boolean;
  resumen?: string | null;
};

const searchFilterSchema = {
  names: z
    .array(z.string())
    .max(6)
    .optional()
    .describe(
      "Términos libres (artista, grupo, persona, título o nombre de archivo). Se buscan en todas las columnas de texto y se combinan con AND."
    ),
  artist: z.string().optional().describe("Coincidencia dentro del campo artistas"),
  person: z.string().optional().describe("Coincidencia dentro de involucrados o testigos"),
  group: z.string().optional().describe("Coincidencia dentro de nombre_grupo"),
  title: z.string().optional().describe("Coincidencia dentro del título del contrato"),
  file_name: z.string().optional().describe("Coincidencia dentro del nombre del archivo"),
  summary_contains: z.string().optional().describe("Coincidencia dentro del resumen general"),
  date_field: z
    .enum(["inicio", "fin", "fin_efectiva", "creacion"])
    .optional()
    .describe("A qué fecha aplican year/month/date_from/date_to. Por defecto 'fin'"),
  year: z.number().int().optional(),
  month: z.number().int().min(1).max(12).optional(),
  date_from: z.string().optional().describe("YYYY-MM-DD"),
  date_to: z.string().optional().describe("YYYY-MM-DD"),
  estatus: z.array(z.enum(["VIGENTE", "FINALIZADO", "NO_ESPECIFICADO"])).optional(),
  tipo: z.array(z.enum(["ARRENDAMIENTOS", "ALQUILERES", "VEHICULOS", "SERVICIOS", "ARTISTAS"])).optional(),
  es_notariado: z.boolean().optional(),
  has_text: z.boolean().optional().describe("true = sólo contratos con texto ya extraído"),
  tags: z.array(z.string()).max(6).optional().describe("Nombres exactos de tags del workspace"),
};

function buildTools(env: Env, body: ContractsAgentRequest) {
  const api = internalApi(env);
  const workspace = body.workspace_id;
  const tools: ToolSet = {};

  const searchContracts = (payload: Record<string, unknown>) =>
    api.request<{
      total: number;
      offset: number;
      returned: number;
      has_more: boolean;
      results: ContractRow[];
    }>("POST", `/internal/workspaces/${workspace}/contracts/search/`, payload);

  tools.list_known_names = tool({
    description:
      "Nombres de artistas, grupos, personas y tags tal como están escritos en la base, más los años y estatus existentes. Llámala ANTES de filtrar por un nombre para usar la ortografía real (3ball / 3BallMTY / 3 Ball Monterrey).",
    inputSchema: z.object({
      filter: z
        .string()
        .optional()
        .describe("Fragmento para acotar la lista devuelta, p. ej. '3ball'. Sin filtro devuelve todo (recortado)."),
    }),
    execute: async ({ filter }) => {
      const facets = await api.request<{
        total_contracts: number;
        artistas: string[];
        grupos: string[];
        involucrados: string[];
        tags: string[];
        estatus: string[];
        tipos: string[];
        years: number[];
      }>("GET", `/internal/workspaces/${workspace}/contracts/facets/`);

      // Two-level matching, because this is exactly where the aliases live.
      // `fold` drops accents ("monterrey" finds "Monterréy"); `squash` also
      // drops spaces and punctuation, so "3ball" matches "3 Ball Monterrey"
      // and "3BallMTY" alike. Without the second level the agent gets back a
      // single spelling and silently searches for only one of them.
      const COMBINING_MARKS = /[̀-ͯ]/g;
      const NON_ALPHANUMERIC = /[^a-z0-9]/g;
      const fold = (value: string) => value.normalize("NFD").replace(COMBINING_MARKS, "").toLowerCase();
      const squash = (value: string) => fold(value).replace(NON_ALPHANUMERIC, "");
      const needle = filter ? fold(filter) : null;
      const squashedNeedle = filter ? squash(filter) : null;
      const pick = (values: string[]) => {
        const matched =
          needle && squashedNeedle
            ? values.filter((value) => fold(value).includes(needle) || squash(value).includes(squashedNeedle))
            : values;
        return matched.slice(0, 60);
      };
      return compact({
        total_contracts: facets.total_contracts,
        artistas: pick(facets.artistas),
        grupos: pick(facets.grupos),
        involucrados: pick(facets.involucrados),
        tags: pick(facets.tags),
        estatus: facets.estatus,
        tipos: facets.tipos,
        years: facets.years,
      });
    },
  });

  tools.find_contracts = tool({
    description:
      "Búsqueda ESTRUCTURADA de contratos por metadatos (nombres, artista, persona, fechas, estatus, tipo, notariado, tags). Devuelve filas compactas con contract_id, título, archivo y fechas. Es la forma correcta de localizar documentos; la semántica es para preguntas de contenido.",
    inputSchema: z.object({
      ...searchFilterSchema,
      limit: z.number().int().min(1).max(50).optional(),
      offset: z.number().int().min(0).optional().describe("Para paginar cuando has_more es true"),
      order: z
        .enum([
          "-created_at",
          "created_at",
          "titulo",
          "-titulo",
          "fecha_inicio",
          "-fecha_inicio",
          "fecha_fin",
          "-fecha_fin",
          "fecha_fin_efectiva",
          "-fecha_fin_efectiva",
        ])
        .optional(),
    }),
    execute: async (input) => {
      const data = await searchContracts({ ...input, limit: Math.min(input.limit ?? LIMITS.searchResults, 50) });
      return {
        total: data.total,
        returned: data.returned,
        offset: data.offset,
        has_more: data.has_more,
        results: data.results.map((row) => compact({ ...row, resumen: truncate(row.resumen, 200) })),
      };
    },
  });

  tools.search_contract_text = tool({
    description:
      "Búsqueda semántica (vectorial) sobre el texto de los contratos. Para preguntas sobre el CONTENIDO. Devuelve fragmentos con su contrato de origen.",
    inputSchema: z.object({
      query: z.string().describe("La pregunta o tema a buscar"),
      top_k: z.number().int().min(1).max(20).optional(),
    }),
    execute: async ({ query, top_k }) => {
      const [embedding] = await generateEmbeddings(env, [query]);
      const { results } = await api.searchChunks(workspace, embedding, top_k ?? LIMITS.fragments);
      const scoped =
        body.mode === "CONTRACT" && body.contract_id
          ? results.filter((chunk) => chunk.contract_id === body.contract_id)
          : results;
      const fragments = scoped.map((chunk) =>
        compact({
          contract_id: chunk.contract_id,
          contract: chunk.title || chunk.file_name || chunk.contract_id,
          similarity: chunk.similarity,
          text: truncate(chunk.content, LIMITS.fragmentChars),
        })
      );
      // An empty semantic result means "nothing vectorized matched", which is
      // not the same as "the workspace does not contain this". Saying so in
      // the payload stops the model from reporting a false negative.
      return fragments.length > 0
        ? { fragments }
        : {
            fragments,
            note: "Sin coincidencias vectoriales. Esto NO prueba que el dato no exista: puede que los contratos no estén vectorizados. Localízalos con find_contracts y verifica con read_contract_excerpts.",
          };
    },
  });

  tools.read_contract_excerpts = tool({
    description:
      "Lee sólo los alrededores de unas palabras clave dentro de contratos concretos. Úsala para verificar detalles puntuales (una INE, un nombre, una cláusula) sin cargar el documento completo en la conversación.",
    inputSchema: z.object({
      contract_ids: z.array(z.string()).min(1).max(10),
      keywords: z.array(z.string()).min(1).max(10).describe("Palabras o frases a localizar dentro del texto"),
      window: z.number().int().min(120).max(1200).optional().describe("Caracteres de contexto alrededor de cada hit"),
      max_per_contract: z.number().int().min(1).max(6).optional(),
    }),
    execute: async (input) => {
      const data = await api.request<{
        results: Array<{
          contract_id: string;
          titulo: string | null;
          file_name: string | null;
          matched_keywords: string[];
          excerpts: Array<{ keyword: string; text: string }>;
        }>;
      }>("POST", `/internal/workspaces/${workspace}/contracts/excerpts/`, input);
      return {
        results: data.results.map((row) =>
          compact({
            contract_id: row.contract_id,
            contrato: row.titulo || row.file_name,
            matched_keywords: row.matched_keywords,
            excerpts: row.excerpts.map((excerpt) => ({
              keyword: excerpt.keyword,
              text: truncate(excerpt.text, LIMITS.excerptChars),
            })),
          })
        ),
      };
    },
  });

  tools.get_contract_details = tool({
    description:
      "Ficha completa de contratos ya localizados: resumen general, involucrados, testigos, periodos de retención/colección, fechas y estatus. No devuelve el texto completo.",
    inputSchema: z.object({ contract_ids: z.array(z.string()).min(1).max(20) }),
    execute: async ({ contract_ids }) => {
      const data = await api.request<{ results: Record<string, unknown>[] }>(
        "POST",
        `/internal/workspaces/${workspace}/contracts/details/`,
        { contract_ids }
      );
      return { results: data.results.map((row) => compact(row)) };
    },
  });

  tools.summarize_contracts = tool({
    description:
      "Revisa el contenido de VARIOS contratos a la vez respondiendo una pregunta concreta sobre cada uno. Cada documento se analiza en una llamada de IA independiente y sólo vuelve el resumen, así que no consume el contexto de esta conversación. Úsala en vez de leer documentos enteros.",
    inputSchema: z.object({
      contract_ids: z.array(z.string()).min(1).max(8),
      question: z
        .string()
        .describe("Qué debe responder el resumen de cada contrato, p. ej. '¿qué obligaciones de pago establece?'"),
      keywords: z
        .array(z.string())
        .max(8)
        .optional()
        .describe(
          "Palabras clave para acotar qué partes del texto lee cada sub-análisis. Si se omite, usa el resumen y la ficha."
        ),
    }),
    execute: async ({ contract_ids, question, keywords }) => {
      const ids = contract_ids.slice(0, LIMITS.summaryFanout);
      const [details, excerpts] = await Promise.all([
        api.request<{ results: Array<Record<string, unknown>> }>(
          "POST",
          `/internal/workspaces/${workspace}/contracts/details/`,
          { contract_ids: ids }
        ),
        keywords && keywords.length > 0
          ? api.request<{
              results: Array<{ contract_id: string; excerpts: Array<{ keyword: string; text: string }> }>;
            }>("POST", `/internal/workspaces/${workspace}/contracts/excerpts/`, {
              contract_ids: ids,
              keywords,
              max_per_contract: 4,
              window: 900,
            })
          : Promise.resolve({
              results: [] as Array<{ contract_id: string; excerpts: Array<{ keyword: string; text: string }> }>,
            }),
      ]);

      const excerptsById = new Map(excerpts.results.map((row) => [row.contract_id, row.excerpts]));
      const workerModel = pickWorkerModel(env);

      // One model call per document, in parallel. Their inputs and reasoning
      // never touch the main conversation — only these one-paragraph answers.
      const summaries = await Promise.all(
        details.results.map(async (detail) => {
          const contractId = String(detail.contract_id);
          const label = String(detail.titulo || detail.file_name || contractId);
          const source = [
            detail.resumen_general ? `RESUMEN: ${detail.resumen_general}` : "",
            detail.artistas ? `ARTISTAS: ${detail.artistas}` : "",
            detail.involucrados ? `INVOLUCRADOS: ${detail.involucrados}` : "",
            detail.fecha_inicio ? `INICIO: ${detail.fecha_inicio}` : "",
            detail.fecha_fin ? `FIN: ${detail.fecha_fin}` : "",
            ...(excerptsById.get(contractId) ?? []).map((excerpt) => `FRAGMENTO (${excerpt.keyword}): ${excerpt.text}`),
          ]
            .filter(Boolean)
            .join("\n")
            .slice(0, LIMITS.subAgentInputChars);

          if (!source.trim()) {
            return {
              contract_id: contractId,
              contrato: label,
              summary: "Sin información extraída para este contrato.",
            };
          }
          try {
            const { text } = await generateText({
              model: workerModel,
              system:
                "Respondes en español, en 2-3 frases como máximo, usando EXCLUSIVAMENTE la información dada. Si no está, responde exactamente: No consta en este documento.",
              prompt: `PREGUNTA: ${question}\n\nDOCUMENTO "${label}":\n${source}`,
            });
            return { contract_id: contractId, contrato: label, summary: text.trim() };
          } catch (error) {
            console.error(JSON.stringify({ message: "sub-agent summary failed", contractId, error: String(error) }));
            return { contract_id: contractId, contrato: label, summary: "No se pudo analizar este documento." };
          }
        })
      );
      return { question, summaries };
    },
  });

  tools.show_documents = tool({
    description:
      "Muestra las tarjetas de los documentos citados (abrir en el panel lateral, abrir en pestaña nueva, descargar). Llámala SIEMPRE al final de una respuesta que mencione documentos concretos, con los contract_id que realmente usaste.",
    inputSchema: z.object({
      contract_ids: z.array(z.string()).min(1).max(20),
      note: z.string().optional().describe("Frase corta que encabeza las tarjetas, p. ej. 'Contratos de 3BALLMTY'"),
      highlights: z
        .array(
          z.object({
            contract_id: z.string(),
            quote: z.string().describe("Frase textual o dato concreto que tomaste de ese documento"),
          })
        )
        .max(20)
        .optional()
        .describe("Por qué citas cada documento. La UI las muestra como anclas dentro de la tarjeta."),
    }),
    // Resolved against Django so the card always carries a real asset the user
    // can open — the model cannot invent a document here.
    execute: async ({ contract_ids, note, highlights }) => {
      const data = await api.request<{ results: ContractRow[] }>(
        "POST",
        `/internal/workspaces/${workspace}/contracts/details/`,
        { contract_ids }
      );
      const byId = new Map(data.results.map((row) => [row.contract_id, row]));
      return {
        note: note ?? null,
        documents: contract_ids
          .map((id) => byId.get(id))
          .filter((row): row is ContractRow => Boolean(row))
          .map((row) =>
            compact({
              contract_id: row.contract_id,
              title: row.titulo,
              file_name: row.file_name,
              asset_id: row.asset_id,
              fecha_inicio: row.fecha_inicio,
              fecha_fin: row.fecha_fin,
              estatus_contrato: row.estatus_contrato,
              tipo_contrato: row.tipo_contrato,
              highlights: (highlights ?? [])
                .filter((highlight) => highlight.contract_id === row.contract_id)
                .map((highlight) => truncate(highlight.quote, 240)),
            })
          ),
      };
    },
  });

  return tools;
}

export async function handleContractsAgent(env: Env, body: ContractsAgentRequest): Promise<Response> {
  const tools = buildTools(env, body);
  const { model, id } = pickModel(env, body.model);

  const system = [
    LANGUAGE_PROMPT(body.locale),
    SYSTEM_PROMPT,
    body.mode === "CONTRACT" && body.contract_id ? CONTRACT_MODE_PROMPT(body.contract_id) : "",
  ]
    .filter(Boolean)
    .join("\n");

  const result = streamText({
    model,
    system,
    // A run the user stopped (or a dropped connection) leaves a tool call with
    // no result in the replayed history; without this the next turn throws
    // instead of answering, which is how a long chat used to start erroring.
    messages: await convertToModelMessages(body.messages, { ignoreIncompleteToolCalls: true }),
    tools,
    stopWhen: stepCountIs(LIMITS.steps),
    onError: ({ error }) => {
      console.error(JSON.stringify({ message: "contracts agent stream error", model: id, error: String(error) }));
    },
  });

  return createUIMessageStreamResponse({
    stream: result.toUIMessageStream({
      messageMetadata: ({ part }) => {
        if (part.type === "finish") return { usage: part.totalUsage };
        if (part.type === "finish-step") return { modelId: part.response.modelId || id };
        return undefined;
      },
    }),
  });
}
