/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * Chat attachments: dropped/picked files upload to the workspace file
 * library and surface their `asset_id` to the agent, so "importa este
 * archivo" chains straight into the `propose_music_import` tool without a
 * separate upload step.
 */

import { FileSpreadsheet, Loader2, X } from "lucide-react";
import type { AttachmentAdapter, CompleteAttachment, PendingAttachment } from "@assistant-ui/react";
import { AttachmentPrimitive, ComposerPrimitive, MessagePrimitive, useAttachment } from "@assistant-ui/react";
// services
import { fileLibraryService } from "@/services/file-library.service";

/** Spreadsheets (music imports) plus PDFs/text the model may want referenced */
const ACCEPTED =
  ".csv,.xlsx,.xlsm,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

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
    const uploaded = await fileLibraryService.uploadFile(this.workspaceSlug, attachment.file);
    return {
      ...attachment,
      status: { type: "complete" },
      // The agent reads this text part: it carries the asset_id the
      // propose_music_import tool needs, so no extra lookup round-trip.
      content: [
        {
          type: "text",
          text: `[Archivo adjunto subido a la biblioteca] nombre="${attachment.name}" asset_id=${uploaded.asset_id}. Si el usuario quiere importarlo al catálogo musical, usa propose_music_import con ese asset_id (primero mode=read).`,
        },
      ],
    };
  }

  async remove(): Promise<void> {
    // The uploaded file stays in the library (it may already be referenced);
    // removing the chip only detaches it from the outgoing message.
  }
}

/** Pill for one attachment (composer + sent message), with upload states */
function AttachmentPill() {
  const status = useAttachment((attachment) => attachment.status);
  const canRemove = status.type !== "complete";
  return (
    <AttachmentPrimitive.Root className="flex items-center gap-1.5 rounded-full border border-subtle bg-layer-1 py-1 pr-1.5 pl-2.5 text-11">
      {status.type === "running" ? (
        <Loader2 className="size-3 shrink-0 animate-spin text-tertiary" />
      ) : (
        <FileSpreadsheet className="size-3 shrink-0 text-tertiary" />
      )}
      <span className="max-w-40 truncate">
        <AttachmentPrimitive.Name />
      </span>
      {canRemove && (
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
