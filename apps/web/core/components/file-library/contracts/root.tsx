/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { observer } from "mobx-react";
import { useDropzone } from "react-dropzone";
import {
  ArrowUpDown,
  BookOpen,
  CalendarClock,
  Check,
  ChevronDown,
  Download,
  FileSpreadsheet,
  FileText,
  FolderInput,
  Layers,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  PencilLine,
  Plus,
  RefreshCcw,
  Search,
  SearchX,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useSearchParams } from "react-router";
import useSWR from "swr";
// plane imports
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type {
  TContract,
  TContractFilters,
  TContractJob,
  TContractPage,
  TContractRetryOptions,
  TContractView,
} from "@plane/types";
import { AlertModalCore, CustomMenu } from "@plane/ui";
import { cn } from "@plane/utils";
// hooks
import { useIntersectionObserver } from "@/hooks/use-intersection-observer";
// services
import { contractService } from "@/services/contract.service";
// local imports
import { BulkActionsModal } from "../bulk-actions-modal";
import { downloadAssets } from "../download";
import { ContractBulkEditModal } from "./bulk-edit-modal";
import { ContractChatModal } from "./chat/chat-modal";
import { EXPIRING_WINDOWS, PAGE_SIZE } from "./constants";
import { AppliedContractFilters, ContractFiltersDropdown } from "./filters";
import { ContractBulkActionsBar } from "./list-controls";
import { ContractPeekPanel } from "./peek-panel";
import { RetryOptionsModal } from "./retry-options-modal";
import { ContractsTable } from "./table";
import { ContractUploadPanel, useContractUploadQueue } from "./upload-queue";
import { useCanEditContracts } from "./use-can-edit";
import {
  activeFilterCount,
  DEFAULT_ORDER,
  FILTER_PARAM_KEYS,
  filterQueryOnly,
  filtersFromParams,
  isJobActive,
  paramsWithFilters,
} from "./utils";

type Props = {
  workspaceSlug: string;
  /** One of the sidebar subsets; the full analyzed list when absent. */
  view?: TContractView;
};

type TOrder = NonNullable<TContractFilters["order"]>;

const ORDER_OPTIONS: { value: TOrder; i18nKey: string }[] = [
  { value: "-created_at", i18nKey: "file_library.order.newest" },
  { value: "-updated_at", i18nKey: "file_library.order.modified" },
  { value: "titulo", i18nKey: "file_library.order.name_asc" },
  { value: "-titulo", i18nKey: "file_library.order.name_desc" },
  { value: "-fecha_inicio", i18nKey: "file_library.contracts.order.start_newest" },
  { value: "fecha_inicio", i18nKey: "file_library.contracts.order.start_oldest" },
  { value: "fecha_fin", i18nKey: "file_library.contracts.order.end_soonest" },
  { value: "-fecha_fin", i18nKey: "file_library.contracts.order.end_latest" },
  { value: "fin_efectiva", i18nKey: "file_library.contracts.order.effective_soonest" },
  { value: "-fin_efectiva", i18nKey: "file_library.contracts.order.effective_latest" },
];

/** Filters carried between Analizados, Vigentes, Vencidos and Editoriales */
const filtersStorageKey = (workspaceSlug: string) => `contracts-filters:${workspaceSlug}`;
const readStoredFilters = (workspaceSlug: string): string => {
  try {
    return sessionStorage.getItem(filtersStorageKey(workspaceSlug)) ?? "";
  } catch {
    return "";
  }
};
const storeFilters = (workspaceSlug: string, query: string) => {
  try {
    if (query) sessionStorage.setItem(filtersStorageKey(workspaceSlug), query);
    else sessionStorage.removeItem(filtersStorageKey(workspaceSlug));
  } catch {
    // storage blocked: filters just don't carry over
  }
};

const TOOLBAR_BUTTON =
  "flex h-8 shrink-0 items-center gap-1 rounded-sm border border-subtle px-2 text-12 whitespace-nowrap text-secondary hover:bg-layer-1-hover disabled:opacity-50";

