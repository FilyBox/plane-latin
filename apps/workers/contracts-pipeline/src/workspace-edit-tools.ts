/**
 * Edits to what already exists in the workspace: corrections to a contract's
 * extracted data, work items (read with filters, change in bulk, comment).
 *
 * Django checks every change before the card (validation, names resolved to
 * ids, ambiguous names come back with choices) and applies it on the same
 * path as a hand edit when the person confirms. Each card can be undone.
 */

import type { ToolSet } from "ai";
import { tool } from "ai";
import { z } from "zod";

import type { AssistantChatRequest } from "./assistant";
import type { internalApi } from "./lib/internal-api";

type Api = ReturnType<typeof internalApi>;

export const WORKSPACE_EDIT_PROMPT = (contracts: boolean) => `
${
  contracts
    ? `CORREGIR DATOS DE CONTRATOS
- "La fecha de inicio es 1 de marzo", "estos 5 son de edición", "el artista es X": propose_contract_edit con el contract_id real, solo los campos que cambian (fechas en ISO, artistas e involucrados como texto separado por comas), el motivo y, si sale del contrato, la cita textual (quote) y su página. Hasta 50 contratos por tarjeta.
- Campos: titulo, resumen_general, nombre_grupo, artistas, testigos, involucrados, es_notariado, fecha_inicio, fecha_fin, fecha_fin_efectiva, estatus_contrato, tipo_contrato, es_editorial, periodo_coleccion, periodo_retencion y sus descripciones y duraciones. Cambiar fecha_fin mueve también el fin efectivo (conserva la extensión).
- Si devuelve errores de validación, corrige el valor y vuelve a proponer.
`
    : ""
}EDITAR TAREAS
- "Las tareas de Ana en Lanzamientos", "lo que vence esta semana": query_work_items con filtros (project, assignee, state_group, labels, due_before/after, text). Responde con lo encontrado y menciona cada tarea.
- "Pasa estas 5 a Hecho", "asígnale a Ana", "ponle la etiqueta renovación", "muévelas al ciclo de mayo": propose_work_item_update con los issue_id (o claves LAN-12) y en set los nombres tal como los dijo (estado, persona, etiqueta, ciclo, módulo); Django los resuelve y la tarjeta pide elegir si un nombre es ambiguo. Para añadir texto a la descripción usa append_description; reescribir la descripción completa solo si lo pidió explícitamente (rewrite_description: true).
- "Comenta en LAN-12 que…": propose_work_item_comment con el Markdown (menciones :tipo[Nombre]{name=id} y personas con @).
- Nunca digas que ya quedó hecho: la persona revisa y aplica en la tarjeta, y puede deshacer.`;

const workItemSet = z.object({
  name: z.string().max(255).optional(),
  state: z.string().max(100).optional().describe('Nombre del estado ("Hecho") o grupo ("completed")'),
  priority: z.enum(["urgent", "high", "medium", "low", "none"]).optional(),
  start_date: z.string().nullable().optional().describe("YYYY-MM-DD; null la quita"),
  target_date: z.string().nullable().optional().describe("YYYY-MM-DD; null la quita"),
  assignees_add: z.array(z.string().max(255)).max(10).optional(),
  assignees_remove: z.array(z.string().max(255)).max(10).optional(),
  labels_add: z.array(z.string().max(255)).max(10).optional(),
  labels_remove: z.array(z.string().max(255)).max(10).optional(),
  cycle: z.string().max(255).nullable().optional().describe("Nombre del ciclo; null la saca del ciclo"),
  modules_add: z.array(z.string().max(255)).max(5).optional(),
  parent: z.string().max(255).nullable().optional().describe("Clave de la tarea padre (LAN-3); null la quita"),
  append_description: z.string().max(10_000).optional().describe("Markdown que se agrega al final"),
  description: z.string().max(50_000).optional(),
  rewrite_description: z.boolean().optional().describe("true solo si pidió reescribir toda la descripción"),
});

