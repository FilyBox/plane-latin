/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * Files attached in the assistant chat.
 *
 * - Spreadsheets go to Music as import sources (for admins with Music on), so
 *   "importa este archivo" chains into read_import_file / plan_music_import.
 * - Everything else (PDF, images, documents, text) goes to the file library:
 *   it stays in the workspace, can be @-mentioned later, and the assistant
 *   reads it with read_file.
 *
 * Each upload surfaces its asset_id to the agent in a text part.
 */

import { useEffect, useRef, useState } from "react";
import {
  Download,
  FileImage,
  FileSpreadsheet,
  FileText,
  FolderSearch,
  Loader2,
  Paperclip,
  Upload,
  X,
} from "lucide-react";
import type { AttachmentAdapter, CompleteAttachment, PendingAttachment } from "@assistant-ui/react";
import { AttachmentPrimitive, ComposerPrimitive, MessagePrimitive, useAttachment, useAui } from "@assistant-ui/react";
import { useTranslation } from "@plane/i18n";
import { cn } from "@plane/utils";
// services
import { fileLibraryService } from "@/services/file-library.service";

const SHEETS = [".csv", ".xlsx", ".xlsm", ".xls"];
const ACCEPTED = [
  ...SHEETS,
  ".pdf",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".heic",
  ".heif",
  ".tif",
  ".tiff",
  ".xml",
  ".docx",
  ".txt",
  ".md",
  ".json",
  "image/*",
  "application/pdf",
  "application/xml",
  "text/*",
].join(",");

const isSheet = (name: string) => SHEETS.some((extension) => name.toLowerCase().endsWith(extension));

/** attachment id → download URL, so the sent pill can offer the file back */
const attachmentDownloadUrls = new Map<string, string>();

export class AssistantAttachmentAdapter implements AttachmentAdapter {
  accept = ACCEPTED;
  constructor(
    private workspaceSlug: string,
    private options: { musicImport: boolean; library: boolean }
  ) {}

  async add({ file }: { file: File }): Promise<PendingAttachment> {
    return {
      id: crypto.randomUUID(),
      type: file.type.startsWith("image/") ? "image" : "document",
      name: file.name,
      contentType: file.type,
      file,
      status: { type: "requires-action", reason: "composer-send" },
    };
  }

  async send(attachment: PendingAttachment): Promise<CompleteAttachment> {
    const toMusic = isSheet(attachment.name) && this.options.musicImport;
    if (!toMusic && !this.options.library) {
      throw new Error("Attachments of this kind need the file library");
    }
    const scope = toMusic ? "music" : undefined;
    const uploaded = await fileLibraryService.uploadFile(
      this.workspaceSlug,
      attachment.file,
      undefined,
      undefined,
      scope,
      toMusic ? { music_asset_kind: "IMPORT_SOURCE", upload_source: "assistant" } : { upload_source: "assistant" }
    );
    attachmentDownloadUrls.set(
      attachment.id,
      fileLibraryService.getFileDownloadUrl(this.workspaceSlug, uploaded.asset_id, scope)
    );
    const how = toMusic
      ? "Para leerlo: read_file. Para importarlo al catálogo musical: read_import_file con ese asset_id y luego plan_music_import."
      : "Para leerlo: read_file con ese asset_id.";
    return {
      ...attachment,
      status: { type: "complete" },
      // The agent reads this text part: it carries the asset_id its tools
      // need, so no extra lookup round-trip.
      content: [
        { type: "text", text: `[Archivo adjunto] nombre="${attachment.name}" asset_id=${uploaded.asset_id}. ${how}` },
      ],
    };
  }

  async remove(): Promise<void> {
    // The uploaded file stays in the workspace (it may already be referenced);
    // removing the chip only detaches it from the outgoing message.
  }
}

