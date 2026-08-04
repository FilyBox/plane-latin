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
import { FileCheck2, Link2, PenLine, RefreshCcw, Search, Send } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router";
import useSWR from "swr";
import { useTranslation } from "@plane/i18n";
import { Input } from "@plane/propel/input";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TContractSignatureRequest } from "@plane/types";
import { CustomMenu } from "@plane/ui";
import { cn } from "@plane/utils";
import { contractService } from "@/services/contract.service";
import { ContractRequestPeek } from "./contract-request-peek";
import { ContractEmptyState, ContractLoading, ContractPageHeader, RequestStatusBadge } from "./ui";

type Props = { workspaceSlug: string };
type StatusFilter = "ALL" | "IN_PROGRESS" | "COMPLETED" | "DRAFTS" | "ATTENTION";

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

const FILTERS: { key: StatusFilter; labelKey: string; match: (r: TContractSignatureRequest) => boolean }[] = [
  { key: "ALL", labelKey: "file_library.contracts.workflow.documents.filter_all", match: () => true },
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
    match: (r) => r.status === "DRAFT" || r.status === "READY" || r.status === "PREPARING",
  },
  {
    key: "ATTENTION",
    labelKey: "file_library.contracts.workflow.documents.filter_attention",
    match: (r) => r.status === "ERROR" || r.status === "REJECTED",
  },
];

