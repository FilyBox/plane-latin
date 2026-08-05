/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * "Created contracts" — the tracking surface for signature requests.
 *
 * Rows follow Plane's list idiom: one primary action plus a quick-actions menu,
 * with the detail living in a peek panel rather than an inline accordion.
 */

import { useEffect, useMemo, useState } from "react";
import {
  Download,
  FileCheck2,
  Link2,
  Loader2,
  PenLine,
  RefreshCcw,
  Search,
  Send,
  Trash2,
} from "lucide-react";
import { useNavigate, useSearchParams } from "react-router";
import useSWR from "swr";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TContractSignatureRequest } from "@plane/types";
import { CustomMenu } from "@plane/ui";
import { cn } from "@plane/utils";
import { contractService } from "@/services/contract.service";
import { downloadAssets } from "../download";
import { ContractDeleteDialog } from "./contract-delete-dialog";
import { ContractRequestPeek } from "./contract-request-peek";
import {
  ContractBulkActionsBar,
  ContractSelectionCheckbox,
} from "./list-controls";
import { ContractEmptyState, ContractLoading, RequestStatusBadge } from "./ui";

type Props = { workspaceSlug: string };
type StatusFilter =
  | "ALL"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "DRAFTS"
  | "ATTENTION";

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

const FILTERS: {
  key: StatusFilter;
  labelKey: string;
  match: (r: TContractSignatureRequest) => boolean;
}[] = [
  {
    key: "ALL",
    labelKey: "file_library.contracts.workflow.documents.filter_all",
    match: () => true,
  },
  {
    key: "IN_PROGRESS",
    labelKey: "file_library.contracts.workflow.documents.filter_in_progress",
    match: (r) => r.status === "PENDING",
  },
  {
    key: "COMPLETED",
    labelKey: "file_library.contracts.workflow.documents.filter_completed",
    match: (r) => r.status === "COMPLETED",
  },
  {
    key: "DRAFTS",
    labelKey: "file_library.contracts.workflow.documents.filter_drafts",
    match: (r) =>
      r.status === "DRAFT" || r.status === "READY" || r.status === "PREPARING",
  },
  {
    key: "ATTENTION",
    labelKey: "file_library.contracts.workflow.documents.filter_attention",
    match: (r) => r.status === "ERROR" || r.status === "REJECTED",
  },
];

const isCompletedSignerStatus = (status: string) =>
  ["SIGNED", "APPROVED", "COMPLETED"].includes(status);

/** Compact "x minutes ago" without pulling in a date library. */
function useRelativeTime() {
  const { t } = useTranslation();
  return (iso: string) => {
    const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (minutes < 1)
      return t("file_library.contracts.workflow.documents.updated_just_now");
    if (minutes < 60)
      return t("file_library.contracts.workflow.documents.updated_minutes", {
        count: minutes,
      });
    const hours = Math.round(minutes / 60);
    if (hours < 24)
      return t("file_library.contracts.workflow.documents.updated_hours", {
        count: hours,
      });
    return new Date(iso).toLocaleDateString();
  };
}

