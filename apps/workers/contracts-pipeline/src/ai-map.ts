/**
 * AI column mapping for the manual music import panel. Receives per-column
 * samples (collected over the WHOLE file, so late-populated columns are
 * classifiable) and returns canonical_field -> column(s). Pure suggestion:
 * Django validates the result against the real headers before using it.
 */

import { generateText } from "./lib/ai";
import { parseJsonResponse } from "./lib/json-repair";

export type AiMapRequest = {
  columns: Record<string, { non_empty: number; total: number; examples: string[] }>;
  canonical_fields: string[];
  multi_fields: string[];
  locale?: string | null;
};

const SYSTEM = `Eres un experto en catálogos musicales. Mapeas columnas de un spreadsheet a campos canónicos.
Reglas:
- Decide por el CONTENIDO (examples), no solo por el nombre de la columna: URLs de YouTube -> track.video_url; URLs de Spotify/Apple Music -> track.streaming_url; códigos tipo "USRC17607839" -> track.isrc; fechas por su formato; duraciones tipo "3:16" -> track.duration_ms.
- Puede haber VARIAS columnas para el mismo campo multi-valor (varias columnas de links, de writers/autores, de artistas): en esos campos el valor es un ARRAY de columnas. Los campos multi-valor permitidos vienen en la lista multi_fields; el resto acepta UNA sola columna (string).
- Solo usa campos de canonical_fields y columnas que existan. Omite columnas basura o sin datos (non_empty = 0).
- No inventes mapeos dudosos: si una columna no encaja claramente en ningún campo, no la mapees.
Responde ÚNICAMENTE con un objeto json: { "mapping": { campo: columna | [columnas] } }.`;

export async function handleMusicAiMap(env: Env, body: AiMapRequest): Promise<{ mapping: Record<string, string | string[]>; model: string }> {
  const query = JSON.stringify({
    canonical_fields: body.canonical_fields,
    multi_fields: body.multi_fields,
    columns: body.columns,
  });
  const { text, model } = await generateText(env, SYSTEM, [], query);
  const parsed = parseJsonResponse<{ mapping?: Record<string, unknown> }>(text);
  const raw = parsed?.mapping && typeof parsed.mapping === "object" ? parsed.mapping : {};

  const headers = new Set(Object.keys(body.columns));
  const fields = new Set(body.canonical_fields);
  const multi = new Set(body.multi_fields);
  const mapping: Record<string, string | string[]> = {};
  for (const [field, value] of Object.entries(raw)) {
    if (!fields.has(field)) continue;
    const columns = (Array.isArray(value) ? value : [value]).filter(
      (column): column is string => typeof column === "string" && headers.has(column)
    );
    if (columns.length === 0) continue;
    mapping[field] = multi.has(field) ? columns : columns[0];
  }
  return { mapping, model };
}
