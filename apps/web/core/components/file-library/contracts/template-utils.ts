/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * Shared helpers for templates and signature requests: one way to count a
 * template, one way to word an API error, readable variable labels.
 */

import type {
  TContractActionError,
  TContractSignatureStatus,
  TContractTemplateSummary,
  TContractTemplateVariable,
  TContractTemplateVariableSchema,
  TContractTemplateWarning,
  TContractVariableSetting,
} from "@plane/types";

type TTranslate = (key: string, params?: Record<string, unknown>) => string;

const PREFIX = "file_library.contracts.workflow";

export const REQUEST_STATUS_LABEL_KEYS: Record<TContractSignatureStatus, string> = {
  DRAFT: `${PREFIX}.request_status.draft`,
  PREPARING: `${PREFIX}.request_status.preparing`,
  READY: `${PREFIX}.request_status.ready`,
  PENDING: `${PREFIX}.request_status.pending`,
  COMPLETED: `${PREFIX}.request_status.completed`,
  REJECTED: `${PREFIX}.request_status.rejected`,
  CANCELLED: `${PREFIX}.request_status.cancelled`,
  EXPIRED: `${PREFIX}.request_status.expired`,
  ERROR: `${PREFIX}.request_status.error`,
};

/** Label key for a status, tolerating values this build does not know yet. */
export const requestStatusLabelKey = (status: string) =>
  REQUEST_STATUS_LABEL_KEYS[status as TContractSignatureStatus] ?? REQUEST_STATUS_LABEL_KEYS.ERROR;

const ERROR_CODES = new Set([
  "template_name_taken",
  "variant_name_taken",
  "invalid_docx",
  "file_too_large",
  "upload_failed",
  "conversion_failed",
  "missing_value",
  "missing_signer",
  "draft_locked",
  "no_draft",
  "job_active",
  "request_not_ready",
  "already_sending",
]);

const formatTime = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" });
};

/** True when the endpoint is missing on this server (older API). */
export const isEndpointMissing = (error: unknown) => {
  const status = (error as TContractActionError | undefined)?.status;
  return status === 404 || status === 405 || status === 501;
};

/**
 * Message for an API error: known codes map to i18n, older endpoints that
 * still answer with a sentence show it as is, anything else uses the fallback.
 */
export function contractErrorMessage(t: TTranslate, error: unknown, fallbackKey: string): string {
  const apiError = (error ?? {}) as TContractActionError;
  const code = typeof apiError.error === "string" ? apiError.error : undefined;
  if (code && ERROR_CODES.has(code)) {
    const params = {
      key: apiError.key ? variableLabel(apiError.key) : "",
      number: (apiError.index ?? 0) + 1,
      name: apiError.by_name ?? "",
      since: apiError.since ? formatTime(apiError.since) : "",
    };
    if (code === "missing_signer")
      return t(
        `${PREFIX}.errors.${apiError.field === "email" ? "missing_signer_email" : "missing_signer_name"}`,
        params
      );
    if (code === "draft_locked" && !params.name) return t(`${PREFIX}.errors.draft_locked_anonymous`);
    return t(`${PREFIX}.errors.${code}`, params);
  }
  if (code && code.trim() && !/^[a-z0-9_]+$/.test(code)) return code;
  if (typeof apiError.detail === "string" && apiError.detail.trim()) return apiError.detail;
  return t(fallbackKey);
}

// labels

/** Common Spanish words that lose their accent when written as a variable key. */
const ACCENTED_WORDS: Record<string, string> = {
  duracion: "duración",
  comision: "comisión",
  artistico: "artístico",
  artistica: "artística",
  numero: "número",
  codigo: "código",
  pais: "país",
  telefono: "teléfono",
  direccion: "dirección",
  descripcion: "descripción",
  razon: "razón",
  informacion: "información",
  ano: "año",
  anos: "años",
  dias: "días",
  regalias: "regalías",
  compania: "compañía",
  credito: "crédito",
  area: "área",
  musica: "música",
  musical: "musical",
  produccion: "producción",
  edicion: "edición",
  cesion: "cesión",
  exhibicion: "exhibición",
  remuneracion: "remuneración",
  participacion: "participación",
  ultimo: "último",
  ultima: "última",
  pagina: "página",
  genero: "género",
  titulo: "título",
  minimo: "mínimo",
  maximo: "máximo",
  publico: "público",
  electronico: "electrónico",
  economico: "económico",
};

