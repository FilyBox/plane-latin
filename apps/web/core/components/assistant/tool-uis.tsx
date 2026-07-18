/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * Tool-call renderers for the workspace assistant. Server tools return data
 * or proposals; anything that mutates is applied HERE through the user's own
 * session (Django REST), never by the model.
 */

import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Check,
  CircleHelp,
  Download,
  FileSpreadsheet,
  FileText,
  Loader2,
  Music2,
  Search,
  Send,
  Settings2,
  WandSparkles,
} from "lucide-react";
import { makeAssistantToolUI, useAssistantRuntime } from "@assistant-ui/react";
// plane imports
import { API_BASE_URL } from "@plane/constants";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import { SearchableSelect } from "../music-catalog/searchable-select";
import { getApiError } from "../music-catalog/shared";

const card = "my-2 rounded-md border border-subtle bg-layer-1 p-3 text-13";

/** Sentinel understood by the import backend: drop the whole row */
const SKIP_ROW = "__SKIP_ROW__";

const DEDUPE_OPTIONS = [
  { value: "auto", label: "Auto (ISRC → título+fecha)" },
  { value: "title", label: "Por título" },
  { value: "isrc", label: "Por ISRC" },
  { value: "catalog", label: "Por catálogo" },
  { value: "upc", label: "Por UPC" },
  { value: "none", label: "Sin duplicados (conservar todos)" },
];

const DUPLICATE_STRATEGY_OPTIONS = [
  { value: "skip", label: "Conservar existentes (omitir)" },
  { value: "update", label: "Actualizar existentes" },
  { value: "error", label: "Marcar como error" },
];

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

export const QueryMusicTracksToolUI = makeAssistantToolUI<
  Record<string, unknown>,
  { total: number; returned: number; results: TTrackRow[] }
>({
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
                    <td className="px-2 py-1">
                      {track.title}
                      {track.version ? ` (${track.version})` : ""}
                    </td>
                    <td className="px-2 py-1">{track.artists.join(", ")}</td>
                    <td className="font-mono px-2 py-1 text-11">{track.isrc ?? "—"}</td>
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
          <span
            key={source.contract_id}
            className="flex items-center gap-1 rounded-full border border-subtle px-2 py-0.5 text-11"
          >
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
        {result.results.length} archivo(s) encontrados
        {result.results.length > 0
          ? `: ${result.results
              .slice(0, 5)
              .map((file) => file.name)
              .join(", ")}`
          : ""}
      </p>
    );
  },
});

type TImportProposal = {
  total?: number;
  created?: number;
  updated?: number;
  skipped?: number;
  errors?: {
    row: number;
    message: string;
    code?: string;
    field?: string | null;
    column?: string | null;
    value?: unknown;
    row_data?: Record<string, unknown>;
  }[];
  dry_run?: boolean;
  asset_id?: string;
  file_name?: string;
  headers?: string[];
  total_rows?: number;
  selected_sheet?: string | null;
  canonical_fields?: string[];
  heuristic_mapping?: Record<string, string>;
  unparseable?: Record<string, { value: string; count: number }[]>;
  proposal?: {
    asset_id: string;
    sheet: string | null;
    mapping: Record<string, string>;
    duplicate_strategy: string;
    invalid_row_strategy?: "abort" | "skip";
    row_overrides?: Record<string, Record<string, string>>;
    dedupe_by?: string;
    value_overrides?: Record<string, Record<string, string>>;
  };
};

/** Dry-run "variables": raw tokens no parser understood ("ringtone" as a
 * duration). The agent resolves them via ask_user + value_overrides; this
 * block keeps them visible on the card meanwhile. */
function UnparseableNotice({ unparseable }: { unparseable?: TImportProposal["unparseable"] }) {
  if (!unparseable || Object.keys(unparseable).length === 0) return null;
  return (
    <div className="mt-2 rounded-md border border-warning-strong bg-warning-subtle/30 p-2 text-11">
      <p className="font-medium text-warning-primary">Valores no interpretables detectados</p>
      <ul className="mt-1 space-y-0.5 text-secondary">
        {Object.entries(unparseable).map(([field, tokens]) => (
          <li key={field}>
            <span className="font-mono">{field}</span>:{" "}
            {tokens.map((token) => `"${token.value}" (${token.count})`).join(", ")}
          </li>
        ))}
      </ul>
      <p className="mt-1 text-tertiary">El asistente te preguntará qué hacer con cada uno.</p>
    </div>
  );
}

type TTokenDecision = { mode: "" | "assign" | "empty" | "skip"; value: string };

/** Interactive resolution of dry-run "variables" straight from the card:
 * per token the user assigns a concrete value, blanks the cell, or drops the
 * affected rows. Decisions land in value_overrides for the next validation. */
