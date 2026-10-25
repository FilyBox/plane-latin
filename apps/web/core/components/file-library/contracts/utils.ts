/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type {
  TContractFilters,
  TContractJob,
  TContractProcessingStatus,
  TContractStatus,
  TContractType,
} from "@plane/types";
// local imports
import { STAGE_CODES } from "./constants";

type TFn = (key: string, params?: Record<string, unknown>) => string;

/** "2029-02-28" → "28 feb 2029" (es) / "Feb 28, 2029" (en). Bad input comes back as-is. */
export const formatContractDate = (value: string | null | undefined, locale: string): string => {
  if (!value) return "";
  const date = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" }).replace(/\./g, "");
};

export const formatContractDateTime = (value: string | null | undefined, locale: string): string => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(locale, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
};

export const isStageCode = (value: string | null | undefined): boolean =>
  !!value && (STAGE_CODES as readonly string[]).includes(value);

/** Translated stage; unknown (legacy) text is shown as it came. */
export const stageLabel = (t: TFn, value: string | null | undefined): string => {
  if (!value) return "";
  return isStageCode(value) ? t(`file_library.contracts.stage.${value}`) : value;
};

export const isJobActive = (job: Pick<TContractJob, "status"> | null | undefined) =>
  job?.status === "QUEUED" || job?.status === "RUNNING";

/** 75_000 → "1 min 15 s" */
export const formatDuration = (ms: number): string => {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds} s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds ? `${minutes} min ${seconds} s` : `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min`;
};

export const elapsedMs = (start: string | null | undefined, end?: string | null): number | null => {
  if (!start) return null;
  const from = new Date(start).getTime();
  const to = end ? new Date(end).getTime() : Date.now();
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.max(0, to - from);
};

export const formatCost = (usd: number, locale: string): string =>
  new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: usd < 0.01 ? 4 : 2,
    maximumFractionDigits: usd < 0.01 ? 4 : 2,
  }).format(usd);

export const formatFileSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/** sha256 hex of a file; empty string where Web Crypto isn't available. */
export const sha256File = async (file: File): Promise<string> => {
  if (typeof crypto === "undefined" || !crypto.subtle) return "";
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

// ── Filters in the URL ────────────────────────────────────────────────────
// Short, readable keys so a shared link stays legible.

const LIST_KEYS = {
  estatus: "estatus",
  tipo: "tipo",
  processing_status: "analisis",
  tags: "tags",
} as const;
const TEXT_KEYS = {
  search: "q",
  person: "persona",
  artist: "artista",
  year: "anio",
  fecha_fin_efectiva_after: "fin_desde",
  fecha_fin_efectiva_before: "fin_hasta",
} as const;
const ORDER_KEY = "orden";
const EXPIRING_KEY = "vence";

export const DEFAULT_ORDER: NonNullable<TContractFilters["order"]> = "-created_at";

/** Every search param the filters own (peek, chat… are left alone) */
export const FILTER_PARAM_KEYS: string[] = [
  ...Object.values(LIST_KEYS),
  ...Object.values(TEXT_KEYS),
  ORDER_KEY,
  EXPIRING_KEY,
];

export const filtersFromParams = (params: URLSearchParams): TContractFilters => {
  const filters: TContractFilters = {};
  const list = (key: string) =>
    (params.get(key) ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  const estatus = list(LIST_KEYS.estatus);
  if (estatus.length) filters.estatus = estatus as TContractStatus[];
  const tipo = list(LIST_KEYS.tipo);
  if (tipo.length) filters.tipo = tipo as TContractType[];
  const processing = list(LIST_KEYS.processing_status);
  if (processing.length) filters.processing_status = processing as TContractProcessingStatus[];
  const tags = list(LIST_KEYS.tags);
  if (tags.length) filters.tags = tags;
  (Object.keys(TEXT_KEYS) as (keyof typeof TEXT_KEYS)[]).forEach((key) => {
    const value = params.get(TEXT_KEYS[key]);
    if (value) filters[key] = value;
  });
  const expiring = Number(params.get(EXPIRING_KEY));
  if (Number.isFinite(expiring) && expiring > 0) filters.vence_en = expiring;
  filters.order = (params.get(ORDER_KEY) as TContractFilters["order"]) || DEFAULT_ORDER;
  return filters;
};

/** Writes the filters into a copy of `current`, keeping unrelated params. */
export const paramsWithFilters = (current: URLSearchParams, filters: TContractFilters): URLSearchParams => {
  const next = new URLSearchParams(current);
  FILTER_PARAM_KEYS.forEach((key) => next.delete(key));
  (Object.keys(LIST_KEYS) as (keyof typeof LIST_KEYS)[]).forEach((key) => {
    const values = filters[key] as string[] | undefined;
    if (values?.length) next.set(LIST_KEYS[key], values.join(","));
  });
  (Object.keys(TEXT_KEYS) as (keyof typeof TEXT_KEYS)[]).forEach((key) => {
    const value = filters[key];
    if (value) next.set(TEXT_KEYS[key], value);
  });
  if (filters.vence_en) next.set(EXPIRING_KEY, String(filters.vence_en));
  if (filters.order && filters.order !== DEFAULT_ORDER) next.set(ORDER_KEY, filters.order);
  return next;
};

/** Only the filter part of a query string, to carry between the list views */
export const filterQueryOnly = (params: URLSearchParams): string => {
  const only = new URLSearchParams();
  FILTER_PARAM_KEYS.forEach((key) => {
    const value = params.get(key);
    if (value) only.set(key, value);
  });
  return only.toString();
};

/** Counts the narrowing filters (search and order excluded) */
export const activeFilterCount = (filters: TContractFilters): number =>
  (filters.estatus?.length ?? 0) +
  (filters.tipo?.length ?? 0) +
  (filters.processing_status?.length ?? 0) +
  (filters.tags?.length ?? 0) +
  (filters.person ? 1 : 0) +
  (filters.artist ? 1 : 0) +
  (filters.year ? 1 : 0) +
  (filters.fecha_fin_efectiva_after ? 1 : 0) +
  (filters.fecha_fin_efectiva_before ? 1 : 0) +
  (filters.vence_en ? 1 : 0);
