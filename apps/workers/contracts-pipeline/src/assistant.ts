/**
 * Workspace assistant agent: AI SDK streamText with tools over the internal
 * Django API.
 *
 * Principles (borrowed from how Twenty runs its agent):
 * - Read through narrow tools that return small, ranked slices plus the total;
 *   count and scan on the server instead of pulling rows into the context.
 * - Never write: tools that change data return a proposal the user approves
 *   in the UI, which applies it through their own session (and audit trail).
 * - Name only what a tool returned, and link it; ask when a choice is unclear.
 *
 * Contract search reuses the contracts agent's tools as they are (that chat
 * keeps its own behaviour); this agent adds counts and full-set scans for
 * questions over hundreds of documents.
 */

import type { ToolSet, UIMessage } from "ai";
import { convertToModelMessages, createUIMessageStreamResponse, stepCountIs, streamText, tool } from "ai";
import { z } from "zod";

import {
  buildTools as buildContractTools,
  compact,
  defaultModelId,
  pickModel,
  publicStreamError,
  resilient,
} from "./contracts-agent";
import { listChatModels } from "./lib/ai";
import { internalApi } from "./lib/internal-api";

export type AssistantPageContext = {
  page?: string;
  items?: { entity_name: string; id: string; title?: string; subtitle?: string; path?: string }[];
  /** The shared tag open in the tags view */
  tag?: { id: string; name: string; path: string };
};

export type AssistantChatRequest = {
  workspace_id: string;
  workspace_slug: string;
  messages: UIMessage[];
  model?: string | null;
  capabilities?: { contracts?: boolean; music?: boolean; references?: boolean };
  locale?: string | null;
  /** Who is asking: cross-module lookups answer with what this user may open. */
  user_id?: string | null;
  user_name?: string | null;
  today?: string | null;
  /** What the user is looking at (resolved by Django as this user). */
  context?: AssistantPageContext | null;
};

const ENTITY_TYPES = [
  "contract",
  "file",
  "music_track",
  "music_release",
  "music_artist",
  "issue",
  "page",
  "budget",
  "expense",
] as const;

const LIMITS = {
  /** Reasoning steps before the run must answer */
  steps: 14,
  /** Rows a catalog query returns by default (the total always comes along) */
  tracks: 20,
  tracksMax: 100,
  /** Older tool results above this size are reduced to their counts */
  historyChars: 3_000,
} as const;

