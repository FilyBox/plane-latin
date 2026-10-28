/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * Template detail.
 *
 * Variants live in the left rail (parallel presentations of the same contract)
 * and versions in the right rail (the immutable history of one variant). Word
 * edits go to a per-variant draft that is published as a new version, kept
 * for later or discarded; the published document is never edited in place.
 * Servers without the draft endpoints fall back to the older edit session.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  CheckCircle2,
  CopyPlus,
  FileClock,
  FileText,
  Loader2,
  Maximize2,
  Pencil,
  Plus,
  Send,
  Settings2,
  Trash2,
  UserRound,
} from "lucide-react";
import { Link, useNavigate, useSearchParams } from "react-router";
import useSWR, { useSWRConfig } from "swr";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import { Tooltip } from "@plane/propel/tooltip";
import type {
  TContractCollaboraSession,
  TContractDraftPublishResponse,
  TContractTemplate,
  TContractTemplateVariant,
} from "@plane/types";
import { AlertModalCore, CustomMenu, EModalPosition, EModalWidth, ModalCore } from "@plane/ui";
import { cn } from "@plane/utils";
import { contractService } from "@/services/contract.service";
import { CollaboraEditorModal, type TCollaboraCloseState } from "../collabora-editor-modal";
import { FilePreviewModal, type TPreviewFile } from "../file-preview-modal";
import { ContractAssetPreview } from "./contract-asset-preview";
import {
  ContractDraftCloseDialog,
  ContractPublishResultDialog,
  type TDraftCloseAction,
} from "./contract-draft-dialogs";
import { ContractTemplateDetailsDialog } from "./contract-template-details-dialog";
import { ContractTemplateUseDialog } from "./contract-template-use-dialog";
import { ContractVariablesPanel } from "./contract-variables-panel";
import { ContractWordEditDecisionDialog, type TContractEditDecision } from "./contract-word-edit-decision-dialog";
import {
  contractErrorMessage,
  formatTemplateCounts,
  isEndpointMissing,
  requestStatusLabelKey,
  schemaWarnings,
  templateCounts,
  templateFieldEditorUrl,
} from "./template-utils";
import { TemplateWarnings } from "./template-warnings";
import { ContractField, ContractInput, ContractPageHeader, ContractSection, RequestStatusBadge } from "./ui";

type Props = { workspaceSlug: string; templateId: string };
type UseSelection = { variant: TContractTemplateVariant; revisionId?: string };

/** One Word session: a draft (current API) or the legacy in-place edit. */
type WordSession =
  | {
      mode: "DRAFT";
      variant: TContractTemplateVariant;
      editor: TContractCollaboraSession | null;
      assetId: string | null;
      phase: "EDITING" | "CONFIRM";
    }
  | { mode: "LEGACY"; variant: TContractTemplateVariant; backupAssetId: string; phase: "EDITING" | "CONFIRM" };

const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const HEARTBEAT_MS = 30000;
/** A heartbeat older than this means nobody has the editor open. */
const ACTIVE_WINDOW_MS = 90000;
/** Compact Collabora: no properties sidebar or ruler. Unknown keys are ignored by the server. */
const COLLABORA_UI_DEFAULTS = "UIMode=compact;TextSidebar=false;TextRuler=false;SaveAsMode=group";

const nextVersionNumber = (variant?: TContractTemplateVariant) =>
  (variant?.latest_revision?.revision ?? variant?.revision_count ?? 0) + 1;

const isDraftActive = (variant?: TContractTemplateVariant) => {
  const activeAt = variant?.draft?.active_at;
  return Boolean(activeAt && Date.now() - new Date(activeAt).getTime() < ACTIVE_WINDOW_MS);
};

/** The draft holds changes the published document doesn't have. */
const hasPendingDraft = (variant?: TContractTemplateVariant) =>
  Boolean(variant?.draft?.exists && variant.draft.changed !== false);

const formatClock = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleString("es-MX", { dateStyle: "medium", timeStyle: "short" }) : "";

