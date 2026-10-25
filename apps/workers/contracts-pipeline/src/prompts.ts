/**
 * Extraction prompts (primary, secondary, artists, editorial classification)
 * plus the per-contract NL-query analysis and synthesis.
 * All prompts mention "json" explicitly (DeepSeek JSON-mode requirement).
 *
 * Analysis prompts start with the same prefix (file name + contract text) and
 * put their instructions after it, so the secondary and artists calls read the
 * text from DeepSeek's prefix cache after the primary call.
 */

/** Same system message for every analysis prompt, so the cached prefix covers
 * system message + contract text. */
export const ANALYSIS_SYSTEM =
  "Eres un analista legal de contratos (industria musical y generales). Lees el contrato y respondes solo con un objeto json válido, sin texto adicional.";

/** The shared prefix: byte-identical across the analysis prompts of one text. */
export const contractPrefix = (fileName: string, text: string, part?: { index: number; total: number }) =>
  `ARCHIVO: ${fileName}
${part && part.total > 1 ? `TRAMO ${part.index} DE ${part.total} DEL CONTRATO (el texto sigue en otros tramos).\n` : ""}Las marcas [[p. N]] señalan el inicio de la página N.
=== CONTRATO ===
${text}
=== FIN DEL CONTRATO ===
`;

const withInstructions = (prefix: string, instructions: string) => `${prefix}\n${instructions.trim()}\n`;

const evidenceRules = (keys: readonly string[]) =>
  `"_evidence": objeto json con la evidencia de cada dato que hayas llenado, para estas claves: ${keys.join(", ")}. Cada valor es {"cita": fragmento copiado LITERALMENTE del contrato (máximo 300 caracteres) que respalda el dato, "pagina": número N de la última marca [[p. N]] antes de la cita, o null}. Si una fecha solo indica el año, agrega "aproximada": true. Omite la clave si no hay un fragmento literal que la respalde; nunca inventes citas.`;

export const CONTRACT_TYPE_GUIDE = `uno de estos códigos:
- ARTISTAS: contrato de artista o de exclusividad artística con una disquera o empresa (exclusividad, 360, desarrollo de carrera).
- REPRESENTACION: management o representación artística a cambio de comisión.
- PRODUCCION: producción musical, grabación, masters, contratos de productor.
- EDICION: edición, administración, sub-edición o co-edición de obras (publishing).
- LICENCIA: licencia de uso o sincronización de obras o grabaciones.
- DISTRIBUCION: distribución digital o física de música.
- CESION_DERECHOS: cesión o transmisión de derechos de autor o conexos.
- COLABORACION: featuring, coautoría, split sheets.
- EVENTOS: presentaciones, booking, conciertos, giras.
- PATROCINIO: marcas, patrocinios, endorsements.
- CONFIDENCIALIDAD: acuerdo de confidencialidad (NDA).
- LABORAL: empleo o contratación de personal.
- SERVICIOS: otros servicios profesionales.
- ARRENDAMIENTOS: arrendamiento de inmuebles.
- ALQUILERES: renta de equipo, bienes muebles o espacios.
- VEHICULOS: compraventa o renta de vehículos.
- OTRO: ninguno de los anteriores.
Si el objeto principal encaja claramente en un tipo específico (REPRESENTACION, PRODUCCION, EDICION, LICENCIA, etc.) úsalo; ARTISTAS solo para contratos de artista o de exclusividad.`;

export const primaryPrompt = (prefix: string, evidenceKeys: readonly string[]) =>
  withInstructions(
    prefix,
    `TAREA: extrae la información clave del contrato de arriba y responde en json con exactamente estas claves:
1. "tituloContrato": nombre del contrato.
2. "involucrados": lista con los nombres de todas las partes (array de strings).
3. "nombreGrupo": grupo, banda o colectivo al que pertenece la parte, si se indica.
4. "fechaInicio": inicio de vigencia en formato AAAA-MM-DD; si solo está el año usa AAAA-01-01.
5. "fechaFin": fecha de término AAAA-MM-DD SOLO si el texto da una fecha explícita; si el plazo se expresa como duración, déjala vacía.
6. "duracionMeses": plazo del contrato en meses cuando se expresa como duración (ej. "3 años" -> 36), número entero; null si no se indica.
7. "esPosibleExpandirlo": si el contrato puede extenderse (SI, NO, NO_ESPECIFICADO).
8. "tiempoExtensionPosible": el tiempo de extensión textual (ej. "2 años").
9. "tiempoExtensionMeses": la extensión en meses, número entero (2 años -> 24); null si no aplica.
10. "tipoContrato": ${CONTRACT_TYPE_GUIDE}
11. "periodoColeccion": si existe un período de colección (SI, NO, NO_ESPECIFICADO).
12. "descripcionPeriodoColeccion": cómo funciona el período de colección.
13. "duracionPeriodoColeccion": duración del período de colección.
14. "periodoRetencion": si existe un período de retención (SI, NO, NO_ESPECIFICADO).
15. "descripcionPeriodoRetencion": cómo funciona el período de retención.
16. "duracionPeriodoRetencion": duración del período de retención.
17. "resumenGeneral": SIEMPRE un resumen del contrato en español.
18. ${evidenceRules(evidenceKeys)}
Responde con un único objeto json (no un array).`
  );

