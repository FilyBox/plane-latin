/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useMemo, useState } from "react";
import type { Ref } from "react";
import { FileWarning, RefreshCcw } from "lucide-react";
import useSWR from "swr";
import { DocxViewerPreview, PDFViewer } from "@plane/extend-ui";
import type { PDFViewerHandle } from "@plane/extend-ui";
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
  /** Handle of the PDF viewer, e.g. to search text in the preview. */
  viewerRef?: Ref<PDFViewerHandle>;
};

const SKELETON_LINES = [
  { id: "l1", width: "w-3/4" },
  { id: "l2", width: "w-full" },
  { id: "l3", width: "w-5/6" },
  { id: "l4", width: "w-full" },
  { id: "l5", width: "w-2/3" },
  { id: "l6", width: "w-full" },
  { id: "l7", width: "w-4/5" },
  { id: "l8", width: "w-1/2" },
];

/** A page-shaped placeholder, optionally with a line saying what is happening. */
function PreviewSkeleton({ className, label }: { className?: string; label?: string }) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-3 bg-layer-1 p-6", className)}>
      <div
        aria-hidden
        className="aspect-[1/1.3] w-3/5 max-w-60 animate-pulse space-y-2.5 rounded-md border border-subtle bg-surface-1 p-5"
      >
        <div className="mx-auto mb-4 h-2.5 w-1/2 rounded-sm bg-layer-3" />
        {SKELETON_LINES.map((line) => (
          <div key={line.id} className={cn("h-1.5 rounded-sm bg-layer-2", line.width)} />
        ))}
      </div>
      {label ? (
        <p role="status" className="text-11 text-tertiary">
          {label}
        </p>
      ) : null}
    </div>
  );
}

export function ContractAssetPreview({
  workspaceSlug,
  assetId,
  fileName,
  contentType,
  version,
  className,
  viewerRef,
}: Props) {
  const { t } = useTranslation();
  const [isDark, setIsDark] = useState(() =>
    typeof document !== "undefined" ? document.documentElement.dataset.theme === "dark" : false
  );
  const isWordSource = contentType !== "application/pdf";

  // Word sources render through the API's LibreOffice conversion: the in-browser
  // .docx renderer silently drops most of the document body, which made current
  // templates look empty even though the saved thumbnail showed the real content.
  const {
    data: previewPdfBlob,
    error: previewPdfError,
    mutate: mutatePreviewPdf,
  } = useSWR(
    isWordSource ? `CONTRACT_ASSET_PREVIEW_PDF_BLOB_${workspaceSlug}_${assetId}_${version ?? "LATEST"}` : null,
    () => contractService.getContractAssetPreviewPdf(workspaceSlug, assetId, version),
    { revalidateOnFocus: false }
  );

  // The file's own URL: needed for PDFs, and for Word only when the conversion
  // failed and the .docx fallback has to render it.
  const needsUrl = !isWordSource || Boolean(previewPdfError);
  const {
    data: url,
    error: urlError,
    mutate,
  } = useSWR(
    needsUrl ? `CONTRACT_ASSET_PREVIEW_${workspaceSlug}_${assetId}_${version ?? "LATEST"}` : null,
    () => fileLibraryService.getPresignedViewUrl(workspaceSlug, assetId, "contract"),
    { revalidateOnFocus: false }
  );

  const previewPdfUrl = useMemo(() => (previewPdfBlob ? URL.createObjectURL(previewPdfBlob) : null), [previewPdfBlob]);

  useEffect(
    () => () => {
      if (previewPdfUrl) URL.revokeObjectURL(previewPdfUrl);
    },
    [previewPdfUrl]
  );

  const retry = () => Promise.all([needsUrl ? mutate() : undefined, isWordSource ? mutatePreviewPdf() : undefined]);

  const pdfSrc = isWordSource ? previewPdfUrl : url;
  if (pdfSrc) {
    return (
      <PDFViewer
        ref={viewerRef}
        src={pdfSrc}
        fileName={fileName}
        className={className}
        showDownload={false}
        showUpload={false}
        defaultZoom={0.75}
      />
    );
  }

  if (urlError) {
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

  // Conversion failed: fall back to the in-browser Word renderer.
  if (isWordSource && previewPdfError && url) {
    return (
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
    );
  }

  return (
    <PreviewSkeleton
      className={className}
      label={
        isWordSource && !previewPdfError ? t("file_library.contracts.workflow.use_live.generating_preview") : undefined
      }
    />
  );
}
