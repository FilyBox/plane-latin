/**
 * Workspace assistant agent: AI SDK streamText with tools over the internal
 * Django API. Mutations are NEVER executed here — write-flavored tools return
 * proposals (dry-run/diff) that the web UI applies through the user's own
 * session, keeping the audit trail on Django's side.
 */

import { createDeepSeek } from "@ai-sdk/deepseek";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel, ToolSet, UIMessage } from "ai";
import { convertToModelMessages, createUIMessageStreamResponse, stepCountIs, streamText, tool } from "ai";
import { z } from "zod";

import { generateEmbeddings, listChatModels } from "./lib/ai";
import { internalApi } from "./lib/internal-api";

export type AssistantChatRequest = {
  workspace_id: string;
  workspace_slug: string;
  messages: UIMessage[];
  model?: string | null;
  capabilities?: { contracts?: boolean; music?: boolean };
  locale?: string | null;
};

const SYSTEM_PROMPT = (caps: {
  contracts: boolean;
  music: boolean;
}) => `Eres el asistente del workspace. Respondes SIEMPRE en el idioma del usuario (por defecto español), claro y conciso.

Herramientas disponibles y cuándo usarlas:
${caps.contracts ? "- search_contracts: preguntas sobre el CONTENIDO de contratos (cláusulas, artistas, fechas de contratos, resúmenes). Cita de qué contrato proviene cada dato." : ""}
${
  caps.music
    ? `- query_music_tracks: preguntas sobre el catálogo musical (canciones, artistas, ISRC, fechas de lanzamiento, videos). Úsala antes de responder cualquier dato del catálogo.
- export_music_excel: cuando el usuario pida un listado/reporte descargable, llámala con los MISMOS filtros que usaste en query_music_tracks; la UI muestra el botón de descarga.
- list_music_files: para resolver de qué archivo habla el usuario cuando quiere importar datos.
- propose_music_import: importación AI-driven de un CSV/XLSX al catálogo. Flujo OBLIGATORIO:
  1. mode=read → recibes columnas, filas de muestra Y column_samples: por CADA columna, hasta 5 valores no-vacíos tomados de TODO el archivo más su conteo de llenado (non_empty/total). Una columna puede venir vacía en las primeras mil filas y tener datos después — column_samples es tu fuente de verdad para clasificarla, no las filas de muestra.
  2. Analiza el CONTENIDO de cada columna (sus examples), no solo su nombre: una columna sin nombre útil cuyo contenido son URLs de YouTube se mapea a track.video_url; URLs de Spotify/Apple Music a track.streaming_url; códigos tipo "USRC17607839" son ISRC aunque la columna se llame "código"; fechas se reconocen por su formato. Los campos canónicos disponibles vienen en canonical_fields. Reporta al usuario columnas con muy pocos datos (non_empty bajo) por si son basura.
  3. Si una columna es ambigua (no sabes a qué campo va), si hay columnas importantes sin mapeo posible, o si hay que elegir entre interpretaciones, usa ask_user ANTES de proponer — no adivines en silencio.
  4. mode=propose con el mapping → recibes el dry-run (created/updated/skipped/errors + unparseable).
  5. VARIABLES: el campo "unparseable" del dry-run lista, por campo, los valores que NO se pudieron interpretar (p. ej. una columna de duración con "ringtone" en vez de 3:16 — suelen ser palabras usadas como valor predefinido). Por CADA token distinto usa ask_user con opciones: asignarle un valor concreto (p. ej. ringtone = 0:30), dejar la celda vacía, u omitir esas filas completas. Aplica la decisión con value_overrides (ej. track.duration_ms → ringtone → "0:30"; cadena vacía = celda vacía; "__SKIP_ROW__" = omitir fila) y vuelve a proponer.
  6. DUPLICADOS: si el dry-run marca updated/skipped que el usuario no esperaba, puede ser que títulos repetidos tengan identificadores distintos (ISRC, catálogo, UPC). Pregunta con ask_user qué identificador define un duplicado (título / ISRC / catálogo / UPC) y qué hacer (conservar todos = dedupe_by "none", actualizar = strategy "update", omitir = "skip"), y re-propone con dedupe_by.
  7. Si el dry-run trae errores por fila, explícalos y usa ask_user para decidir cómo resolverlos (corregir mapping, row_overrides, cambiar duplicate_strategy, ignorar esas filas).
  8. Cuando el resultado sea correcto, dile al usuario que presione "Aplicar importación" en la tarjeta.
  9. ACTUALIZAR DESPUÉS: si el usuario descubre más tarde el valor de una variable que omitió, puede re-importar el MISMO archivo (list_music_files lo encuentra, o que lo re-adjunte) con duplicate_strategy "update", dedupe_by por su identificador y el value_overrides nuevo — solo se actualizarán los campos mapeados.
