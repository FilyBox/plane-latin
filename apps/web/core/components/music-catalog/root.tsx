import { useDeferredValue, useEffect, useState } from "react";
import {
  CalendarClock,
  Disc3,
  Download,
  FileSpreadsheet,
  FileUp,
  Music2,
  Pencil,
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
import { MusicTrackModal } from "./track-modal";

type Props = { workspaceSlug: string };
const PAGE_SIZE = 25;

const badge = (value: string, green = false) => (
  <span
    className={`inline-flex rounded-full px-2 py-0.5 text-10 font-medium ${green ? "bg-emerald-100 text-emerald-800" : "border border-subtle bg-layer-2 text-secondary"}`}
  >
    {value.replaceAll("_", " ")}
  </span>
);

const artistNames = (track: TMusicTrack) =>
  track.credits
    .filter((credit) => credit.role === "PRIMARY_ARTIST" || credit.role === "FEATURED_ARTIST")
    .map((credit) => credit.party.display_name)
    .join(", ");

export function MusicCatalogRoot({ workspaceSlug }: Props) {
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [filters, setFilters] = useState<TMusicFilters>({ songs_only: "true" });
  const [page, setPage] = useState(1);
  const [showFilters, setShowFilters] = useState(false);
  const [editingTrack, setEditingTrack] = useState<TMusicTrack>();
  const [editingRelease, setEditingRelease] = useState<TMusicRelease>();
  const [trackOpen, setTrackOpen] = useState(false);
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

  const openSong = (track?: TMusicTrack) => {
    setEditingTrack(track);
    setTrackOpen(true);
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-surface-1">
      <div className="shrink-0 border-b border-subtle bg-gradient-to-br from-[#edf7f2] via-surface-1 to-[#eaf1f8] px-4 py-4 sm:px-6">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex items-center gap-3">
            <div className="shadow-sm flex size-10 items-center justify-center rounded-xl bg-[#173a31] text-white">
              <Music2 className="size-5" />
            </div>
            <div>
              <h1 className="text-18 font-semibold">Music catalog</h1>
              <p className="mt-0.5 text-12 text-secondary">
                Songs, releases, videos, credits and rights in one workspace view.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={() => setResourcesOpen(true)}>
              <Users className="mr-1.5 size-4" /> Resources
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setImportOpen(true)}>
              <FileUp className="mr-1.5 size-4" /> Import
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void download("filtered", "csv")}>
              <FileSpreadsheet className="mr-1.5 size-4" /> CSV
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void download("filtered", "xlsx")}>
              <Download className="mr-1.5 size-4" /> XLSX
            </Button>
            <Button variant="primary" size="sm" onClick={() => openSong()}>
              <Plus className="mr-1.5 size-4" /> New song
            </Button>
          </div>
        </div>

        <div className="mt-5 grid gap-3 md:grid-cols-[minmax(0,1fr)_auto]">
          <div className="relative">
            <Search className="absolute top-2.5 left-3 size-4 text-tertiary" />
            <input
              className={`${MUSIC_FIELD} bg-layer-1 pl-9`}
              value={search}
              onChange={(event) => {
                setPage(1);
                setSelectedTrackIds([]);
                setSearch(event.target.value);
              }}
              placeholder="Search songs, artists, releases, audio or video ISRC..."
            />
          </div>
          <Button variant="secondary" size="sm" onClick={() => setShowFilters((current) => !current)}>
            <SlidersHorizontal className="mr-1.5 size-4" /> Filters{activeFilterCount ? ` (${activeFilterCount})` : ""}
          </Button>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="hover:border-accent-primary rounded-full border border-subtle bg-layer-1 px-3 py-1.5 text-11"
            onClick={() => {
              setPage(1);
              setSelectedTrackIds([]);
              setFilters({ songs_only: "true", has_video: "true" });
            }}
          >
            <Video className="mr-1 inline size-3.5" /> With video
          </button>
          <button
            type="button"
            className="hover:border-accent-primary rounded-full border border-subtle bg-layer-1 px-3 py-1.5 text-11"
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
            Last 30 days
          </button>
          <button
            type="button"
            className="hover:border-accent-primary rounded-full border border-subtle bg-layer-1 px-3 py-1.5 text-11"
            onClick={() => {
              setPage(1);
              setSelectedTrackIds([]);
              setFilters({ songs_only: "true", from: new Date().toISOString().slice(0, 10) });
            }}
          >
            <CalendarClock className="mr-1 inline size-3.5" /> Upcoming
          </button>
          {activeFilterCount > 0 && (
            <button
              type="button"
              className="px-2 py-1 text-11 text-accent-primary"
              onClick={() => {
                setPage(1);
                setSelectedTrackIds([]);
                setFilters({ songs_only: "true" });
              }}
            >
              Clear filters
            </button>
          )}
        </div>

        {showFilters && (
          <div className="mt-3 grid gap-3 rounded-xl border border-subtle bg-layer-1 p-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6">
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
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4 sm:p-6">
        <div className="mb-3 flex items-center justify-between text-11 text-secondary">
          <span>
            {isLoading
              ? "Loading catalog..."
              : totalTracks === 0
                ? "No songs"
                : `Showing ${firstTrack}-${lastTrack} of ${totalTracks} songs`}
          </span>
          <span>Click a row to open the complete record</span>
        </div>
        {!tracks.length && !isLoading ? (
          <div className="flex min-h-72 flex-col items-center justify-center rounded-2xl border border-dashed border-subtle bg-layer-1 p-8 text-center">
            <div className="mb-4 flex size-14 items-center justify-center rounded-full bg-[#173a31]/10 text-[#173a31]">
              <Disc3 className="size-7" />
            </div>
            <h2 className="text-16 font-semibold">Build your music history</h2>
            <p className="mt-2 max-w-md text-12 text-secondary">
              Create the first song or import a CSV/XLSX. Artists, releases, genres and companies can be created during
              either flow.
            </p>
            <div className="mt-5 flex gap-2">
              <Button variant="secondary" size="sm" onClick={() => setImportOpen(true)}>
                Import spreadsheet
              </Button>
              <Button variant="primary" size="sm" onClick={() => openSong()}>
                <Plus className="mr-1 size-4" /> New song
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="hidden overflow-hidden rounded-xl border border-subtle bg-layer-1 md:block">
              <table className="w-full text-left">
                <thead className="sticky top-0 z-10 bg-layer-2 text-10 font-semibold text-tertiary uppercase">
                  <tr>
                    <th className="w-12 px-4 py-3">
                      <input
                        type="checkbox"
                        checked={isCurrentPageSelected}
                        onChange={toggleCurrentPageSelection}
                        aria-label="Select all songs on this page"
                      />
                    </th>
                    <th className="px-4 py-3">Song</th>
                    <th className="px-4 py-3">Release</th>
                    <th className="px-4 py-3">Identifiers</th>
                    <th className="px-4 py-3">Video</th>
                    <th className="px-4 py-3">Rights</th>
                    <th className="w-24 px-4 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {tracks.map((track) => (
                    <tr
                      key={track.id}
                      className="cursor-pointer border-t border-subtle hover:bg-layer-2/60"
                      onClick={() => openSong(track)}
                    >
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={selectedTrackIds.includes(track.id)}
                          onClick={(event) => event.stopPropagation()}
                          onChange={() => toggleTrackSelection(track.id)}
                          aria-label={`Select ${track.title}`}
                        />
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-[#173a31]/10">
                            {track.cover_url ? (
                              <img src={track.cover_url} alt="" className="size-full object-cover" />
                            ) : (
                              <Music2 className="size-4 text-[#173a31]" />
                            )}
                          </div>
                          <div className="min-w-0">
                            <p className="truncate text-13 font-semibold">{track.title}</p>
                            <p className="mt-0.5 truncate text-11 text-secondary">
                              {artistNames(track) || "No artist"}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-11">
                        <p className="max-w-44 truncate">
                          {track.release_details.map((release) => release.title).join(", ") || "Independent"}
                        </p>
                        <p className="mt-1 text-tertiary">{musicDate(track.release_date)}</p>
                      </td>
                      <td className="px-4 py-3">
                        <code className="text-11">{track.isrc || "No ISRC"}</code>
                        <div className="mt-1">{badge(track.status, track.status === "RELEASED")}</div>
                      </td>
                      <td className="px-4 py-3 text-11">
                        {track.video_details.length ? (
                          <>
                            <span className="text-emerald-700 flex items-center gap-1">
                              <Video className="size-3.5" /> {track.video_details.length} video
                              {track.video_details.length === 1 ? "" : "s"}
                            </span>
                            <p className="mt-1 max-w-36 truncate text-tertiary">
                              {track.video_details
                                .map((video) => video.isrc)
                                .filter(Boolean)
                                .join(", ")}
                            </p>
                          </>
                        ) : (
                          <span className="text-tertiary">No video</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-11">
                        <p>{track.credits.filter((credit) => credit.percentage !== null).length} rights splits</p>
                        <p className="mt-1 text-tertiary">
                          {track.distributions.filter((entry) => entry.percentage !== null).length} commercial splits
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex">
                          <button
                            type="button"
                            className="rounded p-2 hover:bg-layer-2"
                            onClick={(event) => {
                              event.stopPropagation();
                              openSong(track);
                            }}
                          >
                            <Pencil className="size-4" />
                          </button>
                          <button
                            type="button"
                            className="hover:bg-red-50 hover:text-red-600 rounded p-2 text-secondary"
                            onClick={(event) => {
                              event.stopPropagation();
                              setDeletingTrack(track);
                            }}
                          >
                            <Trash2 className="size-4" />
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
                  className="rounded-xl border border-subtle bg-layer-1 p-4"
                  role="button"
                  tabIndex={0}
                  onClick={() => openSong(track)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") openSong(track);
                  }}
                >
                  <div className="flex gap-3">
                    <input
                      type="checkbox"
                      checked={selectedTrackIds.includes(track.id)}
                      onClick={(event) => event.stopPropagation()}
                      onChange={() => toggleTrackSelection(track.id)}
                      aria-label={`Select ${track.title}`}
                      className="mt-1 shrink-0"
                    />
                    <div className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[#173a31]/10">
                      {track.cover_url ? (
                        <img src={track.cover_url} alt="" className="size-full object-cover" />
                      ) : (
                        <Music2 className="size-5 text-[#173a31]" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex justify-between gap-2">
                        <h3 className="truncate text-14 font-semibold">{track.title}</h3>
                        {badge(track.status, track.status === "RELEASED")}
                      </div>
                      <p className="mt-1 truncate text-11 text-secondary">{artistNames(track) || "No artist"}</p>
                      <p className="mt-2 text-10 text-tertiary">
                        {track.isrc || "No ISRC"} · {musicDate(track.release_date)}
                      </p>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
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
                    {track.video_details.length > 0 && badge(`${track.video_details.length} VIDEO`, true)}
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
              />
            )}
          </>
        )}
      </div>

      <MusicTrackModal
        workspaceSlug={workspaceSlug}
        isOpen={trackOpen}
        track={editingTrack}
        releases={releases}
        parties={parties}
        genres={genres}
        companies={companies}
        options={options}
        onClose={() => setTrackOpen(false)}
        onSaved={refreshAll}
        onResourcesChanged={refreshResources}
      />
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
