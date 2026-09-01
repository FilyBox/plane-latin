/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * Document citation card, modelled on assistant-ui's DocumentReference element
 * (https://www.assistant-ui.com/elements/document-reference) and rebuilt on
 * the repo's design system.
 *
 * assistant-ui's version anchors quotes to page numbers; contracts are
 * chunk-indexed rather than paginated, so the anchors here are the passages
 * the agent actually quoted. The three actions are the point of the card: the
 * old chat listed document names the user could not open, so every card gets
 * preview (side panel), open (new tab) and download.
 */

import { createContext, useContext } from "react";
import { motion } from "framer-motion";
import { Download, ExternalLink, FileText, PanelRightOpen, Quote } from "lucide-react";
// plane imports
import { useTranslation } from "@plane/i18n";
import type { TContractAgentDocument } from "@plane/types";
import { cn } from "@plane/utils";
// services
import { fileLibraryService } from "@/services/file-library.service";

/** Workspace + navigation the cards need; provided by the chat panel. */
export const ContractDocumentContext = createContext<{
  workspaceSlug: string;
  /** Opens the document in the chat's side preview */
  onPreview?: (contractId: string) => void;
  /** Leaves the chat for the contract's own peek view */
  onOpenContract?: (contractId: string) => void;
}>({ workspaceSlug: "" });

type Props = {
  document: TContractAgentDocument;
  index?: number;
};

const META_SEPARATOR = " · ";

export function ContractDocumentCard({ document, index = 0 }: Props) {
  const { t } = useTranslation();
  const { workspaceSlug, onPreview, onOpenContract } = useContext(ContractDocumentContext);

  const title = document.title || document.file_name || document.contract_id.slice(0, 8);
  const highlights = (document.highlights ?? []).filter((quote): quote is string => Boolean(quote));
  const meta = [
    document.file_name && document.title ? document.file_name : null,
    document.tipo_contrato,
    document.fecha_inicio || document.fecha_fin
      ? `${document.fecha_inicio ?? "?"} → ${document.fecha_fin ?? "?"}`
      : null,
    document.estatus_contrato && document.estatus_contrato !== "NO_ESPECIFICADO" ? document.estatus_contrato : null,
  ].filter(Boolean);

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, delay: Math.min(index, 6) * 0.04, ease: "easeOut" }}
      className="overflow-hidden rounded-lg border border-subtle bg-layer-1"
    >
      <div className="flex items-start gap-2.5 p-2.5">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-danger-subtle">
          <FileText className="size-3.5 text-danger-primary" />
        </span>
        <div className="min-w-0 flex-1">
          <button
            type="button"
            onClick={() => onPreview?.(document.contract_id)}
            className="block w-full truncate text-left text-12 font-medium text-primary hover:text-accent-primary"
            title={title}
          >
            {title}
          </button>
          {meta.length > 0 && (
            <p className="truncate text-11 text-tertiary" title={meta.join(META_SEPARATOR)}>
              {meta.join(META_SEPARATOR)}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {onPreview && (
            <button
              type="button"
              onClick={() => onPreview(document.contract_id)}
              className="rounded-sm p-1 text-tertiary hover:bg-layer-1-hover hover:text-primary"
              title={t("file_library.contracts.chat.preview_document")}
            >
              <PanelRightOpen className="size-3.5" />
            </button>
          )}
          {document.asset_id && (
            <>
              <a
                href={fileLibraryService.getFileViewUrl(workspaceSlug, document.asset_id, "contract")}
                target="_blank"
                rel="noreferrer"
                className="rounded-sm p-1 text-tertiary hover:bg-layer-1-hover hover:text-primary"
                title={t("file_library.contracts.chat.open_document")}
              >
                <ExternalLink className="size-3.5" />
              </a>
              <a
                href={fileLibraryService.getFileDownloadUrl(workspaceSlug, document.asset_id, "contract")}
                className="rounded-sm p-1 text-tertiary hover:bg-layer-1-hover hover:text-primary"
                title={t("file_library.download")}
              >
                <Download className="size-3.5" />
              </a>
            </>
          )}
        </div>
      </div>

      {highlights.length > 0 && (
        <ul className="border-t border-subtle">
          {highlights.map((quote) => (
            <li key={`${document.contract_id}-${quote}`}>
              <button
                type="button"
                onClick={() => onPreview?.(document.contract_id)}
                className="flex w-full items-start gap-2 px-2.5 py-1.5 text-left hover:bg-layer-1-hover"
              >
                <Quote className="mt-0.5 size-3 shrink-0 text-tertiary" />
                <span className="min-w-0 text-11 leading-snug break-words text-secondary">{quote}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {onOpenContract && (
        <button
          type="button"
          onClick={() => onOpenContract(document.contract_id)}
          className="w-full border-t border-subtle px-2.5 py-1.5 text-left text-11 text-tertiary hover:bg-layer-1-hover hover:text-accent-primary"
        >
          {t("file_library.contracts.open_in_contracts")}
        </button>
      )}
    </motion.div>
  );
}

/** The `show_documents` tool result: a labelled stack of citation cards. */
export function ContractDocumentList({
  documents,
  note,
  className,
}: {
  documents: TContractAgentDocument[];
  note?: string | null;
  className?: string;
}) {
  const { t } = useTranslation();
  if (documents.length === 0) return null;
  return (
    <div className={cn("my-2 space-y-1.5", className)}>
      <p className="text-11 font-medium text-tertiary">{note || t("file_library.contracts.chat.sources_used")}</p>
      {documents.map((document, index) => (
        <ContractDocumentCard key={document.contract_id} document={document} index={index} />
      ))}
    </div>
  );
}