const SYSTEM_PROMPT = (
  body: AssistantChatRequest,
  caps: { contracts: boolean; music: boolean; references: boolean }
) => {
  const context = body.context;
  const looking = (context?.items ?? [])
    .map(
      (item) =>
        `- ${item.title ?? item.id} (${item.entity_name}, id ${item.id}${item.path ? `, path ${item.path}` : ""})`
    )
    .join("\n");
  return `Eres el asistente del workspace de una disquera y editora musical. Hoy es ${body.today ?? "desconocido"}.${
    body.user_name ? ` Hablas con ${body.user_name}.` : ""
  }
${context?.page ? `\nEl usuario está en la sección: ${context.page}.` : ""}${
    context?.tag
      ? `\nTiene abierta la etiqueta «${context.tag.name}» (tag_id ${context.tag.id}, path ${context.tag.path}).`
      : ""
  }${
    looking
      ? `\nEstá viendo (cuando diga "esto", "esta canción", "estos contratos" se refiere a esto):\n${looking}`
      : ""
  }

CÓMO TRABAJAS
- Primero busca, luego responde. Nunca respondas datos del workspace de memoria.
- Empieza por consultas pequeñas y filtradas (5–20 resultados). Si hay más, di el total y ofrece acotar o descargar.
- Para "cuántos…" o "cómo se reparten…" usa las herramientas de conteo: nunca cuentes trayendo filas.
- Si algo es ambiguo y la respuesta cambia según la opción (dos canciones con el mismo título, qué archivo importar), usa ask_user con opciones concretas en vez de adivinar.
- Nada se modifica desde aquí: las herramientas que cambian datos devuelven una propuesta y el usuario la aprueba en la tarjeta. Dile que revise y apruebe; nunca digas que ya quedó aplicado.

CÓMO RESPONDES
- Breve y directo: la respuesta primero, en una o dos frases; luego el detalle si hace falta.
- Markdown: listas cortas; tabla solo para comparar de 2 a 10 elementos.
- Cuando nombres un elemento devuelto por una herramienta que trae "path", enlázalo: [Título](path). Nunca inventes títulos, ids ni rutas.
- Las tarjetas de las herramientas ya muestran tablas y resultados: no repitas todo su contenido, resume lo importante.
- Fechas en formato ISO (YYYY-MM-DD) al llamar herramientas.
${
  caps.contracts
    ? `
CONTRATOS (cientos de documentos)
- list_known_names primero cuando nombren a un artista, grupo o persona: devuelve cómo está escrito en la base.
- find_contracts para localizar documentos por metadatos (nombres, fechas, estatus, tipo, tags). Varias grafías = una llamada por grafía.
- count_contracts para totales y repartos (por estatus, tipo, año, artista, editorial…), sin traer documentos.
- scan_contracts para "¿qué contratos mencionan X?" sobre TODO un conjunto filtrado: el servidor lee el texto completo y solo devuelve coincidencias. Úsalo en vez de leer documentos uno por uno. Términos cortos y literales (["INE", "Juan Pérez"]).
- read_contract_excerpts para leer alrededor de palabras clave en contratos concretos; search_contract_text solo para preguntas conceptuales.
- get_contract_details y summarize_contracts para el contenido de unos pocos documentos.
- show_documents al final de cualquier respuesta que mencione contratos concretos, con los contract_id que usaste.`
    : ""
}${
    caps.music
      ? `
CATÁLOGO MUSICAL
- query_music_tracks para canciones (artista, año, ISRC, estado, con video). Devuelve pocas filas y el total.
- export_music_excel cuando pidan un listado descargable, con los mismos filtros.
- update_music_track para cambiar una canción (fechas, ISRC, agregar un video). Devuelve una propuesta que el usuario aprueba.
- IMPORTAR un CSV/XLSX: 1) read_import_file con el asset_id (los adjuntos del chat ya lo traen; si no, list_music_files). 2) Decide tú el mapeo leyendo el CONTENIDO de cada columna (column_samples), no solo su nombre. 3) plan_music_import con ese mapeo: valida el archivo sin importar nada. 4) Resume el plan en una o dos frases y dile al usuario que pulse "Revisar e importar": se abre el importador de Música con tu mapeo para revisar valores, duplicados y confirmar. No intentes resolver ahí cada fila.`
      : ""
  }${
    caps.references
      ? `
ETIQUETAS Y REFERENCIAS
- find_tags para la grafía exacta de una etiqueta (artistas, grupos, tipos) y sus variantes.
- find_by_tag para todo lo que lleva una etiqueta (contratos, archivos, canciones, lanzamientos, tareas, gastos), con búsqueda y fechas. "Qué lanzamientos tuvo X en 2024": types ["music_release"] con date_from/date_to. Incluye el enlace "link" a la vista de la etiqueta para ver o descargar todo.
- search_workspace para encontrar cualquier elemento por nombre; get_references para ver qué menciona y dónde lo mencionan.`
      : ""
  }`;
};

const LANGUAGE_PROMPT = (locale?: string | null) => `
IDIOMA: responde en el idioma del último mensaje del usuario (por defecto español). Su interfaz usa ${
  locale || "un locale desconocido"
} como referencia secundaria. El idioma de archivos, contratos o resultados es contenido y nunca cambia el de tu respuesta.`;

/** Same models as the contracts chat, and the same default (DeepSeek unless
 * CHAT_DEFAULT_MODEL names another declared model). */
export function listAssistantModels(env: Env): ReturnType<typeof listChatModels> {
  const { models, default_model } = listChatModels(env);
  return { models, default_model: defaultModelId(env) ?? default_model };
}

const trackFilterSchema = {
  search: z.string().optional().describe("Texto libre: título, ISRC, artista"),
  artist_name: z.string().optional().describe("Nombre (o parte) del artista"),
  from: z.string().optional().describe("Fecha de lanzamiento desde, YYYY-MM-DD"),
  to: z.string().optional().describe("Fecha de lanzamiento hasta, YYYY-MM-DD"),
  year: z.string().optional().describe("Año de lanzamiento, YYYY"),
  isrc: z.string().optional(),
  status: z.enum(["DRAFT", "READY", "SCHEDULED", "RELEASED", "TAKEN_DOWN"]).optional(),
  has_video: z.boolean().optional().describe("true = solo canciones con video musical"),
};

