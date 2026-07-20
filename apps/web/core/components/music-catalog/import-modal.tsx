import { useEffect, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, Eye, FileSpreadsheet, Search, ShieldCheck, X, WandSparkles } from "lucide-react";
import { Button } from "@plane/propel/button";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type {
  TMusicCatalogOptions,
  TMusicCompany,
  TMusicGenre,
  TMusicImportAsset,
  TMusicImportPreview,
  TMusicImportResult,
  TMusicParty,
  TMusicRelease,
} from "@plane/types";
import { AlertModalCore } from "@plane/ui";
import { fileLibraryService } from "@/services/file-library.service";
import { musicService } from "@/services/music.service";
import { FilePreviewModal } from "../file-library/file-preview-modal";
import { BudgetPeekPanel } from "../payments/budget-peek-panel";
import { SearchableSelect } from "./searchable-select";
import { getApiError, MUSIC_FIELD } from "./shared";

type Props = {
  workspaceSlug: string;
  isOpen: boolean;
  options?: TMusicCatalogOptions;
  parties: TMusicParty[];
  companies: TMusicCompany[];
  genres: TMusicGenre[];
  releases: TMusicRelease[];
  onClose: () => void;
  onImported: () => void;
  onResourcesChanged: () => void;
};

type DefaultCredit = { party_id: string; role: string };
const REQUIRED_IMPORT_FIELDS = ["track.title"] as const;

/** Backend sentinel: rows whose raw value maps to this are dropped */
const SKIP_ROW = "__SKIP_ROW__";

type TTokenDecision = { mode: "" | "assign" | "empty" | "skip"; value: string };

/** How each dedupe identifier reads in the plain-words summary */
const DEDUPE_EXPLAIN: Record<string, string> = {
  auto: "ISRC (o título + fecha original)",
  isrc: "ISRC",
  title: "título",
  upc: "UPC",
  catalog: "catálogo",
};

const columnsOf = (value: string | string[] | undefined): string[] =>
  !value ? [] : Array.isArray(value) ? value.filter(Boolean) : [value];

/** Dry-run "variables" ("ringtone" in a duration column): one decision per
 * distinct token — assign a real value (with the expected format as example),
 * blank the cell, or drop the affected rows. */
