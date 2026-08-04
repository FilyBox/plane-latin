/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * Template library + creation flow.
 *
 * Creating a template used to chain four contexts (upload modal → redirect with
 * `?edit=1` → Collabora opening by itself → decision dialog). It is now a two
 * step modal that ends by telling the user what was actually detected in their
 * Word file, and never opens an editor nobody asked for.
 */

import { useState } from "react";
import {
  Braces,
  CheckCircle2,
  ChevronRight,
  FilePlus2,
  FileText,
  Loader2,
  Plus,
  Trash2,
  Upload,
  UserRound,
} from "lucide-react";
import { Link, useNavigate } from "react-router";
import useSWR from "swr";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TContractTemplate, TContractTemplateSchemaResponse } from "@plane/types";
import { AlertModalCore, EModalPosition, EModalWidth, ModalCore } from "@plane/ui";
import { cn } from "@plane/utils";
import { contractService } from "@/services/contract.service";
import {
  ContractEmptyState,
  ContractField,
  ContractInput,
  ContractLoading,
  ContractPageHeader,
  ContractSection,
  ContractTextarea,
} from "./ui";

type Props = { workspaceSlug: string };

/** Result of the upload step — drives the "what we detected" screen. */
type CreatedTemplate = { template: TContractTemplate; schema?: TContractTemplateSchemaResponse };

