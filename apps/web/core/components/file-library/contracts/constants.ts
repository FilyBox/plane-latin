/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type {
  TContractProcessingStatus,
  TContractStatus,
  TContractType,
  TContractWorkRightsType,
  TYesNoUnspecified,
} from "@plane/types";

// i18n keys live under file_library.contracts.*

export const CONTRACT_STATUS_OPTIONS: { value: TContractStatus; i18nKey: string }[] = [
  { value: "VIGENTE", i18nKey: "file_library.contracts.status.vigente" },
  { value: "FINALIZADO", i18nKey: "file_library.contracts.status.finalizado" },
  { value: "NO_ESPECIFICADO", i18nKey: "file_library.contracts.status.no_especificado" },
];

export const CONTRACT_TYPE_OPTIONS: { value: TContractType; i18nKey: string }[] = [
  { value: "ARRENDAMIENTOS", i18nKey: "file_library.contracts.type.arrendamientos" },
  { value: "ALQUILERES", i18nKey: "file_library.contracts.type.alquileres" },
  { value: "VEHICULOS", i18nKey: "file_library.contracts.type.vehiculos" },
  { value: "SERVICIOS", i18nKey: "file_library.contracts.type.servicios" },
  { value: "ARTISTAS", i18nKey: "file_library.contracts.type.artistas" },
  { value: "REPRESENTACION", i18nKey: "file_library.contracts.type.representacion" },
  { value: "PRODUCCION", i18nKey: "file_library.contracts.type.produccion" },
  { value: "EDICION", i18nKey: "file_library.contracts.type.edicion" },
  { value: "LICENCIA", i18nKey: "file_library.contracts.type.licencia" },
  { value: "DISTRIBUCION", i18nKey: "file_library.contracts.type.distribucion" },
  { value: "CESION_DERECHOS", i18nKey: "file_library.contracts.type.cesion_derechos" },
  { value: "COLABORACION", i18nKey: "file_library.contracts.type.colaboracion" },
  { value: "EVENTOS", i18nKey: "file_library.contracts.type.eventos" },
  { value: "PATROCINIO", i18nKey: "file_library.contracts.type.patrocinio" },
  { value: "CONFIDENCIALIDAD", i18nKey: "file_library.contracts.type.confidencialidad" },
  { value: "LABORAL", i18nKey: "file_library.contracts.type.laboral" },
  { value: "OTRO", i18nKey: "file_library.contracts.type.otro" },
];

export const PROCESSING_STATUS_OPTIONS: { value: TContractProcessingStatus; i18nKey: string }[] = [
  { value: "PENDING", i18nKey: "file_library.contracts.processing.pending" },
  { value: "PROCESSING", i18nKey: "file_library.contracts.processing.processing" },
  { value: "COMPLETED", i18nKey: "file_library.contracts.processing.completed" },
  { value: "ERROR", i18nKey: "file_library.contracts.processing.error" },
];

export const YES_NO_UNSPECIFIED_OPTIONS: { value: TYesNoUnspecified; i18nKey: string }[] = [
  { value: "SI", i18nKey: "file_library.contracts.yes" },
  { value: "NO", i18nKey: "file_library.contracts.no" },
  { value: "NO_ESPECIFICADO", i18nKey: "file_library.contracts.status.no_especificado" },
];

export type TRetryOptionKey = "extract_text" | "generate_embeddings" | "ai_analysis" | "classify" | "tags" | "works";

export const RETRY_OPTIONS: {
  key: TRetryOptionKey;
  i18nKey: string;
  hintKey?: string;
}[] = [
  {
    key: "extract_text",
    i18nKey: "file_library.contracts.retry.extract_text",
    hintKey: "file_library.contracts.retry.extract_text_hint",
  },
  { key: "generate_embeddings", i18nKey: "file_library.contracts.retry.generate_embeddings" },
  { key: "ai_analysis", i18nKey: "file_library.contracts.retry.ai_analysis" },
  {
    key: "classify",
    i18nKey: "file_library.contracts.retry.classify",
    hintKey: "file_library.contracts.retry.classify_hint",
  },
  {
    key: "tags",
    i18nKey: "file_library.contracts.retry.tags",
    hintKey: "file_library.contracts.retry.tags_hint",
  },
  {
    key: "works",
    i18nKey: "file_library.contracts.retry.works",
    hintKey: "file_library.contracts.retry.works_hint",
  },
];