export function ContractTemplateDetail({ workspaceSlug, templateId }: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { mutate: globalMutate } = useSWRConfig();
  const {
    data: template,
    mutate: mutateTemplate,
    isLoading,
  } = useSWR(
    `CONTRACT_TEMPLATE_${workspaceSlug}_${templateId}`,
    () => contractService.getTemplate(workspaceSlug, templateId),
    {
      revalidateOnFocus: false,
      // Keeps "en edición por…" honest while a draft exists.
      refreshInterval: (latest) => (latest?.variants?.some((variant) => variant.draft?.exists) ? HEARTBEAT_MS : 0),
    }
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
  const [wordSession, setWordSession] = useState<WordSession>();
  const [isStartingEdit, setIsStartingEdit] = useState(false);
  const [isFinishingEdit, setIsFinishingEdit] = useState(false);
  const [draftActionError, setDraftActionError] = useState<string>();
  const [publishResult, setPublishResult] = useState<TContractDraftPublishResponse & { versionNumber?: number }>();
  const [discardingDraft, setDiscardingDraft] = useState<TContractTemplateVariant>();
  const [isDraftActing, setIsDraftActing] = useState(false);
  const [usingSelection, setUsingSelection] = useState<UseSelection>();
  const [variantDraft, setVariantDraft] = useState("");
  const [variantModalOpen, setVariantModalOpen] = useState(false);
  const [isCreatingVariant, setIsCreatingVariant] = useState(false);
  const [isConfiguring, setIsConfiguring] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [renamingVariant, setRenamingVariant] = useState<TContractTemplateVariant>();
  const [variantNameDraft, setVariantNameDraft] = useState("");
  const [isRenamingVariant, setIsRenamingVariant] = useState(false);
  const [deletingVariant, setDeletingVariant] = useState<TContractTemplateVariant>();
  const [isDeletingVariant, setIsDeletingVariant] = useState(false);

  // Live variables of the draft being edited, refreshed after each save.
  const draftVariantId = wordSession?.mode === "DRAFT" ? wordSession.variant.id : undefined;
  const {
    data: draftSchema,
    mutate: mutateDraftSchema,
    isValidating: isDraftSchemaValidating,
  } = useSWR(
    draftVariantId ? `CONTRACT_TEMPLATE_SCHEMA_${workspaceSlug}_${draftVariantId}_DRAFT` : null,
    () =>
      contractService
        .getTemplateSchema(workspaceSlug, draftVariantId!, undefined, { draft: true })
        .catch(() => contractService.getTemplateSchema(workspaceSlug, draftVariantId!)),
    { revalidateOnFocus: false }
  );

  // ?variant=<id> (the assistant's link to a variant it made) selects it
  const [searchParams] = useSearchParams();
  const linkedVariantId = searchParams.get("variant");
  useEffect(() => {
    if (!template) return;
    if (linkedVariantId && template.variants.some((variant) => variant.id === linkedVariantId)) {
      if (!selectedVariantId) setSelectedVariantId(linkedVariantId);
      return;
    }
    if (!selectedVariantId && template.variants[0]) setSelectedVariantId(template.variants[0].id);
  }, [selectedVariantId, template, linkedVariantId]);

  useEffect(() => {
    setSelectedVersionId("CURRENT");
  }, [selectedVariant?.id]);

  /** Every cached schema of this template (detail, use dialog) after the document changes. */
  const refreshSchemas = useCallback(
    () =>
      // No data argument: revalidate in place instead of clearing the cache.
      globalMutate((key) => typeof key === "string" && key.startsWith(`CONTRACT_TEMPLATE_SCHEMA_${workspaceSlug}_`)),
    [globalMutate, workspaceSlug]
  );

  // heartbeat while the draft editor is open
  const editingDraftVariantId =
    wordSession?.mode === "DRAFT" && wordSession.phase === "EDITING" ? wordSession.variant.id : undefined;
  useEffect(() => {
    if (!editingDraftVariantId) return;
    const timer = window.setInterval(() => {
      contractService.heartbeatTemplateDraft(workspaceSlug, editingDraftVariantId).catch(() => undefined);
    }, HEARTBEAT_MS);
    return () => window.clearInterval(timer);
  }, [editingDraftVariantId, workspaceSlug]);

  // Leaving the page with the editor open still frees the draft for others.
  const editingRef = useRef(editingDraftVariantId);
  editingRef.current = editingDraftVariantId;
  useEffect(
    () => () => {
      if (editingRef.current)
        contractService.releaseTemplateDraft(workspaceSlug, editingRef.current).catch(() => undefined);
    },
    [workspaceSlug]
  );

  /** Legacy path: the older API edits the live document behind a backup. */
  const startLegacyEdit = useCallback(
    async (variant: TContractTemplateVariant) => {
      const session = await contractService.startTemplateEditSession(workspaceSlug, variant.id);
      setWordSession({ mode: "LEGACY", variant, backupAssetId: session.backup_asset_id, phase: "EDITING" });
    },
    [workspaceSlug]
  );

  const startWordEdit = useCallback(
    async (variant: TContractTemplateVariant) => {
      if (isStartingEdit || wordSession?.phase === "EDITING") return;
      setIsStartingEdit(true);
      try {
        try {
          const result = await contractService.startTemplateDraft(workspaceSlug, variant.id);
          const assetId = result?.draft?.asset_id ?? null;
          if (!result?.editor && !assetId) {
            await startLegacyEdit(variant);
            return;
          }
          setDraftActionError(undefined);
          setWordSession({ mode: "DRAFT", variant, editor: result.editor ?? null, assetId, phase: "EDITING" });
          void mutateTemplate();
        } catch (error) {
          if (!isEndpointMissing(error)) throw error;
          await startLegacyEdit(variant);
        }
      } catch (error) {
        setToast({
          type: TOAST_TYPE.ERROR,
          title: contractErrorMessage(t, error, "file_library.contracts.workflow.template_detail.edit_start_failed"),
        });
      } finally {
        setIsStartingEdit(false);
      }
    },
    [isStartingEdit, mutateTemplate, startLegacyEdit, t, wordSession?.phase, workspaceSlug]
  );

  /** The editor closed: free the draft, then ask only if something changed. */
  const onEditorClosed = async (state: TCollaboraCloseState) => {
    if (!wordSession) return;
    if (wordSession.mode === "LEGACY") {
      setWordSession({ ...wordSession, phase: "CONFIRM" });
      return;
    }
    const session = wordSession;
    contractService.releaseTemplateDraft(workspaceSlug, session.variant.id).catch(() => undefined);
    const latest: TContractTemplate | undefined = await mutateTemplate();
    const draft = latest?.variants.find((variant) => variant.id === session.variant.id)?.draft;
    // Trust the server when it says the draft equals the published document.
    const changed = draft ? draft.exists && draft.changed !== false : state.modified;
    if (!changed || !state.modified) {
      setWordSession(undefined);
      return;
    }
    setDraftActionError(undefined);
    setWordSession({ ...session, phase: "CONFIRM" });
  };

  const publishDraft = async (variant: TContractTemplateVariant, name?: string) => {
    const result = await contractService.publishTemplateDraft(workspaceSlug, variant.id, name);
    await Promise.all([mutateTemplate(), mutateSchema(), refreshSchemas()]);
    if (result?.unchanged) {
      setToast({ type: TOAST_TYPE.INFO, title: t("file_library.contracts.workflow.draft.unchanged") });
      return;
    }
    if (result?.revision?.id) setSelectedVersionId(result.revision.id);
    setPublishResult({ ...result, versionNumber: result?.revision?.revision ?? nextVersionNumber(variant) });
  };

  const submitDraftAction = async (action: TDraftCloseAction, name?: string) => {
    if (wordSession?.mode !== "DRAFT") return;
    const { variant } = wordSession;
    setIsFinishingEdit(true);
    setDraftActionError(undefined);
    try {
      if (action === "PUBLISH") await publishDraft(variant, name);
      else if (action === "DISCARD") {
        await contractService.discardTemplateDraft(workspaceSlug, variant.id);
        await mutateTemplate();
        setToast({
          type: TOAST_TYPE.SUCCESS,
          title: t("file_library.contracts.workflow.template_detail.changes_discarded"),
        });
      } else if (action === "NEW_VARIANT" && name) {
        const before = new Set(template?.variants.map((item) => item.id));
        const result = await contractService.saveTemplateDraftAsVariant(workspaceSlug, variant.id, name);
        const latest: TContractTemplate | undefined = result?.template
          ? await mutateTemplate(result.template, { revalidate: true })
          : await mutateTemplate();
        const newId =
          result?.variant_id ??
          result?.variant?.id ??
          latest?.variants.find((item) => !before.has(item.id))?.id ??
          latest?.variants.find((item) => item.name === name)?.id;
        if (newId) setSelectedVariantId(newId);
        setToast({
          type: TOAST_TYPE.SUCCESS,
          title: t("file_library.contracts.workflow.template_detail.variant_created"),
        });
      }
      // KEEP: nothing to call — the draft stays and the banner offers it again.
      setWordSession(undefined);
    } catch (error) {
      setDraftActionError(
        contractErrorMessage(t, error, "file_library.contracts.workflow.template_detail.apply_failed")
      );
    } finally {
      setIsFinishingEdit(false);
    }
  };

  /** "Publicar" from the banner, without opening Word. */
  const publishFromBanner = async (variant: TContractTemplateVariant) => {
    setIsDraftActing(true);
    try {
      await publishDraft(variant);
    } catch (error) {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: contractErrorMessage(t, error, "file_library.contracts.workflow.template_detail.apply_failed"),
      });
    } finally {
      setIsDraftActing(false);
    }
  };

  const discardFromBanner = async () => {
    if (!discardingDraft) return;
    setIsDraftActing(true);
    try {
      await contractService.discardTemplateDraft(workspaceSlug, discardingDraft.id);
      await mutateTemplate();
      setDiscardingDraft(undefined);
      setToast({
        type: TOAST_TYPE.SUCCESS,
        title: t("file_library.contracts.workflow.template_detail.changes_discarded"),
      });
    } catch (error) {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: contractErrorMessage(t, error, "file_library.contracts.workflow.template_detail.apply_failed"),
      });
    } finally {
      setIsDraftActing(false);
    }
  };

  const templateRequests = useMemo(
    () =>
      (requests ?? []).filter(
        (request) =>
          // Template-configuration requests are internal plumbing, not contracts
          // the user created — they must not show up in this list.
          request.authoring_mode !== "TEMPLATE" &&
          template?.variants.some((variant) => variant.id === request.revision.variant_id)
      ),
    [requests, template]
  );

  const createVariant = async () => {
    if (!template || !selectedVariant || !variantDraft.trim()) return;
    setIsCreatingVariant(true);
    const name = variantDraft.trim();
    const before = new Set(template.variants.map((variant) => variant.id));
    try {
      const updated = await contractService.createVariant(workspaceSlug, template.id, {
        name,
        source_variant_id: selectedVariant.id,
      });
      await mutateTemplate(updated, { revalidate: true });
      setVariantModalOpen(false);
      setVariantDraft("");
      // The new one, not whichever sorts last.
      const created =
        updated.variants.find((variant) => !before.has(variant.id)) ??
        updated.variants.find((variant) => variant.name === name);
      if (created) setSelectedVariantId(created.id);
      setToast({
        type: TOAST_TYPE.SUCCESS,
        title: t("file_library.contracts.workflow.template_detail.variant_created"),
      });
    } catch (error) {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: contractErrorMessage(t, error, "file_library.contracts.workflow.template_detail.variant_create_failed"),
      });
    } finally {
      setIsCreatingVariant(false);
    }
  };

  /** Opens the shared field editor in template mode, then comes back here. */
  const configureFields = async () => {
    if (!selectedVariant || !template || isConfiguring) return;
    setIsConfiguring(true);
    try {
      const request = await contractService.prepareSignatureRequest(workspaceSlug, {
        variant_id: selectedVariant.id,
        title: template.name,
        authoring_mode: "TEMPLATE",
      });
      navigate(templateFieldEditorUrl(workspaceSlug, request.id, template.id));
    } catch (error) {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: contractErrorMessage(t, error, "file_library.contracts.workflow.template_detail.configuration_failed"),
      });
    } finally {
      setIsConfiguring(false);
    }
  };

  const openRenameVariant = (variant: TContractTemplateVariant) => {
    setVariantNameDraft(variant.name);
    setRenamingVariant(variant);
  };

  const renameVariant = async () => {
    const name = variantNameDraft.trim();
    if (!renamingVariant || !name) return;
    setIsRenamingVariant(true);
    try {
      await contractService.updateVariant(workspaceSlug, renamingVariant.id, { name });
      await mutateTemplate();
      setRenamingVariant(undefined);
      setToast({
        type: TOAST_TYPE.SUCCESS,
        title: t("file_library.contracts.workflow.template_detail.variant_renamed"),
      });
    } catch (error) {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: contractErrorMessage(t, error, "file_library.contracts.workflow.template_detail.variant_rename_failed"),
      });
    } finally {
      setIsRenamingVariant(false);
    }
  };

  const deleteVariant = async () => {
    if (!template || !deletingVariant) return;
    setIsDeletingVariant(true);
    try {
      await contractService.deleteVariant(workspaceSlug, deletingVariant.id);
      // Move the selection off the deleted variant before the list refreshes.
      if (selectedVariant?.id === deletingVariant.id)
        setSelectedVariantId(template.variants.find((variant) => variant.id !== deletingVariant.id)?.id);
      setDeletingVariant(undefined);
      await mutateTemplate();
      setToast({
        type: TOAST_TYPE.SUCCESS,
        title: t("file_library.contracts.workflow.template_detail.variant_deleted"),
      });
    } catch (error) {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: contractErrorMessage(t, error, "file_library.contracts.workflow.template_detail.variant_delete_failed"),
      });
    } finally {
      setIsDeletingVariant(false);
    }
  };

  const deleteTemplate = async () => {
    if (!template) return;
    setIsDeleting(true);
    try {
      await contractService.deleteTemplate(workspaceSlug, template.id);
      setToast({
        type: TOAST_TYPE.SUCCESS,
        title: t("file_library.contracts.workflow.templates.deleted"),
      });
      navigate(`/${workspaceSlug}/file-library/contracts/templates`);
    } catch (error) {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: contractErrorMessage(t, error, "file_library.contracts.workflow.templates.delete_failed"),
      });
    } finally {
      setIsDeleting(false);
    }
  };

  /** Legacy decision (older API only). */
  const finishLegacyEdit = async (decision: TContractEditDecision, name?: string) => {
    if (wordSession?.mode !== "LEGACY") return;
    setIsFinishingEdit(true);
    try {
      const result = await contractService.finishTemplateEditSession(workspaceSlug, wordSession.variant.id, {
        backup_asset_id: wordSession.backupAssetId,
        action: decision,
        name,
      });
      await mutateTemplate(result.template, { revalidate: false });
      setSelectedVariantId(result.variant_id);
      setSelectedVersionId(result.revision_id ?? "CURRENT");
      setWordSession(undefined);
      await Promise.all([mutateTemplate(), mutateSchema(), mutateRequests(), refreshSchemas()]);
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
    } catch (error) {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: contractErrorMessage(t, error, "file_library.contracts.workflow.template_detail.apply_failed"),
      });
    } finally {
      setIsFinishingEdit(false);
    }
  };

  const selectedRevision = schema?.revisions.find((revision) => revision.id === selectedVersionId);
  // The current document usually equals the latest version: reuse that PDF
  // instead of converting the Word file again.
  const matchingRevision = schema?.revisions.find((revision) => revision.content_sha256 === schema.content_sha256);
  const previewRevision = selectedRevision ?? (selectedVersionId === "CURRENT" ? matchingRevision : undefined);
  const selectedAsset = previewRevision
    ? {
        assetId: previewRevision.pdf_asset_id,
        version: previewRevision.content_sha256,
        name: `${t("file_library.contracts.workflow.template_detail.revision_pdf_name", {
          name: template?.name ?? t("file_library.contracts.workflow.common.contract"),
          number: previewRevision.revision,
        })}.pdf`,
        contentType: "application/pdf" as const,
      }
    : selectedVariant && schema
      ? {
          assetId: selectedVariant.source_asset_id,
          version: schema.content_sha256 ?? selectedVariant.updated_at,
          name: selectedVariant.source_file_name,
          contentType: DOCX_TYPE,
        }
      : undefined;

  // One count for every screen: token-derived signers and fields included.
  const counts = templateCounts({
    summary: selectedRevision ? selectedRevision.variable_schema?.summary : schema?.summary,
    schema: selectedRevision?.variable_schema ?? schema?.schema,
    recipientBlueprint: selectedRevision?.recipient_blueprint ?? selectedVariant?.recipient_blueprint,
    signatureBlueprint: selectedRevision?.signature_blueprint ?? selectedVariant?.signature_blueprint,
  });
  const warnings = selectedRevision ? (selectedRevision.variable_schema?.warnings ?? []) : schemaWarnings(schema);
  const isConfigured = counts.fields > 0 && counts.signers > 0;
  const pendingDraft = hasPendingDraft(selectedVariant);
  const activeEditor =
    !wordSession && isDraftActive(selectedVariant) ? selectedVariant?.draft?.active_by_name : undefined;

  if (isLoading || !template)
    return (
      <div className="grid h-full place-items-center">
        <Loader2 className="size-5 animate-spin text-tertiary" />
      </div>
    );

  const useButton = selectedVariant ? (
    <Tooltip
      tooltipContent={t("file_library.contracts.workflow.template_detail.use_blocked_hint")}
      disabled={isConfigured}
    >
      {/* The wrapper keeps the tooltip reachable: a disabled button gets no pointer events. */}
      <span className="inline-flex">
        <Button
          variant={isConfigured ? "primary" : "secondary"}
          size="sm"
          disabled={!isConfigured}
          className={cn(!isConfigured && "pointer-events-none")}
          onClick={() => setUsingSelection({ variant: selectedVariant, revisionId: selectedRevision?.id })}
        >
          <Send className="size-4" />
          {selectedRevision
            ? t("file_library.contracts.workflow.template_detail.use_version", {
                number: selectedRevision.revision,
              })
            : t("file_library.contracts.workflow.template_detail.use_current")}
        </Button>
      </span>
    </Tooltip>
  ) : null;

  return (
    <div className="h-full overflow-y-auto">
      <div className="w-full space-y-5 px-4 py-5 sm:px-5 lg:px-6">
        <ContractPageHeader
          title={template.name}
          description={template.description || undefined}
          actions={
            <>
              <Button variant="secondary" size="sm" onClick={() => setDetailsOpen(true)}>
                <Pencil className="size-4" /> {t("file_library.contracts.workflow.template_detail.edit_details")}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setDeleteOpen(true)}>
                <Trash2 className="size-4" /> {t("file_library.contracts.workflow.common.delete")}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setVariantModalOpen(true)}>
                <CopyPlus className="size-4" /> {t("file_library.contracts.workflow.template_detail.new_variant")}
              </Button>
            </>
          }
        />

        {selectedVariant ? (
          <>
            {pendingDraft && !wordSession ? (
              <DraftBanner
                variant={selectedVariant}
                activeEditor={activeEditor ?? undefined}
                isActing={isDraftActing}
                onPublish={() => void publishFromBanner(selectedVariant)}
                onDiscard={() => setDiscardingDraft(selectedVariant)}
                onContinue={() => void startWordEdit(selectedVariant)}
              />
            ) : activeEditor ? (
              <div className="flex items-center gap-2 rounded-lg border border-subtle bg-layer-1 px-4 py-2.5 text-12 text-secondary">
                <UserRound className="size-4 shrink-0 text-accent-primary" />
                {t("file_library.contracts.workflow.draft.editing_by", {
                  name: activeEditor,
                  date: formatClock(selectedVariant.draft?.started_at),
                })}
              </div>
            ) : null}

            {/* Until the template can be used, what is missing comes first. */}
            {!isSchemaLoading && (!isConfigured || warnings.length > 0) ? (
              <PreparationChecklist
                isConfigured={isConfigured}
                countsLabel={formatTemplateCounts(t, counts)}
                fileName={selectedVariant.source_file_name}
                warnings={warnings}
                isConfiguring={isConfiguring}
                onConfigure={() => void configureFields()}
              />
            ) : null}

            <div className="grid gap-4 xl:grid-cols-[13rem_minmax(0,1fr)]">
              {/* variants: parallel presentations of the same contract */}
              <VariantRail
                variants={template.variants}
                selectedVariantId={selectedVariant.id}
                onSelect={setSelectedVariantId}
                onCreate={() => setVariantModalOpen(true)}
                onRename={openRenameVariant}
                onDelete={setDeletingVariant}
              />

              <ContractSection
                title={
                  selectedRevision
                    ? t("file_library.contracts.workflow.common.version_number", {
                        number: selectedRevision.revision,
                      })
                    : t("file_library.contracts.workflow.common.current_document")
                }
                description={selectedAsset?.name ?? selectedVariant.source_file_name}
                icon={<FileText className="size-4" />}
                actions={
                  <>
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
                            // The extension has to be on the name: the preview
                            // modal picks its viewer from it, not only from the MIME.
                            name: `${t("file_library.contracts.workflow.template_detail.revision_word_name", {
                              name: template.name,
                              number: selectedRevision.revision,
                            })}.docx`,
                            contentType: DOCX_TYPE,
                          })
                        }
                      >
                        {t("file_library.contracts.workflow.common.view_word")}
                      </Button>
                    ) : null}
                    {/* Editing always targets the variant's draft — saved
                        versions are immutable — so this stays available
                        whichever version is being previewed. */}
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={isStartingEdit}
                      onClick={() => void startWordEdit(selectedVariant)}
                    >
                      {isStartingEdit ? <Loader2 className="size-4 animate-spin" /> : null}
                      {pendingDraft
                        ? t("file_library.contracts.workflow.draft.continue_editing")
                        : t("file_library.contracts.workflow.common.edit_word")}
                    </Button>
                  </>
                }
              >
                <div className="grid min-h-140 xl:grid-cols-[minmax(0,1fr)_17rem]">
                  <div className="min-h-140 p-3 sm:p-4">
                    {selectedAsset ? (
                      <ContractAssetPreview
                        key={`${selectedAsset.assetId}-${selectedAsset.version}`}
                        workspaceSlug={workspaceSlug}
                        assetId={selectedAsset.assetId}
                        fileName={selectedAsset.name}
                        contentType={selectedAsset.contentType}
                        version={selectedAsset.version}
                        className="shadow-sm h-[min(64vh,720px)] min-h-130 overflow-hidden rounded-md border border-subtle bg-surface-1"
                      />
                    ) : (
                      <div className="grid h-[min(64vh,720px)] min-h-130 place-items-center rounded-md border border-subtle bg-surface-1">
                        <Loader2 className="size-5 animate-spin text-tertiary" />
                      </div>
                    )}
                  </div>

                  {/* versions: the immutable history of this variant */}
                  <aside className="flex min-h-0 flex-col border-t border-subtle xl:border-t-0 xl:border-l">
                    <div className="border-b border-subtle px-3 py-3">
                      <p className="text-13 font-semibold text-primary">
                        {t("file_library.contracts.workflow.template_detail.choose_version")}
                      </p>
                      <p className="mt-0.5 text-11 text-tertiary">
                        {t("file_library.contracts.workflow.template_detail.choose_version_hint")}
                      </p>
                    </div>
                    <div className="max-h-[min(64vh,720px)] space-y-2 overflow-y-auto p-2.5">
                      <ContractVersionCard
                        isSelected={selectedVersionId === "CURRENT"}
                        title={t("file_library.contracts.workflow.common.current_document")}
                        subtitle={
                          matchingRevision
                            ? t("file_library.contracts.workflow.detail.current_matches", {
                                number: matchingRevision.revision,
                              })
                            : t("file_library.contracts.workflow.template_detail.current_subtitle")
                        }
                        thumbnailUrl={contractService.getContractAssetThumbnailUrl(
                          workspaceSlug,
                          matchingRevision?.pdf_asset_id ?? selectedVariant.source_asset_id,
                          matchingRevision?.content_sha256 ?? schema?.content_sha256 ?? selectedVariant.updated_at
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
                          meta={formatTemplateCounts(
                            t,
                            templateCounts({
                              schema: revision.variable_schema,
                              recipientBlueprint: revision.recipient_blueprint,
                              signatureBlueprint: revision.signature_blueprint,
                            })
                          )}
                          thumbnailUrl={contractService.getContractAssetThumbnailUrl(
                            workspaceSlug,
                            revision.pdf_asset_id,
                            revision.content_sha256
                          )}
                          onSelect={() => setSelectedVersionId(revision.id)}
                        />
                      ))}
                      {!isSchemaLoading && (schema?.revisions.length ?? 0) === 0 ? (
                        <p className="rounded-md border border-dashed border-subtle p-3 text-center text-11 text-tertiary">
                          {t("file_library.contracts.workflow.detail.no_versions")}
                        </p>
                      ) : null}
                    </div>
                  </aside>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-subtle p-4">
                  <p className="text-11 text-tertiary">{formatTemplateCounts(t, counts)}</p>
                  <div className="flex flex-wrap gap-2">
                    {/* While setup is incomplete the checklist above owns this button. */}
                    {isConfigured ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={isConfiguring}
                        onClick={() => void configureFields()}
                      >
                        {isConfiguring ? <Loader2 className="size-4 animate-spin" /> : <Settings2 className="size-4" />}
                        {t("file_library.contracts.workflow.detail.configure_fields")}
                      </Button>
                    ) : null}
                    {useButton}
                  </div>
                </div>
              </ContractSection>
            </div>
          </>
        ) : null}

        <ContractSection
          title={t("file_library.contracts.workflow.template_detail.created_from_template")}
          description={t("file_library.contracts.workflow.template_detail.created_description")}
          actions={
            <Link
              to={`/${workspaceSlug}/file-library/contracts/documents`}
              className="text-11 font-medium text-accent-primary hover:underline"
            >
              {t("file_library.contracts.workflow.common.view_all")}
            </Link>
          }
        >
          {templateRequests.length === 0 ? (
            <div className="px-4 py-8 text-center text-13 text-tertiary">
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
                      <p className="truncate text-13 font-medium text-primary">{request.title}</p>
                      <p className="mt-0.5 text-11 text-tertiary">
                        {t("file_library.contracts.workflow.template_detail.contract_progress", {
                          version: request.revision.revision,
                          signed,
                          total: request.signers.length || request.recipients.length,
                        })}
                      </p>
                    </div>
                    <RequestStatusBadge status={request.status} label={t(requestStatusLabelKey(request.status))} />
                  </Link>
                );
              })}
            </div>
          )}
        </ContractSection>
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
        session={wordSession?.mode === "DRAFT" && wordSession.phase === "EDITING" ? wordSession.editor : null}
        assetId={
          wordSession?.phase !== "EDITING"
            ? null
            : wordSession.mode === "LEGACY"
              ? wordSession.variant.source_asset_id
              : wordSession.editor
                ? null
                : wordSession.assetId
        }
        fileName={template.name}
        subtitle={
          wordSession
            ? t(
                wordSession.mode === "DRAFT"
                  ? "file_library.contracts.workflow.word_editor.subtitle_draft"
                  : "file_library.contracts.workflow.word_editor.subtitle_live",
                { variant: wordSession.variant.name }
              )
            : undefined
        }
        uiDefaults={COLLABORA_UI_DEFAULTS}
        variablesPanel={
          wordSession?.mode === "DRAFT" ? (
            <ContractVariablesPanel
              documentVariables={{
                schema: draftSchema?.schema,
                summary: draftSchema?.summary,
                warnings: schemaWarnings(draftSchema),
                isLoading: isDraftSchemaValidating,
                variableSettings: wordSession.variant.variable_settings,
                recipientRoles: wordSession.variant.recipient_roles,
              }}
            />
          ) : undefined
        }
        onSaved={wordSession?.mode === "DRAFT" ? () => void mutateDraftSchema() : undefined}
        onClose={(state) => void onEditorClosed(state)}
      />
      {usingSelection ? (
        <ContractTemplateUseDialog
          workspaceSlug={workspaceSlug}
          templateName={template.name}
          variant={
            template.variants.find((variant) => variant.id === usingSelection.variant.id) ?? usingSelection.variant
          }
          initialRevisionId={usingSelection.revisionId}
          onEditWord={() => {
            void startWordEdit(usingSelection.variant);
          }}
          onClose={() => setUsingSelection(undefined)}
          onPrepared={(request) => {
            setUsingSelection(undefined);
            void mutateRequests();
            const returnTo = `/${workspaceSlug}/file-library/contracts/templates/${template.id}`;
            navigate(
              `/${workspaceSlug}/file-library/contracts/documents/${request.id}/editor?returnTo=${encodeURIComponent(returnTo)}`
            );
          }}
        />
      ) : null}
      {wordSession?.mode === "DRAFT" ? (
        <ContractDraftCloseDialog
          key={`${wordSession.variant.id}-${wordSession.phase}`}
          isOpen={wordSession.phase === "CONFIRM"}
          nextVersionNumber={nextVersionNumber(
            template.variants.find((variant) => variant.id === wordSession.variant.id) ?? wordSession.variant
          )}
          isSubmitting={isFinishingEdit}
          error={draftActionError}
          onSubmit={(action, name) => void submitDraftAction(action, name)}
          onKeepEditing={() => {
            const { variant } = wordSession;
            setWordSession(undefined);
            void startWordEdit(variant);
          }}
          onDismiss={() => setWordSession(undefined)}
        />
      ) : null}
      <ContractWordEditDecisionDialog
        key={wordSession?.mode === "LEGACY" ? wordSession.backupAssetId : "closed"}
        isOpen={wordSession?.mode === "LEGACY" && wordSession.phase === "CONFIRM"}
        isSubmitting={isFinishingEdit}
        hasVersions={(wordSession?.variant.revision_count ?? 0) > 0}
        suggestedRevisionName={t("file_library.contracts.workflow.common.version_number", {
          number: nextVersionNumber(wordSession?.variant),
        })}
        onKeepEditing={() =>
          setWordSession((current) => (current?.mode === "LEGACY" ? { ...current, phase: "EDITING" } : current))
        }
        onSubmit={(decision, name) => void finishLegacyEdit(decision, name)}
      />
      <ContractPublishResultDialog
        result={publishResult}
        onClose={() => setPublishResult(undefined)}
        onReviewFields={() => {
          setPublishResult(undefined);
          void configureFields();
        }}
      />
      <AlertModalCore
        isOpen={Boolean(discardingDraft)}
        handleClose={() => setDiscardingDraft(undefined)}
        handleSubmit={() => void discardFromBanner()}
        isSubmitting={isDraftActing}
        title={t("file_library.contracts.workflow.draft.discard_banner_title")}
        content={t("file_library.contracts.workflow.draft.discard_banner_description")}
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
          <h3 className="text-15 font-semibold text-primary">
            {t("file_library.contracts.workflow.template_detail.new_variant")}
          </h3>
          <p className="mt-1 text-11 text-tertiary">
            {t("file_library.contracts.workflow.template_detail.new_variant_description")}
          </p>
          <ContractField className="mt-4" label={t("file_library.contracts.workflow.common.name")}>
            <ContractInput
              value={variantDraft}
              onChange={(event) => setVariantDraft(event.target.value)}
              placeholder={t("file_library.contracts.workflow.template_detail.variant_placeholder")}
            />
          </ContractField>
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
      <ContractTemplateDetailsDialog
        workspaceSlug={workspaceSlug}
        template={detailsOpen ? template : undefined}
        onClose={() => setDetailsOpen(false)}
        onSaved={(updated) => {
          setDetailsOpen(false);
          void mutateTemplate(updated, { revalidate: true });
        }}
      />
      <ModalCore
        isOpen={Boolean(renamingVariant)}
        handleClose={() => setRenamingVariant(undefined)}
        position={EModalPosition.CENTER}
        width={EModalWidth.SM}
      >
        <form
          className="p-5"
          onSubmit={(event) => {
            event.preventDefault();
            void renameVariant();
          }}
        >
          <h3 className="text-15 font-semibold text-primary">
            {t("file_library.contracts.workflow.template_detail.rename_variant_title")}
          </h3>
          <ContractField className="mt-4" label={t("file_library.contracts.workflow.common.name")}>
            <ContractInput
              value={variantNameDraft}
              onChange={(event) => setVariantNameDraft(event.target.value)}
              placeholder={t("file_library.contracts.workflow.template_detail.variant_placeholder")}
            />
          </ContractField>
          <div className="mt-5 flex justify-end gap-2">
            <Button
              variant="secondary"
              size="sm"
              type="button"
              disabled={isRenamingVariant}
              onClick={() => setRenamingVariant(undefined)}
            >
              {t("file_library.contracts.workflow.common.cancel")}
            </Button>
            <Button
              variant="primary"
              size="sm"
              type="submit"
              disabled={
                !variantNameDraft.trim() || variantNameDraft.trim() === renamingVariant?.name || isRenamingVariant
              }
            >
              {isRenamingVariant ? <Loader2 className="size-4 animate-spin" /> : null}
              {t("file_library.contracts.workflow.templates.save")}
            </Button>
          </div>
        </form>
      </ModalCore>
      <AlertModalCore
        isOpen={Boolean(deletingVariant)}
        handleClose={() => setDeletingVariant(undefined)}
        handleSubmit={() => void deleteVariant()}
        isSubmitting={isDeletingVariant}
        title={t("file_library.contracts.workflow.template_detail.delete_variant")}
        content={t("file_library.contracts.workflow.template_detail.delete_variant_description", {
          name: deletingVariant?.name ?? "",
        })}
      />
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

