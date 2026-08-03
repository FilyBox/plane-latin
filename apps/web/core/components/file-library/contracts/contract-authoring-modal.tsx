/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { ComponentType, PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  AlertTriangle,
  AtSign,
  CalendarDays,
  CaseUpper,
  Check,
  CheckSquare,
  ChevronDown,
  CircleDot,
  Copy,
  Eye,
  FileText,
  Grip,
  GripVertical,
  Hash,
  Layers,
  Loader2,
  PenLine,
  Plus,
  Save,
  Send,
  Settings,
  Trash2,
  Type,
  UserRound,
  Users,
} from "lucide-react";
// plane imports
import { PDFViewer, type PDFViewerPageOverlayProps } from "@plane/extend-ui";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type {
  TContractAuthoringField,
  TContractAuthoringRecipient,
  TContractAuthoringSettings,
  TContractSignatureRequest,
  TContractSigningLink,
} from "@plane/types";
// services
import { contractService } from "@/services/contract.service";
import { useUser } from "@/hooks/store/user";
import { ContractEnvelopeSettingsDialog } from "./contract-envelope-settings-dialog";
import { ContractDistributeDialog } from "./contract-distribute-dialog";
import { ContractFieldSettings, getDefaultFieldMeta } from "./contract-field-settings";
import { ContractSigningLinksDialog } from "./contract-signing-links-dialog";

type AuthoringTab = "RECIPIENTS" | "FIELDS" | "PREVIEW";
type FieldType = TContractAuthoringField["type"];
type SelectedField = { recipientIndex: number; clientId: string };

type FieldDefinition = {
  labelKey: string;
  icon: ComponentType<{ className?: string }>;
  width: number;
  height: number;
};

const RECIPIENT_COLORS = ["#16A34A", "#0284C7", "#7C3AED", "#D97706", "#DC2626", "#DB2777", "#4F46E5"];

const FIELD_DEFINITIONS: Record<FieldType, FieldDefinition> = {
  SIGNATURE: { labelKey: "file_library.contracts.workflow.field_types.signature", icon: PenLine, width: 28, height: 7 },
  INITIALS: { labelKey: "file_library.contracts.workflow.field_types.initials", icon: CaseUpper, width: 16, height: 5 },
  NAME: { labelKey: "file_library.contracts.workflow.field_types.name", icon: UserRound, width: 24, height: 5 },
  EMAIL: { labelKey: "file_library.contracts.workflow.field_types.email", icon: AtSign, width: 28, height: 5 },
  DATE: { labelKey: "file_library.contracts.workflow.field_types.date", icon: CalendarDays, width: 18, height: 5 },
  TEXT: { labelKey: "file_library.contracts.workflow.field_types.text", icon: Type, width: 24, height: 5 },
  NUMBER: { labelKey: "file_library.contracts.workflow.field_types.number", icon: Hash, width: 18, height: 5 },
  RADIO: { labelKey: "file_library.contracts.workflow.field_types.radio", icon: CircleDot, width: 24, height: 7 },
  CHECKBOX: {
    labelKey: "file_library.contracts.workflow.field_types.checkbox",
    icon: CheckSquare,
    width: 24,
    height: 7,
  },
  DROPDOWN: {
    labelKey: "file_library.contracts.workflow.field_types.dropdown",
    icon: ChevronDown,
    width: 24,
    height: 5,
  },
};

const DEFAULT_SETTINGS: TContractAuthoringSettings = {
  subject: "Signature required: {{document.name}}",
  message: "Hello {{recipient.name}}, please review and sign {{document.name}}.",
  timezone: "Etc/UTC",
  dateFormat: "yyyy-MM-dd hh:mm a",
  redirectUrl: "",
  language: "es",
  distributionMethod: "EMAIL",
  signingOrder: "PARALLEL",
  allowDictateNextSigner: false,
  typedSignatureEnabled: true,
  uploadSignatureEnabled: true,
  drawSignatureEnabled: true,
  emailReplyTo: "",
  emailSettings: {
    recipientSigningRequest: true,
    recipientRemoved: true,
    recipientSigned: true,
    documentPending: true,
    documentCompleted: true,
    documentDeleted: true,
    ownerDocumentCompleted: true,
    ownerRecipientExpired: true,
    ownerDocumentCreated: true,
  },
  envelopeExpirationPeriod: { unit: "month", amount: 3 },
  reminderSettings: {
    sendAfter: { unit: "day", amount: 5 },
    repeatEvery: { unit: "day", amount: 2 },
  },
};

const mergeSettings = (value?: Partial<TContractAuthoringSettings>): TContractAuthoringSettings => ({
  ...DEFAULT_SETTINGS,
  ...value,
  emailSettings: { ...DEFAULT_SETTINGS.emailSettings, ...value?.emailSettings },
  reminderSettings: {
    ...DEFAULT_SETTINGS.reminderSettings,
    ...value?.reminderSettings,
  },
});

const makeClientId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `field-${Date.now()}-${Math.random().toString(16).slice(2)}`;

const createField = (type: FieldType, page = 1, x = 10, y = 10): TContractAuthoringField => {
  const definition = FIELD_DEFINITIONS[type];
  return {
    clientId: makeClientId(),
    type,
    page,
    positionX: Math.max(0, Math.min(100 - definition.width, x)),
    positionY: Math.max(0, Math.min(100 - definition.height, y)),
    width: definition.width,
    height: definition.height,
    fieldMeta: getDefaultFieldMeta(type),
  };
};

const emptyRecipient = (order: number): TContractAuthoringRecipient => ({
  name: "",
  email: "",
  role: "SIGNER",
  signingOrder: order,
  fields: [],
});

const recipientsFromBlueprint = (blueprint: TContractSignatureRequest["fields"]): TContractAuthoringRecipient[] => {
  if (blueprint.length === 0) return [emptyRecipient(1)];

  const recipientCount = Math.max(...blueprint.map((field) => field.recipient_index + 1));
  return Array.from({ length: recipientCount }, (_, recipientIndex) => ({
    ...emptyRecipient(recipientIndex + 1),
    fields: blueprint
      .filter((field) => field.recipient_index === recipientIndex)
      .map((field) => ({
        clientId: makeClientId(),
        type: field.type,
        page: field.page,
        positionX: field.positionX,
        positionY: field.positionY,
        width: field.width,
        height: field.height,
        fieldMeta: field.fieldMeta ? { ...field.fieldMeta } : getDefaultFieldMeta(field.type),
      })),
  }));
};

const recipientsForRequest = (signatureRequest: TContractSignatureRequest): TContractAuthoringRecipient[] => {
  if (signatureRequest.recipients.length === 0) return recipientsFromBlueprint(signatureRequest.fields);

  return signatureRequest.recipients.map((recipient, recipientIndex) => ({
    ...recipient,
    signingOrder: recipientIndex + 1,
    fields: recipient.fields.map((field) => ({
      ...field,
      clientId: makeClientId(),
    })),
  }));
};