/** The retry option that re-runs a failed stage */
export const STAGE_RETRY_OPTION: Partial<Record<string, TRetryOptionKey>> = {
  extracting_text: "extract_text",
  waiting_ocr: "extract_text",
  collecting_text: "extract_text",
  embedding: "generate_embeddings",
  analyzing: "ai_analysis",
  saving: "ai_analysis",
  classifying: "classify",
  syncing_tags: "tags",
};

/** Known stage codes; anything else is legacy free text shown as-is */
export const STAGE_CODES = [
  "queued",
  "starting",
  "extracting_text",
  "waiting_ocr",
  "collecting_text",
  "embedding",
  "analyzing",
  "saving",
  "classifying",
  "syncing_tags",
  "done",
  "failed",
  "cancelled",
  "timeout",
] as const;

/** Field label keys for every DB field the UI names (proposal diff, evidence) */
export const CONTRACT_FIELD_LABEL_KEYS: Record<string, string> = {
  titulo: "file_library.contracts.fields.titulo",
  resumen_general: "file_library.contracts.fields.resumen_general",
  nombre_grupo: "file_library.contracts.fields.nombre_grupo",
  artistas: "file_library.contracts.fields.artistas",
  testigos: "file_library.contracts.fields.testigos",
  involucrados: "file_library.contracts.fields.involucrados",
  es_notariado: "file_library.contracts.fields.es_notariado",
  fecha_inicio: "file_library.contracts.fields.fecha_inicio",
  fecha_fin: "file_library.contracts.fields.fecha_fin",
  fecha_fin_efectiva: "file_library.contracts.fields.fecha_fin_efectiva",
  es_posible_expandirlo: "file_library.contracts.fields.es_posible_expandirlo",
  tiempo_extension_posible: "file_library.contracts.fields.tiempo_extension_posible",
  expansion_time_description: "file_library.contracts.fields.expansion_time_description",
  clausula_renovacion: "file_library.contracts.fields.expansion_time_description",
  estatus_contrato: "file_library.contracts.fields.estatus_contrato",
  tipo_contrato: "file_library.contracts.fields.tipo_contrato",
  es_editorial: "file_library.contracts.fields.es_editorial",
  periodo_coleccion: "file_library.contracts.fields.periodo_coleccion",
  collection_period_description: "file_library.contracts.fields.collection_period_description",
  collection_period_duration: "file_library.contracts.fields.collection_period_duration",
  duracion_periodo_coleccion: "file_library.contracts.fields.collection_period_duration",
  periodo_retencion: "file_library.contracts.fields.periodo_retencion",
  retention_period_description: "file_library.contracts.fields.retention_period_description",
  retention_period_duration: "file_library.contracts.fields.retention_period_duration",
  duracion_periodo_retencion: "file_library.contracts.fields.retention_period_duration",
};

/** Enum options per field, to show proposal values with their labels */
export const CONTRACT_FIELD_OPTIONS: Record<string, { value: string; i18nKey: string }[]> = {
  estatus_contrato: CONTRACT_STATUS_OPTIONS,
  tipo_contrato: CONTRACT_TYPE_OPTIONS,
  es_posible_expandirlo: YES_NO_UNSPECIFIED_OPTIONS,
  periodo_coleccion: YES_NO_UNSPECIFIED_OPTIONS,
  periodo_retencion: YES_NO_UNSPECIFIED_OPTIONS,
};

export const DATE_FIELD_KEYS = new Set(["fecha_inicio", "fecha_fin", "fecha_fin_efectiva"]);

/** Rights a contract grants over a linked work */
export const WORK_RIGHTS_OPTIONS: { value: TContractWorkRightsType; i18nKey: string }[] = [
  { value: "DISTRIBUCION", i18nKey: "file_library.contracts.works.rights.distribucion" },
  { value: "EDICION", i18nKey: "file_library.contracts.works.rights.edicion" },
  { value: "MASTER", i18nKey: "file_library.contracts.works.rights.master" },
  { value: "LICENCIA", i18nKey: "file_library.contracts.works.rights.licencia" },
  { value: "SINCRONIZACION", i18nKey: "file_library.contracts.works.rights.sincronizacion" },
  { value: "REPRESENTACION", i18nKey: "file_library.contracts.works.rights.representacion" },
  { value: "OTRO", i18nKey: "file_library.contracts.works.rights.otro" },
];

/** "Por vencer" quick filter choices (days) */
export const EXPIRING_WINDOWS = [30, 60, 90] as const;

export const PAGE_SIZE = 50;
