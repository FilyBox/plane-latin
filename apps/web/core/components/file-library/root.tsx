/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { observer } from "mobx-react";
import { useDropzone } from "react-dropzone";
import useSWR from "swr";
import { Download, Files, FileText, FolderPlus, Loader2, MoreHorizontal, Search, Upload } from "lucide-react";
import { Link, useSearchParams } from "react-router";
// plane imports
import type { FileSystemFileItem, FileSystemItem, FileSystemView } from "@plane/extend-ui";
import { FileSystem } from "@plane/extend-ui";
import { useLocalStorage } from "@plane/hooks";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { Popover } from "@plane/propel/popover";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import { Tooltip } from "@plane/propel/tooltip";
import { cn } from "@plane/utils";
// hooks
import { useFileLibrary } from "@/hooks/store/use-file-library";
// services
import { contractService } from "@/services/contract.service";
// local imports
import { BulkActionsModal } from "./bulk-actions-modal";
import { downloadAssets as downloadAssetsBundle } from "./download";
import type { TPreviewFile } from "./file-preview-modal";
import { FilePreviewModal } from "./file-preview-modal";
import { AppliedFiltersList } from "./filters-bar";
import { FiltersDropdown } from "./filters-dropdown";
import { FolderBreadcrumbs } from "./folder-breadcrumbs";
import { SafeDeleteModal } from "./safe-delete-modal";
import { SelectionActionBar } from "./selection-action-bar";
import { FolderSelect } from "./shared";
import { UploadModal } from "./upload-modal";

type Props = {
  workspaceSlug: string;
};