export const ContractsRoot = observer(function ContractsRoot(props: Props) {
  const { workspaceSlug, view } = props;
  const { t } = useTranslation();
  const canEdit = useCanEditContracts(workspaceSlug);
  const [searchParams, setSearchParams] = useSearchParams();
  // states
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [chatInitialQuery, setChatInitialQuery] = useState<string | undefined>(undefined);
  const [isBulkActing, setIsBulkActing] = useState(false);
  const [isBulkRetryModalOpen, setIsBulkRetryModalOpen] = useState(false);
  const [isBulkActionsModalOpen, setIsBulkActionsModalOpen] = useState(false);
  const [isBulkEditOpen, setIsBulkEditOpen] = useState(false);
  const [isBulkDeleteOpen, setIsBulkDeleteOpen] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  // Pages shown, per filter set: new filters start again at one page
  const [pageState, setPageState] = useState<{ base: string; count: number }>({ base: "", count: 1 });

  // ── Filters live in the URL ────────────────────────────────────────────
  const filters = useMemo(() => filtersFromParams(searchParams), [searchParams]);
  const filterQuery = filterQueryOnly(searchParams);
  const [searchInput, setSearchInput] = useState(filters.search ?? "");

  const replaceFilters = useCallback(
    (next: TContractFilters) => setSearchParams((current) => paramsWithFilters(current, next), { replace: true }),
    [setSearchParams]
  );
  const setFilters = (next: Partial<TContractFilters>) => replaceFilters({ ...filters, ...next });
  const clearFilters = () => {
    setSearchInput("");
    replaceFilters({ order: filters.order });
  };

  // Coming from another list view with no filters of its own: bring the last ones
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    if (filterQuery) return;
    const stored = readStoredFilters(workspaceSlug);
    if (!stored) return;
    const storedParams = new URLSearchParams(stored);
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        FILTER_PARAM_KEYS.forEach((key) => {
          const value = storedParams.get(key);
          if (value) next.set(key, value);
        });
        return next;
      },
      { replace: true }
    );
    setSearchInput(storedParams.get("q") ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (restored.current) storeFilters(workspaceSlug, filterQuery);
  }, [filterQuery, workspaceSlug]);

  // debounce search → URL → server-side filter
  useEffect(() => {
    const value = searchInput.trim() || undefined;
    if (value === filters.search) return;
    const handle = setTimeout(() => setFilters({ search: value }), 350);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

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

  // ── Paginated list ─────────────────────────────────────────────────────
  // Server filters are part of the key; host.tsx refreshes every `CONTRACTS_<slug>` key.
  const filtersKey = JSON.stringify({ ...filters, search: filters.search ?? null });
  useEffect(() => {
    setSelectedIds([]);
  }, [filtersKey, view]);

  const pagesRef = useRef<{ base: string; pages: TContractPage[] } | null>(null);
  const baseKey = `${view ?? "all"}_${filtersKey}`;
  const pageCount = pageState.base === baseKey ? pageState.count : 1;
  const {
    data: pages,
    mutate: mutateContracts,
    isLoading,
    error: listError,
  } = useSWR<TContractPage[]>(
    [`CONTRACTS_${workspaceSlug}`, baseKey, pageCount],
    async () => {
      const previous = pagesRef.current?.base === baseKey ? pagesRef.current.pages : [];
      let loaded: TContractPage[];
      // Growing by one page: fetch just that page
      if (previous.length === pageCount - 1 && previous.length > 0 && previous[previous.length - 1].next_cursor) {
        const next = await contractService.getContractsPage(
          workspaceSlug,
          filters,
          view,
          PAGE_SIZE,
          previous[previous.length - 1].next_cursor
        );
        loaded = [...previous, next];
      } else {
        // Fresh load or revalidation: re-read every page shown
        loaded = [];
        let cursor: string | null = null;
        for (let index = 0; index < pageCount; index += 1) {
          // Each page needs the previous page's cursor
          // eslint-disable-next-line no-await-in-loop
          const page: TContractPage = await contractService.getContractsPage(
            workspaceSlug,
            filters,
            view,
            PAGE_SIZE,
            cursor
          );
          loaded.push(page);
          cursor = page.next_cursor;
          if (!cursor) break;
        }
      }
      pagesRef.current = { base: baseKey, pages: loaded };
      return loaded;
    },
    { keepPreviousData: true }
  );
  const contracts = useMemo(() => {
    const seen = new Set<string>();
    return (pages ?? []).flatMap((page) => page.results).filter((row) => !seen.has(row.id) && !!seen.add(row.id));
  }, [pages]);
  const total = pages?.[0]?.total ?? contracts.length;
  const nextCursor = pages?.[pages.length - 1]?.next_cursor ?? null;
  const loadMore = useCallback(() => {
    if (nextCursor && pages?.length === pageCount) setPageState({ base: baseKey, count: pageCount + 1 });
  }, [baseKey, nextCursor, pageCount, pages?.length]);
  // Auto-load near the end; the viewport root still respects the list's own scroll clipping
  const [sentinel, setSentinel] = useState<HTMLDivElement | null>(null);
  const viewportRoot = useRef<HTMLDivElement | null>(null);
  useIntersectionObserver(viewportRoot, sentinel, loadMore, "200px");

  // ── Live pipeline monitoring ───────────────────────────────────────────
  // Poll only while something is running: an active job, or a row the
  // pipeline hasn't finished. Uploads and retries trigger a check right away.
  const rowsProcessing = contracts.some(
    (row) => row.processing_status === "PENDING" || row.processing_status === "PROCESSING"
  );
  const { data: activeJobs, mutate: mutateActiveJobs } = useSWR<TContractJob[]>(
    `CONTRACT_ACTIVE_JOBS_${workspaceSlug}`,
    () => contractService.getJobs(workspaceSlug, { active: true }),
    {
      refreshInterval: (latest) => ((latest ?? []).some(isJobActive) || rowsProcessing ? 3000 : 0),
    }
  );
  const activeJobsByContract = useMemo(() => {
    const map: Record<string, TContractJob> = {};
    (activeJobs ?? []).forEach((job) => {
      if (job.contract_id && !map[job.contract_id]) map[job.contract_id] = job;
    });
    return map;
  }, [activeJobs]);

  // Reload the rows whenever the set of running jobs changes (one ends, another starts)
  const jobSet = (activeJobs ?? [])
    .map((job) => job.id)
    .sort()
    .join(",");
  const previousJobSet = useRef<string | null>(null);
  useEffect(() => {
    if (activeJobs === undefined) return;
    if (previousJobSet.current !== null && previousJobSet.current !== jobSet) void mutateContracts();
    previousJobSet.current = jobSet;
  }, [activeJobs, jobSet, mutateContracts]);

  const refreshAll = useCallback(() => {
    void mutateContracts();
    void mutateActiveJobs();
  }, [mutateActiveJobs, mutateContracts]);

  // ── Uploads ────────────────────────────────────────────────────────────
  const uploads = useContractUploadQueue(workspaceSlug, refreshAll);
  const {
    getRootProps,
    getInputProps,
    isDragActive,
    open: openFilePicker,
  } = useDropzone({
    // Non-PDFs are reported by the queue, not dropped silently
    onDrop: (accepted, rejections) => void uploads.addFiles([...accepted, ...rejections.map((entry) => entry.file)]),
    accept: { "application/pdf": [".pdf"] },
    noClick: true,
    noKeyboard: true,
    disabled: !canEdit,
  });

  // ── Selection + bulk ───────────────────────────────────────────────────
  const toggleSelect = (contractId: string) =>
    setSelectedIds((previous) =>
      previous.includes(contractId) ? previous.filter((id) => id !== contractId) : [...previous, contractId]
    );
  const toggleSelectAll = () =>
    setSelectedIds((previous) => (previous.length === contracts.length ? [] : contracts.map((c) => c.id)));

  // The Files bulk-actions modal (move/categories/tags/delete) operates on
  // file_asset ids, not contract ids — map the selection across
  const selectedFileAssetIds = contracts
    .filter((contract) => selectedIds.includes(contract.id))
    .map((contract) => contract.file_asset_id)
    .filter((id): id is string => !!id);

  // Downloads the contracts' backing documents: one file directly, several
  // bundled into a ZIP. Callers pass the loaded list or the selection.
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

  const handleExport = async (type: "xlsx" | "csv") => {
    if (isExporting) return;
    setIsExporting(true);
    try {
      const { blob, fileName } = await contractService.exportContracts(workspaceSlug, type, filters, view);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName ?? `contratos.${type}`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setToast({ type: TOAST_TYPE.ERROR, title: t("file_library.contracts.export.failed") });
    } finally {
      setIsExporting(false);
    }
  };

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
      refreshAll();
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

  // ── Toolbar pieces ─────────────────────────────────────────────────────
  const order = filters.order ?? DEFAULT_ORDER;
  const hasNarrowing = activeFilterCount(filters) > 0 || !!filters.search;
  const activeCount = (activeJobs ?? []).filter(isJobActive).length;

  const expiringMenu = (
    <CustomMenu
      placement="bottom-start"
      customButton={
        <span
          className={cn(TOOLBAR_BUTTON, filters.vence_en && "border-accent-strong text-accent-primary")}
          aria-hidden
        >
          <CalendarClock className="size-3.5" />
          {filters.vence_en
            ? t("file_library.contracts.expiring.days", { count: filters.vence_en })
            : t("file_library.contracts.expiring.label")}
          <ChevronDown className="size-3" />
        </span>
      }
      ariaLabel={t("file_library.contracts.expiring.label")}
      closeOnSelect
    >
      {EXPIRING_WINDOWS.map((days) => (
        <CustomMenu.MenuItem key={days} onClick={() => setFilters({ vence_en: days })}>
          <span className="flex items-center gap-2">
            <Check className={cn("size-3.5", filters.vence_en !== days && "invisible")} />
            {t("file_library.contracts.expiring.within", { count: days })}
          </span>
        </CustomMenu.MenuItem>
      ))}
      {filters.vence_en ? (
        <CustomMenu.MenuItem onClick={() => setFilters({ vence_en: undefined })}>
          <span className="flex items-center gap-2 pl-5.5">{t("file_library.contracts.expiring.any")}</span>
        </CustomMenu.MenuItem>
      ) : null}
    </CustomMenu>
  );

  const emptyState = listError ? (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-tertiary">
      <SearchX className="size-8" />
      <p className="text-14 font-medium text-secondary">{t("file_library.contracts.list.load_failed")}</p>
      <Button variant="secondary" size="sm" onClick={() => void mutateContracts()}>
        <RefreshCcw className="size-3.5" />
        {t("file_library.contracts.retry.button")}
      </Button>
    </div>
  ) : hasNarrowing ? (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-tertiary">
      <SearchX className="size-8" />
      <p className="text-14 font-medium text-secondary">{t("file_library.contracts.empty.filtered_title")}</p>
      <p className="max-w-sm text-12">{t("file_library.contracts.empty.filtered_description")}</p>
      <Button variant="secondary" size="sm" onClick={clearFilters}>
        {t("file_library.filters.clear_all")}
      </Button>
    </div>
  ) : (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-tertiary">
      <FileText className="size-8" />
      <p className="text-14 font-medium text-secondary">
        {view ? t("file_library.contracts.empty.view_title") : t("file_library.contracts.empty.title")}
      </p>
      <p className="max-w-sm text-12">{t("file_library.contracts.empty.upload_description")}</p>
      {canEdit && (
        <Button variant="primary" size="sm" onClick={openFilePicker}>
          <Plus className="size-3.5" />
          {t("file_library.contracts.upload.button")}
        </Button>
      )}
    </div>
  );

  const footer =
    contracts.length > 0 ? (
      <div className="flex flex-col items-center gap-1.5 px-4 py-4 text-11 text-tertiary">
        <span aria-live="polite">{t("file_library.contracts.list.showing", { shown: contracts.length, total })}</span>
        {nextCursor && (
          <>
            <div ref={setSentinel} aria-hidden className="h-px w-full" />
            <Button variant="secondary" size="sm" onClick={loadMore} disabled={pages?.length !== pageCount}>
              {pages?.length !== pageCount ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {t("file_library.contracts.list.load_more")}
            </Button>
          </>
        )}
      </div>
    ) : null;

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

      {/* toolbar: one row that never overflows; secondary actions fold into a menu below sm */}
      <div className="flex shrink-0 items-center gap-2 border-b border-subtle px-3 py-2.5 sm:px-4">
        <div className="relative min-w-0 flex-1 sm:max-w-64">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-tertiary" />
          <label htmlFor="contracts-search" className="sr-only">
            {t("file_library.contracts.search_placeholder")}
          </label>
          <input
            id="contracts-search"
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder={t("file_library.contracts.search_placeholder")}
            className="h-8 w-full rounded-md border border-subtle bg-transparent pr-2 pl-8 text-12"
          />
        </div>
        <ContractFiltersDropdown workspaceSlug={workspaceSlug} filters={filters} onChange={setFilters} />
        <div className="hidden items-center gap-2 lg:flex">{expiringMenu}</div>
        <label className="relative hidden items-center sm:flex">
          <ArrowUpDown className="pointer-events-none absolute left-2 size-3.5 text-tertiary" />
          <select
            aria-label={t("file_library.order.label")}
            value={order}
            onChange={(event) => setFilters({ order: event.target.value as TOrder })}
            className="h-8 max-w-44 rounded-sm border border-subtle bg-surface-1 pr-7 pl-7 text-12 text-secondary hover:bg-layer-1-hover"
          >
            {ORDER_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {t(option.i18nKey)}
              </option>
            ))}
          </select>
        </label>
        {/* Secondary actions: download, export, and (small screens) order + expiring */}
        <CustomMenu
          placement="bottom-end"
          customButton={
            <span className={TOOLBAR_BUTTON} aria-hidden>
              {isExporting ? <Loader2 className="size-3.5 animate-spin" /> : <MoreHorizontal className="size-3.5" />}
            </span>
          }
          ariaLabel={t("file_library.contracts.list.more_actions")}
          closeOnSelect
          maxHeight="lg"
        >
          <CustomMenu.MenuItem onClick={() => void downloadContractFiles(contracts)} disabled={contracts.length === 0}>
            <span className="flex items-center gap-2" title={t("file_library.download_all_hint")}>
              <Download className="size-3.5" />
              {t("file_library.contracts.list.download_files")}
            </span>
          </CustomMenu.MenuItem>
          <CustomMenu.MenuItem onClick={() => void handleExport("xlsx")} disabled={isExporting}>
            <span className="flex items-center gap-2">
              <FileSpreadsheet className="size-3.5" />
              {t("file_library.contracts.export.xlsx")}
            </span>
          </CustomMenu.MenuItem>
          <CustomMenu.MenuItem onClick={() => void handleExport("csv")} disabled={isExporting}>
            <span className="flex items-center gap-2">
              <FileText className="size-3.5" />
              {t("file_library.contracts.export.csv")}
            </span>
          </CustomMenu.MenuItem>
          <div className="lg:hidden">
            <p className="mt-1 border-t border-subtle px-2 pt-2 pb-1 text-10 font-semibold text-tertiary uppercase">
              {t("file_library.contracts.expiring.label")}
            </p>
            {EXPIRING_WINDOWS.map((days) => (
              <CustomMenu.MenuItem
                key={days}
                onClick={() => setFilters({ vence_en: filters.vence_en === days ? undefined : days })}
              >
                <span className="flex items-center gap-2">
                  <Check className={cn("size-3.5", filters.vence_en !== days && "invisible")} />
                  {t("file_library.contracts.expiring.within", { count: days })}
                </span>
              </CustomMenu.MenuItem>
            ))}
          </div>
          <div className="sm:hidden">
            <p className="mt-1 border-t border-subtle px-2 pt-2 pb-1 text-10 font-semibold text-tertiary uppercase">
              {t("file_library.order.label")}
            </p>
            {ORDER_OPTIONS.map((option) => (
              <CustomMenu.MenuItem key={option.value} onClick={() => setFilters({ order: option.value })}>
                <span className="flex items-center gap-2">
                  <Check className={cn("size-3.5", order !== option.value && "invisible")} />
                  {t(option.i18nKey)}
                </span>
              </CustomMenu.MenuItem>
            ))}
          </div>
        </CustomMenu>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {activeCount > 0 && (
            <span
              className="hidden items-center gap-1.5 rounded-full bg-accent-primary/10 px-2.5 py-1 text-11 font-medium text-accent-primary md:flex"
              aria-live="polite"
            >
              <Loader2 className="size-3 animate-spin" />
              {t("file_library.contracts.active_jobs", { count: activeCount })}
            </span>
          )}
          {canEdit && (
            <Button
              variant="secondary"
              size="sm"
              onClick={openFilePicker}
              aria-label={t("file_library.contracts.upload.button")}
            >
              {uploads.busy ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
              <span className="hidden md:inline">{t("file_library.contracts.upload.button")}</span>
            </Button>
          )}
          <Button
            variant="primary"
            size="sm"
            onClick={() => setIsChatOpen(true)}
            aria-label={t("file_library.contracts.chat.button")}
          >
            <MessageSquare className="size-3.5" />
            <span className="hidden md:inline">{t("file_library.contracts.chat.button")}</span>
          </Button>
        </div>
      </div>

      {/* applied filter pills */}
      <AppliedContractFilters
        workspaceSlug={workspaceSlug}
        filters={filters}
        onChange={setFilters}
        onClearAll={clearFilters}
      />

      {/* bulk actions bar */}
      {canEdit && (
        <ContractBulkActionsBar count={selectedIds.length} onClear={() => setSelectedIds([])}>
          <Button variant="secondary" size="sm" onClick={() => setIsBulkEditOpen(true)} disabled={isBulkActing}>
            <PencilLine className="size-3.5" />
            {t("file_library.contracts.bulk_edit.button")}
          </Button>
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
              void downloadContractFiles(contracts.filter((contract) => selectedIds.includes(contract.id)))
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
      )}

      {/* table (desktop) / cards (mobile) */}
      <div className="min-h-0 flex-1">
        {isLoading && !pages ? (
          <div className="flex h-full items-center justify-center" role="status">
            <Loader2 className="size-6 animate-spin text-tertiary" />
            <span className="sr-only">{t("common.loading")}</span>
          </div>
        ) : (
          <ContractsTable
            contracts={contracts}
            activeJobsByContract={activeJobsByContract}
            selectedContractId={selectedContractId}
            onSelect={(contract) => setSelectedContractId(contract.id)}
            selectedIds={selectedIds}
            onToggleSelect={toggleSelect}
            onToggleSelectAll={toggleSelectAll}
            order={order}
            onOrderChange={(next) => setFilters({ order: next })}
            selectable={canEdit}
            emptyState={emptyState}
            footer={footer}
          />
        )}
      </div>

      {/* peek panel */}
      {selectedContractId && (
        <ContractPeekPanel
          workspaceSlug={workspaceSlug}
          contractId={selectedContractId}
          onClose={() => setSelectedContractId(null)}
          onMutate={refreshAll}
          onDeleted={() => {
            setSelectedIds((previous) => previous.filter((id) => id !== selectedContractId));
            setSelectedContractId(null);
            void mutateContracts();
          }}
        />
      )}

      <ContractUploadPanel {...uploads} onOpenContract={(id) => setSelectedContractId(id)} />

      <ContractChatModal
        workspaceSlug={workspaceSlug}
        isOpen={isChatOpen}
        onClose={() => {
          setIsChatOpen(false);
          setChatInitialQuery(undefined);
        }}
        initialQuery={chatInitialQuery}
      />
      <RetryOptionsModal
        isOpen={isBulkRetryModalOpen}
        onClose={() => setIsBulkRetryModalOpen(false)}
        onConfirm={(options) => handleBulk("retry", options)}
        count={selectedIds.length}
      />
      <ContractBulkEditModal
        workspaceSlug={workspaceSlug}
        isOpen={isBulkEditOpen}
        contractIds={selectedIds}
        onClose={() => setIsBulkEditOpen(false)}
        onDone={() => {
          setSelectedIds([]);
          void mutateContracts();
        }}
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
    </div>
  );
});
