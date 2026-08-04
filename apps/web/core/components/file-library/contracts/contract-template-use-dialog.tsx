/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * "Use this template" — the form that turns a template into a contract.
 *
 * Two things changed from the first version: validation is now per field
 * (the footer used to surface one error at a time, so an eight-variable form
 * meant eight round trips), and the right pane shows the document being filled
 * instead of a list of `{{tokens}}` to copy, which is authoring-time
 * information the person filling the form does not need.
 */

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Braces, CheckCircle2, FileClock, FilePenLine, Loader2, Users, X } from "lucide-react";
import useSWR from "swr";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TContractAuthoringRecipient, TContractSignatureRequest, TContractTemplateVariant } from "@plane/types";
import { EModalPosition, EModalWidth, ModalCore } from "@plane/ui";
import { contractService } from "@/services/contract.service";
import { ContractAssetPreview } from "./contract-asset-preview";
import { ContractCheckbox, ContractField, ContractInput, ContractLoading } from "./ui";

type Props = {
  workspaceSlug: string;
  templateName: string;
  variant: TContractTemplateVariant;
  onEditWord: () => void;
  onClose: () => void;
  onPrepared: (request: TContractSignatureRequest) => void;
  initialRevisionId?: string;
};

type PreparedRecipient = Partial<TContractAuthoringRecipient> & { clientKey: string };

const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const roleLabelKey: Record<TContractAuthoringRecipient["role"], string> = {
  SIGNER: "file_library.contracts.workflow.roles.signer",
  APPROVER: "file_library.contracts.workflow.roles.approver",
  ASSISTANT: "file_library.contracts.workflow.roles.assistant",
  VIEWER: "file_library.contracts.workflow.roles.viewer",
  CC: "file_library.contracts.workflow.roles.cc",
};

