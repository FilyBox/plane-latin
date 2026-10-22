/**
 * Prompts for the AI mapping of a workspace into shared tags.
 *
 * One agent per kind of item (contracts, files, work items, expenses) says,
 * for each item, what it is (from a closed list) and whose it is (artist or
 * group). A second pass folds spelling variants of the same name together.
 */

export type TaggingItem = { id: string; title: string; text: string; tags: string[] };

export const CLASSIFY_KEYS = ["items"] as const;
export const NORMALIZE_KEYS = ["grupos"] as const;

const KIND_LABEL: Record<string, string> = {
  contract: "contratos",
  file: "archivos de una biblioteca (portadas, audios, documentos…)",
  issue: "tareas de proyectos",
  expense: "gastos de la empresa",
};

export const classifyPrompt = (
  entityType: string,
  vocabulary: string[],
  knownNames: string[],
  items: TaggingItem[]
) => `
Eres el archivista de una disquera y editora musical. Vas a clasificar ${KIND_LABEL[entityType] ?? entityType}.
Para cada elemento responde:
- "id": el mismo id que recibiste.
- "tipo": ${
  vocabulary.length > 0
    ? `exactamente uno de ${JSON.stringify(vocabulary)}, o null si ninguno aplica con claridad.`
    : "siempre null."
}
- "artistas": artistas, grupos o bandas musicales a los que pertenece el elemento o de los que trata. Usa solo nombres que aparezcan en el título o el texto del elemento; nunca inventes. Si un nombre coincide con uno de los conocidos, aunque cambien mayúsculas, acentos, abreviaturas o "Los" al inicio, devuelve el nombre conocido tal cual. Personas que no son artistas (abogados, testigos, empresas, proveedores) no van aquí. Array vacío si no hay.
- "confianza": número de 0 a 1 sobre tu clasificación.
- "razon": máximo 12 palabras, en español.

Nombres conocidos: ${JSON.stringify(knownNames)}

Elementos: ${JSON.stringify(items)}

Responde en json: {"items": [{"id": "...", "tipo": null, "artistas": [], "confianza": 0.0, "razon": "..."}]}
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
