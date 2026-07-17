import { useEffect, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, FileSpreadsheet, Plus, Search, ShieldCheck, X, WandSparkles } from "lucide-react";
import { Button } from "@plane/propel/button";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type {
  TMusicCatalogOptions,
  TMusicCompany,
  TMusicGenre,
  TMusicImportPreview,
  TMusicImportResult,
  TMusicParty,
  TMusicRelease,
} from "@plane/types";
import { musicService } from "@/services/music.service";
import { BudgetPeekPanel } from "../payments/budget-peek-panel";
import { MusicResourcePickerModal, type MusicResourceType } from "./resource-picker-modal";
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
  const [preview, setPreview] = useState<TMusicImportPreview>();
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [strategy, setStrategy] = useState<"skip" | "update" | "error">("skip");
  const [result, setResult] = useState<TMusicImportResult>();
  const [isRunning, setIsRunning] = useState(false);
  const [defaultCredits, setDefaultCredits] = useState<DefaultCredit[]>([]);
  const [defaultCompanyIds, setDefaultCompanyIds] = useState<string[]>([]);
  const [defaultGenreIds, setDefaultGenreIds] = useState<string[]>([]);
  const [defaultReleaseIds, setDefaultReleaseIds] = useState<string[]>([]);
  const [picker, setPicker] = useState<{ type: MusicResourceType; defaultKind?: string }>();
  const [fieldQuery, setFieldQuery] = useState("");
  const [validatedKey, setValidatedKey] = useState<string>();

  const missingRequired = REQUIRED_IMPORT_FIELDS.filter((field) => !mapping[field]);
  const validationKey = JSON.stringify({
    mapping,
    strategy,
    sheet: preview?.selected_sheet,
    defaultCredits,
    defaultCompanyIds,
    defaultGenreIds,
    defaultReleaseIds,
  });
  const visibleFields = useMemo(() => {
    const query = fieldQuery.trim().toLowerCase();
    const importFields = options?.import_fields ?? [];
    return query ? importFields.filter((field) => field.toLowerCase().includes(query)) : importFields;
  }, [fieldQuery, options?.import_fields]);

  useEffect(() => {
    if (!isOpen) return;
    setFile(undefined);
    setPreview(undefined);
    setMapping({});
    setResult(undefined);
    setStrategy("skip");
    setDefaultCredits([]);
    setDefaultCompanyIds([]);
    setDefaultGenreIds([]);
    setDefaultReleaseIds([]);
    setPicker(undefined);
    setFieldQuery("");
    setValidatedKey(undefined);
  }, [isOpen]);

  const inspect = async (selected: File, sheet?: string) => {
    setIsRunning(true);
    try {
      const next = await musicService.previewImport(workspaceSlug, selected, sheet);
      setPreview(next);
      setMapping(next.mapping);
      setResult(undefined);
      setValidatedKey(undefined);
    } catch (error) {
      setToast({ type: TOAST_TYPE.ERROR, title: "No se pudo leer el archivo", message: getApiError(error) });
    } finally {
      setIsRunning(false);
    }
  };

  const choose = (selected?: File) => {
    setFile(selected);
    setPreview(undefined);
    setResult(undefined);
    setMapping({});
    if (selected) void inspect(selected);
  };

  const run = async (dryRun: boolean) => {
    if (!file) return;
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
        file,
        mapping,
        strategy,
        dryRun,
        preview?.selected_sheet ?? undefined,
        {
          credit_entries: defaultCredits,
          distribution_entries: defaultCompanyIds.map((company_id) => ({ company_id })),
          genre_ids: defaultGenreIds,
          releases: defaultReleaseIds.map((id) => ({ id })),
        }
      );
      setResult(next);
      if (dryRun) setValidatedKey(next.errors.length === 0 ? validationKey : undefined);
      if (!dryRun) {
        setToast({
          type: next.errors.length ? TOAST_TYPE.ERROR : TOAST_TYPE.SUCCESS,
          title: next.errors.length ? "Importación completada con problemas" : "Catálogo importado",
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

  const applyPicker = (ids: string[]) => {
    if (picker?.type === "party")
      setDefaultCredits((current) => [
        ...current.filter((credit) => !ids.includes(credit.party_id)),
        ...ids.map((party_id) => ({ party_id, role: "PRIMARY_ARTIST" })),
      ]);
    if (picker?.type === "company") setDefaultCompanyIds(ids);
    if (picker?.type === "genre") setDefaultGenreIds(ids);
    if (picker?.type === "release") setDefaultReleaseIds(ids);
    setResult(undefined);
    setValidatedKey(undefined);
  };

  const updateMapping = (field: string, column: string) => {
    setMapping((current) => ({ ...current, [field]: column }));
    setResult(undefined);
    setValidatedKey(undefined);
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
          <div className="grid grid-cols-3 overflow-hidden rounded-lg border border-subtle bg-layer-1 text-11">
            {[
              ["1", "Elegir archivo", Boolean(file)],
              ["2", "Mapear columnas", Boolean(preview) && missingRequired.length === 0],
              ["3", "Validar e importar", validatedKey === validationKey],
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
          <label className="hover:border-accent-primary flex cursor-pointer flex-col items-center rounded-xl border border-dashed border-subtle bg-layer-2 px-5 py-7 text-center">
            <FileSpreadsheet className="mb-2 size-7 text-tertiary" />
            <span className="text-13 font-medium">{file?.name ?? "Elegir CSV o XLSX"}</span>
            <span className="mt-1 text-11 text-tertiary">Soporta headers desordenados y formatos de fecha mezclados</span>
            <input
              className="hidden"
              type="file"
              accept=".csv,.xlsx,.xlsm,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={(event) => choose(event.target.files?.[0])}
            />
          </label>

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
                    onSelect={(sheet) => file && void inspect(file, sheet)}
                    placeholder="Buscar hojas…"
                  />
                )}
              </div>

              <section>
                <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
                  <div>
                    <h3 className="text-14 font-semibold">Mapeo de columnas</h3>
                    <p className="text-11 text-secondary">
                      Solo el título de la canción es obligatorio; el resto es opcional.
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="flex items-center gap-1 text-11 text-tertiary">
                      <WandSparkles className="size-3.5" /> {Object.values(mapping).filter(Boolean).length} mapeadas
                    </span>
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
                        Selecciona la columna que contiene el nombre de cada canción. La importación queda bloqueada hasta mapearla.
                      </p>
                    </div>
                  </div>
                )}
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {visibleFields.map((field) => (
                    <div
                      key={field}
                      className={`grid grid-cols-1 items-center gap-2 rounded-md border px-3 py-2 md:grid-cols-2 ${
                        field === "track.title" && !mapping[field] ? "border-warning-strong" : "border-subtle"
                      }`}
                    >
                      <span className="truncate text-11 text-secondary">
                        {field}
                        {field === "track.title" && <span className="text-danger-primary"> *</span>}
                      </span>
                      <SearchableSelect
                        options={[
                          { value: "", label: "No importar" },
                          ...preview.headers.map((header) => ({ value: header, label: header })),
                        ]}
                        value={mapping[field] ?? ""}
                        onSelect={(column) => updateMapping(field, column)}
                        placeholder="Buscar columna origen…"
                      />
                    </div>
                  ))}
                </div>
              </section>

              <section className="rounded-xl border border-subtle bg-layer-2 p-4">
                <div>
                  <h3 className="text-14 font-semibold">Aplicar a cada canción importada</h3>
                  <p className="mt-1 text-11 text-secondary">
                    Relaciones compartidas opcionales que se agregan a cada fila. Las relaciones idénticas existentes se conservan.
                  </p>
                </div>
                <div className="mt-4 grid gap-4 lg:grid-cols-2">
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-11 font-semibold">Artistas, escritores y colaboradores</span>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setPicker({ type: "party", defaultKind: "ARTIST" })}
                      >
                        <Plus className="mr-1 size-3.5" /> Add
                      </Button>
                    </div>
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
                              setResult(undefined);
                              setValidatedKey(undefined);
                            }}
                            placeholder="Buscar rol…"
                          />
                          <button
                            type="button"
                            onClick={() =>
                              setDefaultCredits((current) =>
                                current.filter((item) => item.party_id !== credit.party_id)
                              )
                            }
                          >
                            <X className="size-3.5 text-tertiary" />
                          </button>
                        </div>
                      ))}
                      {!defaultCredits.length && <p className="text-11 text-tertiary">Sin colaboradores compartidos.</p>}
                    </div>
                  </div>

                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-11 font-semibold">Agregadoras y distribuidoras</span>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setPicker({ type: "company", defaultKind: "AGGREGATOR" })}
                      >
                        <Plus className="mr-1 size-3.5" /> Add
                      </Button>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {defaultCompanyIds.map((id) => (
                        <span key={id} className="rounded-full border border-subtle bg-layer-1 px-2.5 py-1 text-11">
                          {companies.find((item) => item.id === id)?.name ?? "Compañía desconocida"}
                        </span>
                      ))}
                      {!defaultCompanyIds.length && <p className="text-11 text-tertiary">Sin compañía compartida.</p>}
                    </div>
                  </div>

                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-11 font-semibold">Géneros</span>
                      <Button variant="secondary" size="sm" onClick={() => setPicker({ type: "genre" })}>
                        <Plus className="mr-1 size-3.5" /> Add
                      </Button>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {defaultGenreIds.map((id) => (
                        <span key={id} className="rounded-full border border-subtle bg-layer-1 px-2.5 py-1 text-11">
                          {genres.find((item) => item.id === id)?.name ?? "Género desconocido"}
                        </span>
                      ))}
                      {!defaultGenreIds.length && <p className="text-11 text-tertiary">Sin género compartido.</p>}
                    </div>
                  </div>

                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-11 font-semibold">Releases</span>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setPicker({ type: "release", defaultKind: "SINGLE" })}
                      >
                        <Plus className="mr-1 size-3.5" /> Add
                      </Button>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {defaultReleaseIds.map((id) => (
                        <span key={id} className="rounded-full border border-subtle bg-layer-1 px-2.5 py-1 text-11">
                          {releases.find((item) => item.id === id)?.title ?? "Release desconocido"}
                        </span>
                      ))}
                      {!defaultReleaseIds.length && <p className="text-11 text-tertiary">Sin release compartido.</p>}
                    </div>
                  </div>
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

              <div className="grid gap-2 sm:grid-cols-3">
                {(
                  [
                    ["skip", "Conservar existentes"],
                    ["update", "Actualizar duplicados"],
                    ["error", "Marcar duplicados como error"],
                  ] as const
                ).map(([value, label]) => (
                  <label
                    key={value}
                    className={`cursor-pointer rounded-lg border p-3 text-12 ${strategy === value ? "border-accent-primary bg-accent-primary/5" : "border-subtle"}`}
                  >
                    <input
                      className="mr-2"
                      type="radio"
                      checked={strategy === value}
                      onChange={() => {
                        setStrategy(value);
                        setResult(undefined);
                        setValidatedKey(undefined);
                      }}
                    />
                    {label}
                  </label>
                ))}
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
                <span className="rounded-full border border-subtle bg-layer-1 px-2 py-0.5">
                  {result.total} filas
                </span>
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
              {result.errors.length > 0 && (
                <div className="mt-2.5 max-h-40 space-y-1 overflow-y-auto rounded-md border border-subtle bg-layer-1 p-2">
                  {result.errors.map((error) => (
                    <p key={`${error.row}-${error.message}`} className="text-11 text-danger-primary">
                      <span className="font-mono font-medium">Fila {error.row}:</span> {error.message}
                    </p>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <footer className="sticky bottom-0 flex flex-wrap items-center justify-between gap-3 border-t border-subtle bg-surface-1 px-5 py-4">
          <div className="min-w-0 text-11 text-secondary">
            {!file && "Elige un archivo CSV o XLSX para empezar."}
            {file && missingRequired.length > 0 && "Mapea el título de la canción para continuar."}
            {file && missingRequired.length === 0 && validatedKey !== validationKey && (
              <span className="flex items-center gap-1.5">
                <ShieldCheck className="size-3.5" /> Valida el mapeo antes de importar.
              </span>
            )}
            {validatedKey === validationKey && (
              <span className="flex items-center gap-1.5 text-success-primary">
                <CheckCircle2 className="size-3.5" /> Validación exitosa. Listo para importar.
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={onClose}>
              Cerrar
            </Button>
            <Button
              variant="secondary"
              size="sm"
              loading={isRunning}
              disabled={!file || missingRequired.length > 0 || preview?.database_ready === false}
              onClick={() => void run(true)}
            >
              Validar
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={isRunning}
              disabled={!file || validatedKey !== validationKey || preview?.database_ready === false}
              onClick={() => void run(false)}
            >
              Importar registros
            </Button>
          </div>
        </footer>
      </div>
      <MusicResourcePickerModal
        workspaceSlug={workspaceSlug}
        isOpen={Boolean(picker)}
        resourceType={picker?.type ?? "party"}
        title={
          picker?.type === "party"
            ? "Colaboradores compartidos"
            : picker?.type === "company"
              ? "Compañías compartidas"
              : picker?.type === "release"
                ? "Releases compartidos"
                : "Géneros compartidos"
        }
        items={
          picker?.type === "party"
            ? parties
            : picker?.type === "company"
              ? companies
              : picker?.type === "release"
                ? releases
                : genres
        }
        selectedIds={
          picker?.type === "party"
            ? defaultCredits.map((credit) => credit.party_id)
            : picker?.type === "company"
              ? defaultCompanyIds
              : picker?.type === "release"
                ? defaultReleaseIds
                : defaultGenreIds
        }
        options={options}
        defaultKind={picker?.defaultKind}
        onClose={() => setPicker(undefined)}
        onSelect={applyPicker}
        onChanged={onResourcesChanged}
      />
    </BudgetPeekPanel>
  );
}
