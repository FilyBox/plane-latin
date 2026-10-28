/**
 * The music catalog checked and corrected: audit_catalog computes the
 * checks in Django (deterministic, with counts, examples and ids), and
 * propose_catalog_fixes turns sourced corrections into a card that applies
 * on confirm and can be undone. Admins with the catalog only.
 */

import type { ToolSet } from "ai";
import { tool } from "ai";
import { z } from "zod";

import type { AssistantChatRequest } from "./assistant";
import type { internalApi } from "./lib/internal-api";

type Api = ReturnType<typeof internalApi>;

export const CATALOG_AUDIT_PROMPT = `
AUDITORÍA DEL CATÁLOGO
- "Revisa el catálogo / qué le falta a X / qué canciones no tienen contrato": audit_catalog (todas las revisiones o las que pida; artist o release para acotar). Resume por revisión con el conteo y ejemplos mencionados; si pide un reporte, haz una página (propose_page) con tablas.
- Revisiones: uncovered_tracks (sin contrato o solo vencidos), editorial_without_works, codes (ISRC faltante, inválido o repetido; UPC faltante o con dígito verificador mal), credits (porcentajes editoriales que no suman 100, >100, sin artista principal o sin autor), track_shares (artista+sello+distribuidora+agregadora >100), contract_artist_mismatch, tags (artistas sin etiqueta, etiquetas sin artista), gaps (lanzamientos sin canciones, canciones sin lanzamiento, fecha o portada).
- Correcciones: ligar contratos con propose_work_links; ligar etiquetas con link_artist_tags; corregir datos con propose_catalog_fixes SOLO con valores que tienen origen (texto del contrato, otra canción con el mismo ISRC, lo que dijo el usuario) en source y source_type. Nunca inventes un valor. Un ISRC que falta se reporta, no se llena, salvo que el usuario dé el código (source_type "user"). Lo que requiere trabajo humano: una tarea por hallazgo o por artista (propose_work_item).`;

const fixItem = z.object({
  entity: z.enum(["music_track", "music_release", "music_credit"]),
  id: z.string(),
  changes: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .default({})
    .describe(
      "Campo: valor. Canción: title, version, isrc, release_date, original_release_date, recording_date, language, explicit, p_line, c_line, *_percentage. Lanzamiento: upc, release_date, label_name, catalog_number, copyright_year… Crédito: percentage, publishing_share"
    ),
  add_video: z
    .object({ video_url: z.string().max(1000), release_date: z.string().optional(), isrc: z.string().optional() })
    .optional()
    .describe("Solo canción: agrega un video musical"),
  source: z
    .string()
    .min(3)
    .max(300)
    .describe('De dónde sale: "Contrato X, cláusula 3", "canción Y con el mismo ISRC", "lo dijo el usuario"'),
  source_type: z.enum(["contract", "catalog", "user"]),
});

export function buildCatalogTools(api: Api, body: AssistantChatRequest): ToolSet {
  const userId = body.user_id ?? "";
  const base = `/internal/workspaces/${body.workspace_id}/assistant/catalog/`;
  return {
    audit_catalog: tool({
      description:
        "Revisa el catálogo musical con reglas fijas y devuelve, por revisión, el conteo, hasta 50 ejemplos (con path) y los ids. Acota con artist (nombre o id) o release.",
      inputSchema: z.object({
        checks: z
          .array(
            z.enum([
              "uncovered_tracks",
              "editorial_without_works",
              "codes",
              "credits",
              "track_shares",
              "contract_artist_mismatch",
              "tags",
              "gaps",
            ])
          )
          .optional(),
        artist: z.string().max(255).optional(),
        release: z.string().max(255).optional(),
      }),
      execute: async (input) => api.request("POST", `${base}audit/`, { user_id: userId, ...input }),
    }),
    propose_catalog_fixes: tool({
      description:
        "Propone correcciones de datos del catálogo (canciones, lanzamientos, créditos), cada una con su origen. Django valida (ISRC, UPC, porcentajes, fechas) y devuelve antes/después; la tarjeta aplica al confirmar y se puede deshacer.",
      inputSchema: z.object({ items: z.array(fixItem).min(1).max(200), summary: z.string().max(300) }),
      execute: async (input) => {
        const run = await api.request<Record<string, unknown> & { error?: string }>("POST", `${base}fixes-preview/`, {
          user_id: userId,
          items: input.items,
        });
        if (run.error) return { error: run.error };
        return { ...run, input_items: input.items, summary: input.summary, workspace_slug: body.workspace_slug };
      },
    }),
  };
}
