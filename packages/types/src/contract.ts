/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// Mirrors apps/api/plane/db/models/contract.py (crm-new aligned schema)

export type TContractProcessingStatus = "PENDING" | "PROCESSING" | "COMPLETED" | "ERROR";
export type TContractStatus = "VIGENTE" | "FINALIZADO" | "NO_ESPECIFICADO";
export type TContractType =
  | "ARRENDAMIENTOS"
  | "ALQUILERES"
  | "VEHICULOS"
  | "SERVICIOS"
  | "ARTISTAS"
  | "REPRESENTACION"
  | "PRODUCCION"
  | "EDICION"
  | "LICENCIA"
  | "DISTRIBUCION"
  | "CESION_DERECHOS"
  | "COLABORACION"
  | "EVENTOS"
  | "PATROCINIO"
  | "CONFIDENCIALIDAD"
  | "LABORAL"
  | "OTRO";
export type TYesNoUnspecified = "SI" | "NO" | "NO_ESPECIFICADO";
/** The sidebar subsets of the analyzed list. Vigente/vencido is decided by the
 * effective end date on the server; editorial contracts live only in their own. */
export type TContractView = "vigentes" | "vencidos" | "editoriales";

export type TContract = {
  id: string;
  workspace_id: string;
  file_asset_id: string | null;
  thumbnail_asset_id: string | null;
  file_name: string | null;
  processing_status: TContractProcessingStatus;
  proposed_data: Record<string, unknown> | null;
  ai_model_used: string | null;
  processed_at: string | null;
  text_extracted_at: string | null;
  // AI-extracted, user-editable fields
  titulo: string | null;
  resumen_general: string | null;
  nombre_grupo: string | null;
  /** Comma-separated plain text (crm-new String @db.Text) */
  artistas: string | null;
  testigos: string | null;
  involucrados: string | null;
  es_notariado: boolean | null;
  fecha_inicio: string | null;
  fecha_fin: string | null;
  es_posible_expandirlo: TYesNoUnspecified;
  tiempo_extension_posible: string | null;
  expansion_time_description: string | null;
  fecha_fin_efectiva: string | null;
  estatus_contrato: TContractStatus;
  tipo_contrato: TContractType | null;
  /** Music-publishing deal. Null until the AI has classified it. */
  es_editorial: boolean | null;
  periodo_coleccion: TYesNoUnspecified | null;
  collection_period_description: string | null;
  collection_period_duration: string | null;
  periodo_retencion: TYesNoUnspecified | null;
  retention_period_description: string | null;
  retention_period_duration: string | null;
  /** Re-analysis proposal waiting for review */
  has_proposal?: boolean;
  /** Days until fecha_fin_efectiva (negative once past), null when undated */
  days_to_expiry?: number | null;
  created_at: string;
  updated_at: string;
};

/** Where a field's value appears in the document (detail only) */
export type TContractEvidence = {
  quote: string;
  page: number | null;
  /** e.g. a year-only date */
  approximate?: boolean;
  /** derived, e.g. the end date from a stated duration */
  computed?: boolean;
  /** corrected on request through the assistant ({by, at, reason} too) */
  manual?: boolean;
};

export type TContractProposedChange = {
  field: string;
  current: unknown;
  proposed: unknown;
  /** the current value was corrected by hand: the proposal would replace it */
  manual?: boolean;
};

/** GET contracts/{id}/ */
export type TContractDetail = TContract & {
  evidence?: Record<string, TContractEvidence>;
  proposed_changes?: TContractProposedChange[];
  source_request_id?: string | null;
  source_template_id?: string | null;
  content_hash?: string | null;
  /** Linked and AI-suggested catalog works */
  works_summary?: { linked: number; suggested: number };
};

/** List response when `per_page` is sent */
export type TContractPage = {
  results: TContract[];
  next_cursor: string | null;
  total: number;
};

export type TContractDuplicateCheck = {
  results: { name: string; duplicate_of: { id: string; titulo: string | null; file_name: string | null } | null }[];
};

