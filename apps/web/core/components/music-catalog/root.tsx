import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  ArrowUpDown,
  CalendarClock,
  CalendarRange,
  Check,
  ChevronDown,
  Disc3,
  Download,
  FileSignature,
  FileText,
  FileUp,
  FileX,
  FolderArchive,
  Link as LinkIcon,
  Loader2,
  MoreHorizontal,
  Plus,
  Search,
  SearchX,
  Sparkles,
  Trash2,
  Users,
  Video,
  Zap,
} from "lucide-react";
import { AnimatePresence } from "framer-motion";
import { useNavigate, useSearchParams } from "react-router";
import useSWR from "swr";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TMusicFilters, TMusicRelease, TMusicTrack } from "@plane/types";
import { AlertModalCore, CustomMenu } from "@plane/ui";
import { cn } from "@plane/utils";
import { useAskAssistant } from "@/components/assistant/ask";
import { setAssistantSelection } from "@/components/assistant/page-context";
import { useAssistantAvailable } from "@/components/assistant/panel";
import { ContractBulkActionsBar } from "@/components/file-library/contracts/list-controls";
import { BulkTagMenu } from "@/components/references/bulk-tag-menu";
import { useIntersectionObserver } from "@/hooks/use-intersection-observer";
import { useWorkspace } from "@/hooks/store/use-workspace";
import { musicService } from "@/services/music.service";
import { MusicBulkEditAction } from "./bulk-edit-modal";
import { MusicBulkLinkContractAction } from "./bulk-link-contract";
import { MusicEntityManager } from "./entity-manager";
import { MusicExportModal, type TMusicExportScope } from "./export-modal";
import { MusicAppliedFilters, MusicFiltersDropdown, type TMusicFiltersData } from "./filters";
import { MusicImportAssetsPanel } from "./import-assets-panel";
import { formatDate } from "./import/constants";
import { MusicReleaseModal } from "./release-modal";
import { getApiError } from "./shared";
import { MusicTrackPeekPanel } from "./track-peek-panel";
import { DEFAULT_TRACK_ORDER, MusicTrackTable } from "./track-table";

type Props = { workspaceSlug: string };
const PAGE_SIZE = 25;

/** Toolbar control, same as the contracts list */
const TOOLBAR_BUTTON =
  "flex h-8 shrink-0 items-center gap-1 rounded-sm border border-subtle px-2 text-12 whitespace-nowrap text-secondary hover:bg-layer-1-hover disabled:opacity-50";
/** Button in the selection strip, same as the contracts list's menu triggers there */
const BAR_BUTTON =
  "flex h-7 shrink-0 items-center gap-1 rounded-sm border border-subtle bg-surface-1 px-2 text-12 font-medium whitespace-nowrap text-secondary hover:bg-layer-1-hover disabled:pointer-events-none disabled:opacity-50";
const BAR_LABEL = "hidden sm:inline";

const ORDER_OPTIONS: { value: string; i18nKey: string }[] = [
  { value: "-release_date", i18nKey: "music_catalog.order.release_newest" },
  { value: "release_date", i18nKey: "music_catalog.order.release_oldest" },
  { value: "-created_at", i18nKey: "music_catalog.order.added" },
  { value: "-updated_at", i18nKey: "music_catalog.order.modified" },
  { value: "title", i18nKey: "music_catalog.order.title_asc" },
  { value: "-title", i18nKey: "music_catalog.order.title_desc" },
  { value: "-contract_count", i18nKey: "music_catalog.order.contracts" },
];

const orderStorageKey = (workspaceSlug: string) => `music-order:${workspaceSlug}`;
const readStoredOrder = (workspaceSlug: string): string => {
  try {
    return localStorage.getItem(orderStorageKey(workspaceSlug)) ?? DEFAULT_TRACK_ORDER;
  } catch {
    return DEFAULT_TRACK_ORDER;
  }
};

const isoDay = (offsetDays = 0) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

