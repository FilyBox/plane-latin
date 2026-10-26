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

/** Groups credit roles in pickers; never changes what a role means */
export type TMusicCreditRoleCategory =
  | "ARTIST"
  | "WRITER"
  | "PUBLISHER"
  | "PRODUCER"
  | "ENGINEER"
  | "PERFORMER"
  | "VIDEO"
  | "MANAGEMENT"
  | "OTHER";

/** A credit role: built-in or the workspace's own, named as its files name
 * it ("Lead Vocals", "Bajo Quinto"). Labels are shown as stored, untranslated. */
export type TMusicCreditRole = {
  key: string;
  label: string;
  category: TMusicCreditRoleCategory | string;
  builtin: boolean;
};

export type TMusicCredit = {
  id: string;
  /** Role key (built-in or workspace role) */
  role: string;
  /** The role's name as stored (English for distributor roles) */
  role_label?: string;
  role_category?: TMusicCreditRoleCategory | string;
  /** The tag the source used when the credit was imported under another
   * role ("LeadVocals" sent to Performer); several are joined with ", " */
  role_detail?: string;
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
  c_line: string;
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
  /** A video's own ISRC or UPC (partial match) */
  video_isrc?: string;
  video_upc?: string;
  company?: string;
  songs_only?: string;
  page?: string;
  page_size?: string;
  ids?: string;
  import_run?: string;
  /** All runs of one source file (asset id) */
  import_file?: string;
  ids_only?: string;
  /** with | without | expired */
  contract?: string;
};

export type TMusicCatalogOptions = {
  release_types: TMusicChoice[];
  release_statuses: TMusicChoice[];
  track_kinds: TMusicChoice[];
  track_statuses: TMusicChoice[];
  /** [key, label] of every role, built-in + the workspace's own */
  credit_roles: TMusicChoice[];
  credit_role_details?: TMusicCreditRole[];
  credit_role_categories?: TMusicChoice[];
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
  code: "REQUIRED_FIELD" | "DUPLICATE" | "DATABASE_NOT_READY" | "TOO_LONG" | "ROW_VALIDATION_ERROR" | string;
  field: string | null;
  column: string | null;
  value: unknown;
  message: string;
  row_data: Record<string, unknown>;
};

/** The existing song a file row was matched to. by === "ambiguous": only the
 * title matched, so the row is a possible duplicate awaiting a decision. */
export type TMusicImportMatch = {
  by: "isrc" | "title" | "title_artist" | "title_date" | "catalog" | "upc" | "external_id" | "ambiguous";
  track_id: string;
  title: string;
  isrc: string;
};

export type TMusicImportRowOutcome = "created" | "updated" | "unchanged" | "skipped" | "omitted" | "error";

export type TMusicImportResult = {
  total: number;
  created: number;
  /** Matched songs the file actually changes */
  updated: number;
  /** Matched songs the file leaves exactly as they are */
  unchanged: number;
  /** Matched songs kept as they are by the "keep existing" rule */
  skipped: number;
  /** Rows dropped by a value decision ("omit those rows") */
  omitted: number;
  /** Blank rows, ignored */
  empty: number;
  errors: TMusicImportError[];
  invalid_row_strategy: "abort" | "skip";
  aborted: boolean;
  /** Rows whose title matches a song but nothing else confirms it */
  possible_duplicates: { row: number; title: string; isrc: string; match: TMusicImportMatch }[];
  possible_duplicate_count: number;
  /** The same ISRC on several rows of the file */
  in_file_duplicates: { isrc: string; rows: number[] }[];
  /** Dry-run only: what happens to each row */
  rows?: {
    row: number;
    outcome: TMusicImportRowOutcome;
    title: string;
    isrc: string;
    match?: TMusicImportMatch | null;
    possible_duplicate?: boolean;
  }[];
  /** Dry-run only: per canonical field, raw tokens that no parser understood
   * ("ringtone" in a duration column), grouped ignoring case */
  unparseable?: Record<string, { value: string; count: number; variants?: string[] }[]>;
  /** Set when the import was applied (provenance run id) */
  import_run_id?: string;
  /** Dry-run only: credits the checked songs end up with, per role key */
  credit_roles?: Record<string, number>;
  /** Dry-run only: label of every role key in credit_roles */
  role_labels?: Record<string, string>;
  /** Roles named after the file's tags: created by an applied import, or
   * that would be created (dry run) */
  new_roles?: TMusicImportNewRole[];
};

