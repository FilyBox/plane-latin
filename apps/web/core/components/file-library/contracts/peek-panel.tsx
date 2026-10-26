/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * Contract peek: same panel modes as the work-item peek overview
 * (side-peek / modal / full-screen, rendered through the full-screen portal).
 * Desktop splits document + tabs; mobile is single-focus — one top-level tab
 * set (document, info, process, chat) where each view takes the whole panel.
 */

import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { observer } from "mobx-react";
import {
  AlertTriangle,
  Ban,
  CalendarSync,
  Columns2,
  Download,
  FileSearch,
  FileX,
  Loader2,
  Maximize2,
  MoreHorizontal,
  RefreshCcw,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import useSWR, { mutate as mutateGlobal } from "swr";
// plane imports
import { PDFViewer } from "@plane/extend-ui";
import type { PDFViewerHandle } from "@plane/extend-ui";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { CenterPanelIcon, FullScreenPanelIcon, SidePanelIcon } from "@plane/propel/icons";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import { Tooltip } from "@plane/propel/tooltip";
import type { TContractEvidence, TContractRetryOptions, TContractUpdatePayload } from "@plane/types";
import { AlertModalCore, CustomMenu } from "@plane/ui";
import { cn } from "@plane/utils";
// services
import { AskAssistantButton } from "@/components/assistant/ask";
import { PeekLinkActions } from "@/components/entity-peek/peek-link-actions";
import { EntityBacklinks } from "@/components/references/references-section";
import { SharedTagPicker } from "@/components/references/shared-tag-picker";
import { useWorkspace } from "@/hooks/store/use-workspace";
import { contractService } from "@/services/contract.service";
import { fileLibraryService } from "@/services/file-library.service";
// local imports
import { downloadAssets } from "../download";
import { ContractChatPanel } from "./chat/chat-panel";
import {
  CONTRACT_STATUS_OPTIONS,
  CONTRACT_TYPE_OPTIONS,
  STAGE_RETRY_OPTION,
  YES_NO_UNSPECIFIED_OPTIONS,
} from "./constants";
import { ContractRenewDialog } from "./contract-renew-dialog";
import { InlineField } from "./inline-field";
import { ContractJobTimeline, ErrorDetails, friendlyJobError } from "./process-steps";
import { ProcessingBadge, stageDetail } from "./processing-badge";
import { ProposalDiff } from "./proposal-diff";
import { RetryOptionsModal } from "./retry-options-modal";
import { useCanEditContracts } from "./use-can-edit";
import { formatContractDateTime, isJobActive, stageLabel } from "./utils";
import { ContractWorksSection } from "./works-section";
import { contractWorksKey } from "./works-shared";

type Props = {
  workspaceSlug: string;
  contractId: string;
  onClose: () => void;
  /** Called after any action that changes the list row (save, retry, confirm) */
  onMutate: () => void;
  /** Called once the contract has been deleted; the caller closes the peek. */
  onDeleted: () => void;
  /** Set when opened outside the contracts list: go to it there */
  onOpenInSection?: () => void;
};

/** The header's icon buttons, one size so the row reads as a toolbar */
const HEADER_ICON =
  "flex size-7 items-center justify-center rounded-sm text-tertiary hover:bg-layer-1-hover hover:text-secondary disabled:opacity-50";

// Tailwind's `lg`: the panel switches from tabs to document-beside-pane here
const DESKTOP_QUERY = "(min-width: 1024px)";
const subscribeDesktop = (onChange: () => void) => {
  const query = window.matchMedia(DESKTOP_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
};
const isDesktopNow = () => window.matchMedia(DESKTOP_QUERY).matches;

type TPeekModes = "side-peek" | "modal" | "full-screen";
/** "document" is mobile-only (desktop always shows the PDF beside the tabs) */
type Tab = "document" | "info" | "process" | "chat";

const PEEK_OPTIONS: { key: TPeekModes; icon: typeof SidePanelIcon; i18nKey: string }[] = [
  { key: "side-peek", icon: SidePanelIcon, i18nKey: "common.side_peek" },
  { key: "modal", icon: CenterPanelIcon, i18nKey: "common.modal" },
  { key: "full-screen", icon: FullScreenPanelIcon, i18nKey: "common.full_screen" },
];

const EDITABLE_TEXT_FIELDS: { key: keyof TContractUpdatePayload; i18nKey: string; textarea?: boolean }[] = [
  { key: "titulo", i18nKey: "file_library.contracts.fields.titulo" },
  { key: "resumen_general", i18nKey: "file_library.contracts.fields.resumen_general", textarea: true },
  { key: "nombre_grupo", i18nKey: "file_library.contracts.fields.nombre_grupo" },
  { key: "artistas", i18nKey: "file_library.contracts.fields.artistas" },
  { key: "testigos", i18nKey: "file_library.contracts.fields.testigos" },
  { key: "involucrados", i18nKey: "file_library.contracts.fields.involucrados" },
  { key: "tiempo_extension_posible", i18nKey: "file_library.contracts.fields.tiempo_extension_posible" },
  {
    key: "expansion_time_description",
    i18nKey: "file_library.contracts.fields.expansion_time_description",
    textarea: true,
  },
  { key: "collection_period_description", i18nKey: "file_library.contracts.fields.collection_period_description" },
  { key: "collection_period_duration", i18nKey: "file_library.contracts.fields.collection_period_duration" },
  { key: "retention_period_description", i18nKey: "file_library.contracts.fields.retention_period_description" },
  { key: "retention_period_duration", i18nKey: "file_library.contracts.fields.retention_period_duration" },
];

const DATE_FIELDS: { key: keyof TContractUpdatePayload; i18nKey: string }[] = [
  { key: "fecha_inicio", i18nKey: "file_library.contracts.fields.fecha_inicio" },
  { key: "fecha_fin", i18nKey: "file_library.contracts.fields.fecha_fin" },
  { key: "fecha_fin_efectiva", i18nKey: "file_library.contracts.fields.fecha_fin_efectiva" },
];

const SELECT_FIELDS: {
  key: keyof TContractUpdatePayload;
  i18nKey: string;
  options: { value: string; i18nKey: string }[];
}[] = [
  {
    key: "estatus_contrato",
    i18nKey: "file_library.contracts.fields.estatus_contrato",
    options: CONTRACT_STATUS_OPTIONS,
  },
  { key: "tipo_contrato", i18nKey: "file_library.contracts.fields.tipo_contrato", options: CONTRACT_TYPE_OPTIONS },
  {
    key: "es_posible_expandirlo",
    i18nKey: "file_library.contracts.fields.es_posible_expandirlo",
    options: YES_NO_UNSPECIFIED_OPTIONS,
  },
  {
    key: "periodo_coleccion",
    i18nKey: "file_library.contracts.fields.periodo_coleccion",
    options: YES_NO_UNSPECIFIED_OPTIONS,
  },
  {
    key: "periodo_retencion",
    i18nKey: "file_library.contracts.fields.periodo_retencion",
    options: YES_NO_UNSPECIFIED_OPTIONS,
  },
];

/** Evidence keys that differ from the column name */
const EVIDENCE_ALIASES: Partial<Record<string, string>> = {
  expansion_time_description: "clausula_renovacion",
  collection_period_duration: "duracion_periodo_coleccion",
  retention_period_duration: "duracion_periodo_retencion",
};

/** First words of a quote, whitespace collapsed: what the PDF search can match */
const searchableQuote = (quote: string, maxLength: number) => {
  const text = quote.replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  const cut = text.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(" ");
  return lastSpace > maxLength / 2 ? cut.slice(0, lastSpace) : cut;
};

export const ContractPeekPanel = observer(function ContractPeekPanel(props: Props) {
  const { workspaceSlug, contractId, onClose, onMutate, onDeleted, onOpenInSection } = props;
  const { isWorkspaceFeatureEnabled } = useWorkspace();
  const referencesEnabled = isWorkspaceFeatureEnabled(workspaceSlug, "references");
  const canEdit = useCanEditContracts(workspaceSlug);
  const { t, currentLocale } = useTranslation();
  const titleId = useId();
  const tabsId = useId();
  // Only one layout mounts the PDF viewer, so the file loads and renders once
  const isDesktop = useSyncExternalStore(subscribeDesktop, isDesktopNow, () => true);
  // states
  const [peekMode, setPeekMode] = useState<TPeekModes>("side-peek");
  const [tab, setTab] = useState<Tab>("document");
  const [draft, setDraft] = useState<TContractUpdatePayload>({});
  const [isSaving, setIsSaving] = useState(false);
  const [isActing, setIsActing] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [isRetryModalOpen, setIsRetryModalOpen] = useState(false);
  const [retryPreset, setRetryPreset] = useState<TContractRetryOptions | undefined>(undefined);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [isDiscardOpen, setIsDiscardOpen] = useState(false);
  const [isRenewOpen, setIsRenewOpen] = useState(false);
  const [isWorksPickerOpen, setIsWorksPickerOpen] = useState(false);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pdfError, setPdfError] = useState(false);
  const [pdfAttempt, setPdfAttempt] = useState(0);
  // Which half of the split has the whole width. Independent of `peekMode`:
  // reading a long clause or a wide table is the same problem whether the peek
  // is docked, centred or full screen.
  const [expanded, setExpanded] = useState<"none" | "document" | "side">("none");
  // "See in document": where to jump once the viewer has the file
  const viewerRef = useRef<PDFViewerHandle | null>(null);
  const [documentReady, setDocumentReady] = useState(false);
  const [pendingJump, setPendingJump] = useState<TContractEvidence | null>(null);

  // On desktop the PDF is always visible, so "document" behaves as "info"
  const paneTab: Exclude<Tab, "document"> = tab === "document" ? "info" : tab;

  // contract detail
  const {
    data: contract,
    mutate: mutateContract,
    error: contractError,
  } = useSWR(`CONTRACT_DETAIL_${contractId}`, () => contractService.getContract(workspaceSlug, contractId));

  // jobs for this contract — poll fast while one is active
  const { data: jobs, mutate: mutateJobs } = useSWR(
    `CONTRACT_JOBS_${contractId}`,
    () => contractService.getJobs(workspaceSlug, { contractId }),
    { refreshInterval: (latest) => (latest?.some(isJobActive) ? 2000 : 0) }
  );
  const activeJob = jobs?.find(isJobActive);
  const latestJob = jobs?.[0];
  const failedJob = !activeJob && latestJob?.status === "FAILED" ? latestJob : undefined;

  // Refresh detail + list when a run ends — not on open
  const activeJobId = activeJob?.id;
  const previousActiveJobId = useRef<string | undefined>(undefined);
  useEffect(() => {
    const previous = previousActiveJobId.current;
    previousActiveJobId.current = activeJobId;
    if (previous && previous !== activeJobId) {
      void mutateContract();
      // A finished run may have saved new work suggestions
      void mutateGlobal(contractWorksKey(contractId));
      onMutate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeJobId]);

  const isDirty = Object.keys(draft).length > 0;

  /** Closing with unsaved edits asks first */
  const requestClose = useCallback(() => {
    if (isDirty) setIsDiscardOpen(true);
    else onClose();
  }, [isDirty, onClose]);

  const anyModalOpen = isRetryModalOpen || isDeleteModalOpen || isDiscardOpen || isRenewOpen || isWorksPickerOpen;
  // Escape closes (matches the work-item peek behavior), unless a dialog is on top
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || anyModalOpen) return;
      requestClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [anyModalOpen, requestClose]);

  // PDF presigned URL
  useEffect(() => {
    let cancelled = false;
    setPdfUrl(null);
    setPdfError(false);
    setDocumentReady(false);
    if (!contract?.file_asset_id) return;
    fileLibraryService
      .getPresignedViewUrl(workspaceSlug, contract.file_asset_id)
      .then((url) => {
        if (cancelled) return url;
        if (url) setPdfUrl(url);
        else setPdfError(true);
        return url;
      })
      .catch(() => {
        if (!cancelled) setPdfError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceSlug, contract?.file_asset_id, pdfAttempt]);

  // A new contract starts clean. A refreshed payload never wipes edits in progress.
  useEffect(() => {
    setDraft({});
  }, [contractId]);

  const draftValue = <K extends keyof TContractUpdatePayload>(key: K) =>
    (key in draft ? draft[key] : contract?.[key]) as TContractUpdatePayload[K];

  const handleSave = async () => {
    if (!contract || !isDirty) return;
    setIsSaving(true);
    try {
      const updated = await contractService.updateContract(workspaceSlug, contract.id, draft);
      await mutateContract(updated, { revalidate: false });
      setDraft({});
      onMutate();
      setToast({ type: TOAST_TYPE.SUCCESS, title: t("file_library.contracts.save_success") });
    } catch {
      setToast({ type: TOAST_TYPE.ERROR, title: t("file_library.contracts.save_failed") });
    } finally {
      setIsSaving(false);
    }
  };

  const jobConflictToast = (error: unknown, fallbackKey: string) => {
    const busy = (error as { error?: string } | undefined)?.error === "job_active";
    setToast({
      type: TOAST_TYPE.ERROR,
      title: t(busy ? "file_library.contracts.retry.job_active" : fallbackKey),
    });
  };

  const handleRetry = async (options: TContractRetryOptions) => {
    if (!contract) return;
    setIsActing(true);
    try {
      await contractService.retryContract(workspaceSlug, contract.id, options);
      await Promise.all([mutateJobs(), mutateContract()]);
      onMutate();
      setToast({ type: TOAST_TYPE.SUCCESS, title: t("file_library.contracts.retry.started") });
    } catch (error) {
      jobConflictToast(error, "file_library.contracts.retry.failed");
    } finally {
      setIsActing(false);
    }
  };

  const openRetry = (preset?: TContractRetryOptions) => {
    setRetryPreset(preset);
    setIsRetryModalOpen(true);
  };

  const handleCancelJob = async () => {
    if (!contract || !activeJob) return;
    setIsCancelling(true);
    try {
      await contractService.cancelJob(workspaceSlug, contract.id, activeJob.id);
      await Promise.all([mutateJobs(), mutateContract()]);
      onMutate();
      setToast({ type: TOAST_TYPE.SUCCESS, title: t("file_library.contracts.process.cancelled") });
    } catch {
      setToast({ type: TOAST_TYPE.ERROR, title: t("file_library.contracts.process.cancel_failed") });
    } finally {
      setIsCancelling(false);
    }
  };

  const [isDownloading, setIsDownloading] = useState(false);
  const handleDownload = async () => {
    if (!contract?.file_asset_id) return;
    setIsDownloading(true);
    try {
      await downloadAssets(
        workspaceSlug,
        [{ assetId: contract.file_asset_id, name: contract.file_name ?? `${contract.titulo ?? contract.id}.pdf` }],
        "contrato",
        "contract"
      );
    } catch {
      setToast({ type: TOAST_TYPE.ERROR, title: t("file_library.download_failed") });
    } finally {
      setIsDownloading(false);
    }
  };

  const handleReanalyze = async () => {
    if (!contract) return;
    setIsActing(true);
    try {
      await contractService.reanalyzeContract(workspaceSlug, contract.id);
      await Promise.all([mutateJobs(), mutateContract()]);
      onMutate();
      setToast({ type: TOAST_TYPE.SUCCESS, title: t("file_library.contracts.reanalyze.started") });
    } catch (error) {
      jobConflictToast(error, "file_library.contracts.reanalyze.failed");
    } finally {
      setIsActing(false);
    }
  };

  const handleDelete = async () => {
    if (!contract) return;
    setIsActing(true);
    try {
      await contractService.deleteContract(workspaceSlug, contract.id);
      setIsDeleteModalOpen(false);
      setToast({ type: TOAST_TYPE.SUCCESS, title: t("file_library.contracts.delete.success", { count: 1 }) });
      onDeleted();
    } catch {
      setToast({ type: TOAST_TYPE.ERROR, title: t("file_library.contracts.delete.failed") });
    } finally {
      setIsActing(false);
    }
  };

  const handleConfirmProposed = async (accept: boolean, fields?: string[]) => {
    if (!contract) return;
    setIsActing(true);
    try {
      const updated = await contractService.confirmReanalysis(workspaceSlug, contract.id, accept, fields);
      await mutateContract(updated, { revalidate: true });
      onMutate();
      setToast({
        type: TOAST_TYPE.SUCCESS,
        title: accept ? t("file_library.contracts.reanalyze.applied") : t("file_library.contracts.reanalyze.discarded"),
      });
    } catch {
      setToast({ type: TOAST_TYPE.ERROR, title: t("file_library.contracts.reanalyze.failed") });
    } finally {
      setIsActing(false);
    }
  };

  // ── Evidence → document ────────────────────────────────────────────────
  const evidenceFor = (key: string): TContractEvidence | undefined => {
    const evidence = contract?.evidence;
    if (!evidence) return undefined;
    const alias = EVIDENCE_ALIASES[key];
    return evidence[key] ?? (alias ? evidence[alias] : undefined);
  };

  const jumpToEvidence = (evidence: TContractEvidence) => {
    if (!isDesktop) setTab("document");
    else if (expanded === "side") setExpanded("none");
    setPendingJump(evidence);
  };

  // On mobile the viewer unmounts with its tab: it must load again before jumping
  useEffect(() => {
    if (!isDesktop && tab !== "document") setDocumentReady(false);
  }, [isDesktop, tab]);

  useEffect(() => {
    if (!pendingJump || !documentReady || !viewerRef.current) return;
    const viewer = viewerRef.current;
    const evidence = pendingJump;
    setPendingJump(null);
    if (evidence.page) viewer.scrollToPage(evidence.page, { behavior: "smooth" });
    if (!evidence.quote) return;
    // Long quotes rarely match across line breaks: try the opening words, then fewer
    const quote = evidence.quote;
    void viewer
      .searchText(searchableQuote(quote, 80))
      .then((found) => found || viewer.searchText(searchableQuote(quote, 32)))
      .then((found) => {
        // Scans with poor OCR or reworded text: say so and show the quote itself
        if (!found)
          setToast({
            type: TOAST_TYPE.INFO,
            title: t("file_library.contracts.evidence.not_found"),
            message: `“${searchableQuote(quote, 240)}”`,
          });
        return found;
      });
    // t is stable for the session
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentReady, pendingJump]);

  const evidenceButton = (key: string) => {
    const evidence = evidenceFor(key);
    if (!evidence || (!evidence.quote && !evidence.page)) return null;
    const tip = (
      <span className="block max-w-72 text-11">
        {evidence.page ? (
          <span className="block font-medium">
            {t("file_library.contracts.evidence.page", { page: evidence.page })}
          </span>
        ) : null}
        {evidence.quote ? <span className="block italic">“{searchableQuote(evidence.quote, 240)}”</span> : null}
      </span>
    );
    return (
      <>
        {evidence.approximate && (
          <Tooltip tooltipContent={t("file_library.contracts.evidence.approximate_hint")}>
            <span className="rounded-sm bg-warning-subtle px-1 text-10 text-warning-primary">
              {t("file_library.contracts.evidence.approximate")}
            </span>
          </Tooltip>
        )}
        {evidence.computed && (
          <Tooltip tooltipContent={t("file_library.contracts.evidence.computed_hint")}>
            <span className="rounded-sm bg-layer-1 px-1 text-10 text-tertiary">
              {t("file_library.contracts.evidence.computed")}
            </span>
          </Tooltip>
        )}
        <Tooltip tooltipContent={tip}>
          <button
            type="button"
            onClick={() => jumpToEvidence(evidence)}
            disabled={!contract?.file_asset_id}
            className="flex items-center gap-0.5 rounded-sm px-1 text-10 text-tertiary hover:bg-layer-1-hover hover:text-accent-primary disabled:opacity-50"
          >
            <FileSearch className="size-3" aria-hidden />
            <span>{t("file_library.contracts.evidence.see")}</span>
          </button>
        </Tooltip>
      </>
    );
  };

  /** Gives one pane the whole width, or hands the split back. The document
   * half hands this to the viewer's own toolbar rather than floating it on top:
   * overlaying the top-right corner covered the viewer's actions menu and ate
   * its clicks. */
  const expandButton = (pane: "document" | "side") => {
    const isExpanded = expanded === pane;
    const label = t(isExpanded ? "file_library.contracts.peek.split_view" : "file_library.contracts.peek.expand_pane");
    return (
      <Tooltip tooltipContent={label}>
        <button
          type="button"
          aria-label={label}
          aria-pressed={isExpanded}
          onClick={() => setExpanded(isExpanded ? "none" : pane)}
          className="rounded-sm p-1 text-tertiary hover:bg-layer-1-hover hover:text-primary"
        >
          {isExpanded ? <Columns2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
        </button>
      </Tooltip>
    );
  };

  /** `expandControl` is `null` on mobile, where the tabs already give each view
   * the whole panel. While the preview is still resolving there is no viewer
   * toolbar to seat it in, so it floats in the corner the toolbar would occupy
   * — otherwise expanding a document that never loads is a one-way trip. */
  const pdfViewer = (expandControl: React.ReactNode) => {
    if (pdfUrl)
      return (
        <PDFViewer
          ref={viewerRef}
          src={pdfUrl}
          fileName={contract?.file_name ?? "contract.pdf"}
          className="h-full"
          showUpload={false}
          toolbarActions={expandControl}
          onDocumentLoadSuccess={() => setDocumentReady(true)}
        />
      );
    const corner = expandControl ? <div className="absolute top-2 right-2">{expandControl}</div> : null;
    // No file behind this contract, or its link couldn't be resolved
    if (contract && (!contract.file_asset_id || pdfError))
      return (
        <div className="relative flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-tertiary">
          {corner}
          <FileX className="size-6" />
          <p className="text-12">
            {contract.file_asset_id
              ? t("file_library.contracts.peek.pdf_failed")
              : t("file_library.contracts.peek.no_document")}
          </p>
          {contract.file_asset_id && (
            <Button variant="secondary" size="sm" onClick={() => setPdfAttempt((value) => value + 1)}>
              <RefreshCcw className="size-3.5" />
              {t("file_library.contracts.retry.button")}
            </Button>
          )}
        </div>
      );
    if (contractError)
      return (
        <div className="relative flex h-full items-center justify-center text-tertiary">
          {corner}
          <FileX className="size-6" />
        </div>
      );
    return (
      <div className="relative flex h-full items-center justify-center text-tertiary" role="status">
        {corner}
        <Loader2 className="size-5 animate-spin" />
        <span className="sr-only">{t("common.loading")}</span>
      </div>
    );
  };

  // A field differs from what is saved (shown until the save bar persists it)
  const isChanged = (key: keyof TContractUpdatePayload) =>
    key in draft && (draft[key] ?? null) !== ((contract?.[key] as unknown) ?? null);
  const setField = (key: keyof TContractUpdatePayload, value: string | boolean | null) =>
    setDraft((prev) => {
      // Back to the saved value: no longer a change
      if ((value ?? null) === ((contract?.[key] as unknown) ?? null)) {
        const next = { ...prev };
        delete next[key];
        return next;
      }
      return { ...prev, [key]: value };
    });

  // First analysis still running: there is nothing to show in the fields yet
  const firstAnalysisRunning =
    !!contract &&
    !contract.processed_at &&
    (!!activeJob || contract.processing_status === "PROCESSING" || contract.processing_status === "PENDING");
  const failureMessage = failedJob
    ? friendlyJobError(t, failedJob)
    : contract?.processing_status === "ERROR"
      ? t("file_library.contracts.errors.generic")
      : null;
  const failedStage = failedJob?.error?.stage ?? failedJob?.current_stage ?? undefined;
  const failedRetryKey = failedStage ? STAGE_RETRY_OPTION[failedStage] : undefined;
  const isExpired = typeof contract?.days_to_expiry === "number" && contract.days_to_expiry < 0;
  const canRenew = canEdit && !!contract?.source_template_id;

  const processingPlaceholder = (
    <div className="rounded-md border border-subtle bg-layer-1/50 p-4" aria-live="polite">
      <div className="flex items-center gap-2">
        <Sparkles className="size-4 shrink-0 text-accent-primary" />
        <p className="text-13 font-medium">{t("file_library.contracts.peek.reading")}</p>
      </div>
      <p className="mt-1 text-12 text-tertiary">{t("file_library.contracts.peek.reading_hint")}</p>
      {activeJob && (
        <>
          <div
            role="progressbar"
            aria-label={stageLabel(t, activeJob.current_stage) || t("file_library.contracts.processing.processing")}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={activeJob.progress}
            className="mt-3 h-1.5 overflow-hidden rounded-full bg-layer-1"
          >
            <div
              className="h-full rounded-full bg-accent-primary transition-all"
              style={{ width: `${activeJob.progress}%` }}
            />
          </div>
          <div className="mt-1 flex items-center justify-between gap-2 text-11 text-tertiary">
            <span className="truncate">
              {stageLabel(t, activeJob.current_stage)}
              {stageDetail(t, activeJob) ? ` · ${stageDetail(t, activeJob)}` : ""}
            </span>
            <span className="shrink-0 tabular-nums">{activeJob.progress}%</span>
          </div>
        </>
      )}
      <div className="mt-3 flex items-center gap-2">
        <Button variant="tertiary" size="sm" onClick={() => setTab("process")}>
          {t("file_library.contracts.peek.see_process")}
        </Button>
        {canEdit && activeJob && (
          <Button variant="tertiary" size="sm" onClick={() => void handleCancelJob()} disabled={isCancelling}>
            {isCancelling ? <Loader2 className="size-3.5 animate-spin" /> : <Ban className="size-3.5" />}
            {t("file_library.contracts.process.cancel")}
          </Button>
        )}
      </div>
    </div>
  );

  const errorBanner = failureMessage && !activeJob && (
    <div role="alert" className="space-y-1.5 rounded-md border border-danger-subtle bg-danger-subtle p-3">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger-primary" />
        <div className="min-w-0 flex-1">
          <p className="text-13 font-medium text-danger-primary">{failureMessage}</p>
          {failedJob?.finished_at && (
            <p className="text-11 text-tertiary">{formatContractDateTime(failedJob.finished_at, currentLocale)}</p>
          )}
        </div>
        {canEdit && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => openRetry(failedRetryKey ? { [failedRetryKey]: true } : undefined)}
            disabled={isActing}
          >
            <RefreshCcw className="size-3.5" />
            {t("file_library.contracts.retry.button")}
          </Button>
        )}
      </div>
      {failedJob?.error?.message && <ErrorDetails message={failedJob.error.message} />}
    </div>
  );

  const renewBanner = isExpired && canRenew && (
    <div className="flex items-center gap-2 rounded-md border border-subtle px-3 py-2">
      <CalendarSync className="size-4 shrink-0 text-tertiary" />
      <p className="min-w-0 flex-1 text-12 text-secondary">{t("file_library.contracts.renew.expired_hint")}</p>
      <Button variant="secondary" size="sm" onClick={() => setIsRenewOpen(true)}>
        {t("file_library.contracts.renew.button")}
      </Button>
    </div>
  );

  const infoPane = (
    <div className="@container min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
      {errorBanner}
      {renewBanner}
      {firstAnalysisRunning ? (
        processingPlaceholder
      ) : (
        <>
          {activeJob && (
            <p
              className="flex items-center gap-2 rounded-md bg-layer-1 px-3 py-2 text-12 text-secondary"
              aria-live="polite"
            >
              <Loader2 className="size-3.5 shrink-0 animate-spin text-accent-primary" />
              {t("file_library.contracts.peek.rerunning", { stage: stageLabel(t, activeJob.current_stage) })}
            </p>
          )}
          {/* Short values side by side when there is room; long text full width */}
          <div className="grid grid-cols-1 gap-x-3 gap-y-3 @sm:grid-cols-2">
            {SELECT_FIELDS.map((field) => (
              <InlineField
                key={field.key}
                kind="select"
                label={t(field.i18nKey)}
                value={(draftValue(field.key) as string | null) ?? null}
                options={field.options.map((option) => ({ value: option.value, label: t(option.i18nKey) }))}
                onChange={(value) => setField(field.key, value)}
                changed={isChanged(field.key)}
                readOnly={!canEdit}
                labelExtra={evidenceButton(field.key)}
              />
            ))}
            {DATE_FIELDS.map((field) => (
              <InlineField
                key={field.key}
                kind="date"
                label={t(field.i18nKey)}
                value={(draftValue(field.key) as string | null) ?? null}
                onChange={(value) => setField(field.key, value)}
                changed={isChanged(field.key)}
                readOnly={!canEdit}
                labelExtra={evidenceButton(field.key)}
              />
            ))}
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-1 px-2">
            {(["es_notariado", "es_editorial"] as const).map((key) => (
              <div key={key} className="flex items-center gap-2 py-1">
                {/* The AI files contracts under Editoriales on its own; this is where a
                    wrong call gets corrected, and the contract moves view on save. */}
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={!!draftValue(key)}
                    disabled={!canEdit}
                    onChange={(e) => setField(key, e.target.checked)}
                  />
                  <span className="text-13">{t(`file_library.contracts.fields.${key}`)}</span>
                </label>
                {isChanged(key) && <span className="size-1.5 rounded-full bg-accent-primary" aria-hidden />}
                {evidenceButton(key)}
              </div>
            ))}
          </div>
          <div className="space-y-3">
            {EDITABLE_TEXT_FIELDS.map((field) => (
              <InlineField
                key={field.key}
                kind="text"
                multiline={field.textarea}
                label={t(field.i18nKey)}
                value={(draftValue(field.key) as string | null) ?? null}
                onChange={(value) => setField(field.key, value)}
                changed={isChanged(field.key)}
                readOnly={!canEdit}
                labelExtra={evidenceButton(field.key)}
              />
            ))}
          </div>
        </>
      )}
      {contract && referencesEnabled && (
        <div className="space-y-4 border-t border-subtle pt-3">
          <div className="space-y-1">
            <span className="text-11 font-medium text-tertiary">{t("references.tags.title")}</span>
            <SharedTagPicker workspaceSlug={workspaceSlug} entityName="contract" entityId={contract.id} />
          </div>
          <EntityBacklinks workspaceSlug={workspaceSlug} entityName="contract" entityId={contract.id} />
        </div>
      )}
      {contract && (
        <div className="border-t border-subtle pt-3">
          <ContractWorksSection
            workspaceSlug={workspaceSlug}
            contractId={contract.id}
            canEdit={canEdit}
            onSeeEvidence={(evidence) => jumpToEvidence({ quote: evidence.quote ?? "", page: evidence.page ?? null })}
            onPickerOpenChange={setIsWorksPickerOpen}
          />
        </div>
      )}
      {contract?.ai_model_used && (
        <p className="text-11 text-tertiary">
          {t("file_library.contracts.ai_model", { model: contract.ai_model_used })}
        </p>
      )}
    </div>
  );

  const processPane = (
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-11 text-tertiary">
        <span>
          {contract?.text_extracted_at
            ? t("file_library.contracts.process.text_extracted", {
                date: formatContractDateTime(contract.text_extracted_at, currentLocale),
              })
            : t("file_library.contracts.process.text_pending")}
        </span>
        {contract?.processed_at && (
          <span>
            {t("file_library.contracts.process.analyzed", {
              date: formatContractDateTime(contract.processed_at, currentLocale),
            })}
          </span>
        )}
      </div>
      {(jobs ?? []).length === 0 ? (
        <p className="text-12 text-tertiary">{t("file_library.contracts.process.no_jobs")}</p>
      ) : (
        (jobs ?? []).map((job, index) => (
          <ContractJobTimeline
            key={job.id}
            job={job}
            defaultOpen={index === 0}
            onCancel={canEdit && isJobActive(job) ? () => void handleCancelJob() : undefined}
            isCancelling={isCancelling}
          />
        ))
      )}
    </div>
  );

  const chatPane = contract ? (
    <div className="min-h-0 min-w-0 flex-1">
      <ContractChatPanel workspaceSlug={workspaceSlug} mode="CONTRACT" contractId={contract.id} compact />
    </div>
  ) : null;

  const statePane =
    contractError && !contract ? (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-tertiary">
        <AlertTriangle className="size-6" />
        <p className="text-13">{t("file_library.contracts.peek.load_failed")}</p>
        <Button variant="secondary" size="sm" onClick={() => void mutateContract()}>
          <RefreshCcw className="size-3.5" />
          {t("file_library.contracts.retry.button")}
        </Button>
      </div>
    ) : (
      <div className="flex flex-1 items-center justify-center" role="status">
        <Loader2 className="size-5 animate-spin text-tertiary" />
        <span className="sr-only">{t("common.loading")}</span>
      </div>
    );

  // Visible on every tab, so edits are never out of sight
  const saveBar = canEdit && isDirty && (
    <div className="flex shrink-0 items-center justify-end gap-2 border-t border-subtle bg-surface-1 px-4 py-2.5">
      <span className="mr-auto text-11 text-tertiary">
        {t("file_library.contracts.peek.unsaved_count", { count: Object.keys(draft).length })}
      </span>
      <Button variant="secondary" size="sm" onClick={() => setDraft({})} disabled={isSaving}>
        {t("cancel")}
      </Button>
      <Button variant="primary" size="sm" onClick={handleSave} disabled={isSaving}>
        {isSaving ? <Loader2 className="size-3.5 animate-spin" /> : t("file_library.contracts.save")}
      </Button>
    </div>
  );

  const chatDisabled = !contract?.text_extracted_at;
  const tabButton = (key: Tab, layout: "m" | "d") => {
    const isSelected = key === "document" ? tab === "document" : paneTab === key && tab !== "document";
    const disabled = key === "chat" && chatDisabled;
    const button = (
      <button
        key={key}
        type="button"
        role="tab"
        id={`${tabsId}-${layout}-${key}`}
        aria-selected={isSelected}
        aria-controls={`${tabsId}-${layout}-panel`}
        aria-disabled={disabled || undefined}
        tabIndex={isSelected ? 0 : -1}
        onClick={() => !disabled && setTab(key)}
        className={cn(
          "rounded-t-sm border-b-2 px-3 py-1.5 text-12 font-medium",
          disabled && "cursor-not-allowed opacity-40",
          isSelected
            ? "border-accent-strong text-accent-primary"
            : "border-transparent text-tertiary hover:text-secondary"
        )}
      >
        {t(`file_library.contracts.tabs.${key}`)}
      </button>
    );
    return disabled ? (
      <Tooltip key={key} tooltipContent={t("file_library.contracts.peek.chat_disabled")}>
        {button}
      </Tooltip>
    ) : (
      button
    );
  };
  /** Arrow keys move between tabs (ARIA tabs pattern) */
  const onTabsKey = (event: React.KeyboardEvent<HTMLDivElement>, keys: Tab[], layout: "m" | "d") => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    const enabled = keys.filter((key) => !(key === "chat" && chatDisabled));
    const current = enabled.indexOf(tab === "document" && !keys.includes("document") ? "info" : tab);
    const next = enabled[(current + (event.key === "ArrowRight" ? 1 : enabled.length - 1)) % enabled.length];
    setTab(next);
    document.getElementById(`${tabsId}-${layout}-${next}`)?.focus();
  };
  const tabList = (keys: Tab[], layout: "m" | "d", className: string, trailing?: React.ReactNode) => (
    <div
      role="tablist"
      aria-label={t("file_library.contracts.title")}
      onKeyDown={(event) => onTabsKey(event, keys, layout)}
      className={className}
    >
      {keys.map((key) => tabButton(key, layout))}
      {trailing}
    </div>
  );

  const panelClassName = cn(
    "absolute z-[25] flex flex-col overflow-hidden rounded-sm border border-subtle bg-surface-1 transition-all duration-300",
    {
      // Wider sheet than the work-item peek so the document + data read comfortably
      "top-0 right-0 bottom-0 w-full border-0 border-l lg:w-[80%] xl:w-[72%]": peekMode === "side-peek",
      "top-[8.33%] left-[8.33%] size-5/6 max-lg:top-0 max-lg:left-0 max-lg:size-full": peekMode === "modal",
      "inset-0 lg:m-4": peekMode === "full-screen",
    }
  );

  const portalContainer = typeof document !== "undefined" ? document.getElementById("full-screen-portal") : null;

  const body = (pane: "info" | "process" | "chat") =>
    !contract ? statePane : pane === "chat" ? chatPane : pane === "process" ? processPane : infoPane;

  const content = (
    <div className="absolute inset-0 z-[24]">
      {/* backdrop */}
      <button
        type="button"
        tabIndex={-1}
        className="absolute inset-0 bg-black/20"
        onClick={requestClose}
        aria-label={t("close")}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={panelClassName}
        style={{
          boxShadow:
            "0px 4px 8px 0px rgba(0, 0, 0, 0.12), 0px 6px 12px 0px rgba(16, 24, 40, 0.12), 0px 1px 16px 0px rgba(16, 24, 40, 0.12)",
        }}
      >
        {/* header: title and status on the left; quick actions, the rest in a menu */}
        <div className="flex shrink-0 items-center gap-2 border-b border-subtle px-3 py-2 sm:px-4">
          {/* peek mode switcher (desktop) */}
          <div className="hidden shrink-0 items-center gap-0.5 rounded-md border border-subtle p-0.5 lg:flex">
            {PEEK_OPTIONS.map((option) => (
              <Tooltip key={option.key} tooltipContent={t(option.i18nKey)}>
                <button
                  type="button"
                  onClick={() => setPeekMode(option.key)}
                  aria-label={t(option.i18nKey)}
                  aria-pressed={peekMode === option.key}
                  className={cn(
                    "rounded-sm p-1",
                    peekMode === option.key ? "bg-layer-1 text-primary" : "text-tertiary hover:bg-layer-1-hover"
                  )}
                >
                  <option.icon className="size-3.5" />
                </button>
              </Tooltip>
            ))}
          </div>
          <div className="min-w-0 flex-1">
            <h2
              id={titleId}
              className="truncate text-14 leading-5 font-medium"
              title={contract?.titulo ?? contract?.file_name ?? ""}
            >
              {contract?.titulo ?? contract?.file_name ?? t("file_library.contracts.title")}
            </h2>
            {contract && (
              <div className="flex min-w-0 items-center gap-1.5">
                <ProcessingBadge contract={contract} activeJob={activeJob} errorMessage={failureMessage} />
                {contract.file_name && contract.titulo && (
                  <span className="min-w-0 truncate text-11 text-tertiary" title={contract.file_name}>
                    {contract.file_name}
                  </span>
                )}
              </div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            <AskAssistantButton
              compact
              className={HEADER_ICON}
              iconClassName="size-4"
              mentions={
                contract
                  ? [{ type: "contract", id: contract.id, label: contract.titulo || contract.file_name || contract.id }]
                  : []
              }
            />
            <Tooltip tooltipContent={t("file_library.download")}>
              <button
                type="button"
                onClick={() => void handleDownload()}
                disabled={!contract?.file_asset_id || isDownloading}
                aria-label={t("file_library.download")}
                className={HEADER_ICON}
              >
                {isDownloading ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
              </button>
            </Tooltip>
            <PeekLinkActions onOpenInSection={onOpenInSection} className={HEADER_ICON} />
            {canEdit && (
              <CustomMenu
                customButton={
                  <span className={HEADER_ICON} aria-hidden>
                    <MoreHorizontal className="size-4" />
                  </span>
                }
                customButtonClassName="rounded-sm"
                placement="bottom-end"
                ariaLabel={t("file_library.contracts.workflow.common.actions")}
                closeOnSelect
              >
                <CustomMenu.MenuItem
                  onClick={() => openRetry(failedRetryKey ? { [failedRetryKey]: true } : undefined)}
                  disabled={isActing || !!activeJob}
                >
                  <span className="flex items-start gap-2" title={t("file_library.contracts.retry.hint")}>
                    <RefreshCcw className="mt-0.5 size-3.5 shrink-0" />
                    {t("file_library.contracts.retry.button")}
                  </span>
                </CustomMenu.MenuItem>
                <CustomMenu.MenuItem
                  onClick={() => void handleReanalyze()}
                  disabled={isActing || !!activeJob || !contract?.text_extracted_at}
                >
                  <span className="flex items-start gap-2" title={t("file_library.contracts.reanalyze.hint")}>
                    <Sparkles className="mt-0.5 size-3.5 shrink-0" />
                    {t("file_library.contracts.reanalyze.button")}
                  </span>
                </CustomMenu.MenuItem>
                {activeJob && (
                  <CustomMenu.MenuItem onClick={() => void handleCancelJob()} disabled={isCancelling}>
                    <span className="flex items-center gap-2">
                      <Ban className="size-3.5" />
                      {t("file_library.contracts.process.cancel")}
                    </span>
                  </CustomMenu.MenuItem>
                )}
                {canRenew && (
                  <CustomMenu.MenuItem onClick={() => setIsRenewOpen(true)}>
                    <span className="flex items-center gap-2">
                      <CalendarSync className="size-3.5" />
                      {t("file_library.contracts.renew.button")}
                    </span>
                  </CustomMenu.MenuItem>
                )}
                <CustomMenu.MenuItem onClick={() => setIsDeleteModalOpen(true)} disabled={isActing || !contract}>
                  <span className="flex items-center gap-2 text-danger-primary">
                    <Trash2 className="size-3.5" />
                    {t("file_library.contracts.delete.button")}
                  </span>
                </CustomMenu.MenuItem>
              </CustomMenu>
            )}
            <span className="mx-1 h-4 shrink-0 border-l border-subtle" aria-hidden />
            <Tooltip tooltipContent={t("close")}>
              <button type="button" onClick={requestClose} aria-label={t("close")} className={HEADER_ICON}>
                <X className="size-4" />
              </button>
            </Tooltip>
          </div>
        </div>

        {/* re-analysis proposal: compact, per-field */}
        {contract?.proposed_changes && contract.proposed_changes.length > 0 && (
          <ProposalDiff
            changes={contract.proposed_changes}
            onApply={(fields) => handleConfirmProposed(true, fields)}
            onDiscard={() => handleConfirmProposed(false)}
            isActing={isActing}
            readOnly={!canEdit}
          />
        )}

        {/* ── Mobile: single-focus views behind top-level tabs ─────────── */}
        <div className="flex min-h-0 flex-1 flex-col lg:hidden">
          {tabList(
            ["document", "info", "process", "chat"],
            "m",
            "flex shrink-0 items-center gap-1 overflow-x-auto border-b border-subtle px-3 pt-2"
          )}
          <div role="tabpanel" id={`${tabsId}-m-panel`} className="flex min-h-0 flex-1 flex-col">
            {tab === "document" ? (
              <div className="min-h-0 flex-1">{isDesktop ? null : pdfViewer(null)}</div>
            ) : (
              body(paneTab)
            )}
          </div>
          {saveBar}
        </div>

        {/* ── Desktop: document beside the tabbed pane ─────────────────── */}
        <div className="hidden min-h-0 flex-1 lg:flex">
          {expanded !== "side" && (
            <div
              className={cn("min-h-0 border-r border-subtle", expanded === "document" ? "w-full border-r-0" : "w-1/2")}
            >
              {isDesktop ? pdfViewer(expandButton("document")) : null}
            </div>
          )}
          {expanded !== "document" && (
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              {tabList(
                ["info", "process", "chat"],
                "d",
                "flex shrink-0 items-center gap-1 border-b border-subtle px-3 pt-2",
                <span className="ml-auto pb-1">{expandButton("side")}</span>
              )}
              <div role="tabpanel" id={`${tabsId}-d-panel`} className="flex min-h-0 flex-1 flex-col">
                {body(paneTab)}
              </div>
              {saveBar}
            </div>
          )}
          {expanded === "document" && saveBar && <div className="absolute right-0 bottom-0 left-0">{saveBar}</div>}
        </div>

        <RetryOptionsModal
          isOpen={isRetryModalOpen}
          onClose={() => setIsRetryModalOpen(false)}
          onConfirm={handleRetry}
          initialSelection={retryPreset}
          hasText={!!contract?.text_extracted_at}
        />
        <AlertModalCore
          isOpen={isDeleteModalOpen}
          handleClose={() => !isActing && setIsDeleteModalOpen(false)}
          isSubmitting={isActing}
          primaryButtonText={{ default: t("common.delete"), loading: t("common.deleting") }}
          secondaryButtonText={t("common.cancel")}
          title={t("file_library.contracts.delete.title", { count: 1 })}
          content={t("file_library.contracts.delete.description", { count: 1 })}
          handleSubmit={() => void handleDelete()}
        />
        <AlertModalCore
          variant="primary"
          isOpen={isDiscardOpen}
          handleClose={() => setIsDiscardOpen(false)}
          isSubmitting={false}
          primaryButtonText={{
            default: t("file_library.contracts.peek.discard_confirm"),
            loading: t("file_library.contracts.peek.discard_confirm"),
          }}
          secondaryButtonText={t("file_library.contracts.peek.keep_editing")}
          title={t("file_library.contracts.peek.discard_title")}
          content={t("file_library.contracts.peek.discard_description")}
          handleSubmit={() => {
            setIsDiscardOpen(false);
            setDraft({});
            onClose();
          }}
        />
        {contract?.source_template_id && (
          <ContractRenewDialog
            workspaceSlug={workspaceSlug}
            templateId={contract.source_template_id}
            isOpen={isRenewOpen}
            onClose={() => setIsRenewOpen(false)}
            initialTitle={contract.titulo ?? undefined}
          />
        )}
      </div>
    </div>
  );

  return portalContainer ? createPortal(content, portalContainer) : content;
});