export function ContractTemplateUseDialog({
  workspaceSlug,
  templateName,
  variant,
  onEditWord,
  onClose,
  onPrepared,
  initialRevisionId,
}: Props) {
  const { t } = useTranslation();
  const selectedSource = initialRevisionId ?? "CURRENT";
  const [title, setTitle] = useState(templateName);
  const [variableValues, setVariableValues] = useState<Record<string, string>>({});
  const [omittedVariableKeys, setOmittedVariableKeys] = useState<string[]>([]);
  const [recipients, setRecipients] = useState<PreparedRecipient[]>([]);
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [showAllErrors, setShowAllErrors] = useState(false);
  const [isPreparing, setIsPreparing] = useState(false);
  const revisionId = selectedSource === "CURRENT" ? undefined : selectedSource;
  const { data, isLoading } = useSWR(
    `CONTRACT_TEMPLATE_SCHEMA_${workspaceSlug}_${variant.id}_${selectedSource}`,
    () => contractService.getTemplateSchema(workspaceSlug, variant.id, revisionId),
    { revalidateOnFocus: false }
  );

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
          placeholderLabel:
            blueprint?.placeholderLabel ??
            t("file_library.contracts.workflow.common.signer_number", { number: index + 1 }),
          role: previous.role ?? blueprint?.role ?? "SIGNER",
          signingOrder: index + 1,
          actionAuth: previous.actionAuth ?? blueprint?.actionAuth ?? [],
        };
      })
    );
  }, [recipientBlueprint, recipientCount, t]);

  useEffect(() => {
    const availableKeys = new Set(data?.schema.variables.map((variable) => variable.key) ?? []);
    setOmittedVariableKeys((current) => current.filter((key) => availableKeys.has(key)));
  }, [data?.schema.variables]);

  /** One error per field id, so every problem can be shown at once. */
  const errors = useMemo(() => {
    const result: Record<string, string> = {};
    if (!title.trim()) result.title = t("file_library.contracts.workflow.use.validation_title");
    for (const variable of data?.schema.variables ?? []) {
      if (omittedVariableKeys.includes(variable.key)) continue;
      if (variable.required && !variableValues[variable.key]?.trim())
        result[`variable:${variable.key}`] = t("file_library.contracts.workflow.use.validation_required");
    }
    for (let index = 0; index < recipientCount; index++) {
      const recipient = recipients[index];
      if (!recipient?.name?.trim())
        result[`recipient:${index}:name`] = t("file_library.contracts.workflow.use.validation_required");
      if (!recipient?.email?.includes("@"))
        result[`recipient:${index}:email`] = t("file_library.contracts.workflow.use.validation_email_format");
    }
    return result;
  }, [data?.schema.variables, omittedVariableKeys, recipientCount, recipients, t, title, variableValues]);

  const errorCount = Object.keys(errors).length;
  const errorFor = (id: string) => (showAllErrors || touched.has(id) ? errors[id] : undefined);
  const markTouched = (id: string) => setTouched((current) => new Set(current).add(id));

  const prepare = async () => {
    if (errorCount > 0) {
      setShowAllErrors(true);
      return;
    }
    setIsPreparing(true);
    try {
      const request = await contractService.prepareSignatureRequest(workspaceSlug, {
        variant_id: variant.id,
        revision_id: revisionId,
        title: title.trim(),
        variable_values: variableValues,
        omitted_variable_keys: omittedVariableKeys,
        recipients,
      });
      onPrepared(request);
    } catch (error: any) {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: error?.error ?? t("file_library.contracts.workflow.use.prepare_failed"),
      });
    } finally {
      setIsPreparing(false);
    }
  };

  const previewAsset = selectedRevision
    ? {
        assetId: selectedRevision.pdf_asset_id,
        version: selectedRevision.content_sha256,
        name: t("file_library.contracts.workflow.use.revision_file_name", {
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
            {t("file_library.contracts.workflow.use.title", { name: templateName })}
          </h2>
          <p className="mt-1 text-11 text-tertiary">{t("file_library.contracts.workflow.use.description")}</p>
        </div>
        <button
          type="button"
          aria-label={t("file_library.contracts.workflow.common.close")}
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
                      t("file_library.contracts.workflow.common.version_number", {
                        number: selectedRevision.revision,
                      })
                    : t("file_library.contracts.workflow.use.current_document")}
                </span>
                {data?.manual_fields_status === "REQUIRES_REVIEW" ? (
                  <span className="flex shrink-0 items-center gap-1 text-11 text-warning-primary">
                    <AlertTriangle className="size-3.5" />
                    {t("file_library.contracts.workflow.use.fields_require_review")}
                  </span>
                ) : data?.manual_fields_status === "COMPATIBLE" ? (
                  <span className="flex shrink-0 items-center gap-1 text-11 text-success-primary">
                    <CheckCircle2 className="size-3.5" />
                    {t("file_library.contracts.workflow.use.fields_compatible")}
                  </span>
                ) : null}
              </div>

              <ContractField label={t("file_library.contracts.workflow.use.contract_title")} error={errorFor("title")}>
                <ContractInput
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
                    <h3 className="text-14 font-semibold text-primary">
                      {t("file_library.contracts.workflow.use.people")}
                    </h3>
                  </div>
                  <p className="mt-1 text-11 text-tertiary">
                    {t("file_library.contracts.workflow.use.people_description")}
                  </p>
                  <div className="mt-3 space-y-3">
                    {recipients.map((recipient, index) => (
                      <div key={recipient.clientKey} className="rounded-lg border border-subtle bg-layer-1 p-4">
                        <div className="mb-3 flex items-center justify-between gap-2">
                          <p className="text-13 font-semibold text-primary">
                            {recipient.placeholderLabel ??
                              t("file_library.contracts.workflow.common.signer_number", { number: index + 1 })}
                          </p>
                          <span className="rounded-full bg-layer-2 px-2 py-1 text-11 text-tertiary">
                            {t(roleLabelKey[recipient.role ?? "SIGNER"])}
                          </span>
                        </div>
                        <div className="grid gap-3 sm:grid-cols-2">
                          <ContractField
                            label={t("file_library.contracts.workflow.common.name")}
                            error={errorFor(`recipient:${index}:name`)}
                          >
                            <ContractInput
                              value={recipient.name ?? ""}
                              hasError={Boolean(errorFor(`recipient:${index}:name`))}
                              onBlur={() => markTouched(`recipient:${index}:name`)}
                              onChange={(event) =>
                                setRecipients((current) =>
                                  current.map((item, itemIndex) =>
                                    itemIndex === index ? { ...item, name: event.target.value } : item
                                  )
                                )
                              }
                            />
                          </ContractField>
                          <ContractField
                            label={t("file_library.contracts.workflow.common.email")}
                            error={errorFor(`recipient:${index}:email`)}
                          >
                            <ContractInput
                              type="email"
                              value={recipient.email ?? ""}
                              hasError={Boolean(errorFor(`recipient:${index}:email`))}
                              onBlur={() => markTouched(`recipient:${index}:email`)}
                              onChange={(event) =>
                                setRecipients((current) =>
                                  current.map((item, itemIndex) =>
                                    itemIndex === index ? { ...item, email: event.target.value } : item
                                  )
                                )
                              }
                            />
                          </ContractField>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}

              {(data?.schema.variables ?? []).length > 0 ? (
                <section>
                  <div className="flex items-center gap-2">
                    <Braces className="size-4 text-accent-primary" />
                    <h3 className="text-14 font-semibold text-primary">
                      {t("file_library.contracts.workflow.use.document_data")}
                    </h3>
                  </div>
                  <p className="mt-1 text-11 text-tertiary">
                    {t("file_library.contracts.workflow.use.document_data_description")}
                  </p>
                  <div className="mt-3 space-y-3">
                    {data?.schema.variables.map((variable) => {
                      const skipped = omittedVariableKeys.includes(variable.key);
                      const fieldId = `variable:${variable.key}`;
                      return (
                        <ContractField
                          key={variable.key}
                          label={variable.label}
                          error={skipped ? undefined : errorFor(fieldId)}
                          hint={
                            variable.occurrences > 1
                              ? t("file_library.contracts.workflow.use.occurrences", {
                                  count: variable.occurrences,
                                })
                              : undefined
                          }
                        >
                          <div className="flex items-center gap-2">
                            <ContractInput
                              type={variable.type}
                              disabled={skipped}
                              value={variableValues[variable.key] ?? ""}
                              hasError={!skipped && Boolean(errorFor(fieldId))}
                              onBlur={() => markTouched(fieldId)}
                              onChange={(event) =>
                                setVariableValues((current) => ({ ...current, [variable.key]: event.target.value }))
                              }
                            />
                            {/* Inverted from the original "Apply": leaving a value
                                out is the exception, so that is what gets a toggle. */}
                            <ContractCheckbox
                              className="shrink-0 whitespace-nowrap"
                              checked={skipped}
                              label={t("file_library.contracts.workflow.use.leave_blank")}
                              onChange={(checked) =>
                                setOmittedVariableKeys((current) =>
                                  checked ? [...current, variable.key] : current.filter((key) => key !== variable.key)
                                )
                              }
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
              <FilePenLine className="size-3.5" /> {t("file_library.contracts.workflow.use.edit_variables")}
            </Button>
          </div>
          <div className="min-h-0 flex-1 p-3">
            <ContractAssetPreview
              key={`${previewAsset.assetId}-${previewAsset.version}`}
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
        <p className="min-w-0 text-11 text-warning-primary">
          {showAllErrors && errorCount > 0
            ? t("file_library.contracts.workflow.use.validation_summary", { count: errorCount })
            : ""}
        </p>
        <div className="ml-auto flex gap-2">
          <Button variant="secondary" size="sm" disabled={isPreparing} onClick={onClose}>
            {t("file_library.contracts.workflow.common.cancel")}
          </Button>
          <Button variant="primary" size="sm" disabled={isPreparing || isLoading} onClick={() => void prepare()}>
            {isPreparing ? <Loader2 className="size-4 animate-spin" /> : null}
            {t("file_library.contracts.workflow.use.prepare")}
          </Button>
        </div>
      </footer>
    </ModalCore>
  );
}
