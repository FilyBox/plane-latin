/**
 * Contract templates for the assistant: list them, read a variant's Word as
 * numbered paragraphs, and propose text edits (a name becomes {{Variable}},
 * a figure changes, a clause or a signature line is added).
 *
 * The Worker never sees the .docx. Django applies the operations to the
 * bytes and checks that nothing but that text changed (dry run before the
 * card, again on apply). Saving makes a NEW variant unless the person asked
 * to change a given one; the base is never written.
 */

import type { ToolSet } from "ai";
import { tool } from "ai";
import { z } from "zod";

import type { AssistantChatRequest } from "./assistant";
import type { internalApi } from "./lib/internal-api";

type Api = ReturnType<typeof internalApi>;

/** What the assistant must know about the {{ }} format (also in the prompt). */
export const TEMPLATE_FORMAT_PROMPT = `
PLANTILLAS DE CONTRATO (Word con marcadores {{Clave}})
- {{NombreArtista}}, {{Regalias}}, {{Territorio}}…: variable de texto; se llena al usar la plantilla. Empieza con "Fecha" → fecha en largo ("25 de octubre de 2026"); empieza con "Numero" → número es-MX.
- {{NombreFirmante2}}, {{CorreoFirmante2}}: nombre y correo del firmante 2 (se capturan al enviar).
- {{FirmaFirmante2}}, {{InicialesFirmante2}}, {{FechaFirmaFirmante2}}: campo de firma del firmante 2; el campo de Documenso queda EXACTAMENTE donde está el marcador. También {{CampoNombreFirmanteN}}, {{CampoCorreoFirmanteN}}, {{CampoFechaFirmanteN}}, {{TextoFirmanteN}}, {{NumeroFirmanteN}}, {{CasillaFirmanteN}}, {{RadioFirmanteN}}, {{ListaFirmanteN}}. Escribe siempre el número (nunca {{Firma}} solo).
- La clave va SIN espacios (letras con acentos, números, _ . -), en CamelCase en español: NombreArtista, PorcentajeRegalias. La misma clave repetida es el mismo dato (se pide una vez).
- Firmantes numerados desde 1 sin huecos. Cada {{FirmaFirmanteN}} en su propia línea del bloque de firmas, justo encima de la línea o del nombre de ese firmante, nunca dentro de una oración; {{FechaFirmaFirmanteN}} debajo de la firma.
- Bajo la línea de firma de una persona, su nombre va como {{NombreFirmanteN}} (no como variable), y {{FirmaFirmanteN}} encima de la línea si falta.
- Guardar crea SIEMPRE una variante nueva (save "new_variant") con nombre "<base> – <cambio en pocas palabras>" ("Principal – artista como variable"). Solo si el usuario pide explícitamente cambiar una variante ("cambia la variante Principal", "guárdalo en la variante X") usa save "this_variant": se crea una versión nueva y las anteriores no cambian.
- Flujo: find_contract_templates → read_contract_template (párrafos numerados) → propose_template_edit. Para reemplazar un nombre usa match "loose" (encuentra MAYÚSCULAS, sin acentos y en encabezados). Las menciones parciales ("el Sr. Pérez") ponlas en una operación aparte con default_off: true, para que la persona decida. Si propose_template_edit devuelve un error con apariciones, corrige el ancla (más texto, occurrence o paragraph) y vuelve a proponer.
- Un ancla vive en UN párrafo y no cruza tabulaciones, saltos, imágenes, campos ni notas. No cambies estilos, márgenes, fuentes, numeración ni tablas: eso se hace en Word.
- Nunca digas que la plantilla ya quedó cambiada: la persona revisa (con vista previa en PDF) y aplica en la tarjeta.

CONTRATO DESDE UNA PLANTILLA
- "Hazme el contrato de edición para Ana López": find_contract_templates → propose_contract_from_template con los valores que ya sabes. Cada valor lleva su origen (source): "lo dijiste en el chat", "etiqueta Ana López", "contrato anterior de Ana (2025)". Busca en el workspace antes de preguntar (etiqueta del artista, catálogo, contratos anteriores); pregunta solo lo indispensable y deja vacío lo que no sepas: la tarjeta lo marca.
- Fechas en ISO (2026-03-01); números sin formato (12500). Firmantes con nombre y correo en el orden de los roles de la variante.
- Llenar variables NO cambia la plantilla. Si piden cambiar el texto solo para este contrato ("quita la exclusividad", "pon 5 años"), pasa esos cambios en document_edits (mismas operaciones que propose_template_edit, después de read_contract_template): se crea una variante nueva y el contrato se hace sobre ella.
- La tarjeta crea un borrador listo para revisar. Tú NUNCA envías a firma: la persona revisa los campos y pulsa "Enviar a firma" en la pantalla de envío.`;

const editSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("replace_text"),
    find: z.string().min(1).max(500),
    replace: z.string().max(2000),
    match: z.enum(["exact", "loose"]).optional(),
    occurrences: z.union([z.literal("all"), z.array(z.number().int().min(0))]).optional(),
    paragraph: z.string().optional().describe('Limita a un párrafo ("document:12")'),
    default_off: z.boolean().optional().describe("true: la tarjeta lo muestra sin marcar (menciones parciales)"),
  }),
  z.object({
    op: z.literal("insert_text"),
    anchor: z.string().min(1).max(500),
    position: z.enum(["before", "after"]).optional(),
    text: z.string().min(1).max(2000),
    match: z.enum(["exact", "loose"]).optional(),
    occurrence: z.number().int().min(0).optional(),
    paragraph: z.string().optional(),
  }),
  z.object({
    op: z.literal("insert_paragraph"),
    anchor: z.string().min(1).max(500),
    position: z.enum(["before", "after"]).optional(),
    text: z.string().min(1).max(5000).describe("Una línea por párrafo nuevo"),
    match: z.enum(["exact", "loose"]).optional(),
    occurrence: z.number().int().min(0).optional(),
    paragraph: z.string().optional(),
  }),
  z.object({
    op: z.literal("delete_paragraph"),
    anchor: z.string().min(1).max(500),
    match: z.enum(["exact", "loose"]).optional(),
    occurrence: z.number().int().min(0).optional(),
    paragraph: z.string().optional(),
    confirm_image: z.boolean().optional(),
  }),
  z.object({
    op: z.literal("rename_token"),
    from: z.string().min(1).max(100),
    to: z.string().min(1).max(100),
  }),
]);

const settingSchema = z.object({
  label: z.string().max(255).optional(),
  type: z.enum(["text", "date", "number", "currency", "choice"]).optional(),
  required: z.boolean().optional(),
  default: z.string().max(500).optional(),
  help: z.string().max(500).optional(),
  options: z.array(z.string().max(255)).max(50).optional(),
});

type Outline = {
  base: Record<string, unknown>;
  paragraphs: { id: string; location: string; number?: string; text: string; tokens?: string[]; has_image?: boolean }[];
  schema: Record<string, unknown>;
  variable_settings: Record<string, unknown>;
  recipient_roles: Record<string, string>;
  warnings: unknown[];
  track_changes?: boolean;
  can_edit?: boolean;
  manual_fields?: number;
  error?: string;
};