export function ContractDocuments({ workspaceSlug }: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const relative = useRelativeTime();
  const [searchParams, setSearchParams] = useSearchParams();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<StatusFilter>("ALL");
  const [peekRequestId, setPeekRequestId] = useState<string>();
  const [syncingId, setSyncingId] = useState<string>();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [isBulkSyncing, setIsBulkSyncing] = useState(false);
  const [deletingRequests, setDeletingRequests] = useState<TContractSignatureRequest[]>([]);
  const [isDeleting, setIsDeleting] = useState(false);

  const {
    data: requests,
    mutate,
    isLoading,
  } = useSWR(
    `CONTRACT_SIGNATURE_REQUESTS_${workspaceSlug}`,
    () => contractService.getSignatureRequests(workspaceSlug),
    { refreshInterval: 15000, revalidateOnFocus: false },
  );

  // Deep link from the template detail and from a just-sent contract.
  useEffect(() => {
    const requestId = searchParams.get("request");
    if (!requestId) return;
    setPeekRequestId(requestId);
    setSearchParams({}, { replace: true });
  }, [searchParams, setSearchParams]);

  const openEditor = (request: TContractSignatureRequest) =>
    navigate(
      `/${workspaceSlug}/file-library/contracts/documents/${request.id}/editor`,
    );

  const ordered = useMemo(
    () =>
      [...(requests ?? [])].sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      ),
    [requests],
  );

  const counts = useMemo(
    () =>
      Object.fromEntries(
        FILTERS.map((item) => [item.key, ordered.filter(item.match).length]),
      ) as Record<StatusFilter, number>,
    [ordered],
  );

  const visible = useMemo(() => {
    const activeFilter = FILTERS.find((item) => item.key === filter)!;
    const term = search.trim().toLowerCase();
    return ordered.filter(
      (request) =>
        activeFilter.match(request) &&
        (!term ||
          request.title.toLowerCase().includes(term) ||
          request.signers.some(
            (signer) =>
              signer.name.toLowerCase().includes(term) ||
              signer.email.toLowerCase().includes(term),
          )),
    );
  }, [filter, ordered, search]);

  const sync = async (requestId: string) => {
    setSyncingId(requestId);
    try {
      await contractService.syncSignatureRequest(workspaceSlug, requestId);
      await mutate();
      setToast({
        type: TOAST_TYPE.SUCCESS,
        title: t("file_library.contracts.workflow.documents.sync_success"),
      });
    } catch (error: any) {
      setToast({
        type: TOAST_TYPE.ERROR,
        title:
          error?.error ??
          t("file_library.contracts.workflow.documents.sync_failed"),
      });
    } finally {
      setSyncingId(undefined);
    }
  };

  const toggleSelect = (requestId: string) =>
    setSelectedIds((current) =>
      current.includes(requestId)
        ? current.filter((id) => id !== requestId)
        : [...current, requestId],
    );
  const toggleSelectAll = () =>
    setSelectedIds((current) =>
      visible.length > 0 &&
      visible.every((request) => current.includes(request.id))
        ? current.filter((id) => !visible.some((request) => request.id === id))
        : [...new Set([...current, ...visible.map((request) => request.id)])],
    );

  const downloadRequests = async (items: TContractSignatureRequest[]) => {
    const targets = items
      .map((request) => {
        const assetId =
          request.status === "COMPLETED" && request.signed_asset_id
            ? request.signed_asset_id
            : request.rendered_pdf_asset_id || request.pdf_asset_id;
        if (!assetId) return null;
        return {
          assetId,
          name: `${request.title}${request.status === "COMPLETED" ? "-signed" : ""}.pdf`,
        };
      })
      .filter(
        (target): target is { assetId: string; name: string } =>
          target !== null,
      );
    if (targets.length === 0) return;
    try {
      await downloadAssets(
        workspaceSlug,
        targets,
        "contratos-creados",
        "contract",
      );
    } catch {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: t("file_library.download_failed"),
      });
    }
  };

  const syncSelected = async () => {
    const syncable = ordered.filter(
      (request) =>
        selectedIds.includes(request.id) &&
        Boolean(request.documenso_envelope_id),
    );
    if (syncable.length === 0) return;
    setIsBulkSyncing(true);
    try {
      await Promise.all(
        syncable.map((request) =>
          contractService.syncSignatureRequest(workspaceSlug, request.id),
        ),
      );
      await mutate();
      setSelectedIds([]);
      setToast({
        type: TOAST_TYPE.SUCCESS,
        title: t(
          "file_library.contracts.workflow.documents.bulk_sync_success",
          { count: syncable.length },
        ),
      });
    } catch {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: t("file_library.contracts.workflow.documents.sync_failed"),
      });
    } finally {
      setIsBulkSyncing(false);
    }
  };

  const deleteRequests = async (options: { deleteFiles: boolean; deleteAnalysis: boolean }) => {
    if (deletingRequests.length === 0) return;
    setIsDeleting(true);
    const requestIds = deletingRequests.map((request) => request.id);
    try {
      const result = await contractService.deleteSignatureRequests(workspaceSlug, requestIds, options);
      setDeletingRequests([]);
      setSelectedIds((current) => current.filter((id) => !result.deleted.includes(id)));
      if (peekRequestId && result.deleted.includes(peekRequestId)) setPeekRequestId(undefined);
      await mutate();
      setToast({
        type: TOAST_TYPE.SUCCESS,
        title: t("file_library.contracts.workflow.documents.delete_success", { count: result.deleted.length }),
      });
    } catch (error: any) {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: error?.error ?? t("file_library.contracts.workflow.documents.delete_failed"),
      });
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden">
      {/* filters replace the old KPI card row — same numbers, but actionable */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-subtle px-3 py-2.5 sm:px-4">
        <div className="flex min-w-0 items-center gap-2">
          <div className="relative">
            <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-tertiary" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t(
                "file_library.contracts.workflow.documents.search_placeholder",
              )}
              className="w-36 rounded-md border border-subtle bg-transparent py-1.5 pr-2 pl-8 text-12 sm:w-64"
            />
          </div>
          <select
            value={filter}
            onChange={(event) => setFilter(event.target.value as StatusFilter)}
            className="rounded-md border border-subtle bg-surface-1 px-2.5 py-1.5 text-12 text-secondary outline-none focus:border-accent-strong"
          >
            {FILTERS.map((item) => (
              <option key={item.key} value={item.key}>
                {t(item.labelKey)} ({counts[item.key]})
              </option>
            ))}
          </select>
          <Button
            variant="secondary"
            size="sm"
            disabled={ordered.length === 0}
            title={t("file_library.download_all_hint")}
            onClick={() => void downloadRequests(ordered)}
          >
            <Download className="size-3.5" />
            <span className="hidden lg:inline">
              {t("file_library.download_all")}
            </span>
          </Button>
        </div>

        <span className="text-11 text-tertiary">
          {t("file_library.contracts.workflow.documents.result_count", {
            count: visible.length,
          })}
        </span>
      </div>

      <ContractBulkActionsBar
        count={selectedIds.length}
        onClear={() => setSelectedIds([])}
      >
        <Button
          variant="secondary"
          size="sm"
          onClick={() =>
            void downloadRequests(
              ordered.filter((request) => selectedIds.includes(request.id)),
            )
          }
        >
          <Download className="size-3.5" />
          {t("file_library.download_selected")}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={
            isBulkSyncing ||
            !ordered.some(
              (request) =>
                selectedIds.includes(request.id) &&
                request.documenso_envelope_id,
            )
          }
          onClick={() => void syncSelected()}
        >
          {isBulkSyncing ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RefreshCcw className="size-3.5" />
          )}
          {t("file_library.contracts.workflow.documents.sync_selected")}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() =>
            setDeletingRequests(ordered.filter((request) => selectedIds.includes(request.id)))
          }
        >
          <Trash2 className="size-3.5 text-danger-primary" />
          {t("file_library.contracts.workflow.documents.delete_selected")}
        </Button>
      </ContractBulkActionsBar>

      <div className="min-h-0 flex-1 overflow-hidden">
        {isLoading && !requests ? (
          <ContractLoading className="h-full" />
        ) : visible.length === 0 ? (
          <ContractEmptyState
            className="h-full"
            icon={<Send className="size-5" />}
            title={t(
              ordered.length === 0
                ? "file_library.contracts.workflow.documents.empty_title"
                : "file_library.contracts.workflow.documents.no_matches_title",
            )}
            description={t(
              ordered.length === 0
                ? "file_library.contracts.workflow.documents.empty_description"
                : "file_library.contracts.workflow.documents.no_matches_description",
            )}
          />
        ) : (
          <div className="h-full min-w-0 overflow-x-hidden overflow-y-auto">
            <div className="sticky top-0 z-[2] hidden grid-cols-[40px_minmax(0,1.6fr)_minmax(0,0.7fr)_minmax(0,1fr)_minmax(0,0.8fr)_44px] items-center border-b border-subtle bg-surface-1 text-11 font-medium text-tertiary md:grid">
              <span className="px-4 py-2">
                <ContractSelectionCheckbox
                  checked={visible.every((request) =>
                    selectedIds.includes(request.id),
                  )}
                  onChange={toggleSelectAll}
                />
              </span>
              <span className="px-2 py-2">
                {t("file_library.contracts.workflow.common.contract")}
              </span>
              <span className="px-3 py-2">
                {t("file_library.contracts.workflow.documents.status")}
              </span>
              <span className="px-3 py-2">
                {t(
                  "file_library.contracts.workflow.documents.signing_progress",
                )}
              </span>
              <span className="px-3 py-2">
                {t("file_library.contracts.workflow.documents.activity")}
              </span>
              <span className="sr-only">
                {t("file_library.contracts.workflow.common.actions")}
              </span>
            </div>
            <ul className="min-w-0 divide-y divide-subtle">
              {visible.map((request) => {
                const remoteSigners = request.signing_details?.recipients ?? [];
                const signerCount =
                  remoteSigners.length ||
                  request.signers.length ||
                  request.recipients.filter(
                    (recipient) => recipient.role === "SIGNER",
                  ).length;
                const signedCount = remoteSigners.length
                  ? remoteSigners.filter((signer) =>
                      isCompletedSignerStatus(signer.signing_status),
                    ).length
                  : request.signers.filter((signer) =>
                      isCompletedSignerStatus(signer.status),
                    ).length;
                const needsAuthoring =
                  request.status === "READY" || request.status === "DRAFT";
                return (
                  <li
                    key={request.id}
                    className={cn(
                      "relative flex min-w-0 items-center gap-3 px-4 py-3 hover:bg-layer-1-hover md:grid md:grid-cols-[40px_minmax(0,1.6fr)_minmax(0,0.7fr)_minmax(0,1fr)_minmax(0,0.8fr)_44px] md:gap-0 md:px-0 md:py-0",
                      peekRequestId === request.id && "bg-layer-1",
                    )}
                  >
                    {/* Full-row click target as a real button, so the quick-actions
                        menu below is not nested inside another button. */}
                    <button
                      type="button"
                      aria-label={request.title}
                      onClick={() => setPeekRequestId(request.id)}
                      className="absolute inset-0 z-0 cursor-pointer"
                    />

                    <span className="z-1 md:px-4 md:py-2.5">
                      <ContractSelectionCheckbox
                        checked={selectedIds.includes(request.id)}
                        onChange={() => toggleSelect(request.id)}
                      />
                    </span>

                    <span className="pointer-events-none z-1 grid size-8 shrink-0 place-items-center rounded-md bg-layer-2 text-accent-primary md:hidden">
                      <FileCheck2 className="size-4" />
                    </span>

                    <div className="pointer-events-none z-1 flex min-w-0 flex-1 items-center gap-2 md:px-2 md:py-2.5">
                      <FileCheck2 className="hidden size-4 shrink-0 text-accent-primary md:block" />
                      <div className="min-w-0">
                        <p className="truncate text-13 font-medium text-primary">
                          {request.title}
                        </p>
                        <p className="mt-0.5 truncate text-11 text-tertiary">
                          {t(
                            "file_library.contracts.workflow.common.version_number",
                            {
                              number: request.revision.revision,
                            },
                          )}{" "}
                          · {relative(request.updated_at)}
                        </p>
                      </div>
                    </div>

                    <div className="pointer-events-none z-1 flex shrink-0 flex-col items-end gap-1 md:hidden">
                      <RequestStatusBadge
                        status={request.status}
                        label={t(STATUS_LABEL_KEYS[request.status])}
                      />
                      <span className="text-10 text-tertiary">
                        {t(
                          "file_library.contracts.workflow.documents.signers_completed",
                          {
                            completed: signedCount,
                            total: signerCount,
                          },
                        )}
                      </span>
                    </div>

                    <div className="pointer-events-none z-1 hidden min-w-0 overflow-hidden px-3 py-2.5 md:block">
                      <RequestStatusBadge
                        status={request.status}
                        label={t(STATUS_LABEL_KEYS[request.status])}
                      />
                    </div>

                    <div className="pointer-events-none z-1 hidden min-w-0 overflow-hidden px-3 py-2.5 md:block">
                      <SignerProgress
                        signed={signedCount}
                        total={signerCount}
                      />
                    </div>

                    <div className="pointer-events-none z-1 hidden min-w-0 overflow-hidden px-3 py-2.5 text-11 text-tertiary md:block">
                      <p className="truncate">
                        {request.completed_at
                          ? new Date(request.completed_at).toLocaleString()
                          : request.sent_at
                            ? new Date(request.sent_at).toLocaleString()
                            : relative(request.updated_at)}
                      </p>
                    </div>

                    <div className="z-1 shrink-0 md:px-2 md:py-2.5 md:text-right">
                      <CustomMenu
                        ellipsis
                        className=""
                        menuItemsClassName="bg-background!"
                        placement="bottom-end"
                        ariaLabel={t(
                          "file_library.contracts.workflow.common.actions",
                        )}
                      >
                        {needsAuthoring ? (
                          <CustomMenu.MenuItem
                            onClick={() => openEditor(request)}
                          >
                            <span className="flex items-center gap-2">
                              <PenLine className="size-3.5" />
                              {t(
                                "file_library.contracts.workflow.documents.review_send",
                              )}
                            </span>
                          </CustomMenu.MenuItem>
                        ) : null}
                        <CustomMenu.MenuItem
                          onClick={() => setPeekRequestId(request.id)}
                        >
                          <span className="flex items-center gap-2">
                            <Link2 className="size-3.5" />
                            {t(
                              "file_library.contracts.workflow.documents.open_detail",
                            )}
                          </span>
                        </CustomMenu.MenuItem>
                        {request.documenso_envelope_id ? (
                          <CustomMenu.MenuItem
                            onClick={() => void sync(request.id)}
                          >
                            <span className="flex items-center gap-2">
                              <RefreshCcw
                                className={cn(
                                  "size-3.5",
                                  syncingId === request.id && "animate-spin",
                                )}
                              />
                              {t(
                                "file_library.contracts.workflow.documents.sync",
                              )}
                            </span>
                          </CustomMenu.MenuItem>
                        ) : null}
                        <CustomMenu.MenuItem
                          onClick={() => void downloadRequests([request])}
                        >
                          <span className="flex items-center gap-2">
                            <Download className="size-3.5" />
                            {t("file_library.download")}
                          </span>
                        </CustomMenu.MenuItem>
                        <CustomMenu.MenuItem onClick={() => setDeletingRequests([request])}>
                          <span className="flex items-center gap-2 text-danger-primary">
                            <Trash2 className="size-3.5" />
                            {t("file_library.contracts.workflow.documents.delete")}
                          </span>
                        </CustomMenu.MenuItem>
                      </CustomMenu>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>

      {peekRequestId ? (
        <ContractRequestPeek
          workspaceSlug={workspaceSlug}
          requestId={peekRequestId}
          onClose={() => setPeekRequestId(undefined)}
          onMutate={() => void mutate()}
          onOpenEditor={(request) => {
            setPeekRequestId(undefined);
            openEditor(request);
          }}
        />
      ) : null}
      <ContractDeleteDialog
        key={deletingRequests.map((request) => request.id).join(":") || "closed"}
        requests={deletingRequests}
        isSubmitting={isDeleting}
        onClose={() => setDeletingRequests([])}
        onConfirm={deleteRequests}
      />
    </div>
  );
}

/** Segmented bar + count, so signing progress reads at a glance from the row. */
function SignerProgress({ signed, total }: { signed: number; total: number }) {
  const { t } = useTranslation();
  if (total === 0) return null;
  const complete = signed === total;
  return (
    <div className="hidden shrink-0 items-center gap-2 sm:flex">
      <div className="flex gap-0.5" aria-hidden>
        {Array.from({ length: Math.min(total, 6) }, (_, index) => (
          <span
            key={index}
            className={cn(
              "h-1.5 w-4 rounded-full",
              index < signed ? "bg-success-primary" : "bg-layer-3",
            )}
          />
        ))}
      </div>
      <span
        className={cn(
          "text-11 tabular-nums",
          complete ? "text-success-primary" : "text-tertiary",
        )}
      >
        {t("file_library.contracts.workflow.documents.signers_completed", {
          completed: signed,
          total,
        })}
      </span>
    </div>
  );
}
