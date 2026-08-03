/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useMemo, useState } from "react";
import {
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  Eye,
  FileCheck2,
  Link2,
  Loader2,
  RefreshCcw,
  Send,
  UserRoundCheck,
} from "lucide-react";
import { useSearchParams } from "react-router";
import useSWR from "swr";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TContractSignatureRequest, TContractSigningLink } from "@plane/types";
import { cn } from "@plane/utils";
import { contractService } from "@/services/contract.service";
import { FilePreviewModal, type TPreviewFile } from "../file-preview-modal";
import { ContractAuthoringModal } from "./contract-authoring-modal";
import { ContractSigningLinksDialog } from "./contract-signing-links-dialog";

type Props = { workspaceSlug: string };

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

const statusClass = (status: TContractSignatureRequest["status"]) => {
  if (status === "COMPLETED") return "bg-success-primary/10 text-success-primary";
  if (status === "REJECTED" || status === "ERROR") return "bg-danger-primary/10 text-danger-primary";
  if (status === "PENDING") return "bg-warning-primary/10 text-warning-primary";
  return "bg-layer-2 text-secondary";
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

export function ContractDocuments({ workspaceSlug }: Props) {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const {
    data: requests,
    mutate,
    isLoading,
  } = useSWR(
    `CONTRACT_SIGNATURE_REQUESTS_${workspaceSlug}`,
    () => contractService.getSignatureRequests(workspaceSlug),
    { refreshInterval: 15000, revalidateOnFocus: false }
  );
  const [expandedId, setExpandedId] = useState<string>();
  const [syncingId, setSyncingId] = useState<string>();
  const [syncedId, setSyncedId] = useState<string>();
  const [authoringRequest, setAuthoringRequest] = useState<TContractSignatureRequest>();
  const [signingLinks, setSigningLinks] = useState<TContractSigningLink[]>();
  const [loadingLinksFor, setLoadingLinksFor] = useState<string>();
  const [previewFile, setPreviewFile] = useState<TPreviewFile | null>(null);
  const {
    data: detail,
    mutate: mutateDetail,
    isLoading: isDetailLoading,
  } = useSWR(
    expandedId ? `CONTRACT_SIGNATURE_REQUEST_${workspaceSlug}_${expandedId}` : null,
    () => contractService.getSignatureRequest(workspaceSlug, expandedId!),
    { revalidateOnFocus: false }
  );

  useEffect(() => {
    const requestId = searchParams.get("request");
    if (!requestId) return;
    setExpandedId(requestId);
    setSearchParams({}, { replace: true });
  }, [searchParams, setSearchParams]);

  const orderedRequests = useMemo(
    () => [...(requests ?? [])].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()),
    [requests]
  );

  const syncRequest = async (requestId: string) => {
    setSyncingId(requestId);
    setSyncedId(undefined);
    try {
      await contractService.syncSignatureRequest(workspaceSlug, requestId);
      await Promise.all([mutate(), expandedId === requestId ? mutateDetail() : Promise.resolve()]);
      setSyncedId(requestId);
      window.setTimeout(() => setSyncedId((current) => (current === requestId ? undefined : current)), 1800);
      setToast({ type: TOAST_TYPE.SUCCESS, title: t("file_library.contracts.workflow.documents.sync_success") });
    } catch (error: any) {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: error?.error ?? t("file_library.contracts.workflow.documents.sync_failed"),
      });
    } finally {
      setSyncingId(undefined);
    }
  };

  const showSigningLinks = async (requestId: string) => {
    setLoadingLinksFor(requestId);
    try {
      setSigningLinks(await contractService.getSignatureRequestLinks(workspaceSlug, requestId));
    } catch (error: any) {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: error?.error ?? t("file_library.contracts.workflow.documents.links_failed"),
      });
    } finally {
      setLoadingLinksFor(undefined);
    }
  };

  const previewRequest = (request: TContractSignatureRequest) => {
    const assetId = request.signed_asset_id ?? request.pdf_asset_id;
    if (!assetId) return;
    setPreviewFile({
      assetId,
      name: `${request.title}${request.signed_asset_id ? t("file_library.contracts.workflow.documents.signed_suffix") : ""}.pdf`,
      contentType: "application/pdf",
    });
  };

  return (
    <div className="h-full overflow-y-auto bg-surface-1">
      <div className="mx-auto max-w-6xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
        <header>
          <h1 className="text-20 font-semibold text-primary">{t("file_library.contracts.workflow.documents.title")}</h1>
          <p className="mt-1 text-12 text-secondary">{t("file_library.contracts.workflow.documents.description")}</p>
        </header>

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-lg border border-subtle p-4">
            <FileCheck2 className="size-4 text-accent-primary" />
            <p className="mt-2 text-18 font-semibold text-primary">{orderedRequests.length}</p>
            <p className="text-10 text-tertiary">{t("file_library.contracts.workflow.documents.created")}</p>
          </div>
          <div className="rounded-lg border border-subtle p-4">
            <Clock3 className="size-4 text-warning-primary" />
            <p className="mt-2 text-18 font-semibold text-primary">
              {orderedRequests.filter((request) => request.status === "PENDING").length}
            </p>
            <p className="text-10 text-tertiary">{t("file_library.contracts.workflow.documents.awaiting")}</p>
          </div>
          <div className="rounded-lg border border-subtle p-4">
            <UserRoundCheck className="size-4 text-success-primary" />
            <p className="mt-2 text-18 font-semibold text-primary">
              {orderedRequests.filter((request) => request.status === "COMPLETED").length}
            </p>
            <p className="text-10 text-tertiary">{t("file_library.contracts.workflow.documents.completed")}</p>
          </div>
        </div>

        <section className="overflow-hidden rounded-lg border border-subtle">
          <div className="border-b border-subtle px-4 py-3">
            <h2 className="text-13 font-semibold text-primary">
              {t("file_library.contracts.workflow.documents.tracking")}
            </h2>
            <p className="mt-0.5 text-10 text-tertiary">
              {t("file_library.contracts.workflow.documents.tracking_description")}
            </p>
          </div>
          {isLoading ? (
            <div className="grid min-h-48 place-items-center">
              <Loader2 className="size-5 animate-spin text-tertiary" />
            </div>
          ) : orderedRequests.length === 0 ? (
            <div className="px-6 py-14 text-center">
              <Send className="mx-auto size-7 text-tertiary" />
              <p className="mt-3 text-12 font-medium text-primary">
                {t("file_library.contracts.workflow.documents.empty_title")}
              </p>
              <p className="mt-1 text-10 text-tertiary">
                {t("file_library.contracts.workflow.documents.empty_description")}
              </p>
            </div>
          ) : (
            <div className="divide-y divide-subtle">
              {orderedRequests.map((request) => {
                const signedCount = request.signers.filter((signer) => signer.status === "SIGNED").length;
                const signerCount =
                  request.signers.length ||
                  request.recipients.filter((recipient) => recipient.role === "SIGNER").length;
                const isExpanded = expandedId === request.id;
                return (
                  <article key={request.id}>
                    <div className="grid gap-3 px-4 py-3.5 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
                      <button
                        type="button"
                        onClick={() => setExpandedId(isExpanded ? undefined : request.id)}
                        className="flex min-w-0 items-start gap-3 text-left"
                      >
                        <span className="mt-0.5 text-tertiary">
                          {isExpanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-12 font-medium text-primary">{request.title}</span>
                          <span className="mt-1 flex flex-wrap items-center gap-2 text-9 text-tertiary">
                            <span>
                              {t("file_library.contracts.workflow.common.version_number", {
                                number: request.revision.revision,
                              })}
                            </span>
                            <span>·</span>
                            <span
                              className={cn(
                                "font-medium",
                                signerCount > 0 && signedCount === signerCount ? "text-success-primary" : ""
                              )}
                            >
                              {t("file_library.contracts.workflow.documents.signers_completed", {
                                signed: signedCount,
                                total: signerCount,
                              })}
                            </span>
                            <span>·</span>
                            <span>{new Date(request.created_at).toLocaleString()}</span>
                          </span>
                        </span>
                      </button>
                      <div className="flex flex-wrap items-center gap-2 md:justify-end">
                        <span className={cn("rounded-full px-2 py-1 text-9 font-medium", statusClass(request.status))}>
                          {t(STATUS_LABEL_KEYS[request.status])}
                        </span>
                        {request.pdf_asset_id ? (
                          <Button variant="secondary" size="sm" onClick={() => previewRequest(request)}>
                            <Eye className="size-3.5" /> {t("file_library.contracts.workflow.documents.view_pdf")}
                          </Button>
                        ) : null}
                        {request.status === "READY" ? (
                          <Button variant="primary" size="sm" onClick={() => setAuthoringRequest(request)}>
                            <Send className="size-3.5" /> {t("file_library.contracts.workflow.documents.review_send")}
                          </Button>
                        ) : null}
                        {request.documenso_envelope_id ? (
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={syncingId === request.id}
                            onClick={() => void syncRequest(request.id)}
                          >
                            {syncingId === request.id ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : syncedId === request.id ? (
                              <Check className="size-3.5 text-success-primary" />
                            ) : (
                              <RefreshCcw className="size-3.5" />
                            )}{" "}
                            {syncingId === request.id
                              ? t("file_library.contracts.workflow.documents.syncing")
                              : syncedId === request.id
                                ? t("file_library.contracts.workflow.common.updated")
                                : t("file_library.contracts.workflow.documents.sync")}
                          </Button>
                        ) : null}
                        {request.documenso_envelope_id ? (
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={loadingLinksFor === request.id}
                            onClick={() => void showSigningLinks(request.id)}
                          >
                            {loadingLinksFor === request.id ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              <Link2 className="size-3.5" />
                            )}{" "}
                            {t("file_library.contracts.workflow.documents.links")}
                          </Button>
                        ) : null}
                      </div>
                    </div>
                    {isExpanded ? (
                      <ContractProgressDetail
                        request={detail?.id === request.id ? detail : request}
                        isLoading={isDetailLoading && !detail}
                      />
                    ) : null}
                  </article>
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
      {authoringRequest ? (
        <ContractAuthoringModal
          workspaceSlug={workspaceSlug}
          signatureRequest={authoringRequest}
          onClose={() => setAuthoringRequest(undefined)}
          onSent={() => {
            setAuthoringRequest(undefined);
            void mutate();
          }}
        />
      ) : null}
      {signingLinks ? (
        <ContractSigningLinksDialog links={signingLinks} onClose={() => setSigningLinks(undefined)} />
      ) : null}
    </div>
  );
}

function ContractProgressDetail({ request, isLoading }: { request: TContractSignatureRequest; isLoading: boolean }) {
  const { t } = useTranslation();
  if (isLoading)
    return (
      <div className="grid min-h-28 place-items-center border-t border-subtle bg-layer-1">
        <Loader2 className="size-4 animate-spin text-tertiary" />
      </div>
    );
  const remoteRecipients = request.signing_details?.recipients ?? [];
  const participants =
    remoteRecipients.length > 0
      ? remoteRecipients
      : request.signers.map((signer) => ({
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
  return (
    <div className="border-t border-subtle bg-layer-1 p-4 sm:p-5">
      {request.signing_details?.error ? (
        <p className="mb-3 rounded-md bg-warning-primary/10 p-3 text-10 text-warning-primary">
          {t("file_library.contracts.workflow.documents.remote_error", { error: request.signing_details.error })}
        </p>
      ) : null}
      <div className="grid gap-3 lg:grid-cols-2">
        {participants.length === 0 ? (
          <p className="text-11 text-tertiary">{t("file_library.contracts.workflow.documents.no_participants")}</p>
        ) : (
          participants.map((recipient, index) => {
            const fields = (request.signing_details?.fields ?? []).filter(
              (field) => field.recipient_id === recipient.id
            );
            const completed = ["SIGNED", "APPROVED", "COMPLETED"].includes(recipient.signing_status);
            return (
              <div
                key={`${recipient.id ?? recipient.email}-${recipient.role}`}
                className="rounded-lg border border-subtle bg-surface-1 p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-11 font-semibold text-primary">
                      {recipient.name ||
                        t("file_library.contracts.workflow.documents.participant_number", { number: index + 1 })}
                    </p>
                    <p className="mt-0.5 truncate text-9 text-tertiary">{recipient.email}</p>
                  </div>
                  <span
                    className={cn(
                      "flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-9 font-medium",
                      completed ? "bg-success-primary/10 text-success-primary" : "bg-layer-2 text-secondary"
                    )}
                  >
                    {completed ? <CheckCircle2 className="size-3" /> : <Clock3 className="size-3" />}
                    {SIGNER_STATUS_LABEL_KEYS[recipient.signing_status]
                      ? t(SIGNER_STATUS_LABEL_KEYS[recipient.signing_status])
                      : recipient.signing_status}
                  </span>
                </div>
                <div className="mt-3 flex flex-wrap gap-2 text-9 text-tertiary">
                  <span>
                    {t(
                      recipient.send_status === "SENT"
                        ? "file_library.contracts.workflow.documents.email_sent"
                        : "file_library.contracts.workflow.signer_status.not_sent"
                    )}
                  </span>
                  <span>·</span>
                  <span>
                    {t(
                      recipient.read_status === "OPENED"
                        ? "file_library.contracts.workflow.documents.document_opened"
                        : "file_library.contracts.workflow.documents.not_opened"
                    )}
                  </span>
                  {recipient.signed_at ? (
                    <>
                      <span>·</span>
                      <span>
                        {t("file_library.contracts.workflow.documents.signed_at", {
                          date: new Date(recipient.signed_at).toLocaleString(),
                        })}
                      </span>
                    </>
                  ) : null}
                </div>
                {fields.length > 0 ? (
                  <div className="mt-3 overflow-hidden rounded-md border border-subtle">
                    <div className="bg-layer-1 px-3 py-2 text-9 font-semibold text-tertiary">
                      {t("file_library.contracts.workflow.documents.completed_fields")}
                    </div>
                    <dl className="divide-y divide-subtle">
                      {fields.map((field) => (
                        <div
                          key={`${field.id ?? `${recipient.id}-${field.type}-${field.page}-${field.label}`}`}
                          className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-3 px-3 py-2"
                        >
                          <dt className="truncate text-9 text-tertiary">{field.label || field.type}</dt>
                          <dd className={cn("text-10 break-words text-primary", !field.value && "text-tertiary")}>
                            {field.value || t("file_library.contracts.workflow.signer_status.pending")}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                ) : (
                  <p className="mt-3 text-9 text-tertiary">
                    {t("file_library.contracts.workflow.documents.no_field_values")}
                  </p>
                )}
              </div>
            );
          })
        )}
      </div>
      {request.signing_details?.synced_at ? (
        <p className="mt-3 text-right text-9 text-tertiary">
          {t("file_library.contracts.workflow.documents.last_sync", {
            date: new Date(request.signing_details.synced_at).toLocaleString(),
          })}
        </p>
      ) : null}
    </div>
  );
}
