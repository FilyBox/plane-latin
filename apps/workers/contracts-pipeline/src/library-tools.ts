/**
 * The file library put in order: read a folder, find duplicates, and propose
 * renames, moves, new folders, categories, tags and trash in one card that
 * applies on confirm and is undone as a whole. Django checks every operation
 * first; analysed contracts, expense receipts and template files never go
 * to the trash from here.
 */

import type { ToolSet } from "ai";
import { tool } from "ai";
import { z } from "zod";

import type { AssistantChatRequest } from "./assistant";
import type { internalApi } from "./lib/internal-api";

type Api = ReturnType<typeof internalApi>;

export const LIBRARY_PROMPT = `
ORDENAR LA BIBLIOTECA
- "¿Qué hay en Contratos/2024?": list_folder con la ruta (o folder_id) y recursive si pide todo lo de adentro.
- "Busca duplicados": find_duplicate_files (en una carpeta o en toda la biblioteca). Exactos = mismo contenido; posibles = mismo nombre y tamaño. Se conserva la copia con más vínculos (contrato, etiquetas, referencias, gasto) o la más antigua; las demás se proponen a la papelera.
- "Ordena / renombra / mueve / pon en carpetas por artista y año": propose_file_organization con las operaciones (rename, move a una ruta como "Contratos/2024/Juan Pérez", create_folder, categorize, tag, trash). Nombres desde el contenido con un patrón constante: "Contrato de edición – Juan Pérez – 2024.pdf" (usa get_contract_details o read_file para saber de qué trata cada archivo). Renombrar cambia solo el nombre visible.
- Poner un PDF en la categoría "Contratos" inicia su análisis con IA (tiene costo): dilo. La papelera nunca toma contratos analizados, comprobantes de gastos ni archivos de plantillas; si te lo piden, explica que eso se hace en su panel.
- Nunca digas que ya quedó hecho: la persona revisa y aplica en la tarjeta, y puede deshacer todo.`;

const folderInput = {
  folder_id: z.string().optional(),
  path: z.string().max(500).optional().describe('Ruta como "Contratos/2024"; vacío = raíz'),
};

const organizeOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("rename"), file_id: z.string(), name: z.string().min(1).max(255) }),
  z.object({
    op: z.literal("move"),
    file_id: z.string(),
    folder_id: z.string().optional(),
    path: z.string().max(500).optional().describe("Ruta destino; se crea si no existe; vacía = raíz"),
  }),
  z.object({ op: z.literal("create_folder"), path: z.string().min(1).max(500) }),
  z.object({
    op: z.literal("categorize"),
    file_id: z.string(),
    category: z.string().max(255).describe("Nombre o id de la categoría"),
    remove: z.boolean().optional(),
  }),
  z.object({
    op: z.literal("tag"),
    file_id: z.string(),
    tag: z.string().max(255).describe("Nombre o id; si no existe se crea"),
    remove: z.boolean().optional(),
  }),
  z.object({ op: z.literal("trash"), file_id: z.string() }),
]);

export function buildLibraryTools(api: Api, body: AssistantChatRequest): ToolSet {
  const userId = body.user_id ?? "";
  const base = `/internal/workspaces/${body.workspace_id}/assistant/files/`;
  return {
    list_folder: tool({
      description:
        "Archivos y subcarpetas de una carpeta de la biblioteca (por ruta o id), con su contrato, etiquetas, categorías y tamaño. recursive incluye lo de las subcarpetas. Hasta 500 archivos.",
      inputSchema: z.object({ ...folderInput, recursive: z.boolean().optional() }),
      execute: async (input) => api.request("POST", `${base}folder/`, { user_id: userId, ...input }),
    }),
    find_duplicate_files: tool({
      description:
        "Duplicados en la biblioteca (o en una carpeta): exactos por contenido y posibles por mismo nombre y tamaño. Marca cuál conservar (más vínculos o la más antigua) y cuáles están protegidos para la papelera.",
      inputSchema: z.object(folderInput),
      execute: async (input) => api.request("POST", `${base}duplicates/`, { user_id: userId, ...input }),
    }),
    propose_file_organization: tool({
      description:
        "Propone ordenar archivos de la biblioteca (hasta 200 operaciones): rename, move, create_folder, categorize, tag, trash. Django revisa cada una; la tarjeta las agrupa por tipo, pide confirmar aparte la papelera y se puede deshacer completa.",
      inputSchema: z.object({
        ops: z.array(organizeOp).min(1).max(200),
        summary: z.string().max(300),
      }),
      execute: async (input) => {
        const run = await api.request<Record<string, unknown> & { error?: string }>("POST", `${base}organize-plan/`, {
          user_id: userId,
          ops: input.ops,
        });
        if (run.error) return { error: run.error };
        return { ...run, input_ops: input.ops, summary: input.summary, workspace_slug: body.workspace_slug };
      },
    }),
  };
}
