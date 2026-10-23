import { useDeferredValue, useEffect, useMemo, useState } from "react";
import {
  CalendarClock,
  Disc3,
  Download,
  FolderArchive,
  FileSpreadsheet,
  FileUp,
  Link as LinkIcon,
  Music2,
  Plus,
  Search,
  Trash2,
  Users,
  Video,
} from "lucide-react";
import { useNavigate, useSearchParams } from "react-router";
import useSWR from "swr";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TMusicFilters, TMusicRelease, TMusicTrack } from "@plane/types";
import { AlertModalCore } from "@plane/ui";
import { cn } from "@plane/utils";
import { setAssistantSelection } from "@/components/assistant/page-context";
import { BulkTagMenu } from "@/components/references/bulk-tag-menu";
import { useWorkspace } from "@/hooks/store/use-workspace";
import { musicService } from "@/services/music.service";
import { MusicEntityManager } from "./entity-manager";
import { MusicAppliedFilters, MusicFiltersDropdown, type TMusicFiltersData } from "./filters";
import { MusicImportAssetsPanel } from "./import-assets-panel";
import { MusicReleaseModal } from "./release-modal";
import { formatDate } from "./import/constants";
import { getApiError, musicDate } from "./shared";
import { actionButton, actionLabel, MusicTableActionBar } from "./table-action-bar";
import { MusicTrackPeekPanel } from "./track-peek-panel";
import { AskAssistantButton } from "@/components/assistant/ask";

type Props = { workspaceSlug: string };
const PAGE_SIZE = 25;

/** Status → design-system tone (no hardcoded palette colors) */
const STATUS_TONE: Record<string, string> = {
  RELEASED: "bg-success-subtle text-success-primary",
  SCHEDULED: "bg-accent-primary/10 text-accent-primary",
  READY: "bg-warning-subtle text-warning-primary",
  TAKEN_DOWN: "bg-danger-subtle text-danger-primary",
  DRAFT: "border border-subtle bg-layer-2 text-secondary",
};

const statusPill = (value: string) => (
  <span
    className={`inline-flex rounded-full px-2 py-0.5 text-10 font-medium ${STATUS_TONE[value] ?? STATUS_TONE.DRAFT}`}
  >
    {value.replaceAll("_", " ")}
  </span>
);

const badge = (value: string, green = false) => (
  <span
    className={`inline-flex rounded-full px-2 py-0.5 text-10 font-medium ${green ? "bg-success-subtle text-success-primary" : "border border-subtle bg-layer-2 text-secondary"}`}
  >
    {value.replaceAll("_", " ")}
  </span>
);

const artistNames = (track: TMusicTrack) =>
  track.credits
    .filter((credit) => credit.role === "PRIMARY_ARTIST" || credit.role === "FEATURED_ARTIST")
    .map((credit) => credit.party.display_name)
    .join(", ");

/** Loading placeholders mirroring the real row/card geometry */
const SkeletonBar = ({ className }: { className: string }) => (
  <span className={`block animate-pulse rounded-sm bg-layer-2 ${className}`} />
);

const TrackRowSkeleton = () => (
  <tr className="border-t border-subtle">
    <td className="px-4 py-3">
      <SkeletonBar className="size-4" />
    </td>
    <td className="px-4 py-3">
      <div className="flex items-center gap-3">
        <SkeletonBar className="size-10 rounded-md" />
        <div className="space-y-1.5">
          <SkeletonBar className="h-3 w-40" />
          <SkeletonBar className="h-2.5 w-24" />
        </div>
      </div>
    </td>
    <td className="px-4 py-3">
      <SkeletonBar className="h-3 w-28" />
    </td>
    <td className="px-4 py-3">
      <SkeletonBar className="h-3 w-24" />
    </td>
    <td className="px-4 py-3">
      <SkeletonBar className="h-3 w-16" />
    </td>
    <td className="px-4 py-3">
      <SkeletonBar className="h-3 w-20" />
    </td>
    <td className="px-4 py-3">
      <SkeletonBar className="h-3 w-12" />
    </td>
  </tr>
);