const getRecipientLabel = (recipient: TContractAuthoringRecipient, fallback: string) =>
  recipient.name.trim() || recipient.email.trim() || recipient.placeholderLabel?.trim() || fallback;

const isFieldRole = (role: TContractAuthoringRecipient["role"]) =>
  role === "SIGNER" || role === "APPROVER" || role === "ASSISTANT";

const reindexRecipients = (recipients: TContractAuthoringRecipient[]) =>
  recipients.map((recipient, index) => ({
    ...recipient,
    signingOrder: index + 1,
  }));

function FieldOverlay({
  field,
  recipientIndex,
  color,
  selected,
  onChange,
  onSelect,
}: {
  field: TContractAuthoringField;
  recipientIndex: number;
  color: string;
  selected: boolean;
  onChange: (patch: Partial<TContractAuthoringField>) => void;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const interactionRef = useRef<{
    mode: "move" | "resize";
    startX: number;
    startY: number;
    initial: TContractAuthoringField;
    pageRect: DOMRect;
  }>();
  const definition = FIELD_DEFINITIONS[field.type];
  const Icon = definition.icon;

  const startInteraction = (event: ReactPointerEvent<HTMLElement>, mode: "move" | "resize") => {
    event.preventDefault();
    event.stopPropagation();
    const pageElement = event.currentTarget.closest<HTMLElement>("[data-pdf-viewer-page]");
    if (!pageElement) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    interactionRef.current = {
      mode,
      startX: event.clientX,
      startY: event.clientY,
      initial: field,
      pageRect: pageElement.getBoundingClientRect(),
    };
    onSelect();
  };

  const moveInteraction = (event: ReactPointerEvent<HTMLElement>) => {
    const interaction = interactionRef.current;
    if (!interaction) return;
    event.preventDefault();
    event.stopPropagation();
    const deltaX = ((event.clientX - interaction.startX) / interaction.pageRect.width) * 100;
    const deltaY = ((event.clientY - interaction.startY) / interaction.pageRect.height) * 100;

    if (interaction.mode === "move") {
      onChange({
        positionX: Math.max(0, Math.min(100 - interaction.initial.width, interaction.initial.positionX + deltaX)),
        positionY: Math.max(0, Math.min(100 - interaction.initial.height, interaction.initial.positionY + deltaY)),
      });
      return;
    }

    onChange({
      width: Math.max(6, Math.min(100 - interaction.initial.positionX, interaction.initial.width + deltaX)),
      height: Math.max(2.5, Math.min(100 - interaction.initial.positionY, interaction.initial.height + deltaY)),
    });
  };

  const stopInteraction = (event: ReactPointerEvent<HTMLElement>) => {
    if (!interactionRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    interactionRef.current = undefined;
  };

  return (
    <div
      data-contract-field
      className="shadow-sm pointer-events-auto absolute flex cursor-move touch-none items-center overflow-hidden rounded-[3px] border-2 bg-white/95 text-[10px] font-medium select-none"
      style={{
        left: `${field.positionX}%`,
        top: `${field.positionY}%`,
        width: `${field.width}%`,
        height: `${field.height}%`,
        borderColor: color,
        color,
        boxShadow: selected ? `0 0 0 2px white, 0 0 0 4px ${color}` : undefined,
        zIndex: selected ? 30 : 20 + recipientIndex,
      }}
      onPointerDown={(event) => startInteraction(event, "move")}
      onPointerMove={moveInteraction}
      onPointerUp={stopInteraction}
      onPointerCancel={stopInteraction}
    >
      <span className="flex min-w-0 flex-1 items-center gap-1 px-1.5">
        <Icon className="size-3 shrink-0" />
        <span className="truncate">
          {field.type === "TEXT"
            ? field.fieldMeta?.text || field.fieldMeta?.placeholder || t(definition.labelKey)
            : field.type === "NUMBER"
              ? field.fieldMeta?.value || field.fieldMeta?.placeholder || t(definition.labelKey)
              : field.type === "DROPDOWN"
                ? field.fieldMeta?.defaultValue || t("file_library.contracts.workflow.authoring.select_option")
                : t(definition.labelKey)}
        </span>
      </span>
      <button
        type="button"
        aria-label={t("file_library.contracts.workflow.authoring.resize_field")}
        className="absolute right-0 bottom-0 grid size-4 cursor-nwse-resize place-items-center rounded-tl bg-white"
        style={{ color }}
        onPointerDown={(event) => startInteraction(event, "resize")}
      >
        <Grip className="size-3" />
      </button>
    </div>
  );
}

function PageFieldsOverlay({
  pageNumber,
  recipients,
  selectedField,
  draggingFieldType,
  onAddField,
  onChangeField,
  onSelectField,
}: PDFViewerPageOverlayProps & {
  recipients: TContractAuthoringRecipient[];
  selectedField?: SelectedField;
  draggingFieldType?: FieldType;
  onAddField: (type: FieldType, page: number, x: number, y: number) => void;
  onChangeField: (recipientIndex: number, clientId: string, patch: Partial<TContractAuthoringField>) => void;
  onSelectField: (selection: SelectedField) => void;
}) {
  return (
    <div
      className={`absolute inset-0 z-20 ${draggingFieldType ? "pointer-events-auto" : "pointer-events-none"}`}
      onDragOver={(event) => {
        if (draggingFieldType) event.preventDefault();
      }}
      onDrop={(event) => {
        if (!draggingFieldType) return;
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        onAddField(
          draggingFieldType,
          pageNumber,
          ((event.clientX - rect.left) / rect.width) * 100,
          ((event.clientY - rect.top) / rect.height) * 100
        );
      }}
    >
      {recipients.flatMap((recipient, recipientIndex) =>
        recipient.fields
          .filter((field) => field.page === pageNumber)
          .map((field) => (
            <FieldOverlay
              key={field.clientId}
              field={field}
              recipientIndex={recipientIndex}
              color={RECIPIENT_COLORS[recipientIndex % RECIPIENT_COLORS.length]}
              selected={selectedField?.clientId === field.clientId}
              onChange={(patch) => onChangeField(recipientIndex, field.clientId!, patch)}
              onSelect={() => onSelectField({ recipientIndex, clientId: field.clientId! })}
            />
          ))
      )}
    </div>
  );
}

function ContractPrefillFields({
  recipients,
  onChange,
}: {
  recipients: TContractAuthoringRecipient[];
  onChange: (recipientIndex: number, clientId: string, patch: Partial<TContractAuthoringField>) => void;
}) {
  const { t } = useTranslation();
  const prefillable = recipients.flatMap((recipient, recipientIndex) =>
    recipient.fields
      .filter((field) => ["TEXT", "NUMBER", "RADIO", "CHECKBOX", "DROPDOWN"].includes(field.type))
      .map((field) => ({ recipient, recipientIndex, field }))
  );
  if (prefillable.length === 0) return null;

  return (
    <section className="rounded-xl border border-subtle bg-surface-1 p-4">
      <div className="mb-4">
        <h2 className="text-13 font-semibold">{t("file_library.contracts.workflow.authoring.prefilled_data")}</h2>
        <p className="mt-0.5 text-10 text-tertiary">
          {t("file_library.contracts.workflow.authoring.prefilled_description")}
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {prefillable.map(({ recipient, recipientIndex, field }) => {
          const meta = {
            ...getDefaultFieldMeta(field.type),
            ...field.fieldMeta,
          };
          const label = meta.label || t(FIELD_DEFINITIONS[field.type].labelKey);
          const updateMeta = (patch: Partial<typeof meta>) =>
            onChange(recipientIndex, field.clientId!, {
              fieldMeta: { ...meta, ...patch },
            });
          return (
            <label key={field.clientId} className="space-y-1 text-10 font-medium text-tertiary">
              {label} ·{" "}
              {getRecipientLabel(
                recipient,
                t("file_library.contracts.workflow.common.recipient_number", { number: recipientIndex + 1 })
              )}
              {field.type === "TEXT" ? (
                <input
                  className="w-full rounded-md border border-subtle bg-transparent px-2.5 py-2 text-11"
                  value={meta.text ?? ""}
                  placeholder={meta.placeholder}
                  onChange={(event) => updateMeta({ text: event.target.value })}
                />
              ) : null}
              {field.type === "NUMBER" ? (
                <input
                  className="w-full rounded-md border border-subtle bg-transparent px-2.5 py-2 text-11"
                  type="number"
                  value={meta.value ?? ""}
                  placeholder={meta.placeholder}
                  onChange={(event) => updateMeta({ value: event.target.value })}
                />
              ) : null}
              {field.type === "DROPDOWN" || field.type === "RADIO" ? (
                <select
                  className="w-full rounded-md border border-subtle bg-surface-1 px-2.5 py-2 text-11"
                  value={
                    field.type === "DROPDOWN"
                      ? (meta.defaultValue ?? "")
                      : (meta.values?.find((choice) => choice.checked)?.value ?? "")
                  }
                  onChange={(event) => {
                    if (field.type === "DROPDOWN") updateMeta({ defaultValue: event.target.value });
                    else
                      updateMeta({
                        values: meta.values?.map((choice) => ({
                          ...choice,
                          checked: choice.value === event.target.value,
                        })),
                      });
                  }}
                >
                  <option value="">{t("file_library.contracts.workflow.authoring.no_prefilled_value")}</option>
                  {(meta.values ?? []).map((choice) => (
                    <option key={choice.id ?? choice.value} value={choice.value}>
                      {choice.value}
                    </option>
                  ))}
                </select>
              ) : null}
              {field.type === "CHECKBOX" ? (
                <span className="flex flex-wrap gap-2 rounded-md border border-subtle p-2">
                  {(meta.values ?? []).map((choice) => (
                    <span key={choice.id ?? choice.value} className="flex items-center gap-1 text-10 text-primary">
                      <input
                        type="checkbox"
                        checked={Boolean(choice.checked)}
                        onChange={(event) =>
                          updateMeta({
                            values: meta.values?.map((item) =>
                              item.id === choice.id
                                ? Object.assign({}, item, {
                                    checked: event.target.checked,
                                  })
                                : item
                            ),
                          })
                        }
                      />
                      {choice.value || t("file_library.contracts.workflow.field_settings.option")}
                    </span>
                  ))}
                </span>
              ) : null}
            </label>
          );
        })}
      </div>
    </section>
  );
}

export function ContractAuthoringModal({
  workspaceSlug,
  signatureRequest,
  onClose,
  onSent,
}: {
  workspaceSlug: string;
  signatureRequest: TContractSignatureRequest;
  onClose: () => void;
  onSent: () => void;
}) {
  const { t } = useTranslation();
  const { data: currentUser } = useUser();
  const [pdfUrl, setPdfUrl] = useState<string>();
  const [pdfError, setPdfError] = useState<string>();
  const [pdfPageCount, setPdfPageCount] = useState(1);
  const [recipients, setRecipients] = useState<TContractAuthoringRecipient[]>(() =>
    recipientsForRequest(signatureRequest)
  );
  const [title, setTitle] = useState(signatureRequest.title);
  const [settings, setSettings] = useState<TContractAuthoringSettings>(() => {
    const merged = mergeSettings(signatureRequest.authoring_settings);
    return {
      ...merged,
      subject:
        signatureRequest.authoring_settings?.subject || t("file_library.contracts.workflow.authoring.default_subject"),
      message:
        signatureRequest.authoring_settings?.message || t("file_library.contracts.workflow.authoring.default_message"),
    };
  });
  const [activeTab, setActiveTab] = useState<AuthoringTab>("RECIPIENTS");
  const [activeRecipientIndex, setActiveRecipientIndex] = useState(0);
  const [selectedTool, setSelectedTool] = useState<FieldType>();
  const [draggingFieldType, setDraggingFieldType] = useState<FieldType>();
  const [selectedField, setSelectedField] = useState<SelectedField>();
  const [dragRecipientIndex, setDragRecipientIndex] = useState<number>();
  const [isSaving, setIsSaving] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [distributionOpen, setDistributionOpen] = useState(false);
  const [signingLinks, setSigningLinks] = useState<TContractSigningLink[]>();
  const [editVersion, setEditVersion] = useState(0);
  const [savedVersion, setSavedVersion] = useState(0);
  const latestVersionRef = useRef(0);

  const markEdited = useCallback(() => {
    setEditVersion((current) => {
      const next = current + 1;
      latestVersionRef.current = next;
      return next;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    setPdfError(undefined);
    void contractService
      .getSignatureRequestPdf(workspaceSlug, signatureRequest.id)
      .then(({ url }) => {
        if (!cancelled) setPdfUrl(url);
        return undefined;
      })
      .catch(() => {
        if (!cancelled) setPdfError(t("file_library.contracts.workflow.authoring.pdf_load_failed"));
      });
    return () => {
      cancelled = true;
    };
  }, [signatureRequest.id, t, workspaceSlug]);

  const updateRecipients = useCallback(
    (updater: (current: TContractAuthoringRecipient[]) => TContractAuthoringRecipient[]) => {
      setRecipients((current) => reindexRecipients(updater(current)));
      markEdited();
    },
    [markEdited]
  );

  const updateRecipient = (index: number, patch: Partial<TContractAuthoringRecipient>) =>
    updateRecipients((current) =>
      current.map((recipient, itemIndex) => (itemIndex === index ? { ...recipient, ...patch } : recipient))
    );

  const updateField = useCallback(
    (recipientIndex: number, clientId: string, patch: Partial<TContractAuthoringField>) => {
      updateRecipients((current) =>
        current.map((recipient, itemIndex) =>
          itemIndex === recipientIndex
            ? {
                ...recipient,
                fields: recipient.fields.map((field) => (field.clientId === clientId ? { ...field, ...patch } : field)),
              }
            : recipient
        )
      );
    },
    [updateRecipients]
  );

  const signingRecipientIndexes = useMemo(
    () => recipients.flatMap((recipient, index) => (isFieldRole(recipient.role) ? [index] : [])),
    [recipients]
  );

  useEffect(() => {
    if (signingRecipientIndexes.includes(activeRecipientIndex)) return;
    setActiveRecipientIndex(signingRecipientIndexes[0] ?? 0);
  }, [activeRecipientIndex, signingRecipientIndexes]);

  const addField = useCallback(
    (type: FieldType, page: number, x: number, y: number) => {
      const recipientIndex = signingRecipientIndexes.includes(activeRecipientIndex)
        ? activeRecipientIndex
        : signingRecipientIndexes[0];
      if (recipientIndex === undefined) {
        setActiveTab("RECIPIENTS");
        setToast({
          type: TOAST_TYPE.ERROR,
          title: t("file_library.contracts.workflow.authoring.add_signer_first"),
        });
        return;
      }
      const definition = FIELD_DEFINITIONS[type];
      const field = createField(type, page, x - definition.width / 2, y - definition.height / 2);
      updateRecipients((current) =>
        current.map((recipient, index) =>
          index === recipientIndex ? { ...recipient, fields: [...recipient.fields, field] } : recipient
        )
      );
      setSelectedField({ recipientIndex, clientId: field.clientId! });
      setSelectedTool(undefined);
      setDraggingFieldType(undefined);
    },
    [activeRecipientIndex, signingRecipientIndexes, t, updateRecipients]
  );

  const removeSelectedField = useCallback(() => {
    if (!selectedField) return;
    updateRecipients((current) =>
      current.map((recipient, index) =>
        index === selectedField.recipientIndex
          ? {
              ...recipient,
              fields: recipient.fields.filter((field) => field.clientId !== selectedField.clientId),
            }
          : recipient
      )
    );
    setSelectedField(undefined);
  }, [selectedField, updateRecipients]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSelectedTool(undefined);
        setSelectedField(undefined);
      }
      if ((event.key === "Delete" || event.key === "Backspace") && selectedField) {
        const target = event.target as HTMLElement | null;
        if (target?.matches("input, textarea, select, [contenteditable=true]")) return;
        event.preventDefault();
        removeSelectedField();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [removeSelectedField, selectedField]);

  const saveDraft = useCallback(
    async (version = latestVersionRef.current, showConfirmation = false) => {
      if (version === savedVersion) return;
      setIsSaving(true);
      try {
        await contractService.saveSignatureRequest(workspaceSlug, signatureRequest.id, recipients, settings, title);
        if (latestVersionRef.current === version) setSavedVersion(version);
        if (showConfirmation)
          setToast({ type: TOAST_TYPE.SUCCESS, title: t("file_library.contracts.workflow.authoring.draft_saved") });
      } catch (error: any) {
        setToast({
          type: TOAST_TYPE.ERROR,
          title: error?.error ?? t("file_library.contracts.workflow.authoring.draft_save_failed"),
        });
        throw error;
      } finally {
        setIsSaving(false);
      }
    },
    [recipients, savedVersion, settings, signatureRequest.id, title, t, workspaceSlug]
  );

  useEffect(() => {
    if (editVersion === savedVersion || editVersion === 0) return;
    const timer = window.setTimeout(() => void saveDraft(editVersion), 1200);
    return () => window.clearTimeout(timer);
  }, [editVersion, saveDraft, savedVersion]);

  const validationMessage = useMemo(() => {
    if (recipients.length === 0) return t("file_library.contracts.workflow.authoring.validation_recipient");
    if (signatureRequest.authoring_mode === "TEMPLATE") {
      for (const [index, recipient] of recipients.entries()) {
        if (!recipient.placeholderLabel?.trim())
          return t("file_library.contracts.workflow.authoring.validation_recipient_label", { number: index + 1 });
        if (recipient.role === "SIGNER" && !recipient.fields.some((field) => field.type === "SIGNATURE"))
          return t("file_library.contracts.workflow.authoring.validation_signature", {
            name: getRecipientLabel(
              recipient,
              t("file_library.contracts.workflow.common.recipient_number", { number: index + 1 })
            ),
          });
        if (recipient.role === "ASSISTANT" && index === recipients.length - 1)
          return t("file_library.contracts.workflow.authoring.validation_assistant");
      }
      return undefined;
    }
    const emails = new Set<string>();
    for (const [index, recipient] of recipients.entries()) {
      if (!recipient.name.trim())
        return t("file_library.contracts.workflow.authoring.validation_name", { number: index + 1 });
      const email = recipient.email.trim().toLowerCase();
      if (!email || !email.includes("@"))
        return t("file_library.contracts.workflow.authoring.validation_email", { number: index + 1 });
      if (emails.has(email)) return t("file_library.contracts.workflow.authoring.validation_duplicate_email");
      emails.add(email);
      if (recipient.role === "SIGNER" && !recipient.fields.some((field) => field.type === "SIGNATURE"))
        return t("file_library.contracts.workflow.authoring.validation_signature", {
          name: getRecipientLabel(
            recipient,
            t("file_library.contracts.workflow.common.recipient_number", { number: index + 1 })
          ),
        });
      if (recipient.role === "ASSISTANT" && index === recipients.length - 1)
        return t("file_library.contracts.workflow.authoring.validation_assistant");
    }
    return undefined;
  }, [recipients, signatureRequest.authoring_mode, t]);

  const handleSend = async () => {
    if (validationMessage) return;
    setIsSending(true);
    try {
      await contractService.saveSignatureRequest(workspaceSlug, signatureRequest.id, recipients, settings, title);
      await contractService.sendSignatureRequest(workspaceSlug, signatureRequest.id, recipients, settings);
      onSent();
      if (settings.distributionMethod === "NONE") {
        const links = await contractService.getSignatureRequestLinks(workspaceSlug, signatureRequest.id);
        setDistributionOpen(false);
        setSigningLinks(links);
        setToast({
          type: TOAST_TYPE.SUCCESS,
          title: t("file_library.contracts.workflow.authoring.links_generated"),
        });
      } else {
        setToast({
          type: TOAST_TYPE.SUCCESS,
          title: t("file_library.contracts.workflow.authoring.sent_email"),
          message: t("file_library.contracts.workflow.authoring.local_inbucket"),
        });
        onClose();
      }
    } catch (error: any) {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: error?.error ?? t("file_library.contracts.workflow.authoring.send_failed"),
      });
    } finally {
      setIsSending(false);
    }
  };

  const handleClose = async () => {
    if (editVersion !== savedVersion) {
      try {
        await saveDraft(editVersion);
      } catch {
        return;
      }
    }
    onClose();
  };

  const selectedFieldData = selectedField
    ? recipients[selectedField.recipientIndex]?.fields.find((field) => field.clientId === selectedField.clientId)
    : undefined;

  const moveSelectedFieldToRecipient = (nextRecipientIndex: number) => {
    if (!selectedFieldData || !selectedField) return;
    updateRecipients((current) =>
      current.map((recipient, index) => {
        if (index === selectedField.recipientIndex)
          return {
            ...recipient,
            fields: recipient.fields.filter((field) => field.clientId !== selectedField.clientId),
          };
        if (index === nextRecipientIndex)
          return {
            ...recipient,
            fields: [...recipient.fields, selectedFieldData],
          };
        return recipient;
      })
    );
    setSelectedField({
      recipientIndex: nextRecipientIndex,
      clientId: selectedField.clientId,
    });
    setActiveRecipientIndex(nextRecipientIndex);
  };

  const updateSettings = (next: TContractAuthoringSettings) => {
    setSettings(next);
    markEdited();
  };

  const duplicateSelectedField = (allPages = false) => {
    if (!selectedFieldData || !selectedField) return;
    const pages = allPages
      ? Array.from({ length: pdfPageCount }, (_, index) => index + 1).filter((page) => page !== selectedFieldData.page)
      : [selectedFieldData.page];
    const copies = pages.map((page) =>
      Object.assign({}, selectedFieldData, {
        clientId: makeClientId(),
        page,
        positionX: allPages
          ? selectedFieldData.positionX
          : Math.min(100 - selectedFieldData.width, selectedFieldData.positionX + 2),
        positionY: allPages
          ? selectedFieldData.positionY
          : Math.min(100 - selectedFieldData.height, selectedFieldData.positionY + 2),
        fieldMeta: selectedFieldData.fieldMeta ? structuredClone(selectedFieldData.fieldMeta) : undefined,
      })
    );
    if (copies.length === 0) return;
    updateRecipients((current) =>
      current.map((recipient, index) =>
        index === selectedField.recipientIndex ? { ...recipient, fields: [...recipient.fields, ...copies] } : recipient
      )
    );
    setSelectedField({
      recipientIndex: selectedField.recipientIndex,
      clientId: copies[copies.length - 1].clientId!,
    });
  };

  const handleTemplateSave = async () => {
    setIsSaving(true);
    try {
      await contractService.saveSignatureRequest(workspaceSlug, signatureRequest.id, recipients, settings, title);
      setSavedVersion(latestVersionRef.current);
      setToast({
        type: TOAST_TYPE.SUCCESS,
        title: t("file_library.contracts.workflow.authoring.template_saved"),
      });
      onSent();
      onClose();
    } catch (error: any) {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: error?.error ?? t("file_library.contracts.workflow.authoring.template_save_failed"),
      });
    } finally {
      setIsSaving(false);
    }
  };

  const pdfCanvas = (
    <div className="relative size-full bg-layer-1">
      {pdfUrl ? (
        <PDFViewer
          src={pdfUrl}
          fileName={title + ".pdf"}
          className="h-full"
          defaultZoom={0.75}
          showToolbar={false}
          showUpload={false}
          showRotateControls={false}
          onDocumentLoadSuccess={setPdfPageCount}
          pageClassName={() => (selectedTool && activeTab === "FIELDS" ? "cursor-crosshair" : undefined)}
          toolbarActions={
            selectedTool && activeTab === "FIELDS" ? (
              <div className="border-accent-primary/30 flex items-center gap-2 rounded-md border bg-accent-primary/10 px-2.5 py-1 text-11 text-accent-primary">
                <Check className="size-3.5" />
                {t("file_library.contracts.workflow.authoring.click_to_place", {
                  field: t(FIELD_DEFINITIONS[selectedTool].labelKey),
                })}
                <button type="button" className="font-medium underline" onClick={() => setSelectedTool(undefined)}>
                  {t("file_library.contracts.workflow.common.cancel")}
                </button>
              </div>
            ) : undefined
          }
          renderPageOverlay={(props) => (
            <PageFieldsOverlay
              {...props}
              recipients={recipients}
              selectedField={activeTab === "FIELDS" ? selectedField : undefined}
              draggingFieldType={activeTab === "FIELDS" ? draggingFieldType : undefined}
              onAddField={addField}
              onChangeField={activeTab === "FIELDS" ? updateField : () => undefined}
              onSelectField={(selection) => {
                if (activeTab === "FIELDS") setSelectedField(selection);
              }}
            />
          )}
          onPagePointerDown={(event, pageNumber) => {
            if (
              activeTab !== "FIELDS" ||
              !selectedTool ||
              (event.target as HTMLElement).closest("[data-contract-field]")
            )
              return;
            const rect = event.currentTarget.getBoundingClientRect();
            addField(
              selectedTool,
              pageNumber,
              ((event.clientX - rect.left) / rect.width) * 100,
              ((event.clientY - rect.top) / rect.height) * 100
            );
          }}
        />
      ) : (
        <div className="flex size-full items-center justify-center">
          {pdfError ? (
            <div className="max-w-sm text-center">
              <p className="text-13 font-medium text-danger-primary">{pdfError}</p>
              <button
                type="button"
                className="mt-2 text-12 text-accent-primary underline"
                onClick={() => window.location.reload()}
              >
                {t("file_library.contracts.workflow.common.retry")}
              </button>
            </div>
          ) : (
            <Loader2 className="size-6 animate-spin text-tertiary" />
          )}
        </div>
      )}
    </div>
  );

  const paritySteps: Array<{
    id: AuthoringTab;
    label: string;
    description: string;
    icon: ComponentType<{ className?: string }>;
  }> = [
    {
      id: "RECIPIENTS",
      label: t("file_library.contracts.workflow.authoring.document"),
      description: t("file_library.contracts.workflow.authoring.add_recipients"),
      icon: FileText,
    },
    {
      id: "FIELDS",
      label: t("file_library.contracts.workflow.common.fields"),
      description: t("file_library.contracts.workflow.authoring.place_fields"),
      icon: PenLine,
    },
    {
      id: "PREVIEW",
      label: t("file_library.contracts.workflow.common.preview"),
      description: t("file_library.contracts.workflow.authoring.review_send"),
      icon: Eye,
    },
  ];
  const activeStepIndex = paritySteps.findIndex((step) => step.id === activeTab);

  const parityDocumentSelector = (
    <div className="flex h-[82px] shrink-0 items-center justify-center border-b border-subtle bg-surface-1 px-5">
      <div className="shadow-sm flex w-80 items-center gap-3 rounded-lg border-2 border-accent-strong bg-accent-primary/10 px-4 py-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-md bg-surface-1 text-accent-primary">
          <FileText className="size-5" />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-12 font-medium">{title}.pdf</span>
          <span className="block text-10 text-tertiary">
            {t("file_library.contracts.workflow.authoring.page_count", { count: pdfPageCount })}
          </span>
        </span>
      </div>
    </div>
  );

  const parityHeaderAction =
    signatureRequest.authoring_mode === "TEMPLATE" ? (
      <Button
        variant="primary"
        size="sm"
        disabled={isSaving || Boolean(validationMessage)}
        onClick={() => void handleTemplateSave()}
      >
        {isSaving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
        {t("file_library.contracts.workflow.authoring.save_template")}
      </Button>
    ) : (
      <Button
        variant="primary"
        size="sm"
        disabled={isSending}
        onClick={() => {
          if (validationMessage) {
            setToast({
              type: TOAST_TYPE.ERROR,
              title: t("file_library.contracts.workflow.authoring.missing_information"),
              message: validationMessage,
            });
            setActiveTab("RECIPIENTS");
            return;
          }
          setActiveTab("PREVIEW");
          setDistributionOpen(true);
        }}
      >
        <Send className="size-3.5" />
        {t("file_library.contracts.workflow.distribute.title")}
      </Button>
    );

  const documensoModal = (
    <div className="absolute inset-0 z-20 flex size-full min-h-0 min-w-0 flex-col overflow-hidden bg-surface-1 text-primary">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-subtle bg-surface-1 px-4">
        <div className="flex min-w-0 items-center gap-4">
          <span className="grid size-8 shrink-0 place-items-center rounded-md bg-layer-1 text-accent-primary">
            <FileText className="size-4" />
          </span>
          <input
            value={title}
            aria-label={t("file_library.contracts.workflow.authoring.contract_title")}
            className="w-[min(38vw,480px)] truncate border-0 bg-transparent text-14 font-medium outline-none"
            onChange={(event) => {
              setTitle(event.target.value);
              markEdited();
            }}
          />
          <span className="rounded-full bg-layer-2 px-2.5 py-1 text-10 font-medium text-secondary">
            {signatureRequest.authoring_mode === "TEMPLATE"
              ? t("file_library.contracts.workflow.common.template")
              : t("file_library.contracts.workflow.request_status.draft")}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label={t("file_library.contracts.workflow.authoring.document_settings")}
            className="grid size-9 place-items-center rounded-md border border-subtle hover:bg-layer-1-hover"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings className="size-4" />
          </button>
          {parityHeaderAction}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-80 shrink-0 flex-col border-r border-subtle bg-surface-1 px-4 py-5">
          <div className="flex items-center justify-between px-2">
            <h1 className="text-15 font-semibold">{t("file_library.contracts.workflow.authoring.editor")}</h1>
            <span className="rounded-full bg-layer-2 px-2.5 py-1 text-10 text-secondary">
              {t("file_library.contracts.workflow.authoring.step_progress", {
                current: activeStepIndex + 1,
                total: paritySteps.length,
              })}
            </span>
          </div>
          <div className="mx-2 mt-4 h-1 overflow-hidden rounded-full bg-layer-2">
            <div
              className="h-full rounded-full bg-accent-primary transition-[width]"
              style={{
                width: `${((activeStepIndex + 1) / paritySteps.length) * 100}%`,
              }}
            />
          </div>
          <nav className="mt-4 space-y-2">
            {paritySteps.map((step, index) => {
              const Icon = step.icon;
              const active = step.id === activeTab;
              const complete = index < activeStepIndex;
              return (
                <button
                  key={step.id}
                  type="button"
                  className={
                    "flex w-full items-center gap-3 rounded-lg border px-3 py-3 text-left transition-colors " +
                    (active
                      ? "border-accent-strong bg-accent-primary/10"
                      : "border-subtle bg-surface-1 hover:bg-layer-1-hover")
                  }
                  onClick={() => setActiveTab(step.id)}
                >
                  <span
                    className={
                      "grid size-9 shrink-0 place-items-center rounded-md border " +
                      (active || complete
                        ? "border-accent-subtle bg-accent-primary/10 text-accent-primary"
                        : "border-subtle bg-layer-1 text-tertiary")
                    }
                  >
                    {complete ? <Check className="size-4" /> : <Icon className="size-4" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-12 font-medium">{step.label}</span>
                    <span className="block truncate text-10 text-tertiary">{step.description}</span>
                  </span>
                </button>
              );
            })}
          </nav>
          <button
            type="button"
            className="mt-auto flex items-center gap-2 rounded-md px-3 py-2.5 text-12 text-secondary hover:bg-layer-1-hover"
            onClick={() => void handleClose()}
          >
            <ArrowLeft className="size-4" /> {t("file_library.contracts.workflow.authoring.back_to_contracts")}
          </button>
        </aside>

        <main className="min-w-0 flex-1">
          {activeTab === "RECIPIENTS" ? (
            <div className="size-full overflow-y-auto">
              <div className="mx-auto max-w-4xl space-y-6 p-8">
                {signatureRequest.preparation_warnings?.length ? (
                  <div className="border-warning-primary/30 rounded-lg border bg-warning-primary/10 p-4">
                    <div className="flex gap-3">
                      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning-primary" />
                      <div>
                        <p className="text-11 font-semibold text-warning-primary">
                          {t("file_library.contracts.workflow.authoring.review_warning")}
                        </p>
                        {signatureRequest.preparation_warnings.map((warning) => (
                          <p key={warning} className="mt-1 text-10 text-warning-primary">
                            {warning}
                          </p>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : null}
                <section className="shadow-sm rounded-xl border border-subtle bg-surface-1 p-6">
                  <h2 className="text-15 font-semibold">{t("file_library.contracts.workflow.authoring.documents")}</h2>
                  <p className="mt-1 text-11 text-tertiary">
                    {t("file_library.contracts.workflow.authoring.documents_description")}
                  </p>
                  <div className="mt-5 rounded-lg border border-dashed border-subtle bg-layer-1/50 p-8 text-center">
                    <span className="mx-auto grid size-11 place-items-center rounded-full bg-layer-2 text-tertiary">
                      <FileText className="size-5" />
                    </span>
                    <p className="mt-3 text-12 font-medium">{title}.pdf</p>
                    <p className="mt-1 text-10 text-tertiary">
                      {t("file_library.contracts.workflow.authoring.generated_pdf")}
                    </p>
                  </div>
                  <div className="mt-4 flex items-center gap-3 rounded-lg border border-subtle px-4 py-3">
                    <FileText className="size-5 shrink-0 text-accent-primary" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-12 font-medium">{title}.pdf</p>
                      <p className="text-10 text-tertiary">
                        {t("file_library.contracts.workflow.authoring.page_count", { count: pdfPageCount })}
                      </p>
                    </div>
                    <span className="rounded bg-layer-2 px-2 py-1 text-9 font-medium">PDF</span>
                  </div>
                </section>

                <section className="shadow-sm rounded-xl border border-subtle bg-surface-1 p-6">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <h2 className="text-15 font-semibold">
                        {t("file_library.contracts.workflow.authoring.recipients")}
                      </h2>
                      <p className="mt-1 text-11 text-tertiary">
                        {t("file_library.contracts.workflow.authoring.recipients_description")}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {signatureRequest.authoring_mode === "DOCUMENT" && currentUser ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={recipients.some((recipient) => recipient.email === currentUser.email)}
                          onClick={() =>
                            updateRecipients((current) => [
                              ...current,
                              {
                                ...emptyRecipient(current.length + 1),
                                name: currentUser.display_name,
                                email: currentUser.email,
                              },
                            ])
                          }
                        >
                          <UserRound className="size-3.5" /> {t("file_library.contracts.workflow.authoring.add_me")}
                        </Button>
                      ) : null}
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() =>
                          updateRecipients((current) => [
                            ...current,
                            {
                              ...emptyRecipient(current.length + 1),
                              placeholderLabel: signatureRequest.authoring_mode === "TEMPLATE" ? "" : undefined,
                            },
                          ])
                        }
                      >
                        <Plus className="size-3.5" /> {t("file_library.contracts.workflow.authoring.add_recipient")}
                      </Button>
                    </div>
                  </div>
                  <div className="mt-5 flex items-center justify-between rounded-lg border border-subtle bg-layer-1 px-4 py-3">
                    <span className="flex items-center gap-2 text-11">
                      <Users className="size-4 text-tertiary" />
                      {t("file_library.contracts.workflow.authoring.signing_order")}
                    </span>
                    <select
                      className="rounded-md border border-subtle bg-surface-1 px-3 py-1.5 text-11 outline-none"
                      value={settings.signingOrder}
                      onChange={(event) =>
                        updateSettings({
                          ...settings,
                          signingOrder: event.target.value as "PARALLEL" | "SEQUENTIAL",
                        })
                      }
                    >
                      <option value="PARALLEL">{t("file_library.contracts.workflow.authoring.parallel")}</option>
                      <option value="SEQUENTIAL">{t("file_library.contracts.workflow.authoring.sequential")}</option>
                    </select>
                  </div>
                  <div className="mt-4 space-y-3">
                    {recipients.map((recipient, recipientIndex) => (
                      <div
                        key={`${recipient.signingOrder}-${recipient.email}-${recipient.placeholderLabel ?? "recipient"}`}
                        draggable
                        className="flex items-center gap-2 rounded-lg border border-subtle bg-surface-1 p-3"
                        onDragStart={() => setDragRecipientIndex(recipientIndex)}
                        onDragOver={(event) => event.preventDefault()}
                        onDrop={() => {
                          if (dragRecipientIndex === undefined || dragRecipientIndex === recipientIndex) return;
                          updateRecipients((current) => {
                            const next = [...current];
                            const [moved] = next.splice(dragRecipientIndex, 1);
                            next.splice(recipientIndex, 0, moved);
                            return next;
                          });
                          setDragRecipientIndex(undefined);
                        }}
                      >
                        <GripVertical className="size-4 shrink-0 cursor-grab text-tertiary" />
                        <span
                          className="grid size-8 shrink-0 place-items-center rounded-full text-11 font-semibold text-white"
                          style={{
                            backgroundColor: RECIPIENT_COLORS[recipientIndex % RECIPIENT_COLORS.length],
                          }}
                        >
                          {recipientIndex + 1}
                        </span>
                        {signatureRequest.authoring_mode === "TEMPLATE" ? (
                          <input
                            className="focus:border-accent-primary min-w-0 flex-1 rounded-md border border-subtle px-3 py-2 text-11 outline-none"
                            value={recipient.placeholderLabel ?? ""}
                            placeholder={t("file_library.contracts.workflow.authoring.role_placeholder")}
                            onChange={(event) =>
                              updateRecipient(recipientIndex, {
                                placeholderLabel: event.target.value,
                              })
                            }
                          />
                        ) : (
                          <>
                            <input
                              className="focus:border-accent-primary min-w-0 flex-1 rounded-md border border-subtle px-3 py-2 text-11 outline-none"
                              value={recipient.email}
                              type="email"
                              placeholder={t("file_library.contracts.workflow.authoring.email_placeholder")}
                              onChange={(event) =>
                                updateRecipient(recipientIndex, {
                                  email: event.target.value,
                                })
                              }
                            />
                            <input
                              className="focus:border-accent-primary min-w-0 flex-1 rounded-md border border-subtle px-3 py-2 text-11 outline-none"
                              value={recipient.name}
                              placeholder={t("file_library.contracts.workflow.common.name")}
                              onChange={(event) =>
                                updateRecipient(recipientIndex, {
                                  name: event.target.value,
                                })
                              }
                            />
                          </>
                        )}
                        <select
                          className="w-40 shrink-0 rounded-md border border-subtle bg-surface-1 px-2 py-2 text-10 outline-none"
                          value={recipient.role}
                          onChange={(event) => {
                            const role = event.target.value as TContractAuthoringRecipient["role"];
                            if (role === "ASSISTANT" && settings.signingOrder !== "SEQUENTIAL")
                              updateSettings({
                                ...settings,
                                signingOrder: "SEQUENTIAL",
                              });
                            updateRecipient(recipientIndex, { role });
                          }}
                        >
                          <option value="SIGNER">{t("file_library.contracts.workflow.roles.signer")}</option>
                          <option value="APPROVER">{t("file_library.contracts.workflow.roles.approver")}</option>
                          <option value="ASSISTANT">{t("file_library.contracts.workflow.roles.assistant")}</option>
                          <option value="VIEWER">{t("file_library.contracts.workflow.roles.viewer")}</option>
                          <option value="CC">{t("file_library.contracts.workflow.roles.cc")}</option>
                        </select>
                        <button
                          type="button"
                          aria-label={t("file_library.contracts.workflow.authoring.delete_recipient")}
                          className="grid size-8 shrink-0 place-items-center rounded-md text-tertiary hover:bg-danger-primary/10 hover:text-danger-primary"
                          onClick={() =>
                            updateRecipients((current) => current.filter((_, index) => index !== recipientIndex))
                          }
                        >
                          <Trash2 className="size-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="mt-3 flex items-center gap-2 px-1 py-2 text-11 font-medium text-accent-primary"
                    onClick={() =>
                      updateRecipients((current) => [
                        ...current,
                        {
                          ...emptyRecipient(current.length + 1),
                          placeholderLabel: signatureRequest.authoring_mode === "TEMPLATE" ? "" : undefined,
                        },
                      ])
                    }
                  >
                    <Plus className="size-4" /> {t("file_library.contracts.workflow.authoring.add_signer")}
                  </button>
                </section>
                <ContractPrefillFields recipients={recipients} onChange={updateField} />
                <div className="flex justify-end">
                  <Button variant="primary" size="sm" onClick={() => setActiveTab("FIELDS")}>
                    {t("file_library.contracts.workflow.authoring.add_fields")} <ArrowRight className="size-3.5" />
                  </Button>
                </div>
              </div>
            </div>
          ) : null}

          {activeTab === "FIELDS" ? (
            <div className="flex size-full min-h-0">
              <div className="flex min-w-0 flex-1 flex-col">
                {parityDocumentSelector}
                <div className="min-h-0 flex-1">{pdfCanvas}</div>
              </div>
              <aside className="flex w-80 shrink-0 flex-col border-l border-subtle bg-surface-1">
                <div className="p-4">
                  <label htmlFor="contract-selected-recipient" className="block text-10 font-semibold text-tertiary">
                    {t("file_library.contracts.workflow.authoring.selected_recipient")}
                  </label>
                  <select
                    id="contract-selected-recipient"
                    className="ring-accent-primary/20 mt-2 w-full rounded-md border border-accent-strong bg-surface-1 px-3 py-2.5 text-11 ring-1 outline-none"
                    value={activeRecipientIndex}
                    onChange={(event) => setActiveRecipientIndex(Number(event.target.value))}
                  >
                    {signingRecipientIndexes.map((recipientIndex) => (
                      <option key={recipientIndex} value={recipientIndex}>
                        {getRecipientLabel(
                          recipients[recipientIndex],
                          t("file_library.contracts.workflow.common.recipient_number", { number: recipientIndex + 1 })
                        )}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="border-t border-subtle" />
                <div className="min-h-0 flex-1 overflow-y-auto p-4">
                  <h2 className="text-12 font-semibold">{t("file_library.contracts.workflow.authoring.add_fields")}</h2>
                  <p className="mt-1 text-10 text-tertiary">
                    {t("file_library.contracts.workflow.authoring.add_fields_description")}
                  </p>
                  <div className="mt-4 grid grid-cols-2 gap-2">
                    {(Object.entries(FIELD_DEFINITIONS) as [FieldType, FieldDefinition][]).map(([type, definition]) => {
                      const Icon = definition.icon;
                      return (
                        <button
                          key={type}
                          type="button"
                          draggable={signingRecipientIndexes.length > 0}
                          disabled={signingRecipientIndexes.length === 0}
                          className={
                            "flex min-h-11 items-center gap-2 rounded-md border px-2.5 py-2 text-left text-10 disabled:opacity-40 " +
                            (selectedTool === type
                              ? "border-accent-strong bg-accent-primary/10 text-accent-primary"
                              : "border-subtle hover:border-accent-strong hover:bg-accent-primary/10")
                          }
                          onClick={() => setSelectedTool((current) => (current === type ? undefined : type))}
                          onDragStart={(event) => {
                            event.dataTransfer.effectAllowed = "copy";
                            event.dataTransfer.setData("text/plain", type);
                            setDraggingFieldType(type);
                          }}
                          onDragEnd={() => setDraggingFieldType(undefined)}
                        >
                          <Icon className="size-4 shrink-0" /> {t(definition.labelKey)}
                        </button>
                      );
                    })}
                  </div>
                  <button
                    type="button"
                    className="mt-3 flex w-full items-center justify-center gap-2 rounded-md border border-subtle px-3 py-2.5 text-10 text-secondary hover:bg-layer-1-hover"
                    onClick={() =>
                      setToast({
                        type: TOAST_TYPE.INFO,
                        title: t("file_library.contracts.workflow.authoring.ai_detection_notice"),
                      })
                    }
                  >
                    <Layers className="size-4" /> {t("file_library.contracts.workflow.authoring.detect_ai")}
                  </button>
                  {selectedFieldData && selectedField ? (
                    <section className="mt-5 space-y-3 border-t border-subtle pt-5">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-12 font-semibold">
                            {t("file_library.contracts.workflow.authoring.field_configuration")}
                          </p>
                          <p className="mt-0.5 text-10 text-tertiary">
                            {t(FIELD_DEFINITIONS[selectedFieldData.type].labelKey)} ·{" "}
                            {t("file_library.contracts.workflow.authoring.page_number", {
                              number: selectedFieldData.page,
                            })}
                          </p>
                        </div>
                        <button
                          type="button"
                          className="grid size-8 place-items-center rounded-md text-danger-primary hover:bg-danger-primary/10"
                          onClick={removeSelectedField}
                        >
                          <Trash2 className="size-4" />
                        </button>
                      </div>
                      <label className="block text-10 font-medium text-tertiary">
                        {t("file_library.contracts.workflow.authoring.assigned_to")}
                        <select
                          className="mt-1.5 w-full rounded-md border border-subtle bg-surface-1 px-3 py-2 text-11"
                          value={selectedField.recipientIndex}
                          onChange={(event) => moveSelectedFieldToRecipient(Number(event.target.value))}
                        >
                          {signingRecipientIndexes.map((recipientIndex) => (
                            <option key={recipientIndex} value={recipientIndex}>
                              {getRecipientLabel(
                                recipients[recipientIndex],
                                t("file_library.contracts.workflow.common.recipient_number", {
                                  number: recipientIndex + 1,
                                })
                              )}
                            </option>
                          ))}
                        </select>
                      </label>
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          className="flex items-center justify-center gap-1.5 rounded-md border border-subtle px-2 py-2 text-10 hover:bg-layer-1-hover"
                          onClick={() => duplicateSelectedField()}
                        >
                          <Copy className="size-3.5" /> {t("file_library.contracts.workflow.authoring.duplicate")}
                        </button>
                        <button
                          type="button"
                          className="flex items-center justify-center gap-1.5 rounded-md border border-subtle px-2 py-2 text-10 hover:bg-layer-1-hover"
                          onClick={() => duplicateSelectedField(true)}
                        >
                          <Layers className="size-3.5" /> {t("file_library.contracts.workflow.authoring.all_pages")}
                        </button>
                      </div>
                      <ContractFieldSettings
                        field={selectedFieldData}
                        onChange={(fieldMeta) =>
                          updateField(selectedField.recipientIndex, selectedField.clientId, { fieldMeta })
                        }
                      />
                    </section>
                  ) : null}
                </div>
                <div className="flex justify-between border-t border-subtle p-4">
                  <Button variant="secondary" size="sm" onClick={() => setActiveTab("RECIPIENTS")}>
                    {t("file_library.contracts.workflow.common.back")}
                  </Button>
                  <Button variant="primary" size="sm" onClick={() => setActiveTab("PREVIEW")}>
                    {t("file_library.contracts.workflow.common.preview")}
                  </Button>
                </div>
              </aside>
            </div>
          ) : null}

          {activeTab === "PREVIEW" ? (
            <div className="flex size-full min-h-0 flex-col">
              {parityDocumentSelector}
              <div className="border-warning-primary/30 border-b bg-warning-primary/10 px-5 py-3 text-center text-11 text-warning-primary">
                <strong>{t("file_library.contracts.workflow.authoring.preview_mode")}</strong>{" "}
                {t("file_library.contracts.workflow.authoring.preview_description")}
              </div>
              <div className="min-h-0 flex-1">{pdfCanvas}</div>
            </div>
          ) : null}
        </main>
      </div>

      {settingsOpen ? (
        <ContractEnvelopeSettingsDialog
          value={settings}
          onChange={updateSettings}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}
      {distributionOpen ? (
        <ContractDistributeDialog
          settings={settings}
          validationMessage={validationMessage}
          isSubmitting={isSending}
          onChange={updateSettings}
          onClose={() => setDistributionOpen(false)}
          onSubmit={() => void handleSend()}
        />
      ) : null}
      {signingLinks ? (
        <ContractSigningLinksDialog
          links={signingLinks}
          onClose={() => {
            setSigningLinks(undefined);
            onClose();
          }}
        />
      ) : null}
    </div>
  );

  return documensoModal;
}