export const FileLibraryRoot = observer(function FileLibraryRoot(props: Props) {
  const { workspaceSlug } = props;
  const { t } = useTranslation();
  // store
  const {
    folderIds,
    getFolderById,
    getFolderPath,
    getFilteredFileIds,
    getFileById,
    filters,
    setFilters,
    fetchCategories,
    fetchFolders,
    fetchTags,
    fetchFiles,
    createFolder,
    bulkAction,
    getPresignedViewUrl,
    filesLoader,
  } = useFileLibrary();
  // states
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [previewFile, setPreviewFile] = useState<TPreviewFile | null>(null);
  const [pendingUploads, setPendingUploads] = useState<File[]>([]);
  const [isBulkOpen, setIsBulkOpen] = useState(false);
  const [bulkInitialIds, setBulkInitialIds] = useState<string[] | undefined>(undefined);
  // Multi-selection over the browser (path → file/folder id), fed by
  // checkboxes and Ctrl/Cmd+click in every view
  const [multiSelected, setMultiSelected] = useState<Map<string, { kind: "file" | "folder"; id: string }>>(new Map());
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [currentPath, setCurrentPath] = useState("");
  const [browseKey, setBrowseKey] = useState(0);
  const [browsePath, setBrowsePath] = useState("");
  const [newFolderParent, setNewFolderParent] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState("");
  const [isNewFolderOpen, setIsNewFolderOpen] = useState(false);

  // Last-used browser view survives reloads (icons | list | columns | gallery)
  const { storedValue: storedView, setValue: setStoredView } = useLocalStorage<FileSystemView>(
    "file_library_view",
    "icons"
  );

  // Deep link (Power K file search): ?preview=<asset_id> opens the viewer
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    const previewId = searchParams.get("preview");
    if (!previewId) return;
    const file = getFileById(previewId);
    if (!file) return; // files not loaded yet — retried when the loader settles
    setPreviewFile({ assetId: file.id, name: file.attributes.name, contentType: file.attributes.type });
    setSearchParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, filesLoader]);

  // Server-driven search/filter/order: any filter change refetches from the
  // database (debounced so typing doesn't fire a request per keystroke)
  const [searchInput, setSearchInput] = useState("");
  const isFirstFilterRun = useRef(true);
  useEffect(() => {
    const handle = setTimeout(() => setFilters({ search: searchInput.trim() || undefined }), 350);
    return () => clearTimeout(handle);
  }, [searchInput, setFilters]);
  useEffect(() => {
    if (isFirstFilterRun.current) {
      isFirstFilterRun.current = false;
      return;
    }
    void fetchFiles(workspaceSlug);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);

  // data
  useSWR(`FILE_LIBRARY_CATEGORIES_${workspaceSlug}`, () => fetchCategories(workspaceSlug), { revalidateOnFocus: false });
  useSWR(`FILE_LIBRARY_FOLDERS_${workspaceSlug}`, () => fetchFolders(workspaceSlug), { revalidateOnFocus: false });
  useSWR(`FILE_LIBRARY_TAGS_${workspaceSlug}`, () => fetchTags(workspaceSlug), { revalidateOnFocus: false });
  useSWR(`FILE_LIBRARY_FILES_${workspaceSlug}`, () => fetchFiles(workspaceSlug), { revalidateOnFocus: false });

  // Active contract analyses (shared SWR key with the contracts page). While
  // any run is live, also refresh the file list so the badges track progress.
  const { data: activeJobs } = useSWR(
    `CONTRACT_ACTIVE_JOBS_${workspaceSlug}`,
    () => contractService.getJobs(workspaceSlug, { active: true }),
    { refreshInterval: (latest) => ((latest?.length ?? 0) > 0 ? 2000 : 15000) }
  );
  const previousActiveJobCount = useRef(0);
  useEffect(() => {
    const count = activeJobs?.length ?? 0;
    if (previousActiveJobCount.current > 0 && count < previousActiveJobCount.current) void fetchFiles(workspaceSlug);
    previousActiveJobCount.current = count;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeJobs?.length]);

  // folder path helpers (path string = "A/B/C/")
  const folderPathString = useCallback(
    (folderId: string | null) =>
      getFolderPath(folderId)
        .map((folder) => folder.name)
        .join("/") + (folderId ? "/" : ""),
    [getFolderPath]
  );

  const currentFolderId = useMemo(() => {
    if (!currentPath) return null;
    const match = folderIds.find((id) => folderPathString(id) === currentPath);
    return match ?? null;
  }, [currentPath, folderIds, folderPathString]);

  // Uploads default to the selected folder, else the folder we're inside, else root
  const uploadTargetFolderId = selectedFolderId ?? currentFolderId;

  // dropzone → open the categorization modal instead of uploading directly
  const handleDrop = useCallback((acceptedFiles: File[]) => {
    if (acceptedFiles.length > 0) setPendingUploads(acceptedFiles);
  }, []);
  const { getRootProps, getInputProps, isDragActive, open: openFilePicker } = useDropzone({
    onDrop: handleDrop,
    noClick: true,
    noKeyboard: true,
  });

  // manifest: real folders; files live in exactly one folder.
  // Computed inline (no useMemo): the MobX getters are stable references, so a
  // memo would never invalidate when filesMap fills after the initial fetch —
  // the observer re-render is what keeps this fresh.
  const buildItems = (): FileSystemItem[] => {
    const manifest: FileSystemItem[] = [];
    for (const folderId of folderIds) {
      manifest.push({ kind: "folder", path: folderPathString(folderId) });
    }
    const usedPaths = new Set<string>();
    const uniquePath = (base: string) => {
      let candidate = base;
      let counter = 2;
      while (usedPaths.has(candidate)) {
        const dot = base.lastIndexOf(".");
        candidate = dot === -1 ? `${base} (${counter})` : `${base.slice(0, dot)} (${counter})${base.slice(dot)}`;
        counter += 1;
      }
      usedPaths.add(candidate);
      return candidate;
    };
    for (const fileId of getFilteredFileIds()) {
      const file = getFileById(fileId);
      if (!file) continue;
      const prefix = folderPathString(file.folder_id);
      // Contract indicator: which files are contracts + live pipeline state
      const contractBadge = file.contract_id
        ? file.contract_processing_status === "PROCESSING" || file.contract_processing_status === "PENDING"
          ? { label: t("file_library.contracts.processing.processing"), tone: "processing" as const }
          : file.contract_processing_status === "ERROR"
            ? { label: t("file_library.contracts.processing.error"), tone: "danger" as const }
            : { label: t("file_library.contracts.badge"), tone: "success" as const }
        : null;
      manifest.push({
        kind: "file",
        path: uniquePath(`${prefix}${file.attributes.name}`),
        name: file.attributes.name,
        contentType: file.attributes.type,
        size: file.size,
        createdAt: file.created_at,
        updatedAt: file.updated_at,
        badge: contractBadge,
        metadata: { assetId: file.id },
      });
    }
    return manifest;
  };
  const items = buildItems();

  const getFileUrl = useCallback(
    (file: FileSystemFileItem) => {
      const assetId = file.metadata?.assetId;
      if (!assetId) return "";
      return getPresignedViewUrl(workspaceSlug, assetId);
    },
    [workspaceSlug, getPresignedViewUrl]
  );

  const handleSelectionChange = useCallback(
    (item: FileSystemItem | null) => {
      if (item && item.kind === "file") {
        setSelectedAssetId(item.metadata?.assetId ?? null);
        setSelectedFolderId(null);
        // Touch devices have no double-tap "open" gesture — a single tap
        // both selects and opens the viewer.
        if (item.metadata?.assetId && window.matchMedia("(pointer: coarse)").matches) {
          setPreviewFile({
            assetId: item.metadata.assetId,
            name: item.name ?? item.path,
            contentType: item.contentType ?? "",
          });
        }
      } else if (item && item.kind === "folder") {
        setSelectedAssetId(null);
        // resolve the folder id from its path so uploads can target it
        const match = folderIds.find((id) => folderPathString(id) === item.path);
        setSelectedFolderId(match ?? null);
      } else {
        setSelectedAssetId(null);
        setSelectedFolderId(null);
      }
    },
    [folderIds, folderPathString]
  );

  const handleFileOpen = useCallback((fsFile: FileSystemFileItem) => {
    const assetId = fsFile.metadata?.assetId;
    if (!assetId) return;
    setPreviewFile({ assetId, name: fsFile.name ?? fsFile.path, contentType: fsFile.contentType ?? "" });
  }, []);

  // ── Multi-selection (files + folders) + downloads ───────────────────
  const selectedFilePaths = useMemo(() => new Set(multiSelected.keys()), [multiSelected]);

  // Folder paths end in "/", so the id is resolved from the folder tree
  const resolveEntryId = useCallback(
    (item: FileSystemItem): { kind: "file" | "folder"; id: string } | null => {
      if (item.kind === "file") {
        const assetId = item.metadata?.assetId;
        return assetId ? { kind: "file", id: assetId } : null;
      }
      const match = folderIds.find((id) => folderPathString(id) === item.path);
      return match ? { kind: "folder", id: match } : null;
    },
    [folderIds, folderPathString]
  );

  const handleFileSelectToggle = useCallback(
    (item: FileSystemItem) => {
      const resolved = resolveEntryId(item);
      if (!resolved) return;
      setMultiSelected((previous) => {
        const next = new Map(previous);
        if (next.has(item.path)) next.delete(item.path);
        else next.set(item.path, resolved);
        return next;
      });
    },
    [resolveEntryId]
  );

  // The list view's tree reports its native multi-selection (Ctrl/Cmd-union,
  // Shift-range) with replace semantics
  const handleFileSelectionReplace = useCallback(
    (entries: FileSystemItem[]) => {
      setMultiSelected(() => {
        const next = new Map<string, { kind: "file" | "folder"; id: string }>();
        entries.forEach((entry) => {
          const resolved = resolveEntryId(entry);
          if (resolved) next.set(entry.path, resolved);
        });
        return next;
      });
    },
    [resolveEntryId]
  );

  const clearSelection = useCallback(() => {
    setMultiSelected(new Map());
    setSelectedAssetId(null);
    setSelectedFolderId(null);
  }, []);

  // Effective selection driving the floating action bar: the multi-selection
  // when active, else the single-clicked item
  const { effectiveFiles, effectiveFolders } = useMemo(() => {
    const files: string[] = [];
    const folders: string[] = [];
    if (multiSelected.size > 0) {
      multiSelected.forEach((entry) => (entry.kind === "file" ? files : folders).push(entry.id));
    } else if (selectedAssetId) {
      files.push(selectedAssetId);
    } else if (selectedFolderId) {
      folders.push(selectedFolderId);
    }
    return {
      effectiveFiles: files.map((id) => getFileById(id)).filter((file): file is NonNullable<typeof file> => !!file),
      effectiveFolders: folders
        .map((id) => getFolderById(id))
        .filter((folder): folder is NonNullable<typeof folder> => !!folder),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [multiSelected, selectedAssetId, selectedFolderId, getFileById, getFolderById, filesLoader]);

  // Selected folders download their whole subtree (every file whose folder
  // path lives under the folder's path)
  const collectSelectionAssetIds = useCallback(() => {
    const ids = new Set(effectiveFiles.map((file) => file.id));
    const prefixes = effectiveFolders.map((folder) => folderPathString(folder.id));
    if (prefixes.length > 0) {
      getFilteredFileIds().forEach((fileId) => {
        const file = getFileById(fileId);
        if (!file) return;
        const filePrefix = folderPathString(file.folder_id);
        if (prefixes.some((prefix) => filePrefix.startsWith(prefix))) ids.add(file.id);
      });
    }
    return Array.from(ids);
  }, [effectiveFiles, effectiveFolders, folderPathString, getFilteredFileIds, getFileById]);

  // One file downloads directly; several are bundled into a single ZIP
  const downloadAssets = useCallback(
    async (assetIds: string[]) => {
      const targets = assetIds
        .map((id) => getFileById(id))
        .filter((file): file is NonNullable<typeof file> => !!file)
        .map((file) => ({ assetId: file.id, name: file.attributes.name }));
      if (targets.length === 0) return;
      // A single file has no downloads-panel entry (it's a direct browser
      // download), so it still gets its own toast; 2+ files are tracked by
      // the panel already — a second "starting" toast would just duplicate it.
      if (targets.length === 1) {
        setToast({ type: TOAST_TYPE.SUCCESS, title: t("file_library.download_started", { count: 1 }) });
      }
      try {
        await downloadAssetsBundle(workspaceSlug, targets);
      } catch {
        setToast({ type: TOAST_TYPE.ERROR, title: t("file_library.download_failed") });
      }
    },
    [workspaceSlug, getFileById, t]
  );

  const navigateTo = (path: string) => {
    setBrowsePath(path);
    setCurrentPath(path);
    setBrowseKey((k) => k + 1);
  };

  // Safe delete: the modal collects the contents strategy for folders and
  // requires typed confirmation before this runs
  const handleDeleteConfirm = async (contents: "detach" | "delete") => {
    await bulkAction(workspaceSlug, {
      action: "delete",
      file_ids: effectiveFiles.map((file) => file.id),
      folder_ids: effectiveFolders.map((folder) => folder.id),
      contents,
    });
    clearSelection();
  };

  const handleCreateFolder = async () => {
    const name = newFolderName.trim();
    if (!name) return;
    try {
      await createFolder(workspaceSlug, { name, parent: newFolderParent });
      setNewFolderName("");
      setIsNewFolderOpen(false);
    } catch (error: any) {
      setToast({ type: TOAST_TYPE.ERROR, title: t("error"), message: error?.error ?? t("error") });
    }
  };

  // Mirror the DB order inside the browser (folders always sort first)
  const sortOverride = useMemo(() => {
    const map: Record<string, { key: "name" | "kind" | "size" | "createdAt" | "updatedAt"; direction: "asc" | "desc" }> = {
      "-created_at": { key: "createdAt", direction: "desc" },
      name: { key: "name", direction: "asc" },
      "-name": { key: "name", direction: "desc" },
      type: { key: "kind", direction: "asc" },
      "-size": { key: "size", direction: "desc" },
      "-updated_at": { key: "updatedAt", direction: "desc" },
    };
    return map[filters.order ?? "-created_at"];
  }, [filters.order]);

  const iconAction = "flex size-8 items-center justify-center rounded-sm border border-subtle text-secondary hover:bg-layer-1-hover";

  return (
    <div className="flex h-full w-full flex-col">
      <UploadModal
        workspaceSlug={workspaceSlug}
        files={pendingUploads}
        onFilesChange={setPendingUploads}
        defaultFolderId={uploadTargetFolderId}
        onClose={() => setPendingUploads([])}
      />
      <BulkActionsModal
        workspaceSlug={workspaceSlug}
        isOpen={isBulkOpen}
        onClose={() => {
          setIsBulkOpen(false);
          setBulkInitialIds(undefined);
          // A bulk action (move/tags/delete) may have consumed the selection
          setMultiSelected(new Map());
        }}
        initialFileIds={bulkInitialIds}
      />
      <FilePreviewModal workspaceSlug={workspaceSlug} file={previewFile} onClose={() => setPreviewFile(null)} />
      <SafeDeleteModal
        isOpen={isDeleteModalOpen}
        files={effectiveFiles}
        folders={effectiveFolders}
        onClose={() => setIsDeleteModalOpen(false)}
        onConfirm={handleDeleteConfirm}
      />

      {/* toolbar — single compact row: folder breadcrumbs + actions */}
      <div className="flex items-center justify-between gap-2 border-b border-subtle px-2 py-1.5 sm:px-4">
        {/* Scrolls horizontally instead of clipping/overlapping the toolbar when the trail is deep */}
        <div className="horizontal-scrollbar scrollbar-xs flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          <FolderBreadcrumbs currentFolderId={currentFolderId} onNavigate={(id) => navigateTo(folderPathString(id))} />
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {/* Selected-item actions live in the floating bar — the toolbar
              stays lean: navigation, search/filter/order, and primary actions */}

          {/* contracts sub-module (AI-analyzed PDFs) */}
          <Link
            to={`/${workspaceSlug}/file-library/contracts`}
            className="flex h-8 items-center gap-1 rounded-sm border border-subtle px-2 text-12 hover:bg-layer-1-hover"
          >
            <FileText className="size-3.5" />
            <span className="hidden sm:inline">{t("file_library.contracts.title")}</span>
          </Link>

          {/* live pipeline monitor — mirrors the contracts page badge */}
          {(activeJobs?.length ?? 0) > 0 && (
            <Link
              to={`/${workspaceSlug}/file-library/contracts`}
              className="flex h-8 items-center gap-1.5 rounded-full bg-accent-primary/10 px-2.5 text-11 font-medium text-accent-primary hover:bg-accent-primary/20"
            >
              <Loader2 className="size-3 animate-spin" />
              <span className="hidden sm:inline">
                {t("file_library.contracts.active_jobs", { count: activeJobs?.length ?? 0 })}
              </span>
              <span className="sm:hidden">{activeJobs?.length ?? 0}</span>
            </Link>
          )}

          {/* search (collapses to icon-triggered popover on mobile) */}
          <div className="relative hidden sm:block">
            <Search className="absolute top-1/2 left-1.5 size-3.5 -translate-y-1/2 text-tertiary" />
            <input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder={t("file_library.bulk.search_placeholder")}
              className="w-36 rounded-sm border border-subtle bg-transparent py-1 pl-6 pr-1.5 text-12 lg:w-44"
            />
          </div>

          {/* filters — work-items-style dropdown of properties + values */}
          <FiltersDropdown />

          {/* order */}
          <select
            className="h-8 max-w-28 rounded-sm border border-subtle bg-transparent px-1.5 text-12 sm:max-w-none"
            value={filters.order ?? "-created_at"}
            onChange={(e) => setFilters({ order: e.target.value })}
            title={t("file_library.order.label")}
          >
            <option value="-created_at">{t("file_library.order.newest")}</option>
            <option value="name">{t("file_library.order.name_asc")}</option>
            <option value="-name">{t("file_library.order.name_desc")}</option>
            <option value="type">{t("file_library.order.type")}</option>
            <option value="-size">{t("file_library.order.size")}</option>
            <option value="-updated_at">{t("file_library.order.modified")}</option>
          </select>

          <span className="mx-0.5 h-5 w-px bg-subtle" />

          {/* primary actions — icon-only, tooltip-labelled */}
          <Tooltip tooltipContent={t("file_library.upload.button")}>
            <button type="button" className={cn(iconAction, "bg-accent-primary text-on-color hover:opacity-90")} onClick={openFilePicker}>
              <Upload className="size-4" />
            </button>
          </Tooltip>
          <Popover open={isNewFolderOpen} onOpenChange={setIsNewFolderOpen}>
            <Popover.Button className={iconAction} title={t("file_library.folders.new_button")}>
              <FolderPlus className="size-4" />
            </Popover.Button>
            <Popover.Panel side="bottom" align="end">
              <div className="w-64 space-y-2 rounded-md border border-subtle bg-layer-1 p-3 shadow-raised-200">
                <FolderSelect value={newFolderParent} onChange={setNewFolderParent} />
                <input
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleCreateFolder();
                  }}
                  placeholder={t("file_library.folders.new_placeholder")}
                  className="w-full rounded-sm border border-strong bg-transparent px-2 py-1 text-12"
                />
                <Button variant="primary" size="base" className="w-full" onClick={() => void handleCreateFolder()}>
                  {t("file_library.folders.create")}
                </Button>
              </div>
            </Popover.Panel>
          </Popover>
          {/* overflow: secondary actions that used to crowd the toolbar */}
          <Popover>
            <Popover.Button className={iconAction} title={t("file_library.actions.more")}>
              <MoreHorizontal className="size-4" />
            </Popover.Button>
            <Popover.Panel side="bottom" align="end" positionerClassName="z-[30]">
              <div className="w-56 space-y-0.5 rounded-md border border-subtle bg-layer-1 p-1.5 shadow-raised-200">
                <button
                  type="button"
                  onClick={() => void downloadAssets(getFilteredFileIds())}
                  disabled={getFilteredFileIds().length === 0}
                  title={t("file_library.download_all_hint")}
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-13 hover:bg-layer-1-hover disabled:opacity-50"
                >
                  <Download className="size-3.5 text-tertiary" />
                  {t("file_library.download_all")}
                </button>
                <button
                  type="button"
                  onClick={() => setIsBulkOpen(true)}
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-13 hover:bg-layer-1-hover"
                >
                  <Files className="size-3.5 text-tertiary" />
                  {t("file_library.bulk.button")}
                </button>
              </div>
            </Popover.Panel>
          </Popover>
        </div>
      </div>

      {/* applied filters row — pills grouped by property, like work items */}
      <AppliedFiltersList />

      {/* browser + dropzone */}
      <div {...getRootProps()} className="relative h-full min-h-0 w-full">
        <input {...getInputProps()} />
        {isDragActive && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-backdrop">
            <div className="rounded-md border-2 border-dashed border-accent-strong bg-layer-1 px-8 py-6 text-14 font-medium">
              {t("file_library.upload.drop_here")}
            </div>
          </div>
        )}
        {!filesLoader && items.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2">
            <p className="text-16 font-medium">{t("file_library.empty.title")}</p>
            <p className="text-13 text-tertiary">{t("file_library.empty.description")}</p>
            <Button variant="primary" size="base" onClick={openFilePicker}>
              <Upload className="size-3.5" />
              {t("file_library.upload.button")}
            </Button>
          </div>
        ) : (
          <FileSystem
            key={browseKey}
            items={items}
            title={t("file_library.title")}
            view={storedView ?? "icons"}
            onViewChange={setStoredView}
            defaultPath={browsePath}
            className="h-full"
            getFileUrl={getFileUrl}
            onPathChange={setCurrentPath}
            hideToolbarControls
            sortOverride={sortOverride}
            onSelectionChange={handleSelectionChange}
            onFileOpen={handleFileOpen}
            selectedFilePaths={selectedFilePaths}
            onFileSelectToggle={handleFileSelectToggle}
            onFileSelectionReplace={handleFileSelectionReplace}
          />
        )}

        {/* floating contextual action bar — appears with any selection */}
        {(effectiveFiles.length > 0 || effectiveFolders.length > 0) && (
          <SelectionActionBar
            workspaceSlug={workspaceSlug}
            files={effectiveFiles}
            folders={effectiveFolders}
            onDownload={() => void downloadAssets(collectSelectionAssetIds())}
            onOpenBulkModal={() => {
              setBulkInitialIds(effectiveFiles.map((file) => file.id));
              setIsBulkOpen(true);
            }}
            onRequestDelete={() => setIsDeleteModalOpen(true)}
            onClear={clearSelection}
          />
        )}
      </div>
    </div>
  );
});
