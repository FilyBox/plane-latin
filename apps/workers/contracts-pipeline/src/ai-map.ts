/**
 * AI column mapping for the manual music import panel. Receives per-column
 * samples (collected over the WHOLE file, so late-populated columns are
 * classifiable), what the user already mapped (and which fields they set by
 * hand), and returns per field the column(s) with a confidence and a short
 * reason. Pure suggestion: Django validates it again and the user reviews
 * every change before it is applied.
 */

import { generateText } from "./lib/ai";
import { buildAiMapQuery, normalizeAiMapping, type AiMapRequest, type AiMapSuggestion } from "./lib/ai-map-result";
import { parseJsonResponse } from "./lib/json-repair";

export type { AiMapRequest };

const SYSTEM = `Eres un experto en catálogos musicales. Mapeas columnas de un spreadsheet a campos canónicos.
Recibes: columns (muestras por columna), canonical_fields con field_descriptions (qué guarda cada campo), multi_fields, current_mapping (lo que ya está asignado), locked_fields (campos que el usuario eligió a mano) y constants (campos con un valor fijo).
Reglas:
- Decide por el CONTENIDO (examples), no solo por el nombre de la columna: URLs de YouTube -> track.video_url; URLs de Spotify/Apple Music -> track.streaming_url; códigos tipo "USRC17607839" -> track.isrc; fechas por su formato; duraciones tipo "3:16" -> track.duration_ms.
- Primero llena los campos VACÍOS (sin columna en current_mapping) con columnas que aún no se usan.
- Un campo que ya tiene columna solo cámbialo si tu propuesta es CLARAMENTE mejor; si coincide, repítelo igual.
- NUNCA cambies un campo de locked_fields salvo que sea un error evidente (p. ej. una columna de URLs en un campo de fecha); en ese caso proponlo con confidence baja-media y explica el error en reason.
- En multi_fields el valor es una lista de columnas; por defecto se AGREGAN a las que ya hay. Usa "replace": true solo si las columnas actuales están mal.
- El resto de campos acepta UNA sola columna.
- Solo usa campos de canonical_fields y columnas que existan. Omite columnas basura o sin datos (non_empty = 0). No inventes mapeos dudosos.
- confidence: número de 0 a 1. reason: una frase corta (máximo 15 palabras) en el idioma indicado en locale.
Responde ÚNICAMENTE con un objeto json: { "mapping": { campo: { "columns": [columnas], "confidence": 0.0-1.0, "reason": "...", "replace": false } } }.`;

export async function handleMusicAiMap(
  env: Env,
  body: AiMapRequest
): Promise<{
  mapping: Record<string, string | string[]>;
  suggestions: Record<string, AiMapSuggestion>;
  model: string;
}> {
  const { text, model } = await generateText(env, SYSTEM, [], buildAiMapQuery(body));
  const parsed = parseJsonResponse<{ mapping?: unknown }>(text);
  const { mapping, suggestions } = normalizeAiMapping(parsed?.mapping, {
    headers: Object.keys(body.columns),
    fields: body.canonical_fields,
    multi: body.multi_fields ?? [],
    locked: body.locked_fields ?? [],
  });
  return { mapping, suggestions, model };
}
