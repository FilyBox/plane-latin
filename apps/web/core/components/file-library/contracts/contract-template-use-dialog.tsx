/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Braces,
  Check,
  CheckCircle2,
  Copy,
  Eye,
  FileClock,
  FilePenLine,
  Loader2,
  Users,
  X,
} from "lucide-react";
import useSWR from "swr";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TContractAuthoringRecipient, TContractSignatureRequest, TContractTemplateVariant } from "@plane/types";
import { EModalPosition, EModalWidth, ModalCore } from "@plane/ui";
import { contractService } from "@/services/contract.service";
import { FilePreviewModal, type TPreviewFile } from "../file-preview-modal";

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

const INPUT_CLASS =
  "mt-1.5 h-9 w-full rounded-md border border-subtle bg-surface-1 px-3 text-11 text-primary outline-none focus:border-accent-primary disabled:cursor-not-allowed disabled:bg-layer-1 disabled:text-tertiary";

const roleLabelKey: Record<TContractAuthoringRecipient["role"], string> = {
  SIGNER: "file_library.contracts.workflow.roles.signer",
  APPROVER: "file_library.contracts.workflow.roles.approver",
  ASSISTANT: "file_library.contracts.workflow.roles.assistant",
  VIEWER: "file_library.contracts.workflow.roles.viewer",
  CC: "file_library.contracts.workflow.roles.cc",
};

