/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * "Use this template" — the form that turns a template into a contract.
 *
 * Validation is per field so every problem shows at once. The right pane shows
 * the document being filled: focusing a field jumps to its `{{token}}` in the
 * preview and a strip above it shows the value as it will read in the contract.
 * Values are remembered per variant so the next contract starts prefilled.
 */

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { observer } from "mobx-react";
import {
  AlertTriangle,
  ArrowRight,
  Braces,
  CheckCircle2,
  FileClock,
  FilePenLine,
  History,
  Loader2,
  Users,
  X,
} from "lucide-react";
import useSWR from "swr";
import type { PDFViewerHandle } from "@plane/extend-ui";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type {
  TContractActionError,
  TContractAuthoringRecipient,
  TContractSignatureRequest,
  TContractTemplateVariable,
  TContractTemplateVariant,
  TContractVariableSetting,
  TSharedTag,
} from "@plane/types";
import { EModalPosition, EModalWidth, ModalCore } from "@plane/ui";
import { cn } from "@plane/utils";
import { useMember } from "@/hooks/store/use-member";
import { contractService } from "@/services/contract.service";
import { referencesService } from "@/services/references.service";
import { ContractAssetPreview } from "./contract-asset-preview";
import { contractErrorMessage, displayValue, safeStorage, variableKind, variableLabel } from "./template-utils";
import { ContractCheckbox, ContractField, ContractInput, ContractLoading, ContractSelect } from "./ui";

type Props = {
  workspaceSlug: string;
  templateName: string;
  variant: TContractTemplateVariant;
  onEditWord: () => void;
  onClose: () => void;
  onPrepared: (request: TContractSignatureRequest) => void;
  initialRevisionId?: string;
  /** Prefills the contract title; defaults to the template name. */
  initialTitle?: string;
};

type PreparedRecipient = Partial<TContractAuthoringRecipient> & { clientKey: string };

/** What the last successful "Prepare" used, per variant. */
type TRememberedValues = {
  variableValues?: Record<string, string>;
  recipients?: Array<{ name?: string; email?: string } | null>;
  omittedKeys?: string[];
  savedAt?: string;
};

type TServerError = { message: string; fieldId?: string };

const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PREFIX = "file_library.contracts.workflow";
const LIVE = `${PREFIX}.use_live`;
const SEARCH_DEBOUNCE_MS = 400;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RECIPIENT_FIELD = /^recipient:(\d+):(name|email)$/;
/** Time-based only: the request does not report progress. */
const PROGRESS_STEPS = [
  { after: 0, key: `${LIVE}.step_filling` },
  { after: 2500, key: `${LIVE}.step_pdf` },
  { after: 6000, key: `${LIVE}.step_fields` },
];

const lastValuesKey = (variantId: string) => `plane:contracts:use-last-values:${variantId}`;

/**
 * A variant (or one of its saved versions) can be used once it has signature
 * fields placed and participants defined — without them the contract has
 * nowhere to be signed.
 */
export function isTemplateSourceReady(
  source: Pick<TContractTemplateVariant, "signature_blueprint" | "recipient_blueprint"> | undefined
) {
  return Boolean(source && source.signature_blueprint.length > 0 && source.recipient_blueprint.length > 0);
}

const roleLabelKey: Record<TContractAuthoringRecipient["role"], string> = {
  SIGNER: `${PREFIX}.roles.signer`,
  APPROVER: `${PREFIX}.roles.approver`,
  ASSISTANT: `${PREFIX}.roles.assistant`,
  VIEWER: `${PREFIX}.roles.viewer`,
  CC: `${PREFIX}.roles.cc`,
};

/** The token a field fills, as written in the Word document. */
function fieldToken(fieldId: string): string | null {
  if (fieldId.startsWith("variable:")) return `{{${fieldId.slice("variable:".length)}}}`;
  const match = RECIPIENT_FIELD.exec(fieldId);
  if (!match) return null;
  return `{{${match[2] === "name" ? "NombreFirmante" : "CorreoFirmante"}${Number(match[1]) + 1}}}`;
}

/** Texts to look for in the preview, most precise first. */
function searchCandidates(fieldId: string): string[] {
  if (fieldId.startsWith("variable:")) {
    const key = fieldId.slice("variable:".length);
    return [`{{${key}}}`, key];
  }
  const match = RECIPIENT_FIELD.exec(fieldId);
  if (!match) return [];
  const number = Number(match[1]) + 1;
  const base = match[2] === "name" ? "NombreFirmante" : "CorreoFirmante";
  // Signer 1 may be written without the number ({{NombreFirmante}}).
  return number === 1
    ? [`{{${base}1}}`, `{{${base}}}`, `${base}1`, base]
    : [`{{${base}${number}}}`, `${base}${number}`];
}

