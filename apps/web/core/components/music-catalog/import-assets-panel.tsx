import { useEffect, useState } from "react";
import useSWR from "swr";
import {
  Check,
  ChevronRight,
  Download,
  Eye,
  FileSpreadsheet,
  ListMusic,
  RefreshCcw,
  Search,
  Trash2,
} from "lucide-react";
import { useNavigate } from "react-router";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TMusicImportAsset } from "@plane/types";
import { AlertModalCore } from "@plane/ui";
import { cn } from "@plane/utils";
import { FilePreviewModal, type TPreviewFile } from "../file-library/file-preview-modal";
import { BudgetPeekPanel } from "../payments/budget-peek-panel";
import { fileLibraryService } from "@/services/file-library.service";
import { musicService } from "@/services/music.service";
import { formatDate } from "./import/constants";
import { getApiError, MUSIC_FIELD } from "./shared";

type Props = {
  workspaceSlug: string;
  isOpen: boolean;
  onClose: () => void;
  /** Show the catalog filtered to the songs of one import run */
  onViewRun: (runId: string) => void;
  /** Show the catalog filtered to every song imported from one file */
  onViewFile: (assetId: string) => void;
};

const formatSize = (size: number) => {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
};

/** Every stored import source with its history: when each import ran, who
 * ran it and what it did — and from there, the songs it produced. */