- update_music_track: cuando pidan modificar una canción (agregar link de video, ISRC, fechas). Devuelve una propuesta de cambio que el usuario confirma en la UI.`
    : ""
}
- ask_user: pregunta al usuario cuando necesites una decisión o dato para continuar (columna ambigua, estrategia de duplicados, fila problemática). Ofrece opciones concretas cuando existan. Úsala las veces necesarias hasta completar la tarea — no dejes trabajo a medias por falta de información.

Reglas:
- No inventes datos: si una tool no devuelve resultados, dilo.
- Para listados largos, muestra un resumen y ofrece el Excel.
- Fechas siempre en formato ISO (YYYY-MM-DD) al llamar tools.
- Los archivos adjuntados en el chat llegan con su asset_id — úsalo directo, no llames list_music_files para buscarlos.
- Toda importación debe ejecutar propose_music_import en mode=propose antes de aplicar. Si la validación devuelve errores, explica fila, campo y causa; no apliques hasta que el usuario elija omitirlos o corregirlos.
- Cuando el usuario pida ayuda para corregir filas inválidas, propone únicamente valores seguros mediante row_overrides y vuelve a validar en mode=propose. Nunca inventes identificadores legales, ISRC, UPC o porcentajes.`;

const LANGUAGE_PROMPT = (locale?: string | null) => `
IDIOMA OBLIGATORIO:
- Responde en el mismo idioma del ultimo mensaje escrito por el usuario. Su interfaz usa ${locale || "un locale desconocido"} como referencia secundaria.
- El idioma de columnas, archivos, contratos y resultados de herramientas es contenido y nunca cambia el idioma de tu respuesta.
- Si el usuario escribe en espanol, responde completamente en espanol, incluidos resumenes y preguntas.
- Nunca pegues un JSON de mapeo para pedir confirmacion. Usa ask_user para decisiones y propose_music_import mode=propose para mostrar la tarjeta interactiva.
`;