/** Fields the bulk "update" action accepts */
export type TContractBulkUpdateFields = Partial<
  Pick<
    TContract,
    | "tipo_contrato"
    | "estatus_contrato"
    | "es_editorial"
    | "es_notariado"
    | "artistas"
    | "nombre_grupo"
    | "fecha_inicio"
    | "fecha_fin"
  >
>;

export type TContractUpdatePayload = Partial<
  Pick<
    TContract,
    | "titulo"
    | "resumen_general"
    | "nombre_grupo"
    | "artistas"
    | "testigos"
    | "involucrados"
    | "es_notariado"
    | "fecha_inicio"
    | "fecha_fin"
    | "es_posible_expandirlo"
    | "tiempo_extension_posible"
    | "expansion_time_description"
    | "fecha_fin_efectiva"
    | "estatus_contrato"
    | "tipo_contrato"
    | "es_editorial"
    | "periodo_coleccion"
    | "collection_period_description"
    | "collection_period_duration"
    | "periodo_retencion"
    | "retention_period_description"
    | "retention_period_duration"
  >
>;

export type TContractJobStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";

/** Pipeline step codes in job.current_stage (legacy rows may hold free text) */
export type TContractStageCode =
  | "queued"
  | "starting"
  | "extracting_text"
  | "waiting_ocr"
  | "collecting_text"
  | "embedding"
  | "analyzing"
  | "saving"
  | "classifying"
  | "syncing_tags"
  | "done"
  | "failed"
  | "cancelled"
  | "timeout";

export type TContractJobStep = {
  code: string;
  started_at: string | null;
  finished_at: string | null;
  status: "running" | "done" | "failed";
};

export type TContractUsageCall = {
  prompt: string;
  model: string;
  input_tokens: number;
  cached_tokens: number;
  output_tokens: number;
  cost_usd: number;
};

export type TContractJobUsage = {
  calls: TContractUsageCall[];
  total_cost_usd: number;
};

export type TContractJobMetadata = {
  steps?: TContractJobStep[];
  usage?: TContractJobUsage;
  detail?: string;
  detail_data?: Record<string, number>;
  [key: string]: unknown;
};
export type TContractJobTaskType = "EXTRACT_FULL" | "RETRY_PARTIAL" | "REANALYZE" | "QUERY";

export type TContractJob = {
  id: string;
  workspace_id: string;
  contract_id: string | null;
  initiated_by_id: string | null;
  task_type: TContractJobTaskType;
  status: TContractJobStatus;
  progress: number;
  current_stage: string | null;
  workflow_instance_id: string | null;
  error: { message?: string; stage?: string } | null;
  metadata: TContractJobMetadata | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
};

export type TContractQueryMatch = {
  contract_id: string;
  title: string;
  artists: string | null;
  start_date: string | null;
  end_date: string | null;
  final_end_date: string | null;
  reason: string;
};

export type TContractQuery = {
  id: string;
  workspace_id: string;
  user_id: string;
  query: string;
  status: TContractJobStatus;
  result: { summary?: string; matches?: TContractQueryMatch[]; scanned_count?: number } | null;
  emailed_at: string | null;
  job_id: string | null;
  created_at: string;
};

export type TContractRetryOptions = {
  extract_text?: boolean;
  generate_embeddings?: boolean;
  ai_analysis?: boolean;
  /** AI-free: resyncs ARTIST/GROUP/PERSON tags from the contract's stored fields */
  tags?: boolean;
  /** Re-runs only the type/editorial classification */
  classify?: boolean;
  /** Looks for catalog works named in the contract */
  works?: boolean;
};

export type TContractChatMode = "GENERAL" | "CONTRACT";

export type TContractChat = {
  id: string;
  workspace_id: string;
  user_id: string;
  title: string;
  mode: TContractChatMode;
  contract_id: string | null;
  created_at: string;
  updated_at: string;
};

