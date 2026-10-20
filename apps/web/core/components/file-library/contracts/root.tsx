/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDropzone } from "react-dropzone";
import {
  ArrowUpDown,
  BookOpen,
  ChevronDown,
  Download,
  FolderInput,
  Layers,
  Loader2,
  MessageSquare,
  Plus,
  RefreshCcw,
  Search,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useSearchParams } from "react-router";
import useSWR from "swr";
// plane imports
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TContract, TContractFilters, TContractJob, TContractRetryOptions, TContractView } from "@plane/types";
import { AlertModalCore, CustomMenu } from "@plane/ui";
// services
import { contractService } from "@/services/contract.service";
import { fileLibraryService } from "@/services/file-library.service";
// local imports
import { BulkActionsModal } from "../bulk-actions-modal";
import { downloadAssets } from "../download";
// local imports
import { ContractChatModal } from "./chat/chat-modal";
import { AppliedContractFilters, ContractFiltersDropdown } from "./filters";
import { ContractBulkActionsBar } from "./list-controls";
import { ContractPeekPanel } from "./peek-panel";
import { ContractQueryModal } from "./query-modal";
import { RetryOptionsModal } from "./retry-options-modal";
import { ContractsTable } from "./table";

type Props = {
  workspaceSlug: string;
  /** One of the sidebar subsets; the full analyzed list when absent. */
  view?: TContractView;
};

