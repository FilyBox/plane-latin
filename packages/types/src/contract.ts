/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// Mirrors apps/api/plane/db/models/contract.py (crm-new aligned schema)

export type TContractProcessingStatus = "PENDING" | "PROCESSING" | "COMPLETED" | "ERROR";
export type TContractStatus = "VIGENTE" | "FINALIZADO" | "NO_ESPECIFICADO";
export type TContractType = "ARRENDAMIENTOS" | "ALQUILERES" | "VEHICULOS" | "SERVICIOS" | "ARTISTAS";
export type TYesNoUnspecified = "SI" | "NO" | "NO_ESPECIFICADO";

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
  periodo_coleccion: TYesNoUnspecified | null;
  collection_period_description: string | null;
  collection_period_duration: string | null;
  periodo_retencion: TYesNoUnspecified | null;
  retention_period_description: string | null;
  retention_period_duration: string | null;
  created_at: string;
  updated_at: string;
};

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
    | "periodo_coleccion"
    | "collection_period_description"
    | "collection_period_duration"
    | "periodo_retencion"
    | "retention_period_description"
    | "retention_period_duration"
  >
>;

export type TContractJobStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED";
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
  metadata: Record<string, unknown> | null;
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
  extract_thumbnail?: boolean;
  /** AI-free: resyncs ARTIST/GROUP/PERSON tags from the contract's stored fields */
  tags?: boolean;
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
  created_at: string;
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
};

export type TContractAuthoringRecipient = {
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
};

export type TContractTemplateSchemaResponse = {
  variant_id: string;
  content_sha256: string;
  source: { kind: "CURRENT" | "REVISION"; revision_id: string | null; revision: number | null };
  schema: TContractTemplateVariableSchema;
  manual_fields_status: "COMPATIBLE" | "REQUIRES_REVIEW" | "NONE";
  manual_field_count: number;
  revisions: TContractTemplateRevision[];
};

export type TContractSigner = {
  id: string;
  signature_request_id: string;
  name: string;
  email: string;
  role: string;
  signing_order: number;
  status: "NOT_SENT" | "SENT" | "OPENED" | "SIGNED" | "REJECTED";
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
  | "ERROR";

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
  created_at: string;
  updated_at: string;
};