/** Filters shared by count_contracts and scan_contracts (the contracts agent's terms). */
const contractFilterSchema = {
  names: z.array(z.string()).max(6).optional().describe("Términos libres (artista, grupo, persona, título); AND"),
  artist: z.string().optional(),
  person: z.string().optional().describe("Involucrados o testigos"),
  group: z.string().optional(),
  title: z.string().optional(),
  date_field: z.enum(["inicio", "fin", "fin_efectiva", "creacion"]).optional(),
  year: z.number().int().optional(),
  date_from: z.string().optional().describe("YYYY-MM-DD"),
  date_to: z.string().optional().describe("YYYY-MM-DD"),
  estatus: z.array(z.enum(["VIGENTE", "FINALIZADO", "NO_ESPECIFICADO"])).optional(),
  tipo: z.array(z.enum(["ARRENDAMIENTOS", "ALQUILERES", "VEHICULOS", "SERVICIOS", "ARTISTAS"])).optional(),
  es_editorial: z.boolean().optional(),
  tags: z.array(z.string()).max(6).optional(),
};

function query(input: Record<string, unknown>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  return params;
}

type TrackRow = {
  id: string;
  title: string;
  version?: string | null;
  isrc?: string | null;
  status?: string;
  release_date?: string | null;
  artists?: string[];
  featured?: string[];
  releases?: { title: string; upc?: string | null }[];
  videos?: unknown[];
};

