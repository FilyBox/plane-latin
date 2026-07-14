/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useState } from "react";
import { observer } from "mobx-react";
import { Check, Download, FolderInput, Layers, Pencil, Tags, Trash2, X } from "lucide-react";
// plane imports
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { Popover } from "@plane/propel/popover";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TFileFolder, TLibraryFile } from "@plane/types";
import { cn } from "@plane/utils";
// hooks
import { useFileLibrary } from "@/hooks/store/use-file-library";
// local imports
import { FolderSelect } from "./shared";
import { releaseToastClearance, reserveToastClearance } from "./toast-offset";

type Props = {
  workspaceSlug: string;
  /** Effective selection: multi-selection when active, else the single-clicked item */
  files: TLibraryFile[];
  folders: TFileFolder[];
  onDownload: () => void;
  onOpenBulkModal: () => void;
  onRequestDelete: () => void;
  onClear: () => void;
};

const barButton =
  "flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-12 font-medium text-secondary hover:bg-layer-1-hover";

/**
 * Floating contextual action bar shown while files/folders are selected.
 * Content adapts: a single file gets its full quick actions (categories, tags,
 * rename…), a single folder gets folder actions, and mixed/multiple
 * selections narrow down to the operations that safely apply to everything.
 */
export const SelectionActionBar = observer(function SelectionActionBar(props: Props) {
  const { workspaceSlug, files, folders, onDownload, onOpenBulkModal, onRequestDelete, onClear } = props;
  const { t } = useTranslation();
  const {
    categoryIds,
    getCategoryById,
    tagIds,
    getTagById,
    addFileCategories,
    removeFileCategory,
    addFileTags,
    removeFileTag,
    renameFile,
    updateFolder,
    bulkAction,
    getFileDownloadUrl,
  } = useFileLibrary();
  // states
  const [entered, setEntered] = useState(false);
  const [isRenameOpen, setIsRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [isMoveOpen, setIsMoveOpen] = useState(false);
  const [moveTarget, setMoveTarget] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  // Slide-up entrance (the parent mounts the bar when the selection appears)
  useEffect(() => {
    const raf = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  // While visible, push ephemeral toasts up so they don't land on top of
  // this bar's buttons — it's mounted only for the lifetime of a selection
  useEffect(() => {
    reserveToastClearance("selection-action-bar", 3.5);
    return () => releaseToastClearance("selection-action-bar");
  }, []);

  const total = files.length + folders.length;
  const singleFile = files.length === 1 && folders.length === 0 ? files[0] : null;
  const singleFolder = folders.length === 1 && files.length === 0 ? folders[0] : null;
  const label = singleFile
    ? singleFile.attributes.name
    : singleFolder
      ? singleFolder.name
      : t("file_library.bulk.selected_count", { count: total });

  const run = async (fn: () => Promise<void>) => {
    setIsBusy(true);
    try {
      await fn();
    } catch (error: any) {
      setToast({ type: TOAST_TYPE.ERROR, title: t("error"), message: error?.error ?? t("error") });
    } finally {
      setIsBusy(false);
    }
  };

  const handleRename = () =>
    void run(async () => {
      const name = renameValue.trim();
      if (!name) return;
      if (singleFile) await renameFile(workspaceSlug, singleFile.id, name);
      else if (singleFolder) await updateFolder(workspaceSlug, singleFolder.id, { name });
      setIsRenameOpen(false);
    });

  const handleMove = () =>
    void run(async () => {
      await bulkAction(workspaceSlug, {
        action: "move",
        file_ids: files.map((file) => file.id),
        folder_ids: folders.map((folder) => folder.id),
        folder_id: moveTarget,
      });
      setIsMoveOpen(false);
      onClear();
    });

  const labelChecklist = (
    kind: "categories" | "tags",
    ids: string[],
    getById: (id: string) => { id: string; name: string; pdf_only?: boolean } | undefined,
    assigned: string[],
    onToggle: (id: string) => void
  ) => (
    <Popover>
      <Popover.Button className={barButton} title={t(`file_library.${kind}.title`)}>
        {kind === "categories" ? <Layers className="size-3.5" /> : <Tags className="size-3.5" />}
        <span className="hidden sm:inline">{t(`file_library.${kind}.title`)}</span>
      </Popover.Button>
      <Popover.Panel side="top" align="center" positionerClassName="z-[30]">
        <div className="max-h-60 w-56 space-y-0.5 overflow-y-auto rounded-md border border-subtle bg-layer-1 p-2 shadow-raised-200">
          {ids.map((id) => {
            const item = getById(id);
            if (!item) return null;
            const isAssigned = assigned.includes(id);
            const isDisabled = Boolean(item.pdf_only) && singleFile?.attributes.type !== "application/pdf";
            return (
              <button
                key={id}
                type="button"
                disabled={isDisabled}
                title={isDisabled ? t("file_library.categories.pdf_only_hint") : undefined}
                className={cn(
                  "flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-left text-13",
                  isDisabled ? "cursor-not-allowed text-placeholder" : "hover:bg-layer-1-hover"
                )}
                onClick={() => onToggle(id)}
              >
                <span className="truncate">{item.name}</span>
                {isAssigned && <Check className="size-3.5 shrink-0" />}
              </button>
            );
          })}
        </div>
      </Popover.Panel>
    </Popover>
  );

  return (
    <div className="pointer-events-none absolute inset-x-2 bottom-4 z-[25] flex justify-center sm:inset-x-4">
      <div
        className={cn(
          "pointer-events-auto flex max-w-full items-center gap-0.5 overflow-x-auto rounded-lg border border-subtle bg-layer-1 px-2 py-1.5 shadow-raised-200 transition-all duration-200 ease-out",
          entered ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0"
        )}
      >
        <span className="max-w-40 shrink-0 truncate px-1.5 text-12 font-medium sm:max-w-56">{label}</span>
        <span className="mx-0.5 h-5 w-px shrink-0 bg-subtle" />

        {/* single file: full quick actions */}
        {singleFile && (
          <>
            {labelChecklist(
              "categories",
              categoryIds,
              (id) => getCategoryById(id),
              singleFile.category_ids,
              (id) =>
                void (singleFile.category_ids.includes(id)
                  ? removeFileCategory(workspaceSlug, singleFile.id, id)
                  : addFileCategories(workspaceSlug, singleFile.id, [id])
                ).catch((error: any) =>
                  setToast({ type: TOAST_TYPE.ERROR, title: t("error"), message: error?.error ?? t("error") })
                )
            )}
            {labelChecklist(
              "tags",
              tagIds,
              (id) => getTagById(id),
              singleFile.tag_ids,
              (id) =>
                void (singleFile.tag_ids.includes(id)
                  ? removeFileTag(workspaceSlug, singleFile.id, id)
                  : addFileTags(workspaceSlug, singleFile.id, [id])
                ).catch((error: any) =>
                  setToast({ type: TOAST_TYPE.ERROR, title: t("error"), message: error?.error ?? t("error") })
                )
            )}
          </>
        )}

        {/* several files (no folders): the full bulk modal applies */}
        {!singleFile && !singleFolder && files.length > 0 && (
          <button type="button" className={barButton} onClick={onOpenBulkModal}>
            <Layers className="size-3.5" />
            <span className="hidden sm:inline">{t("file_library.bulk.button")}</span>
          </button>
        )}

        {/* rename — only meaningful for exactly one item */}
        {(singleFile || singleFolder) && (
          <Popover
            open={isRenameOpen}
            onOpenChange={(open) => {
              setIsRenameOpen(open);
              if (open) setRenameValue(singleFile ? singleFile.attributes.name : (singleFolder?.name ?? ""));
            }}
          >
            <Popover.Button className={barButton} title={t("file_library.actions.rename")}>
              <Pencil className="size-3.5" />
              <span className="hidden sm:inline">{t("file_library.actions.rename")}</span>
            </Popover.Button>
            <Popover.Panel side="top" align="center" positionerClassName="z-[30]">
              <div className="w-64 space-y-2 rounded-md border border-subtle bg-layer-1 p-3 shadow-raised-200">
                <input
                  autoFocus
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleRename();
                  }}
                  placeholder={t("file_library.actions.rename_placeholder")}
                  className="w-full rounded-sm border border-strong bg-transparent px-2 py-1 text-12"
                />
                <Button
                  variant="primary"
                  size="base"
                  className="w-full"
                  onClick={handleRename}
                  disabled={isBusy || !renameValue.trim()}
                >
                  {t("file_library.actions.rename")}
                </Button>
              </div>
            </Popover.Panel>
          </Popover>
        )}

        {/* move — applies to any mix of files and folders */}
        <Popover open={isMoveOpen} onOpenChange={setIsMoveOpen}>
          <Popover.Button className={barButton} title={t("file_library.actions.move")}>
            <FolderInput className="size-3.5" />
            <span className="hidden sm:inline">{t("file_library.actions.move")}</span>
          </Popover.Button>
          <Popover.Panel side="top" align="center" positionerClassName="z-[30]">
            <div className="w-64 space-y-2 rounded-md border border-subtle bg-layer-1 p-3 shadow-raised-200">
              <FolderSelect value={moveTarget} onChange={setMoveTarget} />
              <Button variant="primary" size="base" className="w-full" onClick={handleMove} disabled={isBusy}>
                {t("file_library.actions.move_here")}
              </Button>
            </div>
          </Popover.Panel>
        </Popover>

        {/* download — single file goes straight to the asset, everything else zips */}
        {singleFile ? (
          <a href={getFileDownloadUrl(workspaceSlug, singleFile.id)} className={barButton} title={t("file_library.download")}>
            <Download className="size-3.5" />
            <span className="hidden sm:inline">{t("file_library.download")}</span>
          </a>
        ) : (
          <button type="button" className={barButton} onClick={onDownload}>
            <Download className="size-3.5" />
            <span className="hidden sm:inline">{t("file_library.download")}</span>
          </button>
        )}

        <button type="button" className={cn(barButton, "text-danger-primary")} onClick={onRequestDelete}>
          <Trash2 className="size-3.5" />
          <span className="hidden sm:inline">{t("file_library.delete")}</span>
        </button>

        <span className="mx-0.5 h-5 w-px shrink-0 bg-subtle" />
        <button type="button" className={barButton} onClick={onClear} title={t("file_library.contracts.bulk.clear")}>
          <X className="size-3.5" />
        </button>
      </div>
    </div>
  );
});