/** Shared by the full analysis and the classification-only backfill, so both
 * draw the editorial line in the same place. */
const EDITORIAL_CRITERIA = `true si el objeto principal del contrato es la edición musical: edición, administración, sub-edición o co-edición de obras (composiciones, letras), o la cesión o licencia de derechos de autor sobre obras a una editora o editorial musical (contratos editoriales, de publishing, de administración de catálogo). false en cualquier otro caso, incluidos los contratos de artista, de grabación, de representación o management, de servicios, arrendamientos o vehículos.`;

export const secondaryPrompt = (prefix: string, evidenceKeys: readonly string[]) =>
  withInstructions(
    prefix,
    `TAREA: extrae del contrato de arriba lo siguiente y responde en json con exactamente estas claves:
1. "testigos": lista con los nombres de los testigos, si existen (array de strings).
2. "clausulaRenovacion": la cláusula de renovación citada textualmente, si existe.
3. "esNotariado": true si el contrato se otorgó ante notario o fedatario público; false si no (true o false).
4. "esEditorial": ${EDITORIAL_CRITERIA}
5. ${evidenceRules(evidenceKeys)}
Responde con un único objeto json (no un array).`
  );

export const artistsPrompt = (prefix: string, existingTags: readonly string[], evidenceKeys: readonly string[]) =>
  withInstructions(
    prefix,
    `TAREA: extrae los artistas del contrato de arriba y responde en json con las claves "artistas" (array de strings) y "_evidence".
El nombre de los artistas se identifica porque se les denomina como EL ARTISTA.
FORMATO de cada artista: "Nombre Artístico - Nombre Real" cuando el contrato mencione ambos (p. ej. "Andrew - Andrés Felipe Arroyave Benjumea"); si solo se conoce uno de los dos, devuelve únicamente ese, sin guion.
${
  existingTags.length > 0
    ? `ETIQUETAS DE ARTISTAS YA EXISTENTES EN EL SISTEMA (las que aparecen en este texto):
${existingTags.map((tag) => `- ${tag}`).join("\n")}
REGLA IMPORTANTE: si un artista del contrato corresponde a una etiqueta existente — aunque el nombre esté escrito distinto (mayúsculas, con o sin segundos nombres/apellidos, alias o nombre artístico) — devuelve EXACTAMENTE el texto de la etiqueta existente en lugar de una variante nueva. Solo devuelve un nombre nuevo cuando el artista no corresponda a ninguna etiqueta existente.
`
    : ""
}${evidenceRules(evidenceKeys)}
Responde con un único objeto json (no un array).`
  );

/** The opening of a contract names its parties and its object — enough to tell
 * an editorial deal apart, at a fraction of the full text's tokens. */
const CLASSIFY_TEXT_CHARS = 12_000;

export const classificationPrompt = (fileName: string, extractedText: string) =>
  withInstructions(
    contractPrefix(fileName, extractedText.slice(0, CLASSIFY_TEXT_CHARS)),
    `TAREA: lo de arriba es solo el inicio del contrato. Clasifícalo y responde en json con la clave "esEditorial".
"esEditorial": ${EDITORIAL_CRITERIA}`
  );

export const QUERY_ANALYSIS_KEYS = [
  "coincide",
  "confianza",
  "razon",
  "fechaInicio",
  "fechaFin",
  "fechaFinFinal",
  "artistas",
];

export const queryAnalysisPrompt = (
  fileName: string,
  extractedText: string,
  userQuery: string,
  currentDateIso: string,
  currentYear: number
) => `
Eres un analista legal. Analiza si este contrato coincide con la petición del usuario y responde en json.
PETICIÓN: "${userQuery}"
Fecha actual: ${currentDateIso} (año en curso: ${currentYear})
Archivo: ${fileName}
Claves de la respuesta:
1. "coincide": true/false — si el contrato coincide con la petición. Considera cláusulas de extensión automática: un contrato con fin 2025 y extensión automática de 5 años termina efectivamente en 2030.
2. "confianza": número de 0 a 100.
3. "razon": explicación breve en español.
4. "fechaInicio" y "fechaFin": AAAA-MM-DD si se conocen.
5. "fechaFinFinal": fecha de finalización EFECTIVA considerando extensiones, AAAA-MM-DD.
6. "artistas": array de strings con los artistas del contrato.
Este es el contrato:
${extractedText}
`;

export const SYNTHESIS_KEYS = ["resumen", "contractIdsSeleccionados"];

export const synthesisPrompt = (
  userQuery: string,
  currentDateIso: string,
  currentYear: number,
  candidateList: unknown
) => `
Eres un analista legal. Recibiste el resultado del análisis individual de varios contratos frente a esta petición del usuario:
PETICIÓN: "${userQuery}"
Fecha actual: ${currentDateIso} (año en curso: ${currentYear})
A continuación están los contratos candidatos (ya pre-filtrados como posibles coincidencias):
${JSON.stringify(candidateList, null, 2)}
Tu tarea (responde en json):
1. Revisa la coherencia de cada candidato con la petición y descarta los que claramente NO deberían incluirse (falsos positivos).
2. "contractIdsSeleccionados": array con los ids (strings) de los contratos que SÍ coinciden.
3. "resumen": resumen ejecutivo en español del resultado global (cuántos coinciden, criterios usados, observaciones sobre extensiones o vencimientos).
`;