function buildTools(
  env: Env,
  body: AssistantChatRequest,
  caps: { contracts: boolean; music: boolean; references: boolean }
) {
  const api = internalApi(env);
  const workspace = body.workspace_id;
  const slug = body.workspace_slug;
  let tools: ToolSet = {};

  // No `execute`: the run pauses with the call in the stream; the chat UI
  // collects the user's answer and resumes the conversation with the result.
  tools.ask_user = tool({
    description:
      "Pregunta al usuario y espera su respuesta antes de continuar, con opciones concretas cuando existan. Úsala ante ambigüedades que cambian el resultado.",
    inputSchema: z.object({
      question: z.string().describe("La pregunta, clara y concreta"),
      options: z.array(z.string()).max(6).optional().describe("Opciones para responder con un clic"),
      context: z.string().optional().describe("Contexto breve para decidir"),
    }),
  });

  if (caps.contracts) {
    // The contracts agent's own tools, unchanged.
    tools = {
      ...tools,
      ...buildContractTools(env, {
        workspace_id: workspace,
        workspace_slug: slug,
        mode: "GENERAL",
        messages: [],
        model: body.model,
        locale: body.locale,
      }),
    };

    tools.count_contracts = tool({
      description:
        "Cuenta contratos agrupados por un campo (estatus, tipo, year, artista, grupo, editorial, notariado, procesamiento) con filtros opcionales. Devuelve el total y los grupos, sin traer documentos.",
      inputSchema: z.object({
        group_by: z.enum(["estatus", "tipo", "year", "artista", "grupo", "editorial", "notariado", "procesamiento"]),
        ...contractFilterSchema,
        limit: z.number().int().min(1).max(100).optional(),
      }),
      execute: async (input) => api.request("POST", `/internal/workspaces/${workspace}/contracts/group/`, input),
    });

    tools.scan_contracts = tool({
      description:
        "Busca términos LITERALES dentro del texto completo de TODOS los contratos que cumplan los filtros (hasta cientos) y devuelve solo los que coinciden, con un fragmento alrededor. match='all' exige todos los términos.",
      inputSchema: z.object({
        keywords: z.array(z.string()).min(1).max(6).describe("Términos cortos, por separado"),
        match: z.enum(["any", "all"]).optional(),
        ...contractFilterSchema,
        max_matches: z.number().int().min(1).max(40).optional(),
      }),
      execute: async (input) => api.request("POST", `/internal/workspaces/${workspace}/contracts/scan/`, input),
    });
  }

  if (caps.music) {
    tools.query_music_tracks = tool({
      description: `Consulta el catálogo musical. Devuelve hasta ${LIMITS.tracks} canciones por defecto (máx. ${LIMITS.tracksMax}) y el total, cada una con su path.`,
      inputSchema: z.object({ ...trackFilterSchema, limit: z.number().int().min(1).max(LIMITS.tracksMax).optional() }),
      execute: async (input) => {
        const data = await api.request<{ total: number; returned: number; results: TrackRow[] }>(
          "GET",
          `/internal/workspaces/${workspace}/music/tracks/?${query({ ...input, limit: input.limit ?? LIMITS.tracks })}`
        );
        return {
          total: data.total,
          returned: data.returned,
          filters: compact(input),
          results: data.results.map((track) =>
            compact({
              id: track.id,
              title: track.version ? `${track.title} (${track.version})` : track.title,
              artists: [...(track.artists ?? []), ...(track.featured ?? [])].join(", "),
              isrc: track.isrc,
              release_date: track.release_date,
              status: track.status,
              release: track.releases?.[0]?.title,
              videos: track.videos?.length || undefined,
              path: `/${slug}/music?track=${track.id}`,
            })
          ),
        };
      },
    });

    tools.export_music_excel = tool({
      description:
        "Prepara la descarga en Excel del catálogo con los mismos filtros de query_music_tracks. La tarjeta muestra el botón; no descarga nada por sí misma.",
      inputSchema: z.object(trackFilterSchema),
      execute: async (input) => {
        const { total } = await api.request<{ total: number }>(
          "GET",
          `/internal/workspaces/${workspace}/music/tracks/?${query({ ...input, limit: 1 })}`
        );
        return { count: total, params: Object.fromEntries(query(input)), workspace_slug: slug };
      },
    });

    tools.list_music_files = tool({
      description: "Lista archivos de la biblioteca para localizar el que el usuario quiere importar.",
      inputSchema: z.object({ search: z.string().optional().describe("Parte del nombre del archivo") }),
      execute: async ({ search }) => {
        const data = await api.request<{ results: Record<string, unknown>[] }>(
          "GET",
          `/internal/workspaces/${workspace}/assets/${search ? `?search=${encodeURIComponent(search)}` : ""}`
        );
        return { results: (data.results ?? []).slice(0, 15) };
      },
    });

    tools.read_import_file = tool({
      description:
        "Lee un CSV/XLSX para importarlo: columnas, cuántas celdas tiene cada una con hasta 3 ejemplos tomados de todo el archivo, hojas, campos canónicos disponibles y un mapeo heurístico de partida.",
      inputSchema: z.object({
        asset_id: z.string(),
        sheet: z.string().optional().describe("Hoja del XLSX"),
      }),
      execute: async ({ asset_id, sheet }) => {
        const data = await api.request<{
          file_name?: string;
          headers: string[];
          column_samples: Record<string, { non_empty: number; total: number; examples: unknown[] }>;
          total_rows: number;
          sheets: string[];
          selected_sheet?: string | null;
          canonical_fields: unknown;
          heuristic_mapping: Record<string, string>;
        }>("POST", `/internal/workspaces/${workspace}/music/import/`, { asset_id, sheet, mode: "read" });
        return {
          asset_id,
          file_name: data.file_name,
          total_rows: data.total_rows,
          sheets: data.sheets,
          selected_sheet: sheet ?? data.selected_sheet ?? null,
          columns: data.headers.map((header) => ({
            name: header,
            filled: `${data.column_samples[header]?.non_empty ?? 0}/${data.column_samples[header]?.total ?? data.total_rows}`,
            examples: (data.column_samples[header]?.examples ?? []).slice(0, 3),
          })),
          canonical_fields: data.canonical_fields,
          heuristic_mapping: data.heuristic_mapping,
        };
      },
    });

    tools.plan_music_import = tool({
      description:
        "Valida un archivo con TU mapeo, sin importar nada, y devuelve cuántas canciones se crearían, actualizarían u omitirían y los primeros problemas. La tarjeta ofrece 'Revisar e importar', que abre el importador de Música con este plan.",
      inputSchema: z.object({
        asset_id: z.string(),
        sheet: z.string().optional(),
        mapping: z
          .record(z.string(), z.union([z.string(), z.array(z.string())]))
          .describe("Campo canónico → columna EXACTA del archivo (o varias columnas)"),
        dedupe_by: z
          .enum(["auto", "isrc", "title", "catalog", "upc", "none"])
          .optional()
          .describe("Qué define un duplicado; 'auto' = ISRC y luego título+fecha"),
        duplicate_strategy: z.enum(["skip", "update"]).optional().describe("Qué hacer con canciones que ya existen"),
        reason: z.string().max(300).optional().describe("Por qué elegiste este mapeo, en una frase"),
      }),
      execute: async ({ asset_id, sheet, mapping, dedupe_by, duplicate_strategy, reason }) => {
        const result = await api.request<Record<string, unknown> & { errors?: { row?: number; message?: string }[] }>(
          "POST",
          `/internal/workspaces/${workspace}/music/import/`,
          {
            asset_id,
            sheet,
            mode: "import",
            mapping,
            dedupe_by: dedupe_by ?? "auto",
            duplicate_strategy: duplicate_strategy ?? "skip",
            invalid_row_strategy: "skip",
            dry_run: true,
          }
        );
        const errors = Array.isArray(result.errors) ? result.errors : [];
        const pick = (key: string) => (typeof result[key] === "number" ? (result[key] as number) : 0);
        return {
          asset_id,
          sheet: sheet ?? null,
          mapping,
          dedupe_by: dedupe_by ?? "auto",
          duplicate_strategy: duplicate_strategy ?? "skip",
          reason,
          summary: {
            total: pick("total"),
            created: pick("created"),
            updated: pick("updated"),
            unchanged: pick("unchanged"),
            skipped: pick("skipped"),
            omitted: pick("omitted"),
            errors: errors.length,
            possible_duplicates: pick("possible_duplicate_count"),
          },
          first_errors: errors.slice(0, 3).map((error) => ({ row: error.row, message: error.message })),
          workspace_slug: slug,
        };
      },
    });

    tools.update_music_track = tool({
      description:
        "Propone cambios sobre una canción (fechas, ISRC, agregar un video con su fecha/ISRC). Resuelve la canción por ISRC o título+artista y devuelve antes/después; el usuario aprueba en la tarjeta. Si coinciden varias, devuelve las opciones: pregunta con ask_user.",
      inputSchema: z.object({
        track_isrc: z.string().optional(),
        track_title: z.string().optional(),
        artist_name: z.string().optional(),
        set: z.object({
          release_date: z.string().optional(),
          original_release_date: z.string().optional(),
          isrc: z.string().optional(),
          video_url: z.string().optional().describe("Agrega un video musical (no reemplaza los existentes)"),
          video_release_date: z.string().optional(),
          video_isrc: z.string().optional(),
        }),
      }),
      execute: async ({ track_isrc, track_title, artist_name, set }) => {
        const params = query({ isrc: track_isrc, search: track_isrc ? undefined : track_title, artist_name, limit: 5 });
        const { results, total } = await api.request<{ total: number; results: TrackRow[] }>(
          "GET",
          `/internal/workspaces/${workspace}/music/tracks/?${params}`
        );
        if (total === 0) return { error: "No se encontró la canción.", matches: [] };
        if (total > 1) {
          return {
            error: "Coinciden varias canciones; pregunta cuál con ask_user.",
            matches: results.map((track) =>
              compact({ id: track.id, title: track.title, isrc: track.isrc, artists: (track.artists ?? []).join(", ") })
            ),
          };
        }
        const track = results[0];
        return {
          track_id: track.id,
          title: track.title,
          artists: (track.artists ?? []).join(", "),
          path: `/${slug}/music?track=${track.id}`,
          before: compact({
            release_date: track.release_date,
            isrc: track.isrc,
            videos: track.videos?.length ?? 0,
          }),
          changes: compact(set),
          workspace_slug: slug,
        };
      },
    });
  }

  if (caps.references) {
    const lookup = <T>(path: string, params: Record<string, unknown> = {}) =>
      api.request<T>(
        "GET",
        `/internal/workspaces/${workspace}/assistant/${path}?${query({ ...params, user_id: body.user_id })}`
      );

    tools.find_tags = tool({
      description:
        "Etiquetas del workspace cuyo nombre coincide (tolera espacios y mayúsculas: '3ball' encuentra 3BallMTY y 3Ball Mty), ordenadas por uso.",
      inputSchema: z.object({ query: z.string().describe("Nombre o fragmento") }),
      execute: async ({ query: q }) => lookup("tags/", { q }),
    });

    tools.find_by_tag = tool({
      description:
        "Todo lo que lleva una etiqueta (por nombre exacto o tag_id), agrupado por tipo con conteos, hasta 30 por tipo, más recientes primero, con búsqueda y rango de fechas.",
      inputSchema: z.object({
        tag: z.string().optional().describe("Nombre exacto (usa find_tags antes)"),
        tag_id: z.string().optional(),
        types: z.array(z.enum(ENTITY_TYPES)).optional(),
        query: z.string().optional().describe("Buscar dentro de la etiqueta"),
        date_from: z.string().optional(),
        date_to: z.string().optional(),
      }),
      execute: async ({ tag, tag_id, types, query: q, date_from, date_to }) =>
        lookup("tagged/", { tag, tag_id, types: types?.join(","), q, date_from, date_to }),
    });

    tools.search_workspace = tool({
      description:
        "Busca por nombre en todo el workspace: contratos, archivos, canciones, lanzamientos, artistas, tareas, páginas, presupuestos y gastos.",
      inputSchema: z.object({ query: z.string(), types: z.array(z.enum(ENTITY_TYPES)).optional() }),
      execute: async ({ query: q, types }) => lookup("search/", { q, types: types?.join(",") }),
    });

    tools.get_references = tool({
      description:
        "Qué menciona o tiene adjunto un elemento (references) y qué tareas o páginas lo mencionan (referenced_by).",
      inputSchema: z.object({ entity_name: z.enum(ENTITY_TYPES), id: z.string() }),
      execute: async ({ entity_name, id }) => lookup(`references/${entity_name}/${id}/`),
    });
  }

  return tools;
}

