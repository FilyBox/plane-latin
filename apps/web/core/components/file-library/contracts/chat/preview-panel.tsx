/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * Side preview for a document the agent cited. Opening a citation used to mean
 * leaving the conversation for the contracts list; here the PDF and the fields
 * the AI extracted from it sit next to the answer, so the user can check a
 * claim without losing their place in the chat.
 */

import { useState } from "react";
import { ExternalLink, FileText, Loader2, X } from "lucide-react";
import useSWR from "swr";
// plane imports
import { useTranslation } from "@plane/i18n";
import type { TContract } from "@plane/types";
import { cn } from "@plane/utils";
// services
import { contractService } from "@/services/contract.service";
import { fileLibraryService } from "@/services/file-library.service";
// local imports
import { ContractAssetPreview } from "../contract-asset-preview";

type Props = {
  workspaceSlug: string;
  contractId: string;
  onClose: () => void;
  /** Jumps to the contract's own peek view */
  onOpenContract?: (contractId: string) => void;
};

type Tab = "document" | "info";

/** Extracted fields worth showing beside the document */
const INFO_FIELDS: { key: keyof TContract; i18nKey: string }[] = [
  { key: "resumen_general", i18nKey: "file_library.contracts.fields.resumen_general" },
  { key: "nombre_grupo", i18nKey: "file_library.contracts.fields.nombre_grupo" },
  { key: "artistas", i18nKey: "file_library.contracts.fields.artistas" },
  { key: "involucrados", i18nKey: "file_library.contracts.fields.involucrados" },
  { key: "testigos", i18nKey: "file_library.contracts.fields.testigos" },
  { key: "fecha_inicio", i18nKey: "file_library.contracts.fields.fecha_inicio" },
  { key: "fecha_fin", i18nKey: "file_library.contracts.fields.fecha_fin" },
  { key: "fecha_fin_efectiva", i18nKey: "file_library.contracts.fields.fecha_fin_efectiva" },
  { key: "estatus_contrato", i18nKey: "file_library.contracts.fields.estatus_contrato" },
  { key: "tipo_contrato", i18nKey: "file_library.contracts.fields.tipo_contrato" },
];

export function ContractChatPreviewPanel({ workspaceSlug, contractId, onClose, onOpenContract }: Props) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>("document");

  const { data: contract, isLoading } = useSWR(
    `CONTRACT_CHAT_PREVIEW_${workspaceSlug}_${contractId}`,
    () => contractService.getContract(workspaceSlug, contractId),
    { revalidateOnFocus: false }
  );

  const fileName = contract?.file_name || contract?.titulo || "";

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-surface-1">
      <div className="flex shrink-0 items-center gap-2 border-b border-subtle px-3 py-2">
        <FileText className="size-4 shrink-0 text-danger-primary" />
        <p className="min-w-0 flex-1 truncate text-12 font-medium" title={contract?.titulo || fileName}>
          {contract?.titulo || fileName || t("file_library.contracts.chat.preview_document")}
        </p>
        {contract?.file_asset_id && (
          <a
            href={fileLibraryService.getFileViewUrl(workspaceSlug, contract.file_asset_id, "contract")}
            target="_blank"
            rel="noreferrer"
            className="rounded-sm p-1 text-tertiary hover:bg-layer-1-hover hover:text-primary"
            title={t("file_library.contracts.chat.open_document")}
          >
            <ExternalLink className="size-3.5" />
          </a>
        )}
        <button
          type="button"
          onClick={onClose}
          className="rounded-sm p-1 text-tertiary hover:bg-layer-1-hover hover:text-primary"
          title={t("common.close")}
        >
          <X className="size-3.5" />
        </button>
      </div>

      <div className="flex shrink-0 items-center gap-1 border-b border-subtle px-2 py-1">
        {(["document", "info"] as Tab[]).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={cn(
              "rounded-sm px-2 py-1 text-11 font-medium transition-colors",
              tab === key ? "bg-layer-1 text-primary" : "text-tertiary hover:bg-layer-1-hover"
            )}
          >
            {t(`file_library.contracts.tabs.${key}`)}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {isLoading && (
          <div className="grid h-full place-items-center">
            <Loader2 className="size-5 animate-spin text-tertiary" />
          </div>
        )}
        {!isLoading && contract && tab === "document" && contract.file_asset_id && (
          <ContractAssetPreview
            workspaceSlug={workspaceSlug}
            assetId={contract.file_asset_id}
            fileName={fileName}
            contentType="application/pdf"
            className="h-full w-full"
          />
        )}
        {!isLoading && contract && tab === "info" && (
          <div className="h-full space-y-2.5 overflow-y-auto p-3">
            {INFO_FIELDS.map(({ key, i18nKey }) => {
              const value = contract[key];
              if (value === null || value === undefined || value === "") return null;
              return (
                <div key={String(key)}>
                  <p className="text-10 font-medium tracking-wide text-tertiary uppercase">{t(i18nKey)}</p>
                  <p className="mt-0.5 text-12 break-words text-secondary">{String(value)}</p>
                </div>
              );
            })}
            {onOpenContract && (
              <button
                type="button"
                onClick={() => onOpenContract(contractId)}
                className="mt-2 w-full rounded-md border border-subtle px-2 py-1.5 text-11 text-secondary hover:bg-layer-1-hover hover:text-accent-primary"
              >
                {t("file_library.contracts.open_in_contracts")}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