export function ContractWorkflow({ workspaceSlug }: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const {
    data: templates,
    mutate,
    isLoading,
  } = useSWR(`CONTRACT_TEMPLATES_${workspaceSlug}`, () => contractService.getTemplates(workspaceSlug), {
    revalidateOnFocus: false,
  });
  const [uploadOpen, setUploadOpen] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const [templateDescription, setTemplateDescription] = useState("");
  const [templateFile, setTemplateFile] = useState<File>();
  const [isUploading, setIsUploading] = useState(false);
  const [created, setCreated] = useState<CreatedTemplate>();
  const [deletingTemplate, setDeletingTemplate] = useState<TContractTemplate>();
  const [isDeleting, setIsDeleting] = useState(false);

  const closeCreation = () => {
    setUploadOpen(false);
    setCreated(undefined);
    setTemplateName("");
    setTemplateDescription("");
    setTemplateFile(undefined);
  };

  const uploadTemplate = async () => {
    if (!templateFile || !templateName.trim()) return;
    setIsUploading(true);
    try {
      const template = await contractService.createTemplate(workspaceSlug, {
        name: templateName.trim(),
        description: templateDescription.trim(),
        file: templateFile,
      });
      await mutate();
      // Read back what the parser found so step 2 can report it. A schema
      // failure must not block the flow — the template already exists.
      const variantId = template.variants[0]?.id;
      const schema = variantId
        ? await contractService.getTemplateSchema(workspaceSlug, variantId).catch(() => undefined)
        : undefined;
      setCreated({ template, schema });
    } catch (error: any) {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: error?.error ?? t("file_library.contracts.workflow.templates.create_failed"),
      });
    } finally {
      setIsUploading(false);
    }
  };

  const deleteTemplate = async () => {
    if (!deletingTemplate) return;
    setIsDeleting(true);
    try {
      await contractService.deleteTemplate(workspaceSlug, deletingTemplate.id);
      await mutate();
      setDeletingTemplate(undefined);
      setToast({ type: TOAST_TYPE.SUCCESS, title: t("file_library.contracts.workflow.templates.deleted") });
    } catch (error: any) {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: error?.error ?? t("file_library.contracts.workflow.templates.delete_failed"),
      });
    } finally {
      setIsDeleting(false);
    }
  };

  const goToTemplate = (templateId: string) => {
    closeCreation();
    navigate(`/${workspaceSlug}/file-library/contracts/templates/${templateId}`);
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl space-y-5 px-4 py-6 sm:px-6 lg:px-8">
        <ContractPageHeader
          title={t("file_library.contracts.workflow.templates.title")}
          description={t("file_library.contracts.workflow.templates.description")}
          actions={
            <Button variant="primary" size="sm" onClick={() => setUploadOpen(true)}>
              <Plus className="size-4" /> {t("file_library.contracts.workflow.templates.new")}
            </Button>
          }
        />

        <div className="flex items-start gap-3 rounded-lg border border-subtle bg-layer-1 p-4">
          <span className="grid size-8 shrink-0 place-items-center rounded-md bg-accent-subtle-hover text-accent-primary">
            <Braces className="size-4" />
          </span>
          <div>
            <p className="text-13 font-medium text-primary">
              {t("file_library.contracts.workflow.templates.variables_title")}
            </p>
            <p className="mt-1 text-11 leading-4 text-tertiary">
              {t("file_library.contracts.workflow.templates.variables_prefix")} <code>{"{{NombreFirmante1}}"}</code>,{" "}
              <code>{"{{CorreoFirmante1}}"}</code> {t("file_library.contracts.workflow.templates.variables_or")}{" "}
              <code>{"{{FirmaFirmante1}}"}</code>. {t("file_library.contracts.workflow.templates.variables_suffix")}
            </p>
          </div>
        </div>

        <ContractSection
          title={t("file_library.contracts.workflow.templates.library")}
          description={t("file_library.contracts.workflow.templates.library_description")}
          actions={
            <span className="text-11 text-tertiary">
              {t("file_library.contracts.workflow.templates.count", { count: templates?.length ?? 0 })}
            </span>
          }
        >
          {isLoading ? (
            <ContractLoading />
          ) : (templates ?? []).length === 0 ? (
            <ContractEmptyState
              icon={<FilePlus2 className="size-5" />}
              title={t("file_library.contracts.workflow.templates.empty_title")}
              description={t("file_library.contracts.workflow.templates.empty_description")}
              action={
                <Button variant="primary" size="sm" onClick={() => setUploadOpen(true)}>
                  <Upload className="size-4" /> {t("file_library.contracts.workflow.templates.upload_word")}
                </Button>
              }
            />
          ) : (
            <ul className="divide-y divide-subtle">
              {(templates ?? []).map((template) => {
                const revisionCount = template.variants.reduce((total, variant) => total + variant.revision_count, 0);
                return (
                  <li key={template.id} className="group flex items-center gap-3 px-4 py-3 hover:bg-layer-1-hover">
                    <Link
                      to={`/${workspaceSlug}/file-library/contracts/templates/${template.id}`}
                      className="flex min-w-0 flex-1 items-center gap-3"
                    >
                      <span className="grid size-8 shrink-0 place-items-center rounded-md bg-layer-2 text-accent-primary">
                        <FileText className="size-4" />
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-13 font-medium text-primary">{template.name}</span>
                        <span className="block max-w-md truncate text-11 text-tertiary">
                          {template.description || t("file_library.contracts.workflow.common.no_description")}
                        </span>
                      </span>
                    </Link>
                    <div className="hidden shrink-0 items-center gap-4 text-11 text-tertiary sm:flex">
                      <span>
                        {template.variants.length} {t("file_library.contracts.workflow.common.variants")}
                      </span>
                      <span>
                        {revisionCount} {t("file_library.contracts.workflow.common.versions")}
                      </span>
                      <span>{new Date(template.updated_at).toLocaleDateString()}</span>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <button
                        type="button"
                        onClick={() => setDeletingTemplate(template)}
                        className="rounded p-1.5 text-tertiary hover:bg-layer-2 hover:text-danger-primary"
                        aria-label={t("file_library.contracts.workflow.templates.delete_named", {
                          name: template.name,
                        })}
                      >
                        <Trash2 className="size-4" />
                      </button>
                      <Link
                        to={`/${workspaceSlug}/file-library/contracts/templates/${template.id}`}
                        className="rounded p-1.5 text-tertiary hover:bg-layer-2 hover:text-primary"
                        aria-label={t("file_library.contracts.workflow.templates.open_named", {
                          name: template.name,
                        })}
                      >
                        <ChevronRight className="size-4" />
                      </Link>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </ContractSection>
      </div>

      <ModalCore
        isOpen={uploadOpen}
        handleClose={closeCreation}
        position={EModalPosition.CENTER}
        width={EModalWidth.MD}
      >
        {created ? (
          <TemplateDetectionSummary
            created={created}
            onConfigure={() => goToTemplate(created.template.id)}
            onFinish={closeCreation}
          />
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void uploadTemplate();
            }}
          >
            <div className="border-b border-subtle px-5 py-4">
              <h3 className="text-15 font-semibold text-primary">
                {t("file_library.contracts.workflow.templates.new")}
              </h3>
              <p className="mt-1 text-11 text-tertiary">
                {t("file_library.contracts.workflow.templates.upload_description")}
              </p>
            </div>
            <div className="space-y-4 p-5">
              <ContractField label={t("file_library.contracts.workflow.common.name")}>
                <ContractInput
                  value={templateName}
                  onChange={(event) => setTemplateName(event.target.value)}
                  placeholder={t("file_library.contracts.workflow.templates.name_placeholder")}
                />
              </ContractField>
              <ContractField
                label={t("file_library.contracts.workflow.common.description")}
                optional
                optionalLabel={t("file_library.contracts.workflow.common.optional")}
              >
                <ContractTextarea
                  value={templateDescription}
                  onChange={(event) => setTemplateDescription(event.target.value)}
                  className="min-h-20 resize-none"
                />
              </ContractField>
              <label className="grid cursor-pointer place-items-center rounded-lg border border-dashed border-subtle bg-layer-1 px-5 py-7 text-center hover:bg-layer-1-hover">
                {templateFile ? (
                  <CheckCircle2 className="size-6 text-success-primary" />
                ) : (
                  <Upload className="size-6 text-tertiary" />
                )}
                <span className="mt-2 text-13 font-medium text-primary">
                  {templateFile?.name ?? t("file_library.contracts.workflow.templates.select_word")}
                </span>
                <span className="mt-1 text-11 text-tertiary">
                  {t("file_library.contracts.workflow.templates.editable_docx")}
                </span>
                <input
                  type="file"
                  accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                  className="hidden"
                  onChange={(event) => setTemplateFile(event.target.files?.[0])}
                />
              </label>
            </div>
            <footer className="flex justify-end gap-2 border-t border-subtle px-5 py-4">
              <Button variant="secondary" size="sm" type="button" disabled={isUploading} onClick={closeCreation}>
                {t("file_library.contracts.workflow.common.cancel")}
              </Button>
              <Button
                variant="primary"
                size="sm"
                type="submit"
                disabled={!templateFile || !templateName.trim() || isUploading}
              >
                {isUploading ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}{" "}
                {t(
                  isUploading
                    ? "file_library.contracts.workflow.templates.analyzing"
                    : "file_library.contracts.workflow.templates.create"
                )}
              </Button>
            </footer>
          </form>
        )}
      </ModalCore>

      <AlertModalCore
        isOpen={Boolean(deletingTemplate)}
        handleClose={() => setDeletingTemplate(undefined)}
        handleSubmit={() => void deleteTemplate()}
        isSubmitting={isDeleting}
        title={t("file_library.contracts.workflow.templates.delete_title")}
        content={
          <>
            {t("file_library.contracts.workflow.templates.delete_prefix")} <strong>{deletingTemplate?.name}</strong>{" "}
            {t("file_library.contracts.workflow.templates.delete_suffix")}
          </>
        }
      />
    </div>
  );
}

/**
 * Step 2 of creation: report what the parser found in the uploaded Word file
 * so the upload has a visible result, then offer the natural next step.
 */
function TemplateDetectionSummary({
  created,
  onConfigure,
  onFinish,
}: {
  created: CreatedTemplate;
  onConfigure: () => void;
  onFinish: () => void;
}) {
  const { t } = useTranslation();
  const variables = created.schema?.schema.variables ?? [];
  const signerCount = created.schema?.schema.recipients.length ?? 0;
  const tokens = variables.slice(0, 8);

  return (
    <div>
      <div className="border-b border-subtle px-5 py-4">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="size-4 shrink-0 text-success-primary" />
          <h3 className="text-15 font-semibold text-primary">
            {t("file_library.contracts.workflow.templates.created")}
          </h3>
        </div>
        <p className="mt-1 text-11 text-tertiary">
          {t("file_library.contracts.workflow.templates.detection_description")}
        </p>
      </div>

      <div className="space-y-4 p-5">
        <div className="grid grid-cols-2 gap-3">
          <DetectionStat
            icon={<Braces className="size-4" />}
            value={variables.length}
            label={t("file_library.contracts.workflow.use.data")}
          />
          <DetectionStat
            icon={<UserRound className="size-4" />}
            value={signerCount}
            label={t("file_library.contracts.workflow.use.people_count")}
          />
        </div>

        {tokens.length > 0 ? (
          <div className="rounded-lg border border-subtle bg-layer-1 p-3">
            <p className="text-11 font-medium text-secondary">
              {t("file_library.contracts.workflow.templates.detected_variables")}
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {tokens.map((variable) => (
                <code
                  key={variable.key}
                  className="rounded bg-layer-2 px-1.5 py-0.5 text-11 text-secondary"
                >{`{{${variable.key}}}`}</code>
              ))}
              {variables.length > tokens.length ? (
                <span className="text-11 text-tertiary">
                  {t("file_library.contracts.workflow.templates.and_more", {
                    count: variables.length - tokens.length,
                  })}
                </span>
              ) : null}
            </div>
          </div>
        ) : (
          <div className={cn("rounded-lg border border-dashed border-subtle p-4 text-center")}>
            <p className="text-13 text-secondary">
              {t("file_library.contracts.workflow.templates.no_variables_title")}
            </p>
            <p className="mt-1 text-11 text-tertiary">
              {t("file_library.contracts.workflow.templates.no_variables_description")}
            </p>
          </div>
        )}
      </div>

      <footer className="flex justify-end gap-2 border-t border-subtle px-5 py-4">
        <Button variant="secondary" size="sm" onClick={onFinish}>
          {t("file_library.contracts.workflow.templates.save_and_exit")}
        </Button>
        <Button variant="primary" size="sm" onClick={onConfigure}>
          {t("file_library.contracts.workflow.templates.continue_setup")}
        </Button>
      </footer>
    </div>
  );
}

function DetectionStat({ icon, value, label }: { icon: React.ReactNode; value: number; label: string }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-subtle bg-layer-1 p-3">
      <span className="grid size-8 shrink-0 place-items-center rounded-md bg-layer-2 text-accent-primary">{icon}</span>
      <span>
        <span className="block text-18 font-semibold text-primary">{value}</span>
        <span className="block text-11 text-tertiary">{label}</span>
      </span>
    </div>
  );
}