export function MusicImportAssetsPanel({ workspaceSlug, isOpen, onClose, onViewRun, onViewFile }: Props) {
  const { t, currentLocale } = useTranslation();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [expandedId, setExpandedId] = useState<string>();
  const [previewFile, setPreviewFile] = useState<TPreviewFile | null>(null);
  const [deleteIds, setDeleteIds] = useState<string[]>([]);
  const [isDeleting, setIsDeleting] = useState(false);
  const { data, mutate, isLoading } = useSWR(
    isOpen ? `MUSIC_IMPORT_ASSETS_${workspaceSlug}_${search}` : null,
    () => musicService.getImportAssets(workspaceSlug, search),
    { keepPreviousData: true, revalidateOnFocus: false }
  );
  const assets = data?.results ?? [];

  useEffect(() => {
    if (!isOpen) return;
    setSearch("");
    setSelectedIds([]);
  }, [isOpen]);

  const toggle = (id: string) =>
    setSelectedIds((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));

  const download = (items: TMusicImportAsset[]) => {
    for (const asset of items) {
      const anchor = document.createElement("a");
      anchor.href = fileLibraryService.getFileDownloadUrl(workspaceSlug, asset.id, "music");
      anchor.download = asset.name;
      anchor.click();
    }
  };

  const remove = async () => {
    if (!deleteIds.length) return;
    setIsDeleting(true);
    try {
      const result = await musicService.deleteImportAssets(workspaceSlug, deleteIds);
      setSelectedIds((current) => current.filter((id) => !deleteIds.includes(id)));
      setDeleteIds([]);
      await mutate();
      setToast({ type: TOAST_TYPE.SUCCESS, title: t("music_import.history.deleted", { count: result.deleted }) });
    } catch (error) {
      setToast({ type: TOAST_TYPE.ERROR, title: t("music_import.done.delete_failed"), message: getApiError(error) });
    } finally {
      setIsDeleting(false);
    }
  };

  if (!isOpen) return null;
  const selectedAssets = assets.filter((asset) => selectedIds.includes(asset.id));
  const allSelected = assets.length > 0 && assets.every((asset) => selectedIds.includes(asset.id));

  return (
    <BudgetPeekPanel
      title={t("music_import.history.title")}
      description={t("music_import.history.description")}
      onClose={onClose}
    >
      <div className="flex h-full min-h-0 flex-col bg-surface-1">
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-subtle p-4">
          <div className="relative min-w-52 flex-1">
            <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-tertiary" aria-hidden />
            <input
              className={`${MUSIC_FIELD} pl-9`}
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setSelectedIds([]);
              }}
              placeholder={t("music_import.history.search")}
              aria-label={t("music_import.history.search")}
            />
          </div>
          <Button
            variant="secondary"
            size="sm"
            disabled={!assets.length}
            onClick={() => setSelectedIds(allSelected ? [] : assets.map((asset) => asset.id))}
          >
            {allSelected ? t("music_resources.clear_all") : t("music_resources.select_all")}
          </Button>
          {selectedAssets.length > 0 && (
            <>
              <Button variant="secondary" size="sm" onClick={() => download(selectedAssets)}>
                <Download className="size-3.5" />{" "}
                {t("music_import.history.download_count", { count: selectedAssets.length })}
              </Button>
              <Button variant="error-fill" size="sm" onClick={() => setDeleteIds(selectedIds)}>
                <Trash2 className="size-3.5" />{" "}
                {t("music_import.history.delete_count", { count: selectedAssets.length })}
              </Button>
            </>
          )}
        </div>

        <div className="vertical-scrollbar min-h-0 flex-1 overflow-y-auto p-4">
          {isLoading && !data ? (
            <p className="py-12 text-center text-12 text-tertiary">{t("music_import.history.loading")}</p>
          ) : assets.length === 0 ? (
            <div className="rounded-lg border border-dashed border-subtle py-14 text-center">
              <FileSpreadsheet className="mx-auto size-8 text-tertiary" aria-hidden />
              <p className="mt-2 text-13 font-medium">{t("music_import.history.empty")}</p>
              <p className="mt-1 text-12 text-tertiary">{t("music_import.history.empty_hint")}</p>
            </div>
          ) : (
            <ul className="space-y-2">
              {assets.map((asset) => {
                const selected = selectedIds.includes(asset.id);
                const runs = asset.runs ?? [];
                const expanded = expandedId === asset.id;
                const preview = () =>
                  setPreviewFile({ assetId: asset.id, name: asset.name, contentType: asset.content_type });
                return (
                  <li
                    key={asset.id}
                    className={cn(
                      "rounded-lg border",
                      selected ? "border-accent-primary bg-accent-primary/5" : "border-subtle bg-layer-1"
                    )}
                  >
                    <div className="flex items-center gap-3 p-3">
                      <button
                        type="button"
                        onClick={() => toggle(asset.id)}
                        className={cn(
                          "grid size-5 shrink-0 place-items-center rounded border",
                          selected ? "border-accent-primary bg-accent-primary text-on-color" : "border-strong"
                        )}
                        aria-label={t("music_resources.select_item", { name: asset.name })}
                        aria-pressed={selected}
                      >
                        {selected && <Check className="size-3" />}
                      </button>
                      <FileSpreadsheet className="size-5 shrink-0 text-tertiary" aria-hidden />
                      <button type="button" className="min-w-0 flex-1 text-left" onClick={preview}>
                        <p className="truncate text-13 font-medium text-primary">{asset.name}</p>
                        <p className="mt-0.5 text-11 text-tertiary">
                          {formatSize(asset.size)} ·{" "}
                          {t(
                            asset.upload_source === "assistant"
                              ? "music_import.history.source_assistant"
                              : "music_import.history.source_manual"
                          )}{" "}
                          ·{" "}
                          {asset.run_count
                            ? t("music_import.file.runs", { count: asset.run_count })
                            : t("music_import.history.never_imported")}
                        </p>
                      </button>
                      <button
                        type="button"
                        className="rounded p-1.5 text-secondary hover:bg-layer-2"
                        onClick={preview}
                        aria-label={t("music_import.history.preview")}
                        title={t("music_import.history.preview")}
                      >
                        <Eye className="size-4" />
                      </button>
                      <a
                        href={fileLibraryService.getFileDownloadUrl(workspaceSlug, asset.id, "music")}
                        className="rounded p-1.5 text-secondary hover:bg-layer-2"
                        aria-label={t("music_import.history.download")}
                        title={t("music_import.history.download")}
                      >
                        <Download className="size-4" />
                      </a>
                      <button
                        type="button"
                        className="rounded p-1.5 text-secondary hover:bg-danger-subtle hover:text-danger-primary"
                        onClick={() => setDeleteIds([asset.id])}
                        aria-label={t("music_import.history.delete")}
                        title={t("music_import.history.delete")}
                      >
                        <Trash2 className="size-4" />
                      </button>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 border-t border-subtle px-3 py-2">
                      {runs.length > 0 && (
                        <button
                          type="button"
                          onClick={() => setExpandedId(expanded ? undefined : asset.id)}
                          aria-expanded={expanded}
                          className="flex items-center gap-1 text-12 text-secondary hover:text-primary"
                        >
                          <ChevronRight className={cn("size-3.5 transition-transform", expanded && "rotate-90")} />
                          {t("music_import.history.runs_toggle", { count: runs.length })}
                        </button>
                      )}
                      <span className="flex-1" />
                      {runs.length > 0 && (
                        <Button variant="secondary" size="sm" onClick={() => onViewFile(asset.id)}>
                          <ListMusic className="size-3.5" />
                          {t("music_import.history.view_songs")}
                        </Button>
                      )}
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => navigate(`/${workspaceSlug}/music/import?asset=${asset.id}`)}
                      >
                        <RefreshCcw className="size-3.5" />
                        {t("music_import.actions.reimport")}
                      </Button>
                    </div>

                    {expanded && (
                      <ul className="divide-y divide-subtle border-t border-subtle">
                        {runs.map((run) => (
                          <li
                            key={run.id}
                            className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-12"
                          >
                            <span className="min-w-0 text-secondary">
                              {t("music_import.history.run_line", {
                                date: formatDate(run.imported_at, currentLocale),
                                created: run.summary.created ?? 0,
                                updated: run.summary.updated ?? 0,
                                unchanged: (run.summary.unchanged ?? 0) + (run.summary.skipped ?? 0),
                              })}
                              {run.imported_by && (
                                <span className="text-tertiary">
                                  {" "}
                                  · {t("music_import.history.run_by", { name: run.imported_by })}
                                </span>
                              )}
                            </span>
                            <button
                              type="button"
                              onClick={() => onViewRun(run.id)}
                              className="text-primary underline-offset-2 hover:underline"
                            >
                              {t("music_import.history.view_songs")}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
      <FilePreviewModal
        workspaceSlug={workspaceSlug}
        file={previewFile}
        scope="music"
        onClose={() => setPreviewFile(null)}
      />
      <AlertModalCore
        isOpen={deleteIds.length > 0}
        isSubmitting={isDeleting}
        handleClose={() => setDeleteIds([])}
        handleSubmit={() => void remove()}
        title={t("music_import.history.delete_title", { count: deleteIds.length })}
        content={t("music_import.history.delete_content")}
        primaryButtonText={{ default: t("common.delete"), loading: t("common.deleting") }}
        secondaryButtonText={t("common.cancel")}
      />
    </BudgetPeekPanel>
  );
}