/** "Vista rápida": the old one-click chips, folded into one menu. Each one
 * sets (or, when on, removes) a few filters; the rest stay as they are. */
type TQuickView = {
  id: string;
  i18nKey: string;
  icon: LucideIcon;
  group: "content" | "dates" | "contracts";
  isActive: (filters: TMusicFilters) => boolean;
  patch: () => Partial<TMusicFilters>;
  clear: Partial<TMusicFilters>;
};

const QUICK_VIEWS: TQuickView[] = [
  {
    id: "has_video",
    i18nKey: "music_catalog.quick.has_video",
    icon: Video,
    group: "content",
    isActive: (filters) => filters.has_video === "true",
    patch: () => ({ has_video: "true" }),
    clear: { has_video: undefined },
  },
  {
    id: "has_links",
    i18nKey: "music_catalog.quick.has_links",
    icon: LinkIcon,
    group: "content",
    isActive: (filters) => filters.has_links === "true",
    patch: () => ({ has_links: "true" }),
    clear: { has_links: undefined },
  },
  {
    id: "has_lyrics",
    i18nKey: "music_catalog.quick.has_lyrics",
    icon: FileText,
    group: "content",
    isActive: (filters) => filters.has_lyrics === "true",
    patch: () => ({ has_lyrics: "true" }),
    clear: { has_lyrics: undefined },
  },
  {
    id: "last_30_days",
    i18nKey: "music_catalog.quick.last_30_days",
    icon: CalendarRange,
    group: "dates",
    isActive: (filters) => filters.from === isoDay(-30) && filters.to === isoDay(),
    patch: () => ({ from: isoDay(-30), to: isoDay() }),
    clear: { from: undefined, to: undefined },
  },
  {
    id: "upcoming",
    i18nKey: "music_catalog.quick.upcoming",
    icon: CalendarClock,
    group: "dates",
    isActive: (filters) => filters.from === isoDay() && !filters.to,
    patch: () => ({ from: isoDay(), to: undefined }),
    clear: { from: undefined, to: undefined },
  },
  {
    id: "with_contract",
    i18nKey: "music_catalog.quick.with_contract",
    icon: FileSignature,
    group: "contracts",
    isActive: (filters) => filters.contract === "with",
    patch: () => ({ contract: "with" }),
    clear: { contract: undefined },
  },
  {
    id: "without_contract",
    i18nKey: "music_catalog.quick.without_contract",
    icon: FileX,
    group: "contracts",
    isActive: (filters) => filters.contract === "without",
    patch: () => ({ contract: "without" }),
    clear: { contract: undefined },
  },
  {
    id: "expired_contract",
    i18nKey: "music_catalog.quick.expired_contract",
    icon: CalendarClock,
    group: "contracts",
    isActive: (filters) => filters.contract === "expired",
    patch: () => ({ contract: "expired" }),
    clear: { contract: undefined },
  },
];
const QUICK_GROUPS = ["content", "dates", "contracts"] as const;

type TTrackPage = { results: TMusicTrack[]; total: number };

// One-shot filters. The open song (?track=) and release (?release=) stay in
// the URL instead, so the page can be shared with that panel open.
const DEEP_LINK_KEYS = ["import_run", "import_file", "import_files", "artist", "contract"];