const accentWord = (word: string) => {
  const lower = word.toLowerCase();
  const accented = ACCENTED_WORDS[lower];
  if (!accented) return word;
  return word[0] === word[0]?.toUpperCase() && word.length > 1
    ? accented[0].toUpperCase() + accented.slice(1)
    : accented;
};

/** "DuracionMeses" → "Duración meses"; keeps acronyms such as RFC. */
export function humanizeKey(key: string): string {
  const words = key
    .replace(/[_-]+/g, " ")
    .replace(/([a-záéíóúñ])([A-ZÁÉÍÓÚÑ])/g, "$1 $2")
    .replace(/([A-Za-zÁÉÍÓÚÑáéíóúñ])(\d)/g, "$1 $2")
    .split(/\s+/)
    .filter(Boolean);
  return words
    .map((word, index) => {
      const isAcronym = word.length > 1 && word === word.toUpperCase() && /[A-Z]/.test(word);
      const cased = isAcronym
        ? word
        : index === 0
          ? word[0].toUpperCase() + word.slice(1).toLowerCase()
          : word.toLowerCase();
      return accentWord(cased);
    })
    .join(" ");
}

/** Readable label for a variable: the saved setting wins, then the API label, then the key. */
export function variableLabel(
  key: string,
  apiLabel?: string | null,
  setting?: TContractVariableSetting | null
): string {
  if (setting?.label?.trim()) return setting.label.trim();
  const base = apiLabel?.trim() || humanizeKey(key);
  return base
    .split(/(\s+)/)
    .map((part) => (/\s+/.test(part) ? part : accentWord(part)))
    .join("");
}

export type TVariableKind = NonNullable<TContractVariableSetting["type"]>;

export const variableKind = (variable: Pick<TContractTemplateVariable, "type">, setting?: TContractVariableSetting) =>
  (setting?.type ?? variable.type ?? "text") as TVariableKind;

/** "2026-10-25" → "25 de octubre de 2026"; anything unparsable is returned unchanged. */
export function formatLongSpanishDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return value;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("es-MX", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(
    date
  );
}

/** How a typed value will read in the document (mirrors the API's formatting). */
export function displayValue(value: string, kind: TVariableKind, setting?: TContractVariableSetting): string {
  if (!value.trim()) return value;
  if (kind === "date") return setting?.date_format === "iso" ? value : formatLongSpanishDate(value);
  if (kind === "number" || kind === "currency") {
    const number = Number(value.replace(/,/g, ""));
    if (Number.isNaN(number)) return value;
    return kind === "currency"
      ? new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(number)
      : new Intl.NumberFormat("es-MX").format(number);
  }
  return value;
}

// counts

export type TTemplateCounts = { data: number; signers: number; fields: number };

/**
 * The one way to count a template on every screen: data to fill, signers and
 * signing fields. Prefers the API summary; computes it for older responses.
 * Manual fields from the blueprint are added on top of the token-derived ones.
 */
export function templateCounts(input: {
  summary?: TContractTemplateSummary | null;
  schema?: TContractTemplateVariableSchema | null;
  recipientBlueprint?: unknown[] | null;
  signatureBlueprint?: Array<{ fieldMeta?: { templateVariable?: string } }> | null;
}): TTemplateCounts {
  const summary = input.summary ?? input.schema?.summary;
  const schema = input.schema;
  const data = summary?.data_count ?? new Set((schema?.variables ?? []).map((variable) => variable.key)).size;
  const semanticFields =
    summary?.signing_field_count ??
    new Set((schema?.signing_fields ?? []).map((field) => `${field.recipient_index}:${field.type}:${field.key}`)).size;
  const manualFields = (input.signatureBlueprint ?? []).filter((field) => !field.fieldMeta?.templateVariable).length;
  const signers = Math.max(
    summary?.signer_count ?? schema?.recipients?.length ?? 0,
    input.recipientBlueprint?.length ?? 0
  );
  return { data, signers, fields: semanticFields + manualFields };
}