/** Pill for one attachment: upload states while pending, download once sent */
function AttachmentPill() {
  const { t } = useTranslation();
  const status = useAttachment((attachment) => attachment.status);
  const id = useAttachment((attachment) => attachment.id);
  const name = useAttachment((attachment) => attachment.name);
  const kind = useAttachment((attachment) => attachment.type);
  const downloadUrl = status.type === "complete" ? attachmentDownloadUrls.get(id) : undefined;
  let Icon = FileText;
  if (kind === "image") Icon = FileImage;
  else if (isSheet(name)) Icon = FileSpreadsheet;
  const body = (
    <>
      {status.type === "running" ? (
        <Loader2 className="size-3 shrink-0 animate-spin text-tertiary" />
      ) : (
        <Icon className="size-3 shrink-0 text-tertiary" />
      )}
      <span className="max-w-40 truncate">
        <AttachmentPrimitive.Name />
      </span>
    </>
  );
  return (
    <AttachmentPrimitive.Root className="group/pill flex items-center gap-1.5 rounded-full border border-subtle bg-layer-1 py-1 pr-1.5 pl-2.5 text-11">
      {downloadUrl ? (
        <a
          href={downloadUrl}
          className="flex items-center gap-1.5 hover:text-accent-primary"
          title={t("assistant.attachments.download")}
        >
          {body}
          <Download className="size-3 shrink-0 opacity-0 transition-opacity group-hover/pill:opacity-100" />
        </a>
      ) : (
        body
      )}
      {status.type !== "complete" && (
        <AttachmentPrimitive.Remove
          className="rounded-full p-0.5 text-tertiary hover:bg-layer-1-hover"
          aria-label={t("assistant.attachments.remove")}
        >
          <X className="size-3" />
        </AttachmentPrimitive.Remove>
      )}
    </AttachmentPrimitive.Root>
  );
}

export function ComposerAttachmentsRow() {
  return (
    <ComposerPrimitive.Attachments
      components={{ Attachment: AttachmentPill, Image: AttachmentPill, Document: AttachmentPill, File: AttachmentPill }}
    />
  );
}

export function MessageAttachmentsRow() {
  return (
    <MessagePrimitive.Attachments
      components={{ Attachment: AttachmentPill, Image: AttachmentPill, Document: AttachmentPill, File: AttachmentPill }}
    />
  );
}

/**
 * The paperclip: upload from the computer or pick a file already in the
 * workspace (opens the @ picker on Files). A real file input inside a label
 * opens the system dialog more reliably than a programmatic click.
 */
export function AttachMenu({
  allowUpload,
  onPickFromWorkspace,
  className,
}: {
  allowUpload: boolean;
  onPickFromWorkspace: () => void;
  className: string;
}) {
  const { t } = useTranslation();
  const aui = useAui();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  const item = "flex w-full items-center gap-2 px-3 py-1.5 text-left text-12 text-secondary hover:bg-layer-1-hover";
  return (
    <div ref={root} className="relative">
      <button
        type="button"
        className={className}
        title={t("assistant.composer.attach")}
        aria-label={t("assistant.composer.attach")}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Paperclip className="size-4" />
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-20 mb-1.5 w-56 overflow-hidden rounded-lg border border-subtle bg-surface-1 py-1 shadow-raised-200">
          {allowUpload && (
            <label className={cn(item, "cursor-pointer")}>
              <Upload className="size-3.5 shrink-0 text-tertiary" aria-hidden />
              {t("assistant.attachments.upload")}
              <input
                type="file"
                multiple
                accept={ACCEPTED}
                className="sr-only"
                onChange={(event) => {
                  const files = Array.from(event.target.files ?? []);
                  event.target.value = "";
                  setOpen(false);
                  for (const file of files) void aui.composer().addAttachment(file);
                }}
              />
            </label>
          )}
          <button
            type="button"
            className={item}
            onClick={() => {
              setOpen(false);
              onPickFromWorkspace();
            }}
          >
            <FolderSearch className="size-3.5 shrink-0 text-tertiary" aria-hidden />
            {t("assistant.attachments.pick")}
          </button>
        </div>
      )}
    </div>
  );
}