const SUMMARY_KEYS = ["total", "returned", "count", "matched", "candidates", "scanned", "has_more", "summary"];

/**
 * Older turns' tool results are reduced to their counts before re-sending.
 *
 * The full history goes to the model on every turn; a 100-row table from three
 * questions ago only costs tokens (and context window) by now. The latest turn
 * stays intact so the model can still read what it just found.
 */
function compactHistory(messages: UIMessage[]): UIMessage[] {
  const lastUser = messages.map((message) => message.role).lastIndexOf("user");
  return messages.map((message, index) => {
    if (index >= lastUser || message.role !== "assistant") return message;
    return {
      ...message,
      parts: message.parts.map((part) => {
        const output = (part as { output?: unknown }).output;
        if (output === undefined || JSON.stringify(output).length <= LIMITS.historyChars) return part;
        const kept: Record<string, unknown> = { note: "resultado anterior resumido" };
        if (output && typeof output === "object") {
          for (const key of SUMMARY_KEYS) {
            if (key in output) kept[key] = (output as Record<string, unknown>)[key];
          }
        }
        return { ...part, output: kept } as typeof part;
      }),
    };
  });
}

export async function handleAssistantChat(env: Env, body: AssistantChatRequest): Promise<Response> {
  const caps = {
    contracts: body.capabilities?.contracts === true,
    music: body.capabilities?.music === true,
    // Only with a known user: answers are limited to what they may open.
    references: body.capabilities?.references === true && Boolean(body.user_id),
  };
  const tools = resilient(buildTools(env, body, caps));
  const { model, id } = pickModel(env, body.model);

  const result = streamText({
    model,
    system: `${LANGUAGE_PROMPT(body.locale)}\n${SYSTEM_PROMPT(body, caps)}`,
    // A stopped run (or an unanswered question card) leaves a tool call with
    // no result in the history; without this the next turn throws.
    messages: await convertToModelMessages(compactHistory(body.messages), { ignoreIncompleteToolCalls: true }),
    tools,
    stopWhen: stepCountIs(LIMITS.steps),
    maxRetries: 3,
    onError: ({ error }) => {
      console.error(JSON.stringify({ message: "assistant stream error", model: id, error: String(error) }));
    },
  });

  return createUIMessageStreamResponse({
    stream: result.toUIMessageStream({
      onError: publicStreamError,
      messageMetadata: ({ part }) => {
        if (part.type === "finish") return { usage: part.totalUsage };
        if (part.type === "finish-step") return { modelId: part.response.modelId || id };
        return undefined;
      },
    }),
  });
}