export const formatTemplateCounts = (t: TTranslate, counts: TTemplateCounts) =>
  t(`${PREFIX}.summary.line`, { data: counts.data, signers: counts.signers, fields: counts.fields });

// warnings

const FIELD_TYPE_KEYS: Record<string, string> = {
  SIGNATURE: "signature",
  INITIALS: "initials",
  NAME: "name",
  EMAIL: "email",
  DATE: "date",
  TEXT: "text",
  NUMBER: "number",
  RADIO: "radio",
  CHECKBOX: "checkbox",
  DROPDOWN: "dropdown",
};

const braces = (token?: string | null) => (token ? `{{${token.replace(/^\{\{|\}\}$/g, "")}}}` : "");

/** Sentence for one parser warning; unknown codes fall back to the token. */
export function warningMessage(t: TTranslate, warning: TContractTemplateWarning): string {
  const params = warning.params ?? {};
  const recipientNumber = Number(params.recipient_index ?? params.index ?? 0) + 1;
  switch (warning.code) {
    case "reserved_token": {
      const fieldKey = FIELD_TYPE_KEYS[String(params.field_type ?? "").toUpperCase()];
      return t(`${PREFIX}.warnings.reserved_token`, {
        token: braces(warning.token),
        field: fieldKey ? t(`${PREFIX}.field_types.${fieldKey}`) : String(params.field_type ?? ""),
        number: recipientNumber,
        suggestion: braces(String(params.suggestion ?? "")) || "—",
      });
    }
    case "space_in_name":
      return t(`${PREFIX}.warnings.space_in_name`, {
        token: braces(warning.token),
        suggestion: braces((warning.token ?? "").replace(/\s+/g, "")),
      });
    case "signer_gap":
      return t(`${PREFIX}.warnings.signer_gap`, { token: braces(warning.token) });
    case "signer_without_signature":
      return t(`${PREFIX}.warnings.signer_without_signature`, {
        number: recipientNumber,
        token: `{{FirmaFirmante${recipientNumber}}}`,
      });
    default:
      return braces(warning.token) || String(warning.code);
  }
}

/** Warnings of a schema response, wherever this API version puts them. */
export const schemaWarnings = (response?: {
  warnings?: TContractTemplateWarning[];
  schema?: { warnings?: TContractTemplateWarning[] };
}) => response?.warnings ?? response?.schema?.warnings ?? [];

// navigation

/** Field editor in template mode; it comes back to the template detail. */
export const templateFieldEditorUrl = (workspaceSlug: string, requestId: string, templateId: string) => {
  const returnTo = `/${workspaceSlug}/file-library/contracts/templates/${templateId}`;
  return `/${workspaceSlug}/file-library/contracts/documents/${requestId}/editor?mode=template&returnTo=${encodeURIComponent(returnTo)}`;
};

/** "Contrato de servicios_v2.docx" → "Contrato de servicios v2" */
export const nameFromFileName = (fileName: string) =>
  fileName
    .replace(/\.[^.]+$/, "")
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export const MAX_TEMPLATE_FILE_BYTES = 25 * 1024 * 1024;

// storage

/** localStorage that never throws (private windows, blocked storage). */
export const safeStorage = {
  get<T>(key: string): T | undefined {
    try {
      const raw = window.localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : undefined;
    } catch {
      return undefined;
    }
  },
  set(key: string, value: unknown) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // storage unavailable; the feature just does not remember
    }
  },
};
