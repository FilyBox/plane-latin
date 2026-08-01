/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import { FileWarning, Loader2, RefreshCcw } from "lucide-react";
import useSWR from "swr";
import { DocxViewerPreview, PDFViewer } from "@plane/extend-ui";
import { Button } from "@plane/propel/button";
import { cn } from "@plane/utils";
import { fileLibraryService } from "@/services/file-library.service";

type Props = {
  workspaceSlug: string;
  assetId: string;
  fileName: string;
  contentType: string;
  className?: string;
};

export function ContractAssetPreview({ workspaceSlug, assetId, fileName, contentType, className }: Props) {
  const [isDark, setIsDark] = useState(() =>
    typeof document !== "undefined" ? document.documentElement.dataset.theme === "dark" : false
  );
  const {
    data: url,
    error,
    isLoading,
    mutate,
  } = useSWR(
    `CONTRACT_ASSET_PREVIEW_${workspaceSlug}_${assetId}`,
    () => fileLibraryService.getPresignedViewUrl(workspaceSlug, assetId, "contract"),
    { revalidateOnFocus: false }
  );

  if (isLoading || !url) {
    if (error) {
      return (
        <div className={cn("grid place-items-center bg-layer-1", className)}>
          <div className="text-center">
            <FileWarning className="mx-auto size-7 text-tertiary" />
            <p className="mt-2 text-11 font-medium text-primary">No se pudo cargar la vista previa</p>
            <p className="mt-1 text-9 text-tertiary">Comprueba que el archivo siga disponible.</p>
            <Button variant="secondary" size="sm" className="mt-3" onClick={() => void mutate()}>
              <RefreshCcw className="size-3.5" /> Reintentar
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