export function buildTemplateTools(api: Api, body: AssistantChatRequest): ToolSet {
  const workspace = body.workspace_id;
  const slug = body.workspace_slug;
  const userId = body.user_id ?? "";
  const base = `/internal/workspaces/${workspace}/assistant/contract-templates/`;
  const tools: ToolSet = {};

  tools.find_contract_templates = tool({
    description:
      "Plantillas de contrato del workspace con sus variantes, versiones, variables y firmantes. Úsala para ubicar el variant_id de la plantilla de la que habla el usuario.",
    inputSchema: z.object({ query: z.string().max(200).optional().describe("Parte del nombre") }),
    execute: async ({ query }) =>
      api.request("GET", `${base}?${new URLSearchParams({ user_id: userId, q: query ?? "" })}`),
  });

  tools.read_contract_template = tool({
    description:
      "Lee el Word de una variante (o de una versión) como párrafos numerados: id, lugar (cuerpo, tabla, encabezado, pie, nota, cuadro de texto), número automático de Word, texto y marcadores. Más el esquema (variables y firmantes), las fichas de variables, los roles y los avisos. Úsala antes de proponer cambios.",
    inputSchema: z.object({
      variant_id: z.string(),
      revision: z.number().int().min(1).optional().describe("Una versión concreta; por defecto lo publicado"),
    }),
    execute: async ({ variant_id: variantId, revision }) => {
      const params = new URLSearchParams({ user_id: userId });
      if (revision) params.set("revision", String(revision));
      const outline = await api.request<Outline>("GET", `${base}variants/${variantId}/outline/?${params}`);
      if (outline.error) return outline;
      // One line per paragraph: cheaper to read than JSON
      const lines = outline.paragraphs.map(
        (item) =>
          `[${item.id}${item.location === "body" ? "" : ` ${item.location}`}]${item.number ? ` (${item.number})` : ""} ${item.text}${item.has_image ? " [imagen]" : ""}`
      );
      return {
        base: outline.base,
        paragraphs: lines.join("\n").slice(0, 60_000),
        truncated: lines.join("\n").length > 60_000 || undefined,
        schema: outline.schema,
        variable_settings: outline.variable_settings,
        recipient_roles: outline.recipient_roles,
        warnings: outline.warnings,
        track_changes: outline.track_changes || undefined,
        manual_fields: outline.manual_fields,
        can_edit: outline.can_edit,
      };
    },
  });

  tools.propose_template_edit = tool({
    description:
      'Propone cambios al Word de una plantilla (reemplazar texto, insertar texto o párrafos, borrar un párrafo, renombrar un marcador). Django los prueba sin guardar y devuelve cada aparición con su contexto; la tarjeta deja elegir apariciones, ver el PDF y aplicar. save "new_variant" (por defecto) crea una variante nueva; "this_variant" solo si el usuario pidió cambiar esa variante.',
    inputSchema: z.object({
      base: z.object({
        variant_id: z.string(),
        revision: z.number().int().min(1).optional().describe("Versión base; por defecto lo publicado"),
      }),
      edits: z.array(editSchema).min(1).max(50),
      save: z.enum(["new_variant", "this_variant"]).default("new_variant"),
      name: z
        .string()
        .max(200)
        .optional()
        .describe('Para una variante nueva: "<base> – <cambio>", p. ej. "Principal – artista como variable"'),
      variable_settings: z
        .record(z.string(), settingSchema)
        .optional()
        .describe('Fichas de variables nuevas: {"NombreArtista": {"label": "Nombre del artista", "required": true}}'),
      recipient_roles: z
        .record(z.string(), z.string().max(100))
        .optional()
        .describe('{"0": "Editora", "1": "Artista"}'),
      summary: z.string().max(300).describe("Qué cambia, en una frase"),
    }),
    execute: async (input) => {
      const run = await api.request<Record<string, unknown> & { error?: string; detail?: unknown }>(
        "POST",
        `${base}variants/${input.base.variant_id}/dry-run/`,
        {
          user_id: userId,
          revision: input.base.revision,
          edits: input.edits,
          variable_settings: input.variable_settings,
        }
      );
      if (run.error) {
        return {
          error: `${run.error} Corrige la operación y vuelve a proponer.`,
          detail: run.detail,
        };
      }
      return {
        ...run,
        edits: input.edits,
        save: input.save,
        name: input.save === "new_variant" ? input.name : undefined,
        recipient_roles: input.recipient_roles,
        summary: input.summary,
        workspace_slug: slug,
      };
    },
  });

  tools.propose_contract_from_template = tool({
    description:
      "Prepara un contrato desde una variante de plantilla: valores de las variables (cada uno con su origen) y firmantes. La tarjeta deja corregirlos, ver el PDF con los valores y crear el borrador; nunca se envía a firma desde aquí. Cambios al texto solo para este contrato van en document_edits (crean una variante nueva).",
    inputSchema: z.object({
      variant_id: z.string(),
      revision: z.number().int().min(1).optional().describe("Versión; por defecto la publicada"),
      title: z.string().max(500).optional().describe('Título del contrato, p. ej. "Contrato de edición – Ana López"'),
      values: z
        .record(
          z.string(),
          z.object({
            value: z.string().max(5000),
            source: z.string().max(300).optional().describe("De dónde salió el valor"),
          })
        )
        .default({}),
      recipients: z
        .array(
          z.object({
            name: z.string().max(255).optional(),
            email: z.string().max(255).optional(),
            source: z.string().max(300).optional(),
          })
        )
        .max(20)
        .default([])
        .describe("Firmantes en orden (Firmante 1, 2…)"),
      document_edits: z.array(editSchema).max(50).optional(),
      variant_name: z.string().max(200).optional().describe("Nombre de la variante nueva si hay document_edits"),
      summary: z.string().max(300).describe("Qué contrato se prepara, en una frase"),
    }),
    execute: async (input) => {
      const run = await api.request<Record<string, unknown> & { error?: string; detail?: unknown }>(
        "POST",
        `${base}variants/${input.variant_id}/contract-proposal/`,
        {
          user_id: userId,
          revision: input.revision,
          values: input.values,
          recipients: input.recipients,
          title: input.title,
          document_edits: input.document_edits,
        }
      );
      if (run.error) {
        return { error: `${run.error} Corrige y vuelve a proponer.`, detail: run.detail };
      }
      return {
        ...run,
        document_edits_input: input.document_edits,
        variant_name_input: input.document_edits?.length ? input.variant_name : undefined,
        summary: input.summary,
        workspace_slug: slug,
      };
    },
  });

  return tools;
}