function pickModel(env: Env, requested?: string | null): { model: LanguageModel; id: string } {
  const gemini = createGoogleGenerativeAI({ apiKey: env.GOOGLE_GENERATIVE_AI_API_KEY });
  const deepseek = createDeepSeek({ apiKey: env.DEEPSEEK_API_KEY });
  const deepseekModels = (env.DEEPSEEK_MODEL_LIST || env.DEEPSEEK_MODEL || "deepseek-chat")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const geminiModels = (env.GEMINI_MODEL_FALLBACK_LIST || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (requested) {
    if (deepseekModels.includes(requested)) return { model: deepseek(requested), id: requested };
    if (geminiModels.includes(requested)) return { model: gemini(requested), id: requested };
  }
  // Independent from AI_PROVIDER: the contracts pipeline stays on DeepSeek by
  // default while this chat can default to a different provider (Gemini).
  const provider = (env.ASSISTANT_AI_PROVIDER || "gemini").toLowerCase();
  if (provider === "deepseek" && deepseekModels.length > 0) {
    return { model: deepseek(deepseekModels[0]), id: deepseekModels[0] };
  }
  if (geminiModels.length > 0) {
    return { model: gemini(geminiModels[0]), id: geminiModels[0] };
  }
  return { model: deepseek(deepseekModels[0]), id: deepseekModels[0] };
}

/** Same env-declared model list as the contract chat, but the default follows
 * ASSISTANT_AI_PROVIDER instead of CHAT_DEFAULT_MODEL. */
export function listAssistantModels(env: Env): ReturnType<typeof listChatModels> {
  const { models, default_model } = listChatModels(env);
  const provider = (env.ASSISTANT_AI_PROVIDER || "gemini").toLowerCase();
  const preferred = models.find((model) => model.provider === provider);
  return { models, default_model: preferred?.id ?? default_model };
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

function trackParams(input: Record<string, unknown>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  return params;
}

function buildTools(env: Env, body: AssistantChatRequest) {
  const api = internalApi(env);
  const caps = { contracts: body.capabilities?.contracts !== false, music: body.capabilities?.music !== false };
  const tools: ToolSet = {};

  // No `execute`: the run pauses with the call in the stream; the chat UI
  // collects the user's answer and resumes the conversation with the result.
  tools.ask_user = tool({
    description:
      "Pregunta al usuario y espera su respuesta antes de continuar. Úsala para columnas ambiguas, decisiones de importación, filas con problemas, o cualquier dato que falte.",
    inputSchema: z.object({
      question: z.string().describe("La pregunta, clara y concreta"),
      options: z.array(z.string()).max(6).optional().describe("Opciones sugeridas para responder con un clic"),
      context: z.string().optional().describe("Contexto breve (p. ej. valores de muestra de la columna en duda)"),
    }),
  });

  if (caps.contracts) {
    tools.search_contracts = tool({
      description:
        "Búsqueda semántica sobre el texto vectorizado de los contratos del workspace. Devuelve fragmentos relevantes con su contrato de origen.",
      inputSchema: z.object({
        query: z.string().describe("La pregunta o tema a buscar en los contratos"),
        top_k: z.number().int().min(1).max(20).optional(),
      }),
      execute: async ({ query, top_k }) => {
        const [embedding] = await generateEmbeddings(env, [query]);
        const { results } = await api.searchChunks(body.workspace_id, embedding, top_k ?? 10);
        return {
          fragments: results.map((chunk) => ({
            contract_id: chunk.contract_id,
            contract: chunk.title || chunk.file_name || chunk.contract_id,
            similarity: chunk.similarity,
            text: chunk.content,
          })),
          sources: results
            .filter((chunk, index, all) => all.findIndex((c) => c.contract_id === chunk.contract_id) === index)
            .map((chunk) => ({
              contract_id: chunk.contract_id,
              title: chunk.title,
              file_name: chunk.file_name,
              similarity: chunk.similarity,
            })),
        };
      },
    });
  }

  if (caps.music) {
    tools.query_music_tracks = tool({
      description:
        "Consulta el catálogo musical (canciones con artistas, ISRC, fechas, videos). Devuelve hasta `limit` filas y el total.",
      inputSchema: z.object({ ...trackFilterSchema, limit: z.number().int().min(1).max(200).optional() }),
      execute: async (input) =>
        api.request<{ total: number; returned: number; results: unknown[] }>(
          "GET",
          `/internal/workspaces/${body.workspace_id}/music/tracks/?${trackParams(input)}`
        ),
    });

    tools.export_music_excel = tool({
      description:
        "Prepara la descarga en Excel del catálogo con los filtros dados (mismos filtros que query_music_tracks). La UI muestra el botón de descarga; no descarga nada por sí misma.",
      inputSchema: z.object(trackFilterSchema),
      execute: async (input) => {
        const { total } = await api.request<{ total: number }>(
          "GET",
          `/internal/workspaces/${body.workspace_id}/music/tracks/?${trackParams({ ...input, limit: 1 })}`
        );
        return { count: total, params: Object.fromEntries(trackParams(input)), workspace_slug: body.workspace_slug };
      },
    });

    tools.list_music_files = tool({
      description: "Lista archivos de la biblioteca (Files) para localizar el que el usuario quiere importar.",
      inputSchema: z.object({ search: z.string().optional().describe("Parte del nombre del archivo") }),
      execute: async ({ search }) =>
        api.request<{ results: unknown[] }>(
          "GET",
          `/internal/workspaces/${body.workspace_id}/assets/${search ? `?search=${encodeURIComponent(search)}` : ""}`
        ),
    });

    tools.propose_music_import = tool({
      description:
        "Importación de un CSV/XLSX al catálogo. mode=read devuelve columnas + filas de muestra + mapping heurístico; corrige ese mapping (claves canónicas → nombre EXACTO de columna) y llama mode=propose para obtener el dry-run (created/updated/skipped/errors). El usuario aplica desde la UI.",
      inputSchema: z.object({
        asset_id: z.string().describe("Id del archivo (de list_music_files)"),
        mode: z.enum(["read", "propose"]),
        sheet: z.string().optional().describe("Nombre de la hoja (XLSX)"),
        mapping: z
          .record(z.string(), z.string())
          .optional()
          .describe("Solo en propose: campo canónico → columna del archivo"),
        duplicate_strategy: z.enum(["skip", "update", "error"]).optional(),
        invalid_row_strategy: z.enum(["abort", "skip"]).optional(),
        row_overrides: z
          .record(z.string(), z.record(z.string(), z.string()))
          .optional()
          .describe("Correcciones por numero de fila: fila -> campo canonico -> valor de reemplazo"),
        dedupe_by: z
          .enum(["auto", "isrc", "title", "catalog", "upc", "none"])
          .optional()
          .describe(
            "Qué identificador define un duplicado. 'none' = conservar todos (crea aunque el título se repita); 'auto' = ISRC y luego título+fecha"
          ),
        value_overrides: z
          .record(z.string(), z.record(z.string(), z.string()))
          .optional()
          .describe(
            'Resolución de "variables" (valores no parseables repetidos): campo canónico -> {token en minúsculas -> reemplazo}. "" deja la celda vacía; "__SKIP_ROW__" omite la fila completa. Ej: {"track.duration_ms": {"ringtone": "0:30"}}'
          ),
      }),
      execute: async ({
        asset_id,
        mode,
        sheet,
        mapping,
        duplicate_strategy,
        invalid_row_strategy,
        row_overrides,
        dedupe_by,
        value_overrides,
      }) => {
        if (mode === "read") {
          const inspected = await api.request<Record<string, unknown>>(
            "POST",
            `/internal/workspaces/${body.workspace_id}/music/import/`,
            { asset_id, sheet, mode: "read" }
          );
          return { ...inspected, asset_id, selected_sheet: sheet ?? inspected.selected_sheet ?? null };
        }
        const result = await api.request<Record<string, unknown>>(
          "POST",
          `/internal/workspaces/${body.workspace_id}/music/import/`,
          {
            asset_id,
            sheet,
            mode: "import",
            mapping,
            duplicate_strategy: duplicate_strategy ?? "skip",
            invalid_row_strategy: invalid_row_strategy ?? "abort",
            row_overrides: row_overrides ?? {},
            dedupe_by: dedupe_by ?? "auto",
            value_overrides: value_overrides ?? {},
            dry_run: true,
          }
        );
        // Everything the Apply button needs travels in the tool result
        return {
          ...result,
          proposal: {
            asset_id,
            sheet: sheet ?? null,
            mapping,
            duplicate_strategy: duplicate_strategy ?? "skip",
            invalid_row_strategy: invalid_row_strategy ?? "abort",
            row_overrides: row_overrides ?? {},
            dedupe_by: dedupe_by ?? "auto",
            value_overrides: value_overrides ?? {},
          },
        };
      },
    });

    tools.update_music_track = tool({
      description:
        "Propone cambios sobre una canción existente (fechas, ISRC, link de video musical con su fecha/ISRC). Resuelve la canción por ISRC o título+artista y devuelve el diff; el usuario lo aplica desde la UI.",
      inputSchema: z.object({
        track_isrc: z.string().optional(),
        track_title: z.string().optional(),
        artist_name: z.string().optional(),
        set: z.object({
          release_date: z.string().optional(),
          original_release_date: z.string().optional(),
          isrc: z.string().optional(),
          video_url: z.string().optional(),
          video_release_date: z.string().optional(),
          video_isrc: z.string().optional(),
        }),
      }),
      execute: async ({ track_isrc, track_title, artist_name, set }) => {
        const params = trackParams({
          isrc: track_isrc,
          search: track_isrc ? undefined : track_title,
          artist_name,
          limit: 5,
        });
        const { results, total } = await api.request<{ total: number; results: Array<Record<string, unknown>> }>(
          "GET",
          `/internal/workspaces/${body.workspace_id}/music/tracks/?${params}`
        );
        if (total === 0) return { error: "No se encontró la canción", matches: [] };
        if (total > 1 && !track_isrc) {
          return {
            error: "Coinciden varias canciones; pide al usuario que precise (ISRC o artista)",
            matches: results.map((track) => ({
              id: track.id,
              title: track.title,
              isrc: track.isrc,
              artists: track.artists,
            })),
          };
        }
        const track = results[0];
        return { track_id: track.id, before: track, changes: set, workspace_slug: body.workspace_slug };
      },
    });
  }

  return { tools, caps };
}

export async function handleAssistantChat(env: Env, body: AssistantChatRequest): Promise<Response> {
  const { tools, caps } = buildTools(env, body);
  const { model, id } = pickModel(env, body.model);

  const result = streamText({
    model,
    system: `${LANGUAGE_PROMPT(body.locale)}\n${SYSTEM_PROMPT(caps)}`,
    messages: await convertToModelMessages(body.messages),
    tools,
    // Import loops (read → analyze → ask → propose → refine) take more steps
    stopWhen: stepCountIs(8),
    onError: ({ error }) => {
      console.error(JSON.stringify({ message: "assistant stream error", model: id, error: String(error) }));
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
