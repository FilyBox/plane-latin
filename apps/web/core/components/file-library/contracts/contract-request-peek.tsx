/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * Peek panel for a signature request — the same side-peek / modal / full-screen
 * shell the work-item and analyzed-contract peeks use.
 *
 * This panel is where every process in the contracts flow *ends*: sending,
 * signing, sealing and the hand-off to the AI analysis all resolve into a
 * visible terminal state here instead of a toast that leaves the user nowhere.
 */

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Link2, RefreshCcw, X } from "lucide-react";
import { Link } from "react-router";
import useSWR from "swr";
// plane imports
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { CenterPanelIcon, FullScreenPanelIcon, SidePanelIcon } from "@plane/propel/icons";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import { Tooltip } from "@plane/propel/tooltip";
import type { TContractSignatureRequest, TContractSigningLink } from "@plane/types";
import { cn } from "@plane/utils";
// services
import { contractService } from "@/services/contract.service";
// local imports
import { FilePreviewModal, type TPreviewFile } from "../file-preview-modal";
import { ContractEmptyState, ContractLoading, ContractSection } from "./ui";

type TPeekModes = "side-peek" | "modal" | "full-screen";
type Tab = "progress" | "document" | "links";

const PEEK_OPTIONS: { key: TPeekModes; icon: typeof SidePanelIcon; i18nKey: string }[] = [
  { key: "side-peek", icon: SidePanelIcon, i18nKey: "common.side_peek" },
  { key: "modal", icon: CenterPanelIcon, i18nKey: "common.modal" },
  { key: "full-screen", icon: FullScreenPanelIcon, i18nKey: "common.full_screen" },
];

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
};

const isSignedStatus = (status: string) => ["SIGNED", "APPROVED", "COMPLETED"].includes(status);

type Props = {
  workspaceSlug: string;
  requestId: string;
  onClose: () => void;
  onMutate: () => void;
  /** Opens the field editor route for a request that is still being authored. */
  onOpenEditor: (request: TContractSignatureRequest) => void;
};