export type TMusicImportNewRole = {
  key: string;
  label: string;
  category: TMusicCreditRoleCategory | string;
  /** Tag spellings that bring it */
  tags: string[];
  /** Credits with this role */
  count: number;
};

/** Live progress of a validation or an import */
export type TMusicImportProgress = {
  processed: number;
  total: number;
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  errors: number;
};

/** One applied import of a stored file, for its history */
export type TMusicImportRunSummary = {
  id: string;
  imported_at: string;
  source: "MANUAL" | "ASSISTANT" | string;
  sheet: string | null;
  summary: Partial<Record<"total" | "created" | "updated" | "unchanged" | "skipped" | "omitted" | "empty", number>>;
  imported_by: string | null;
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
  /** When false (default) a file row only matches PRE-EXISTING records, so
   * rows sharing an identifier within the file don't collapse into one */
  dedupe_within_file?: boolean;
  /** Title-only matches: create apart, treat as that song, or leave out */
  ambiguous_strategy?: "create" | "match" | "skip";
  /** Updating a song: an empty cell keeps its current value or clears it */
  blank_cells?: "keep" | "clear";
  value_overrides?: Record<string, Record<string, string>>;
  row_overrides?: Record<string, Record<string, string>>;
  invalid_row_strategy?: "abort" | "skip";
  defaults?: {
    credit_entries?: { party_id: string; role: string }[];
    distribution_entries?: { company_id: string }[];
    genre_ids?: string[];
    releases?: { id: string }[];
  };
  /** Fixed value per field for the whole file (fills blank cells when the
   * field also has a column) */
  constants?: TMusicImportConstants;
  /** Normalized tag → credit role key (or "__SKIP__") for tagged credit columns */
  role_map?: Record<string, string>;
  /** Save columns no field took as each song's extra data */
  keep_unmapped?: boolean;
};

export type TMusicImportConstants = Record<string, string | string[]>;

/** One field the AI mapper proposes */
export type TMusicImportAiSuggestion = {
  columns: string[];
  /** 0..1, or null (older worker / no estimate) */
  confidence: number | null;
  /** Short reason in the user's language; "" when none */
  reason: string;
  /** Multi-column field: replace the current columns instead of adding */
  replace: boolean;
  /** The field was set by hand: a flagged suggestion only */
  locked: boolean;
};

export type TMusicImportAiMap = {
  /** Backward-compatible shape: field -> column | columns */
  mapping: Record<string, string | string[]>;
  suggestions?: Record<string, TMusicImportAiSuggestion>;
  model: string | null;
};

/** One tag found in a column of tagged names ("Ana <Tuba>") */
export type TMusicImportRoleTag = {
  /** Normalized tag (lowercase letters); "" for names without a tag */
  tag: string;
  /** Most common spelling in the file */
  label: string;
  count: number;
  /** Default role key; null for names without a tag (their field decides) */
  role: string | null;
  role_label?: string | null;
  role_category?: TMusicCreditRoleCategory | string | null;
  /** The default is a new role named after the tag, created on import */
  role_is_new?: boolean;
};

/** Existing values of an import field, for its fixed value */
export type TMusicImportFieldValues = {
  field: string;
  kind: "company" | "party" | "genre" | "release" | "choice" | "text" | "date" | "number";
  choices?: TMusicChoice[];
  values: { value: string; count: number }[];
  /** An existing value equal to the query (ignoring case) */
  exact: { value: string; count: number } | null;
  /** Existing values that look like the query ("VirginAgregadora" for "Virgin") */
  similar: { value: string; count: number; score: number }[];
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
  /** Applied runs of this file, newest first (up to 20) */
  runs?: TMusicImportRunSummary[];
  run_count?: number;
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
  /** Per column of tagged names: tags found and their default role */
  column_role_tags?: Record<string, TMusicImportRoleTag[]>;
  /** Expected-format example per typed field (shown when replacing variables) */
  format_examples?: Record<string, string>;
  /** Max characters of plain text fields; longer values must be decided on */
  field_limits?: Record<string, number>;
  artist_examples: { source: string; detected: string[] }[];
  database_ready: boolean;
  database_error: string | null;
  file_name?: string | null;
  /** Earlier applied imports of this same file */
  previous_imports?: { id: string; asset_id: string | null; imported_at: string; summary: Record<string, number> }[];
  /** ISRCs in the file, and how many the catalog already holds */
  isrc_count?: number;
  existing_isrc_count?: number;
  /** How a date-looking column will be read ("1/7/1905" → 2009-01-01) */
  date_interpretations?: Record<string, { raw: string; parsed: string; year_only: boolean }>;
};
