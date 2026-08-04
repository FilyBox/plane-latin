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

import { useMemo, useState } from "react";
import {
  Braces,
  CheckCircle2,
  Download,
  FilePlus2,
  FileText,
  Loader2,
  Plus,
  Search,
  Trash2,
  Upload,
  UserRound,
} from "lucide-react";
import { useNavigate } from "react-router";
import useSWR from "swr";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TContractTemplate, TContractTemplateSchemaResponse } from "@plane/types";
import { AlertModalCore, CustomMenu, EModalPosition, EModalWidth, ModalCore } from "@plane/ui";
import { cn } from "@plane/utils";
import { contractService } from "@/services/contract.service";
import { downloadAssets } from "../download";
import { ContractBulkActionsBar, ContractSelectionCheckbox } from "./list-controls";
import { ContractEmptyState, ContractField, ContractInput, ContractLoading, ContractTextarea } from "./ui";

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
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

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

  const orderedTemplates = useMemo(
    () =>
      [...(templates ?? [])].sort(
        (left, right) => new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime()
      ),
    [templates]
  );
  const visibleTemplates = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return orderedTemplates;
    return orderedTemplates.filter(
      (template) => template.name.toLowerCase().includes(term) || template.description.toLowerCase().includes(term)
    );
  }, [orderedTemplates, search]);

  const toggleSelect = (templateId: string) =>
    setSelectedIds((current) =>
      current.includes(templateId) ? current.filter((id) => id !== templateId) : [...current, templateId]
    );
  const toggleSelectAll = () =>
    setSelectedIds((current) =>
      visibleTemplates.length > 0 && visibleTemplates.every((template) => current.includes(template.id))
        ? current.filter((id) => !visibleTemplates.some((template) => template.id === id))
        : [...new Set([...current, ...visibleTemplates.map((template) => template.id)])]
    );

  const downloadTemplates = async (items: TContractTemplate[]) => {
    const targets = items.flatMap((template) =>
      template.variants.map((variant) => ({
        assetId: variant.source_asset_id,
        name: variant.source_file_name || `${template.name}-${variant.name}.docx`,
      }))
    );
    const uniqueTargets = [...new Map(targets.map((target) => [target.assetId, target])).values()];
    if (uniqueTargets.length === 0) return;
    try {
      await downloadAssets(workspaceSlug, uniqueTargets, "plantillas-contratos", "contract");
    } catch {
      setToast({ type: TOAST_TYPE.ERROR, title: t("file_library.download_failed") });
    }
  };

  const deleteSelectedTemplates = async () => {
    if (selectedIds.length === 0) return;
    setIsDeleting(true);
    try {
      await Promise.all(selectedIds.map((templateId) => contractService.deleteTemplate(workspaceSlug, templateId)));
      await mutate();
      setSelectedIds([]);
      setBulkDeleteOpen(false);
      setToast({
        type: TOAST_TYPE.SUCCESS,
        title: t("file_library.contracts.workflow.templates.bulk_deleted", { count: selectedIds.length }),
      });
    } catch (error: any) {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: error?.error ?? t("file_library.contracts.workflow.templates.delete_failed"),
      });
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-subtle px-3 py-2.5 sm:px-4">
        <div className="flex min-w-0 items-center gap-2">
          <div className="relative">
            <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-tertiary" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("file_library.contracts.workflow.templates.search_placeholder")}
              className="w-36 rounded-md border border-subtle bg-transparent py-1.5 pr-2 pl-8 text-12 sm:w-64"
            />
          </div>
          <Button
            variant="secondary"
            size="sm"
            disabled={orderedTemplates.length === 0}
            title={t("file_library.download_all_hint")}
            onClick={() => void downloadTemplates(orderedTemplates)}
          >
            <Download className="size-3.5" />
            <span className="hidden lg:inline">{t("file_library.download_all")}</span>
          </Button>
        </div>
        <Button variant="primary" size="sm" onClick={() => setUploadOpen(true)}>
          <Plus className="size-3.5" /> {t("file_library.contracts.workflow.templates.new")}
        </Button>
      </div>

      <div className="flex shrink-0 items-start gap-3 border-b border-subtle bg-layer-1 px-3 py-2.5 sm:px-4">
        <span className="grid size-8 shrink-0 place-items-center rounded-md bg-accent-subtle-hover text-accent-primary">
          <Braces className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="text-13 font-medium text-primary">
            {t("file_library.contracts.workflow.templates.variables_title")}
          </p>
          <p className="mt-0.5 truncate text-11 text-tertiary">
            {t("file_library.contracts.workflow.templates.variables_prefix")} <code>{"{{NombreFirmante1}}"}</code>,{" "}
            <code>{"{{CorreoFirmante1}}"}</code> {t("file_library.contracts.workflow.templates.variables_or")}{" "}
            <code>{"{{FirmaFirmante1}}"}</code>. {t("file_library.contracts.workflow.templates.variables_suffix")}
          </p>
        </div>
      </div>

      <ContractBulkActionsBar count={selectedIds.length} onClear={() => setSelectedIds([])}>
        <Button
          variant="secondary"
          size="sm"
          onClick={() =>
            void downloadTemplates(orderedTemplates.filter((template) => selectedIds.includes(template.id)))
          }
        >
          <Download className="size-3.5" />
          {t("file_library.download_selected")}
        </Button>
        <Button variant="secondary" size="sm" onClick={() => setBulkDeleteOpen(true)}>
          <Trash2 className="size-3.5" />
          {t("file_library.contracts.workflow.templates.delete_selected")}
        </Button>
      </ContractBulkActionsBar>

      <div className="min-h-0 flex-1 overflow-hidden">
        {isLoading ? (
          <ContractLoading className="h-full" />
        ) : orderedTemplates.length === 0 ? (
          <ContractEmptyState
            className="h-full"
            icon={<FilePlus2 className="size-5" />}
            title={t("file_library.contracts.workflow.templates.empty_title")}
            description={t("file_library.contracts.workflow.templates.empty_description")}
            action={
              <Button variant="primary" size="sm" onClick={() => setUploadOpen(true)}>
                <Upload className="size-4" /> {t("file_library.contracts.workflow.templates.upload_word")}
              </Button>
            }
          />
        ) : visibleTemplates.length === 0 ? (
          <ContractEmptyState
            className="h-full"
            icon={<Search className="size-5" />}
            title={t("file_library.contracts.workflow.templates.no_matches_title")}
            description={t("file_library.contracts.workflow.templates.no_matches_description")}
          />
        ) : (
          <div className="h-full overflow-auto">
            <table className="hidden w-full min-w-[820px] border-collapse text-left md:table">
              <thead className="sticky top-0 z-[1] bg-surface-1">
                <tr className="border-b border-subtle text-11 font-medium text-tertiary">
                  <th className="w-10 px-4 py-2">
                    <ContractSelectionCheckbox
                      checked={visibleTemplates.every((template) => selectedIds.includes(template.id))}
                      onChange={toggleSelectAll}
                    />
                  </th>
                  <th className="px-2 py-2">{t("file_library.contracts.workflow.common.name")}</th>
                  <th className="px-3 py-2">{t("file_library.contracts.workflow.common.description")}</th>
                  <th className="px-3 py-2">{t("file_library.contracts.workflow.common.variants")}</th>
                  <th className="px-3 py-2">{t("file_library.contracts.workflow.common.versions")}</th>
                  <th className="px-3 py-2">{t("file_library.contracts.workflow.templates.updated_at")}</th>
                  <th className="w-12 px-3 py-2 text-right">{t("file_library.contracts.workflow.common.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {visibleTemplates.map((template) => {
                  const revisionCount = template.variants.reduce((total, variant) => total + variant.revision_count, 0);
                  return (
                    <tr
                      key={template.id}
                      onClick={() => goToTemplate(template.id)}
                      className="cursor-pointer border-b border-subtle text-13 hover:bg-layer-1-hover"
                    >
                      <td className="px-4 py-2.5">
                        <ContractSelectionCheckbox
                          checked={selectedIds.includes(template.id)}
                          onChange={() => toggleSelect(template.id)}
                        />
                      </td>
                      <td className="max-w-64 px-2 py-2.5">
                        <div className="flex items-center gap-2">
                          <FileText className="size-4 shrink-0 text-accent-primary" />
                          <span className="truncate font-medium text-primary">{template.name}</span>
                        </div>
                      </td>
                      <td className="max-w-96 truncate px-3 py-2.5 text-secondary">
                        {template.description || t("file_library.contracts.workflow.common.no_description")}
                      </td>
                      <td className="px-3 py-2.5 tabular-nums">{template.variants.length}</td>
                      <td className="px-3 py-2.5 tabular-nums">{revisionCount}</td>
                      <td className="px-3 py-2.5 whitespace-nowrap text-tertiary">
                        {new Date(template.updated_at).toLocaleString()}
                      </td>
                      <td className="px-3 py-2.5 text-right" onClick={(event) => event.stopPropagation()}>
                        <CustomMenu
                          ellipsis
                          placement="bottom-end"
                          ariaLabel={t("file_library.contracts.workflow.common.actions")}
                        >
                          <CustomMenu.MenuItem onClick={() => goToTemplate(template.id)}>
                            {t("file_library.contracts.workflow.templates.open_named", { name: template.name })}
                          </CustomMenu.MenuItem>
                          <CustomMenu.MenuItem onClick={() => void downloadTemplates([template])}>
                            {t("file_library.download")}
                          </CustomMenu.MenuItem>
                          <CustomMenu.MenuItem onClick={() => setDeletingTemplate(template)}>
                            <span className="text-danger-primary">
                              {t("file_library.contracts.workflow.templates.delete_named", { name: template.name })}
                            </span>
                          </CustomMenu.MenuItem>
                        </CustomMenu>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            <div className="space-y-2 p-3 md:hidden">
              {visibleTemplates.map((template) => {
                const revisionCount = template.variants.reduce((total, variant) => total + variant.revision_count, 0);
                return (
                  <div
                    key={template.id}
                    className="relative w-full rounded-lg border border-subtle p-3 text-left hover:bg-layer-1-hover"
                  >
                    <button
                      type="button"
                      aria-label={template.name}
                      onClick={() => goToTemplate(template.id)}
                      className="absolute inset-0 z-0"
                    />
                    <div className="pointer-events-none relative z-1 flex items-start gap-2.5">
                      <span className="pointer-events-auto">
                        <ContractSelectionCheckbox
                          checked={selectedIds.includes(template.id)}
                          onChange={() => toggleSelect(template.id)}
                        />
                      </span>
                      <FileText className="size-4 shrink-0 text-accent-primary" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-13 font-medium text-primary">{template.name}</p>
                        <p className="mt-1 truncate text-11 text-tertiary">
                          {template.description || t("file_library.contracts.workflow.common.no_description")}
                        </p>
                        <p className="mt-2 text-11 text-tertiary">
                          {template.variants.length} {t("file_library.contracts.workflow.common.variants")} ·{" "}
                          {revisionCount} {t("file_library.contracts.workflow.common.versions")}
                        </p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
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
      <AlertModalCore
        isOpen={bulkDeleteOpen}
        handleClose={() => setBulkDeleteOpen(false)}
        handleSubmit={() => void deleteSelectedTemplates()}
        isSubmitting={isDeleting}
        title={t("file_library.contracts.workflow.templates.delete_selected")}
        content={t("file_library.contracts.workflow.templates.bulk_delete_description", {
          count: selectedIds.length,
        })}
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
