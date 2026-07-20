export type TMusicChoice = [string, string];

export type TMusicParty = {
  id: string;
  kind: "ARTIST" | "GROUP" | "PERSON" | "ORGANIZATION";
  display_name: string;
  legal_name: string;
  email: string;
  phone: string;
  country: string;
  website: string;
  ipi_cae: string;
  isni: string;
  performing_rights_organization: string;
  notes: string;
  disabled: boolean;
};

export type TMusicGenre = { id: string; name: string };

export type TMusicCompany = {
  id: string;
  kind: "AGGREGATOR" | "DISTRIBUTOR" | "RECORD_LABEL" | "PUBLISHER" | "MANAGEMENT" | "OTHER";
  name: string;
  country: string;
  email: string;
  website: string;
  notes: string;
};

export type TMusicRelease = {
  id: string;
  title: string;
  version: string;
  release_type: string;
  status: string;
  upc: string;
  ean: string;
  catalog_number: string;
  original_release_date: string | null;
  release_date: string | null;
  copyright_year: number | null;
  p_line: string;
  c_line: string;
  label_name: string;
  language: string;
  cover_url: string;
  territories: string[];
  notes: string;
  artist_ids?: string[];
  artist_details: { id: string; name: string; role: string }[];
  track_count: number;
};

export type TMusicCredit = {
  id: string;
  role: string;
  percentage: string | null;
  publishing_share: string | null;
  territory: string;
  notes: string;
  party: TMusicParty;
};

export type TMusicTrack = {
  id: string;
  title: string;
  subtitle: string;
  version: string;
  kind: string;
  status: string;
  isrc: string;
  isrc_video: string;
  upc: string;
  catalog: string;
  duration_ms: number | null;
  country_of_recording: string;
  language: string;
  recording_date: string | null;
  original_release_date: string | null;
  release_date: string | null;
  explicit: boolean;
  instrumental: boolean;
  ownership: string;
  us_publishing_obligations: string;
  recoupment: string;
  p_line: string;
  digital_format: string;
  lyrics: string;
  audio_url: string;
  cover_url: string;
  aggregator_percentage: string | null;
  distributor_percentage: string | null;
  record_label_percentage: string | null;
  artist_percentage: string | null;
  writer_percentage: string | null;
  tiktok_preview_start_ms: number | null;
  tiktok_preview_end_ms: number | null;
  metadata: Record<string, unknown>;
  credits: TMusicCredit[];
  genre_details: TMusicGenre[];
  release_details: {
    id: string;
    title: string;
    release_type: string;
    release_date: string | null;
    disc_number: number;
    track_number: number;
  }[];
  links: {
    id: string;
    kind: string;
    platform: string;
    name: string;
    url: string;
    isrc: string;
  }[];
  distributions: {
    id: string;
    percentage: string | null;
    territory: string;
    valid_from: string | null;
    valid_to: string | null;
    company: TMusicCompany;
  }[];
  import_sources?: {
    id: string;
    asset_id: string | null;
    name: string;
    source: string;
    action: string;
    row_number: number | null;
    imported_at: string;
  }[];
  video_details: {
    id: string;
    title: string;
    version: string;
    status: string;
    isrc: string;
    upc: string;
    catalog: string;
    release_date: string | null;
    duration_ms: number | null;
    cover_url: string;
    video_url: string;
  }[];
};

export type TMusicTrackPage = {
  results: TMusicTrack[];
  total: number;
  page: number;
  page_size: number;
  requested_page: number;
};

export type TMusicBulkDeleteResult = {
  deleted: number;
  not_found: number;
};

export type TMusicFilters = {
  search?: string;
  type?: string;
  kind?: string;
  status?: string;
  artist?: string;
  genre?: string;
  release?: string;
  year?: string;
  from?: string;
  to?: string;
  has_video?: string;
  has_links?: string;
  has_lyrics?: string;
  video_from?: string;
  video_to?: string;
  company?: string;
  songs_only?: string;
  page?: string;
  page_size?: string;
  ids?: string;
  import_run?: string;
  /** All runs of one source file (asset id) */
  import_file?: string;
  ids_only?: string;
};

export type TMusicCatalogOptions = {
  release_types: TMusicChoice[];
  release_statuses: TMusicChoice[];
  track_kinds: TMusicChoice[];
  track_statuses: TMusicChoice[];
  credit_roles: TMusicChoice[];
  party_kinds: TMusicChoice[];
  company_kinds: TMusicChoice[];
  import_fields: string[];
  multi_fields?: string[];
  /** One entry per source FILE (runs of the same upload collapse); deleted
   * files are excluded — powers the provenance filter */
  import_files?: TMusicImportFile[];
};

export type TMusicImportFile = {
  asset_id: string;
  name: string;
  source: "MANUAL" | "ASSISTANT" | string;
  runs: number;
  last_imported_at: string;
};

export type TMusicImportError = {
  row: number;
  code: "REQUIRED_FIELD" | "DUPLICATE" | "DATABASE_NOT_READY" | "ROW_VALIDATION_ERROR" | string;
  field: string | null;
  column: string | null;
  value: unknown;
  message: string;
  row_data: Record<string, unknown>;
};

export type TMusicImportResult = {
  total: number;
  created: number;
  updated: number;
  skipped: number;
  errors: TMusicImportError[];
  invalid_row_strategy: "abort" | "skip";
  aborted: boolean;
  /** Dry-run only: per canonical field, raw tokens that no parser understood
   * ("ringtone" in a duration column) with their occurrence count */
  unparseable?: Record<string, { value: string; count: number }[]>;
  /** Set when the import was applied (provenance run id) */
  import_run_id?: string;
};

export type TMusicImportRun = {
  id: string;
  name: string;
  source: "MANUAL" | "ASSISTANT" | string;
  asset_id: string | null;
  created_at: string;
};

export type TMusicImportRunRules = {
  mapping?: Record<string, string | string[]>;
  duplicate_strategy?: string;
  dedupe_by?: string;
  /** What happens with relations existing tracks already have: "merge" only
   * adds what the file brings; "replace" makes mapped fields authoritative */
  relations_mode?: "merge" | "replace";
  value_overrides?: Record<string, Record<string, string>>;
  row_overrides?: Record<string, Record<string, string>>;
  invalid_row_strategy?: "abort" | "skip";
  defaults?: {
    credit_entries?: { party_id: string; role: string }[];
    distribution_entries?: { company_id: string }[];
    genre_ids?: string[];
    releases?: { id: string }[];
  };
};

export type TMusicImportAsset = {
  id: string;
  name: string;
  content_type: string;
  size: number;
  upload_source: "manual" | "assistant" | string;
  created_at: string;
  /** Latest applied run of this file: restores the panel configuration */
  last_run?: {
    sheet: string | null;
    rules: TMusicImportRunRules;
    summary: Record<string, number>;
    imported_at: string;
  } | null;
};

export type TMusicImportPreview = {
  headers: string[];
  rows: Record<string, string | number | null>[];
  sheets: string[];
  selected_sheet: string | null;
  header_row: number;
  total_rows: number;
  /** Multi-capable fields (multi_fields) may map several columns */
  mapping: Record<string, string | string[]>;
  /** Per column: fill count + up to 10 examples scanned over the whole file */
  column_samples?: Record<string, { non_empty: number; total: number; examples: string[] }>;
  multi_fields?: string[];
  /** Expected-format example per typed field (shown when replacing variables) */
  format_examples?: Record<string, string>;
  artist_examples: { source: string; detected: string[] }[];
  database_ready: boolean;
  database_error: string | null;
};