/** "Borrador sin publicar": the draft waits until someone publishes or drops it. */
function DraftBanner({
  variant,
  activeEditor,
  isActing,
  onPublish,
  onDiscard,
  onContinue,
}: {
  variant: TContractTemplateVariant;
  activeEditor?: string;
  isActing: boolean;
  onPublish: () => void;
  onDiscard: () => void;
  onContinue: () => void;
}) {
  const { t } = useTranslation();
  const draft = variant.draft;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-subtle bg-layer-1 px-4 py-3">
      <div className="flex min-w-0 items-start gap-2.5">
        <FileClock className="mt-0.5 size-4 shrink-0 text-warning-primary" />
        <div className="min-w-0">
          <p className="text-13 font-medium text-primary">
            {t("file_library.contracts.workflow.draft.banner_title", { variant: variant.name })}
          </p>
          <p className="mt-0.5 text-11 text-tertiary">
            {activeEditor
              ? t("file_library.contracts.workflow.draft.editing_by", {
                  name: activeEditor,
                  date: formatClock(draft?.started_at),
                })
              : t("file_library.contracts.workflow.draft.banner_description", {
                  name: draft?.started_by_name ?? "—",
                  date: formatClock(draft?.updated_at ?? draft?.started_at),
                })}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        <Button variant="secondary" size="sm" disabled={isActing} onClick={onDiscard}>
          {t("file_library.contracts.workflow.draft.discard_short")}
        </Button>
        <Button variant="secondary" size="sm" disabled={isActing} onClick={onContinue}>
          {t("file_library.contracts.workflow.draft.continue_editing")}
        </Button>
        <Button variant="primary" size="sm" disabled={isActing || Boolean(activeEditor)} onClick={onPublish}>
          {isActing ? <Loader2 className="size-4 animate-spin" /> : null}
          {t("file_library.contracts.workflow.draft.publish_confirm", { number: nextVersionNumber(variant) })}
        </Button>
      </div>
    </div>
  );
}

