import { useDeferredValue, useEffect, useState } from "react";
import {
  CalendarClock,
  Disc3,
  Download,
  FileSpreadsheet,
  FileUp,
  Link as LinkIcon,
  Music2,
  Plus,
  Search,
  SlidersHorizontal,
  Trash2,
  Users,
  Video,
} from "lucide-react";
import useSWR from "swr";
import { Button } from "@plane/propel/button";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TMusicFilters, TMusicRelease, TMusicTrack } from "@plane/types";
import { AlertModalCore } from "@plane/ui";
import { musicService } from "@/services/music.service";
import { MusicEntityManager } from "./entity-manager";
import { MusicImportModal } from "./import-modal";
import { MusicReleaseModal } from "./release-modal";
import { getApiError, musicDate, MUSIC_FIELD } from "./shared";
import { MusicTableActionBar } from "./table-action-bar";
import { MusicTrackPeekPanel } from "./track-peek-panel";

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

export function MusicCatalogRoot({ workspaceSlug }: Props) {
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [filters, setFilters] = useState<TMusicFilters>({ songs_only: "true" });
  const [page, setPage] = useState(1);
  const [showFilters, setShowFilters] = useState(false);
  const [editingRelease, setEditingRelease] = useState<TMusicRelease>();
  const [peekTrack, setPeekTrack] = useState<TMusicTrack>();
  const [peekCreateOpen, setPeekCreateOpen] = useState(false);
  const [releaseOpen, setReleaseOpen] = useState(false);
  const [resourcesOpen, setResourcesOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [deletingTrack, setDeletingTrack] = useState<TMusicTrack>();
  const [isDeletingTrack, setIsDeletingTrack] = useState(false);
  const [selectedTrackIds, setSelectedTrackIds] = useState<string[]>([]);
  const [isBulkDeleteOpen, setIsBulkDeleteOpen] = useState(false);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);

  const exportQuery = { ...filters, search: deferredSearch || undefined };
  const query = { ...exportQuery, page: String(page), page_size: String(PAGE_SIZE) };
  const { data: options } = useSWR(`MUSIC_OPTIONS_${workspaceSlug}`, () => musicService.getOptions(workspaceSlug));
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
  const setFilter = (key: keyof TMusicFilters, value: string) => {
    setPage(1);
    setSelectedTrackIds([]);
    setFilters((current) => ({ ...current, [key]: value || undefined, songs_only: "true" }));
  };
  const activeFilterCount = Object.entries(filters).filter(
    ([key, value]) => key !== "songs_only" && Boolean(value)
  ).length;

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
          <button
            type="button"
            onClick={() => setShowFilters((current) => !current)}
            className={`flex items-center gap-1 rounded-sm border px-2 py-1.5 text-12 hover:bg-layer-1-hover ${activeFilterCount ? "border-accent-strong text-accent-primary" : "border-subtle"}`}
          >
            <SlidersHorizontal className="size-3.5" />
            <span className="hidden sm:inline">Filtros</span>
            {activeFilterCount > 0 && (
              <span className="rounded-full bg-accent-primary px-1 text-10 text-on-color">{activeFilterCount}</span>
            )}
          </button>
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
          {activeFilterCount > 0 && (
            <button
              type="button"
              className="px-1.5 py-1 text-11 text-accent-primary hover:underline"
              onClick={() => {
                setPage(1);
                setSelectedTrackIds([]);
                setFilters({ songs_only: "true" });
              }}
            >
              Limpiar
            </button>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button variant="secondary" size="sm" onClick={() => setResourcesOpen(true)}>
            <Users className="size-3.5" />
            <span className="hidden lg:inline">Recursos</span>
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setImportOpen(true)}>
            <FileUp className="size-3.5" />
            <span className="hidden lg:inline">Importar</span>
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

      <div className="shrink-0 px-3 sm:px-4">
        {showFilters && (
          <div className="mt-2 grid gap-3 rounded-md border border-subtle bg-layer-1 p-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6">
            <select
              className={MUSIC_FIELD}
              value={filters.artist ?? ""}
              onChange={(event) => setFilter("artist", event.target.value)}
            >
              <option value="">All artists</option>
              {parties
                .filter((party) => party.kind === "ARTIST" || party.kind === "GROUP")
                .map((party) => (
                  <option key={party.id} value={party.id}>
                    {party.display_name}
                  </option>
                ))}
            </select>
            <select
              className={MUSIC_FIELD}
              value={filters.release ?? ""}
              onChange={(event) => setFilter("release", event.target.value)}
            >
              <option value="">All releases</option>
              {releases.map((release) => (
                <option key={release.id} value={release.id}>
                  {release.title}
                </option>
              ))}
            </select>
            <select
              className={MUSIC_FIELD}
              value={filters.genre ?? ""}
              onChange={(event) => setFilter("genre", event.target.value)}
            >
              <option value="">All genres</option>
              {genres.map((genre) => (
                <option key={genre.id} value={genre.id}>
                  {genre.name}
                </option>
              ))}
            </select>
            <select
              className={MUSIC_FIELD}
              value={filters.company ?? ""}
              onChange={(event) => setFilter("company", event.target.value)}
            >
              <option value="">All companies</option>
              {companies.map((company) => (
                <option key={company.id} value={company.id}>
                  {company.name}
                </option>
              ))}
            </select>
            <input
              type="number"
              min="1900"
              max="2100"
              className={MUSIC_FIELD}
              placeholder="Release year"
              value={filters.year ?? ""}
              onChange={(event) => setFilter("year", event.target.value)}
            />
            <select
              className={MUSIC_FIELD}
              value={filters.status ?? ""}
              onChange={(event) => setFilter("status", event.target.value)}
            >
              <option value="">All statuses</option>
              {options?.track_statuses.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <label className="text-10 text-tertiary">
              Song from
              <input
                type="date"
                className={`${MUSIC_FIELD} mt-1`}
                value={filters.from ?? ""}
                onChange={(event) => setFilter("from", event.target.value)}
              />
            </label>
            <label className="text-10 text-tertiary">
              Song to
              <input
                type="date"
                className={`${MUSIC_FIELD} mt-1`}
                value={filters.to ?? ""}
                onChange={(event) => setFilter("to", event.target.value)}
              />
            </label>
            <label className="text-10 text-tertiary">
              Video from
              <input
                type="date"
                className={`${MUSIC_FIELD} mt-1`}
                value={filters.video_from ?? ""}
                onChange={(event) => setFilter("video_from", event.target.value)}
              />
            </label>
            <label className="text-10 text-tertiary">
              Video to
              <input
                type="date"
                className={`${MUSIC_FIELD} mt-1`}
                value={filters.video_to ?? ""}
                onChange={(event) => setFilter("video_to", event.target.value)}
              />
            </label>
            <label className="flex items-center gap-2 self-end rounded-md border border-subtle px-3 py-2 text-11">
              <input
                type="checkbox"
                checked={filters.has_video === "true"}
                onChange={(event) => setFilter("has_video", event.target.checked ? "true" : "")}
              />{" "}
              Has music video
            </label>
            <label className="flex items-center gap-2 self-end rounded-md border border-subtle px-3 py-2 text-11">
              <input
                type="checkbox"
                checked={filters.has_links === "true"}
                onChange={(event) => setFilter("has_links", event.target.checked ? "true" : "")}
              />{" "}
              Has links
            </label>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3 sm:p-4">
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
          <div className="flex min-h-72 flex-col items-center justify-center rounded-md border border-dashed border-subtle bg-layer-1 p-8 text-center">
            <div className="mb-4 flex size-14 items-center justify-center rounded-full bg-accent-primary/10 text-accent-primary">
              <Disc3 className="size-7" />
            </div>
            <h2 className="text-16 font-semibold">Construye tu catálogo musical</h2>
            <p className="mt-2 max-w-md text-12 text-secondary">
              Crea la primera canción o importa un CSV/XLSX. Los artistas, releases, géneros y compañías se pueden crear
              durante cualquiera de los dos flujos.
            </p>
            <div className="mt-5 flex gap-2">
              <Button variant="secondary" size="sm" onClick={() => setImportOpen(true)}>
                <FileUp className="size-3.5" /> Importar archivo
              </Button>
              <Button variant="primary" size="sm" onClick={() => setPeekCreateOpen(true)}>
                <Plus className="size-3.5" /> Nueva canción
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="hidden overflow-hidden rounded-md border border-subtle bg-layer-1 md:block">
              <table className="w-full text-left">
                <thead className="sticky top-0 z-10 bg-layer-2 text-11 font-medium text-tertiary">
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
                page={page}
                totalPages={totalPages}
                isBusy={isBulkDeleting}
                onClear={() => setSelectedTrackIds([])}
                onDownload={() => void downloadSelectedTracks()}
                onDelete={() => setIsBulkDeleteOpen(true)}
                onPrevious={() => setPage((current) => current - 1)}
                onNext={() => setPage((current) => current + 1)}
                onGoTo={(nextPage) => setPage(nextPage)}
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
          suspendClose={releaseOpen || resourcesOpen || importOpen}
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
      <MusicImportModal
        workspaceSlug={workspaceSlug}
        isOpen={importOpen}
        options={options}
        parties={parties}
        companies={companies}
        genres={genres}
        releases={releases}
        onClose={() => setImportOpen(false)}
        onImported={refreshAll}
        onResourcesChanged={refreshResources}
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