/** Compact "x minutes ago" without pulling in a date library. */
function useRelativeTime() {
  const { t } = useTranslation();
  return (iso: string) => {
    const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (minutes < 1) return t("file_library.contracts.workflow.documents.updated_just_now");
    if (minutes < 60) return t("file_library.contracts.workflow.documents.updated_minutes", { count: minutes });
    const hours = Math.round(minutes / 60);
    if (hours < 24) return t("file_library.contracts.workflow.documents.updated_hours", { count: hours });
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

  const {
    data: requests,
    mutate,
    isLoading,
  } = useSWR(
    `CONTRACT_SIGNATURE_REQUESTS_${workspaceSlug}`,
    () => contractService.getSignatureRequests(workspaceSlug),
    { refreshInterval: 15000, revalidateOnFocus: false }
  );

  // Deep link from the template detail and from a just-sent contract.
  useEffect(() => {
    const requestId = searchParams.get("request");
    if (!requestId) return;
    setPeekRequestId(requestId);
    setSearchParams({}, { replace: true });
  }, [searchParams, setSearchParams]);

  const openEditor = (request: TContractSignatureRequest) =>
    navigate(`/${workspaceSlug}/file-library/contracts/documents/${request.id}/editor`);

  const ordered = useMemo(
    () => [...(requests ?? [])].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()),
    [requests]
  );

  const counts = useMemo(
    () =>
      Object.fromEntries(FILTERS.map((item) => [item.key, ordered.filter(item.match).length])) as Record<
        StatusFilter,
        number
      >,
    [ordered]
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
            (signer) => signer.name.toLowerCase().includes(term) || signer.email.toLowerCase().includes(term)
          ))
    );
  }, [filter, ordered, search]);

  const sync = async (requestId: string) => {
    setSyncingId(requestId);
    try {
      await contractService.syncSignatureRequest(workspaceSlug, requestId);
      await mutate();
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

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl space-y-5 px-4 py-6 sm:px-6 lg:px-8">
        <ContractPageHeader
          title={t("file_library.contracts.workflow.documents.title")}
          description={t("file_library.contracts.workflow.documents.description")}
        />

        {/* filters replace the old KPI card row — same numbers, but actionable */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative mr-auto">
            <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-tertiary" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("file_library.contracts.workflow.documents.search_placeholder")}
              className="w-56 pl-8"
            />
          </div>
          {FILTERS.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setFilter(item.key)}
              className={cn(
                "flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-13 font-medium transition-colors",
                filter === item.key
                  ? "border-accent-strong bg-accent-subtle-hover text-accent-primary"
                  : "border-subtle text-secondary hover:bg-layer-1-hover"
              )}
            >
              {t(item.labelKey)}
              <span
                className={cn(
                  "rounded px-1 text-11",
                  filter === item.key ? "bg-surface-1 text-accent-primary" : "bg-layer-2 text-tertiary"
                )}
              >
                {counts[item.key]}
              </span>
            </button>
          ))}
        </div>

        <div className="overflow-hidden rounded-lg border border-subtle bg-layer-1">
          {isLoading && !requests ? (
            <ContractLoading />
          ) : visible.length === 0 ? (
            <ContractEmptyState
              icon={<Send className="size-5" />}
              title={t(
                ordered.length === 0
                  ? "file_library.contracts.workflow.documents.empty_title"
                  : "file_library.contracts.workflow.documents.no_matches_title"
              )}
              description={t(
                ordered.length === 0
                  ? "file_library.contracts.workflow.documents.empty_description"
                  : "file_library.contracts.workflow.documents.no_matches_description"
              )}
            />
          ) : (
            <ul className="divide-y divide-subtle">
              {visible.map((request) => {
                const signerCount =
                  request.signers.length ||
                  request.recipients.filter((recipient) => recipient.role === "SIGNER").length;
                const signedCount = request.signers.filter((signer) => signer.status === "SIGNED").length;
                const needsAuthoring = request.status === "READY" || request.status === "DRAFT";
                return (
                  <li key={request.id} className="relative flex items-center gap-3 px-4 py-3 hover:bg-layer-1-hover">
                    {/* Full-row click target as a real button, so the quick-actions
                        menu below is not nested inside another button. */}
                    <button
                      type="button"
                      aria-label={request.title}
                      onClick={() => setPeekRequestId(request.id)}
                      className="absolute inset-0 z-0 cursor-pointer"
                    />

                    <span className="pointer-events-none z-1 grid size-8 shrink-0 place-items-center rounded-md bg-layer-2 text-accent-primary">
                      <FileCheck2 className="size-4" />
                    </span>

                    <div className="pointer-events-none z-1 min-w-0 flex-1">
                      <p className="truncate text-13 font-medium text-primary">{request.title}</p>
                      <p className="mt-0.5 truncate text-11 text-tertiary">
                        {t("file_library.contracts.workflow.common.version_number", {
                          number: request.revision.revision,
                        })}{" "}
                        · {relative(request.updated_at)}
                      </p>
                    </div>

                    <div className="pointer-events-none z-1 flex shrink-0 items-center gap-3">
                      <SignerProgress signed={signedCount} total={signerCount} />
                      <RequestStatusBadge status={request.status} label={t(STATUS_LABEL_KEYS[request.status])} />
                    </div>

                    <div className="z-1 shrink-0">
                      <CustomMenu
                        ellipsis
                        placement="bottom-end"
                        ariaLabel={t("file_library.contracts.workflow.common.actions")}
                      >
                        {needsAuthoring ? (
                          <CustomMenu.MenuItem onClick={() => openEditor(request)}>
                            <span className="flex items-center gap-2">
                              <PenLine className="size-3.5" />
                              {t("file_library.contracts.workflow.documents.review_send")}
                            </span>
                          </CustomMenu.MenuItem>
                        ) : null}
                        <CustomMenu.MenuItem onClick={() => setPeekRequestId(request.id)}>
                          <span className="flex items-center gap-2">
                            <Link2 className="size-3.5" />
                            {t("file_library.contracts.workflow.documents.open_detail")}
                          </span>
                        </CustomMenu.MenuItem>
                        {request.documenso_envelope_id ? (
                          <CustomMenu.MenuItem onClick={() => void sync(request.id)}>
                            <span className="flex items-center gap-2">
                              <RefreshCcw className={cn("size-3.5", syncingId === request.id && "animate-spin")} />
                              {t("file_library.contracts.workflow.documents.sync")}
                            </span>
                          </CustomMenu.MenuItem>
                        ) : null}
                      </CustomMenu>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
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
            className={cn("h-1.5 w-4 rounded-full", index < signed ? "bg-success-primary" : "bg-layer-3")}
          />
        ))}
      </div>
      <span className={cn("text-11 tabular-nums", complete ? "text-success-primary" : "text-tertiary")}>
        {t("file_library.contracts.workflow.documents.signers_completed", { completed: signed, total })}
      </span>
    </div>
  );
}