export type TContractChatSource = {
  contract_id: string;
  title: string | null;
  file_name: string | null;
  asset_id: string | null;
  similarity: number;
};

export type TContractChatMessage = {
  id: string;
  chat_id: string;
  role: "USER" | "ASSISTANT";
  content: string;
  sources: TContractChatSource[] | null;
  /** assistant-ui UIMessage parts (text + tool calls), null on pre-agent turns */
  parts: unknown[] | null;
  created_at: string;
};

/** One document card produced by the agent's `show_documents` tool */
export type TContractAgentDocument = {
  contract_id: string;
  title?: string | null;
  file_name?: string | null;
  asset_id?: string | null;
  fecha_inicio?: string | null;
  fecha_fin?: string | null;
  estatus_contrato?: string | null;
  tipo_contrato?: string | null;
  /** Why the agent cited it — rendered as anchors inside the card */
  highlights?: (string | null)[];
};

export type TContractFilters = {
  /** Exact match on the backing file asset (viewer lookups) */
  asset_id?: string;
  search?: string;
  person?: string;
  artist?: string;
  year?: string;
  /** OR'd within the group (multi-value) */
  estatus?: TContractStatus[];
  tipo?: TContractType[];
  processing_status?: TContractProcessingStatus[];
  /** FileTag ids linked to the contract's document */
  tags?: string[];
  fecha_fin_efectiva_after?: string;
  fecha_fin_efectiva_before?: string;
  /** Effective end within the next N days */
  vence_en?: number;
  order?:
    | "-created_at"
    | "-updated_at"
    | "titulo"
    | "-titulo"
    /** AI-extracted dates; undated contracts always sort last */
    | "fecha_inicio"
    | "-fecha_inicio"
    | "fecha_fin"
    | "-fecha_fin"
    | "fin_efectiva"
    | "-fin_efectiva";
};

export type TContractFieldType =
  | "SIGNATURE"
  | "INITIALS"
  | "NAME"
  | "EMAIL"
  | "DATE"
  | "TEXT"
  | "NUMBER"
  | "RADIO"
  | "CHECKBOX"
  | "DROPDOWN";

export type TContractFieldChoice = {
  id?: number;
  value: string;
  checked?: boolean;
};

export type TContractFieldMeta = {
  type?: Lowercase<TContractFieldType>;
  label?: string;
  placeholder?: string;
  required?: boolean;
  readOnly?: boolean;
  fontSize?: number;
  overflow?: "auto" | "horizontal" | "vertical" | "crop";
  textAlign?: "left" | "center" | "right";
  verticalAlign?: "top" | "middle" | "bottom";
  lineHeight?: number | null;
  letterSpacing?: number | null;
  text?: string;
  characterLimit?: number;
  numberFormat?: string | null;
  value?: string;
  minValue?: number | null;
  maxValue?: number | null;
  values?: TContractFieldChoice[];
  direction?: "vertical" | "horizontal";
  validationRule?: string;
  validationLength?: number;
  defaultValue?: string;
  /** DOCX variable that generated this field; semantic fields are repositioned on every render. */
  templateVariable?: string;
};

export type TContractAuthoringField = {
  /** Client-only stable key; ignored by the API integration. */
  clientId?: string;
  type: TContractFieldType;
  page: number;
  positionX: number;
  positionY: number;
  width: number;
  height: number;
  fieldMeta?: TContractFieldMeta;
  /** Set by the API on fields derived from {{…FirmanteN}} tokens: placed from the Word file, not movable. */
  locked?: boolean;
  source?: "template_variable" | (string & {});
};

export type TContractAuthoringRecipient = {
  /** Client-only stable key; ignored by the API integration. */
  clientId?: string;
  name: string;
  email: string;
  role: "SIGNER" | "APPROVER" | "CC" | "VIEWER" | "ASSISTANT";
  signingOrder: number;
  placeholderLabel?: string;
  actionAuth?: Array<"ACCOUNT" | "PASSKEY" | "TWO_FACTOR_AUTH" | "PASSWORD" | "EXPLICIT_NONE">;
  fields: TContractAuthoringField[];
};

