/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import { Braces, CheckCircle2, ChevronRight, FilePlus2, FileText, Loader2, Plus, Trash2, Upload } from "lucide-react";
import { Link, useNavigate } from "react-router";
import useSWR from "swr";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TContractTemplate } from "@plane/types";
import { AlertModalCore, EModalPosition, EModalWidth, ModalCore } from "@plane/ui";
import { contractService } from "@/services/contract.service";

type Props = { workspaceSlug: string };

const INPUT_CLASS =
  "mt-1.5 w-full rounded-md border border-subtle bg-surface-1 px-3 text-12 text-primary outline-none focus:border-accent-primary";

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
  const [deletingTemplate, setDeletingTemplate] = useState<TContractTemplate>();
  const [isDeleting, setIsDeleting] = useState(false);

  const resetUpload = () => {
    setUploadOpen(false);
    setTemplateName("");
    setTemplateDescription("");
    setTemplateFile(undefined);
  };

  const uploadTemplate = async () => {
    if (!templateFile || !templateName.trim()) return;
    setIsUploading(true);
    try {
      const created = await contractService.createTemplate(workspaceSlug, {
        name: templateName.trim(),
        description: templateDescription.trim(),
        file: templateFile,
      });
      resetUpload();
      await mutate();
      setToast({ type: TOAST_TYPE.SUCCESS, title: t("file_library.contracts.workflow.templates.created") });
      navigate(`/${workspaceSlug}/file-library/contracts/templates/${created.id}?edit=1`);
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

  return (
    <div className="h-full overflow-y-auto bg-surface-1">
      <div className="mx-auto max-w-6xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-20 font-semibold text-primary">
              {t("file_library.contracts.workflow.templates.title")}
            </h1>
            <p className="mt-1 text-12 text-secondary">{t("file_library.contracts.workflow.templates.description")}</p>
          </div>
          <Button variant="primary" size="sm" onClick={() => setUploadOpen(true)}>
            <Plus className="size-4" /> {t("file_library.contracts.workflow.templates.new")}
          </Button>
        </header>

        <div className="flex items-start gap-3 rounded-lg border border-subtle bg-layer-1 p-4">
          <span className="grid size-8 shrink-0 place-items-center rounded-md bg-accent-primary/10 text-accent-primary">
            <Braces className="size-4" />
          </span>
          <div>
            <p className="text-12 font-medium text-primary">
              {t("file_library.contracts.workflow.templates.variables_title")}
            </p>
            <p className="mt-1 text-10 leading-4 text-tertiary">
              {t("file_library.contracts.workflow.templates.variables_prefix")} <code>{"{{NombreFirmante1}}"}</code>,{" "}
              <code>{"{{CorreoFirmante1}}"}</code> {t("file_library.contracts.workflow.templates.variables_or")}{" "}
              <code>{"{{FirmaFirmante1}}"}</code>. {t("file_library.contracts.workflow.templates.variables_suffix")}
            </p>
          </div>
        </div>

        <section className="overflow-hidden rounded-lg border border-subtle bg-surface-1">
          <div className="flex items-center justify-between border-b border-subtle px-4 py-3">
            <div>
              <h2 className="text-13 font-semibold text-primary">
                {t("file_library.contracts.workflow.templates.library")}
              </h2>
              <p className="mt-0.5 text-10 text-tertiary">
                {t("file_library.contracts.workflow.templates.library_description")}
              </p>
            </div>
            <span className="text-10 text-tertiary">
              {t("file_library.contracts.workflow.templates.count", { count: templates?.length ?? 0 })}
            </span>
          </div>

          {isLoading ? (
            <div className="grid min-h-48 place-items-center">
              <Loader2 className="size-5 animate-spin text-tertiary" />
            </div>
          ) : (templates ?? []).length === 0 ? (
            <div className="px-6 py-14 text-center">
              <FilePlus2 className="mx-auto size-8 text-tertiary" />
              <h3 className="mt-3 text-13 font-semibold text-primary">
                {t("file_library.contracts.workflow.templates.empty_title")}
              </h3>
              <p className="mt-1 text-11 text-tertiary">
                {t("file_library.contracts.workflow.templates.empty_description")}
              </p>
              <Button variant="primary" size="sm" className="mt-4" onClick={() => setUploadOpen(true)}>
                <Upload className="size-4" /> {t("file_library.contracts.workflow.templates.upload_word")}
              </Button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] border-collapse text-left">
                <thead className="bg-layer-1 text-10 font-medium text-tertiary">
                  <tr>
                    <th className="px-4 py-2.5">{t("file_library.contracts.workflow.common.template")}</th>
                    <th className="px-4 py-2.5">{t("file_library.contracts.workflow.common.variants")}</th>
                    <th className="px-4 py-2.5">{t("file_library.contracts.workflow.common.versions")}</th>
                    <th className="px-4 py-2.5">{t("file_library.contracts.workflow.common.updated")}</th>
                    <th className="w-24 px-4 py-2.5">
                      <span className="sr-only">{t("file_library.contracts.workflow.common.actions")}</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-subtle">
                  {(templates ?? []).map((template) => {
                    const revisionCount = template.variants.reduce(
                      (total, variant) => total + variant.revision_count,
                      0
                    );
                    return (
                      <tr key={template.id} className="group hover:bg-layer-1-hover">
                        <td className="px-4 py-3">
                          <Link
                            to={`/${workspaceSlug}/file-library/contracts/templates/${template.id}`}
                            className="flex items-center gap-3"
                          >
                            <span className="grid size-8 shrink-0 place-items-center rounded-md bg-accent-primary/10 text-accent-primary">
                              <FileText className="size-4" />
                            </span>
                            <span className="min-w-0">
                              <span className="block truncate text-12 font-medium text-primary">{template.name}</span>
                              <span className="block max-w-md truncate text-10 text-tertiary">
                                {template.description || t("file_library.contracts.workflow.common.no_description")}
                              </span>
                            </span>
                          </Link>
                        </td>
                        <td className="px-4 py-3 text-11 text-secondary">{template.variants.length}</td>
                        <td className="px-4 py-3 text-11 text-secondary">{revisionCount}</td>
                        <td className="px-4 py-3 text-11 text-secondary">
                          {new Date(template.updated_at).toLocaleDateString()}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex justify-end gap-1">
                            <button
                              type="button"
                              onClick={() => setDeletingTemplate(template)}
                              className="rounded p-1.5 text-tertiary hover:bg-layer-1 hover:text-danger-primary"
                              aria-label={t("file_library.contracts.workflow.templates.delete_named", {
                                name: template.name,
                              })}
                            >
                              <Trash2 className="size-4" />
                            </button>
                            <Link
                              to={`/${workspaceSlug}/file-library/contracts/templates/${template.id}`}
                              className="rounded p-1.5 text-tertiary hover:bg-layer-1 hover:text-primary"
                              aria-label={t("file_library.contracts.workflow.templates.open_named", {
                                name: template.name,
                              })}
                            >
                              <ChevronRight className="size-4" />
                            </Link>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      <ModalCore isOpen={uploadOpen} handleClose={resetUpload} position={EModalPosition.CENTER} width={EModalWidth.SM}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void uploadTemplate();
          }}
        >
          <div className="border-b border-subtle px-5 py-4">
            <h3 className="text-14 font-semibold text-primary">{t("file_library.contracts.workflow.templates.new")}</h3>
            <p className="mt-1 text-10 text-tertiary">
              {t("file_library.contracts.workflow.templates.upload_description")}
            </p>
          </div>
          <div className="space-y-4 p-5">
            <label className="block text-11 font-medium text-secondary">
              {t("file_library.contracts.workflow.common.name")}
              <input
                className={`${INPUT_CLASS} h-9`}
                value={templateName}
                onChange={(event) => setTemplateName(event.target.value)}
                placeholder={t("file_library.contracts.workflow.templates.name_placeholder")}
              />
            </label>
            <label className="block text-11 font-medium text-secondary">
              {t("file_library.contracts.workflow.common.description")}{" "}
              <span className="font-normal text-tertiary">
                ({t("file_library.contracts.workflow.common.optional")})
              </span>
              <textarea
                className={`${INPUT_CLASS} min-h-20 resize-none py-2`}
                value={templateDescription}
                onChange={(event) => setTemplateDescription(event.target.value)}
              />
            </label>
            <label className="grid cursor-pointer place-items-center rounded-lg border border-dashed border-subtle bg-layer-1 px-5 py-7 text-center hover:bg-layer-1-hover">
              {templateFile ? (
                <CheckCircle2 className="size-6 text-success-primary" />
              ) : (
                <Upload className="size-6 text-tertiary" />
              )}
              <span className="mt-2 text-11 font-medium text-primary">
                {templateFile?.name ?? t("file_library.contracts.workflow.templates.select_word")}
              </span>
              <span className="mt-1 text-9 text-tertiary">
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
            <Button variant="secondary" size="sm" type="button" disabled={isUploading} onClick={resetUpload}>
              {t("file_library.contracts.workflow.common.cancel")}
            </Button>
            <Button
              variant="primary"
              size="sm"
              type="submit"
              disabled={!templateFile || !templateName.trim() || isUploading}
            >
              {isUploading ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}{" "}
              {t("file_library.contracts.workflow.templates.create")}
            </Button>
          </footer>
        </form>
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
