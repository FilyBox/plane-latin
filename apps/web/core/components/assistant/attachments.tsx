/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * Spreadsheet attachments are Music-owned assets and surface their `asset_id` to the
 * agent, so "importa este archivo" chains straight into the
 * `propose_music_import` tool without a separate upload step.
 */

import { Download, FileSpreadsheet, Loader2, X } from "lucide-react";
import type { AttachmentAdapter, CompleteAttachment, PendingAttachment } from "@assistant-ui/react";
import { AttachmentPrimitive, ComposerPrimitive, MessagePrimitive, useAttachment } from "@assistant-ui/react";
// services
import { fileLibraryService } from "@/services/file-library.service";

/** Spreadsheets (music imports) — the import pipeline reads CSV/XLSX */
const ACCEPTED =
  ".csv,.xlsx,.xlsm,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** attachment id → download URL, so the sent pill can offer the file back */
const attachmentDownloadUrls = new Map<string, string>();

export class FileLibraryAttachmentAdapter implements AttachmentAdapter {
  accept = ACCEPTED;
  constructor(private workspaceSlug: string) {}

  async add({ file }: { file: File }): Promise<PendingAttachment> {
    return {
      id: crypto.randomUUID(),
      type: "document",
      name: file.name,
      contentType: file.type,
      file,
      status: { type: "requires-action", reason: "composer-send" },
    };
  }

  async send(attachment: PendingAttachment): Promise<CompleteAttachment> {
    const uploaded = await fileLibraryService.uploadFile(
      this.workspaceSlug,
      attachment.file,
      undefined,
      undefined,
      "music"
    );
    attachmentDownloadUrls.set(
      attachment.id,
      fileLibraryService.getFileDownloadUrl(this.workspaceSlug, uploaded.asset_id, "music")
    );
    return {
      ...attachment,
      status: { type: "complete" },
      // The agent reads this text part: it carries the asset_id the
      // propose_music_import tool needs, so no extra lookup round-trip.
      content: [
        {
          type: "text",
          text: `[Archivo adjunto interno de Music] nombre="${attachment.name}" asset_id=${uploaded.asset_id}. Para importarlo al catálogo musical, usa propose_music_import con ese asset_id (primero mode=read).`,
        },
      ],
    };
  }

  async remove(): Promise<void> {
    // The uploaded file stays in the library (it may already be referenced);
    // removing the chip only detaches it from the outgoing message.
  }
}

/** Pill for one attachment: upload states while pending, download once sent */
function AttachmentPill() {
  const status = useAttachment((attachment) => attachment.status);
  const id = useAttachment((attachment) => attachment.id);
  const downloadUrl = status.type === "complete" ? attachmentDownloadUrls.get(id) : undefined;
  const body = (
    <>
      {status.type === "running" ? (
        <Loader2 className="size-3 shrink-0 animate-spin text-tertiary" />
      ) : (
        <FileSpreadsheet className="size-3 shrink-0 text-tertiary" />
      )}
      <span className="max-w-40 truncate">
        <AttachmentPrimitive.Name />
      </span>
    </>
  );
  return (
    <AttachmentPrimitive.Root className="group/pill flex items-center gap-1.5 rounded-full border border-subtle bg-layer-1 py-1 pr-1.5 pl-2.5 text-11">
      {downloadUrl ? (
        <a href={downloadUrl} className="flex items-center gap-1.5 hover:text-accent-primary" title="Descargar archivo">
          {body}
          <Download className="size-3 shrink-0 opacity-0 transition-opacity group-hover/pill:opacity-100" />
        </a>
      ) : (
        body
      )}
      {status.type !== "complete" && (
        <AttachmentPrimitive.Remove className="rounded-full p-0.5 text-tertiary hover:bg-layer-1-hover">
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
