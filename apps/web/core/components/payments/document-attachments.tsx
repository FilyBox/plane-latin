/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useRef, useState } from "react";
import { Download, Paperclip, X } from "lucide-react";
import { useTranslation } from "@plane/i18n";
import { Tooltip } from "@plane/propel/tooltip";
import type { TExpenseDocument } from "@plane/types";
import { cn, convertBytesToSize, getFileExtension } from "@plane/utils";
import { fileLibraryService } from "@/services/file-library.service";
import { documentIcon } from "./document-kind";
import { DocumentViewer } from "./document-viewer";

type Props = {
  workspaceSlug: string;
  documents: TExpenseDocument[];
  disabled?: boolean;
  /** Receives the full asset list the record should end up with. */
  onChange: (assetIds: string[]) => void | Promise<void>;
};

/** The attachment block work items use: type icon, name, extension and size,
 * a drop target, and the viewer on click. Shared by the budget row and the
 * expense panels so a receipt behaves the same wherever it is reached from.
 */
export function DocumentAttachments({ workspaceSlug, documents, disabled, onChange }: Props) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [isDropping, setIsDropping] = useState(false);
  const [preview, setPreview] = useState<number | null>(null);

  const add = async (files: File[]) => {
    if (!files.length || uploading) return;
    setUploading(true);
    try {
      const assets = documents.map((document) => document.asset_id);
      // One upload at a time keeps the order of the list and avoids firing a
      // dozen multipart requests at once.
      // eslint-disable-next-line no-await-in-loop
      for (const file of files) assets.push((await fileLibraryService.uploadFile(workspaceSlug, file)).asset_id);
      await onChange(assets);
    } finally {
      setUploading(false);
    }
  };

  return (
    <>
      <div className="space-y-2">
        {documents.map((document, index) => (
          <AttachmentCard
            key={document.asset_id}
            name={document.name}
            size={document.size}
            onOpen={() => setPreview(index)}
            downloadHref={fileLibraryService.getFileDownloadUrl(workspaceSlug, document.asset_id)}
            removeDisabled={disabled || uploading}
            onRemove={() =>
              void onChange(
                documents.filter((item) => item.asset_id !== document.asset_id).map((item) => item.asset_id)
              )
            }
            removeLabel={t("payments.actions.delete")}
          />
        ))}

        <input
          ref={input}
          type="file"
          multiple
          className="hidden"
          onChange={(event) => {
            void add([...(event.target.files ?? [])]);
            event.target.value = "";
          }}
        />
        <button
          type="button"
          disabled={disabled || uploading}
          onClick={() => input.current?.click()}
          onDragOver={(event) => {
            event.preventDefault();
            setIsDropping(true);
          }}
          onDragLeave={() => setIsDropping(false)}
          onDrop={(event) => {
            event.preventDefault();
            setIsDropping(false);
            if (!disabled) void add([...event.dataTransfer.files]);
          }}
          className={cn(
            "flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed py-3 text-12 disabled:opacity-60",
            isDropping
              ? "border-accent-strong bg-accent-primary/5 text-accent-primary"
              : "border-subtle text-tertiary hover:border-accent-strong hover:text-accent-primary"
          )}
        >
          <Paperclip className="size-3.5" />
          {uploading ? t("payments.ledger.upload") : t("payments.fields.add_files")}
        </button>
      </div>

      <DocumentViewer
        workspaceSlug={workspaceSlug}
        expenseId={null}
        documents={documents}
        initialIndex={preview}
        onClose={() => setPreview(null)}
        resolveAssetUrl={(id) => fileLibraryService.getPresignedViewUrl(workspaceSlug, id)}
      />
    </>
  );
}

/** The attachment card work items use: type icon, name, extension and size,
 * with a download link and an X. Exported so a record that has not been saved
 * yet can list its queued files in the same shape.
 */
export function AttachmentCard({
  name,
  size,
  isPending = false,
  pendingLabel,
  onOpen,
  downloadHref,
  onRemove,
  removeLabel,
  removeDisabled,
}: {
  name: string;
  size: number;
  isPending?: boolean;
  pendingLabel?: string;
  onOpen?: () => void;
  downloadHref?: string;
  onRemove: () => void;
  removeLabel: string;
  removeDisabled?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex h-[60px] items-center justify-between gap-2 rounded-md border-2 border-subtle bg-surface-1 px-3 py-2",
        isPending && "border-dashed"
      )}
    >
      <button
        type="button"
        disabled={!onOpen}
        onClick={onOpen}
        className="flex min-w-0 items-center gap-3 text-left disabled:cursor-default"
      >
        <span className="size-7 shrink-0">{documentIcon(name)}</span>
        <span className="flex min-w-0 flex-col gap-1">
          <Tooltip tooltipContent={name}>
            <span className="truncate text-13 text-primary">{name}</span>
          </Tooltip>
          <span className="flex items-center gap-3 text-11 text-secondary">
            <span>{getFileExtension(name).toUpperCase()}</span>
            <span>{convertBytesToSize(size)}</span>
            {isPending && pendingLabel && <span className="text-tertiary">{pendingLabel}</span>}
          </span>
        </span>
      </button>
      <div className="flex shrink-0 items-center gap-1">
        {downloadHref && (
          <a
            href={downloadHref}
            download={name}
            aria-label={removeLabel}
            className="rounded-sm p-1 text-secondary hover:text-primary"
          >
            <Download className="size-4" />
          </a>
        )}
        <button
          type="button"
          disabled={removeDisabled}
          onClick={onRemove}
          aria-label={removeLabel}
          title={removeLabel}
          className="rounded-sm p-1 text-secondary hover:text-danger-primary"
        >
          <X className="size-4" />
        </button>
      </div>
    </div>
  );
}