export type TContractAuthoringSettings = {
  subject: string;
  message: string;
  timezone: string;
  dateFormat: string;
  redirectUrl: string;
  language: string;
  distributionMethod: "EMAIL" | "NONE";
  signingOrder: "PARALLEL" | "SEQUENTIAL";
  allowDictateNextSigner: boolean;
  typedSignatureEnabled: boolean;
  uploadSignatureEnabled: boolean;
  drawSignatureEnabled: boolean;
  emailReplyTo: string;
  emailSettings: {
    recipientSigningRequest: boolean;
    recipientRemoved: boolean;
    recipientSigned: boolean;
    documentPending: boolean;
    documentCompleted: boolean;
    documentDeleted: boolean;
    ownerDocumentCompleted: boolean;
    ownerRecipientExpired: boolean;
    ownerDocumentCreated: boolean;
  };
  envelopeExpirationPeriod: { disabled: true } | { unit: "day" | "week" | "month" | "year"; amount: number };
  reminderSettings: {
    sendAfter: { disabled: true } | { unit: "day" | "week" | "month"; amount: number };
    repeatEvery: { disabled: true } | { unit: "day" | "week" | "month"; amount: number };
  };
  /** Signers must attach an ID (INE). Off unless set; older requests may not have it. */
  identity_verification_required?: boolean;
};

/** Optional per-variable settings stored on a variant (absent = inferred from the key). */
export type TContractVariableSetting = {
  label?: string;
  type?: "text" | "date" | "number" | "currency" | "choice";
  required?: boolean;
  default?: string;
  help?: string;
  options?: string[];
  date_format?: "long" | "iso";
};

/** Unpublished Word edits of a variant. Null/absent on older API responses. */
export type TContractTemplateDraft = {
  exists: boolean;
  started_by_name: string | null;
  started_at: string | null;
  updated_at: string | null;
  /** Who has the editor open right now (heartbeat in the last ~90 s). */
  active_by_name: string | null;
  active_at: string | null;
  /** The draft differs from the published document. */
  changed: boolean;
  asset_id?: string | null;
};

/** What the browser needs to load Collabora (same shape as the file-library session). */
export type TContractCollaboraSession = {
  editor_url: string;
  access_token: string;
  wopi_src?: string;
  can_write?: boolean;
};

export type TContractDraftStartResponse = {
  draft: TContractTemplateDraft | null;
  editor: TContractCollaboraSession | null;
};

export type TContractVariableChanges = {
  added: string[];
  removed: string[];
  signers_added: number[];
  signers_removed: number[];
};

export type TContractDraftPublishResponse = {
  revision?: TContractTemplateRevision | null;
  /** The draft matched the latest version: nothing was published. */
  unchanged?: boolean;
  variable_changes?: TContractVariableChanges;
  manual_fields_status?: "COMPATIBLE" | "REQUIRES_REVIEW" | "NONE";
  manual_field_count?: number;
};

export type TContractDraftAsVariantResponse = {
  template?: TContractTemplate;
  variant?: TContractTemplateVariant;
  variant_id?: string;
};

export type TContractTemplateVariant = {
  id: string;
  workspace_id: string;
  template_id: string;
  name: string;
  source_asset_id: string;
  source_file_name: string;
  revision_count: number;
  latest_revision: Pick<TContractTemplateRevision, "id" | "revision" | "content_sha256" | "created_at"> | null;
  is_default: boolean;
  signature_blueprint: Array<TContractAuthoringField & { recipient_index: number }>;
  signature_blueprint_layout: {
    page_count?: number;
    media_boxes?: number[][];
  };
  recipient_blueprint: Array<
    Omit<TContractAuthoringRecipient, "fields" | "email" | "name"> & {
      placeholderLabel: string;
    }
  >;
  authoring_settings: Partial<TContractAuthoringSettings>;
  /** Absent on older API responses; treat as no draft. */
  draft?: TContractTemplateDraft | null;
  /** Keyed by variable key; {} or absent = defaults. */
  variable_settings?: Record<string, TContractVariableSetting>;
  /** Role names by zero-based signer index, e.g. {"0": "Representante"}. */
  recipient_roles?: Record<string, string>;
  /** Set when the assistant made the variant: {by: "assistant", from_variant, from_revision, action_id} */
  origin?: { by?: string; from_variant?: string; from_revision?: number; action_id?: string };
  created_at: string;
  updated_at: string;
};

