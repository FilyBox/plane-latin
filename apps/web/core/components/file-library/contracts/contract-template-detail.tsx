/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  Braces,
  CheckCircle2,
  CopyPlus,
  Eye,
  FilePenLine,
  FileText,
  Loader2,
  Maximize2,
  Plus,
  Save,
  Send,
  Settings2,
  Trash2,
} from "lucide-react";
import { Link, useNavigate, useSearchParams } from "react-router";
import useSWR from "swr";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TContractSignatureRequest, TContractTemplateVariant } from "@plane/types";
import { AlertModalCore, EModalPosition, EModalWidth, ModalCore } from "@plane/ui";
import { contractService } from "@/services/contract.service";
import { CollaboraEditorModal } from "../collabora-editor-modal";
import { FilePreviewModal, type TPreviewFile } from "../file-preview-modal";
import { ContractAssetPreview } from "./contract-asset-preview";
import { ContractAuthoringModal } from "./contract-authoring-modal";
import { ContractTemplateUseDialog } from "./contract-template-use-dialog";
import { ContractWordEditDecisionDialog, type TContractEditDecision } from "./contract-word-edit-decision-dialog";

type Props = { workspaceSlug: string; templateId: string };
type UseSelection = { variant: TContractTemplateVariant; revisionId?: string };
type EditSession = {
  variant: TContractTemplateVariant;
  backupAssetId: string;
  phase: "EDITING" | "CONFIRM";
};

const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const STATUS_LABEL_KEYS: Record<TContractSignatureRequest["status"], string> = {
  DRAFT: "file_library.contracts.workflow.request_status.draft",
  PREPARING: "file_library.contracts.workflow.request_status.preparing",
  READY: "file_library.contracts.workflow.request_status.ready",
  PENDING: "file_library.contracts.workflow.request_status.pending",
  COMPLETED: "file_library.contracts.workflow.request_status.completed",
  REJECTED: "file_library.contracts.workflow.request_status.rejected",
  CANCELLED: "file_library.contracts.workflow.request_status.cancelled",
  ERROR: "file_library.contracts.workflow.request_status.error",
};