export function MusicCatalogRoot({ workspaceSlug }: Props) {
  const { t, currentLocale } = useTranslation();
  const navigate = useNavigate();
  // Selected songs can be tagged with the workspace's shared tags.
  const { isWorkspaceFeatureEnabled } = useWorkspace();
  const referencesEnabled = isWorkspaceFeatureEnabled(workspaceSlug, "references");
  // Selected songs can be linked to a contract (contracts live in the file library).
  const fileLibraryEnabled = isWorkspaceFeatureEnabled(workspaceSlug, "file_library");
  const assistantAvailable = useAssistantAvailable(workspaceSlug);
  const askAssistant = useAskAssistant();
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
    // ?contract=with|without|expired: songs by contract coverage
    ...(searchParams.get("contract") ? { contract: searchParams.get("contract")! } : {}),
  }));
  const [order, setOrderState] = useState(() => readStoredOrder(workspaceSlug));
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
  // The open song and release live in the URL (?track=<id>, ?release=<id>):
  // a shared link, a mention or Back/Forward opens or closes them.
  const trackParam = searchParams.get("track");
  const releaseParam = searchParams.get("release");
  const setPanelParam = (key: "track" | "release", id: string | null) =>
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (id) next.set(key, id);
        else next.delete(key);
        return next;
      },
      { replace: !id }
    );
  const openTrack = (track: TMusicTrack) => {
    setPeekTrack(track);
    setPanelParam("track", track.id);
  };
  const openRelease = (release: TMusicRelease | undefined) => {
    setEditingRelease(release);
    setReleaseOpen(true);
    if (release) setPanelParam("release", release.id);
  };
  useEffect(() => {
    if (!trackParam) {
      setPeekTrack((current) => (current ? undefined : current));
      return;
    }
    if (peekTrack?.id === trackParam) return;
    let cancelled = false;
    void musicService
      .getTracks(workspaceSlug, { ids: trackParam })
      .then((response) => {
        const found = (Array.isArray(response) ? response : response.results)[0];
        if (found && !cancelled) setPeekTrack(found);
        return undefined;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // Follows the URL only; the panel's own copy updates peekTrack.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackParam, workspaceSlug]);
  const [selectedTrackIds, setSelectedTrackIds] = useState<string[]>([]);
  // The assistant knows which songs are selected ("estas canciones").
  useEffect(() => {
    setAssistantSelection({ entity_name: "music_track", ids: selectedTrackIds });
  }, [selectedTrackIds]);
  useEffect(() => () => setAssistantSelection(null), []);
  const [isBulkDeleteOpen, setIsBulkDeleteOpen] = useState(false);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);
  const [isSelectingAllMatching, setIsSelectingAllMatching] = useState(false);

  const exportQuery = useMemo(() => ({ ...filters, search: deferredSearch || undefined }), [filters, deferredSearch]);
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

  // ── Paginated list: pages of 25 that grow with "Cargar más" (as in contracts) ──
  const listQuery = useMemo(() => ({ ...exportQuery, order_by: order }), [exportQuery, order]);
  const baseKey = JSON.stringify(listQuery);
  const [pageState, setPageState] = useState<{ base: string; count: number }>({ base: "", count: 1 });
  const pageCount = pageState.base === baseKey ? pageState.count : 1;
  const pagesRef = useRef<{ base: string; pages: TTrackPage[] } | null>(null);
  const {
    data: pages,
    isLoading,
    mutate: mutateTracks,
  } = useSWR<TTrackPage[]>(
    ["MUSIC_TRACKS", workspaceSlug, baseKey, pageCount],
    async () => {
      const fetchPage = async (page: number): Promise<TTrackPage> => {
        const response = await musicService.getTracks(workspaceSlug, {
          ...listQuery,
          page: String(page),
          page_size: String(PAGE_SIZE),
        });
        return Array.isArray(response)
          ? { results: response, total: response.length }
          : { results: response.results, total: response.total };
      };
      const previous = pagesRef.current?.base === baseKey ? pagesRef.current.pages : [];
      let loaded: TTrackPage[];
      // Growing by one page: fetch just that page
      if (previous.length === pageCount - 1 && previous.length > 0) {
        loaded = [...previous, await fetchPage(pageCount)];
      } else {
        // Fresh load or revalidation: re-read every page shown
        loaded = [];
        for (let page = 1; page <= pageCount; page += 1) {
          // Pages are read in order so a short one ends the list
          // eslint-disable-next-line no-await-in-loop
          const next = await fetchPage(page);
          loaded.push(next);
          if (page * PAGE_SIZE >= next.total) break;
        }
      }
      pagesRef.current = { base: baseKey, pages: loaded };
      return loaded;
    },
    { keepPreviousData: true }
  );
  const tracks = useMemo(() => {
    const seen = new Set<string>();
    return (pages ?? []).flatMap((page) => page.results).filter((row) => !seen.has(row.id) && !!seen.add(row.id));
  }, [pages]);
  const totalTracks = pages?.[pages.length - 1]?.total ?? tracks.length;
  const hasMore = tracks.length < totalTracks;
  const loadMore = useCallback(() => {
    if (hasMore && pages?.length === pageCount) setPageState({ base: baseKey, count: pageCount + 1 });
  }, [baseKey, hasMore, pageCount, pages?.length]);
  // Auto-load near the end of the list
  const [sentinel, setSentinel] = useState<HTMLDivElement | null>(null);
  const viewportRoot = useRef<HTMLDivElement | null>(null);
  useIntersectionObserver(viewportRoot, sentinel, loadMore, "200px");

  useEffect(() => {
    if (!releaseParam) {
      if (releaseOpen && editingRelease) setReleaseOpen(false);
      return;
    }
    if (releaseOpen && editingRelease?.id === releaseParam) return;
    const found = releases.find((item) => item.id === releaseParam);
    if (found) {
      setEditingRelease(found);
      setReleaseOpen(true);
    }
    // Follows the URL, once the releases have loaded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [releaseParam, releases]);

  const selectedTrackCount = selectedTrackIds.length;

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
    setSelectedTrackIds([]);
    setFilters({ songs_only: "true" });
  };
  const patchFilters = (patch: Partial<TMusicFilters>) => {
    setSelectedTrackIds([]);
    setFilters((current) => ({ ...current, ...patch, songs_only: "true" }));
  };
  const setFilter = (key: keyof TMusicFilters, value: string) => patchFilters({ [key]: value || undefined });
  const setOrder = (next: string) => {
    setOrderState(next);
    try {
      localStorage.setItem(orderStorageKey(workspaceSlug), next);
    } catch {
      // storage blocked: the order just isn't remembered
    }
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
        label: `${file.name}${file.runs > 1 ? ` · ${file.runs} importaciones` : ""}${file.file_deleted ? " · archivo eliminado" : ""}`,
      })),
    }),
    [options, parties, genres, releases, companies]
  );

  // ── Selection ──────────────────────────────────────────────────────────
  const toggleTrackSelection = (trackId: string) =>
    setSelectedTrackIds((current) =>
      current.includes(trackId) ? current.filter((id) => id !== trackId) : [...current, trackId]
    );

  /** Header checkbox: every loaded song, or none of them */
  const toggleLoadedSelection = () =>
    setSelectedTrackIds((current) => {
      const loadedIds = tracks.map((track) => track.id);
      const allLoadedSelected = loadedIds.every((id) => current.includes(id));
      return allLoadedSelected
        ? current.filter((id) => !loadedIds.includes(id))
        : [...new Set([...current, ...loadedIds])];
    });

  const selectAllMatching = async () => {
    setIsSelectingAllMatching(true);
    try {
      const { ids } = await musicService.getTrackIds(workspaceSlug, exportQuery);
      setSelectedTrackIds(ids);
    } catch (error) {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: t("music_catalog.selection.select_all_failed"),
        message: getApiError(error),
      });
    } finally {
      setIsSelectingAllMatching(false);
    }
  };

  const removeSelectedTracks = async () => {
    if (!selectedTrackIds.length) return;
    setIsBulkDeleting(true);
    try {
      const { deleted, not_found } = await musicService.deleteTracks(workspaceSlug, selectedTrackIds);
      if (peekTrack && selectedTrackIds.includes(peekTrack.id)) {
        setPeekTrack(undefined);
        setPanelParam("track", null);
      }
      setSelectedTrackIds([]);
      setIsBulkDeleteOpen(false);
      await mutateTracks();
      setToast({
        type: TOAST_TYPE.SUCCESS,
        title: t("music_catalog.delete.done", { count: deleted }),
        message: not_found ? t("music_catalog.delete.already", { count: not_found }) : undefined,
      });
    } catch (error) {
      setToast({ type: TOAST_TYPE.ERROR, title: t("music_catalog.delete.failed"), message: getApiError(error) });
    } finally {
      setIsBulkDeleting(false);
    }
  };

  // The export panel: open with the filtered songs or the selected ones
  const [exportScope, setExportScope] = useState<TMusicExportScope | null>(null);

  // ── Toolbar pieces ─────────────────────────────────────────────────────
  const activeQuickViews = QUICK_VIEWS.filter((view) => view.isActive(filters));
  const toggleQuickView = (view: TQuickView) => patchFilters(view.isActive(filters) ? view.clear : view.patch());
  const quickViewItems = (withHeadings: boolean) =>
    QUICK_GROUPS.map((group, index) => (
      <div key={group} className={cn(index > 0 && "mt-1 border-t border-subtle pt-1")}>
        {withHeadings && (
          <p className="px-2 pt-1 pb-0.5 text-10 font-semibold text-tertiary uppercase">
            {t(`music_catalog.quick.groups.${group}`)}
          </p>
        )}
        {QUICK_VIEWS.filter((view) => view.group === group).map((view) => {
          const Icon = view.icon;
          const active = view.isActive(filters);
          return (
            <CustomMenu.MenuItem key={view.id} onClick={() => toggleQuickView(view)}>
              <span className="flex items-center gap-2">
                <Check className={cn("size-3.5", !active && "invisible")} />
                <Icon className="size-3.5 text-tertiary" />
                {t(view.i18nKey)}
              </span>
            </CustomMenu.MenuItem>
          );
        })}
      </div>
    ));

  const quickMenu = (
    <CustomMenu
      placement="bottom-start"
      customButton={
        <span
          className={cn(TOOLBAR_BUTTON, activeQuickViews.length > 0 && "border-accent-strong text-accent-primary")}
          aria-hidden
        >
          <Zap className="size-3.5" />
          {activeQuickViews.length === 1
            ? t(activeQuickViews[0].i18nKey)
            : activeQuickViews.length > 1
              ? t("music_catalog.quick.count", { count: activeQuickViews.length })
              : t("music_catalog.quick.label")}
          <ChevronDown className="size-3" />
        </span>
      }
      ariaLabel={t("music_catalog.quick.label")}
      closeOnSelect
      maxHeight="lg"
    >
      {quickViewItems(true)}
      {activeQuickViews.length > 0 && (
        <CustomMenu.MenuItem
          onClick={() => patchFilters(Object.assign({}, ...activeQuickViews.map((view) => view.clear)))}
        >
          <span className="flex items-center gap-2 pl-5.5">{t("music_catalog.quick.clear")}</span>
        </CustomMenu.MenuItem>
      )}
    </CustomMenu>
  );

  // The selected songs that are loaded (at most 10) go to the assistant as mentions
  const selectedMentions = tracks
    .filter((track) => selectedTrackIds.includes(track.id))
    .slice(0, 10)
    .map((track) => ({ type: "music_track" as const, id: track.id, label: track.title }));

  const emptyState = hasActiveFilters ? (
    // Filtered search with no matches — never the onboarding screen
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-tertiary">
      <SearchX className="size-8" />
      <p className="text-14 font-medium text-secondary">{t("music_catalog.list.filtered_title")}</p>
      <p className="max-w-sm text-12">{t("music_catalog.list.filtered_description")}</p>
      <Button variant="secondary" size="sm" onClick={clearFilters}>
        {t("music_catalog.list.clear_filters")}
      </Button>
    </div>
  ) : (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-tertiary">
      <Disc3 className="size-8" />
      <p className="text-14 font-medium text-secondary">{t("music_catalog.list.empty_title")}</p>
      <p className="max-w-md text-12">{t("music_catalog.list.empty_description")}</p>
      <div className="mt-1 flex gap-2">
        <Button variant="secondary" size="sm" onClick={openImport}>
          <FileUp className="size-3.5" />
          {t("music_catalog.list.empty_import")}
        </Button>
        <Button variant="primary" size="sm" onClick={() => setPeekCreateOpen(true)}>
          <Plus className="size-3.5" />
          {t("music_catalog.actions.new_song")}
        </Button>
      </div>
    </div>
  );

  const footer =
    tracks.length > 0 ? (
      <div className="flex flex-col items-center gap-1.5 px-4 py-4 text-11 text-tertiary">
        <span aria-live="polite">
          {t("file_library.contracts.list.showing", { shown: tracks.length, total: totalTracks })}
        </span>
        {hasMore && (
          <>
            <div ref={setSentinel} aria-hidden className="h-px w-full" />
            <Button variant="secondary" size="sm" onClick={loadMore} disabled={pages?.length !== pageCount}>
              {pages?.length !== pageCount ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {t("file_library.contracts.list.load_more")}
            </Button>
          </>
        )}
      </div>
    ) : null;

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden bg-surface-1">
      {/* toolbar: one row that never overflows; secondary actions fold into "…" */}
      <div className="flex shrink-0 items-center gap-2 border-b border-subtle px-3 py-2.5 sm:px-4">
        <div className="relative min-w-0 flex-1 sm:max-w-64">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-tertiary" />
          <label htmlFor="music-search" className="sr-only">
            {t("music_catalog.list.search")}
          </label>
          <input
            id="music-search"
            type="search"
            value={search}
            onChange={(event) => {
              setSelectedTrackIds([]);
              setSearch(event.target.value);
            }}
            placeholder={t("music_catalog.list.search")}
            className="h-8 w-full rounded-md border border-subtle bg-transparent pr-2 pl-8 text-12"
          />
        </div>
        <MusicFiltersDropdown filters={filters} data={filtersData} activeCount={activeFilterCount} onSet={setFilter} />
        <div className="hidden items-center gap-2 lg:flex">{quickMenu}</div>
        <label className="relative hidden items-center sm:flex">
          <ArrowUpDown className="pointer-events-none absolute left-2 size-3.5 text-tertiary" />
          <select
            aria-label={t("file_library.order.label")}
            value={order}
            onChange={(event) => setOrder(event.target.value)}
            className="h-8 max-w-60 rounded-sm border border-subtle bg-surface-1 pr-7 pl-7 text-12 text-secondary hover:bg-layer-1-hover"
          >
            {/* A column header may sort by something the menu doesn't list */}
            {!ORDER_OPTIONS.some((option) => option.value === order) && (
              <option value={order}>{t("music_catalog.order.by_column")}</option>
            )}
            {ORDER_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {t(option.i18nKey)}
              </option>
            ))}
          </select>
        </label>
        {/* Secondary actions: export, import files, resources, and (small screens) quick views + order */}
        <CustomMenu
          placement="bottom-end"
          customButton={
            <span className={TOOLBAR_BUTTON} aria-hidden>
              <MoreHorizontal className="size-3.5" />
            </span>
          }
          ariaLabel={t("file_library.contracts.list.more_actions")}
          closeOnSelect
          maxHeight="lg"
        >
          <CustomMenu.MenuItem onClick={() => setExportScope("filtered")}>
            <span className="flex items-center gap-2" title={t("music_export.button_title")}>
              <Download className="size-3.5" />
              {t("music_catalog.actions.export")}
            </span>
          </CustomMenu.MenuItem>
          <CustomMenu.MenuItem onClick={() => setImportAssetsOpen(true)}>
            <span className="flex items-center gap-2">
              <FolderArchive className="size-3.5" />
              {t("music_catalog.actions.import_files")}
            </span>
          </CustomMenu.MenuItem>
          <CustomMenu.MenuItem onClick={() => setResourcesOpen(true)}>
            <span className="flex items-center gap-2">
              <Users className="size-3.5" />
              {t("music_catalog.actions.resources")}
            </span>
          </CustomMenu.MenuItem>
          <div className="lg:hidden">
            <p className="mt-1 border-t border-subtle px-2 pt-2 pb-1 text-10 font-semibold text-tertiary uppercase">
              {t("music_catalog.quick.label")}
            </p>
            {quickViewItems(false)}
          </div>
          <div className="sm:hidden">
            <p className="mt-1 border-t border-subtle px-2 pt-2 pb-1 text-10 font-semibold text-tertiary uppercase">
              {t("file_library.order.label")}
            </p>
            {ORDER_OPTIONS.map((option) => (
              <CustomMenu.MenuItem key={option.value} onClick={() => setOrder(option.value)}>
                <span className="flex items-center gap-2">
                  <Check className={cn("size-3.5", order !== option.value && "invisible")} />
                  {t(option.i18nKey)}
                </span>
              </CustomMenu.MenuItem>
            ))}
          </div>
        </CustomMenu>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Button variant="secondary" size="sm" onClick={openImport} aria-label={t("music_catalog.actions.import")}>
            <FileUp className="size-3.5" />
            <span className="hidden md:inline">{t("music_catalog.actions.import")}</span>
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => setPeekCreateOpen(true)}
            aria-label={t("music_catalog.actions.new_song")}
          >
            <Plus className="size-3.5" />
            <span className="hidden md:inline">{t("music_catalog.actions.new_song")}</span>
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
      {/* applied filter chips */}
      {activeFilterCount > 0 && (
        <div className="shrink-0 border-b border-subtle px-3 py-2 sm:px-4">
          <MusicAppliedFilters filters={filters} data={filtersData} onSet={setFilter} onClearAll={clearFilters} />
        </div>
      )}

      {/* selection strip, as in contracts: count, the main actions, "…" for the rest, clear */}
      <ContractBulkActionsBar
        count={selectedTrackCount}
        onClear={() => setSelectedTrackIds([])}
        label={t("music_catalog.action_bar.selected", { count: selectedTrackCount })}
      >
        {totalTracks > selectedTrackCount && (
          <button
            type="button"
            disabled={isBulkDeleting || isSelectingAllMatching}
            onClick={() => void selectAllMatching()}
            className="text-12 font-medium text-accent-primary underline-offset-2 hover:underline disabled:opacity-50"
          >
            {isSelectingAllMatching
              ? t("music_catalog.action_bar.selecting")
              : t("music_catalog.action_bar.select_all", { count: totalTracks })}
          </button>
        )}
        <MusicBulkEditAction
          workspaceSlug={workspaceSlug}
          trackIds={selectedTrackIds}
          options={options}
          disabled={isBulkDeleting}
          triggerClassName={BAR_BUTTON}
          labelClassName={BAR_LABEL}
          onDone={refreshAll}
        />
        {fileLibraryEnabled && (
          <MusicBulkLinkContractAction
            workspaceSlug={workspaceSlug}
            trackIds={selectedTrackIds}
            disabled={isBulkDeleting}
            triggerClassName={BAR_BUTTON}
            labelClassName={BAR_LABEL}
            onDone={() => void mutateTracks()}
          />
        )}
        {referencesEnabled && (
          <BulkTagMenu
            workspaceSlug={workspaceSlug}
            entityName="music_track"
            ids={selectedTrackIds}
            itemsLabel={t("references.bulk.items.music_track")}
            disabled={isBulkDeleting}
            placement="bottom-start"
            triggerClassName={BAR_BUTTON}
            labelClassName={BAR_LABEL}
          />
        )}
        <button
          type="button"
          className={BAR_BUTTON}
          disabled={isBulkDeleting}
          onClick={() => setExportScope("selected")}
          aria-label={t("music_catalog.selection.export")}
          title={t("music_catalog.selection.export")}
        >
          <Download className="size-3.5" />
          <span className={BAR_LABEL}>{t("music_catalog.selection.export")}</span>
        </button>
        <CustomMenu
          placement="bottom-start"
          disabled={isBulkDeleting}
          customButton={
            <span className={BAR_BUTTON} aria-hidden>
              <MoreHorizontal className="size-3.5" />
            </span>
          }
          ariaLabel={t("music_catalog.selection.more")}
          closeOnSelect
        >
          {assistantAvailable && selectedMentions.length > 0 && (
            <CustomMenu.MenuItem onClick={() => askAssistant({ mentions: selectedMentions })}>
              <span className="flex items-center gap-2">
                <Sparkles className="size-3.5" />
                {t("assistant.ask_ai")}
              </span>
            </CustomMenu.MenuItem>
          )}
          <CustomMenu.MenuItem onClick={() => setIsBulkDeleteOpen(true)}>
            <span className="flex items-center gap-2 text-danger-primary">
              <Trash2 className="size-3.5" />
              {t("music_catalog.action_bar.delete")}
            </span>
          </CustomMenu.MenuItem>
        </CustomMenu>
      </ContractBulkActionsBar>

      {/* table (desktop) / cards (mobile) */}
      <div className="min-h-0 flex-1">
        {isLoading && !pages ? (
          <div className="flex h-full items-center justify-center" role="status">
            <Loader2 className="size-6 animate-spin text-tertiary" />
            <span className="sr-only">{t("common.loading")}</span>
          </div>
        ) : (
          <MusicTrackTable
            tracks={tracks}
            options={options}
            openTrackId={peekTrack?.id ?? null}
            onOpen={openTrack}
            onOpenRelease={(releaseId) => openRelease(releases.find((item) => item.id === releaseId))}
            selectedIds={selectedTrackIds}
            onToggleSelect={toggleTrackSelection}
            onToggleSelectAll={toggleLoadedSelection}
            order={order}
            onOrderChange={setOrder}
            emptyState={emptyState}
            footer={footer}
          />
        )}
      </div>

      {/* kept mounted while it slides out */}
      <AnimatePresence>
        {(peekTrack || peekCreateOpen) && (
          <MusicTrackPeekPanel
            key="track-peek"
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
              setPanelParam("track", null);
            }}
            onSaved={() => void mutateTracks()}
            onCreated={(created) => {
              setPeekCreateOpen(false);
              openTrack(created);
            }}
            onResourcesChanged={refreshResources}
          />
        )}
      </AnimatePresence>

      <MusicReleaseModal
        workspaceSlug={workspaceSlug}
        isOpen={releaseOpen}
        release={editingRelease}
        parties={parties}
        options={options}
        onClose={() => {
          setReleaseOpen(false);
          setPanelParam("release", null);
        }}
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
      <MusicExportModal
        workspaceSlug={workspaceSlug}
        isOpen={exportScope !== null}
        initialScope={exportScope ?? "filtered"}
        filters={exportQuery}
        filteredCount={totalTracks}
        selectedIds={selectedTrackIds}
        onClose={() => setExportScope(null)}
      />
      <MusicImportAssetsPanel
        workspaceSlug={workspaceSlug}
        isOpen={importAssetsOpen}
        onClose={() => setImportAssetsOpen(false)}
        onViewRun={(runId) => {
          setImportAssetsOpen(false);
          setSelectedTrackIds([]);
          setFilters({ songs_only: "true", import_run: runId });
        }}
        onViewFile={(assetId) => {
          setImportAssetsOpen(false);
          setSelectedTrackIds([]);
          setFilters({ songs_only: "true", import_file: assetId });
        }}
      />
      <AlertModalCore
        isOpen={isBulkDeleteOpen}
        isSubmitting={isBulkDeleting}
        handleClose={() => !isBulkDeleting && setIsBulkDeleteOpen(false)}
        handleSubmit={() => void removeSelectedTracks()}
        primaryButtonText={{ default: t("common.delete"), loading: t("common.deleting") }}
        secondaryButtonText={t("common.cancel")}
        title={t("music_catalog.delete.title", { count: selectedTrackCount })}
        content={t("music_catalog.delete.description")}
      />
    </div>
  );
}
