import { useEffect, useState } from "react";
import useSWR from "swr";
import { Check, Download, Eye, FileSpreadsheet, Search, Trash2 } from "lucide-react";
import { Button } from "@plane/propel/button";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TMusicImportAsset } from "@plane/types";
import { AlertModalCore } from "@plane/ui";
import { FilePreviewModal, type TPreviewFile } from "../file-library/file-preview-modal";
import { BudgetPeekPanel } from "../payments/budget-peek-panel";
import { fileLibraryService } from "@/services/file-library.service";
import { musicService } from "@/services/music.service";
import { getApiError, MUSIC_FIELD } from "./shared";

type Props = {
  workspaceSlug: string;
  isOpen: boolean;
  onClose: () => void;
};

const formatSize = (size: number) => {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
};

export function MusicImportAssetsPanel({ workspaceSlug, isOpen, onClose }: Props) {
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [previewFile, setPreviewFile] = useState<TPreviewFile | null>(null);
  const [deleteIds, setDeleteIds] = useState<string[]>([]);
  const [isDeleting, setIsDeleting] = useState(false);
  const { data, mutate, isLoading } = useSWR(
    isOpen ? `MUSIC_IMPORT_ASSETS_${workspaceSlug}_${search}` : null,
    () => musicService.getImportAssets(workspaceSlug, search),
    { keepPreviousData: true, revalidateOnFocus: false }
  );
  const assets = data?.results ?? [];

  useEffect(() => {
    if (!isOpen) return;
    setSearch("");
    setSelectedIds([]);
  }, [isOpen]);

  const toggle = (id: string) =>
    setSelectedIds((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));

  const download = (items: TMusicImportAsset[]) => {
    for (const asset of items) {
      const anchor = document.createElement("a");
      anchor.href = fileLibraryService.getFileDownloadUrl(workspaceSlug, asset.id, "music");
      anchor.download = asset.name;
      anchor.click();
    }
  };

  const remove = async () => {
    if (!deleteIds.length) return;
    setIsDeleting(true);
    try {
      const result = await musicService.deleteImportAssets(workspaceSlug, deleteIds);
      setSelectedIds((current) => current.filter((id) => !deleteIds.includes(id)));
      setDeleteIds([]);
      await mutate();
      setToast({
        type: TOAST_TYPE.SUCCESS,
        title: `${result.deleted} archivo${result.deleted === 1 ? "" : "s"} eliminado${result.deleted === 1 ? "" : "s"}`,
      });
    } catch (error) {
      setToast({ type: TOAST_TYPE.ERROR, title: "No se pudieron eliminar los archivos", message: getApiError(error) });
    } finally {
      setIsDeleting(false);
    }
  };

  if (!isOpen) return null;
  const selectedAssets = assets.filter((asset) => selectedIds.includes(asset.id));
  const allSelected = assets.length > 0 && assets.every((asset) => selectedIds.includes(asset.id));

  return (
    <BudgetPeekPanel
      title="Archivos de importación"
      description="Fuentes CSV y Excel conservadas por Music. Puedes revisarlas, descargarlas o eliminarlas sin afectar Files."
      onClose={onClose}
    >
      <div className="flex h-full min-h-0 flex-col bg-surface-1">
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-subtle p-4">
          <div className="relative min-w-52 flex-1">
            <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-tertiary" />
            <input
              className={`${MUSIC_FIELD} pl-9`}
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setSelectedIds([]);
              }}
              placeholder="Buscar por nombre…"
            />
          </div>
          <Button
            variant="secondary"
            size="sm"
            disabled={!assets.length}
            onClick={() => setSelectedIds(allSelected ? [] : assets.map((asset) => asset.id))}
          >
            {allSelected ? "Limpiar selección" : "Seleccionar todos"}
          </Button>
          {selectedAssets.length > 0 && (
            <>
              <Button variant="secondary" size="sm" onClick={() => download(selectedAssets)}>
                <Download className="size-3.5" /> Descargar {selectedAssets.length}
              </Button>
              <Button variant="error-fill" size="sm" onClick={() => setDeleteIds(selectedIds)}>
                <Trash2 className="size-3.5" /> Eliminar {selectedAssets.length}
              </Button>
            </>
          )}
        </div>

        <div className="vertical-scrollbar min-h-0 flex-1 overflow-y-auto p-4">
          {isLoading && !data ? (
            <p className="py-12 text-center text-12 text-tertiary">Cargando archivos…</p>
          ) : assets.length === 0 ? (
            <div className="rounded-xl border border-dashed border-subtle py-14 text-center">
              <FileSpreadsheet className="mx-auto size-8 text-tertiary" />
              <p className="mt-2 text-13 font-medium">No hay archivos de importación</p>
              <p className="mt-1 text-11 text-tertiary">
                Los archivos subidos manualmente o por el agente aparecerán aquí.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {assets.map((asset) => {
                const selected = selectedIds.includes(asset.id);
                return (
                  <div
                    key={asset.id}
                    className={`flex items-center gap-3 rounded-lg border p-3 ${selected ? "border-accent-primary bg-accent-primary/5" : "border-subtle bg-layer-1"}`}
                  >
                    <button
                      type="button"
                      onClick={() => toggle(asset.id)}
                      className={`grid size-5 shrink-0 place-items-center rounded border ${selected ? "border-accent-primary bg-accent-primary text-on-color" : "border-strong"}`}
                      aria-label={`Seleccionar ${asset.name}`}
                    >
                      {selected && <Check className="size-3" />}
                    </button>
                    <FileSpreadsheet className="size-5 shrink-0 text-success-primary" />
                    <button
                      type="button"
                      className="min-w-0 flex-1 text-left"
                      onClick={() =>
                        setPreviewFile({ assetId: asset.id, name: asset.name, contentType: asset.content_type })
                      }
                    >
                      <p className="truncate text-12 font-medium">{asset.name}</p>
                      <p className="mt-0.5 text-10 text-tertiary">
                        {formatSize(asset.size)} ·{" "}
                        {asset.upload_source === "assistant" ? "Agente" : "Importador manual"} ·{" "}
                        {new Date(asset.created_at).toLocaleString()}
                      </p>
                    </button>
                    <button
                      type="button"
                      className="rounded p-1.5 text-secondary hover:bg-layer-2"
                      onClick={() =>
                        setPreviewFile({ assetId: asset.id, name: asset.name, contentType: asset.content_type })
                      }
                      title="Previsualizar"
                    >
                      <Eye className="size-4" />
                    </button>
                    <a
                      href={fileLibraryService.getFileDownloadUrl(workspaceSlug, asset.id, "music")}
                      className="rounded p-1.5 text-secondary hover:bg-layer-2"
                      title="Descargar"
                    >
                      <Download className="size-4" />
                    </a>
                    <button
                      type="button"
                      className="rounded p-1.5 text-secondary hover:bg-danger-subtle hover:text-danger-primary"
                      onClick={() => setDeleteIds([asset.id])}
                      title="Eliminar"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
      <FilePreviewModal
        workspaceSlug={workspaceSlug}
        file={previewFile}
        scope="music"
        onClose={() => setPreviewFile(null)}
      />
      <AlertModalCore
        isOpen={deleteIds.length > 0}
        isSubmitting={isDeleting}
        handleClose={() => setDeleteIds([])}
        handleSubmit={() => void remove()}
        title={`¿Eliminar ${deleteIds.length} archivo${deleteIds.length === 1 ? "" : "s"}?`}
        content="Los archivos dejarán de estar disponibles para nuevas importaciones y para el agente. Los registros musicales ya importados no se eliminarán. Esta acción no se puede deshacer."
      />
    </BudgetPeekPanel>
  );
}
