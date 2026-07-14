/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useState } from "react";
import { FileText, Folder } from "lucide-react";
// plane imports
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TFileFolder, TLibraryFile } from "@plane/types";
import { EModalPosition, EModalWidth, ModalCore } from "@plane/ui";

type Props = {
  isOpen: boolean;
  files: TLibraryFile[];
  folders: TFileFolder[];
  onClose: () => void;
  /** Runs the delete; `contents` says what happens inside deleted folders */
  onConfirm: (contents: "detach" | "delete") => Promise<void>;
};

const PREVIEW_LIMIT = 8;

/**
 * Delete confirmation with folder safeguards: deleting folders requires
 * typing the folder name (or a confirmation word for several) and choosing
 * what happens to their contents — nothing is removed by accident.
 */
export function SafeDeleteModal(props: Props) {
  const { isOpen, files, folders, onClose, onConfirm } = props;
  const { t } = useTranslation();
  // states
  const [contents, setContents] = useState<"detach" | "delete">("detach");
  const [confirmText, setConfirmText] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Every open starts clean — a previous confirmation must not carry over
  useEffect(() => {
    if (isOpen) {
      setContents("detach");
      setConfirmText("");
    }
  }, [isOpen]);

  const total = files.length + folders.length;
  const hasFolders = folders.length > 0;
  // One folder → type its name; several → type the localized keyword
  const requiredText = hasFolders
    ? folders.length === 1
      ? folders[0].name
      : t("file_library.delete_confirm_word")
    : null;
  const isConfirmed = requiredText === null || confirmText.trim() === requiredText;

  const previewItems: { key: string; name: string; kind: "file" | "folder" }[] = [
    ...folders.map((folder) => ({ key: folder.id, name: folder.name, kind: "folder" as const })),
    ...files.map((file) => ({ key: file.id, name: file.attributes.name, kind: "file" as const })),
  ];

  const handleConfirm = async () => {
    if (!isConfirmed || isSubmitting) return;
    setIsSubmitting(true);
    try {
      await onConfirm(contents);
      onClose();
    } catch (error: any) {
      setToast({ type: TOAST_TYPE.ERROR, title: t("error"), message: error?.error ?? t("file_library.delete_failed") });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <ModalCore isOpen={isOpen} handleClose={onClose} position={EModalPosition.CENTER} width={EModalWidth.XL}>
      <div className="space-y-4 p-5">
        <h3 className="text-16 font-medium">{t("file_library.delete_selected_title", { count: total })}</h3>

        <div className="max-h-40 space-y-0.5 overflow-y-auto rounded-sm border border-subtle p-1.5">
          {previewItems.slice(0, PREVIEW_LIMIT).map((item) => (
            <p key={item.key} className="flex items-center gap-2 px-1.5 py-0.5 text-12">
              {item.kind === "folder" ? (
                <Folder className="size-3.5 shrink-0 text-tertiary" />
              ) : (
                <FileText className="size-3.5 shrink-0 text-tertiary" />
              )}
              <span className="truncate">{item.name}</span>
            </p>
          ))}
          {previewItems.length > PREVIEW_LIMIT && (
            <p className="px-1.5 py-0.5 text-11 text-tertiary">+{previewItems.length - PREVIEW_LIMIT}</p>
          )}
        </div>

        {hasFolders && (
          <div className="space-y-1.5">
            <p className="text-12 font-medium">{t("file_library.delete_contents_question")}</p>
            <label className="flex cursor-pointer items-start gap-2 text-12">
              <input
                type="radio"
                name="folder-contents"
                className="mt-0.5"
                checked={contents === "detach"}
                onChange={() => setContents("detach")}
              />
              {t("file_library.delete_contents_detach")}
            </label>
            <label className="flex cursor-pointer items-start gap-2 text-12 text-danger-primary">
              <input
                type="radio"
                name="folder-contents"
                className="mt-0.5"
                checked={contents === "delete"}
                onChange={() => setContents("delete")}
              />
              {t("file_library.delete_contents_delete")}
            </label>
          </div>
        )}

        {requiredText !== null && (
          <div className="space-y-1.5">
            <p className="text-12 text-tertiary">
              {t("file_library.delete_type_to_confirm", { name: requiredText })}
            </p>
            <input
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleConfirm();
              }}
              placeholder={requiredText}
              className="w-full rounded-sm border border-strong bg-transparent px-2 py-1.5 text-13"
            />
          </div>
        )}

        <p className="text-12 text-danger-primary">{t("file_library.bulk.delete_warning")}</p>

        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" size="lg" onClick={onClose} disabled={isSubmitting}>
            {t("close")}
          </Button>
          <Button
            variant="error-fill"
            size="lg"
            onClick={() => void handleConfirm()}
            loading={isSubmitting}
            disabled={isSubmitting || !isConfirmed}
          >
            {t("file_library.delete")}
          </Button>
        </div>
      </div>
    </ModalCore>
  );
}