/**
 * What stands between the uploaded Word file and a contract that can be sent.
 * Shown on top while incomplete (or while the document has warnings), with the
 * only "Configure" button on the page at that moment.
 */
function PreparationChecklist({
  isConfigured,
  countsLabel,
  fileName,
  warnings,
  isConfiguring,
  onConfigure,
}: {
  isConfigured: boolean;
  countsLabel: string;
  fileName: string;
  warnings: Parameters<typeof TemplateWarnings>[0]["warnings"];
  isConfiguring: boolean;
  onConfigure: () => void;
}) {
  const { t } = useTranslation();
  const steps = [
    {
      key: "document",
      done: true,
      title: t("file_library.contracts.workflow.template_detail.step_document"),
      detail: `${fileName} · ${countsLabel}`,
    },
    {
      key: "fields",
      done: isConfigured,
      title: t("file_library.contracts.workflow.template_detail.step_fields"),
      detail: isConfigured
        ? t("file_library.contracts.workflow.detail.fields_ready")
        : t("file_library.contracts.workflow.template_detail.step_fields_todo"),
    },
  ];
  const done = steps.filter((step) => step.done).length;

  return (
    <ContractSection
      title={t("file_library.contracts.workflow.template_detail.preparation_title")}
      description={t("file_library.contracts.workflow.template_detail.preparation_progress", {
        done,
        total: steps.length,
      })}
      actions={
        isConfigured ? null : (
          <Button variant="primary" size="sm" disabled={isConfiguring} onClick={onConfigure}>
            {isConfiguring ? <Loader2 className="size-3.5 animate-spin" /> : <Settings2 className="size-3.5" />}
            {t("file_library.contracts.workflow.detail.configure_fields")}
          </Button>
        )
      }
      bodyClassName="divide-y divide-subtle"
    >
      {steps.map((step) => (
        <div key={step.key} className="flex items-center gap-3 px-4 py-3">
          <span
            className={cn(
              "grid size-5 shrink-0 place-items-center rounded-full border",
              step.done ? "border-success-primary bg-success-primary text-on-color" : "border-strong text-tertiary"
            )}
          >
            {step.done ? <Check className="size-3" /> : null}
          </span>
          <div className="min-w-0 flex-1">
            <p className={cn("truncate text-13 font-medium", step.done ? "text-primary" : "text-secondary")}>
              {step.title}
            </p>
            <p className="truncate text-11 text-tertiary">{step.detail}</p>
          </div>
        </div>
      ))}
      {warnings.length > 0 ? (
        <div className="px-4 py-3">
          <TemplateWarnings warnings={warnings} />
        </div>
      ) : null}
    </ContractSection>
  );
}