const suggestedVariables = [
  "{{NombreFirmante1}}",
  "{{CorreoFirmante1}}",
  "{{FirmaFirmante1}}",
  "{{InicialesFirmante1}}",
  "{{FechaFirmaFirmante1}}",
  "{{TextoFirmante1}}",
  "{{NumeroFirmante1}}",
  "{{CasillaFirmante1}}",
  "{{ListaFirmante1}}",
  "{{CualquierDato}}",
];

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
  const [copiedToken, setCopiedToken] = useState<string>();
  const [isPreparing, setIsPreparing] = useState(false);
  const [previewFile, setPreviewFile] = useState<TPreviewFile | null>(null);
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

  const detectedTokens = useMemo(() => {
    if (!data) return [];
    const tokens = [
      ...data.schema.variables.map((variable) => `{{${variable.key}}}`),
      ...data.schema.signing_fields.map((field) => `{{${field.key}}}`),
    ];
    data.schema.recipients.forEach((recipient) => {
      if (recipient.requires_name) tokens.push(`{{NombreFirmante${recipient.index + 1}}}`);
      if (recipient.requires_email) tokens.push(`{{CorreoFirmante${recipient.index + 1}}}`);
    });
    return [...new Set(tokens)];
  }, [data]);

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

  const validationMessage = useMemo(() => {
    if (!title.trim()) return t("file_library.contracts.workflow.use.validation_title");
    for (const variable of data?.schema.variables ?? []) {
      if (!omittedVariableKeys.includes(variable.key) && variable.required && !variableValues[variable.key]?.trim())
        return t("file_library.contracts.workflow.use.validation_variable", { name: variable.label });
    }
    for (let index = 0; index < recipientCount; index++) {
      const recipient = recipients[index];
      const label =
        recipient?.placeholderLabel ?? t("file_library.contracts.workflow.common.signer_number", { number: index + 1 });
      if (!recipient?.name?.trim()) return t("file_library.contracts.workflow.use.validation_name", { name: label });
      if (!recipient.email?.includes("@"))
        return t("file_library.contracts.workflow.use.validation_email", { name: label });
    }
    return undefined;
  }, [data?.schema.variables, omittedVariableKeys, recipientCount, recipients, t, title, variableValues]);

  const copyVariable = async (token: string) => {
    await navigator.clipboard.writeText(token);
    setCopiedToken(token);
    window.setTimeout(() => setCopiedToken((current) => (current === token ? undefined : current)), 1600);
  };

  const prepare = async () => {
    if (validationMessage) return;
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

  const handleDialogClose = () => {
    if (previewFile) {
      setPreviewFile(null);
      return;
    }
    onClose();
  };

  return (
    <>
      <ModalCore
        isOpen
        handleClose={handleDialogClose}
        position={EModalPosition.CENTER}
        width={EModalWidth.XXXXL}
        className="flex max-h-[92vh] flex-col overflow-hidden"
      >
        <header className="flex items-start justify-between border-b border-subtle px-5 py-4 sm:px-6">
          <div>
            <h2 className="text-15 font-semibold text-primary">
              {t("file_library.contracts.workflow.use.title", { name: templateName })}
            </h2>
            <p className="mt-1 text-11 text-tertiary">{t("file_library.contracts.workflow.use.description")}</p>
          </div>
          <button
            type="button"
            className="grid size-8 place-items-center rounded-md hover:bg-layer-1-hover"
            onClick={onClose}
          >
            <X className="size-4" />
          </button>
        </header>

        <div className="flex items-center gap-2 border-b border-subtle bg-layer-1 px-5 py-2.5 text-10 text-tertiary sm:px-6">
          <span className="font-medium text-primary">{t("file_library.contracts.workflow.use.step_version")}</span>
          <span>→</span>
          <span className="font-medium text-primary">{t("file_library.contracts.workflow.use.step_data")}</span>
          <span>→</span>
          <span>{t("file_library.contracts.workflow.use.step_review")}</span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
            <div className="min-w-0 space-y-5">
              <section className="rounded-lg border border-subtle p-4">
                <div className="flex items-center gap-2">
                  <FileClock className="size-4 text-accent-primary" />
                  <h3 className="text-12 font-semibold text-primary">
                    {t("file_library.contracts.workflow.use.document_version")}
                  </h3>
                </div>
                <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                  <div className="flex h-9 min-w-0 flex-1 items-center rounded-md border border-subtle bg-layer-1 px-3 text-11 text-primary">
                    <FileClock className="mr-2 size-3.5 shrink-0 text-tertiary" />
                    <span className="truncate">
                      {selectedRevision
                        ? selectedRevision.name ||
                          t("file_library.contracts.workflow.common.version_number", {
                            number: selectedRevision.revision,
                          })
                        : t("file_library.contracts.workflow.use.current_document")}
                    </span>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      setPreviewFile({
                        assetId: selectedRevision?.source_asset_id ?? variant.source_asset_id,
                        name:
                          selectedRevision != null
                            ? t("file_library.contracts.workflow.use.revision_file_name", {
                                name: templateName,
                                number: selectedRevision.revision,
                              })
                            : variant.source_file_name,
                        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                      })
                    }
                  >
                    <Eye className="size-4" /> {t("file_library.contracts.workflow.common.preview")}
                  </Button>
                </div>
                {data?.manual_fields_status === "REQUIRES_REVIEW" ? (
                  <div className="mt-3 flex gap-2 rounded-md bg-warning-primary/10 p-3 text-10 text-warning-primary">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                    {t("file_library.contracts.workflow.use.fields_require_review")}
                  </div>
                ) : data?.manual_fields_status === "COMPATIBLE" ? (
                  <div className="mt-3 flex gap-2 rounded-md bg-success-primary/10 p-3 text-10 text-success-primary">
                    <CheckCircle2 className="size-4 shrink-0" />
                    {t("file_library.contracts.workflow.use.fields_compatible")}
                  </div>
                ) : null}
              </section>

              <label className="block text-11 font-medium text-secondary">
                {t("file_library.contracts.workflow.use.contract_title")}
                <input className={INPUT_CLASS} value={title} onChange={(event) => setTitle(event.target.value)} />
              </label>

              {isLoading ? (
                <div className="grid min-h-40 place-items-center">
                  <Loader2 className="size-5 animate-spin text-tertiary" />
                </div>
              ) : null}

              {recipientCount > 0 ? (
                <section>
                  <div className="flex items-center gap-2">
                    <Users className="size-4 text-accent-primary" />
                    <h3 className="text-12 font-semibold text-primary">
                      {t("file_library.contracts.workflow.use.people")}
                    </h3>
                  </div>
                  <p className="mt-1 text-10 text-tertiary">
                    {t("file_library.contracts.workflow.use.people_description")}
                  </p>
                  <div className="mt-3 space-y-3">
                    {recipients.map((recipient, index) => (
                      <div key={recipient.clientKey} className="rounded-lg border border-subtle p-4">
                        <div className="mb-3 flex items-center justify-between gap-2">
                          <p className="text-11 font-semibold text-primary">
                            {recipient.placeholderLabel ??
                              t("file_library.contracts.workflow.common.signer_number", { number: index + 1 })}
                          </p>
                          <span className="rounded-full bg-layer-2 px-2 py-1 text-9 text-tertiary">
                            {t(roleLabelKey[recipient.role ?? "SIGNER"])}
                          </span>
                        </div>
                        <div className="grid gap-3 sm:grid-cols-2">
                          <label className="text-10 font-medium text-secondary">
                            {t("file_library.contracts.workflow.common.name")}
                            <input
                              className={INPUT_CLASS}
                              value={recipient.name ?? ""}
                              onChange={(event) =>
                                setRecipients((current) =>
                                  current.map((item, itemIndex) =>
                                    itemIndex === index ? { ...item, name: event.target.value } : item
                                  )
                                )
                              }
                            />
                          </label>
                          <label className="text-10 font-medium text-secondary">
                            {t("file_library.contracts.workflow.common.email")}
                            <input
                              className={INPUT_CLASS}
                              type="email"
                              value={recipient.email ?? ""}
                              onChange={(event) =>
                                setRecipients((current) =>
                                  current.map((item, itemIndex) =>
                                    itemIndex === index ? { ...item, email: event.target.value } : item
                                  )
                                )
                              }
                            />
                          </label>
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
                    <h3 className="text-12 font-semibold text-primary">
                      {t("file_library.contracts.workflow.use.document_data")}
                    </h3>
                  </div>
                  <p className="mt-1 text-10 text-tertiary">
                    {t("file_library.contracts.workflow.use.document_data_description")}
                  </p>
                  <div className="mt-3 space-y-2">
                    {data?.schema.variables.map((variable) => {
                      const enabled = !omittedVariableKeys.includes(variable.key);
                      return (
                        <div key={variable.key} className="rounded-lg border border-subtle p-3">
                          <div className="mb-2 flex min-w-0 items-center justify-between gap-3">
                            <span className="truncate text-10 font-medium text-secondary">{variable.label}</span>
                            <label className="flex h-9 shrink-0 cursor-pointer items-center gap-2 rounded-md border border-subtle px-3 text-11 text-secondary hover:bg-layer-1-hover">
                              <input
                                type="checkbox"
                                checked={enabled}
                                onChange={(event) =>
                                  setOmittedVariableKeys((current) =>
                                    event.target.checked
                                      ? current.filter((key) => key !== variable.key)
                                      : [...current, variable.key]
                                  )
                                }
                              />
                              {t("file_library.contracts.workflow.common.apply")}
                            </label>
                          </div>
                          <label className="block">
                            <input
                              className={INPUT_CLASS}
                              type={variable.type}
                              disabled={!enabled}
                              value={variableValues[variable.key] ?? ""}
                              onChange={(event) =>
                                setVariableValues((current) => ({ ...current, [variable.key]: event.target.value }))
                              }
                            />
                            <span className="font-normal mt-1 block text-tertiary">
                              {`{{${variable.key}}}`}
                              {variable.occurrences > 1
                                ? ` · ${t("file_library.contracts.workflow.use.occurrences", {
                                    count: variable.occurrences,
                                  })}`
                                : ""}
                            </span>
                          </label>
                        </div>
                      );
                    })}
                  </div>
                </section>
              ) : null}
            </div>

            <aside className="h-fit overflow-hidden rounded-lg border border-subtle lg:sticky lg:top-0">
              <div className="border-b border-subtle p-4">
                <h3 className="text-11 font-semibold text-primary">
                  {t("file_library.contracts.workflow.use.version_variables")}
                </h3>
                <p className="mt-1 text-10 leading-4 text-tertiary">
                  {t("file_library.contracts.workflow.use.version_variables_description")}
                </p>
                {data ? (
                  <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                    <div className="rounded-md bg-layer-1 p-2">
                      <strong className="block text-12 text-primary">{data.schema.variables.length}</strong>
                      <span className="text-9 text-tertiary">{t("file_library.contracts.workflow.use.data")}</span>
                    </div>
                    <div className="rounded-md bg-layer-1 p-2">
                      <strong className="block text-12 text-primary">{recipientCount}</strong>
                      <span className="text-9 text-tertiary">
                        {t("file_library.contracts.workflow.use.people_count")}
                      </span>
                    </div>
                    <div className="rounded-md bg-layer-1 p-2">
                      <strong className="block text-12 text-primary">
                        {data.schema.signing_fields.length + data.manual_field_count}
                      </strong>
                      <span className="text-9 text-tertiary">{t("file_library.contracts.workflow.use.fields")}</span>
                    </div>
                  </div>
                ) : null}
              </div>

              <div className="max-h-52 space-y-1 overflow-y-auto p-3">
                {detectedTokens.length ? (
                  detectedTokens.map((token) => (
                    <button
                      key={token}
                      type="button"
                      className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-10 hover:bg-layer-1-hover"
                      onClick={() => void copyVariable(token)}
                    >
                      <code className="truncate">{token}</code>
                      {copiedToken === token ? (
                        <Check className="size-3.5 text-success-primary" />
                      ) : (
                        <Copy className="size-3.5 text-tertiary" />
                      )}
                    </button>
                  ))
                ) : !isLoading ? (
                  <div className="px-2 py-5 text-center text-10 text-tertiary">
                    {t("file_library.contracts.workflow.use.no_markers")}
                  </div>
                ) : null}
              </div>

              <div className="border-t border-subtle p-3">
                <Button variant="secondary" size="sm" className="w-full" onClick={onEditWord}>
                  <FilePenLine className="size-4" /> {t("file_library.contracts.workflow.use.edit_variables")}
                </Button>
                <p className="mt-2 text-9 leading-4 text-tertiary">
                  {t("file_library.contracts.workflow.use.edit_variables_hint")}
                </p>
              </div>

              <details className="border-t border-subtle p-3">
                <summary className="cursor-pointer text-10 font-medium text-secondary">
                  {t("file_library.contracts.workflow.use.available_variables")}
                </summary>
                <div className="mt-2 space-y-1">
                  {suggestedVariables.map((token) => (
                    <button
                      key={token}
                      type="button"
                      className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-9 hover:bg-layer-1-hover"
                      onClick={() => void copyVariable(token)}
                    >
                      <code>{token}</code>
                      <Copy className="size-3 text-tertiary" />
                    </button>
                  ))}
                </div>
              </details>
            </aside>
          </div>
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-subtle px-5 py-4 sm:px-6">
          <p className="min-w-0 text-10 text-warning-primary">{validationMessage}</p>
          <div className="ml-auto flex gap-2">
            <Button variant="secondary" size="sm" disabled={isPreparing} onClick={onClose}>
              {t("file_library.contracts.workflow.common.cancel")}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={isPreparing || isLoading || Boolean(validationMessage)}
              onClick={() => void prepare()}
            >
              {isPreparing ? <Loader2 className="size-4 animate-spin" /> : null}
              {t("file_library.contracts.workflow.use.prepare")}
            </Button>
          </div>
        </footer>
      </ModalCore>
      <FilePreviewModal
        workspaceSlug={workspaceSlug}
        file={previewFile}
        onClose={() => setPreviewFile(null)}
        scope="contract"
        readOnly
      />
    </>
  );
}