export function ContractTemplateDetail({ workspaceSlug, templateId }: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const {
    data: template,
    mutate: mutateTemplate,
    isLoading,
  } = useSWR(
    `CONTRACT_TEMPLATE_${workspaceSlug}_${templateId}`,
    () => contractService.getTemplate(workspaceSlug, templateId),
    { revalidateOnFocus: false }
  );
  const { data: requests, mutate: mutateRequests } = useSWR(
    `CONTRACT_SIGNATURE_REQUESTS_${workspaceSlug}`,
    () => contractService.getSignatureRequests(workspaceSlug),
    { revalidateOnFocus: false }
  );
  const [selectedVariantId, setSelectedVariantId] = useState<string>();
  const selectedVariant =
    template?.variants.find((variant) => variant.id === selectedVariantId) ?? template?.variants[0];
  const {
    data: schema,
    mutate: mutateSchema,
    isLoading: isSchemaLoading,
  } = useSWR(
    selectedVariant ? `CONTRACT_TEMPLATE_SCHEMA_${workspaceSlug}_${selectedVariant.id}_CURRENT` : null,
    () => contractService.getTemplateSchema(workspaceSlug, selectedVariant!.id),
    { revalidateOnFocus: false }
  );
  const [previewFile, setPreviewFile] = useState<TPreviewFile | null>(null);
  const [selectedVersionId, setSelectedVersionId] = useState("CURRENT");
  const [editSession, setEditSession] = useState<EditSession>();
  const [isStartingEdit, setIsStartingEdit] = useState(false);
  const [isFinishingEdit, setIsFinishingEdit] = useState(false);
  const [usingSelection, setUsingSelection] = useState<UseSelection>();
  const [authoringRequest, setAuthoringRequest] = useState<TContractSignatureRequest>();
  const [variantDraft, setVariantDraft] = useState("");
  const [variantModalOpen, setVariantModalOpen] = useState(false);
  const [isCreatingVariant, setIsCreatingVariant] = useState(false);
  const [isSavingVersion, setIsSavingVersion] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    if (!selectedVariantId && template?.variants[0]) setSelectedVariantId(template.variants[0].id);
  }, [selectedVariantId, template]);

  useEffect(() => {
    setSelectedVersionId("CURRENT");
  }, [selectedVariant?.id]);

  const startWordEdit = useCallback(
    async (variant: TContractTemplateVariant) => {
      if (isStartingEdit || editSession) return;
      setIsStartingEdit(true);
      try {
        const session = await contractService.startTemplateEditSession(workspaceSlug, variant.id);
        setEditSession({ variant, backupAssetId: session.backup_asset_id, phase: "EDITING" });
      } catch (error: any) {
        setToast({
          type: TOAST_TYPE.ERROR,
          title: error?.error ?? t("file_library.contracts.workflow.template_detail.edit_start_failed"),
        });
      } finally {
        setIsStartingEdit(false);
      }
    },
    [editSession, isStartingEdit, t, workspaceSlug]
  );

  useEffect(() => {
    if (searchParams.get("edit") !== "1" || !selectedVariant) return;
    void startWordEdit(selectedVariant);
    setSearchParams({}, { replace: true });
  }, [searchParams, selectedVariant, setSearchParams, startWordEdit]);

  const templateRequests = useMemo(
    () =>
      (requests ?? []).filter((request) =>
        template?.variants.some((variant) => variant.id === request.revision.variant_id)
      ),
    [requests, template]
  );

  const createVariant = async () => {
    if (!template || !selectedVariant || !variantDraft.trim()) return;
    setIsCreatingVariant(true);
    try {
      const updated = await contractService.createVariant(workspaceSlug, template.id, {
        name: variantDraft.trim(),
        source_variant_id: selectedVariant.id,
      });
      await mutateTemplate(updated, { revalidate: true });
      setVariantModalOpen(false);
      setVariantDraft("");
      setSelectedVariantId(updated.variants.at(-1)?.id);
      setToast({
        type: TOAST_TYPE.SUCCESS,
        title: t("file_library.contracts.workflow.template_detail.variant_created"),
      });
    } catch (error: any) {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: error?.error ?? t("file_library.contracts.workflow.template_detail.variant_create_failed"),
      });
    } finally {
      setIsCreatingVariant(false);
    }
  };

  const saveVersion = async () => {
    if (!selectedVariant) return;
    setIsSavingVersion(true);
    try {
      const revision = await contractService.saveTemplateRevision(workspaceSlug, selectedVariant.id);
      await Promise.all([mutateTemplate(), mutateSchema()]);
      setSelectedVersionId(revision.id);
      setToast({ type: TOAST_TYPE.SUCCESS, title: t("file_library.contracts.workflow.template_detail.version_saved") });
    } catch (error: any) {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: error?.error ?? t("file_library.contracts.workflow.template_detail.version_save_failed"),
      });
    } finally {
      setIsSavingVersion(false);
    }
  };

  const configureFields = async () => {
    if (!selectedVariant || !template) return;
    try {
      const request = await contractService.prepareSignatureRequest(workspaceSlug, {
        variant_id: selectedVariant.id,
        title: t("file_library.contracts.workflow.template_detail.configuration_title", { name: template.name }),
        authoring_mode: "TEMPLATE",
      });
      setAuthoringRequest(request);
    } catch (error: any) {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: error?.error ?? t("file_library.contracts.workflow.template_detail.configuration_failed"),
      });
    }
  };

  const deleteTemplate = async () => {
    if (!template) return;
    setIsDeleting(true);
    try {
      await contractService.deleteTemplate(workspaceSlug, template.id);
      setToast({ type: TOAST_TYPE.SUCCESS, title: t("file_library.contracts.workflow.templates.deleted") });
      navigate(`/${workspaceSlug}/file-library/contracts/templates`);
    } catch (error: any) {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: error?.error ?? t("file_library.contracts.workflow.templates.delete_failed"),
      });
    } finally {
      setIsDeleting(false);
    }
  };

  const finishWordEdit = async (decision: TContractEditDecision, name?: string) => {
    if (!editSession) return;
    setIsFinishingEdit(true);
    try {
      const result = await contractService.finishTemplateEditSession(workspaceSlug, editSession.variant.id, {
        backup_asset_id: editSession.backupAssetId,
        action: decision,
        name,
      });
      await mutateTemplate(result.template, { revalidate: false });
      const resultVariant = result.template.variants.find((variant) => variant.id === result.variant_id);
      setSelectedVariantId(result.variant_id);
      setSelectedVersionId(result.revision_id ?? "CURRENT");
      if (usingSelection && resultVariant) {
        setUsingSelection({
          variant: resultVariant,
          revisionId: result.revision_id ?? usingSelection.revisionId,
        });
      }
      setEditSession(undefined);
      await Promise.all([mutateTemplate(), mutateSchema(), mutateRequests()]);
      setToast({
        type: TOAST_TYPE.SUCCESS,
        title:
          decision === "DISCARD"
            ? t("file_library.contracts.workflow.template_detail.changes_discarded")
            : decision === "NEW_VARIANT"
              ? t("file_library.contracts.workflow.template_detail.variant_created")
              : decision === "NEW_REVISION"
                ? t("file_library.contracts.workflow.template_detail.version_saved")
                : t("file_library.contracts.workflow.template_detail.document_updated"),
      });
    } catch (error: any) {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: error?.error ?? t("file_library.contracts.workflow.template_detail.apply_failed"),
      });
    } finally {
      setIsFinishingEdit(false);
    }
  };

  const selectedRevision = schema?.revisions.find((revision) => revision.id === selectedVersionId);
  const selectedAsset = selectedRevision
    ? {
        assetId: selectedRevision.pdf_asset_id,
        name: t("file_library.contracts.workflow.template_detail.revision_pdf_name", {
          name: template?.name ?? t("file_library.contracts.workflow.common.contract"),
          number: selectedRevision.revision,
        }),
        contentType: "application/pdf" as const,
      }
    : selectedVariant
      ? {
          assetId: selectedVariant.source_asset_id,
          name: selectedVariant.source_file_name,
          contentType: DOCX_TYPE,
        }
      : undefined;

  if (isLoading || !template)
    return (
      <div className="grid h-full place-items-center">
        <Loader2 className="size-5 animate-spin text-tertiary" />
      </div>
    );

  return (
    <div className="h-full overflow-y-auto bg-surface-1">
      <div className="w-full space-y-6 px-4 py-5 sm:px-5 lg:px-6">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <Link
              to={`/${workspaceSlug}/file-library/contracts/templates`}
              className="mb-2 inline-flex items-center gap-1 text-10 text-tertiary hover:text-primary"
            >
              <ArrowLeft className="size-3.5" /> {t("file_library.contracts.workflow.navigation.templates")}
            </Link>
            <h1 className="truncate text-20 font-semibold text-primary">{template.name}</h1>
            <p className="mt-1 text-12 text-secondary">
              {template.description || t("file_library.contracts.workflow.template_detail.description")}
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            {template.variants.length > 1 ? (
              <label className="text-9 font-medium text-tertiary">
                {t("file_library.contracts.workflow.common.variant")}
                <select
                  value={selectedVariant?.id ?? ""}
                  onChange={(event) => setSelectedVariantId(event.target.value)}
                  className="focus:border-accent-primary mt-1 block h-9 min-w-44 rounded-md border border-subtle bg-surface-1 px-3 text-11 font-medium text-primary outline-none"
                >
                  {template.variants.map((variant) => (
                    <option key={variant.id} value={variant.id}>
                      {variant.name} ·{" "}
                      {t("file_library.contracts.workflow.common.version_count", {
                        count: variant.revision_count,
                      })}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <Button variant="secondary" size="sm" onClick={() => setDeleteOpen(true)}>
              <Trash2 className="size-4" /> {t("file_library.contracts.workflow.common.delete")}
            </Button>
            <Button variant="primary" size="sm" onClick={() => setVariantModalOpen(true)}>
              <CopyPlus className="size-4" /> {t("file_library.contracts.workflow.template_detail.new_variant")}
            </Button>
          </div>
        </header>

        <section className="min-w-0">
          {selectedVariant ? (
            <div className="min-w-0 space-y-5">
              <section className="overflow-hidden rounded-lg border border-subtle bg-surface-1">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-subtle px-4 py-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="grid size-9 shrink-0 place-items-center rounded-md bg-accent-primary/10 text-accent-primary">
                      <FileText className="size-4" />
                    </span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <h2 className="truncate text-13 font-semibold text-primary">
                          {selectedRevision
                            ? t("file_library.contracts.workflow.common.version_number", {
                                number: selectedRevision.revision,
                              })
                            : t("file_library.contracts.workflow.common.current_document")}
                        </h2>
                        {!selectedRevision ? (
                          <span className="rounded-full bg-accent-primary/10 px-2 py-0.5 text-9 font-medium text-accent-primary">
                            {t("file_library.contracts.workflow.common.editable")}
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-0.5 truncate text-10 text-tertiary">{selectedAsset?.name}</p>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={!selectedAsset}
                      onClick={() => selectedAsset && setPreviewFile(selectedAsset)}
                    >
                      <Maximize2 className="size-4" /> {t("file_library.contracts.workflow.common.expand")}
                    </Button>
                    {selectedRevision ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() =>
                          setPreviewFile({
                            assetId: selectedRevision.source_asset_id,
                            name: t("file_library.contracts.workflow.template_detail.revision_word_name", {
                              name: template.name,
                              number: selectedRevision.revision,
                            }),
                            contentType: DOCX_TYPE,
                          })
                        }
                      >
                        <Eye className="size-4" /> {t("file_library.contracts.workflow.common.view_word")}
                      </Button>
                    ) : null}
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={isStartingEdit}
                      onClick={() => void startWordEdit(selectedVariant)}
                    >
                      {isStartingEdit ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <FilePenLine className="size-4" />
                      )}{" "}
                      {t("file_library.contracts.workflow.common.edit_word")}
                    </Button>
                    <Button variant="secondary" size="sm" disabled={isSavingVersion} onClick={() => void saveVersion()}>
                      {isSavingVersion ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                      {t(
                        isSavingVersion
                          ? "file_library.contracts.workflow.common.saving"
                          : "file_library.contracts.workflow.common.save_version"
                      )}
                    </Button>
                  </div>
                </div>

                <div className="grid min-h-[620px] xl:grid-cols-[minmax(0,1fr)_18rem]">
                  <div className="min-h-[620px] bg-layer-1 p-3 sm:p-4">
                    {selectedAsset ? (
                      <ContractAssetPreview
                        key={selectedAsset.assetId}
                        workspaceSlug={workspaceSlug}
                        assetId={selectedAsset.assetId}
                        fileName={selectedAsset.name}
                        contentType={selectedAsset.contentType}
                        className="shadow-sm h-[min(68vh,760px)] min-h-[580px] overflow-hidden rounded-md border border-subtle bg-surface-1"
                      />
                    ) : (
                      <div className="grid h-full place-items-center">
                        <Loader2 className="size-5 animate-spin text-tertiary" />
                      </div>
                    )}
                  </div>

                  <aside className="flex min-h-0 flex-col border-t border-subtle xl:border-t-0 xl:border-l">
                    <div className="border-b border-subtle px-3 py-3">
                      <p className="text-11 font-semibold text-primary">
                        {t("file_library.contracts.workflow.template_detail.choose_version")}
                      </p>
                      <p className="mt-0.5 text-9 text-tertiary">
                        {t("file_library.contracts.workflow.template_detail.choose_version_hint")}
                      </p>
                    </div>
                    <div className="max-h-[min(68vh,760px)] space-y-2 overflow-y-auto p-2.5">
                      <ContractVersionCard
                        isSelected={selectedVersionId === "CURRENT"}
                        title={t("file_library.contracts.workflow.common.current_document")}
                        subtitle={t("file_library.contracts.workflow.template_detail.current_subtitle")}
                        thumbnailUrl={contractService.getContractAssetThumbnailUrl(
                          workspaceSlug,
                          selectedVariant.source_asset_id,
                          selectedVariant.updated_at
                        )}
                        onSelect={() => setSelectedVersionId("CURRENT")}
                      />
                      {isSchemaLoading ? (
                        <div className="grid min-h-24 place-items-center">
                          <Loader2 className="size-4 animate-spin text-tertiary" />
                        </div>
                      ) : null}
                      {schema?.revisions.map((revision) => (
                        <ContractVersionCard
                          key={revision.id}
                          isSelected={selectedVersionId === revision.id}
                          title={
                            revision.name ||
                            t("file_library.contracts.workflow.common.version_number", { number: revision.revision })
                          }
                          subtitle={new Date(revision.created_at).toLocaleString()}
                          meta={t("file_library.contracts.workflow.template_detail.version_meta", {
                            variables: revision.variable_schema?.placeholder_count ?? 0,
                            fields: revision.signature_blueprint.length,
                          })}
                          thumbnailUrl={contractService.getContractAssetThumbnailUrl(
                            workspaceSlug,
                            revision.pdf_asset_id,
                            revision.content_sha256
                          )}
                          onSelect={() => setSelectedVersionId(revision.id)}
                        />
                      ))}
                      {!isSchemaLoading && (schema?.revisions.length ?? 0) === 0 ? (
                        <p className="rounded-md border border-dashed border-subtle p-3 text-center text-9 text-tertiary">
                          {t("file_library.contracts.workflow.template_detail.save_first_version")}
                        </p>
                      ) : null}
                    </div>
                  </aside>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-subtle p-4">
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-10 text-tertiary">
                    <span className="flex items-center gap-1.5">
                      <Braces className="size-3.5" />
                      {selectedRevision?.variable_schema?.placeholder_count ??
                        schema?.schema.placeholder_count ??
                        0}{" "}
                      {t("file_library.contracts.workflow.common.variables")}
                    </span>
                    <span>
                      {selectedRevision?.signature_blueprint.length ?? selectedVariant.signature_blueprint.length}{" "}
                      {t("file_library.contracts.workflow.common.fields")}
                    </span>
                    <span>
                      {selectedRevision?.recipient_blueprint.length ?? selectedVariant.recipient_blueprint.length}{" "}
                      {t("file_library.contracts.workflow.common.participants")}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="secondary" size="sm" onClick={() => void configureFields()}>
                      <Settings2 className="size-4" />
                      {t("file_library.contracts.workflow.template_detail.configure_current")}
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => setUsingSelection({ variant: selectedVariant, revisionId: selectedRevision?.id })}
                    >
                      <Send className="size-4" />
                      {selectedRevision
                        ? t("file_library.contracts.workflow.template_detail.use_version", {
                            number: selectedRevision.revision,
                          })
                        : t("file_library.contracts.workflow.template_detail.use_current")}
                    </Button>
                  </div>
                </div>
              </section>
            </div>
          ) : null}
        </section>

        <section className="overflow-hidden rounded-lg border border-subtle">
          <div className="flex items-center justify-between border-b border-subtle px-4 py-3">
            <div>
              <h2 className="text-13 font-semibold text-primary">
                {t("file_library.contracts.workflow.template_detail.created_from_template")}
              </h2>
              <p className="mt-0.5 text-10 text-tertiary">
                {t("file_library.contracts.workflow.template_detail.created_description")}
              </p>
            </div>
            <Link
              to={`/${workspaceSlug}/file-library/contracts/documents`}
              className="text-10 font-medium text-accent-primary hover:underline"
            >
              {t("file_library.contracts.workflow.common.view_all")}
            </Link>
          </div>
          {templateRequests.length === 0 ? (
            <div className="px-4 py-8 text-center text-11 text-tertiary">
              {t("file_library.contracts.workflow.template_detail.no_contracts")}
            </div>
          ) : (
            <div className="divide-y divide-subtle">
              {templateRequests.slice(0, 8).map((request) => {
                const signed = request.signers.filter((signer) => signer.status === "SIGNED").length;
                return (
                  <Link
                    key={request.id}
                    to={`/${workspaceSlug}/file-library/contracts/documents?request=${request.id}`}
                    className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-layer-1-hover"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-11 font-medium text-primary">{request.title}</p>
                      <p className="mt-0.5 text-9 text-tertiary">
                        {t("file_library.contracts.workflow.template_detail.contract_progress", {
                          version: request.revision.revision,
                          signed,
                          total: request.signers.length || request.recipients.length,
                        })}
                      </p>
                    </div>
                    <span
                      className={`shrink-0 rounded-full px-2 py-1 text-9 ${request.status === "COMPLETED" ? "bg-success-primary/10 text-success-primary" : "bg-layer-2 text-secondary"}`}
                    >
                      {t(STATUS_LABEL_KEYS[request.status])}
                    </span>
                  </Link>
                );
              })}
            </div>
          )}
        </section>
      </div>

      <FilePreviewModal
        workspaceSlug={workspaceSlug}
        file={previewFile}
        onClose={() => setPreviewFile(null)}
        scope="contract"
        readOnly
      />
      <CollaboraEditorModal
        workspaceSlug={workspaceSlug}
        assetId={editSession?.phase === "EDITING" ? editSession.variant.source_asset_id : null}
        fileName={editSession?.variant.source_file_name ?? ""}
        deferredCommit
        onClose={() => setEditSession((current) => (current ? { ...current, phase: "CONFIRM" } : current))}
      />
      {usingSelection ? (
        <ContractTemplateUseDialog
          workspaceSlug={workspaceSlug}
          templateName={template.name}
          variant={usingSelection.variant}
          initialRevisionId={usingSelection.revisionId}
          onEditWord={() => {
            void startWordEdit(usingSelection.variant);
          }}
          onClose={() => setUsingSelection(undefined)}
          onPrepared={(request) => {
            setUsingSelection(undefined);
            setAuthoringRequest(request);
            void mutateRequests();
          }}
        />
      ) : null}
      {authoringRequest ? (
        <ContractAuthoringModal
          workspaceSlug={workspaceSlug}
          signatureRequest={authoringRequest}
          onClose={() => setAuthoringRequest(undefined)}
          onSent={() => {
            void mutateRequests();
            void mutateTemplate();
          }}
        />
      ) : null}
      <ContractWordEditDecisionDialog
        key={editSession?.backupAssetId ?? "closed"}
        isOpen={editSession?.phase === "CONFIRM"}
        isSubmitting={isFinishingEdit}
        suggestedRevisionName={t("file_library.contracts.workflow.common.version_number", {
          number: (editSession?.variant.revision_count ?? 0) + 1,
        })}
        onSubmit={(decision, name) => void finishWordEdit(decision, name)}
      />

      <ModalCore
        isOpen={variantModalOpen}
        handleClose={() => setVariantModalOpen(false)}
        position={EModalPosition.CENTER}
        width={EModalWidth.SM}
      >
        <form
          className="p-5"
          onSubmit={(event) => {
            event.preventDefault();
            void createVariant();
          }}
        >
          <h3 className="text-14 font-semibold text-primary">
            {t("file_library.contracts.workflow.template_detail.new_variant")}
          </h3>
          <p className="mt-1 text-10 text-tertiary">
            {t("file_library.contracts.workflow.template_detail.new_variant_description")}
          </p>
          <label className="mt-4 block text-11 font-medium text-secondary">
            {t("file_library.contracts.workflow.common.name")}
            <input
              value={variantDraft}
              onChange={(event) => setVariantDraft(event.target.value)}
              className="focus:border-accent-primary mt-1.5 h-9 w-full rounded-md border border-subtle bg-surface-1 px-3 text-11 outline-none"
              placeholder={t("file_library.contracts.workflow.template_detail.variant_placeholder")}
            />
          </label>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" size="sm" type="button" onClick={() => setVariantModalOpen(false)}>
              {t("file_library.contracts.workflow.common.cancel")}
            </Button>
            <Button variant="primary" size="sm" type="submit" disabled={!variantDraft.trim() || isCreatingVariant}>
              {isCreatingVariant ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}{" "}
              {t("file_library.contracts.workflow.template_detail.create_variant")}
            </Button>
          </div>
        </form>
      </ModalCore>
      <AlertModalCore
        isOpen={deleteOpen}
        handleClose={() => setDeleteOpen(false)}
        handleSubmit={() => void deleteTemplate()}
        isSubmitting={isDeleting}
        title={t("file_library.contracts.workflow.templates.delete_title")}
        content={<>{t("file_library.contracts.workflow.template_detail.delete_description")}</>}
      />
    </div>
  );
}

function ContractVersionCard({
  title,
  subtitle,
  meta,
  thumbnailUrl,
  isSelected,
  onSelect,
}: {
  title: string;
  subtitle: string;
  meta?: string;
  thumbnailUrl: string;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const [thumbnailFailed, setThumbnailFailed] = useState(false);

  return (
    <button
      type="button"
      aria-pressed={isSelected}
      onClick={onSelect}
      className={`group flex w-full gap-3 rounded-lg border p-2 text-left transition-colors ${
        isSelected
          ? "border-accent-strong bg-accent-primary/5 ring-1 ring-accent-strong"
          : "border-subtle bg-surface-1 hover:bg-layer-1-hover"
      }`}
    >
      <span className="shadow-sm grid h-24 w-[4.5rem] shrink-0 place-items-center overflow-hidden rounded border border-subtle bg-layer-1">
        {thumbnailFailed ? (
          <FileText className="size-5 text-tertiary" />
        ) : (
          <img
            src={thumbnailUrl}
            alt=""
            loading="lazy"
            className="size-full bg-white object-cover object-top"
            onError={() => setThumbnailFailed(true)}
          />
        )}
      </span>
      <span className="min-w-0 flex-1 py-1">
        <span className="flex items-center justify-between gap-2">
          <span className="truncate text-11 font-semibold text-primary">{title}</span>
          {isSelected ? <CheckCircle2 className="size-3.5 shrink-0 text-accent-primary" /> : null}
        </span>
        <span className="mt-1 line-clamp-2 text-9 leading-4 text-tertiary">{subtitle}</span>
        {meta ? <span className="mt-2 block text-9 leading-4 text-secondary">{meta}</span> : null}
      </span>
    </button>
  );
}
