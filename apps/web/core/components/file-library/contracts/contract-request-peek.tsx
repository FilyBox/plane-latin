/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * Signature request detail rendered with the same preview-first shell as the
 * analyzed-contract panel. Signing information stays first; AI data only
 * appears after the request reaches COMPLETED.
 */

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Ban, BellRing, CopyPlus, Link2, Loader2, RefreshCcw } from "lucide-react";
import { Link } from "react-router";
import useSWR from "swr";
// plane imports
import { PDFViewer } from "@plane/extend-ui";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TContract, TContractSignatureRequest, TContractSigningLink } from "@plane/types";
import { AlertModalCore } from "@plane/ui";
import { cn } from "@plane/utils";
// services
import { contractService } from "@/services/contract.service";
import { fileLibraryService } from "@/services/file-library.service";
// local imports
import { downloadAssets } from "../download";
import { ContractPeekLayout, type TContractPeekTab } from "./contract-peek-layout";
import {
  cancelAndDuplicateRequest,
  ContractSendSteps,
  hasSendFailed,
  isSendInProgress,
  sendErrorMessage,
  sendStepOf,
} from "./contract-send-progress";
import { contractErrorMessage, requestStatusLabelKey } from "./template-utils";
import { ContractEmptyState, ContractLoading, ContractSection, RequestStatusBadge } from "./ui";

type Tab = "document" | "signature" | "analysis" | "process" | "links";
type PeekAction = "remind" | "cancel" | "cancel_duplicate" | "duplicate";

const ACTION_TOAST_KEYS: Record<PeekAction, { success: string; failed: string }> = {
  remind: {
    success: "file_library.contracts.workflow.documents.remind_success",
    failed: "file_library.contracts.workflow.documents.remind_failed",
  },
  cancel: {
    success: "file_library.contracts.workflow.documents.cancel_success",
    failed: "file_library.contracts.workflow.documents.cancel_failed",
  },
  cancel_duplicate: {
    success: "file_library.contracts.workflow.tracking.cancel_duplicate_success",
    failed: "file_library.contracts.workflow.tracking.cancel_duplicate_failed",
  },
  duplicate: {
    success: "file_library.contracts.workflow.documents.duplicate_success",
    failed: "file_library.contracts.workflow.documents.duplicate_failed",
  },
};

const formatDate = (iso?: string | null) => {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
};

const SIGNER_STATUS_LABEL_KEYS: Record<string, string> = {
  NOT_SENT: "file_library.contracts.workflow.signer_status.not_sent",
  NOT_SIGNED: "file_library.contracts.workflow.signer_status.pending",
  SENT: "file_library.contracts.workflow.signer_status.sent",
  OPENED: "file_library.contracts.workflow.signer_status.opened",
  SIGNED: "file_library.contracts.workflow.signer_status.completed",
  REJECTED: "file_library.contracts.workflow.signer_status.rejected",
  PENDING: "file_library.contracts.workflow.signer_status.pending",
  APPROVED: "file_library.contracts.workflow.signer_status.approved",
  COMPLETED: "file_library.contracts.workflow.signer_status.completed",
  EXPIRED: "file_library.contracts.workflow.signer_status.expired",
};

const isSignedStatus = (status: string) => ["SIGNED", "APPROVED", "COMPLETED"].includes(status);

type Props = {
  workspaceSlug: string;
  requestId: string;
  onClose: () => void;
  onMutate: () => void;
  onOpenEditor: (request: TContractSignatureRequest) => void;
  /** Shows another request in the panel (a copy that is not ready to edit yet). */
  onOpenRequest?: (requestId: string) => void;
};