export function ContractsRoot(props: Props) {
  const { workspaceSlug, view } = props;
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  // states
  const [filters, setFiltersState] = useState<TContractFilters>({ order: "-created_at" });
  const [searchInput, setSearchInput] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [isQueryModalOpen, setIsQueryModalOpen] = useState(false);
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [chatInitialQuery, setChatInitialQuery] = useState<string | undefined>(undefined);
  const [isBulkActing, setIsBulkActing] = useState(false);
  const [isBulkRetryModalOpen, setIsBulkRetryModalOpen] = useState(false);
  const [isBulkActionsModalOpen, setIsBulkActionsModalOpen] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isBulkDeleteOpen, setIsBulkDeleteOpen] = useState(false);

  const setFilters = (next: Partial<TContractFilters>) => setFiltersState((prev) => ({ ...prev, ...next }));

  /** Which contract the peek is showing. It lives in the URL rather than in
   * component state so the address bar always names what is on screen: the link
   * can be copied, bookmarked, or sent to someone else and it reopens the same
   * contract. Back and forward move through it too. */
  const selectedContractId = searchParams.get("peek");

  const setSelectedContractId = useCallback(
    (contractId: string | null) =>
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (contractId) next.set("peek", contractId);
          else next.delete("peek");
          return next;
        },
        // Opening a contract is a navigation, so Back closes it. Closing
        // replaces, so Back does not immediately reopen what was just shut.
        { replace: !contractId }
      ),
    [setSearchParams]
  );

  // ?chat=<query> (Power K AI search) seeds the first message once and is then
  // consumed — unlike ?peek, it is an instruction, not a view to return to.
  useEffect(() => {
    const chatQuery = searchParams.get("chat");
    if (chatQuery === null) return;
    setChatInitialQuery(chatQuery || undefined);
    setIsChatOpen(true);
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete("chat");
        return next;
      },
      { replace: true }
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // debounce search → server-side filter
  useEffect(() => {
    const handle = setTimeout(() => setFilters({ search: searchInput.trim() || undefined }), 350);
    return () => clearTimeout(handle);
  }, [searchInput]);

  // contracts, refetched from the database on every filter change
  const filtersKey = JSON.stringify(filters);
  const {
    data: contracts,
    mutate: mutateContracts,
    isLoading,
  } = useSWR<TContract[]>(
    `CONTRACTS_${workspaceSlug}_${view ?? "all"}_${filtersKey}`,
    () => contractService.getContracts(workspaceSlug, filters, view),
    { revalidateOnFocus: false }
  );

  // live pipeline monitoring: poll active jobs, refresh the table when a run ends
  const { data: activeJobs } = useSWR<TContractJob[]>(
    `CONTRACT_ACTIVE_JOBS_${workspaceSlug}`,
    () => contractService.getJobs(workspaceSlug, { active: true }),
    { refreshInterval: (latest) => ((latest?.length ?? 0) > 0 ? 2000 : 15000) }
  );
  const activeJobsByContract = useMemo(() => {
    const map: Record<string, TContractJob> = {};
    (activeJobs ?? []).forEach((job) => {
      if (job.contract_id && !map[job.contract_id]) map[job.contract_id] = job;
    });
    return map;
  }, [activeJobs]);

  const previousActiveCount = useRef(0);
  useEffect(() => {
    const count = activeJobs?.length ?? 0;
    if (previousActiveCount.current > 0 && count < previousActiveCount.current) void mutateContracts();
    previousActiveCount.current = count;
  }, [activeJobs?.length, mutateContracts]);

  // bulk actions
  const toggleSelect = (contractId: string) =>
    setSelectedIds((previous) =>
      previous.includes(contractId) ? previous.filter((id) => id !== contractId) : [...previous, contractId]
    );
  const toggleSelectAll = () =>
    setSelectedIds((previous) =>
      previous.length === (contracts ?? []).length ? [] : (contracts ?? []).map((c) => c.id)
    );

  // The Files bulk-actions modal (move/categories/tags/delete) operates on
  // file_asset ids, not contract ids — map the selection across
  const selectedFileAssetIds = (contracts ?? [])
    .filter((contract) => selectedIds.includes(contract.id))
    .map((contract) => contract.file_asset_id)
    .filter((id): id is string => !!id);

  // Downloads the contracts' backing documents: one file directly, several
  // bundled into a ZIP. Callers pass the filtered list or the selection.
  const downloadContractFiles = async (contractsToDownload: TContract[]) => {
    const targets = contractsToDownload
      .filter((contract): contract is TContract & { file_asset_id: string } => !!contract.file_asset_id)
      .map((contract) => ({
        assetId: contract.file_asset_id,
        name: contract.file_name ?? `${contract.titulo ?? contract.id}.pdf`,
      }));
    if (targets.length === 0) return;
    // A single file has no downloads-panel entry (it's a direct browser
    // download), so it still gets its own toast; 2+ files are tracked by the
    // panel already — a second "starting" toast would just duplicate it.
    if (targets.length === 1) {
      setToast({ type: TOAST_TYPE.SUCCESS, title: t("file_library.download_started", { count: 1 }) });
    }
    try {
      await downloadAssets(workspaceSlug, targets, "contratos");
    } catch {
      setToast({ type: TOAST_TYPE.ERROR, title: t("file_library.download_failed") });
    }
  };

  // Dropping a PDF here uploads it and links it to the protected "Contratos"
  // category, which is what makes the API create the Contract row and dispatch
  // the extraction + AI pipeline. Uploading without the link would leave an
  // orphan file that never gets analyzed.
  const uploadContracts = useCallback(
    async (files: File[]) => {
      const pdfs = files.filter((file) => file.type === "application/pdf");
      if (pdfs.length === 0) {
        setToast({ type: TOAST_TYPE.ERROR, title: t("file_library.contracts.upload.only_pdf") });
        return;
      }
      setIsUploading(true);
      let uploaded = 0;
      try {
        const categories = await fileLibraryService.getCategories(workspaceSlug);
        const contractsCategory = categories.find((category) => category.is_default);
        if (!contractsCategory) {
          setToast({ type: TOAST_TYPE.ERROR, title: t("file_library.contracts.upload.no_category") });
          return;
        }
        await Promise.all(
          pdfs.map(async (file) => {
            const response = await fileLibraryService.uploadFile(workspaceSlug, file);
            await fileLibraryService.addFileCategories(workspaceSlug, response.asset_id, [contractsCategory.id]);
            uploaded += 1;
          })
        );
        setToast({
          type: TOAST_TYPE.SUCCESS,
          title: t("file_library.contracts.upload.started", { count: uploaded }),
        });
      } catch (error: any) {
        setToast({
          type: TOAST_TYPE.ERROR,
          title: error?.error ?? t("file_library.contracts.upload.failed"),
        });
      } finally {
        setIsUploading(false);
        void mutateContracts();
      }
    },
    [mutateContracts, t, workspaceSlug]
  );

  const {
    getRootProps,
    getInputProps,
    isDragActive,
    open: openFilePicker,
  } = useDropzone({
    onDrop: (accepted) => void uploadContracts(accepted),
    accept: { "application/pdf": [".pdf"] },
    noClick: true,
    noKeyboard: true,
  });

  const handleBulk = async (action: "retry" | "reanalyze", retryOptions?: TContractRetryOptions) => {
    if (selectedIds.length === 0 || isBulkActing) return;
    setIsBulkActing(true);
    try {
      const { dispatched, skipped } = await contractService.bulkAction(
        workspaceSlug,
        action,
        selectedIds,
        retryOptions
      );
      setSelectedIds([]);
      void mutateContracts();
      setToast({
        type: TOAST_TYPE.SUCCESS,
        title: t("file_library.contracts.bulk.dispatched", {
          count: dispatched?.length ?? 0,
          skipped: skipped?.length ?? 0,
        }),
      });
    } catch {
      setToast({ type: TOAST_TYPE.ERROR, title: t("file_library.contracts.bulk.failed") });
    } finally {
      setIsBulkActing(false);
    }
  };

  /** Files the selection under Editoriales, or takes it out — back into
   * Vigentes or Vencidos, whichever its dates say. */
  const handleBulkMove = async (esEditorial: boolean) => {
    if (selectedIds.length === 0 || isBulkActing) return;
    setIsBulkActing(true);
    try {
      const { updated } = await contractService.bulkAction(
        workspaceSlug,
        "editorial",
        selectedIds,
        undefined,
        esEditorial
      );
      setSelectedIds([]);
      void mutateContracts();
      setToast({
        type: TOAST_TYPE.SUCCESS,
        title: t("file_library.contracts.move.success", { count: updated?.length ?? 0 }),
      });
    } catch {
      setToast({ type: TOAST_TYPE.ERROR, title: t("file_library.contracts.move.failed") });
    } finally {
      setIsBulkActing(false);
    }
  };

  const handleBulkDelete = async () => {
    if (selectedIds.length === 0 || isBulkActing) return;
    setIsBulkActing(true);
    try {
      const { deleted } = await contractService.bulkAction(workspaceSlug, "delete", selectedIds);
      const deletedIds = deleted ?? [];
      // The peek would be left pointing at a contract that no longer exists.
      if (selectedContractId && deletedIds.includes(selectedContractId)) setSelectedContractId(null);
      setSelectedIds([]);
      setIsBulkDeleteOpen(false);
      void mutateContracts();
      setToast({
        type: TOAST_TYPE.SUCCESS,
        title: t("file_library.contracts.delete.success", { count: deletedIds.length }),
      });
    } catch {
      setToast({ type: TOAST_TYPE.ERROR, title: t("file_library.contracts.delete.failed") });
    } finally {
      setIsBulkActing(false);
    }
  };

  return (
    <div {...getRootProps()} className="relative flex h-full w-full flex-col overflow-hidden">
      <input {...getInputProps()} />
      {isDragActive ? (
        <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center bg-canvas/80">
          <div className="rounded-lg border border-dashed border-accent-strong bg-surface-1 px-6 py-5 text-center">
            <p className="text-13 font-medium text-primary">{t("file_library.contracts.upload.drop_title")}</p>
            <p className="mt-1 text-11 text-tertiary">{t("file_library.contracts.upload.drop_description")}</p>
          </div>
        </div>
      ) : null}
      <>
        {/* toolbar */}
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-subtle px-3 py-2.5 sm:px-4">
          <div className="flex min-w-0 items-center gap-2">
            <div className="relative">
              <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-tertiary" />
              <input
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder={t("file_library.contracts.search_placeholder")}
                className="w-36 rounded-md border border-subtle bg-transparent py-1.5 pr-2 pl-8 text-12 sm:w-64"
              />
            </div>
            <ContractFiltersDropdown workspaceSlug={workspaceSlug} filters={filters} onChange={setFilters} />
            <label className="relative flex items-center">
              <ArrowUpDown className="pointer-events-none absolute left-2 size-3.5 text-tertiary" />
              <select
                aria-label={t("file_library.order.label")}
                value={filters.order ?? "-created_at"}
                onChange={(event) => setFilters({ order: event.target.value as TContractFilters["order"] })}
                className="h-8 rounded-sm border border-subtle bg-surface-1 pr-7 pl-7 text-12 text-secondary hover:bg-layer-1-hover"
              >
                <option value="-created_at">{t("file_library.order.newest")}</option>
                <option value="-updated_at">{t("file_library.order.modified")}</option>
                <option value="titulo">{t("file_library.order.name_asc")}</option>
                <option value="-titulo">{t("file_library.order.name_desc")}</option>
                <option value="-fecha_inicio">{t("file_library.contracts.order.start_newest")}</option>
                <option value="fecha_inicio">{t("file_library.contracts.order.start_oldest")}</option>
                <option value="fecha_fin">{t("file_library.contracts.order.end_soonest")}</option>
                <option value="-fecha_fin">{t("file_library.contracts.order.end_latest")}</option>
              </select>
            </label>
            {/* contextual download: every contract matching the current filters */}
            <button
              type="button"
              onClick={() => void downloadContractFiles(contracts ?? [])}
              disabled={(contracts ?? []).length === 0}
              title={t("file_library.download_all_hint")}
              className="flex items-center gap-1 rounded-sm border border-subtle px-2 py-1.5 text-12 hover:bg-layer-1-hover disabled:opacity-50"
            >
              <Download className="size-3.5" />
              <span className="hidden lg:inline">{t("file_library.download_all")}</span>
            </button>
          </div>
          <div className="flex items-center gap-2">
            {(activeJobs?.length ?? 0) > 0 && (
              <span className="flex items-center gap-1.5 rounded-full bg-accent-primary/10 px-2.5 py-1 text-11 font-medium text-accent-primary">
                <Loader2 className="size-3 animate-spin" />
                <span className="hidden sm:inline">
                  {t("file_library.contracts.active_jobs", { count: activeJobs?.length ?? 0 })}
                </span>
                <span className="sm:hidden">{activeJobs?.length ?? 0}</span>
              </span>
            )}
            <Button variant="secondary" size="sm" disabled={isUploading} onClick={openFilePicker}>
              {isUploading ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
              <span className="hidden sm:inline">{t("file_library.contracts.upload.button")}</span>
            </Button>
            <Button variant="primary" size="sm" onClick={() => setIsChatOpen(true)}>
              <MessageSquare className="size-3.5" />
              <span className="hidden sm:inline">{t("file_library.contracts.chat.button")}</span>
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setIsQueryModalOpen(true)}>
              <Sparkles className="size-3.5" />
              <span className="hidden sm:inline">{t("file_library.contracts.query.button")}</span>
            </Button>
          </div>
        </div>

        {/* applied filter pills */}
        <AppliedContractFilters
          workspaceSlug={workspaceSlug}
          filters={filters}
          onChange={setFilters}
          onClearAll={() => setFiltersState({ order: "-created_at" })}
        />

        {/* bulk actions bar */}
        <ContractBulkActionsBar count={selectedIds.length} onClear={() => setSelectedIds([])}>
          <Button variant="secondary" size="sm" onClick={() => setIsBulkRetryModalOpen(true)} disabled={isBulkActing}>
            <RefreshCcw className="size-3.5" />
            {t("file_library.contracts.retry.button")}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => void handleBulk("reanalyze")} disabled={isBulkActing}>
            <Sparkles className="size-3.5" />
            {t("file_library.contracts.reanalyze.button")}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              void downloadContractFiles((contracts ?? []).filter((contract) => selectedIds.includes(contract.id)))
            }
          >
            <Download className="size-3.5" />
            {t("file_library.download_selected")}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setIsBulkActionsModalOpen(true)}
            disabled={selectedFileAssetIds.length === 0}
          >
            <Layers className="size-3.5" />
            {t("file_library.bulk.button")}
          </Button>
          <CustomMenu
            placement="bottom-start"
            disabled={isBulkActing}
            customButton={
              <span className="flex h-7 shrink-0 items-center gap-1 rounded-sm border border-subtle bg-surface-1 px-2 text-12 font-medium whitespace-nowrap text-secondary hover:bg-layer-1-hover">
                <FolderInput className="size-3.5" />
                {t("file_library.contracts.move.button")}
                <ChevronDown className="size-3" />
              </span>
            }
          >
            <CustomMenu.MenuItem onClick={() => void handleBulkMove(true)}>
              <span className="flex items-center gap-2">
                <BookOpen className="size-3.5" />
                {t("file_library.contracts.move.to_editoriales")}
              </span>
            </CustomMenu.MenuItem>
            <CustomMenu.MenuItem onClick={() => void handleBulkMove(false)}>
              <span className="flex items-center gap-2">
                <FolderInput className="size-3.5" />
                {t("file_library.contracts.move.to_normal")}
              </span>
            </CustomMenu.MenuItem>
          </CustomMenu>
          <Button variant="secondary" size="sm" onClick={() => setIsBulkDeleteOpen(true)} disabled={isBulkActing}>
            <Trash2 className="size-3.5" />
            {t("file_library.delete")}
          </Button>
        </ContractBulkActionsBar>

        {/* table (desktop) / cards (mobile) */}
        <div className="min-h-0 flex-1">
          {isLoading && !contracts ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="size-6 animate-spin text-tertiary" />
            </div>
          ) : (
            <ContractsTable
              contracts={contracts ?? []}
              activeJobsByContract={activeJobsByContract}
              selectedContractId={selectedContractId}
              onSelect={(contract) => setSelectedContractId(contract.id)}
              selectedIds={selectedIds}
              onToggleSelect={toggleSelect}
              onToggleSelectAll={toggleSelectAll}
            />
          )}
        </div>

        {/* peek panel */}
        {selectedContractId && (
          <ContractPeekPanel
            workspaceSlug={workspaceSlug}
            contractId={selectedContractId}
            onClose={() => setSelectedContractId(null)}
            onMutate={() => void mutateContracts()}
            onDeleted={() => {
              setSelectedIds((previous) => previous.filter((id) => id !== selectedContractId));
              setSelectedContractId(null);
              void mutateContracts();
            }}
          />
        )}

        <ContractChatModal
          workspaceSlug={workspaceSlug}
          isOpen={isChatOpen}
          onClose={() => {
            setIsChatOpen(false);
            setChatInitialQuery(undefined);
          }}
          initialQuery={chatInitialQuery}
        />
        <ContractQueryModal
          workspaceSlug={workspaceSlug}
          isOpen={isQueryModalOpen}
          onClose={() => setIsQueryModalOpen(false)}
        />
        <RetryOptionsModal
          isOpen={isBulkRetryModalOpen}
          onClose={() => setIsBulkRetryModalOpen(false)}
          onConfirm={(options) => handleBulk("retry", options)}
          count={selectedIds.length}
        />
        <AlertModalCore
          isOpen={isBulkDeleteOpen}
          handleClose={() => !isBulkActing && setIsBulkDeleteOpen(false)}
          isSubmitting={isBulkActing}
          primaryButtonText={{ default: t("common.delete"), loading: t("common.deleting") }}
          secondaryButtonText={t("common.cancel")}
          title={t("file_library.contracts.delete.title", { count: selectedIds.length })}
          content={t("file_library.contracts.delete.description", { count: selectedIds.length })}
          handleSubmit={() => void handleBulkDelete()}
        />
        <BulkActionsModal
          workspaceSlug={workspaceSlug}
          isOpen={isBulkActionsModalOpen}
          onClose={() => {
            setIsBulkActionsModalOpen(false);
            setSelectedIds([]);
            void mutateContracts();
          }}
          initialFileIds={selectedFileAssetIds}
        />
      </>
    </div>
  );
}
