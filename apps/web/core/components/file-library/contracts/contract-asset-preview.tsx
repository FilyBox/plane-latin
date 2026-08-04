/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useMemo, useState } from "react";
import { FileWarning, Loader2, RefreshCcw } from "lucide-react";
import useSWR from "swr";
import { DocxViewerPreview, PDFViewer } from "@plane/extend-ui";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { cn } from "@plane/utils";
import { contractService } from "@/services/contract.service";
import { fileLibraryService } from "@/services/file-library.service";

type Props = {
  workspaceSlug: string;
  assetId: string;
  fileName: string;
  contentType: string;
  /** Changes whenever an asset is overwritten in place, forcing a fresh preview. */
  version?: string;
  className?: string;
};

export function ContractAssetPreview({ workspaceSlug, assetId, fileName, contentType, version, className }: Props) {
  const { t } = useTranslation();
  const [isDark, setIsDark] = useState(() =>
    typeof document !== "undefined" ? document.documentElement.dataset.theme === "dark" : false
  );
  const {
    data: url,
    error,
    isLoading,
    mutate,
  } = useSWR(
    `CONTRACT_ASSET_PREVIEW_${workspaceSlug}_${assetId}_${version ?? "LATEST"}`,
    () => fileLibraryService.getPresignedViewUrl(workspaceSlug, assetId, "contract"),
    { revalidateOnFocus: false }
  );

  const isWordSource = contentType !== "application/pdf";
  const {
    data: previewPdfBlob,
    error: previewPdfError,
    isLoading: isLoadingPreviewPdf,
    mutate: mutatePreviewPdf,
  } = useSWR(
    isWordSource ? `CONTRACT_ASSET_PREVIEW_PDF_BLOB_${workspaceSlug}_${assetId}_${version ?? "LATEST"}` : null,
    () => contractService.getContractAssetPreviewPdf(workspaceSlug, assetId, version),
    { revalidateOnFocus: false }
  );
  const previewPdfUrl = useMemo(() => (previewPdfBlob ? URL.createObjectURL(previewPdfBlob) : null), [previewPdfBlob]);

  useEffect(
    () => () => {
      if (previewPdfUrl) URL.revokeObjectURL(previewPdfUrl);
    },
    [previewPdfUrl]
  );

  const retry = () => Promise.all([mutate(), mutatePreviewPdf()]);

  if (isLoading || !url) {
    if (error) {
      return (
        <div className={cn("grid place-items-center bg-layer-1", className)}>
          <div className="text-center">
            <FileWarning className="mx-auto size-7 text-tertiary" />
            <p className="mt-2 text-13 font-medium text-primary">
              {t("file_library.contracts.workflow.preview.load_failed")}
            </p>
            <p className="mt-1 text-11 text-tertiary">{t("file_library.contracts.workflow.preview.check_available")}</p>
            <Button variant="secondary" size="sm" className="mt-3" onClick={() => void retry()}>
              <RefreshCcw className="size-3.5" /> {t("file_library.contracts.workflow.common.retry")}
            </Button>
          </div>
        </div>
      );
    }
    return (
      <div className={cn("grid place-items-center bg-layer-1", className)}>
        <Loader2 className="size-5 animate-spin text-tertiary" />
      </div>
    );
  }

  if (contentType === "application/pdf") {
    return (
      <PDFViewer
        src={url}
        fileName={fileName}
        className={className}
        showDownload={false}
        showUpload={false}
        defaultZoom={0.75}
      />
    );
  }

  // Word sources render through the API's LibreOffice conversion: the in-browser
  // .docx renderer silently drops most of the document body, which made current
  // templates look empty even though the saved thumbnail showed the real content.
  if (previewPdfUrl) {
    return (
      <PDFViewer
        src={previewPdfUrl}
        fileName={fileName}
        className={className}
        showDownload={false}
        showUpload={false}
        defaultZoom={0.75}
      />
    );
  }

  if (isLoadingPreviewPdf) {
    return (
      <div className={cn("grid place-items-center bg-layer-1", className)}>
        <Loader2 className="size-5 animate-spin text-tertiary" />
      </div>
    );
  }

  return previewPdfError ? (
    <DocxViewerPreview
      src={url}
      fileName={fileName}
      isDark={isDark}
      onIsDarkChange={setIsDark}
      showDownload={false}
      showUpload={false}
      className={className}
      defaultZoom={0.75}
    />
  ) : null;
}