export function ContractRequestPeek({
  workspaceSlug,
  requestId,
  onClose,
  onMutate,
  onOpenEditor,
  onOpenRequest,
}: Props) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>("signature");
  const [acting, setActing] = useState<PeekAction>();
  const [confirming, setConfirming] = useState<"cancel" | "cancel_duplicate">();
  const [isSyncing, setIsSyncing] = useState(false);
  const [links, setLinks] = useState<TContractSigningLink[]>();
  const [isLoadingLinks, setIsLoadingLinks] = useState(false);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);

  const {
    data: request,
    mutate,
    isLoading,
  } = useSWR(
    `CONTRACT_SIGNATURE_REQUEST_${workspaceSlug}_${requestId}`,
    () => contractService.getSignatureRequest(workspaceSlug, requestId),
    {
      // Faster while a background send is moving, so its steps read live.
      refreshInterval: (latest) => {
        if (!latest) return 0;
        if (isSendInProgress(latest) && sendStepOf(latest) !== "done") return 2000;
        return ["PENDING", "PREPARING", "READY"].includes(latest.status) ? 10000 : 0;
      },
      revalidateOnFocus: false,
    }
  );

  const canShowAnalysis = request?.status === "COMPLETED";
  const { data: analysis, isLoading: isLoadingAnalysis } = useSWR<TContract>(
    canShowAnalysis && request?.analysis_contract_id
      ? `CONTRACT_DETAIL_${workspaceSlug}_${request.analysis_contract_id}`
      : null,
    () => contractService.getContract(workspaceSlug, request!.analysis_contract_id!),
    { revalidateOnFocus: false }
  );

  const previewAssetId =
    request?.status === "COMPLETED" && request.signed_asset_id
      ? request.signed_asset_id
      : request?.rendered_pdf_asset_id || request?.pdf_asset_id;

  useEffect(() => {
    let cancelled = false;
    setPdfUrl(null);
    setPreviewFailed(false);
    if (!previewAssetId) return;
    const loadPreview = async () => {
      try {
        const url = await fileLibraryService.getPresignedViewUrl(workspaceSlug, previewAssetId, "contract");
        if (!cancelled) setPdfUrl(url);
      } catch {
        if (!cancelled) setPreviewFailed(true);
      }
    };
    void loadPreview();
    return () => {
      cancelled = true;
    };
  }, [previewAssetId, workspaceSlug]);

  useEffect(() => {
    if (tab !== "links" || links || !request?.documenso_envelope_id) return;
    setIsLoadingLinks(true);
    void contractService
      .getSignatureRequestLinks(workspaceSlug, requestId)
      .then(setLinks)
      .catch(() =>
        setToast({ type: TOAST_TYPE.ERROR, title: t("file_library.contracts.workflow.documents.links_failed") })
      )
      .finally(() => setIsLoadingLinks(false));
  }, [links, request?.documenso_envelope_id, requestId, t, tab, workspaceSlug]);

  const sync = async () => {
    setIsSyncing(true);
    try {
      await contractService.syncSignatureRequest(workspaceSlug, requestId);
      await mutate();
      onMutate();
    } catch (error: unknown) {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: contractErrorMessage(t, error, "file_library.contracts.workflow.documents.sync_failed"),
      });
    } finally {
      setIsSyncing(false);
    }
  };

  /** A copy opens in the editor when it can be edited, otherwise in this panel. */
  const openCopy = (copy: TContractSignatureRequest) => {
    if (!copy.id) return;
    if (copy.status === "READY" || copy.status === "DRAFT" || !onOpenRequest) onOpenEditor(copy);
    else onOpenRequest(copy.id);
  };

  const runAction = async (action: PeekAction) => {
    if (!request) return;
    setActing(action);
    try {
      let copy: TContractSignatureRequest | undefined;
      if (action === "remind") await contractService.remindSignatureRequest(workspaceSlug, request.id);
      else if (action === "cancel") await contractService.cancelSignatureRequest(workspaceSlug, request.id);
      else if (action === "duplicate")
        copy = await contractService.duplicateSignatureRequest(workspaceSlug, request.id);
      else copy = await cancelAndDuplicateRequest(workspaceSlug, request.id);
      setConfirming(undefined);
      setToast({ type: TOAST_TYPE.SUCCESS, title: t(ACTION_TOAST_KEYS[action].success) });
      onMutate();
      if (copy) {
        openCopy(copy);
        return;
      }
      await mutate();
    } catch (error: unknown) {
      setToast({ type: TOAST_TYPE.ERROR, title: contractErrorMessage(t, error, ACTION_TOAST_KEYS[action].failed) });
    } finally {
      setActing(undefined);
    }
  };

  const participants = useMemo(() => {
    if (!request) return [];
    const remote = request.signing_details?.recipients ?? [];
    if (remote.length > 0) return remote;
    return request.signers.map((signer) => ({
      id: signer.documenso_recipient_id,
      name: signer.name,
      email: signer.email,
      role: signer.role,
      signing_order: signer.signing_order,
      signing_status: signer.status,
      read_status: signer.status === "OPENED" || signer.status === "SIGNED" ? "OPENED" : "NOT_OPENED",
      send_status: signer.status === "NOT_SENT" ? "NOT_SENT" : "SENT",
      signed_at: null,
      rejection_reason: null,
    }));
  }, [request]);

  const signedCount = participants.filter((participant) => isSignedStatus(participant.signing_status)).length;

  const copyLink = async (url: string) => {
    await navigator.clipboard.writeText(url);
    setToast({ type: TOAST_TYPE.SUCCESS, title: t("file_library.contracts.workflow.common.copied") });
  };

  const downloadSigned = async () => {
    if (!request?.signed_asset_id) return;
    try {
      await downloadAssets(
        workspaceSlug,
        [
          {
            assetId: request.signed_asset_id,
            name: `${request.title}${t("file_library.contracts.workflow.documents.signed_suffix")}.pdf`,
          },
        ],
        request.title,
        "contract"
      );
    } catch {
      setToast({ type: TOAST_TYPE.ERROR, title: t("file_library.download_failed") });
    }
  };

  const tabs: TContractPeekTab[] = [
    {
      key: "document",
      label: t("file_library.contracts.workflow.request_peek.tab_document"),
      document: true,
    },
    {
      key: "signature",
      label: t("file_library.contracts.workflow.request_peek.tab_signature"),
    },
    ...(canShowAnalysis
      ? [
          {
            key: "analysis",
            label: t("file_library.contracts.workflow.request_peek.tab_analysis"),
          },
          {
            key: "process",
            label: t("file_library.contracts.tabs.process"),
          },
        ]
      : []),
    ...(request?.documenso_envelope_id
      ? [
          {
            key: "links",
            label: t("file_library.contracts.workflow.request_peek.tab_links"),
          },
        ]
      : []),
  ];

  const documentPane = (expandControl: React.ReactNode) => {
    /** The viewer seats the expand control in its own toolbar. The states with
     * no chrome of their own float it in the corner instead, so a document that
     * never previews is still one click away from handing the split back. */
    const bare = (node: React.ReactNode) => (
      <div className="relative h-full">
        {expandControl ? <div className="absolute top-2 right-2 z-10">{expandControl}</div> : null}
        {node}
      </div>
    );

    if (isLoading && !request) return bare(<ContractLoading className="h-full" />);
    if (!previewAssetId || previewFailed)
      return bare(
        <ContractEmptyState
          className="h-full"
          icon={<AlertTriangle className="size-5" />}
          title={t("file_library.contracts.workflow.request_peek.preview_unavailable")}
        />
      );
    if (!pdfUrl)
      return bare(
        <div className="flex h-full items-center justify-center text-tertiary">
          <Loader2 className="size-5 animate-spin" />
        </div>
      );

    return (
      <PDFViewer
        src={pdfUrl}
        fileName={`${request?.title ?? "contract"}.pdf`}
        className="h-full"
        showUpload={false}
        toolbarActions={expandControl}
      />
    );
  };

  const signaturePane = !request ? (
    <ContractLoading className="h-full" />
  ) : (
    <div className="h-full overflow-y-auto p-4">
      <RequestOutcomeBanner
        workspaceSlug={workspaceSlug}
        request={request}
        acting={acting}
        onOpenEditor={() => onOpenEditor(request)}
        onDownloadSigned={() => void downloadSigned()}
        onRemind={() => void runAction("remind")}
        onCancel={() => setConfirming("cancel")}
        onCancelDuplicate={() => setConfirming("cancel_duplicate")}
        onDuplicate={() => void runAction("duplicate")}
      />
      <ContractSection
        title={t("file_library.contracts.workflow.request_peek.signers_title")}
        description={t("file_library.contracts.workflow.documents.signers_completed", {
          completed: signedCount,
          total: participants.length,
        })}
        bodyClassName="divide-y divide-subtle"
      >
        {participants.length === 0 ? (
          <p className="px-4 py-6 text-center text-13 text-tertiary">
            {t("file_library.contracts.workflow.documents.no_participants")}
          </p>
        ) : (
          participants.map((participant, index) => {
            const fields = (request.signing_details?.fields ?? []).filter(
              (field) => field.recipient_id === participant.id
            );
            const done = isSignedStatus(participant.signing_status);
            const rejected = participant.signing_status === "REJECTED";
            return (
              <div key={participant.id ?? `${participant.email}:${participant.role}`} className="px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-13 font-medium text-primary">
                      {participant.name ||
                        t("file_library.contracts.workflow.documents.participant_number", {
                          number: index + 1,
                        })}
                    </p>
                    <p className="truncate text-11 text-tertiary">{participant.email}</p>
                  </div>
                  <span
                    className={cn(
                      "shrink-0 text-11",
                      done ? "text-success-primary" : rejected ? "text-danger-primary" : "text-tertiary"
                    )}
                  >
                    {SIGNER_STATUS_LABEL_KEYS[participant.signing_status]
                      ? t(SIGNER_STATUS_LABEL_KEYS[participant.signing_status])
                      : participant.signing_status}
                  </span>
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-11 text-tertiary">
                  <span>
                    {t(
                      participant.send_status === "SENT"
                        ? "file_library.contracts.workflow.documents.email_sent"
                        : "file_library.contracts.workflow.signer_status.not_sent"
                    )}
                  </span>
                  <span>
                    {t(
                      participant.read_status === "OPENED"
                        ? "file_library.contracts.workflow.documents.document_opened"
                        : "file_library.contracts.workflow.documents.not_opened"
                    )}
                  </span>
                  {participant.signed_at ? (
                    <span>
                      {t("file_library.contracts.workflow.documents.signed_at", {
                        date: new Date(participant.signed_at).toLocaleString(),
                      })}
                    </span>
                  ) : null}
                </div>
                {participant.rejection_reason ? (
                  <p className="mt-2 text-11 text-danger-primary">{participant.rejection_reason}</p>
                ) : null}
                {fields.length > 0 ? (
                  <dl className="mt-2 space-y-1">
                    {fields.map((field) => (
                      <div
                        key={field.id ?? `${field.type}:${field.page}:${field.label}`}
                        className="flex gap-3 text-11"
                      >
                        <dt className="w-32 shrink-0 truncate text-tertiary">{field.label || field.type}</dt>
                        <dd className={cn("min-w-0 break-words", field.value ? "text-primary" : "text-tertiary")}>
                          {field.value || t("file_library.contracts.workflow.signer_status.pending")}
                        </dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
              </div>
            );
          })
        )}
      </ContractSection>
      {request.signing_details?.synced_at ? (
        <p className="mt-3 text-right text-11 text-tertiary">
          {t("file_library.contracts.workflow.documents.last_sync", {
            date: new Date(request.signing_details.synced_at).toLocaleString(),
          })}
        </p>
      ) : null}
    </div>
  );

  const linksPane = isLoadingLinks ? (
    <ContractLoading className="h-full" />
  ) : (links ?? []).length === 0 ? (
    <ContractEmptyState
      className="h-full"
      icon={<Link2 className="size-5" />}
      title={t("file_library.contracts.workflow.request_peek.no_links")}
      description={t("file_library.contracts.workflow.request_peek.no_links_description")}
    />
  ) : (
    <div className="h-full space-y-2 overflow-y-auto p-4">
      {(links ?? []).map((link) => (
        <div key={link.id ?? `${link.email}:${link.role}`} className="rounded-lg border border-subtle bg-layer-1 p-3">
          <p className="text-13 font-medium text-primary">{link.name || link.email}</p>
          <p className="mt-0.5 text-11 text-tertiary">{link.email}</p>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-layer-2 px-2 py-1.5 text-11 text-secondary">
              {link.url}
            </code>
            <Button variant="secondary" size="sm" onClick={() => void copyLink(link.url)}>
              {t("file_library.contracts.workflow.common.copy")}
            </Button>
          </div>
        </div>
      ))}
      <Button
        variant="secondary"
        size="sm"
        className="w-full"
        onClick={() => void copyLink((links ?? []).map((link) => `${link.name}: ${link.url}`).join("\n"))}
      >
        {t("file_library.contracts.workflow.signing_links.copy_all")}
      </Button>
    </div>
  );

  const analysisPane = (
    <AnalysisDetails
      contract={analysis}
      isLoading={isLoadingAnalysis}
      analysisRequested={Boolean(request?.analysis_contract_id)}
    />
  );
  const processPane = (
    <AnalysisProcess
      contract={analysis}
      isLoading={isLoadingAnalysis}
      analysisRequested={Boolean(request?.analysis_contract_id)}
    />
  );
  const sidePane =
    tab === "analysis" ? analysisPane : tab === "process" ? processPane : tab === "links" ? linksPane : signaturePane;

  return (
    <>
      <ContractPeekLayout
        // Escape closes the confirmation first, not the panel under it.
        suspendClose={Boolean(confirming)}
        title={request?.title ?? t("file_library.contracts.workflow.documents.title")}
        status={
          request ? (
            <RequestStatusBadge
              status={isSendInProgress(request) ? "PREPARING" : request.status}
              label={
                isSendInProgress(request)
                  ? t("file_library.contracts.workflow.send.sending")
                  : t(requestStatusLabelKey(request.status))
              }
            />
          ) : null
        }
        headerActions={
          request?.documenso_envelope_id ? (
            <button
              type="button"
              aria-label={t("file_library.contracts.workflow.documents.sync")}
              title={t("file_library.contracts.workflow.documents.sync")}
              disabled={isSyncing}
              onClick={() => void sync()}
              className="grid size-7 place-items-center rounded-md text-tertiary hover:bg-layer-1-hover hover:text-primary disabled:opacity-50"
            >
              <RefreshCcw className={cn("size-3.5", isSyncing && "animate-spin")} />
            </button>
          ) : null
        }
        tabs={tabs}
        activeTab={tab}
        desktopActiveTab={tab === "document" ? "signature" : tab}
        onTabChange={(key) => setTab(key as Tab)}
        documentPane={documentPane}
        sidePane={sidePane}
        onClose={onClose}
      />
      <AlertModalCore
        isOpen={confirming === "cancel"}
        handleClose={() => setConfirming(undefined)}
        handleSubmit={() => void runAction("cancel")}
        isSubmitting={acting === "cancel"}
        title={t("file_library.contracts.workflow.documents.cancel_title")}
        content={t("file_library.contracts.workflow.documents.cancel_description", { title: request?.title ?? "" })}
        primaryButtonText={{
          default: t("file_library.contracts.workflow.documents.cancel_confirm"),
          loading: t("file_library.contracts.workflow.documents.cancel_confirming"),
        }}
        secondaryButtonText={t("file_library.contracts.workflow.documents.keep")}
      />
      <AlertModalCore
        isOpen={confirming === "cancel_duplicate"}
        handleClose={() => setConfirming(undefined)}
        handleSubmit={() => void runAction("cancel_duplicate")}
        isSubmitting={acting === "cancel_duplicate"}
        title={t("file_library.contracts.workflow.tracking.cancel_duplicate_title")}
        content={t("file_library.contracts.workflow.tracking.cancel_duplicate_description", {
          title: request?.title ?? "",
        })}
        primaryButtonText={{
          default: t("file_library.contracts.workflow.tracking.cancel_duplicate_confirm"),
          loading: t("file_library.contracts.workflow.tracking.cancel_duplicate_confirming"),
        }}
        secondaryButtonText={t("file_library.contracts.workflow.documents.keep")}
      />
    </>
  );
}

function AnalysisDetails({
  contract,
  isLoading,
  analysisRequested,
}: {
  contract?: TContract;
  isLoading: boolean;
  analysisRequested: boolean;
}) {
  const { t } = useTranslation();
  if (isLoading)
    return (
      <div className="flex h-full items-center justify-center text-tertiary">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  if (!contract)
    return (
      <ContractEmptyState
        className="h-full"
        icon={<RefreshCcw className="size-5" />}
        title={t("file_library.contracts.workflow.request_peek.analysis_running")}
        description={t(
          analysisRequested
            ? "file_library.contracts.workflow.request_peek.analysis_processing_description"
            : "file_library.contracts.workflow.request_peek.analysis_waiting_description"
        )}
      />
    );

  const fields = [
    ["file_library.contracts.fields.titulo", contract.titulo],
    ["file_library.contracts.fields.resumen_general", contract.resumen_general],
    ["file_library.contracts.fields.tipo_contrato", contract.tipo_contrato],
    ["file_library.contracts.fields.estatus_contrato", contract.estatus_contrato],
    ["file_library.contracts.fields.fecha_inicio", contract.fecha_inicio],
    ["file_library.contracts.fields.fecha_fin", contract.fecha_fin],
    ["file_library.contracts.fields.artistas", contract.artistas],
    ["file_library.contracts.fields.involucrados", contract.involucrados],
  ] as const;

  return (
    <div className="h-full overflow-y-auto p-4">
      <dl className="divide-y divide-subtle rounded-md border border-subtle">
        {fields.map(([label, value]) => (
          <div key={label} className="grid gap-1 px-3 py-2.5 sm:grid-cols-[10rem_1fr]">
            <dt className="text-11 font-medium text-tertiary">{t(label)}</dt>
            <dd className="text-12 whitespace-pre-wrap text-primary">{value || "—"}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function AnalysisProcess({
  contract,
  isLoading,
  analysisRequested,
}: {
  contract?: TContract;
  isLoading: boolean;
  analysisRequested: boolean;
}) {
  const { t } = useTranslation();
  if (isLoading) return <ContractLoading className="h-full" />;
  return (
    <div className="h-full overflow-y-auto p-4">
      <ContractSection title={t("file_library.contracts.process.pipeline_state")}>
        <div className="space-y-1 px-4 py-3 text-12 text-tertiary">
          <p>
            {contract?.text_extracted_at
              ? t("file_library.contracts.process.text_extracted", {
                  date: new Date(contract.text_extracted_at).toLocaleString(),
                })
              : t("file_library.contracts.process.text_pending")}
          </p>
          {contract?.processed_at ? (
            <p>
              {t("file_library.contracts.process.analyzed", {
                date: new Date(contract.processed_at).toLocaleString(),
              })}
            </p>
          ) : null}
          {!analysisRequested ? (
            <p>{t("file_library.contracts.workflow.request_peek.analysis_waiting_description")}</p>
          ) : null}
        </div>
      </ContractSection>
    </div>
  );
}

/**
 * The completion surface.
 *
 * Deliberately quiet: one status line plus the action that state calls for.
 * Semantic colour is carried by the status word alone — tinted panels and a
 * large icon per state read as an alert box, which is not Plane's language.
 */
function RequestOutcomeBanner({
  workspaceSlug,
  request,
  acting,
  onOpenEditor,
  onDownloadSigned,
  onRemind,
  onCancel,
  onCancelDuplicate,
  onDuplicate,
}: {
  workspaceSlug: string;
  request: TContractSignatureRequest;
  acting?: PeekAction;
  onOpenEditor: () => void;
  onDownloadSigned: () => void;
  onRemind: () => void;
  onCancel: () => void;
  onCancelDuplicate: () => void;
  onDuplicate: () => void;
}) {
  const { t } = useTranslation();

  const shell = (
    tone: "default" | "success" | "danger",
    title: string,
    details: string[],
    actions?: React.ReactNode,
    extra?: React.ReactNode
  ) => (
    <div className="mb-3 rounded-md border border-subtle bg-layer-1 px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p
            className={cn(
              "truncate text-12 font-medium",
              tone === "success" ? "text-success-primary" : tone === "danger" ? "text-danger-primary" : "text-primary"
            )}
          >
            {title}
          </p>
          {details
            .filter((detail) => detail.trim())
            .map((detail) => (
              <p key={detail} className="mt-0.5 text-11 break-words text-tertiary">
                {detail}
              </p>
            ))}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-1.5">{actions}</div> : null}
      </div>
      {extra ? <div className="mt-3 border-t border-subtle pt-3">{extra}</div> : null}
    </div>
  );

  const resendButton = (
    <Button variant="secondary" size="sm" onClick={onOpenEditor}>
      {t("file_library.contracts.workflow.request_peek.resend")}
    </Button>
  );

  if (request.status === "COMPLETED")
    return shell(
      "success",
      t("file_library.contracts.workflow.request_peek.completed_title"),
      [
        request.completed_at
          ? t("file_library.contracts.workflow.request_peek.completed_at", {
              date: new Date(request.completed_at).toLocaleString(),
            })
          : t("file_library.contracts.workflow.request_peek.completed_description"),
      ],
      <>
        {request.signed_asset_id ? (
          <Button variant="primary" size="sm" onClick={onDownloadSigned}>
            {t("file_library.contracts.workflow.request_peek.download_signed")}
          </Button>
        ) : null}
        {request.analysis_contract_id ? (
          <Link
            to={`/${workspaceSlug}/file-library/contracts/analyzed?peek=${request.analysis_contract_id}`}
            className="rounded-md border border-subtle px-3 py-1.5 text-13 font-medium text-secondary hover:bg-layer-1-hover"
          >
            {t("file_library.contracts.workflow.request_peek.view_analysis")}
          </Link>
        ) : (
          <span className="text-11 text-tertiary">
            {t("file_library.contracts.workflow.request_peek.analysis_running")}
          </span>
        )}
      </>
    );

  // Being sent in the background: the steps, live.
  if (isSendInProgress(request))
    return shell(
      "default",
      t("file_library.contracts.workflow.send.sending_title"),
      [],
      undefined,
      <ContractSendSteps phase="sending" step={sendStepOf(request)} />
    );

  // The send failed before the envelope went out.
  if (hasSendFailed(request))
    return shell(
      "danger",
      t("file_library.contracts.workflow.send.failed"),
      [sendErrorMessage(t, request)],
      resendButton
    );

  if (request.status === "ERROR" || request.status === "REJECTED")
    return shell(
      "danger",
      t(
        request.status === "REJECTED"
          ? "file_library.contracts.workflow.request_peek.rejected_title"
          : "file_library.contracts.workflow.request_peek.error_title"
      ),
      [
        request.status === "ERROR" && request.metadata?.send?.error
          ? sendErrorMessage(t, request)
          : (request.error?.message ??
            request.signing_details?.error ??
            t("file_library.contracts.workflow.request_peek.error_description")),
      ],
      resendButton
    );

  if (request.status === "EXPIRED")
    return shell(
      "danger",
      t("file_library.contracts.workflow.tracking.expired_title"),
      [
        t("file_library.contracts.workflow.tracking.expired_description"),
        request.expires_at
          ? t("file_library.contracts.workflow.tracking.expired_on", { date: formatDate(request.expires_at) })
          : "",
      ],
      <Button variant="primary" size="sm" loading={acting === "duplicate"} onClick={onDuplicate}>
        <CopyPlus className="size-3.5" />
        {t("file_library.contracts.workflow.tracking.create_copy")}
      </Button>
    );

  if (request.status === "READY" || request.status === "DRAFT")
    return shell(
      "default",
      t("file_library.contracts.workflow.request_peek.ready_title"),
      [t("file_library.contracts.workflow.request_peek.ready_description")],
      <Button variant="primary" size="sm" onClick={onOpenEditor}>
        {t("file_library.contracts.workflow.request_peek.open_editor")}
      </Button>
    );

  if (request.status === "PREPARING")
    return shell("default", t("file_library.contracts.workflow.request_peek.preparing_title"), [
      t("file_library.contracts.workflow.request_peek.preparing_description"),
    ]);

  const sentLine = request.sent_at
    ? t("file_library.contracts.workflow.request_peek.sent_at", { date: formatDate(request.sent_at) })
    : "";

  // Out for signature: chase, cancel, or cancel and start over from a copy.
  if (request.status === "PENDING")
    return shell(
      "default",
      t(requestStatusLabelKey(request.status)),
      [
        sentLine,
        request.last_reminded_at
          ? t("file_library.contracts.workflow.tracking.last_reminded", { date: formatDate(request.last_reminded_at) })
          : "",
        request.expires_at
          ? t("file_library.contracts.workflow.tracking.expires_on", { date: formatDate(request.expires_at) })
          : "",
      ],
      <>
        <Button
          variant="secondary"
          size="sm"
          loading={acting === "remind"}
          disabled={Boolean(acting)}
          onClick={onRemind}
        >
          <BellRing className="size-3.5" />
          {t("file_library.contracts.workflow.documents.remind")}
        </Button>
        <Button variant="secondary" size="sm" disabled={Boolean(acting)} onClick={onCancelDuplicate}>
          <CopyPlus className="size-3.5" />
          {t("file_library.contracts.workflow.tracking.cancel_duplicate")}
        </Button>
        <Button variant="error-outline" size="sm" disabled={Boolean(acting)} onClick={onCancel}>
          <Ban className="size-3.5" />
          {t("file_library.contracts.workflow.documents.cancel_request")}
        </Button>
      </>
    );

  // CANCELLED and statuses this build does not know: the status line alone.
  return shell("default", t(requestStatusLabelKey(request.status)), [sentLine]);
}