export type TContractTemplate = {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  is_active: boolean;
  variants: TContractTemplateVariant[];
  created_at: string;
  updated_at: string;
};

export type TContractTemplateRevision = {
  id: string;
  workspace_id: string;
  variant_id: string;
  revision: number;
  name: string;
  source_asset_id: string;
  pdf_asset_id: string;
  content_sha256: string;
  layout_signature: {
    page_count?: number;
    media_boxes?: number[][];
  };
  variable_schema: TContractTemplateVariableSchema;
  signature_blueprint: Array<TContractAuthoringField & { recipient_index: number }>;
  signature_blueprint_layout: {
    page_count?: number;
    media_boxes?: number[][];
    content_sha256?: string;
  };
  recipient_blueprint: TContractTemplateVariant["recipient_blueprint"];
  authoring_settings: Partial<TContractAuthoringSettings>;
  created_at: string;
};

export type TContractTemplateVariable = {
  key: string;
  label: string;
  type: "text" | "date" | "number";
  required: boolean;
  occurrences: number;
};

export type TContractTemplateSemanticRecipient = {
  index: number;
  label: string;
  requires_name: boolean;
  requires_email: boolean;
  field_types: TContractFieldType[];
};

export type TContractTemplateSemanticField = {
  key: string;
  label: string;
  type: TContractFieldType;
  recipient_index: number;
};

export type TContractTemplateVariableSchema = {
  variables: TContractTemplateVariable[];
  recipients: TContractTemplateSemanticRecipient[];
  signing_fields: TContractTemplateSemanticField[];
  placeholder_count: number;
  summary?: TContractTemplateSummary;
  warnings?: TContractTemplateWarning[];
};

/** "N datos · N firmantes · N campos de firma", counted once by the API. */
export type TContractTemplateSummary = {
  data_count: number;
  signer_count: number;
  signing_field_count: number;
};

export type TContractTemplateWarningCode =
  | "reserved_token"
  | "space_in_name"
  | "signer_gap"
  | "signer_without_signature";

export type TContractTemplateWarning = {
  code: TContractTemplateWarningCode | (string & {});
  token?: string;
  params?: Record<string, string | number | null | undefined>;
};

export type TContractTemplateSchemaResponse = {
  variant_id: string;
  content_sha256: string;
  source: { kind: "CURRENT" | "REVISION" | "DRAFT"; revision_id: string | null; revision: number | null };
  schema: TContractTemplateVariableSchema;
  manual_fields_status: "COMPATIBLE" | "REQUIRES_REVIEW" | "NONE";
  manual_field_count: number;
  revisions: TContractTemplateRevision[];
  /** Absent on older API responses. */
  summary?: TContractTemplateSummary;
  warnings?: TContractTemplateWarning[];
};

export type TContractSigner = {
  id: string;
  signature_request_id: string;
  name: string;
  email: string;
  role: string;
  signing_order: number;
  status: "NOT_SENT" | "SENT" | "OPENED" | "SIGNED" | "REJECTED" | "EXPIRED";
  documenso_recipient_id: number | null;
  created_at: string;
  updated_at: string;
};

export type TContractSigningLink = {
  id: number | null;
  name: string;
  email: string;
  role: string;
  signing_order: number | null;
  url: string;
};

export type TContractSigningDetailsRecipient = {
  id: number | null;
  name: string;
  email: string;
  role: string;
  signing_order: number | null;
  signing_status: string;
  read_status: string;
  send_status: string;
  signed_at: string | null;
  rejection_reason: string | null;
};

