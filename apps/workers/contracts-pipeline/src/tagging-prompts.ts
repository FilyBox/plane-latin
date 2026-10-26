/**
 * Prompts for the AI mapping of a workspace into shared tags.
 *
 * One agent per kind of item (contracts, files, work items, expenses and,
 * when chosen, songs and releases) says, for each item, what it is (from a
 * closed list), whose it is (artist or group) and which existing workspace
 * tags (projects, campaigns, catalogs…) it clearly belongs to. A second pass
 * folds spelling variants of the same name together.
 */

export type TaggingItem = { id: string; title: string; text: string; tags: string[] };

export const CLASSIFY_KEYS = ["items"] as const;
export const NORMALIZE_KEYS = ["grupos"] as const;

const KIND_LABEL: Record<string, string> = {
  contract: "contratos",
  file: "archivos de una biblioteca (portadas, audios, documentos…)",
  issue: "tareas de proyectos",
  expense: "gastos de la empresa",
  music_track:
    "canciones y videos del catálogo musical (cada línea trae título y versión, artistas con su rol, otros créditos, lanzamientos, géneros, ISRC, sello y empresas, idioma, catálogo y notas)",
  music_release:
    "lanzamientos del catálogo musical: álbumes, EPs y sencillos (cada línea trae título, tipo, artistas, sello y empresas, año y la lista de canciones)",
};

const MUSIC_ARTISTS = `
En canciones y lanzamientos, "artistas" son solo quienes interpretan: los marcados como Primary Artist, Featured Artist, Performer o un instrumento/voz, y los artistas del lanzamiento. Nunca compositores, autores, productores, ingenieros, editoras, sellos ni distribuidoras. Una colaboración son varios artistas: devuélvelos por separado.`;

const isMusic = (entityType: string) => entityType === "music_track" || entityType === "music_release";

/** `topics`: existing tags (projects, campaigns, catalogs…) the model may
 * pick from; with none, the prompt is the same as before they existed. */
export const classifyPrompt = (
  entityType: string,
  vocabulary: string[],
  knownNames: string[],
  items: TaggingItem[],
  topics: string[] = []
) => `
Eres el archivista de una disquera y editora musical. Vas a clasificar ${KIND_LABEL[entityType] ?? entityType}.${
  isMusic(entityType) ? MUSIC_ARTISTS : ""
}
Para cada elemento responde:
- "id": el mismo id que recibiste.
- "tipo": ${
  vocabulary.length > 0
    ? `exactamente uno de ${JSON.stringify(vocabulary)}, o null si ninguno aplica con claridad.`
    : "siempre null."
}
- "artistas": artistas, grupos o bandas musicales a los que pertenece el elemento o de los que trata. Usa solo nombres que aparezcan en el título o el texto del elemento; nunca inventes. Si un nombre coincide con uno de los conocidos, aunque cambien mayúsculas, acentos, abreviaturas o "Los" al inicio, devuelve el nombre conocido tal cual. Personas que no son artistas (abogados, testigos, empresas, proveedores) no van aquí. Array vacío si no hay.
${
  topics.length > 0
    ? `- "etiquetas": etiquetas que ya existen en el workspace (proyectos, campañas, catálogos, sellos…) a las que el elemento claramente pertenece. Solo de esta lista, escritas tal cual: ${JSON.stringify(topics)}. Elige una solo si el elemento la respalda: su nombre aparece en el título o el texto (catálogo, lanzamiento, sello, notas, carpeta, proyecto) o es sin duda el tema del elemento. Un parecido vago no basta; nunca inventes. Array vacío si ninguna.
`
    : ""
}- "confianza": número de 0 a 1 sobre tu clasificación.
- "razon": máximo 12 palabras, en español.

Nombres conocidos: ${JSON.stringify(knownNames)}

Elementos: ${JSON.stringify(items)}

Responde en json: {"items": [{"id": "...", "tipo": null, "artistas": [], ${topics.length > 0 ? '"etiquetas": [], ' : ""}"confianza": 0.0, "razon": "..."}]}
`;

export const normalizePrompt = (names: string[], catalog: string[]) => `
Estos son nombres de artistas y grupos musicales encontrados en distintos lugares. Agrupa los que se refieren al mismo artista o grupo: variantes de escritura, acentos, errores de dedo, "Los X" frente a "X", abreviaturas.
No agrupes artistas distintos aunque se parezcan (por ejemplo, dos bandas diferentes de la misma ciudad). Ante la duda, no agrupes.
Una colaboración (varios artistas unidos por "/", "-", "&", "feat", "ft", " x " o " y ") no es una variante de ninguno de ellos: nunca la agrupes con un artista individual.
Para cada grupo de dos o más nombres elige "canonico": el que aparezca en el catálogo; si ninguno aparece, el más completo y mejor escrito.
Incluye solo grupos con dos o más nombres.

Nombres: ${JSON.stringify(names)}

Catálogo: ${JSON.stringify(catalog)}

Responde en json: {"grupos": [{"canonico": "...", "variantes": ["...", "..."]}]}
`;