function UnparseableResolver({
  unparseable,
  overrides,
  onResolve,
}: {
  unparseable?: TImportProposal["unparseable"];
  overrides: Record<string, Record<string, string>>;
  onResolve: (field: string, token: string, replacement: string | undefined) => void;
}) {
  const [decisions, setDecisions] = useState<Record<string, TTokenDecision>>({});
  if (!unparseable || Object.keys(unparseable).length === 0) return null;

  const decisionFor = (field: string, token: string): TTokenDecision => {
    const key = `${field}:${token}`;
    if (decisions[key]) return decisions[key];
    const current = overrides[field]?.[token];
    if (current === undefined) return { mode: "", value: "" };
    if (current === "") return { mode: "empty", value: "" };
    if (current === SKIP_ROW) return { mode: "skip", value: "" };
    return { mode: "assign", value: current };
  };

  const update = (field: string, token: string, decision: TTokenDecision) => {
    setDecisions((current) => ({ ...current, [`${field}:${token}`]: decision }));
    if (decision.mode === "empty") onResolve(field, token, "");
    else if (decision.mode === "skip") onResolve(field, token, SKIP_ROW);
    else if (decision.mode === "assign" && decision.value.trim()) onResolve(field, token, decision.value.trim());
    else onResolve(field, token, undefined);
  };

  return (
    <div className="mt-2 rounded-md border border-warning-strong bg-warning-subtle/30 p-2 text-11">
      <p className="font-medium text-warning-primary">Valores no interpretables — decide qué hacer con cada uno</p>
      <div className="mt-1.5 space-y-2">
        {Object.entries(unparseable).map(([field, tokens]) => (
          <div key={field}>
            <p className="font-mono text-10 text-tertiary">{field}</p>
            <div className="mt-1 space-y-1">
              {tokens.map((token) => {
                const tokenKey = token.value.toLowerCase();
                const decision = decisionFor(field, tokenKey);
                return (
                  <div key={token.value} className="flex flex-wrap items-center gap-1.5">
                    <span className="min-w-24 truncate font-medium">
                      “{token.value}” <span className="text-tertiary">×{token.count}</span>
                    </span>
                    <select
                      value={decision.mode}
                      onChange={(event) =>
                        update(field, tokenKey, { ...decision, mode: event.target.value as TTokenDecision["mode"] })
                      }
                      className="rounded-sm border border-subtle bg-layer-1 px-1.5 py-1 text-11"
                    >
                      <option value="">Decidir…</option>
                      <option value="assign">Asignar valor</option>
                      <option value="empty">Dejar vacío</option>
                      <option value="skip">Omitir esas filas</option>
                    </select>
                    {decision.mode === "assign" && (
                      <input
                        value={decision.value}
                        onChange={(event) => update(field, tokenKey, { ...decision, value: event.target.value })}
                        placeholder={field.includes("duration") ? "ej. 0:30" : "Valor"}
                        className="w-24 rounded-sm border border-subtle bg-layer-1 px-1.5 py-1 text-11"
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <p className="mt-1.5 text-tertiary">Al terminar, vuelve a validar para aplicar tus decisiones.</p>
    </div>
  );
}

function ImportProposalCard({ result, workspaceSlug }: { result: TImportProposal; workspaceSlug: string }) {
  const [state, setState] = useState<"idle" | "applying" | "done">("idle");
  const [applied, setApplied] = useState<TImportProposal | null>(null);

  // mode=read result (no proposal yet): the model is still reasoning the mapping
  if (!result.proposal) {
    if (result.headers) {
      return (
        <p className={`${card} text-tertiary`}>
          Archivo leído: {result.headers.length} columnas, {result.total ?? "?"} filas. Analizando mapeo…
        </p>
      );
    }
    return null;
  }

  const apply = async () => {
    setState("applying");
    try {
      const response = await fetch(`${API_BASE_URL}/api/workspaces/${workspaceSlug}/assistant/music-import/`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...result.proposal, dry_run: false }),
      });
      const data = await response.json();
      if (!response.ok) throw data;
      setApplied(data);
      setState("done");
      setToast({
        type: TOAST_TYPE.SUCCESS,
        title: "Importación aplicada",
        message: `${data.created} creadas · ${data.updated} actualizadas`,
      });
    } catch (error: unknown) {
      setState("idle");
      setToast({
        type: TOAST_TYPE.ERROR,
        title: "Error",
        message: getApiError(error),
      });
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
      <UnparseableNotice unparseable={summary.unparseable} />
      {summary.errors && summary.errors.length > 0 && (
        <ul className="mt-1 max-h-24 overflow-y-auto text-11 text-danger-primary">
          {summary.errors.slice(0, 5).map((error) => (
            <li key={error.row}>
              Fila {error.row}: {error.message}
            </li>
          ))}
        </ul>
      )}
      <details className="mt-1 text-11 text-tertiary">
        <summary className="cursor-pointer">Mapeo de columnas</summary>
        <ul>
          {Object.entries(result.proposal.mapping).map(([field, column]) => (
            <li key={field}>
              <span className="font-mono">{field}</span> ← {column}
            </li>
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

function InteractiveImportProposalCard({ result, workspaceSlug }: { result: TImportProposal; workspaceSlug: string }) {
  const runtime = useAssistantRuntime();
  const initialMapping = useMemo(() => result.proposal?.mapping ?? result.heuristic_mapping ?? {}, [result]);
  const [mapping, setMapping] = useState<Record<string, string>>(initialMapping);
  const [strategy, setStrategy] = useState(result.proposal?.duplicate_strategy ?? "skip");
  const [dedupeBy, setDedupeBy] = useState(result.proposal?.dedupe_by ?? "auto");
  const [valueOverrides, setValueOverrides] = useState<Record<string, Record<string, string>>>(
    result.proposal?.value_overrides ?? {}
  );
  const [query, setQuery] = useState("");
  const [state, setState] = useState<"idle" | "validating" | "applying" | "done">("idle");
  const [validation, setValidation] = useState<TImportProposal | null>(null);
  const [applied, setApplied] = useState<TImportProposal | null>(null);
  const [invalidRowStrategy, setInvalidRowStrategy] = useState<"abort" | "skip">("abort");
  const [rowOverrides, setRowOverrides] = useState<Record<string, Record<string, string>>>({});
  const [isAdjustOpen, setIsAdjustOpen] = useState(false);
  // Variable decisions taken after a validation don't wipe the result panel;
  // they mark it stale so the user re-validates before applying.
  const [overridesDirty, setOverridesDirty] = useState(false);
  const assetId = result.proposal?.asset_id ?? result.asset_id;
  const sheet = result.proposal?.sheet ?? result.selected_sheet ?? null;
  const headers = result.headers ?? [];
  const fields = result.canonical_fields ?? Object.keys(initialMapping);
  const filteredFields = query.trim()
    ? fields.filter((field) => field.toLowerCase().includes(query.trim().toLowerCase()))
    : fields;
  const missingTitle = !mapping["track.title"];

  const requestAiCorrections = () => {
    const errors = validation?.errors ?? [];
    if (!assetId || errors.length === 0) return;
    runtime.thread.append({
      role: "user",
      content: [
        {
          type: "text",
          text: `Revisa las filas invalidas de la ultima validacion del asset ${assetId}. Propone valores de reemplazo seguros usando row_overrides y vuelve a ejecutar propose_music_import en mode=propose. No apliques la importacion. Errores: ${JSON.stringify(errors)}`,
        },
      ],
    });
  };

  useEffect(() => {
    setMapping(initialMapping);
    setStrategy(result.proposal?.duplicate_strategy ?? "skip");
    setDedupeBy(result.proposal?.dedupe_by ?? "auto");
    setValueOverrides(result.proposal?.value_overrides ?? {});
    setValidation(null);
    setApplied(null);
    setInvalidRowStrategy("abort");
    setRowOverrides({});
    setIsAdjustOpen(false);
    setOverridesDirty(false);
    setState("idle");
  }, [initialMapping, result]);

  if (!assetId || headers.length === 0) return <ImportProposalCard result={result} workspaceSlug={workspaceSlug} />;

  const setOverride = (field: string, token: string, replacement: string | undefined) => {
    setValueOverrides((current) => {
      const next = { ...current, [field]: { ...current[field] } };
      if (replacement === undefined) {
        delete next[field][token];
        if (Object.keys(next[field]).length === 0) delete next[field];
      } else {
        next[field][token] = replacement;
      }
      return next;
    });
    setOverridesDirty(true);
    setApplied(null);
  };

  const submit = async (dryRun: boolean) => {
    if (missingTitle) return;
    setState(dryRun ? "validating" : "applying");
    try {
      const response = await fetch(`${API_BASE_URL}/api/workspaces/${workspaceSlug}/assistant/music-import/`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          asset_id: assetId,
          sheet,
          mapping,
          duplicate_strategy: strategy,
          dedupe_by: dedupeBy,
          value_overrides: valueOverrides,
          dry_run: dryRun,
          invalid_row_strategy: invalidRowStrategy,
          row_overrides: rowOverrides,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw data;
      if (dryRun) {
        setValidation(data);
        setOverridesDirty(false);
        setState("idle");
        setToast({
          type: data.errors?.length ? TOAST_TYPE.ERROR : TOAST_TYPE.SUCCESS,
          title: data.errors?.length ? "La validacion encontro problemas" : "Mapeo validado",
          message: data.errors?.length
            ? `${data.errors.length} filas requieren atencion.`
            : "La importacion esta lista para aplicarse.",
        });
      } else {
        setApplied(data);
        setState("done");
        setToast({
          type: TOAST_TYPE.SUCCESS,
          title: "Importacion aplicada",
          message: `${data.created} creadas, ${data.updated} actualizadas`,
        });
      }
    } catch (error: unknown) {
      setState("idle");
      setToast({
        type: TOAST_TYPE.ERROR,
        title: "No se pudo importar",
        message: getApiError(error),
      });
    }
  };

  return (
    <div className={`${card} overflow-visible`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-medium">Importar {result.file_name || "catalogo musical"}</p>
          <p className="mt-0.5 text-11 text-tertiary">
            {result.total_rows ?? result.total ?? "?"} filas, {headers.length} columnas
          </p>
        </div>
        {applied && (
          <span className="rounded-full bg-success-subtle px-2 py-0.5 text-11 text-success-primary">Aplicado</span>
        )}
      </div>

      {/* The agent already decided the mapping — show it as compact chips;
          the full editor lives behind "Ajustar" for manual corrections only */}
      <div className="mt-2 flex flex-wrap items-center gap-1">
        {Object.entries(mapping)
          .filter(([, column]) => column)
          .slice(0, 8)
          .map(([field, column]) => (
            <span
              key={field}
              className="flex items-center gap-1 rounded-full border border-subtle bg-layer-2 px-2 py-0.5 text-10"
              title={`${field} ← ${column}`}
            >
              <span className="font-mono text-tertiary">{field.replace(/^(track|release)\./, "")}</span>
              <span className="text-tertiary">←</span>
              <span className="max-w-24 truncate">{column}</span>
            </span>
          ))}
        {Object.values(mapping).filter(Boolean).length > 8 && (
          <span className="text-10 text-tertiary">+{Object.values(mapping).filter(Boolean).length - 8} más</span>
        )}
      </div>

      {missingTitle && (
        <p className="mt-2 flex items-start gap-1.5 rounded-sm border border-warning-subtle bg-warning-subtle/30 p-2 text-11 text-warning-primary">
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
          Asigna una columna a track.title para poder validar e importar.
        </p>
      )}

      <button
        type="button"
        onClick={() => setIsAdjustOpen((open) => !open)}
        className="mt-1.5 flex items-center gap-1 text-11 text-accent-primary hover:underline"
      >
        <Settings2 className="size-3" /> {isAdjustOpen ? "Ocultar ajustes" : "Ajustar mapeo y duplicados"}
      </button>

      {isAdjustOpen && (
        <div className="mt-2 rounded-md border border-subtle bg-layer-2/50 p-2">
          <div className="flex flex-wrap items-center gap-2">
            <label className="relative min-w-0 flex-1">
              <Search className="absolute top-1/2 left-2 size-3 -translate-y-1/2 text-tertiary" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Buscar campo de destino..."
                className="w-full rounded-sm border border-subtle bg-transparent py-1.5 pr-2 pl-7 text-11"
              />
            </label>
            <SearchableSelect
              className="w-44 shrink-0"
              options={DEDUPE_OPTIONS}
              value={dedupeBy}
              onSelect={(value) => {
                setDedupeBy(value);
                setValidation(null);
              }}
              placeholder="Identificador de duplicado"
            />
            <SearchableSelect
              className="w-44 shrink-0"
              options={DUPLICATE_STRATEGY_OPTIONS}
              value={strategy}
              onSelect={(value) => {
                setStrategy(value);
                setValidation(null);
              }}
              placeholder="Acción con duplicados"
            />
          </div>

          <div className="mt-2 max-h-56 space-y-1 overflow-y-auto pr-1">
            {filteredFields.map((field) => (
              <div
                key={field}
                className="grid grid-cols-2 items-center gap-2 rounded-sm border border-subtle bg-layer-1 px-2 py-1.5"
              >
                <span className="font-mono truncate text-10">
                  {field}
                  {field === "track.title" ? " *" : ""}
                </span>
                <SearchableSelect
                  options={[
                    { value: "", label: "No importar" },
                    ...headers.map((header) => ({ value: header, label: header })),
                  ]}
                  value={mapping[field] ?? ""}
                  onSelect={(column) => {
                    setMapping((current) => ({ ...current, [field]: column }));
                    setValidation(null);
                    setApplied(null);
                  }}
                  placeholder="Buscar columna..."
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {state === "validating" && <Running label="Validando cada fila del archivo…" />}
      {validation && (
        <div
          className={`mt-2 rounded-md border p-3 ${validation.errors?.length ? "border-warning-subtle bg-warning-subtle/20" : "border-success-subtle bg-success-subtle/20"}`}
        >
          <p className="text-12 font-semibold">
            {validation.errors?.length ? "La validación requiere una decisión" : "Todo está correcto"}
          </p>
          <p className="mt-1 text-11 text-secondary">
            {validation.total} filas: {validation.created} nuevas, {validation.updated} actualizadas,{" "}
            {validation.skipped} omitidas
            {validation.errors?.length ? `, ${validation.errors.length} inválidas` : ". Ya puedes importar."}
          </p>
          <UnparseableResolver
            unparseable={validation.unparseable}
            overrides={valueOverrides}
            onResolve={setOverride}
          />
        </div>
      )}
      {validation?.errors && validation.errors.length > 0 && (
        <div className="mt-2 space-y-2">
          <div className="grid gap-2 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => setInvalidRowStrategy("skip")}
              className={`rounded-md border p-2 text-left text-11 ${invalidRowStrategy === "skip" ? "border-accent-primary bg-accent-primary/5" : "border-subtle"}`}
            >
              <strong className="block">Omitir filas inválidas</strong>
              Importar el resto del archivo.
            </button>
            <button
              type="button"
              onClick={() => setInvalidRowStrategy("abort")}
              className={`rounded-md border p-2 text-left text-11 ${invalidRowStrategy === "abort" ? "border-accent-primary bg-accent-primary/5" : "border-subtle"}`}
            >
              <strong className="block">Corregir valores</strong>
              Reemplazar datos y volver a validar.
            </button>
          </div>
          <button
            type="button"
            onClick={requestAiCorrections}
            className="flex w-full items-center justify-center gap-1.5 rounded-md border border-accent-subtle bg-accent-primary/5 px-2 py-2 text-11 font-medium text-accent-primary"
          >
            <WandSparkles className="size-3.5" /> Pedir a la IA que proponga correcciones
          </button>
          <div className="max-h-64 space-y-2 overflow-y-auto">
            {validation.errors.map((error) => (
              <div key={`${error.row}-${error.message}`} className="rounded-md border border-subtle bg-layer-1 p-2">
                <p className="text-11 font-medium text-danger-primary">
                  Fila {error.row}: {error.message}
                </p>
                <p className="mt-0.5 text-10 text-tertiary">
                  {error.field ? `${error.field}${error.column ? ` ← ${error.column}` : ""}` : "Error general"}
                </p>
                {error.field && (
                  <input
                    className="mt-1.5 w-full rounded-sm border border-subtle bg-transparent px-2 py-1 text-11"
                    value={rowOverrides[String(error.row)]?.[error.field] ?? String(error.value ?? "")}
                    onChange={(event) => {
                      setRowOverrides((current) => ({
                        ...current,
                        [String(error.row)]: {
                          ...current[String(error.row)],
                          [error.field!]: event.target.value,
                        },
                      }));
                      setValidation(null);
                    }}
                    placeholder="Valor de reemplazo"
                  />
                )}
                {error.row_data && (
                  <details className="mt-1 text-10 text-tertiary">
                    <summary className="cursor-pointer">Ver datos de la fila</summary>
                    {Object.entries(error.row_data).map(([column, value]) => (
                      <p key={column} className="truncate">
                        <strong>{column}:</strong> {String(value ?? "—")}
                      </p>
                    ))}
                  </details>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {!applied && (
        <div className="mt-3 flex flex-wrap gap-2">
          {!validation && (
            <button
              type="button"
              disabled={missingTitle || state !== "idle"}
              onClick={() => void submit(true)}
              className="flex items-center gap-1.5 rounded-sm bg-accent-primary px-2.5 py-1.5 text-12 font-medium text-on-color hover:opacity-90 disabled:opacity-50"
            >
              {state === "validating" ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
              Validar archivo
            </button>
          )}
          {validation && overridesDirty && (
            <button
              type="button"
              disabled={state !== "idle"}
              onClick={() => void submit(true)}
              className="flex items-center gap-1.5 rounded-sm bg-accent-primary px-2.5 py-1.5 text-12 font-medium text-on-color hover:opacity-90 disabled:opacity-50"
            >
              {state === "validating" ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
              Validar de nuevo
            </button>
          )}
          {validation && !overridesDirty && (!validation.errors?.length || invalidRowStrategy === "skip") && (
            <button
              type="button"
              disabled={state !== "idle"}
              onClick={() => void submit(false)}
              className="flex items-center gap-1.5 rounded-sm bg-accent-primary px-2.5 py-1.5 text-12 font-medium text-on-color hover:opacity-90 disabled:opacity-50"
            >
              {state === "applying" ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
              {validation.errors?.length ? "Importar filas válidas" : "Aplicar importación"}
            </button>
          )}
        </div>
      )}
      {applied && (
        <p className="mt-2 text-11 text-tertiary">
          El archivo quedó guardado en Archivos de importación; los registros creados mantienen su referencia.
        </p>
      )}
    </div>
  );
}

export const buildProposeMusicImportToolUI = (workspaceSlug: string) =>
  makeAssistantToolUI<Record<string, unknown>, TImportProposal>({
    toolName: "propose_music_import",
    render: ({ result }) => {
      if (!result) return <Running label="Procesando el archivo…" />;
      return <InteractiveImportProposalCard result={result} workspaceSlug={workspaceSlug} />;
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
      setToast({
        type: TOAST_TYPE.ERROR,
        title: "Error",
        message: getApiError(error),
      });
    }
  };

  return (
    <div className={card}>
      <p className="mb-1 font-medium">Cambios propuestos: {result.before?.title}</p>
      <ul className="text-12 text-secondary">
        {Object.entries(result.changes)
          .filter(([, value]) => value)
          .map(([field, value]) => (
            <li key={field}>
              <span className="font-mono text-11">{field}</span> → {value}
            </li>
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
        <p className="mt-2 flex items-center gap-1 text-12 text-success-primary">
          <Check className="size-3.5" /> Aplicado
        </p>
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

type TAskUserArgs = { question: string; options?: string[]; context?: string };

/** Human-in-the-loop: the agent pauses on ask_user; answering here resumes it */
function AskUserCard({
  args,
  result,
  addResult,
}: {
  args: TAskUserArgs;
  result?: { answer: string };
  addResult: (r: { answer: string }) => void;
}) {
  const [freeText, setFreeText] = useState("");

  if (result) {
    return (
      <div className={card}>
        <p className="flex items-start gap-1.5 text-secondary">
          <CircleHelp className="mt-0.5 size-3.5 shrink-0 text-tertiary" /> {args.question}
        </p>
        <p className="mt-1 flex items-center gap-1 text-12 text-success-primary">
          <Check className="size-3.5" /> Respondiste: {result.answer}
        </p>
      </div>
    );
  }

  return (
    <div className={`${card} border-accent-strong/40`}>
      <p className="flex items-start gap-1.5 font-medium">
        <CircleHelp className="mt-0.5 size-3.5 shrink-0 text-accent-primary" /> {args.question}
      </p>
      {args.context && <p className="mt-1 text-11 text-tertiary">{args.context}</p>}
      {(args.options?.length ?? 0) > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {args.options?.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => addResult({ answer: option })}
              className="rounded-full border border-subtle px-2.5 py-1 text-12 hover:border-accent-strong hover:text-accent-primary"
            >
              {option}
            </button>
          ))}
        </div>
      )}
      <div className="mt-2 flex items-center gap-1.5">
        <input
          value={freeText}
          onChange={(event) => setFreeText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && freeText.trim()) addResult({ answer: freeText.trim() });
          }}
          placeholder="U otra respuesta…"
          className="w-full rounded-sm border border-subtle bg-transparent px-2 py-1 text-12"
        />
        <button
          type="button"
          disabled={!freeText.trim()}
          onClick={() => addResult({ answer: freeText.trim() })}
          className="flex size-7 shrink-0 items-center justify-center rounded-sm bg-accent-primary text-on-color hover:opacity-90 disabled:opacity-50"
        >
          <Send className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

export const AskUserToolUI = makeAssistantToolUI<TAskUserArgs, { answer: string }>({
  toolName: "ask_user",
  render: ({ args, result, addResult }) => <AskUserCard args={args} result={result} addResult={addResult} />,
});

// ---------------------------------------------------------------------------
// Structured human-in-the-loop cards. Like ask_user these tools have no
// server-side execute: the run pauses and the typed answer we addResult()
// here is replayed by the model into the next propose_music_import call.
// ---------------------------------------------------------------------------

type TResolveVariablesArgs = {
  asset_id: string;
  fields: {
    field: string;
    field_label?: string;
    tokens: { value: string; count: number; suggestion?: string }[];
  }[];
};

type TResolveVariablesResult = {
  value_overrides: Record<string, Record<string, string>>;
  note: string;
};

function ResolveImportVariablesCard({
  args,
  result,
  addResult,
}: {
  args: TResolveVariablesArgs;
  result?: TResolveVariablesResult;
  addResult: (r: TResolveVariablesResult) => void;
}) {
  const [decisions, setDecisions] = useState<Record<string, TTokenDecision>>({});
  const fields = args.fields ?? [];

  const decisionFor = (field: string, token: { value: string; suggestion?: string }): TTokenDecision => {
    const key = `${field}:${token.value.toLowerCase()}`;
    if (decisions[key]) return decisions[key];
    if (token.suggestion) return { mode: "assign", value: token.suggestion };
    return { mode: "", value: "" };
  };

  const allDecided = fields.every((entry) =>
    entry.tokens.every((token) => {
      const decision = decisionFor(entry.field, token);
      return decision.mode === "empty" || decision.mode === "skip" || (decision.mode === "assign" && decision.value.trim());
    })
  );

  const confirm = () => {
    const overrides: Record<string, Record<string, string>> = {};
    for (const entry of fields) {
      for (const token of entry.tokens) {
        const decision = decisionFor(entry.field, token);
        const key = token.value.toLowerCase();
        const replacement =
          decision.mode === "empty" ? "" : decision.mode === "skip" ? SKIP_ROW : decision.value.trim();
        overrides[entry.field] = { ...overrides[entry.field], [key]: replacement };
      }
    }
    addResult({
      value_overrides: overrides,
      note: "Decisiones del usuario. Re-propón la importación pasando este value_overrides EXACTAMENTE igual.",
    });
  };

  if (result) {
    return (
      <div className={card}>
        <p className="flex items-center gap-1.5 font-medium text-secondary">
          <WandSparkles className="size-3.5 text-tertiary" /> Variables resueltas
        </p>
        <ul className="mt-1 space-y-0.5 text-11 text-secondary">
          {Object.entries(result.value_overrides).flatMap(([field, tokens]) =>
            Object.entries(tokens).map(([token, replacement]) => (
              <li key={`${field}:${token}`}>
                <span className="font-mono">{field.replace(/^(track|release)\./, "")}</span> · “{token}” →{" "}
                {replacement === "" ? "vacío" : replacement === SKIP_ROW ? "omitir filas" : replacement}
              </li>
            ))
          )}
        </ul>
      </div>
    );
  }

  return (
    <div className={`${card} border-accent-strong/40`}>
      <p className="flex items-start gap-1.5 font-medium">
        <WandSparkles className="mt-0.5 size-3.5 shrink-0 text-accent-primary" />
        Algunos valores no se pueden interpretar — decide qué hacer con cada uno
      </p>
      <div className="mt-2 space-y-2.5">
        {fields.map((entry) => (
          <div key={entry.field}>
            <p className="text-11 font-medium text-secondary">
              {entry.field_label || entry.field}{" "}
              <span className="font-mono text-10 text-tertiary">({entry.field})</span>
            </p>
            <div className="mt-1 space-y-1">
              {entry.tokens.map((token) => {
                const key = `${entry.field}:${token.value.toLowerCase()}`;
                const decision = decisionFor(entry.field, token);
                return (
                  <div key={token.value} className="flex flex-wrap items-center gap-1.5 text-12">
                    <span className="min-w-28 truncate font-medium">
                      “{token.value}” <span className="text-tertiary">×{token.count}</span>
                    </span>
                    <select
                      value={decision.mode}
                      onChange={(event) =>
                        setDecisions((current) => ({
                          ...current,
                          [key]: { ...decision, mode: event.target.value as TTokenDecision["mode"] },
                        }))
                      }
                      className="rounded-sm border border-subtle bg-layer-1 px-1.5 py-1 text-11"
                    >
                      <option value="">Decidir…</option>
                      <option value="assign">Asignar valor</option>
                      <option value="empty">Dejar vacío</option>
                      <option value="skip">Omitir esas filas</option>
                    </select>
                    {decision.mode === "assign" && (
                      <input
                        value={decision.value}
                        onChange={(event) =>
                          setDecisions((current) => ({
                            ...current,
                            [key]: { ...decision, value: event.target.value },
                          }))
                        }
                        placeholder={entry.field.includes("duration") ? "ej. 0:30" : "Valor"}
                        className="w-24 rounded-sm border border-subtle bg-layer-1 px-1.5 py-1 text-11"
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <button
        type="button"
        disabled={!allDecided}
        onClick={confirm}
        className="mt-3 flex items-center gap-1.5 rounded-sm bg-accent-primary px-2.5 py-1.5 text-12 font-medium text-on-color hover:opacity-90 disabled:opacity-50"
      >
        <Check className="size-3.5" /> Confirmar decisiones
      </button>
    </div>
  );
}

export const ResolveImportVariablesToolUI = makeAssistantToolUI<TResolveVariablesArgs, TResolveVariablesResult>({
  toolName: "resolve_import_variables",
  render: ({ args, result, addResult }) => (
    <ResolveImportVariablesCard args={args} result={result} addResult={addResult} />
  ),
});

type TResolveDuplicatesArgs = {
  asset_id: string;
  updated: number;
  skipped: number;
  current_dedupe_by?: string;
  examples?: { title: string; isrc?: string; catalog?: string; upc?: string }[];
};

type TResolveDuplicatesResult = {
  dedupe_by: string;
  duplicate_strategy: string;
  note: string;
};

function ResolveDuplicatesCard({
  args,
  result,
  addResult,
}: {
  args: TResolveDuplicatesArgs;
  result?: TResolveDuplicatesResult;
  addResult: (r: TResolveDuplicatesResult) => void;
}) {
  const [dedupeBy, setDedupeBy] = useState(args.current_dedupe_by ?? "auto");
  const [strategy, setStrategy] = useState("skip");

  if (result) {
    const dedupeLabel = DEDUPE_OPTIONS.find((option) => option.value === result.dedupe_by)?.label ?? result.dedupe_by;
    const strategyLabel =
      DUPLICATE_STRATEGY_OPTIONS.find((option) => option.value === result.duplicate_strategy)?.label ??
      result.duplicate_strategy;
    return (
      <div className={card}>
        <p className="flex items-center gap-1.5 text-secondary">
          <Check className="size-3.5 text-success-primary" /> Duplicados: {dedupeLabel}
          {result.dedupe_by !== "none" ? ` · ${strategyLabel}` : ""}
        </p>
      </div>
    );
  }

  return (
    <div className={`${card} border-accent-strong/40`}>
      <p className="flex items-start gap-1.5 font-medium">
        <CircleHelp className="mt-0.5 size-3.5 shrink-0 text-accent-primary" />
        Se detectaron posibles duplicados ({args.updated} a actualizar, {args.skipped} omitidos)
      </p>
      {(args.examples?.length ?? 0) > 0 && (
        <div className="mt-2 max-h-28 overflow-auto rounded-sm border border-subtle">
          <table className="w-full text-11">
            <thead className="sticky top-0 bg-layer-1 text-left text-tertiary">
              <tr>
                <th className="px-2 py-1 font-medium">Título</th>
                <th className="px-2 py-1 font-medium">ISRC</th>
                <th className="px-2 py-1 font-medium">Catálogo</th>
                <th className="px-2 py-1 font-medium">UPC</th>
              </tr>
            </thead>
            <tbody>
              {args.examples?.map((example, index) => (
                <tr key={index} className="border-t border-subtle">
                  <td className="px-2 py-1">{example.title}</td>
                  <td className="font-mono px-2 py-1">{example.isrc ?? "—"}</td>
                  <td className="font-mono px-2 py-1">{example.catalog ?? "—"}</td>
                  <td className="font-mono px-2 py-1">{example.upc ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-2 text-11 font-medium text-secondary">¿Qué identificador define un duplicado?</p>
      <div className="mt-1 flex flex-wrap gap-1.5">
        {DEDUPE_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => setDedupeBy(option.value)}
            className={`rounded-full border px-2.5 py-1 text-11 ${
              dedupeBy === option.value
                ? "border-accent-strong bg-accent-primary/10 text-accent-primary"
                : "border-subtle hover:border-accent-strong"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
      {dedupeBy !== "none" && (
        <>
          <p className="mt-2 text-11 font-medium text-secondary">¿Qué hacer con los duplicados?</p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {DUPLICATE_STRATEGY_OPTIONS.filter((option) => option.value !== "error").map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setStrategy(option.value)}
                className={`rounded-full border px-2.5 py-1 text-11 ${
                  strategy === option.value
                    ? "border-accent-strong bg-accent-primary/10 text-accent-primary"
                    : "border-subtle hover:border-accent-strong"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </>
      )}
      <button
        type="button"
        onClick={() =>
          addResult({
            dedupe_by: dedupeBy,
            duplicate_strategy: dedupeBy === "none" ? "skip" : strategy,
            note: "Decisión del usuario. Re-propón la importación pasando dedupe_by y duplicate_strategy EXACTAMENTE así.",
          })
        }
        className="mt-3 flex items-center gap-1.5 rounded-sm bg-accent-primary px-2.5 py-1.5 text-12 font-medium text-on-color hover:opacity-90"
      >
        <Check className="size-3.5" /> Confirmar
      </button>
    </div>
  );
}

export const ResolveDuplicatesToolUI = makeAssistantToolUI<TResolveDuplicatesArgs, TResolveDuplicatesResult>({
  toolName: "resolve_duplicates",
  render: ({ args, result, addResult }) => <ResolveDuplicatesCard args={args} result={result} addResult={addResult} />,
});