export type TContractSigningDetailsField = {
  id: number | null;
  recipient_id: number | null;
  type: TContractFieldType;
  page: number | null;
  label: string;
  value: string;
  inserted: boolean;
};

export type TContractSigningDetails = {
  status: string | null;
  recipients: TContractSigningDetailsRecipient[];
  fields: TContractSigningDetailsField[];
  synced_at?: string;
  error?: string;
};

export type TContractSignatureStatus =
  | "DRAFT"
  | "PREPARING"
  | "READY"
  | "PENDING"
  | "COMPLETED"
  | "REJECTED"
  | "CANCELLED"
  | "EXPIRED"
  | "ERROR";

/** Background send progress kept in request.metadata.send (absent on older requests). */
export type TContractSendStep = "queued" | "uploading" | "creating" | "distributing" | "done" | "failed";

export type TContractSendState = {
  step: TContractSendStep | (string & {});
  error?: { code?: string; message?: string } | null;
  started_at?: string | null;
  finished_at?: string | null;
};

export type TContractPendingSigner = {
  name: string;
  email: string;
  status: string;
};

export type TContractSignatureRequest = {
  id: string;
  workspace_id: string;
  revision: TContractTemplateRevision;
  rendered_source_asset_id: string | null;
  rendered_pdf_asset_id: string | null;
  title: string;
  authoring_mode: "DOCUMENT" | "TEMPLATE";
  status: TContractSignatureStatus;
  recipients: TContractAuthoringRecipient[];
  fields: Array<TContractAuthoringField & { recipient_index: number }>;
  authoring_settings: TContractAuthoringSettings;
  variable_values: Record<string, string>;
  preparation_warnings: string[];
  rendered_layout_signature: {
    page_count?: number;
    media_boxes?: number[][];
  };
  documenso_envelope_id: string | null;
  documenso_envelope_item_id: string | null;
  source_asset_id: string;
  pdf_asset_id: string;
  signed_asset_id: string | null;
  analysis_contract_id: string | null;
  error: { message?: string } | null;
  sent_at: string | null;
  completed_at: string | null;
  signers: TContractSigner[];
  signing_details: TContractSigningDetails | null;
  /** Fields below are optional: older API responses and requests do not have them. */
  metadata?: { send?: TContractSendState; superseded?: boolean; [key: string]: unknown } | null;
  pending_signers?: TContractPendingSigner[];
  expires_at?: string | null;
  last_reminded_at?: string | null;
  /** TEMPLATE requests: the template being configured (for the back link). */
  template_id?: string | null;
  template_name?: string | null;
  variant_id?: string | null;
  variant_name?: string | null;
  created_at: string;
  updated_at: string;
};

/** PATCH contract-templates/{id}/ — only the fields being changed. */
export type TContractTemplateUpdatePayload = {
  name?: string;
  description?: string;
};

/** PATCH contract-variants/{id}/ — only the fields being changed. */
export type TContractVariantUpdatePayload = {
  name?: string;
  variable_settings?: Record<string, TContractVariableSetting>;
  recipient_roles?: Record<string, string>;
};

/** Error codes the API returns in `error` (400/409). */
export type TContractErrorCode =
  | "template_name_taken"
  | "variant_name_taken"
  | "invalid_docx"
  | "file_too_large"
  | "upload_failed"
  | "conversion_failed"
  | "missing_value"
  | "missing_signer"
  | "draft_locked"
  | "no_draft"
  | "job_active"
  | "request_not_ready"
  | "already_sending";

/**
 * Error thrown by template / signature-request actions: the API body plus the
 * HTTP status. `error` is a code from TContractErrorCode or, on older
 * endpoints, a human-readable message.
 */
export type TContractActionError = {
  error?: TContractErrorCode | (string & {});
  detail?: string;
  status?: number;
  key?: string;
  index?: number;
  field?: "name" | "email";
  by_name?: string;
  since?: string;
};