export function buildWorkspaceEditTools(api: Api, body: AssistantChatRequest, contracts: boolean): ToolSet {
  const workspace = body.workspace_id;
  const slug = body.workspace_slug;
  const userId = body.user_id ?? "";
  const base = `/internal/workspaces/${workspace}/assistant/`;
  const tools: ToolSet = {};

  if (contracts) {
    tools.propose_contract_edit = tool({
      description:
        "Propone corregir datos extraídos de uno o varios contratos (hasta 50). Django valida y devuelve campo / antes / después por contrato; la tarjeta deja elegir cambios, ver la cita en el PDF y aplicar. Queda marcado como corregido a mano y se puede deshacer.",
      inputSchema: z.object({
        items: z
          .array(
            z.object({
              contract_id: z.string(),
              changes: z.record(z.string(), z.union([z.string(), z.boolean(), z.null()])),
              reason: z.string().max(500).describe("Por qué cambia, en una frase"),
              quote: z.string().max(500).optional().describe("Texto del contrato que lo respalda"),
              page: z.number().int().min(1).optional(),
            })
          )
          .min(1)
          .max(50),
        summary: z.string().max(300),
      }),
      execute: async (input) => {
        const run = await api.request<Record<string, unknown> & { error?: string }>(
          "POST",
          `${base}contracts/edit-preview/`,
          { user_id: userId, items: input.items }
        );
        if (run.error) return { error: run.error };
        return { ...run, summary: input.summary, workspace_slug: slug };
      },
    });
  }

  tools.query_work_items = tool({
    description:
      "Busca tareas con filtros (proyecto, responsable, grupo de estado, etiquetas, vencimiento, texto), con la visibilidad de quien pregunta. Hasta 100.",
    inputSchema: z.object({
      project: z.string().max(255).optional().describe("Nombre o identificador"),
      assignee: z.string().max(255).optional().describe('Nombre, correo o "me"'),
      state_group: z.array(z.enum(["backlog", "unstarted", "started", "completed", "cancelled", "triage"])).optional(),
      state: z.string().max(100).optional(),
      labels: z.array(z.string().max(255)).max(5).optional(),
      priority: z.enum(["urgent", "high", "medium", "low", "none"]).optional(),
      due_before: z.string().optional().describe("YYYY-MM-DD"),
      due_after: z.string().optional().describe("YYYY-MM-DD"),
      text: z.string().max(200).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    execute: async (input) => api.request("POST", `${base}work-items/query/`, { user_id: userId, ...input }),
  });

  tools.propose_work_item_update = tool({
    description:
      "Propone cambiar una o varias tareas (hasta 100): estado, prioridad, fechas, título, responsables, etiquetas, ciclo, módulo, tarea padre o agregar texto a la descripción. Los nombres se resuelven en Django; la tarjeta muestra tarea / campo / antes / después con casilla por fila y pide elegir si un nombre es ambiguo. Se puede deshacer.",
    inputSchema: z.object({
      items: z
        .array(z.object({ issue_id: z.string().describe("id o clave (LAN-12)"), set: workItemSet }))
        .min(1)
        .max(100),
      summary: z.string().max(300),
    }),
    execute: async (input) => {
      const run = await api.request<Record<string, unknown> & { error?: string; items?: unknown[] }>(
        "POST",
        `${base}work-items/update-preview/`,
        { user_id: userId, items: input.items }
      );
      if (run.error) return { error: run.error };
      if (!run.items?.length) return { ...run, error: "Nada que cambiar: revisa los problemas y vuelve a proponer." };
      return { ...run, summary: input.summary, workspace_slug: slug };
    },
  });

  tools.propose_work_item_comment = tool({
    description:
      "Propone un comentario en una tarea, en Markdown (menciones de elementos y personas). La tarjeta lo muestra como quedará; se publica al confirmar y se puede deshacer si nadie lo editó.",
    inputSchema: z.object({
      issue_id: z.string().describe("id o clave (LAN-12)"),
      markdown: z.string().min(1).max(20_000),
    }),
    execute: async (input) => {
      const run = await api.request<Record<string, unknown> & { error?: string }>(
        "POST",
        `${base}work-items/comment-preview/`,
        { user_id: userId, ...input }
      );
      if (run.error) return { error: run.error };
      return { ...run, workspace_slug: slug };
    },
  });

  return tools;
}