const normalize = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();

const nonEmpty = (values: Record<string, string>) =>
  Object.fromEntries(Object.entries(values).filter(([, value]) => typeof value === "string" && value.trim()));

// people autocomplete

type TSuggestion = { id: string; name: string; email?: string; source: "member" | "person" };

const MAX_SUGGESTIONS = 8;

/** Name input that suggests workspace members (name + email) and person tags (name). */
const PersonNameInput = observer(function PersonNameInput({
  workspaceSlug,
  inputId,
  value,
  hasError,
  personTags,
  onFocus,
  onBlur,
  onChange,
  onPick,
}: {
  workspaceSlug: string;
  inputId: string;
  value: string;
  hasError: boolean;
  personTags: TSharedTag[];
  onFocus: () => void;
  onBlur: () => void;
  onChange: (value: string) => void;
  onPick: (suggestion: TSuggestion) => void;
}) {
  const { t } = useTranslation();
  const {
    workspace: { getWorkspaceMemberIds, getWorkspaceMemberDetails },
  } = useMember();
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const listId = `${inputId}-suggestions`;
  const query = normalize(value);

  const suggestions: TSuggestion[] = [];
  if (query.length >= 2) {
    const seen = new Set<string>();
    for (const memberId of getWorkspaceMemberIds(workspaceSlug)) {
      const member = getWorkspaceMemberDetails(memberId)?.member;
      if (!member || member.is_bot) continue;
      const name = `${member.first_name ?? ""} ${member.last_name ?? ""}`.trim() || member.display_name;
      const email = member.email ?? "";
      if (![name, member.display_name, email].some((text) => text && normalize(text).includes(query))) continue;
      suggestions.push({ id: `member:${memberId}`, name, email: email || undefined, source: "member" });
      seen.add(normalize(name));
      if (suggestions.length >= MAX_SUGGESTIONS - 2) break;
    }
    for (const tag of personTags) {
      if (suggestions.length >= MAX_SUGGESTIONS) break;
      const tagName = normalize(tag.name);
      if (seen.has(tagName) || !tagName.includes(query)) continue;
      seen.add(tagName);
      suggestions.push({ id: `tag:${tag.id}`, name: tag.name, source: "person" });
    }
  }
  // Nothing to offer once the value is exactly the only suggestion.
  const alreadyPicked = suggestions.length === 1 && normalize(suggestions[0].name) === query;
  const visible = open && suggestions.length > 0 && !alreadyPicked;
  const activeIndex = Math.min(highlight, Math.max(suggestions.length - 1, 0));

  const pick = (suggestion: TSuggestion) => {
    onPick(suggestion);
    setOpen(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!visible) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setHighlight((activeIndex + step + suggestions.length) % suggestions.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      pick(suggestions[activeIndex]);
    } else if (event.key === "Escape") {
      // Close the list, not the whole dialog.
      event.stopPropagation();
      setOpen(false);
    }
  };

  return (
    <div className="relative">
      <ContractInput
        id={inputId}
        value={value}
        hasError={hasError}
        autoComplete="off"
        role="combobox"
        aria-expanded={visible}
        aria-controls={visible ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={visible ? `${listId}-${activeIndex}` : undefined}
        onFocus={() => {
          setOpen(true);
          onFocus();
        }}
        onBlur={() => {
          setOpen(false);
          onBlur();
        }}
        onKeyDown={onKeyDown}
        onChange={(event) => {
          setOpen(true);
          setHighlight(0);
          onChange(event.target.value);
        }}
      />
      {visible ? (
        <ul
          id={listId}
          role="listbox"
          aria-label={t(`${LIVE}.suggestions_label`)}
          className="absolute inset-x-0 top-full z-20 mt-1 max-h-56 overflow-y-auto rounded-md border border-subtle bg-surface-1 py-1 shadow-raised-200"
        >
          {suggestions.map((suggestion, index) => (
            <li
              key={suggestion.id}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === activeIndex}
              className={cn(
                "flex cursor-pointer items-center gap-2 px-3 py-1.5",
                index === activeIndex && "bg-layer-1-hover"
              )}
              // mousedown, so the pick lands before the input blurs
              onMouseDown={(event) => {
                event.preventDefault();
                pick(suggestion);
              }}
              onMouseEnter={() => setHighlight(index)}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-13 text-primary">{suggestion.name}</span>
                {suggestion.email ? (
                  <span className="block truncate text-11 text-tertiary">{suggestion.email}</span>
                ) : null}
              </span>
              <span className="shrink-0 text-10 text-tertiary">
                {t(suggestion.source === "member" ? `${LIVE}.suggestion_member` : `${LIVE}.suggestion_person`)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
});

export function ContractTemplateUseDialog({
  workspaceSlug,
  templateName,
  variant,
  onEditWord,
  onClose,
  onPrepared,
  initialRevisionId,
  initialTitle,
}: Props) {
  const { t } = useTranslation();
  const uid = useId();
  const domId = (fieldId: string) => `${uid}${fieldId}`;
  const selectedSource = initialRevisionId ?? "CURRENT";
  const storageKey = lastValuesKey(variant.id);
  const [title, setTitle] = useState(initialTitle ?? templateName);
  const [variableValues, setVariableValues] = useState<Record<string, string>>({});
  const [omittedVariableKeys, setOmittedVariableKeys] = useState<string[]>([]);
  const [recipients, setRecipients] = useState<PreparedRecipient[]>([]);
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [showAllErrors, setShowAllErrors] = useState(false);
  const [isPreparing, setIsPreparing] = useState(false);
  const [progressStep, setProgressStep] = useState(0);
  const [serverError, setServerError] = useState<TServerError | null>(null);
  const [restoredLastValues, setRestoredLastValues] = useState(false);
  const [activeField, setActiveField] = useState<string | null>(null);
  const [searchTick, setSearchTick] = useState(0);
  const viewerRef = useRef<PDFViewerHandle | null>(null);
  /** Field whose token the preview already jumped to; avoids re-scrolling on every keystroke. */
  const foundFieldRef = useRef<string | null>(null);
  const initializedRef = useRef(false);
  const revisionId = selectedSource === "CURRENT" ? undefined : selectedSource;
  const { data, isLoading } = useSWR(
    `CONTRACT_TEMPLATE_SCHEMA_${workspaceSlug}_${variant.id}_${selectedSource}`,
    () => contractService.getTemplateSchema(workspaceSlug, variant.id, revisionId),
    { revalidateOnFocus: false }
  );

  const variableSettings = useMemo<Record<string, TContractVariableSetting>>(
    () => variant.variable_settings ?? {},
    [variant.variable_settings]
  );
  const variables = useMemo(() => data?.schema.variables ?? [], [data?.schema.variables]);
  const selectedRevision = data?.revisions.find((revision) => revision.id === revisionId);
  const recipientBlueprint = selectedRevision?.recipient_blueprint?.length
    ? selectedRevision.recipient_blueprint
    : variant.recipient_blueprint;
  const recipientCount = useMemo(() => {
    const semanticCount = data?.schema.recipients.length
      ? Math.max(...data.schema.recipients.map((recipient) => recipient.index)) + 1
      : 0;
    return Math.max(semanticCount, recipientBlueprint.length);
  }, [data?.schema.recipients, recipientBlueprint.length]);

  // Person tags only fill a name; any failure just means no tag suggestions.
  const { data: personTags } = useSWR(
    recipientCount > 0 ? `CONTRACT_USE_PERSON_TAGS_${workspaceSlug}` : null,
    () => referencesService.getTags(workspaceSlug, { kind: "PERSON" }),
    { revalidateOnFocus: false, shouldRetryOnError: false }
  );

  const isRequired = (variable: TContractTemplateVariable) =>
    variableSettings[variable.key]?.required ?? variable.required;

  useEffect(() => {
    setRecipients((current) =>
      Array.from({ length: recipientCount }, (_, index) => {
        const previous = current[index] ?? {};
        const blueprint = recipientBlueprint[index];
        return {
          ...previous,
          clientKey:
            previous.clientKey ??
            (typeof crypto !== "undefined" && "randomUUID" in crypto
              ? crypto.randomUUID()
              : `recipient-${Date.now()}-${Math.random()}`),
          placeholderLabel: blueprint?.placeholderLabel ?? t(`${PREFIX}.common.signer_number`, { number: index + 1 }),
          role: previous.role ?? blueprint?.role ?? "SIGNER",
          signingOrder: index + 1,
          actionAuth: previous.actionAuth ?? blueprint?.actionAuth ?? [],
        };
      })
    );
  }, [recipientBlueprint, recipientCount, t]);

  useEffect(() => {
    const availableKeys = new Set(variables.map((variable) => variable.key));
    setOmittedVariableKeys((current) => current.filter((key) => availableKeys.has(key)));
  }, [variables]);

  // First load: defaults from the variable settings, then last time's values on top.
  // Declared after the recipients effect so its update sees the filled list.
  useEffect(() => {
    if (!data || initializedRef.current) return;
    initializedRef.current = true;
    const keys = new Set(data.schema.variables.map((variable) => variable.key));
    const next: Record<string, string> = {};
    for (const variable of data.schema.variables) {
      const fallback = variableSettings[variable.key]?.default;
      if (typeof fallback === "string" && fallback.trim()) next[variable.key] = fallback;
    }
    let restored = false;
    const remembered = safeStorage.get<TRememberedValues | null>(storageKey);
    if (remembered && typeof remembered === "object") {
      for (const [key, value] of Object.entries(remembered.variableValues ?? {})) {
        if (!keys.has(key) || typeof value !== "string" || !value.trim()) continue;
        next[key] = value;
        restored = true;
      }
      const omitted = Array.isArray(remembered.omittedKeys)
        ? remembered.omittedKeys.filter((key) => typeof key === "string" && keys.has(key))
        : [];
      if (omitted.length) {
        setOmittedVariableKeys(omitted);
        restored = true;
      }
      const people = Array.isArray(remembered.recipients) ? remembered.recipients.slice(0, recipientCount) : [];
      if (people.some((person) => person?.name || person?.email)) {
        restored = true;
        setRecipients((current) =>
          current.map((item, index) => {
            const person = people[index];
            if (!person) return item;
            return {
              ...item,
              name: item.name || (typeof person.name === "string" ? person.name : ""),
              email: item.email || (typeof person.email === "string" ? person.email : ""),
            };
          })
        );
      }
    }
    // Anything typed while the schema loaded wins.
    setVariableValues((current) => ({ ...next, ...nonEmpty(current) }));
    setRestoredLastValues(restored);
  }, [data, recipientCount, storageKey, variableSettings]);

  // Jump the preview to the focused field's token.
  useEffect(() => {
    if (!activeField || foundFieldRef.current === activeField) return;
    const candidates = searchCandidates(activeField);
    if (!candidates.length) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      // One query at a time: each search moves the highlight.
      const tryFrom = (index: number): Promise<boolean> => {
        const viewer = viewerRef.current;
        if (cancelled || !viewer || index >= candidates.length) return Promise.resolve(false);
        return viewer.searchText(candidates[index]).then((found) => found || tryFrom(index + 1));
      };
      tryFrom(0)
        .then((found) => {
          if (found && !cancelled) foundFieldRef.current = activeField;
          return found;
        })
        .catch(() => false);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeField, searchTick]);

  useEffect(() => {
    if (!isPreparing) {
      setProgressStep(0);
      return;
    }
    const timers = PROGRESS_STEPS.slice(1).map((step, index) =>
      window.setTimeout(() => setProgressStep(index + 1), step.after)
    );
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [isPreparing]);

  /** One error per field id, in the order the form shows them. */
  const errors = useMemo(() => {
    const result: Record<string, string> = {};
    if (!title.trim()) result.title = t(`${PREFIX}.use.validation_title`);
    for (let index = 0; index < recipientCount; index++) {
      const recipient = recipients[index];
      if (!recipient?.name?.trim()) result[`recipient:${index}:name`] = t(`${PREFIX}.use.validation_required`);
      if (!recipient?.email?.includes("@"))
        result[`recipient:${index}:email`] = t(`${PREFIX}.use.validation_email_format`);
    }
    for (const variable of variables) {
      if (omittedVariableKeys.includes(variable.key)) continue;
      const required = variableSettings[variable.key]?.required ?? variable.required;
      if (required && !variableValues[variable.key]?.trim())
        result[`variable:${variable.key}`] = t(`${PREFIX}.use.validation_required`);
    }
    return result;
  }, [omittedVariableKeys, recipientCount, recipients, t, title, variableSettings, variableValues, variables]);

  const errorCount = Object.keys(errors).length;
  const errorFor = (id: string) => {
    if (serverError?.fieldId === id) return serverError.message;
    return showAllErrors || touched.has(id) ? errors[id] : undefined;
  };
  const markTouched = (id: string) => setTouched((current) => new Set(current).add(id));

  const focusField = (id: string) => {
    if (id !== activeField) foundFieldRef.current = null;
    setActiveField(id);
    setSearchTick((tick) => tick + 1);
  };
  /** After an edit: drop a server error on this field and retry the preview search if needed. */
  const fieldEdited = (id: string) => {
    setServerError((current) => (current?.fieldId === id ? null : current));
    setSearchTick((tick) => tick + 1);
  };

  const scrollToField = (id: string) => {
    window.requestAnimationFrame(() => {
      const element = document.getElementById(domId(id));
      if (!element) return;
      element.scrollIntoView({ block: "center", behavior: "smooth" });
      element.focus({ preventScroll: true });
    });
  };

  const updateRecipient = (index: number, patch: Partial<PreparedRecipient>) =>
    setRecipients((current) => current.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item)));

  const defaultValues = () => {
    const result: Record<string, string> = {};
    for (const variable of variables) {
      const fallback = variableSettings[variable.key]?.default;
      if (typeof fallback === "string" && fallback.trim()) result[variable.key] = fallback;
    }
    return result;
  };

  const clearLastValues = () => {
    setVariableValues(defaultValues());
    setOmittedVariableKeys([]);
    setRecipients((current) => current.map((item) => ({ ...item, name: "", email: "" })));
    setRestoredLastValues(false);
    setServerError(null);
    safeStorage.set(storageKey, null);
  };

  const rememberValues = () => {
    const remembered: TRememberedValues = {
      variableValues: nonEmpty(variableValues),
      recipients: recipients.map((recipient) => ({
        name: recipient.name?.trim() ?? "",
        email: recipient.email?.trim() ?? "",
      })),
      omittedKeys: omittedVariableKeys,
      savedAt: new Date().toISOString(),
    };
    safeStorage.set(storageKey, remembered);
  };

  const prepare = async () => {
    setServerError(null);
    if (errorCount > 0) {
      setShowAllErrors(true);
      const firstError = Object.keys(errors)[0];
      if (firstError) scrollToField(firstError);
      return;
    }
    setIsPreparing(true);
    try {
      const request = await contractService.prepareSignatureRequest(workspaceSlug, {
        variant_id: variant.id,
        revision_id: revisionId,
        title: title.trim(),
        // Dates stay ISO (yyyy-mm-dd); the API writes them out in long form.
        variable_values: variableValues,
        omitted_variable_keys: omittedVariableKeys,
        recipients,
      });
      rememberValues();
      onPrepared(request);
    } catch (error: unknown) {
      const message = contractErrorMessage(t, error, `${PREFIX}.use.prepare_failed`);
      const apiError = (error ?? {}) as TContractActionError;
      let fieldId: string | undefined;
      if (apiError.error === "missing_value" && apiError.key) fieldId = `variable:${apiError.key}`;
      if (apiError.error === "missing_signer" && typeof apiError.index === "number")
        fieldId = `recipient:${apiError.index}:${apiError.field === "email" ? "email" : "name"}`;
      setServerError({ message, fieldId });
      setToast({ type: TOAST_TYPE.ERROR, title: message });
      if (fieldId) {
        // A value the server needs cannot stay "left blank".
        if (fieldId.startsWith("variable:")) {
          const key = fieldId.slice("variable:".length);
          setOmittedVariableKeys((current) => current.filter((item) => item !== key));
        }
        scrollToField(fieldId);
      }
    } finally {
      setIsPreparing(false);
    }
  };

  const previewAsset = selectedRevision
    ? {
        assetId: selectedRevision.pdf_asset_id,
        version: selectedRevision.content_sha256,
        name: t(`${PREFIX}.use.revision_file_name`, {
          name: templateName,
          number: selectedRevision.revision,
        }),
        contentType: "application/pdf" as const,
      }
    : {
        assetId: variant.source_asset_id,
        version: data?.content_sha256 ?? variant.updated_at,
        name: variant.source_file_name,
        contentType: DOCX_TYPE,
      };

  const signerLabel = (index: number) => t(`${PREFIX}.common.signer_number`, { number: index + 1 });
  /** Saved role name first; the blueprint label is often just "Firmante N". */
  const recipientTitle = (index: number) =>
    variant.recipient_roles?.[String(index)]?.trim() ||
    recipientBlueprint[index]?.placeholderLabel?.trim() ||
    signerLabel(index);

  // completion summary
  const filledVariables = variables.filter(
    (variable) => omittedVariableKeys.includes(variable.key) || variableValues[variable.key]?.trim()
  ).length;
  const filledRecipientFields = recipients
    .slice(0, recipientCount)
    .reduce(
      (count, recipient) => count + (recipient.name?.trim() ? 1 : 0) + (recipient.email?.includes("@") ? 1 : 0),
      0
    );
  const totalFields = variables.length + recipientCount * 2;
  const filledFields = filledVariables + filledRecipientFields;

  // "Así quedará" strip for the focused field
  const activePreview = (() => {
    if (!activeField) return null;
    const token = fieldToken(activeField);
    if (!token) return null;
    if (activeField.startsWith("variable:")) {
      const key = activeField.slice("variable:".length);
      const variable = variables.find((item) => item.key === key);
      if (!variable) return null;
      if (omittedVariableKeys.includes(key)) return { token, text: t(`${LIVE}.left_blank`), muted: true };
      const raw = variableValues[key] ?? "";
      if (!raw.trim()) return { token, text: t(`${LIVE}.no_value`), muted: true };
      const setting = variableSettings[key];
      return { token, text: displayValue(raw, variableKind(variable, setting), setting), muted: false };
    }
    const match = RECIPIENT_FIELD.exec(activeField);
    const recipient = match ? recipients[Number(match[1])] : undefined;
    const raw = (match?.[2] === "email" ? recipient?.email : recipient?.name) ?? "";
    return raw.trim() ? { token, text: raw.trim(), muted: false } : { token, text: t(`${LIVE}.no_value`), muted: true };
  })();

  const footerMessage = isPreparing ? (
    <span className="flex items-center gap-1.5 text-secondary" role="status">
      <Loader2 className="size-3.5 shrink-0 animate-spin" />
      {t(PROGRESS_STEPS[progressStep]?.key ?? PROGRESS_STEPS[0].key)}
    </span>
  ) : serverError ? (
    <span className="flex items-start gap-1.5 text-danger-primary" role="alert">
      <AlertTriangle className="mt-px size-3.5 shrink-0" />
      {serverError.message}
    </span>
  ) : showAllErrors && errorCount > 0 ? (
    <span className="text-warning-primary">{t(`${PREFIX}.use.validation_summary`, { count: errorCount })}</span>
  ) : null;

  return (
    <ModalCore
      isOpen
      handleClose={onClose}
      position={EModalPosition.CENTER}
      width={EModalWidth.VIXL}
      className="flex max-h-[92vh] flex-col overflow-hidden"
    >
      <header className="flex items-start justify-between border-b border-subtle px-5 py-4 sm:px-6">
        <div className="min-w-0">
          <h2 className="text-15 truncate font-semibold text-primary">
            {t(`${PREFIX}.use.title`, { name: templateName })}
          </h2>
          <p className="mt-1 text-11 text-tertiary">{t(`${PREFIX}.use.description`)}</p>
        </div>
        <button
          type="button"
          aria-label={t(`${PREFIX}.common.close`)}
          className="grid size-8 shrink-0 place-items-center rounded-md hover:bg-layer-1-hover"
          onClick={onClose}
        >
          <X className="size-4" />
        </button>
      </header>

      <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        {/* form */}
        <div className="min-h-0 overflow-y-auto p-4 sm:p-6">
          {isLoading ? (
            <ContractLoading />
          ) : (
            <div className="space-y-6">
              <div className="flex items-center gap-2 rounded-md border border-subtle bg-layer-1 px-3 py-2">
                <FileClock className="size-3.5 shrink-0 text-tertiary" />
                <span className="min-w-0 flex-1 truncate text-11 text-secondary">
                  {selectedRevision
                    ? selectedRevision.name ||
                      t(`${PREFIX}.common.version_number`, {
                        number: selectedRevision.revision,
                      })
                    : t(`${PREFIX}.use.current_document`)}
                </span>
                {data?.manual_fields_status === "REQUIRES_REVIEW" ? (
                  <span className="flex shrink-0 items-center gap-1 text-11 text-warning-primary">
                    <AlertTriangle className="size-3.5" />
                    {t(`${PREFIX}.use.fields_require_review`)}
                  </span>
                ) : data?.manual_fields_status === "COMPATIBLE" ? (
                  <span className="flex shrink-0 items-center gap-1 text-11 text-success-primary">
                    <CheckCircle2 className="size-3.5" />
                    {t(`${PREFIX}.use.fields_compatible`)}
                  </span>
                ) : null}
              </div>

              {restoredLastValues ? (
                <div className="flex items-center gap-2 rounded-md bg-accent-primary/10 px-3 py-2 text-11 text-secondary">
                  <History className="size-3.5 shrink-0 text-accent-primary" />
                  <span className="min-w-0 flex-1 truncate">{t(`${LIVE}.last_values`)}</span>
                  <button
                    type="button"
                    className="shrink-0 font-medium text-accent-primary hover:underline"
                    onClick={clearLastValues}
                  >
                    {t(`${LIVE}.clear`)}
                  </button>
                </div>
              ) : null}

              <ContractField
                label={t(`${PREFIX}.use.contract_title`)}
                error={errorFor("title")}
                htmlFor={domId("title")}
              >
                <ContractInput
                  id={domId("title")}
                  value={title}
                  hasError={Boolean(errorFor("title"))}
                  onChange={(event) => setTitle(event.target.value)}
                  onBlur={() => markTouched("title")}
                />
              </ContractField>

              {recipientCount > 0 ? (
                <section>
                  <div className="flex items-center gap-2">
                    <Users className="size-4 text-accent-primary" />
                    <h3 className="text-14 font-semibold text-primary">{t(`${PREFIX}.use.people`)}</h3>
                  </div>
                  <p className="mt-1 text-11 text-tertiary">{t(`${PREFIX}.use.people_description`)}</p>
                  <div className="mt-3 space-y-3">
                    {recipients.map((recipient, index) => {
                      const nameId = `recipient:${index}:name`;
                      const emailId = `recipient:${index}:email`;
                      const cardTitle = recipientTitle(index);
                      return (
                        <div key={recipient.clientKey} className="rounded-lg border border-subtle bg-layer-1 p-4">
                          <div className="mb-3 flex items-center justify-between gap-2">
                            <p className="min-w-0 truncate text-13 font-semibold text-primary">
                              {cardTitle}
                              {cardTitle !== signerLabel(index) ? (
                                <span className="font-normal ml-2 text-11 text-tertiary">{signerLabel(index)}</span>
                              ) : null}
                            </p>
                            <span className="shrink-0 rounded-full bg-layer-2 px-2 py-1 text-11 text-tertiary">
                              {t(roleLabelKey[recipient.role ?? "SIGNER"])}
                            </span>
                          </div>
                          <div className="grid gap-3 sm:grid-cols-2">
                            <ContractField
                              label={t(`${PREFIX}.common.name`)}
                              error={errorFor(nameId)}
                              htmlFor={domId(nameId)}
                            >
                              <PersonNameInput
                                workspaceSlug={workspaceSlug}
                                inputId={domId(nameId)}
                                value={recipient.name ?? ""}
                                hasError={Boolean(errorFor(nameId))}
                                personTags={personTags ?? []}
                                onFocus={() => focusField(nameId)}
                                onBlur={() => markTouched(nameId)}
                                onChange={(name) => {
                                  updateRecipient(index, { name });
                                  fieldEdited(nameId);
                                }}
                                onPick={(suggestion) => {
                                  updateRecipient(
                                    index,
                                    suggestion.email
                                      ? { name: suggestion.name, email: suggestion.email }
                                      : { name: suggestion.name }
                                  );
                                  fieldEdited(nameId);
                                  if (suggestion.email) fieldEdited(emailId);
                                }}
                              />
                            </ContractField>
                            <ContractField
                              label={t(`${PREFIX}.common.email`)}
                              error={errorFor(emailId)}
                              htmlFor={domId(emailId)}
                            >
                              <ContractInput
                                id={domId(emailId)}
                                type="email"
                                value={recipient.email ?? ""}
                                hasError={Boolean(errorFor(emailId))}
                                onFocus={() => focusField(emailId)}
                                onBlur={() => markTouched(emailId)}
                                onChange={(event) => {
                                  updateRecipient(index, { email: event.target.value });
                                  fieldEdited(emailId);
                                }}
                              />
                            </ContractField>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              ) : null}

              {variables.length > 0 ? (
                <section>
                  <div className="flex items-center gap-2">
                    <Braces className="size-4 text-accent-primary" />
                    <h3 className="text-14 font-semibold text-primary">{t(`${PREFIX}.use.document_data`)}</h3>
                  </div>
                  <p className="mt-1 text-11 text-tertiary">{t(`${LIVE}.document_data_description`)}</p>
                  <div className="mt-3 space-y-3">
                    {variables.map((variable) => {
                      const skipped = omittedVariableKeys.includes(variable.key);
                      const fieldId = `variable:${variable.key}`;
                      const setting = variableSettings[variable.key];
                      const kind = variableKind(variable, setting);
                      const value = variableValues[variable.key] ?? "";
                      const error = skipped ? undefined : errorFor(fieldId);
                      const options = (setting?.options ?? []).filter((option) => option.trim());
                      const setValue = (next: string) => {
                        setVariableValues((current) => ({ ...current, [variable.key]: next }));
                        fieldEdited(fieldId);
                      };

                      const hints: string[] = [];
                      if (setting?.help?.trim()) hints.push(setting.help.trim());
                      const formatted = value.trim() ? displayValue(value, kind, setting) : "";
                      if (
                        formatted &&
                        formatted !== value &&
                        (kind === "date" || kind === "number" || kind === "currency")
                      )
                        hints.push(t(`${LIVE}.date_hint`, { value: formatted }));
                      else if (kind === "currency") hints.push(t(`${LIVE}.currency_hint`));
                      if (variable.occurrences > 1)
                        hints.push(t(`${PREFIX}.use.occurrences`, { count: variable.occurrences }));

                      const inputType =
                        kind === "date"
                          ? !value || ISO_DATE.test(value)
                            ? "date"
                            : "text"
                          : kind === "number" || kind === "currency"
                            ? "number"
                            : "text";

                      return (
                        <ContractField
                          key={variable.key}
                          label={variableLabel(variable.key, variable.label, setting)}
                          optional={!isRequired(variable)}
                          optionalLabel={t(`${PREFIX}.common.optional`)}
                          htmlFor={kind === "choice" && options.length ? undefined : domId(fieldId)}
                          error={error}
                          hint={hints.length ? hints.join(" · ") : undefined}
                        >
                          <div className="flex items-center gap-2">
                            {kind === "choice" && options.length ? (
                              <div
                                id={domId(fieldId)}
                                tabIndex={-1}
                                className="min-w-0 flex-1 outline-none"
                                onFocus={() => focusField(fieldId)}
                                onBlur={() => markTouched(fieldId)}
                              >
                                <ContractSelect
                                  value={value}
                                  options={options.map((option) => ({ value: option, label: option }))}
                                  placeholder={t(`${LIVE}.choose_option`)}
                                  disabled={skipped}
                                  hasError={Boolean(error)}
                                  ariaLabel={variableLabel(variable.key, variable.label, setting)}
                                  onChange={setValue}
                                />
                              </div>
                            ) : (
                              <ContractInput
                                id={domId(fieldId)}
                                type={inputType}
                                inputMode={inputType === "number" ? "decimal" : undefined}
                                step={inputType === "number" ? (kind === "currency" ? "0.01" : "any") : undefined}
                                disabled={skipped}
                                value={value}
                                hasError={Boolean(error)}
                                onFocus={() => focusField(fieldId)}
                                onBlur={() => markTouched(fieldId)}
                                onChange={(event) => setValue(event.target.value)}
                              />
                            )}
                            {/* Leaving a value out is the exception, so that is what gets a toggle. */}
                            <ContractCheckbox
                              className="shrink-0 whitespace-nowrap"
                              checked={skipped}
                              label={t(`${PREFIX}.use.leave_blank`)}
                              onChange={(checked) => {
                                setOmittedVariableKeys((current) =>
                                  checked ? [...current, variable.key] : current.filter((key) => key !== variable.key)
                                );
                                setActiveField(fieldId);
                                fieldEdited(fieldId);
                              }}
                            />
                          </div>
                        </ContractField>
                      );
                    })}
                  </div>
                </section>
              ) : null}
            </div>
          )}
        </div>

        {/* the document being filled */}
        <aside className="hidden min-h-0 flex-col border-l border-subtle bg-layer-1 lg:flex">
          <div className="flex items-center justify-between gap-2 border-b border-subtle px-4 py-2.5">
            <p className="min-w-0 truncate text-11 font-medium text-secondary">{previewAsset.name}</p>
            <Button variant="secondary" size="sm" onClick={onEditWord}>
              <FilePenLine className="size-3.5" /> {t(`${PREFIX}.use.edit_variables`)}
            </Button>
          </div>
          <div
            className="flex min-h-9 items-center gap-3 border-b border-subtle px-4 py-1.5 text-11"
            aria-live="polite"
          >
            {activePreview ? (
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <span className="shrink-0 font-medium text-secondary">{t(`${LIVE}.preview_label`)}</span>
                <code className="font-mono max-w-[40%] shrink-0 truncate rounded-sm bg-layer-2 px-1.5 py-0.5 text-10 text-tertiary">
                  {activePreview.token}
                </code>
                <ArrowRight className="size-3 shrink-0 text-tertiary" aria-hidden />
                <span
                  className={cn(
                    "min-w-0 truncate",
                    activePreview.muted ? "text-tertiary italic" : "font-medium text-primary"
                  )}
                >
                  {activePreview.text}
                </span>
              </div>
            ) : (
              <p className="min-w-0 flex-1 truncate text-tertiary">{t(`${LIVE}.preview_hint`)}</p>
            )}
            {totalFields > 0 ? (
              <span
                className={cn(
                  "shrink-0 tabular-nums",
                  filledFields === totalFields ? "text-success-primary" : "text-tertiary"
                )}
              >
                {t(`${LIVE}.filled_count`, { filled: filledFields, total: totalFields })}
              </span>
            ) : null}
          </div>
          <div className="min-h-0 flex-1 p-3">
            <ContractAssetPreview
              key={`${previewAsset.assetId}-${previewAsset.version}`}
              viewerRef={viewerRef}
              workspaceSlug={workspaceSlug}
              assetId={previewAsset.assetId}
              fileName={previewAsset.name}
              contentType={previewAsset.contentType}
              version={previewAsset.version}
              className="size-full overflow-hidden rounded-md border border-subtle bg-surface-1"
            />
          </div>
        </aside>
      </div>

      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-subtle px-5 py-4 sm:px-6">
        <div className="min-w-0 flex-1 text-11">{footerMessage}</div>
        <div className="ml-auto flex gap-2">
          <Button variant="secondary" size="sm" disabled={isPreparing} onClick={onClose}>
            {t(`${PREFIX}.common.cancel`)}
          </Button>
          <Button variant="primary" size="sm" disabled={isPreparing || isLoading} onClick={() => void prepare()}>
            {isPreparing ? <Loader2 className="size-4 animate-spin" /> : null}
            {t(`${PREFIX}.use.prepare`)}
          </Button>
        </div>
      </footer>
    </ModalCore>
  );
}
