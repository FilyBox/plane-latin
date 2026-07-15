/**
 * Workspace assistant agent: AI SDK streamText with tools over the internal
 * Django API. Mutations are NEVER executed here — write-flavored tools return
 * proposals (dry-run/diff) that the web UI applies through the user's own
 * session, keeping the audit trail on Django's side.
 */

import { createDeepSeek } from "@ai-sdk/deepseek";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel, ToolSet, UIMessage } from "ai";
import { convertToModelMessages, stepCountIs, streamText, tool } from "ai";
import { z } from "zod";

import { generateEmbeddings } from "./lib/ai";
import { internalApi } from "./lib/internal-api";

export type AssistantChatRequest = {
  workspace_id: string;
  workspace_slug: string;
  messages: UIMessage[];
  model?: string | null;
  capabilities?: { contracts?: boolean; music?: boolean };
};

const SYSTEM_PROMPT = (caps: { contracts: boolean; music: boolean }) => `Eres el asistente del workspace. Respondes SIEMPRE en el idioma del usuario (por defecto español), claro y conciso.

Herramientas disponibles y cuándo usarlas:
${caps.contracts ? "- search_contracts: preguntas sobre el CONTENIDO de contratos (cláusulas, artistas, fechas de contratos, resúmenes). Cita de qué contrato proviene cada dato." : ""}
${
  caps.music
    ? `- query_music_tracks: preguntas sobre el catálogo musical (canciones, artistas, ISRC, fechas de lanzamiento, videos). Úsala antes de responder cualquier dato del catálogo.
- export_music_excel: cuando el usuario pida un listado/reporte descargable, llámala con los MISMOS filtros que usaste en query_music_tracks; la UI muestra el botón de descarga.
- list_music_files: para resolver de qué archivo habla el usuario cuando quiere importar datos.
- propose_music_import: para importar un archivo (CSV/XLSX) al catálogo. Primero llama con mode=read para ver columnas y filas de muestra; razona el mapping hacia los campos canónicos; luego llama con mode=propose y ese mapping. NUNCA inventes columnas que no existen. El usuario aplicará la importación desde la UI.
- update_music_track: cuando pidan modificar una canción (agregar link de video, ISRC, fechas). Devuelve una propuesta de cambio que el usuario confirma en la UI.`
    : ""
}

Reglas:
- No inventes datos: si una tool no devuelve resultados, dilo.
- Para listados largos, muestra un resumen y ofrece el Excel.
- Fechas siempre en formato ISO (YYYY-MM-DD) al llamar tools.`;

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
  const provider = (env.AI_PROVIDER || "deepseek").toLowerCase();
  if (provider === "gemini" && geminiModels.length > 0) {
    return { model: gemini(geminiModels[0]), id: geminiModels[0] };
  }
  return { model: deepseek(deepseekModels[0]), id: deepseekModels[0] };
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
      }),
      execute: async ({ asset_id, mode, sheet, mapping, duplicate_strategy }) => {
        if (mode === "read") {
          return api.request("POST", `/internal/workspaces/${body.workspace_id}/music/import/`, {
            asset_id,
            sheet,
            mode: "read",
          });
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
            dry_run: true,
          }
        );
        // Everything the Apply button needs travels in the tool result
        return { ...result, proposal: { asset_id, sheet: sheet ?? null, mapping, duplicate_strategy: duplicate_strategy ?? "skip" } };
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
            matches: results.map((track) => ({ id: track.id, title: track.title, isrc: track.isrc, artists: track.artists })),
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
    system: SYSTEM_PROMPT(caps),
    messages: await convertToModelMessages(body.messages),
    tools,
    stopWhen: stepCountIs(8),
    onError: ({ error }) => {
      console.error(JSON.stringify({ message: "assistant stream error", model: id, error: String(error) }));
    },
  });

  return result.toUIMessageStreamResponse();
}