/** Variants are siblings, not history — a rail, never a dropdown. */
function VariantRail({
  variants,
  selectedVariantId,
  onSelect,
  onCreate,
  onRename,
  onDelete,
}: {
  variants: TContractTemplateVariant[];
  selectedVariantId: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRename: (variant: TContractTemplateVariant) => void;
  onDelete: (variant: TContractTemplateVariant) => void;
}) {
  const { t } = useTranslation();
  // The server refuses to delete the last variant; say why up front.
  const canDelete = variants.length > 1;
  return (
    <aside className="xl:sticky xl:top-0 xl:self-start">
      <p className="mb-2 px-1 text-11 font-semibold text-tertiary">
        {t("file_library.contracts.workflow.common.variants")}
      </p>
      <ul className="space-y-1">
        {variants.map((variant) => {
          const isSelected = variant.id === selectedVariantId;
          return (
            <li key={variant.id} className="relative">
              <button
                type="button"
                aria-current={isSelected ? "true" : undefined}
                onClick={() => onSelect(variant.id)}
                className={cn(
                  "w-full rounded-md border py-2 pr-9 pl-3 text-left transition-colors",
                  isSelected
                    ? "border-accent-strong bg-accent-subtle-hover"
                    : "border-transparent hover:bg-layer-1-hover"
                )}
              >
                <span
                  className={cn(
                    "block truncate text-13 font-medium",
                    isSelected ? "text-accent-primary" : "text-primary"
                  )}
                >
                  {variant.name}
                </span>
                <span className="flex items-center gap-1.5 text-11 text-tertiary">
                  {variant.revision_count > 0
                    ? t("file_library.contracts.workflow.common.version_count", { count: variant.revision_count })
                    : t("file_library.contracts.workflow.detail.current_only")}
                  {hasPendingDraft(variant) ? (
                    <span className="rounded-sm bg-warning-primary/10 px-1 text-10 text-warning-primary">
                      {t("file_library.contracts.workflow.draft.badge")}
                    </span>
                  ) : null}
                  {variant.origin?.by === "assistant" ? (
                    <span className="rounded-sm bg-layer-2 px-1 text-10 text-secondary">
                      {t("file_library.contracts.workflow.detail.generated_by_assistant")}
                    </span>
                  ) : null}
                </span>
              </button>
              <div className="absolute top-2 right-2">
                <CustomMenu
                  ellipsis
                  placement="bottom-end"
                  ariaLabel={t("file_library.contracts.workflow.template_detail.variant_actions")}
                >
                  <CustomMenu.MenuItem onClick={() => onRename(variant)}>
                    <span className="flex items-center gap-2">
                      <Pencil className="size-3.5" />
                      {t("file_library.contracts.workflow.template_detail.rename_variant")}
                    </span>
                  </CustomMenu.MenuItem>
                  <Tooltip
                    tooltipContent={t("file_library.contracts.workflow.template_detail.last_variant_hint")}
                    disabled={canDelete}
                  >
                    <div>
                      <CustomMenu.MenuItem disabled={!canDelete} onClick={() => onDelete(variant)}>
                        <span className={cn("flex items-center gap-2", canDelete && "text-danger-primary")}>
                          <Trash2 className="size-3.5" />
                          {t("file_library.contracts.workflow.template_detail.delete_variant")}
                        </span>
                      </CustomMenu.MenuItem>
                    </div>
                  </Tooltip>
                </CustomMenu>
              </div>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        onClick={onCreate}
        className="mt-1 flex w-full items-center gap-2 rounded-md px-3 py-2 text-13 font-medium text-accent-primary hover:bg-layer-1-hover"
      >
        <Plus className="size-3.5" /> {t("file_library.contracts.workflow.template_detail.new_variant")}
      </button>
    </aside>
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
  const [failedThumbnailUrl, setFailedThumbnailUrl] = useState<string>();
  const thumbnailFailed = failedThumbnailUrl === thumbnailUrl;

  return (
    <button
      type="button"
      aria-pressed={isSelected}
      onClick={onSelect}
      className={cn(
        "group flex w-full gap-3 rounded-lg border p-2 text-left transition-colors",
        isSelected
          ? "border-accent-strong bg-accent-primary/5 ring-1 ring-accent-strong"
          : "border-subtle bg-surface-1 hover:bg-layer-1-hover"
      )}
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
            onError={() => setFailedThumbnailUrl(thumbnailUrl)}
          />
        )}
      </span>
      <span className="min-w-0 flex-1 py-1">
        <span className="flex items-center justify-between gap-2">
          <span className="truncate text-13 font-semibold text-primary">{title}</span>
          {isSelected ? <CheckCircle2 className="size-3.5 shrink-0 text-accent-primary" /> : null}
        </span>
        <span className="mt-1 line-clamp-2 text-11 leading-4 text-tertiary">{subtitle}</span>
        {meta ? <span className="mt-2 block text-11 leading-4 text-secondary">{meta}</span> : null}
      </span>
    </button>
  );
}