export function ContractRequestPeek({ workspaceSlug, requestId, onClose, onMutate, onOpenEditor }: Props) {
  const { t } = useTranslation();
  const [peekMode, setPeekMode] = useState<TPeekModes>("side-peek");
  const [tab, setTab] = useState<Tab>("progress");
  const [isSyncing, setIsSyncing] = useState(false);
  const [links, setLinks] = useState<TContractSigningLink[]>();
  const [isLoadingLinks, setIsLoadingLinks] = useState(false);
  const [previewFile, setPreviewFile] = useState<TPreviewFile | null>(null);

  const {
    data: request,
    mutate,
    isLoading,
  } = useSWR(
    `CONTRACT_SIGNATURE_REQUEST_${workspaceSlug}_${requestId}`,
    () => contractService.getSignatureRequest(workspaceSlug, requestId),
    {
      // Poll while the envelope is still moving; stop once it reaches a terminal state.
      refreshInterval: (latest) => (latest && ["PENDING", "PREPARING", "READY"].includes(latest.status) ? 10000 : 0),
      revalidateOnFocus: false,
    }
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !previewFile) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, previewFile]);

  // Signing links only exist once an envelope was created without email delivery.
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
    } catch (error: any) {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: error?.error ?? t("file_library.contracts.workflow.documents.sync_failed"),
      });
    } finally {
      setIsSyncing(false);
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

  const openPdf = (signed: boolean) => {
    if (!request) return;
    const assetId = signed ? request.signed_asset_id : request.pdf_asset_id;
    if (!assetId) return;
    setPreviewFile({
      assetId,
      name: `${request.title}${signed ? t("file_library.contracts.workflow.documents.signed_suffix") : ""}.pdf`,
      contentType: "application/pdf",
    });
  };

  const copyLink = async (url: string) => {
    await navigator.clipboard.writeText(url);
    setToast({ type: TOAST_TYPE.SUCCESS, title: t("file_library.contracts.workflow.common.copied") });
  };

  const tabs: { key: Tab; label: string }[] = [
    { key: "progress", label: t("file_library.contracts.workflow.request_peek.tab_progress") },
    { key: "document", label: t("file_library.contracts.workflow.request_peek.tab_document") },
    ...(request?.documenso_envelope_id
      ? [{ key: "links" as Tab, label: t("file_library.contracts.workflow.request_peek.tab_links") }]
      : []),
  ];

  return createPortal(
    <div
      className={cn("fixed z-30 flex flex-col overflow-hidden bg-surface-1", {
        "top-0 right-0 h-full w-full border-l border-subtle md:w-[45%]": peekMode === "side-peek",
        "shadow-xl top-1/2 left-1/2 h-[85%] w-[85%] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-subtle":
          peekMode === "modal",
        "inset-0 size-full": peekMode === "full-screen",
      })}
    >
      {/* header */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-subtle px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            aria-label={t("file_library.contracts.workflow.common.close")}
            className="grid size-7 shrink-0 place-items-center rounded-md text-tertiary hover:bg-layer-1-hover hover:text-primary"
            onClick={onClose}
          >
            <X className="size-4" />
          </button>
          <div className="min-w-0">
            <p className="truncate text-14 font-semibold text-primary">{request?.title ?? "—"}</p>
            {request ? (
              <p className="mt-0.5 truncate text-11 text-tertiary">
                {t("file_library.contracts.workflow.common.version_number", { number: request.revision.revision })} ·{" "}
                {new Date(request.created_at).toLocaleString()}
              </p>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {request?.documenso_envelope_id ? (
            <Tooltip tooltipContent={t("file_library.contracts.workflow.documents.sync")}>
              <button
                type="button"
                aria-label={t("file_library.contracts.workflow.documents.sync")}
                disabled={isSyncing}
                onClick={() => void sync()}
                className="grid size-7 place-items-center rounded-md text-tertiary hover:bg-layer-1-hover hover:text-primary"
              >
                <RefreshCcw className={cn("size-3.5", isSyncing && "animate-spin")} />
              </button>
            </Tooltip>
          ) : null}
          {PEEK_OPTIONS.map((option) => (
            <Tooltip key={option.key} tooltipContent={t(option.i18nKey)}>
              <button
                type="button"
                aria-label={t(option.i18nKey)}
                onClick={() => setPeekMode(option.key)}
                className={cn(
                  "grid size-7 place-items-center rounded-md hover:bg-layer-1-hover",
                  peekMode === option.key ? "text-accent-primary" : "text-tertiary"
                )}
              >
                <option.icon className="size-3.5" />
              </button>
            </Tooltip>
          ))}
        </div>
      </div>

      {isLoading && !request ? (
        <ContractLoading className="flex-1" />
      ) : !request ? (
        <ContractEmptyState
          className="flex-1"
          icon={<AlertTriangle className="size-5" />}
          title={t("file_library.contracts.workflow.request_peek.not_found")}
        />
      ) : (
        <>
          {/* terminal-state banner */}
          <RequestOutcomeBanner
            workspaceSlug={workspaceSlug}
            request={request}
            onOpenEditor={() => onOpenEditor(request)}
            onDownloadSigned={() => openPdf(true)}
          />

          {/* tabs */}
          <div className="flex shrink-0 gap-1 border-b border-subtle px-4">
            {tabs.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => setTab(item.key)}
                className={cn(
                  "-mb-px border-b-2 px-3 py-2.5 text-13 font-medium transition-colors",
                  tab === item.key
                    ? "border-accent-strong text-primary"
                    : "border-transparent text-tertiary hover:text-secondary"
                )}
              >
                {item.label}
              </button>
            ))}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {tab === "progress" ? (
              <div className="space-y-4">
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
                            {/* Status as plain text — a badge per row turned the
                                panel into a wall of pills. */}
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
                                  <dd
                                    className={cn(
                                      "min-w-0 break-words",
                                      field.value ? "text-primary" : "text-tertiary"
                                    )}
                                  >
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
                  <p className="text-right text-11 text-tertiary">
                    {t("file_library.contracts.workflow.documents.last_sync", {
                      date: new Date(request.signing_details.synced_at).toLocaleString(),
                    })}
                  </p>
                ) : null}
              </div>
            ) : null}

            {tab === "document" ? (
              <div className="space-y-3">
                <ContractSection
                  title={t("file_library.contracts.workflow.request_peek.documents_title")}
                  bodyClassName="divide-y divide-subtle"
                >
                  <DocumentRow
                    label={t("file_library.contracts.workflow.request_peek.generated_pdf")}
                    description={`${request.title}.pdf`}
                    disabled={!request.pdf_asset_id}
                    onOpen={() => openPdf(false)}
                    openLabel={t("file_library.contracts.workflow.documents.view_pdf")}
                  />
                  {request.signed_asset_id ? (
                    <DocumentRow
                      label={t("file_library.contracts.workflow.request_peek.signed_pdf")}
                      description={t("file_library.contracts.workflow.request_peek.signed_pdf_description")}
                      onOpen={() => openPdf(true)}
                      openLabel={t("file_library.contracts.workflow.documents.view_pdf")}
                    />
                  ) : null}
                </ContractSection>
              </div>
            ) : null}

            {tab === "links" ? (
              isLoadingLinks ? (
                <ContractLoading />
              ) : (links ?? []).length === 0 ? (
                <ContractEmptyState
                  icon={<Link2 className="size-5" />}
                  title={t("file_library.contracts.workflow.request_peek.no_links")}
                  description={t("file_library.contracts.workflow.request_peek.no_links_description")}
                />
              ) : (
                <div className="space-y-2">
                  {(links ?? []).map((link) => (
                    <div
                      key={link.id ?? `${link.email}:${link.role}`}
                      className="rounded-lg border border-subtle bg-layer-1 p-3"
                    >
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
              )
            ) : null}
          </div>
        </>
      )}

      <FilePreviewModal
        workspaceSlug={workspaceSlug}
        file={previewFile}
        onClose={() => setPreviewFile(null)}
        scope="contract"
        readOnly
      />
    </div>,
    document.body
  );
}

function DocumentRow({
  label,
  description,
  onOpen,
  openLabel,
  disabled,
}: {
  label: string;
  description: string;
  onOpen: () => void;
  openLabel: string;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <p className="truncate text-13 font-medium text-primary">{label}</p>
        <p className="truncate text-11 text-tertiary">{description}</p>
      </div>
      <Button variant="secondary" size="sm" disabled={disabled} onClick={onOpen}>
        {openLabel}
      </Button>
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
  onOpenEditor,
  onDownloadSigned,
}: {
  workspaceSlug: string;
  request: TContractSignatureRequest;
  onOpenEditor: () => void;
  onDownloadSigned: () => void;
}) {
  const { t } = useTranslation();

  const shell = (tone: "default" | "success" | "danger", title: string, detail: string, actions?: React.ReactNode) => (
    <div className="shrink-0 border-b border-subtle px-4 py-3">
      <p
        className={cn(
          "text-13 font-medium",
          tone === "success" ? "text-success-primary" : tone === "danger" ? "text-danger-primary" : "text-primary"
        )}
      >
        {title}
      </p>
      <p className="mt-0.5 text-11 text-tertiary">{detail}</p>
      {actions ? <div className="mt-2.5 flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );

  if (request.status === "COMPLETED")
    return shell(
      "success",
      t("file_library.contracts.workflow.request_peek.completed_title"),
      request.completed_at
        ? t("file_library.contracts.workflow.request_peek.completed_at", {
            date: new Date(request.completed_at).toLocaleString(),
          })
        : t("file_library.contracts.workflow.request_peek.completed_description"),
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

  if (request.status === "ERROR" || request.status === "REJECTED")
    return shell(
      "danger",
      t(
        request.status === "REJECTED"
          ? "file_library.contracts.workflow.request_peek.rejected_title"
          : "file_library.contracts.workflow.request_peek.error_title"
      ),
      request.error?.message ??
        request.signing_details?.error ??
        t("file_library.contracts.workflow.request_peek.error_description"),
      <Button variant="secondary" size="sm" onClick={onOpenEditor}>
        {t("file_library.contracts.workflow.request_peek.resend")}
      </Button>
    );

  if (request.status === "READY" || request.status === "DRAFT")
    return shell(
      "default",
      t("file_library.contracts.workflow.request_peek.ready_title"),
      t("file_library.contracts.workflow.request_peek.ready_description"),
      <Button variant="primary" size="sm" onClick={onOpenEditor}>
        {t("file_library.contracts.workflow.request_peek.open_editor")}
      </Button>
    );

  if (request.status === "PREPARING")
    return shell(
      "default",
      t("file_library.contracts.workflow.request_peek.preparing_title"),
      t("file_library.contracts.workflow.request_peek.preparing_description")
    );

  // PENDING / CANCELLED — the status line alone is enough.
  return shell(
    "default",
    t(STATUS_LABEL_KEYS[request.status]),
    request.sent_at
      ? t("file_library.contracts.workflow.request_peek.sent_at", {
          date: new Date(request.sent_at).toLocaleString(),
        })
      : ""
  );
}