const TrackCardSkeleton = () => (
  <article className="rounded-lg border border-subtle bg-layer-1 p-4">
    <div className="flex gap-3">
      <SkeletonBar className="size-14 rounded-lg" />
      <div className="flex-1 space-y-2">
        <SkeletonBar className="h-3.5 w-3/4" />
        <SkeletonBar className="h-2.5 w-1/2" />
        <SkeletonBar className="h-2.5 w-2/3" />
      </div>
    </div>
  </article>
);

const DEEP_LINK_KEYS = ["import_run", "import_file", "import_files", "track", "release", "artist"];

export function MusicCatalogRoot({ workspaceSlug }: Props) {
  const { t, currentLocale } = useTranslation();
  const navigate = useNavigate();
  // Selected songs can be tagged with the workspace's shared tags.
  const { isWorkspaceFeatureEnabled } = useWorkspace();
  const referencesEnabled = isWorkspaceFeatureEnabled(workspaceSlug, "references");
  const [searchParams, setSearchParams] = useSearchParams();
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  // ?import_run=<id> / ?import_file=<asset id> arrive from the import result
  // and the file history: the catalog opens filtered to those songs.
  const [filters, setFilters] = useState<TMusicFilters>(() => ({
    songs_only: "true",
    // ?artist=<id> arrives from a mention or a shared tag.
    ...(searchParams.get("artist") ? { artist: searchParams.get("artist")! } : {}),
    ...(searchParams.get("import_run") ? { import_run: searchParams.get("import_run")! } : {}),
    ...(searchParams.get("import_file") ? { import_file: searchParams.get("import_file")! } : {}),
  }));
  const [page, setPage] = useState(1);
  const [editingRelease, setEditingRelease] = useState<TMusicRelease>();
  const [peekTrack, setPeekTrack] = useState<TMusicTrack>();
  const [peekCreateOpen, setPeekCreateOpen] = useState(false);
  const [releaseOpen, setReleaseOpen] = useState(false);
  const [resourcesOpen, setResourcesOpen] = useState(false);
  const [importAssetsOpen, setImportAssetsOpen] = useState(() => searchParams.get("import_files") === "1");
  const openImport = () => navigate(`/${workspaceSlug}/music/import`);

  // The deep-link params seeded state once; drop them so a reload or a
  // shared link doesn't keep re-applying a filter the user already removed.
  useEffect(() => {
    if (!DEEP_LINK_KEYS.some((key) => searchParams.has(key))) return;
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        DEEP_LINK_KEYS.forEach((key) => next.delete(key));
        return next;
      },
      { replace: true }
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // ?track=<id> / ?release=<id> (mentions, references, shared tags) open
  // that song's panel or that release's editor.
  const [linkedRelease, setLinkedRelease] = useState(() => searchParams.get("release"));
  useEffect(() => {
    const trackId = searchParams.get("track");
    if (!trackId) return;
    void musicService
      .getTracks(workspaceSlug, { ids: trackId })
      .then((response) => {
        const found = (Array.isArray(response) ? response : response.results)[0];
        if (found) setPeekTrack(found);
        return undefined;
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [deletingTrack, setDeletingTrack] = useState<TMusicTrack>();
  const [isDeletingTrack, setIsDeletingTrack] = useState(false);
  const [selectedTrackIds, setSelectedTrackIds] = useState<string[]>([]);
  // The assistant knows which songs are selected ("estas canciones").
  useEffect(() => {
    setAssistantSelection({ entity_name: "music_track", ids: selectedTrackIds });
  }, [selectedTrackIds]);
  useEffect(() => () => setAssistantSelection(null), []);
  const [isBulkDeleteOpen, setIsBulkDeleteOpen] = useState(false);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);
  const [isSelectingAllMatching, setIsSelectingAllMatching] = useState(false);

  const exportQuery = { ...filters, search: deferredSearch || undefined };
  const query = { ...exportQuery, page: String(page), page_size: String(PAGE_SIZE) };
  const { data: options } = useSWR(`MUSIC_OPTIONS_${workspaceSlug}`, () => musicService.getOptions(workspaceSlug));
  // Names the file behind "?import_run=": same key as the import page's list.
  const { data: importAssets } = useSWR(filters.import_run ? `MUSIC_IMPORT_ASSETS_${workspaceSlug}_` : null, () =>
    musicService.getImportAssets(workspaceSlug)
  );
  const filteredRun = useMemo(() => {
    for (const asset of importAssets?.results ?? []) {
      const run = asset.runs?.find((item) => item.id === filters.import_run);
      if (run) return { file: asset.name, importedAt: run.imported_at };
    }
    return undefined;
  }, [filters.import_run, importAssets]);
  const { data: parties = [], mutate: mutateParties } = useSWR(`MUSIC_PARTIES_${workspaceSlug}`, () =>
    musicService.getParties(workspaceSlug)
  );
  const { data: companies = [], mutate: mutateCompanies } = useSWR(`MUSIC_COMPANIES_${workspaceSlug}`, () =>
    musicService.getCompanies(workspaceSlug)
  );
  const { data: genres = [], mutate: mutateGenres } = useSWR(`MUSIC_GENRES_${workspaceSlug}`, () =>
    musicService.getGenres(workspaceSlug)
  );
  const { data: releases = [], mutate: mutateReleases } = useSWR(["MUSIC_RELEASES", workspaceSlug], () =>
    musicService.getReleases(workspaceSlug)
  );
  const {
    data: trackResponse,
    isLoading,
    mutate: mutateTracks,
  } = useSWR(["MUSIC_TRACKS", workspaceSlug, query], () => musicService.getTracks(workspaceSlug, query), {
    keepPreviousData: true,
  });

  useEffect(() => {
    if (!linkedRelease || releaseOpen) return;
    const found = releases.find((item) => item.id === linkedRelease);
    if (found) {
      setEditingRelease(found);
      setReleaseOpen(true);
      setLinkedRelease(null);
    }
    // Only for the release named in the link, once it has loaded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkedRelease, releases]);

  const trackPage = Array.isArray(trackResponse) ? undefined : trackResponse;
  const tracks = Array.isArray(trackResponse) ? trackResponse : (trackResponse?.results ?? []);
  const totalTracks = trackPage?.total ?? tracks.length;
  const totalPages = Math.max(1, Math.ceil(totalTracks / PAGE_SIZE));
  const firstTrack = totalTracks === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const lastTrack = Math.min(page * PAGE_SIZE, totalTracks);
  const selectedTrackCount = selectedTrackIds.length;
  const isCurrentPageSelected = tracks.length > 0 && tracks.every((track) => selectedTrackIds.includes(track.id));

  useEffect(() => {
    if (trackPage && trackPage.requested_page === page && trackPage.page !== page) setPage(trackPage.page);
  }, [page, trackPage]);

  useEffect(() => {
    if (!peekTrack) return;
    const fresh = tracks.find((item) => item.id === peekTrack.id);
    if (fresh && fresh !== peekTrack) setPeekTrack(fresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracks]);

  const refreshResources = () =>
    void Promise.all([mutateParties(), mutateCompanies(), mutateGenres(), mutateReleases()]);
  const refreshAll = () =>
    void Promise.all([mutateTracks(), mutateParties(), mutateCompanies(), mutateGenres(), mutateReleases()]);
  // songs_only is the base scope, not a user filter
  const hasActiveFilters =
    Boolean(deferredSearch.trim()) ||
    Object.entries(filters).some(([key, value]) => key !== "songs_only" && Boolean(value));
  const clearFilters = () => {
    setSearch("");
    setPage(1);
    setSelectedTrackIds([]);
    setFilters({ songs_only: "true" });
  };
  const setFilter = (key: keyof TMusicFilters, value: string) => {
    setPage(1);
    setSelectedTrackIds([]);
    setFilters((current) => ({ ...current, [key]: value || undefined, songs_only: "true" }));
  };
  const activeFilterCount = Object.entries(filters).filter(
    ([key, value]) => key !== "songs_only" && Boolean(value)
  ).length;

  const filtersData: TMusicFiltersData = useMemo(
    () => ({
      statuses: (options?.track_statuses ?? []).map(([value, label]) => ({ value, label })),
      kinds: (options?.track_kinds ?? []).map(([value, label]) => ({ value, label })),
      artists: parties
        .filter((party) => party.kind === "ARTIST" || party.kind === "GROUP")
        .map((party) => ({ value: party.id, label: party.display_name })),
      genres: genres.map((genre) => ({ value: genre.id, label: genre.name })),
      releases: releases.map((release) => ({ value: release.id, label: release.title })),
      companies: companies.map((company) => ({ value: company.id, label: company.name })),
      importFiles: (options?.import_files ?? []).map((file) => ({
        value: file.asset_id,
        label: `${file.name}${file.runs > 1 ? ` · ${file.runs} importaciones` : ""}`,
      })),
    }),
    [options, parties, genres, releases, companies]
  );

  const removeTrack = async () => {
    if (!deletingTrack) return;
    setIsDeletingTrack(true);
    try {
      await musicService.deleteTrack(workspaceSlug, deletingTrack.id);
      setSelectedTrackIds((current) => current.filter((id) => id !== deletingTrack.id));
      setDeletingTrack(undefined);
      await mutateTracks();
    } catch (error) {
      setToast({ type: TOAST_TYPE.ERROR, title: "Could not delete song", message: getApiError(error) });
    } finally {
      setIsDeletingTrack(false);
    }
  };

  const toggleTrackSelection = (trackId: string) =>
    setSelectedTrackIds((current) =>
      current.includes(trackId) ? current.filter((id) => id !== trackId) : [...current, trackId]
    );

  const toggleCurrentPageSelection = () =>
    setSelectedTrackIds((current) => {
      const currentPageIds = tracks.map((track) => track.id);
      const currentPageIsSelected = currentPageIds.every((id) => current.includes(id));
      return currentPageIsSelected
        ? current.filter((id) => !currentPageIds.includes(id))
        : [...new Set([...current, ...currentPageIds])];
    });

  const selectAllMatching = async () => {
    setIsSelectingAllMatching(true);
    try {
      const { ids } = await musicService.getTrackIds(workspaceSlug, exportQuery);
      setSelectedTrackIds(ids);
    } catch (error) {
      setToast({ type: TOAST_TYPE.ERROR, title: "No se pudo seleccionar todo", message: getApiError(error) });
    } finally {
      setIsSelectingAllMatching(false);
    }
  };

  const downloadSelectedTracks = async () => {
    if (!selectedTrackIds.length) return;
    try {
      await musicService.downloadReport(workspaceSlug, "filtered", "xlsx", {
        ...exportQuery,
        ids: selectedTrackIds.join(","),
      });
    } catch (error) {
      setToast({ type: TOAST_TYPE.ERROR, title: "Could not export selected songs", message: getApiError(error) });
    }
  };

  const removeSelectedTracks = async () => {
    if (!selectedTrackIds.length) return;
    setIsBulkDeleting(true);
    try {
      const { deleted, not_found } = await musicService.deleteTracks(workspaceSlug, selectedTrackIds);
      setSelectedTrackIds([]);
      setIsBulkDeleteOpen(false);
      await mutateTracks();
      setToast({
        type: TOAST_TYPE.SUCCESS,
        title: `${deleted} song${deleted === 1 ? "" : "s"} deleted`,
        message: not_found
          ? `${not_found} selected song${not_found === 1 ? " was" : "s were"} already unavailable.`
          : undefined,
      });
    } catch (error) {
      setToast({ type: TOAST_TYPE.ERROR, title: "Could not delete selected songs", message: getApiError(error) });
    } finally {
      setIsBulkDeleting(false);
    }
  };

  const download = async (window: "upcoming" | "last_30_days" | "filtered", format: "csv" | "xlsx") => {
    try {
      await musicService.downloadReport(workspaceSlug, window, format, exportQuery);
    } catch (error) {
      setToast({ type: TOAST_TYPE.ERROR, title: "Could not export catalog", message: getApiError(error) });
    }
  };

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-surface-1">
      {/* toolbar — compact, Plane-style (search + filters left, actions right) */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-subtle px-3 py-2.5 sm:px-4">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-tertiary" />
            <input
              className="w-40 rounded-md border border-subtle bg-transparent py-1.5 pr-2 pl-8 text-12 sm:w-64"
              value={search}
              onChange={(event) => {
                setPage(1);
                setSelectedTrackIds([]);
                setSearch(event.target.value);
              }}
              placeholder="Buscar canciones, artistas, ISRC…"
            />
          </div>
          <MusicFiltersDropdown
            filters={filters}
            data={filtersData}
            hasActiveFilters={activeFilterCount > 0}
            onSet={setFilter}
          />
          {/* quick filters */}
          <button
            type="button"
            className="flex items-center gap-1 rounded-full border border-subtle px-2.5 py-1 text-11 text-secondary hover:bg-layer-1-hover"
            onClick={() => {
              setPage(1);
              setSelectedTrackIds([]);
              setFilters({ songs_only: "true", has_video: "true" });
            }}
          >
            <Video className="size-3" /> Con video
          </button>
          <button
            type="button"
            className="flex items-center gap-1 rounded-full border border-subtle px-2.5 py-1 text-11 text-secondary hover:bg-layer-1-hover"
            onClick={() => {
              setPage(1);
              setSelectedTrackIds([]);
              setFilters({ songs_only: "true", has_links: "true" });
            }}
          >
            <LinkIcon className="size-3" /> Con enlaces
          </button>
          <button
            type="button"
            className="rounded-full border border-subtle px-2.5 py-1 text-11 text-secondary hover:bg-layer-1-hover"
            onClick={() => {
              setPage(1);
              setSelectedTrackIds([]);
              setFilters({
                songs_only: "true",
                from: new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10),
                to: new Date().toISOString().slice(0, 10),
              });
            }}
          >
            Últimos 30 días
          </button>
          <button
            type="button"
            className="flex items-center gap-1 rounded-full border border-subtle px-2.5 py-1 text-11 text-secondary hover:bg-layer-1-hover"
            onClick={() => {
              setPage(1);
              setSelectedTrackIds([]);
              setFilters({ songs_only: "true", from: new Date().toISOString().slice(0, 10) });
            }}
          >
            <CalendarClock className="size-3" /> Próximos
          </button>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button variant="secondary" size="sm" onClick={() => setResourcesOpen(true)}>
            <Users className="size-3.5" />
            <span className="hidden lg:inline">Recursos</span>
          </Button>
          <Button variant="secondary" size="sm" onClick={openImport}>
            <FileUp className="size-3.5" />
            <span className="hidden lg:inline">Importar</span>
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setImportAssetsOpen(true)}>
            <FolderArchive className="size-3.5" />
            <span className="hidden lg:inline">Archivos</span>
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void download("filtered", "csv")}
            title="Exportar CSV (filtros actuales)"
          >
            <FileSpreadsheet className="size-3.5" />
            <span className="hidden xl:inline">CSV</span>
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void download("filtered", "xlsx")}
            title="Exportar Excel (filtros actuales)"
          >
            <Download className="size-3.5" />
            <span className="hidden xl:inline">Excel</span>
          </Button>
          <Button variant="primary" size="sm" onClick={() => setPeekCreateOpen(true)}>
            <Plus className="size-3.5" />
            <span className="hidden sm:inline">Nueva canción</span>
          </Button>
        </div>
      </div>

      {filters.import_run && (
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-subtle bg-layer-1 px-3 py-2 text-12 sm:px-4">
          <span className="min-w-0 truncate text-secondary">
            {filteredRun
              ? t("music_import.history.run_filter_named", {
                  file: filteredRun.file,
                  date: formatDate(filteredRun.importedAt, currentLocale),
                })
              : t("music_import.history.run_filter")}
          </span>
          <button
            type="button"
            onClick={() => setFilter("import_run", "")}
            className="text-primary underline-offset-2 hover:underline"
          >
            {t("music_import.history.clear_filter")}
          </button>
        </div>
      )}
      {activeFilterCount > 0 && (
        <div className="shrink-0 border-b border-subtle px-3 py-2 sm:px-4">
          <MusicAppliedFilters filters={filters} data={filtersData} onSet={setFilter} onClearAll={clearFilters} />
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col overflow-auto p-3 sm:p-4">
        <div className="mb-2 flex items-center justify-between text-11 text-tertiary">
          <span>
            {isLoading && !tracks.length
              ? "Cargando catálogo…"
              : totalTracks === 0
                ? "Sin canciones"
                : `${firstTrack}-${lastTrack} de ${totalTracks} canciones`}
          </span>
          <span className="hidden sm:inline">Click en una fila para abrir el registro</span>
        </div>
        {isLoading && !tracks.length ? (
          <>
            {/* skeletons mirroring the table / card geometry */}
            <div className="hidden overflow-hidden rounded-md border border-subtle bg-layer-1 md:block">
              <table className="w-full text-left">
                <tbody>
                  {Array.from({ length: 8 }, (_, index) => (
                    <TrackRowSkeleton key={index} />
                  ))}
                </tbody>
              </table>
            </div>
            <div className="grid gap-3 md:hidden">
              {Array.from({ length: 4 }, (_, index) => (
                <TrackCardSkeleton key={index} />
              ))}
            </div>
          </>
        ) : !tracks.length ? (
          hasActiveFilters ? (
            // Filtered search with no matches — never the onboarding screen
            <div className="flex min-h-72 flex-col items-center justify-center rounded-md border border-dashed border-subtle bg-layer-1 p-8 text-center">
              <div className="mb-4 flex size-14 items-center justify-center rounded-full bg-layer-2 text-tertiary">
                <Disc3 className="size-7" />
              </div>
              <h2 className="text-16 font-semibold">No hay registros que coincidan</h2>
              <p className="mt-2 max-w-md text-12 text-secondary">
                Ninguna canción coincide con la búsqueda o los filtros activos.
              </p>
              <div className="mt-5">
                <Button variant="secondary" size="sm" onClick={clearFilters}>
                  Limpiar búsqueda y filtros
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex min-h-72 flex-col items-center justify-center rounded-md border border-dashed border-subtle bg-layer-1 p-8 text-center">
              <div className="mb-4 flex size-14 items-center justify-center rounded-full bg-accent-primary/10 text-accent-primary">
                <Disc3 className="size-7" />
              </div>
              <h2 className="text-16 font-semibold">Construye tu catálogo musical</h2>
              <p className="mt-2 max-w-md text-12 text-secondary">
                Crea la primera canción o importa un CSV/XLSX. Los artistas, releases, géneros y compañías se pueden
                crear durante cualquiera de los dos flujos.
              </p>
              <div className="mt-5 flex gap-2">
                <Button variant="secondary" size="sm" onClick={openImport}>
                  <FileUp className="size-3.5" /> Importar archivo
                </Button>
                <Button variant="primary" size="sm" onClick={() => setPeekCreateOpen(true)}>
                  <Plus className="size-3.5" /> Nueva canción
                </Button>
              </div>
            </div>
          )
        ) : (
          <>
            <div className="hidden overflow-hidden rounded-md border border-subtle bg-layer-1 md:block">
              <table className="w-full text-left">
                <thead className="sticky top-0 z-1 bg-layer-2 text-11 font-medium text-tertiary">
                  <tr>
                    <th className="w-12 px-4 py-2.5">
                      <input
                        type="checkbox"
                        checked={isCurrentPageSelected}
                        onChange={toggleCurrentPageSelection}
                        aria-label="Seleccionar todas las canciones de la página"
                      />
                    </th>
                    <th className="px-4 py-2.5">Canción</th>
                    <th className="px-4 py-2.5">Release</th>
                    <th className="px-4 py-2.5">ISRC</th>
                    <th className="px-4 py-2.5">Estado</th>
                    <th className="px-4 py-2.5">Videos</th>
                    <th className="px-4 py-2.5">Derechos</th>
                    <th className="w-20 px-4 py-2.5" />
                  </tr>
                </thead>
                <tbody>
                  {tracks.map((track) => (
                    <tr
                      key={track.id}
                      className="group cursor-pointer border-t border-subtle hover:bg-layer-1-hover"
                      onClick={() => setPeekTrack(track)}
                    >
                      <td className="px-4 py-2.5">
                        <input
                          type="checkbox"
                          checked={selectedTrackIds.includes(track.id)}
                          onClick={(event) => event.stopPropagation()}
                          onChange={() => toggleTrackSelection(track.id)}
                          aria-label={`Seleccionar ${track.title}`}
                        />
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2.5">
                          <div className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-md bg-accent-primary/10 text-accent-primary">
                            {track.cover_url ? (
                              <img src={track.cover_url} alt="" className="size-full object-cover" />
                            ) : (
                              <Music2 className="size-4" />
                            )}
                          </div>
                          <div className="min-w-0">
                            <p className="truncate text-13 font-medium">
                              {track.title}
                              {track.version && (
                                <span className="font-normal ml-1 text-11 text-tertiary">({track.version})</span>
                              )}
                            </p>
                            <p className="mt-0.5 truncate text-11 text-tertiary">
                              {artistNames(track) || "Sin artista"}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-12">
                        <p className="max-w-44 truncate">
                          {track.release_details.map((release) => release.title).join(", ") || (
                            <span className="text-tertiary">Independiente</span>
                          )}
                        </p>
                        <p className="mt-0.5 text-11 text-tertiary">{musicDate(track.release_date)}</p>
                      </td>
                      <td className="px-4 py-2.5">
                        {track.isrc ? (
                          <code className="font-mono text-11">{track.isrc}</code>
                        ) : (
                          <span className="text-11 text-placeholder">—</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">{statusPill(track.status)}</td>
                      <td className="px-4 py-2.5 text-12">
                        {track.video_details.length ? (
                          <span className="flex items-center gap-1 text-success-primary">
                            <Video className="size-3.5" /> {track.video_details.length}
                          </span>
                        ) : (
                          <span className="text-placeholder">—</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-11 text-tertiary">
                        {track.credits.filter((credit) => credit.percentage !== null).length} splits ·{" "}
                        {track.distributions.filter((entry) => entry.percentage !== null).length} com.
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex justify-end opacity-0 transition-opacity group-hover:opacity-100">
                          <button
                            type="button"
                            className="rounded-sm p-1.5 text-secondary hover:bg-danger-subtle hover:text-danger-primary"
                            title="Eliminar"
                            onClick={(event) => {
                              event.stopPropagation();
                              setDeletingTrack(track);
                            }}
                          >
                            <Trash2 className="size-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="grid gap-3 md:hidden">
              {tracks.map((track) => (
                <article
                  key={track.id}
                  className="rounded-lg border border-subtle bg-layer-1 p-4"
                  // The card holds its own controls, so it can't be a <button>
                  // (nested interactive elements); the role keeps it reachable.
                  // eslint-disable-next-line jsx-a11y/prefer-tag-over-role
                  role="button"
                  tabIndex={0}
                  onClick={() => setPeekTrack(track)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") setPeekTrack(track);
                  }}
                >
                  <div className="flex gap-3">
                    <input
                      type="checkbox"
                      checked={selectedTrackIds.includes(track.id)}
                      onClick={(event) => event.stopPropagation()}
                      onChange={() => toggleTrackSelection(track.id)}
                      aria-label={`Seleccionar ${track.title}`}
                      className="mt-1 shrink-0"
                    />
                    <div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-accent-primary/10 text-accent-primary">
                      {track.cover_url ? (
                        <img src={track.cover_url} alt="" className="size-full object-cover" />
                      ) : (
                        <Music2 className="size-5" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex justify-between gap-2">
                        <h3 className="truncate text-13 font-medium">{track.title}</h3>
                        {statusPill(track.status)}
                      </div>
                      <p className="mt-0.5 truncate text-11 text-tertiary">{artistNames(track) || "Sin artista"}</p>
                      <p className="font-mono mt-1.5 text-10 text-tertiary">
                        {track.isrc || "—"} · {musicDate(track.release_date)}
                      </p>
                    </div>
                  </div>
                  <div className="mt-2.5 flex flex-wrap gap-1.5">
                    {track.release_details.slice(0, 2).map((release) => (
                      <button
                        type="button"
                        key={release.id}
                        onClick={(event) => {
                          event.stopPropagation();
                          setEditingRelease(releases.find((item) => item.id === release.id));
                          setReleaseOpen(true);
                        }}
                      >
                        {badge(release.title)}
                      </button>
                    ))}
                    {track.video_details.length > 0 &&
                      badge(`${track.video_details.length} video${track.video_details.length === 1 ? "" : "s"}`, true)}
                  </div>
                </article>
              ))}
            </div>
            {totalTracks > 0 && (
              <MusicTableActionBar
                selectedCount={selectedTrackCount}
                totalMatching={totalTracks}
                isSelectingAll={isSelectingAllMatching}
                onSelectAllMatching={() => void selectAllMatching()}
                page={page}
                totalPages={totalPages}
                isBusy={isBulkDeleting}
                onClear={() => setSelectedTrackIds([])}
                onDownload={() => void downloadSelectedTracks()}
                onDelete={() => setIsBulkDeleteOpen(true)}
                onPrevious={() => setPage((current) => current - 1)}
                onNext={() => setPage((current) => current + 1)}
                onGoTo={(nextPage) => setPage(nextPage)}
                selectionActions={
                  <>
                    {/* The selected songs on this page (at most 10) go to the assistant as mentions. */}
                    <AskAssistantButton
                      className={cn(actionButton, "border-0 text-secondary")}
                      mentions={tracks
                        .filter((track) => selectedTrackIds.includes(track.id))
                        .slice(0, 10)
                        .map((track) => ({ type: "music_track" as const, id: track.id, label: track.title }))}
                    />
                    {referencesEnabled && (
                      <BulkTagMenu
                        workspaceSlug={workspaceSlug}
                        entityName="music_track"
                        ids={selectedTrackIds}
                        itemsLabel={t("references.bulk.items.music_track")}
                        disabled={isBulkDeleting}
                        triggerClassName={cn(actionButton, "text-secondary hover:bg-layer-1-hover")}
                        labelClassName={actionLabel}
                      />
                    )}
                  </>
                }
              />
            )}
          </>
        )}
      </div>

      {(peekTrack || peekCreateOpen) && (
        <MusicTrackPeekPanel
          workspaceSlug={workspaceSlug}
          track={peekTrack}
          options={options}
          parties={parties}
          genres={genres}
          companies={companies}
          releases={releases}
          suspendClose={releaseOpen || resourcesOpen || importAssetsOpen}
          onClose={() => {
            setPeekTrack(undefined);
            setPeekCreateOpen(false);
          }}
          onSaved={() => void mutateTracks()}
          onCreated={(created) => {
            setPeekCreateOpen(false);
            setPeekTrack(created);
          }}
          onResourcesChanged={refreshResources}
        />
      )}

      <MusicReleaseModal
        workspaceSlug={workspaceSlug}
        isOpen={releaseOpen}
        release={editingRelease}
        parties={parties}
        options={options}
        onClose={() => setReleaseOpen(false)}
        onSaved={refreshAll}
        onResourcesChanged={refreshResources}
      />
      <MusicEntityManager
        workspaceSlug={workspaceSlug}
        isOpen={resourcesOpen}
        options={options}
        parties={parties}
        companies={companies}
        genres={genres}
        releases={releases}
        onClose={() => setResourcesOpen(false)}
        onChanged={refreshAll}
      />
      <MusicImportAssetsPanel
        workspaceSlug={workspaceSlug}
        isOpen={importAssetsOpen}
        onClose={() => setImportAssetsOpen(false)}
        onViewRun={(runId) => {
          setImportAssetsOpen(false);
          setFilters({ songs_only: "true", import_run: runId });
          setPage(1);
        }}
        onViewFile={(assetId) => {
          setImportAssetsOpen(false);
          setFilters({ songs_only: "true", import_file: assetId });
          setPage(1);
        }}
      />
      <AlertModalCore
        isOpen={Boolean(deletingTrack)}
        isSubmitting={isDeletingTrack}
        handleClose={() => setDeletingTrack(undefined)}
        handleSubmit={() => void removeTrack()}
        title={`Delete ${deletingTrack?.title ?? "song"}?`}
        content={
          deletingTrack
            ? `This also removes ${deletingTrack.credits.length} credit relationships, ${deletingTrack.video_details.length} music videos and ${deletingTrack.release_details.length} release associations. Uploaded files remain in Files. This action cannot be undone.`
            : "This action cannot be undone."
        }
      />
      <AlertModalCore
        isOpen={isBulkDeleteOpen}
        isSubmitting={isBulkDeleting}
        handleClose={() => setIsBulkDeleteOpen(false)}
        handleSubmit={() => void removeSelectedTracks()}
        title={`Delete ${selectedTrackCount} selected song${selectedTrackCount === 1 ? "" : "s"}?`}
        content="This permanently removes each selected song, its videos and catalog relationships. Uploaded audio and cover files remain in Files. This action cannot be undone."
      />
    </div>
  );
}
