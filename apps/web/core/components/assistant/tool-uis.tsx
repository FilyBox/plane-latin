/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * Tool-call renderers for the workspace assistant. Server tools return data
 * or proposals; anything that mutates is applied HERE through the user's own
 * session (Django REST), never by the model.
 */

import { useState } from "react";
import { Check, Download, FileSpreadsheet, FileText, Loader2, Music2, Search } from "lucide-react";
import { makeAssistantToolUI } from "@assistant-ui/react";
// plane imports
import { API_BASE_URL } from "@plane/constants";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";

const card = "my-2 rounded-md border border-subtle bg-layer-1 p-3 text-13";

const Running = ({ label }: { label: string }) => (
  <p className={`${card} flex items-center gap-2 text-tertiary`}>
    <Loader2 className="size-3.5 animate-spin" /> {label}
  </p>
);

type TTrackRow = {
  id: string;
  title: string;
  version: string | null;
  isrc: string | null;
  release_date: string | null;
  artists: string[];
  videos: { title: string; release_date: string | null; urls: string[] }[];
};

export const QueryMusicTracksToolUI = makeAssistantToolUI<Record<string, unknown>, { total: number; returned: number; results: TTrackRow[] }>({
  toolName: "query_music_tracks",
  render: ({ result }) => {
    if (!result) return <Running label="Consultando el catálogo…" />;
    return (
      <div className={card}>
        <p className="mb-1.5 flex items-center gap-1.5 font-medium">
          <Music2 className="size-3.5 text-tertiary" />
          {result.total} canciones {result.total > result.returned ? `(mostrando ${result.returned})` : ""}
        </p>
        {result.results.length > 0 && (
          <div className="max-h-64 overflow-auto rounded-sm border border-subtle">
            <table className="w-full text-12">
              <thead className="sticky top-0 bg-layer-1">
                <tr className="text-left text-tertiary">
                  <th className="px-2 py-1 font-medium">Canción</th>
                  <th className="px-2 py-1 font-medium">Artistas</th>
                  <th className="px-2 py-1 font-medium">ISRC</th>
                  <th className="px-2 py-1 font-medium">Lanzamiento</th>
                  <th className="px-2 py-1 font-medium">Videos</th>
                </tr>
              </thead>
              <tbody>
                {result.results.map((track) => (
                  <tr key={track.id} className="border-t border-subtle">
                    <td className="px-2 py-1">{track.title}{track.version ? ` (${track.version})` : ""}</td>
                    <td className="px-2 py-1">{track.artists.join(", ")}</td>
                    <td className="px-2 py-1 font-mono text-11">{track.isrc ?? "—"}</td>
                    <td className="px-2 py-1">{track.release_date ?? "—"}</td>
                    <td className="px-2 py-1">{track.videos.length || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  },
});

export const ExportMusicExcelToolUI = makeAssistantToolUI<
  Record<string, unknown>,
  { count: number; params: Record<string, string>; workspace_slug: string }
>({
  toolName: "export_music_excel",
  render: ({ result }) => {
    if (!result) return <Running label="Preparando el reporte…" />;
    const query = new URLSearchParams({ ...result.params, format: "xlsx" });
    const href = `${API_BASE_URL}/api/workspaces/${result.workspace_slug}/music/reports/?${query}`;
    return (
      <div className={`${card} flex items-center justify-between gap-3`}>
        <p className="flex items-center gap-1.5">
          <FileSpreadsheet className="size-4 text-success-primary" />
          Reporte listo · {result.count} canciones
        </p>
        <a
          href={href}
          className="flex shrink-0 items-center gap-1.5 rounded-sm bg-accent-primary px-2.5 py-1.5 text-12 font-medium text-on-color hover:opacity-90"
        >
          <Download className="size-3.5" /> Descargar Excel
        </a>
      </div>
    );
  },
});

export const SearchContractsToolUI = makeAssistantToolUI<
  { query: string },
  { sources: { contract_id: string; title: string | null; file_name: string | null }[] }
>({
  toolName: "search_contracts",
  render: ({ args, result }) => {
    if (!result) return <Running label={`Buscando en contratos: ${args.query ?? ""}…`} />;
    if (!result.sources?.length) return null;
    return (
      <div className={`${card} flex flex-wrap items-center gap-1.5`}>
        <Search className="size-3.5 text-tertiary" />
        {result.sources.map((source) => (
          <span key={source.contract_id} className="flex items-center gap-1 rounded-full border border-subtle px-2 py-0.5 text-11">
            <FileText className="size-3 text-tertiary" />
            {source.title || source.file_name || source.contract_id.slice(0, 8)}
          </span>
        ))}
      </div>
    );
  },
});

export const ListMusicFilesToolUI = makeAssistantToolUI<
  { search?: string },
  { results: { asset_id: string; name: string | null }[] }
>({
  toolName: "list_music_files",
  render: ({ result }) => {
    if (!result) return <Running label="Buscando archivos…" />;
    return (
      <p className={`${card} text-tertiary`}>
        {result.results.length} archivo(s) encontrados{result.results.length > 0 ? `: ${result.results.slice(0, 5).map((file) => file.name).join(", ")}` : ""}
      </p>
    );
  },
});

type TImportProposal = {
  total?: number;
  created?: number;
  updated?: number;
  skipped?: number;
  errors?: { row: number; message: string }[];
  dry_run?: boolean;
  headers?: string[];
  proposal?: { asset_id: string; sheet: string | null; mapping: Record<string, string>; duplicate_strategy: string };
};

function ImportProposalCard({ result, workspaceSlug }: { result: TImportProposal; workspaceSlug: string }) {
  const [state, setState] = useState<"idle" | "applying" | "done">("idle");
  const [applied, setApplied] = useState<TImportProposal | null>(null);

  // mode=read result (no proposal yet): the model is still reasoning the mapping
  if (!result.proposal) {
    if (result.headers) {
      return <p className={`${card} text-tertiary`}>Archivo leído: {result.headers.length} columnas, {result.total ?? "?"} filas. Analizando mapeo…</p>;
    }
    return null;
  }

  const apply = async () => {
    setState("applying");
    try {
      const response = await fetch(
        `${API_BASE_URL}/api/workspaces/${workspaceSlug}/assistant/music-import/`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...result.proposal, dry_run: false }),
        }
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error ?? "Import failed");
      setApplied(data);
      setState("done");
      setToast({ type: TOAST_TYPE.SUCCESS, title: "Importación aplicada", message: `${data.created} creadas · ${data.updated} actualizadas` });
    } catch (error: unknown) {
      setState("idle");
      setToast({ type: TOAST_TYPE.ERROR, title: "Error", message: error instanceof Error ? error.message : "Import failed" });
    }
  };

  const summary = applied ?? result;
  return (
    <div className={card}>
      <p className="mb-1 font-medium">Propuesta de importación {applied ? "(aplicada)" : "(simulación)"}</p>
      <p className="text-12 text-secondary">
        {summary.total} filas → {summary.created} nuevas · {summary.updated} actualizadas · {summary.skipped} omitidas
        {summary.errors && summary.errors.length > 0 ? ` · ${summary.errors.length} errores` : ""}
      </p>
      {summary.errors && summary.errors.length > 0 && (
        <ul className="mt-1 max-h-24 overflow-y-auto text-11 text-danger-primary">
          {summary.errors.slice(0, 5).map((error) => (
            <li key={error.row}>Fila {error.row}: {error.message}</li>
          ))}
        </ul>
      )}
      <details className="mt-1 text-11 text-tertiary">
        <summary className="cursor-pointer">Mapeo de columnas</summary>
        <ul>
          {Object.entries(result.proposal.mapping).map(([field, column]) => (
            <li key={field}><span className="font-mono">{field}</span> ← {column}</li>
          ))}
        </ul>
      </details>
      {!applied && (
        <button
          type="button"
          disabled={state === "applying"}
          onClick={() => void apply()}
          className="mt-2 flex items-center gap-1.5 rounded-sm bg-accent-primary px-2.5 py-1.5 text-12 font-medium text-on-color hover:opacity-90 disabled:opacity-60"
        >
          {state === "applying" ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
          Aplicar importación
        </button>
      )}
    </div>
  );
}

export const buildProposeMusicImportToolUI = (workspaceSlug: string) =>
  makeAssistantToolUI<Record<string, unknown>, TImportProposal>({
    toolName: "propose_music_import",
    render: ({ result }) => {
      if (!result) return <Running label="Procesando el archivo…" />;
      return <ImportProposalCard result={result} workspaceSlug={workspaceSlug} />;
    },
  });

type TUpdateProposal = {
  error?: string;
  track_id?: string;
  before?: { title?: string; isrc?: string | null };
  changes?: Record<string, string | undefined>;
  workspace_slug?: string;
};

function UpdateTrackCard({ result }: { result: TUpdateProposal }) {
  const [state, setState] = useState<"idle" | "applying" | "done">("idle");
  if (result.error) return <p className={`${card} text-warning-primary`}>{result.error}</p>;
  if (!result.track_id || !result.changes) return null;

  const apply = async () => {
    setState("applying");
    const { video_url, video_release_date, video_isrc, ...trackFields } = result.changes ?? {};
    const payload: Record<string, unknown> = { ...trackFields };
    if (video_url) {
      payload.video_entries = [
        { video_url, release_date: video_release_date || null, isrc: video_isrc || "", title: result.before?.title },
      ];
    }
    try {
      const response = await fetch(
        `${API_BASE_URL}/api/workspaces/${result.workspace_slug}/music/tracks/${result.track_id}/`,
        {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );
      if (!response.ok) throw new Error((await response.json())?.error ?? "Update failed");
      setState("done");
      setToast({ type: TOAST_TYPE.SUCCESS, title: "Canción actualizada" });
    } catch (error: unknown) {
      setState("idle");
      setToast({ type: TOAST_TYPE.ERROR, title: "Error", message: error instanceof Error ? error.message : "Update failed" });
    }
  };

  return (
    <div className={card}>
      <p className="mb-1 font-medium">Cambios propuestos: {result.before?.title}</p>
      <ul className="text-12 text-secondary">
        {Object.entries(result.changes).filter(([, value]) => value).map(([field, value]) => (
          <li key={field}><span className="font-mono text-11">{field}</span> → {value}</li>
        ))}
      </ul>
      {state !== "done" ? (
        <button
          type="button"
          disabled={state === "applying"}
          onClick={() => void apply()}
          className="mt-2 flex items-center gap-1.5 rounded-sm bg-accent-primary px-2.5 py-1.5 text-12 font-medium text-on-color hover:opacity-90 disabled:opacity-60"
        >
          {state === "applying" ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
          Aplicar cambios
        </button>
      ) : (
        <p className="mt-2 flex items-center gap-1 text-12 text-success-primary"><Check className="size-3.5" /> Aplicado</p>
      )}
    </div>
  );
}

export const UpdateMusicTrackToolUI = makeAssistantToolUI<Record<string, unknown>, TUpdateProposal>({
  toolName: "update_music_track",
  render: ({ result }) => {
    if (!result) return <Running label="Buscando la canción…" />;
    return <UpdateTrackCard result={result} />;
  },
});