function VariableResolver({
  unparseable,
  overrides,
  formatExamples,
  onResolve,
}: {
  unparseable: NonNullable<TMusicImportResult["unparseable"]>;
  overrides: Record<string, Record<string, string>>;
  formatExamples: Record<string, string>;
  onResolve: (field: string, token: string, decision: TTokenDecision) => void;
}) {
  const [decisions, setDecisions] = useState<Record<string, TTokenDecision>>({});

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
    onResolve(field, token, decision);
  };

  const pendingCount = Object.entries(unparseable).reduce((count, [field, tokens]) => {
    for (const token of tokens) {
      const decision = decisionFor(field, token.value.toLowerCase());
      const resolved =
        decision.mode === "empty" || decision.mode === "skip" || (decision.mode === "assign" && decision.value.trim());
      if (!resolved) count += 1;
    }
    return count;
  }, 0);

  return (
    <div className="mt-3 rounded-lg border border-warning-strong bg-layer-1 p-3">
      <p className="text-12 font-semibold">
        Valores que no encajan con el formato del campo{" "}
        <span className="font-normal text-tertiary">
          — palabras usadas como variable (p. ej. “ringtone” en una columna de duración)
        </span>
      </p>
      <p className="mt-0.5 text-11 text-secondary">
        Decide qué hacer con cada valor: se aplicará a TODAS las filas que lo contengan.
        {pendingCount > 0 ? ` Faltan ${pendingCount} por decidir.` : " Todo decidido — vuelve a validar."}
      </p>
      <div className="mt-2.5 space-y-3">
        {Object.entries(unparseable).map(([field, tokens]) => (
          <div key={field}>
            <p className="text-11 font-medium text-secondary">
              {field}
              {formatExamples[field] ? (
                <span className="ml-1.5 font-normal text-tertiary">Formato esperado: {formatExamples[field]}</span>
              ) : null}
            </p>
            <div className="mt-1.5 space-y-1.5">
              {tokens.map((token) => {
                const tokenKey = token.value.toLowerCase();
                const decision = decisionFor(field, tokenKey);
                return (
                  <div key={token.value} className="flex flex-wrap items-center gap-2 text-12">
                    <span className="min-w-32 truncate font-medium">
                      “{token.value}” <span className="text-tertiary">×{token.count}</span>
                    </span>
                    <select
                      value={decision.mode}
                      onChange={(event) =>
                        update(field, tokenKey, { ...decision, mode: event.target.value as TTokenDecision["mode"] })
                      }
                      className="rounded-sm border border-subtle bg-layer-1 px-2 py-1 text-11"
                    >
                      <option value="">Decidir…</option>
                      <option value="assign">Reemplazar por un valor</option>
                      <option value="empty">Dejar la celda vacía</option>
                      <option value="skip">Omitir esas filas</option>
                    </select>
                    {decision.mode === "assign" && (
                      <input
                        value={decision.value}
                        onChange={(event) => update(field, tokenKey, { ...decision, value: event.target.value })}
                        placeholder={formatExamples[field] ? `ej. ${formatExamples[field]}` : "Valor"}
                        className="w-28 rounded-sm border border-subtle bg-layer-1 px-2 py-1 text-11"
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function MusicImportModal({
  workspaceSlug,
  isOpen,
  options,
  parties,
  companies,
  genres,
  releases,
  onClose,
  onImported,
  onResourcesChanged,
}: Props) {
  const [file, setFile] = useState<File>();
  const [assetId, setAssetId] = useState<string>();
  const [preview, setPreview] = useState<TMusicImportPreview>();
  const [mapping, setMapping] = useState<Record<string, string | string[]>>({});
  const [strategy, setStrategy] = useState<"skip" | "update" | "error">("skip");
  const [dedupeBy, setDedupeBy] = useState("auto");
  const [relationsMode, setRelationsMode] = useState<"merge" | "replace">("merge");
  const [dedupeWithinFile, setDedupeWithinFile] = useState(false);
  const [valueOverrides, setValueOverrides] = useState<Record<string, Record<string, string>>>({});
  const [isAiMapping, setIsAiMapping] = useState(false);
  const [result, setResult] = useState<TMusicImportResult>();
  const [isRunning, setIsRunning] = useState(false);
  const [defaultCredits, setDefaultCredits] = useState<DefaultCredit[]>([]);
  const [defaultCompanyIds, setDefaultCompanyIds] = useState<string[]>([]);
  const [defaultGenreIds, setDefaultGenreIds] = useState<string[]>([]);
  const [defaultReleaseIds, setDefaultReleaseIds] = useState<string[]>([]);
  const [fieldQuery, setFieldQuery] = useState("");
  const [validatedKey, setValidatedKey] = useState<string>();
  const [invalidRowStrategy, setInvalidRowStrategy] = useState<"abort" | "skip">("abort");
  const [rowOverrides, setRowOverrides] = useState<Record<string, Record<string, string>>>({});
  const [hasApplied, setHasApplied] = useState(false);
  const [isDeleteSourceOpen, setIsDeleteSourceOpen] = useState(false);
  const [savedAssets, setSavedAssets] = useState<TMusicImportAsset[]>([]);
  const [assetName, setAssetName] = useState<string>();
  const [isFilePreviewOpen, setIsFilePreviewOpen] = useState(false);

  // What the import endpoints consume: a fresh browser File, or the id of a
  // stored asset when re-importing (the file never travels again).
  const source: File | { assetId: string } | undefined = file ?? (assetId ? { assetId } : undefined);
  const sourceName = file?.name ?? assetName;

  const missingRequired = REQUIRED_IMPORT_FIELDS.filter((field) => columnsOf(mapping[field]).length === 0);
  const multiFields = useMemo(() => new Set(preview?.multi_fields ?? []), [preview?.multi_fields]);

  /** Short content sample for a column ("4:02 · 2:24 · ringtone") */
  const columnSample = (column: string, limit = 3): string => {
    const samples = preview?.column_samples?.[column];
    if (!samples || samples.examples.length === 0) return "";
    return samples.examples
      .slice(0, limit)
      .map((example) => (example.length > 24 ? `${example.slice(0, 24)}…` : example))
      .join(" · ");
  };

  /** Header options for the column selects, with a content hint per column
   * (rendered on its own line under the column name) */
  const headerOptions = useMemo(
    () =>
      (preview?.headers ?? []).map((header) => {
        const samples = preview?.column_samples?.[header];
        if (!samples) return { value: header, label: header };
        const example = samples.examples[0];
        const truncated = example && example.length > 36 ? `${example.slice(0, 36)}…` : example;
        return {
          value: header,
          label: header,
          hint:
            samples.non_empty === 0
              ? "columna vacía"
              : `${samples.non_empty} con datos${truncated ? ` · ej. ${truncated}` : ""}`,
        };
      }),
    [preview?.headers, preview?.column_samples]
  );
  const validationKey = JSON.stringify({
    mapping,
    strategy,
    dedupeBy,
    relationsMode,
    dedupeWithinFile,
    sheet: preview?.selected_sheet,
    defaultCredits,
    defaultCompanyIds,
    defaultGenreIds,
    defaultReleaseIds,
    rowOverrides,
    valueOverrides,
  });
  const visibleFields = useMemo(() => {
    const query = fieldQuery.trim().toLowerCase();
    const importFields = options?.import_fields ?? [];
    return query ? importFields.filter((field) => field.toLowerCase().includes(query)) : importFields;
  }, [fieldQuery, options?.import_fields]);

  useEffect(() => {
    if (!isOpen) return;
    setFile(undefined);
    setAssetId(undefined);
    setPreview(undefined);
    setMapping({});
    setResult(undefined);
    setStrategy("skip");
    setDedupeBy("auto");
    setRelationsMode("merge");
    setDedupeWithinFile(false);
    setDefaultCredits([]);
    setDefaultCompanyIds([]);
    setDefaultGenreIds([]);
    setDefaultReleaseIds([]);
    setFieldQuery("");
    setValidatedKey(undefined);
    setInvalidRowStrategy("abort");
    setRowOverrides({});
    setValueOverrides({});
    setHasApplied(false);
    setIsDeleteSourceOpen(false);
    setAssetName(undefined);
    setIsFilePreviewOpen(false);
    // Saved files for the re-import path (with their last configuration)
    musicService
      .getImportAssets(workspaceSlug)
      .then(({ results }) => setSavedAssets(results))
      .catch(() => setSavedAssets([]));
  }, [isOpen, workspaceSlug]);

  const inspect = async (target: File | { assetId: string }, sheet?: string) => {
    setIsRunning(true);
    try {
      const next = await musicService.previewImport(workspaceSlug, target, sheet);
      setPreview(next);
      setMapping(next.mapping);
      setResult(undefined);
      setValidatedKey(undefined);
      return next;
    } catch (error) {
      setToast({ type: TOAST_TYPE.ERROR, title: "No se pudo leer el archivo", message: getApiError(error) });
      return undefined;
    } finally {
      setIsRunning(false);
    }
  };

  const choose = async (selected?: File) => {
    setFile(selected);
    setAssetId(undefined);
    setAssetName(undefined);
    setPreview(undefined);
    setResult(undefined);
    setMapping({});
    setRowOverrides({});
    setValueOverrides({});
    setHasApplied(false);
    if (!selected) return;
    setIsRunning(true);
    try {
      const uploaded = await fileLibraryService.uploadFile(workspaceSlug, selected, undefined, undefined, "music", {
        music_asset_kind: "IMPORT_SOURCE",
        upload_source: "manual",
      });
      setAssetId(uploaded.asset_id);
      await inspect(selected);
    } catch (error) {
      setToast({ type: TOAST_TYPE.ERROR, title: "No se pudo subir el archivo", message: getApiError(error) });
    } finally {
      setIsRunning(false);
    }
  };

  /** Re-import a stored file restoring its saved configuration. The user only
   * touches what changed; duplicates default to UPDATE existing records. */
  const reimport = async (asset: TMusicImportAsset) => {
    setFile(undefined);
    setAssetId(asset.id);
    setAssetName(asset.name);
    setPreview(undefined);
    setResult(undefined);
    setHasApplied(false);
    const rules = asset.last_run?.rules ?? {};
    const next = await inspect({ assetId: asset.id }, asset.last_run?.sheet ?? undefined);
    if (!next) return;
    // Saved config wins over the fresh heuristic; missing pieces keep defaults
    if (rules.mapping && Object.keys(rules.mapping).length > 0) setMapping(rules.mapping);
    setStrategy("update");
    setDedupeBy(rules.dedupe_by && rules.dedupe_by !== "none" ? rules.dedupe_by : "auto");
    setRelationsMode(rules.relations_mode ?? "merge");
    setDedupeWithinFile(rules.dedupe_within_file ?? false);
    setValueOverrides(rules.value_overrides ?? {});
    setRowOverrides(rules.row_overrides ?? {});
    setInvalidRowStrategy(rules.invalid_row_strategy ?? "abort");
    const defaults = rules.defaults ?? {};
    setDefaultCredits(defaults.credit_entries ?? []);
    setDefaultCompanyIds((defaults.distribution_entries ?? []).map((entry) => entry.company_id));
    setDefaultGenreIds(defaults.genre_ids ?? []);
    setDefaultReleaseIds((defaults.releases ?? []).map((entry) => entry.id));
    setToast({
      type: TOAST_TYPE.SUCCESS,
      title: "Configuración anterior cargada",
      message: "Se restauró el mapeo y las opciones de la última importación. Los duplicados se actualizarán por defecto.",
    });
  };

  const run = async (dryRun: boolean) => {
    if (!source) return;
    if (missingRequired.length) {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: "Falta el mapeo obligatorio",
        message: "Mapea una columna al título de la canción antes de validar.",
      });
      return;
    }
    setIsRunning(true);
    try {
      const next = await musicService.importSpreadsheet(
        workspaceSlug,
        source,
        mapping,
        strategy,
        dryRun,
        preview?.selected_sheet ?? undefined,
        {
          credit_entries: defaultCredits,
          distribution_entries: defaultCompanyIds.map((company_id) => ({ company_id })),
          genre_ids: defaultGenreIds,
          releases: defaultReleaseIds.map((id) => ({ id })),
        },
        invalidRowStrategy,
        rowOverrides,
        valueOverrides,
        dedupeBy,
        relationsMode,
        dedupeWithinFile
      );
      setResult(next);
      if (dryRun) setValidatedKey(validationKey);
      if (!dryRun) {
        setHasApplied(true);
        setToast({
          type: TOAST_TYPE.SUCCESS,
          title: next.errors.length ? "Importación completada omitiendo filas" : "Catálogo importado",
          message: `${next.created} creadas, ${next.updated} actualizadas, ${next.skipped} conservadas${next.errors.length ? ` y ${next.errors.length} con error` : ""}.`,
        });
        onImported();
      }
    } catch (error) {
      setToast({ type: TOAST_TYPE.ERROR, title: "No se pudo importar el archivo", message: getApiError(error) });
    } finally {
      setIsRunning(false);
    }
  };

  const deleteSourceFile = async () => {
    if (!assetId) return;
    setIsRunning(true);
    try {
      await musicService.deleteImportAssets(workspaceSlug, [assetId]);
      setAssetId(undefined);
      setIsDeleteSourceOpen(false);
      setToast({ type: TOAST_TYPE.SUCCESS, title: "Archivo de origen eliminado" });
    } catch (error) {
      setToast({ type: TOAST_TYPE.ERROR, title: "No se pudo eliminar el archivo", message: getApiError(error) });
    } finally {
      setIsRunning(false);
    }
  };

  const invalidateValidation = () => {
    setResult(undefined);
    setValidatedKey(undefined);
  };

  // Inline creation (no extra modal): new resources are created on the spot
  // from the "Crear «nombre»" option of each searchable select.
  const createResource = async (type: "party" | "company" | "genre" | "release", name: string): Promise<string> => {
    if (type === "party") {
      const saved = await musicService.saveParty(workspaceSlug, { display_name: name, kind: "ARTIST" });
      onResourcesChanged();
      return saved.id;
    }
    if (type === "company") {
      const saved = await musicService.saveCompany(workspaceSlug, { name, kind: "AGGREGATOR" });
      onResourcesChanged();
      return saved.id;
    }
    if (type === "release") {
      const saved = await musicService.saveRelease(workspaceSlug, { title: name, release_type: "SINGLE", status: "DRAFT" });
      onResourcesChanged();
      return saved.id;
    }
    const saved = await musicService.saveGenre(workspaceSlug, { name });
    onResourcesChanged();
    return saved.id;
  };

  const addInline = (type: "party" | "company" | "genre" | "release") => async (nameToCreate: string) => {
    try {
      const id = await createResource(type, nameToCreate.trim());
      if (type === "party") setDefaultCredits((current) => [...current, { party_id: id, role: "PRIMARY_ARTIST" }]);
      if (type === "company") setDefaultCompanyIds((current) => [...current, id]);
      if (type === "genre") setDefaultGenreIds((current) => [...current, id]);
      if (type === "release") setDefaultReleaseIds((current) => [...current, id]);
      invalidateValidation();
    } catch (error) {
      setToast({ type: TOAST_TYPE.ERROR, title: "No se pudo crear", message: getApiError(error) });
    }
  };

  const updateMapping = (field: string, column: string) => {
    setMapping((current) => ({ ...current, [field]: column }));
    setResult(undefined);
    setValidatedKey(undefined);
  };

  const updateMultiMapping = (field: string, columns: string[]) => {
    setMapping((current) => {
      const next = { ...current };
      if (columns.length === 0) delete next[field];
      else next[field] = columns;
      return next;
    });
    setResult(undefined);
    setValidatedKey(undefined);
  };

  /** One decision per variable token → the value_overrides the backend expects */
  const resolveVariable = (field: string, token: string, decision: TTokenDecision) => {
    setValueOverrides((current) => {
      const next = { ...current, [field]: { ...current[field] } };
      if (decision.mode === "empty") next[field][token] = "";
      else if (decision.mode === "skip") next[field][token] = SKIP_ROW;
      else if (decision.mode === "assign" && decision.value.trim()) next[field][token] = decision.value.trim();
      else {
        delete next[field][token];
        if (Object.keys(next[field]).length === 0) delete next[field];
      }
      return next;
    });
    setValidatedKey(undefined);
  };

  const aiMap = async () => {
    if (!source) return;
    setIsAiMapping(true);
    try {
      const { mapping: suggested } = await musicService.aiMapImport(
        workspaceSlug,
        source,
        preview?.selected_sheet ?? undefined
      );
      if (Object.keys(suggested).length === 0) {
        setToast({ type: TOAST_TYPE.WARNING, title: "La IA no encontró columnas mapeables" });
        return;
      }
      setMapping((current) => ({ ...current, ...suggested }));
      setResult(undefined);
      setValidatedKey(undefined);
      setToast({
        type: TOAST_TYPE.SUCCESS,
        title: "Mapeo sugerido por IA aplicado",
        message: `${Object.keys(suggested).length} campos mapeados analizando el contenido de las columnas. Revísalos antes de validar.`,
      });
    } catch (error) {
      setToast({ type: TOAST_TYPE.ERROR, title: "No se pudo mapear con IA", message: getApiError(error) });
    } finally {
      setIsAiMapping(false);
    }
  };

  if (!isOpen) return null;
  return (
    <BudgetPeekPanel
      title="Importar catálogo"
      description="Mapea columnas del CSV/XLSX, valida y resuelve duplicados antes de importar."
      onClose={onClose}
    >
      <div className="vertical-scrollbar h-full overflow-y-auto bg-surface-1">
        <div className="space-y-5 p-5">
          <div className="grid grid-cols-2 overflow-hidden rounded-lg border border-subtle bg-layer-1 text-11 sm:grid-cols-4">
            {[
              ["1", "Elegir archivo", Boolean(source)],
              ["2", "Mapear columnas", Boolean(preview) && missingRequired.length === 0],
              ["3", "Validar", validatedKey === validationKey],
              ["4", "Importar", hasApplied],
            ].map(([step, label, complete]) => (
              <div
                key={String(step)}
                className="flex items-center gap-2 border-r border-subtle px-3 py-2 last:border-r-0"
              >
                <span
                  className={`flex size-5 shrink-0 items-center justify-center rounded-full text-10 font-semibold ${
                    complete ? "bg-success-primary text-white" : "bg-layer-2 text-tertiary"
                  }`}
                >
                  {complete ? <CheckCircle2 className="size-3" /> : step}
                </span>
                <span className="truncate text-secondary">{label}</span>
              </div>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="hover:border-accent-primary flex cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-subtle bg-layer-2 px-5 py-6 text-center">
              <FileSpreadsheet className="mb-2 size-7 text-tertiary" />
              <span className="text-13 font-medium">{sourceName ?? "Elegir CSV o XLSX"}</span>
              <span className="mt-1 text-11 text-tertiary">
                Soporta headers desordenados y formatos de fecha mezclados
              </span>
              <input
                className="hidden"
                type="file"
                accept=".csv,.xlsx,.xlsm,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                onChange={(event) => void choose(event.target.files?.[0])}
              />
            </label>
            <div className="flex flex-col justify-center rounded-xl border border-subtle bg-layer-2 px-5 py-4">
              <span className="text-13 font-medium">…o reimporta un archivo guardado</span>
              <span className="mt-1 text-11 text-tertiary">
                Carga el archivo con el mapeo y las opciones de su última importación; solo cambia lo que necesites.
                Los duplicados se actualizan por defecto.
              </span>
              <SearchableSelect
                className="mt-2"
                options={savedAssets.map((asset) => ({
                  value: asset.id,
                  label: asset.name,
                  hint: asset.last_run
                    ? `· ${new Date(asset.last_run.imported_at).toLocaleDateString()}`
                    : "· sin importaciones",
                }))}
                value={!file && assetId ? assetId : ""}
                onSelect={(id) => {
                  const asset = savedAssets.find((item) => item.id === id);
                  if (asset) void reimport(asset);
                }}
                placeholder="Buscar archivo guardado…"
              />
            </div>
          </div>

          {assetId && (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-subtle bg-layer-1 px-3 py-2">
              <span className="min-w-0 truncate text-12 text-secondary">{sourceName}</span>
              <Button variant="secondary" size="sm" onClick={() => setIsFilePreviewOpen(true)}>
                <Eye className="mr-1 size-3.5" /> Ver archivo
              </Button>
            </div>
          )}

          {isRunning && (
            <div className="flex items-center gap-3 rounded-xl border border-accent-subtle bg-accent-primary/5 p-4">
              <span className="border-accent-primary size-5 animate-spin rounded-full border-2 border-t-transparent" />
              <div>
                <p className="text-13 font-semibold">
                  {validatedKey ? "Aplicando importación…" : "Validando archivo…"}
                </p>
                <p className="text-11 text-secondary">Revisamos cada fila sin guardar cambios todavía.</p>
              </div>
            </div>
          )}

          {preview && (
            <>
              {!preview.database_ready && (
                <div className="flex gap-3 rounded-lg border border-danger-subtle bg-danger-subtle/30 p-4 text-12 text-danger-primary">
                  <AlertCircle className="size-4 shrink-0" />
                  <div>
                    <p className="font-semibold">Se requiere una migración de base de datos</p>
                    <p className="mt-1">{preview.database_error}</p>
                  </div>
                </div>
              )}
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-subtle bg-layer-1 p-3">
                <div className="text-12">
                  <strong>{preview.total_rows}</strong> filas · header detectado en la fila {preview.header_row}
                </div>
                {preview.sheets.length > 1 && (
                  <SearchableSelect
                    className="w-56"
                    options={preview.sheets.map((sheet) => ({ value: sheet, label: sheet }))}
                    value={preview.selected_sheet}
                    onSelect={(sheet) => source && void inspect(source, sheet)}
                    placeholder="Buscar hojas…"
                  />
                )}
              </div>

              <section>
                <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
                  <div>
                    <h3 className="text-14 font-semibold">2 · Mapeo de columnas</h3>
                    <p className="text-11 text-secondary">
                      Indica qué columna del archivo alimenta cada campo del catálogo. Solo el título es obligatorio;
                      usa «Mapear con IA» para que se sugiera automáticamente analizando el contenido.
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-11 text-tertiary">
                      {Object.values(mapping).filter((value) => columnsOf(value).length > 0).length} mapeadas
                    </span>
                    <Button variant="secondary" size="sm" loading={isAiMapping} onClick={() => void aiMap()}>
                      <WandSparkles className="mr-1 size-3.5" /> Mapear con IA
                    </Button>
                    <label className="relative w-52">
                      <Search className="absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-tertiary" />
                      <input
                        className={`${MUSIC_FIELD} py-1.5 pr-2 pl-7 text-11`}
                        value={fieldQuery}
                        onChange={(event) => setFieldQuery(event.target.value)}
                        placeholder="Buscar campo destino…"
                      />
                    </label>
                  </div>
                </div>
                {missingRequired.length > 0 && (
                  <div className="mb-3 flex items-start gap-2 rounded-lg border border-warning-subtle bg-warning-subtle/30 p-3 text-12 text-warning-primary">
                    <AlertCircle className="mt-0.5 size-4 shrink-0" />
                    <div>
                      <p className="font-semibold">Falta la columna del título de la canción</p>
                      <p className="mt-0.5 text-11">
                        Selecciona la columna que contiene el nombre de cada canción. La importación queda bloqueada
                        hasta mapearla.
                      </p>
                    </div>
                  </div>
                )}
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {visibleFields.map((field) => {
                    const selected = columnsOf(mapping[field]);
                    if (multiFields.has(field)) {
                      // Multi-column field (links, writers…): chips + add select
                      return (
                        <div key={field} className="rounded-md border border-subtle px-3 py-2">
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate text-11 text-secondary">
                              {field} <span className="text-10 text-tertiary">(varias columnas)</span>
                            </span>
                            <SearchableSelect
                              className="w-44"
                              options={headerOptions.filter((option) => !selected.includes(option.value))}
                              value=""
                              onSelect={(column) => column && updateMultiMapping(field, [...selected, column])}
                              placeholder="Agregar columna…"
                            />
                          </div>
                          {selected.length > 0 && (
                            <div className="mt-1.5 flex flex-wrap gap-1">
                              {selected.map((column) => (
                                <span
                                  key={column}
                                  title={columnSample(column) ? `Ej: ${columnSample(column)}` : undefined}
                                  className="flex items-center gap-1 rounded-full border border-subtle bg-layer-1 px-2 py-0.5 text-10"
                                >
                                  <span className="max-w-32 truncate">{column}</span>
                                  <button
                                    type="button"
                                    onClick={() =>
                                      updateMultiMapping(
                                        field,
                                        selected.filter((item) => item !== column)
                                      )
                                    }
                                    aria-label={`Quitar ${column}`}
                                  >
                                    <X className="size-3 text-tertiary hover:text-danger-primary" />
                                  </button>
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    }
                    const sample = selected[0] ? columnSample(selected[0]) : "";
                    return (
                      <div
                        key={field}
                        className={`rounded-md border px-3 py-2 ${
                          field === "track.title" && selected.length === 0 ? "border-warning-strong" : "border-subtle"
                        }`}
                      >
                        <div className="grid grid-cols-1 items-center gap-2 md:grid-cols-2">
                          <span className="truncate text-11 text-secondary">
                            {field}
                            {field === "track.title" && <span className="text-danger-primary"> *</span>}
                          </span>
                          <SearchableSelect
                            options={[{ value: "", label: "No importar" }, ...headerOptions]}
                            value={selected[0] ?? ""}
                            onSelect={(column) => updateMapping(field, column)}
                            placeholder="Buscar columna origen…"
                          />
                        </div>
                        {sample && (
                          <p className="mt-1 truncate text-10 text-tertiary" title={sample}>
                            Ej: {sample}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>

              <section className="rounded-xl border border-subtle bg-layer-2 p-4">
                <div>
                  <h3 className="text-14 font-semibold">3 · Duplicados y registros existentes</h3>
                  <p className="mt-1 text-11 text-secondary">
                    Cada fila se compara contra TODO el catálogo actual (no solo contra este archivo). Elige con qué
                    identificador se busca la coincidencia y qué hacer cuando exista.
                  </p>
                </div>
                <div className="mt-3 grid gap-3 lg:grid-cols-2">
                  <div>
                    <span className="text-11 font-semibold">¿Con qué identificador se busca la coincidencia?</span>
                    <SearchableSelect
                      className="mt-1.5"
                      options={[
                        { value: "auto", label: "Automático", hint: "ISRC; si no hay, título + fecha original" },
                        { value: "isrc", label: "ISRC" },
                        { value: "title", label: "Título" },
                        { value: "upc", label: "UPC" },
                        { value: "catalog", label: "Catálogo" },
                        { value: "none", label: "No buscar — todo como registros nuevos" },
                      ]}
                      value={dedupeBy}
                      onSelect={(value) => {
                        setDedupeBy(value);
                        invalidateValidation();
                      }}
                      placeholder="Identificador…"
                    />
                  </div>
                  {dedupeBy !== "none" && (
                    <div>
                      <span className="text-11 font-semibold">¿Qué hacer cuando coincida?</span>
                      <div className="mt-1.5 grid gap-2 sm:grid-cols-3">
                        {(
                          [
                            ["update", "Actualizar el existente"],
                            ["skip", "Conservarlo tal cual"],
                            ["error", "Marcar como error"],
                          ] as const
                        ).map(([value, label]) => (
                          <label
                            key={value}
                            className={`cursor-pointer rounded-lg border p-2.5 text-12 ${strategy === value ? "border-accent-primary bg-accent-primary/5" : "border-subtle"}`}
                          >
                            <input
                              className="mr-2"
                              type="radio"
                              checked={strategy === value}
                              onChange={() => {
                                setStrategy(value);
                                invalidateValidation();
                              }}
                            />
                            {label}
                          </label>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {dedupeBy !== "none" && (
                  <label className="mt-3 flex cursor-pointer items-start gap-2 rounded-md border border-subtle p-2.5 text-11">
                    <input
                      type="checkbox"
                      className="mt-0.5 shrink-0"
                      checked={dedupeWithinFile}
                      onChange={(event) => {
                        setDedupeWithinFile(event.target.checked);
                        invalidateValidation();
                      }}
                    />
                    <span>
                      <strong className="text-12">Tratar filas repetidas dentro del archivo como una sola</strong>
                      <span className="mt-0.5 block text-tertiary">
                        Por defecto está DESACTIVADO: cada fila del archivo produce su propio registro y solo se
                        compara contra el catálogo YA existente. Actívalo únicamente si tu archivo trae filas
                        duplicadas que quieres colapsar entre sí.
                      </span>
                    </span>
                  </label>
                )}

                {/* Plain-words summary of what THIS combination will do */}
                <p className="mt-3 rounded-md border border-accent-subtle bg-accent-primary/5 px-3 py-2 text-11 text-secondary">
                  {dedupeBy === "none"
                    ? "Las 216 filas (o las que traiga el archivo) se agregarán TODAS como registros NUEVOS, aunque ya existan canciones iguales en el catálogo."
                    : (() => {
                        const idLabel = DEDUPE_EXPLAIN[dedupeBy];
                        const action =
                          strategy === "update"
                            ? `ACTUALIZARÁN ese registro con los campos mapeados`
                            : strategy === "skip"
                              ? `se OMITIRÁN (el registro existente queda intacto)`
                              : `se marcarán como ERROR para que las revises`;
                        const rest =
                          strategy === "error"
                            ? " antes de importar."
                            : "; las filas que NO coincidan con nada del catálogo se crean como registros nuevos.";
                        const withinFile = dedupeWithinFile
                          ? " Además, filas del propio archivo que compartan ese identificador se colapsan en una."
                          : " Cada fila del archivo se procesa por separado: dos filas con el mismo identificador NO se colapsan entre sí, así que un archivo de N filas produce/actualiza N registros.";
                        return `Cada fila se busca por ${idLabel} contra el catálogo actual. Las que coincidan ${action}${rest}${withinFile}`;
                      })()}
                </p>

                {dedupeBy !== "none" && strategy === "update" && (
                  <div className="mt-3">
                    <span className="text-11 font-semibold">
                      Campos dinámicos del registro existente (artistas, writers, links, géneros…)
                    </span>
                    <div className="mt-1.5 grid gap-2 sm:grid-cols-2">
                      <label
                        className={`cursor-pointer rounded-lg border p-2.5 text-11 ${relationsMode === "merge" ? "border-accent-primary bg-accent-primary/5" : "border-subtle"}`}
                      >
                        <input
                          className="mr-2"
                          type="radio"
                          checked={relationsMode === "merge"}
                          onChange={() => {
                            setRelationsMode("merge");
                            invalidateValidation();
                          }}
                        />
                        <strong className="text-12">Agregar a los existentes</strong>
                        <span className="mt-0.5 block text-tertiary">
                          Lo que traiga el archivo se SUMA a lo que el registro ya tiene. No se quita nada.
                        </span>
                      </label>
                      <label
                        className={`cursor-pointer rounded-lg border p-2.5 text-11 ${relationsMode === "replace" ? "border-accent-primary bg-accent-primary/5" : "border-subtle"}`}
                      >
                        <input
                          className="mr-2"
                          type="radio"
                          checked={relationsMode === "replace"}
                          onChange={() => {
                            setRelationsMode("replace");
                            invalidateValidation();
                          }}
                        />
                        <strong className="text-12">Reemplazar con el archivo</strong>
                        <span className="mt-0.5 block text-tertiary">
                          Los campos mapeados quedan EXACTAMENTE como el archivo: relaciones que ya no vengan de una
                          columna mapeada se quitan. Campos sin mapear y celdas vacías no se tocan.
                        </span>
                      </label>
                    </div>
                  </div>
                )}
              </section>

              <section className="rounded-xl border border-subtle bg-layer-2 p-4">
                <div>
                  <h3 className="text-14 font-semibold">4 · Relaciones para cada canción (opcional)</h3>
                  <p className="mt-1 text-11 text-secondary">
                    Se agregan a TODAS las filas importadas. Busca en cada lista o escribe un nombre nuevo para crearlo
                    aquí mismo — sin salir de este panel.
                  </p>
                </div>
                <div className="mt-4 grid gap-4 lg:grid-cols-2">
                  <div>
                    <span className="text-11 font-semibold">Artistas, escritores y colaboradores</span>
                    <SearchableSelect
                      className="mt-1.5"
                      options={parties
                        .filter((party) => !defaultCredits.some((credit) => credit.party_id === party.id))
                        .map((party) => ({ value: party.id, label: party.display_name }))}
                      value=""
                      onSelect={(partyId) => {
                        if (!partyId) return;
                        setDefaultCredits((current) => [...current, { party_id: partyId, role: "PRIMARY_ARTIST" }]);
                        invalidateValidation();
                      }}
                      onCreate={(name) => void addInline("party")(name)}
                      placeholder="Buscar o crear colaborador…"
                    />
                    <div className="mt-2 space-y-2">
                      {defaultCredits.map((credit) => (
                        <div
                          key={credit.party_id}
                          className="flex items-center gap-2 rounded-md border border-subtle bg-layer-1 p-2"
                        >
                          <span className="min-w-0 flex-1 truncate text-11">
                            {parties.find((party) => party.id === credit.party_id)?.display_name ?? "Desconocido"}
                          </span>
                          <SearchableSelect
                            className="w-44"
                            options={(options?.credit_roles ?? []).map(([value, label]) => ({ value, label }))}
                            value={credit.role}
                            onSelect={(role) => {
                              setDefaultCredits((current) =>
                                current.map((item) => (item.party_id === credit.party_id ? { ...item, role } : item))
                              );
                              invalidateValidation();
                            }}
                            placeholder="Buscar rol…"
                          />
                          <button
                            type="button"
                            aria-label="Quitar colaborador"
                            onClick={() => {
                              setDefaultCredits((current) =>
                                current.filter((item) => item.party_id !== credit.party_id)
                              );
                              invalidateValidation();
                            }}
                          >
                            <X className="size-3.5 text-tertiary hover:text-danger-primary" />
                          </button>
                        </div>
                      ))}
                      {!defaultCredits.length && (
                        <p className="text-11 text-tertiary">Sin colaboradores compartidos.</p>
                      )}
                    </div>
                  </div>

                  {(
                    [
                      ["company", "Agregadoras y distribuidoras", defaultCompanyIds, setDefaultCompanyIds, companies.map((item) => ({ value: item.id, label: item.name }))],
                      ["genre", "Géneros", defaultGenreIds, setDefaultGenreIds, genres.map((item) => ({ value: item.id, label: item.name }))],
                      ["release", "Releases", defaultReleaseIds, setDefaultReleaseIds, releases.map((item) => ({ value: item.id, label: item.title }))],
                    ] as const
                  ).map(([type, label, selectedIds, setSelectedIds, optionsList]) => (
                    <div key={type}>
                      <span className="text-11 font-semibold">{label}</span>
                      <SearchableSelect
                        className="mt-1.5"
                        options={optionsList.filter((option) => !selectedIds.includes(option.value))}
                        value=""
                        onSelect={(id) => {
                          if (!id) return;
                          setSelectedIds((current) => [...current, id]);
                          invalidateValidation();
                        }}
                        onCreate={(name) => void addInline(type)(name)}
                        placeholder={`Buscar o crear…`}
                      />
                      <div className="mt-2 flex flex-wrap gap-2">
                        {selectedIds.map((id) => (
                          <span
                            key={id}
                            className="flex items-center gap-1 rounded-full border border-subtle bg-layer-1 px-2.5 py-1 text-11"
                          >
                            {optionsList.find((option) => option.value === id)?.label ?? "Desconocido"}
                            <button
                              type="button"
                              aria-label="Quitar"
                              onClick={() => {
                                setSelectedIds((current) => current.filter((item) => item !== id));
                                invalidateValidation();
                              }}
                            >
                              <X className="size-3 text-tertiary hover:text-danger-primary" />
                            </button>
                          </span>
                        ))}
                        {!selectedIds.length && <p className="text-11 text-tertiary">Ninguno seleccionado.</p>}
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              {!!preview.artist_examples.length && (
                <section className="rounded-lg border border-subtle bg-layer-2 p-4">
                  <h3 className="text-12 font-semibold">Separación de artistas detectada</h3>
                  <p className="mt-1 text-11 text-secondary">
                    Reconoce comas, FT, F.T., feat., and, y, ampersands y pipes.
                  </p>
                  <div className="mt-3 space-y-2">
                    {preview.artist_examples.map((example) => (
                      <div key={example.source} className="text-11">
                        <span className="text-tertiary">{example.source}</span>
                        <span className="mx-2">→</span>
                        <span>{example.detected.join(" · ")}</span>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              <div className="overflow-x-auto rounded-lg border border-subtle">
                <table className="min-w-full text-left text-11">
                  <thead className="bg-layer-2">
                    <tr>
                      {preview.headers.slice(0, 8).map((header) => (
                        <th key={header} className="px-3 py-2 whitespace-nowrap">
                          {header}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.slice(0, 5).map((row) => (
                      <tr
                        key={preview.headers.map((header) => String(row[header] ?? "")).join("|")}
                        className="border-t border-subtle"
                      >
                        {preview.headers.slice(0, 8).map((header) => (
                          <td key={header} className="max-w-48 truncate px-3 py-2">
                            {String(row[header] ?? "")}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

            </>
          )}

          {result && (
            <div
              className={`rounded-lg border p-4 ${result.errors.length ? "border-warning-strong bg-warning-subtle/40" : "border-success-strong bg-success-subtle/40"}`}
            >
              <div className="flex items-center gap-2 text-13 font-semibold">
                {result.errors.length ? (
                  <AlertCircle className="size-4 text-warning-primary" />
                ) : (
                  <CheckCircle2 className="size-4 text-success-primary" />
                )}
                {validatedKey === validationKey && result.errors.length === 0
                  ? "Validación exitosa — así quedaría la importación"
                  : result.errors.length
                    ? "Resultado con problemas"
                    : "Resultado de la importación"}
              </div>
              {/* counts as scannable chips instead of a sentence */}
              <div className="mt-2.5 flex flex-wrap gap-1.5 text-11">
                <span className="rounded-full border border-subtle bg-layer-1 px-2 py-0.5">{result.total} filas</span>
                <span className="rounded-full bg-success-subtle px-2 py-0.5 font-medium text-success-primary">
                  +{result.created} nuevas
                </span>
                <span className="rounded-full bg-accent-primary/10 px-2 py-0.5 font-medium text-accent-primary">
                  ~{result.updated} actualizadas
                </span>
                <span className="rounded-full border border-subtle bg-layer-1 px-2 py-0.5 text-secondary">
                  ={result.skipped} conservadas
                </span>
                {result.errors.length > 0 && (
                  <span className="rounded-full bg-danger-subtle px-2 py-0.5 font-medium text-danger-primary">
                    ✕{result.errors.length} con error
                  </span>
                )}
              </div>
              {result.unparseable && Object.keys(result.unparseable).length > 0 && (
                <VariableResolver
                  unparseable={result.unparseable}
                  overrides={valueOverrides}
                  formatExamples={preview?.format_examples ?? {}}
                  onResolve={resolveVariable}
                />
              )}
              {result.errors.length > 0 && (
                <div className="mt-3 space-y-3">
                  <div className="rounded-lg border border-warning-subtle bg-layer-1 p-3">
                    <p className="text-12 font-semibold">¿Qué deseas hacer con las filas inválidas?</p>
                    <div className="mt-2 grid gap-2 sm:grid-cols-2">
                      <button
                        type="button"
                        onClick={() => setInvalidRowStrategy("skip")}
                        className={`rounded-md border p-3 text-left text-11 ${invalidRowStrategy === "skip" ? "border-accent-primary bg-accent-primary/5" : "border-subtle"}`}
                      >
                        <strong className="block text-12">Omitir únicamente estas filas</strong>
                        Importa todas las filas válidas y conserva este reporte de errores.
                      </button>
                      <button
                        type="button"
                        onClick={() => setInvalidRowStrategy("abort")}
                        className={`rounded-md border p-3 text-left text-11 ${invalidRowStrategy === "abort" ? "border-accent-primary bg-accent-primary/5" : "border-subtle"}`}
                      >
                        <strong className="block text-12">Corregir antes de importar</strong>
                        Ningún registro se guardará hasta que la validación esté completa.
                      </button>
                    </div>
                  </div>
                  <div className="max-h-80 space-y-2 overflow-y-auto">
                    {result.errors.map((error) => (
                      <div
                        key={`${error.row}-${error.message}`}
                        className="rounded-md border border-subtle bg-layer-1 p-3"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div>
                            <p className="text-12 font-semibold text-danger-primary">
                              Fila {error.row}: {error.message}
                            </p>
                            <p className="mt-0.5 text-10 text-tertiary">
                              {error.field ? `Campo: ${error.field}` : "Error general de la fila"}
                              {error.column ? ` · Columna: ${error.column}` : ""}
                            </p>
                          </div>
                          <span className="rounded-full bg-danger-subtle px-2 py-0.5 text-10 text-danger-primary">
                            {error.code}
                          </span>
                        </div>
                        <details className="mt-2 text-10 text-secondary">
                          <summary className="cursor-pointer">Ver valores de la fila</summary>
                          <div className="mt-1 grid gap-1 sm:grid-cols-2">
                            {Object.entries(error.row_data ?? {}).map(([column, value]) => (
                              <p key={column} className="truncate">
                                <strong>{column}:</strong> {String(value ?? "—")}
                              </p>
                            ))}
                          </div>
                        </details>
                        {error.field && (
                          <label className="mt-2 block text-10 font-medium text-secondary">
                            Valor de reemplazo para {error.field}
                            <input
                              className={`${MUSIC_FIELD} mt-1`}
                              value={rowOverrides[String(error.row)]?.[error.field] ?? String(error.value ?? "")}
                              onChange={(event) => {
                                setRowOverrides((current) => ({
                                  ...current,
                                  [String(error.row)]: {
                                    ...current[String(error.row)],
                                    [error.field!]: event.target.value,
                                  },
                                }));
                                setValidatedKey(undefined);
                              }}
                              placeholder="Escribe el valor correcto"
                            />
                          </label>
                        )}
                      </div>
                    ))}
                  </div>
                  {Object.keys(rowOverrides).length > 0 && (
                    <Button variant="secondary" size="sm" loading={isRunning} onClick={() => void run(true)}>
                      Volver a validar las correcciones
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <footer className="sticky bottom-0 flex flex-wrap items-center justify-between gap-3 border-t border-subtle bg-surface-1 px-5 py-4">
          <div className="min-w-0 text-11 text-secondary">
            {!source && "Elige un archivo CSV o XLSX (o reimporta uno guardado) para empezar."}
            {source && missingRequired.length > 0 && "Mapea el título de la canción para continuar."}
            {source && missingRequired.length === 0 && validatedKey !== validationKey && (
              <span className="flex items-center gap-1.5">
                <ShieldCheck className="size-3.5" /> Valida el mapeo antes de importar.
              </span>
            )}
            {validatedKey === validationKey && !result?.errors.length && !hasApplied && (
              <span className="flex items-center gap-1.5 text-success-primary">
                <CheckCircle2 className="size-3.5" /> Validación exitosa. Listo para importar.
              </span>
            )}
            {validatedKey === validationKey && Boolean(result?.errors.length) && invalidRowStrategy === "abort" && (
              <span className="flex items-center gap-1.5 text-warning-primary">
                <AlertCircle className="size-3.5" /> Corrige los valores o elige omitir las filas inválidas.
              </span>
            )}
            {hasApplied && assetId && "La importación terminó. Decide si deseas conservar el archivo de origen."}
          </div>
          <div className="flex items-center gap-2">
            {hasApplied && assetId ? (
              <>
                <Button variant="secondary" size="sm" onClick={onClose}>
                  Conservar archivo
                </Button>
                <Button variant="error-fill" size="sm" loading={isRunning} onClick={() => setIsDeleteSourceOpen(true)}>
                  Eliminar archivo
                </Button>
              </>
            ) : (
              <>
                <Button variant="secondary" size="sm" onClick={onClose}>
                  Cancelar
                </Button>
                {validatedKey !== validationKey && (
                  <Button
                    variant="primary"
                    size="sm"
                    loading={isRunning}
                    disabled={!source || missingRequired.length > 0 || preview?.database_ready === false}
                    onClick={() => void run(true)}
                  >
                    Validar archivo
                  </Button>
                )}
                {validatedKey === validationKey &&
                  (!result?.errors.length || invalidRowStrategy === "skip") &&
                  !hasApplied && (
                    <Button
                      variant="primary"
                      size="sm"
                      loading={isRunning}
                      disabled={!source || preview?.database_ready === false}
                      onClick={() => void run(false)}
                    >
                      {result?.errors.length ? "Importar filas válidas" : "Importar registros"}
                    </Button>
                  )}
              </>
            )}
          </div>
        </footer>
      </div>
      <FilePreviewModal
        workspaceSlug={workspaceSlug}
        file={
          isFilePreviewOpen && assetId
            ? { assetId, name: sourceName ?? "Archivo de importación", contentType: file?.type ?? "" }
            : null
        }
        onClose={() => setIsFilePreviewOpen(false)}
        scope="music"
      />
      <AlertModalCore
        isOpen={isDeleteSourceOpen}
        isSubmitting={isRunning}
        handleClose={() => setIsDeleteSourceOpen(false)}
        handleSubmit={() => void deleteSourceFile()}
        title="¿Eliminar el archivo de origen?"
        content="El CSV o Excel dejará de estar disponible en los archivos de importación de Music. Las canciones y relaciones que ya se importaron no se eliminarán. Esta acción no se puede deshacer."
      />
    </BudgetPeekPanel>
  );
}
