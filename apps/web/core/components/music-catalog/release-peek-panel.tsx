/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * Release panel, the song panel's sibling: same docked sheet, header and
 * sections, every value editable in place. Cover, title, status and type in
 * the header; identifiers, details, artists (primary / featured), the
 * tracklist (open a song on top, renumber, move, add, remove), rights and
 * notes, tags, contracts. Takes its place in the panel stack: a song opened
 * from the tracklist stacks over it, and it stacks over the song or contract
 * it was opened from.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { ArrowDown, ArrowUp, Combine, Disc3, Download, ImagePlus, Loader2, Search, Trash2, X } from "lucide-react";
// plane imports
import { useTranslation } from "@plane/i18n";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TMusicCatalogOptions, TMusicParty, TMusicRelease, TMusicTrack } from "@plane/types";
import { AlertModalCore } from "@plane/ui";
import { cn } from "@plane/utils";
// components
import { AskAssistantButton } from "@/components/assistant/ask";
import { PeekLinkActions } from "@/components/entity-peek/peek-link-actions";
import { useEntityPeek } from "@/components/entity-peek/use-entity-peek";
import { StackLayer } from "@/components/panel-stack/stack-layer";
import { usePanelLayer } from "@/components/panel-stack/use-panel-layer";
import { EntityBacklinks } from "@/components/references/references-section";
import { SharedTagPicker } from "@/components/references/shared-tag-picker";
// hooks & services
import { useWorkspace } from "@/hooks/store/use-workspace";
import { fileLibraryService } from "@/services/file-library.service";
import { musicService } from "@/services/music.service";
// local imports
import { EditableField } from "./editable-field";
import { AddAction, CopyButton, FieldRow, PEEK_ICON_BUTTON, PEEK_PANEL_CLASS, SectionTitle } from "./peek-parts";
import { MusicReleaseMergeModal } from "./release-merge-modal";
import { SearchableSelect } from "./searchable-select";
import { getApiError } from "./shared";
import { WorkContractsSection } from "./work-contracts-section";

type Props = {
  workspaceSlug: string;
  release: TMusicRelease;
  options?: TMusicCatalogOptions;
  parties: TMusicParty[];
  onClose: () => void;
  /** The release or its tracklist changed: refresh the lists that show it */
  onSaved: () => void;
  onDeleted: () => void;
  /** A person was created from the artists picker */
  onResourcesChanged: () => void;
  /** Set when opened outside the catalog: go to the release there */
  onOpenInSection?: () => void;
};

const KNOWN_STATUSES = new Set(["DRAFT", "SCHEDULED", "RELEASED", "TAKEN_DOWN"]);
const KNOWN_TYPES = new Set(["SINGLE", "EP", "LP", "ALBUM", "COMPILATION", "SOUNDTRACK"]);
const ARTIST_ROLES = ["PRIMARY", "FEATURED"];

type TPosition = { disc: number; number: number };

type TOption = { value: string; label: string };
const labelOf = (list: TOption[]) => (value: string) => list.find((option) => option.value === value)?.label ?? value;
/** The header's status and type chips (as the song panel's status chip) */
const CHIP = "min-h-5 w-fit rounded-full border border-subtle px-2 py-0 text-11 text-secondary";

type TTextField =
  | "version"
  | "upc"
  | "ean"
  | "catalog_number"
  | "label_name"
  | "language"
  | "cover_url"
  | "p_line"
  | "c_line"
  | "notes";

const formatDuration = (ms: number | null | undefined) => {
  if (!ms) return "";
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
};

const positionIn = (track: TMusicTrack, releaseId: string): TPosition => {
  const link = track.release_details.find((item) => item.id === releaseId);
  return { disc: link?.disc_number || 1, number: link?.track_number || 1 };
};

/** The song's full release list (the API replaces it) with this release's
 * place set, or the release removed when `position` is null */
const releasesWith = (track: TMusicTrack, releaseId: string, position: TPosition | null) => [
  ...track.release_details
    .filter((item) => item.id !== releaseId)
    .map((item) => ({ id: item.id, disc_number: item.disc_number, track_number: item.track_number })),
  ...(position ? [{ id: releaseId, disc_number: position.disc, track_number: position.number }] : []),
];

const trackArtists = (track: TMusicTrack) => {
  const names = (role: string) =>
    track.credits.filter((credit) => credit.role === role).map((credit) => credit.party.display_name);
  const primary = names("PRIMARY_ARTIST").join(", ");
  const featured = names("FEATURED_ARTIST").join(", ");
  return featured ? `${primary || "—"} feat. ${featured}` : primary;
};

/** Search-as-you-type over the whole catalog (it can be thousands of songs) */
function TrackSearch(props: {
  workspaceSlug: string;
  excludeIds: string[];
  onSelect: (track: TMusicTrack) => void;
  onCancel: () => void;
}) {
  const { workspaceSlug, excludeIds, onSelect, onCancel } = props;
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TMusicTrack[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    const timer = setTimeout(() => {
      const run = async () => {
        try {
          const response = await musicService.getTracks(workspaceSlug, {
            search: query.trim() || undefined,
            songs_only: "true",
            order_by: "title",
            page: "1",
            page_size: "20",
          });
          if (!cancelled) setResults(Array.isArray(response) ? response : response.results);
        } catch {
          if (!cancelled) setResults([]);
        } finally {
          if (!cancelled) setIsLoading(false);
        }
      };
      void run();
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, workspaceSlug]);

  const visible = results.filter((track) => !excludeIds.includes(track.id));
  return (
    <div className="rounded-md border border-subtle p-1.5">
      <div className="relative mb-1">
        <Search className="absolute top-1/2 left-2 size-3 -translate-y-1/2 text-tertiary" />
        <input
          // eslint-disable-next-line jsx-a11y/no-autofocus -- opened on purpose by "Agregar"
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              // Closes the search, not the panel
              event.preventDefault();
              event.stopPropagation();
              onCancel();
            }
            if (event.key === "Enter" && visible[0]) {
              event.preventDefault();
              onSelect(visible[0]);
            }
          }}
          placeholder={t("music_catalog.release_panel.tracks.search_placeholder")}
          aria-label={t("music_catalog.release_panel.tracks.search_placeholder")}
          className="w-full rounded-sm border border-subtle bg-transparent py-1 pr-2 pl-6 text-12"
        />
      </div>
      <div className="max-h-52 space-y-0.5 overflow-y-auto">
        {visible.map((track) => (
          <button
            key={track.id}
            type="button"
            onClick={() => onSelect(track)}
            className="flex w-full items-center gap-2 rounded-sm px-1.5 py-1 text-left text-12 hover:bg-layer-1-hover"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate">
                {track.title}
                {track.version && <span className="text-tertiary"> ({track.version})</span>}
              </span>
              <span className="block truncate text-10 text-tertiary">{trackArtists(track) || "—"}</span>
            </span>
            {track.isrc && <span className="font-mono shrink-0 text-10 text-tertiary">{track.isrc}</span>}
          </button>
        ))}
        {isLoading && visible.length === 0 && (
          <p className="flex items-center gap-1.5 px-1.5 py-1 text-11 text-tertiary">
            <Loader2 className="size-3 animate-spin" /> {t("music_catalog.release_panel.tracks.searching")}
          </p>
        )}
        {!isLoading && visible.length === 0 && (
          <p className="px-1.5 py-1 text-11 text-tertiary">{t("music_catalog.release_panel.tracks.no_matches")}</p>
        )}
      </div>
    </div>
  );
}

/** A disc or track number that saves on blur / Enter */
function PositionInput(props: {
  value: number;
  label: string;
  disabled?: boolean;
  className?: string;
  onCommit: (value: number) => void;
}) {
  const { value, label, disabled, className, onCommit } = props;
  return (
    <input
      key={value}
      type="number"
      min={1}
      max={999}
      defaultValue={value}
      disabled={disabled}
      aria-label={label}
      title={label}
      onBlur={(event) => {
        const next = Number.parseInt(event.target.value, 10);
        if (!Number.isFinite(next) || next < 1) {
          event.target.value = String(value);
          return;
        }
        if (next !== value) onCommit(next);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
      className={cn(
        "w-8 shrink-0 [appearance:textfield] rounded-sm border border-transparent bg-transparent px-0.5 py-0.5 text-center text-11 text-tertiary tabular-nums outline-none hover:border-subtle focus:border-accent-strong focus:text-primary disabled:opacity-50 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none",
        className
      )}
    />
  );
}

export function MusicReleasePeekPanel(props: Props) {
  const {
    workspaceSlug,
    release: initialRelease,
    options,
    parties,
    onClose,
    onSaved,
    onDeleted,
    onResourcesChanged,
    onOpenInSection,
  } = props;
  const { t } = useTranslation();
  const { isWorkspaceFeatureEnabled } = useWorkspace();
  const referencesEnabled = isWorkspaceFeatureEnabled(workspaceSlug, "references");
  const { open: openPeek } = useEntityPeek();
  // The panel owns the freshest copy: PATCH responses replace it in place
  const [release, setRelease] = useState<TMusicRelease>(initialRelease);
  useEffect(() => setRelease(initialRelease), [initialRelease]);
  const releaseId = release.id;

  const [uploadingCover, setUploadingCover] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isAddingArtist, setIsAddingArtist] = useState(false);
  const [newArtistRole, setNewArtistRole] = useState("PRIMARY");
  const [isAddingTrack, setIsAddingTrack] = useState(false);
  const [isMergeOpen, setIsMergeOpen] = useState(false);
  const [busyTrackIds, setBusyTrackIds] = useState<string[]>([]);
  // The contracts section's picker or confirm is open: Escape belongs to it
  const [contractsDialogOpen, setContractsDialogOpen] = useState(false);
  const coverInputRef = useRef<HTMLInputElement | null>(null);

  // ── Tracklist: the songs of this release, in disc / track order. The key
  // starts with MUSIC_TRACKS so a song saved in its own panel refreshes it.
  const tracksKey = `MUSIC_TRACKS_RELEASE_${workspaceSlug}_${releaseId}`;
  const {
    data: trackData,
    isLoading: tracksLoading,
    mutate: mutateTracks,
  } = useSWR(tracksKey, async () => {
    const response = await musicService.getTracks(workspaceSlug, { release: releaseId });
    return Array.isArray(response) ? response : response.results;
  });
  const tracks = useMemo(
    () =>
      [...(trackData ?? [])].sort((a, b) => {
        const pa = positionIn(a, releaseId);
        const pb = positionIn(b, releaseId);
        return pa.disc - pb.disc || pa.number - pb.number || a.title.localeCompare(b.title);
      }),
    [trackData, releaseId]
  );
  const discs = useMemo(
    () => [...new Set(tracks.map((track) => positionIn(track, releaseId).disc))],
    [tracks, releaseId]
  );
  const multiDisc = discs.length > 1;
  const totalDuration = tracks.reduce((sum, track) => sum + (track.duration_ms ?? 0), 0);

  // Where this panel sits among the open panels (a song opened from it stacks on top)
  const layer = usePanelLayer(true);
  const isTopLayer = layer.isTop;
  const dialogOpen = contractsDialogOpen || isDeleteOpen || isMergeOpen;
  // Escape closes the panel when it is on top and nothing of its own is open.
  // A field being edited takes the first Escape (it cancels or blurs).
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || !isTopLayer || dialogOpen) return;
      if (document.querySelector('[data-headlessui-state="open"]')) return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("input, textarea, select")) {
        target.blur();
        return;
      }
      onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [isTopLayer, dialogOpen, onClose]);
  // Focus goes back where it was when the panel closes
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  const saveFailed = (error: unknown) =>
    setToast({
      type: TOAST_TYPE.ERROR,
      title: t("music_catalog.release_panel.save_failed"),
      message: getApiError(error),
    });

  const patch = async (payload: Partial<TMusicRelease>) => {
    try {
      const updated = await musicService.saveRelease(workspaceSlug, { id: releaseId, ...payload });
      // Counts are annotated by the list only
      setRelease((current) => ({
        ...updated,
        track_count: current.track_count,
        contract_count: current.contract_count,
      }));
      onSaved();
    } catch (error) {
      saveFailed(error);
    }
  };

  const saveText = (field: TTextField) => async (value: string) =>
    patch({ [field]: value.trim() } as Partial<TMusicRelease>);
  /** Status and type always hold a value: the blank choice is ignored */
  const saveChoice = (field: "status" | "release_type") => async (value: string) => {
    if (value) await patch({ [field]: value } as Partial<TMusicRelease>);
  };
  const saveDate = (field: "release_date" | "original_release_date") => async (value: string) =>
    patch({ [field]: value || null } as Partial<TMusicRelease>);
  const saveTitle = async (value: string) => {
    if (!value.trim()) return;
    await patch({ title: value.trim() });
  };
  const saveCopyrightYear = async (value: string) => {
    const raw = value.trim();
    if (!raw) return patch({ copyright_year: null });
    const year = Number(raw);
    if (!/^\d{4}$/.test(raw) || year < 1900 || year > 2999) {
      setToast({ type: TOAST_TYPE.ERROR, title: t("music_catalog.release_panel.invalid_year") });
      return;
    }
    return patch({ copyright_year: year });
  };
  const saveTerritories = async (value: string) =>
    patch({
      territories: [
        ...new Set(
          value
            .split(/[,;\n]/)
            .map((item) => item.trim())
            .filter(Boolean)
        ),
      ],
    });

  const uploadCover = async (file: File | undefined) => {
    if (!file) return;
    setUploadingCover(true);
    try {
      const uploaded = await fileLibraryService.uploadFile(workspaceSlug, file, undefined, undefined, "music");
      await patch({ cover_url: fileLibraryService.getFileViewUrl(workspaceSlug, uploaded.asset_id, "music") });
      setToast({ type: TOAST_TYPE.SUCCESS, title: t("music_catalog.release_panel.cover_uploaded") });
    } catch {
      setToast({ type: TOAST_TYPE.ERROR, title: t("music_catalog.release_panel.upload_failed") });
    } finally {
      setUploadingCover(false);
      if (coverInputRef.current) coverInputRef.current.value = "";
    }
  };

  // ── Artists: the whole list is sent each time (the API replaces it)
  const artists = [...release.artist_details].sort(
    (a, b) => ARTIST_ROLES.indexOf(a.role) - ARTIST_ROLES.indexOf(b.role)
  );
  const artistEntries = () => artists.map((artist) => ({ party_id: artist.id, role: artist.role }));
  const roleLabel = (role: string) =>
    ARTIST_ROLES.includes(role) ? t(`music_catalog.release_panel.artist_roles.${role}`) : role;
  const roleOptions = ARTIST_ROLES.map((role) => ({ value: role, label: roleLabel(role) }));
  const addArtist = async (partyId: string) => {
    if (artists.some((artist) => artist.id === partyId && artist.role === newArtistRole)) return;
    await patch({ artist_entries: [...artistEntries(), { party_id: partyId, role: newArtistRole }] });
    setIsAddingArtist(false);
  };
  const createArtist = async (name: string) => {
    try {
      const created = await musicService.saveParty(workspaceSlug, { display_name: name, kind: "ARTIST" });
      onResourcesChanged();
      await addArtist(created.id);
    } catch (error) {
      saveFailed(error);
    }
  };
  const changeArtistRole = async (index: number, role: string) =>
    patch({
      artist_entries: artistEntries()
        .map((entry, position) => (position === index ? { party_id: entry.party_id, role } : entry))
        // The same person twice with the same role is one link
        .filter(
          (entry, position, list) =>
            list.findIndex((other) => other.party_id === entry.party_id && other.role === entry.role) === position
        ),
    });
  const removeArtist = async (index: number) =>
    patch({ artist_entries: artistEntries().filter((_, position) => position !== index) });

  // ── Tracklist edits go through each song (its release links)
  const withBusy = async (ids: string[], work: () => Promise<TMusicTrack[]>) => {
    setBusyTrackIds((current) => [...current, ...ids]);
    try {
      const updated = await work();
      await mutateTracks(
        (current = []) => {
          const byId = new Map(updated.map((track) => [track.id, track]));
          const merged = current.map((track) => byId.get(track.id) ?? track);
          updated.forEach((track) => {
            if (!merged.some((item) => item.id === track.id)) merged.push(track);
          });
          return merged.filter((track) => track.release_details.some((item) => item.id === releaseId));
        },
        { revalidate: false }
      );
      onSaved();
    } catch (error) {
      saveFailed(error);
      void mutateTracks();
    } finally {
      setBusyTrackIds((current) => current.filter((id) => !ids.includes(id)));
    }
  };
  const savePosition = (track: TMusicTrack, position: TPosition | null) =>
    musicService.saveTrack(workspaceSlug, { id: track.id, releases: releasesWith(track, releaseId, position) });

  const setPosition = (track: TMusicTrack, change: Partial<TPosition>) =>
    withBusy([track.id], async () => [await savePosition(track, { ...positionIn(track, releaseId), ...change })]);

  /** Swaps a song with its neighbour; equal numbers renumber that disc */
  const move = (index: number, delta: -1 | 1) => {
    const current = tracks[index];
    const other = tracks[index + delta];
    if (!current || !other) return;
    const a = positionIn(current, releaseId);
    const b = positionIn(other, releaseId);
    if (a.disc !== b.disc || a.number !== b.number) {
      void withBusy([current.id, other.id], () => Promise.all([savePosition(current, b), savePosition(other, a)]));
      return;
    }
    const order = [...tracks];
    order[index] = other;
    order[index + delta] = current;
    const sameDisc = order.filter((track) => positionIn(track, releaseId).disc === a.disc);
    const changed = sameDisc
      .map((track, position) => ({ track, number: position + 1 }))
      .filter(({ track, number }) => positionIn(track, releaseId).number !== number);
    void withBusy(
      changed.map(({ track }) => track.id),
      () => Promise.all(changed.map(({ track, number }) => savePosition(track, { disc: a.disc, number })))
    );
  };

  const addTrack = (track: TMusicTrack) => {
    const lastDisc = discs[discs.length - 1] ?? 1;
    const lastNumber = Math.max(
      0,
      ...tracks
        .map((item) => positionIn(item, releaseId))
        .filter((position) => position.disc === lastDisc)
        .map((position) => position.number)
    );
    setIsAddingTrack(false);
    void withBusy([track.id], async () => [await savePosition(track, { disc: lastDisc, number: lastNumber + 1 })]);
  };
  const removeTrack = (track: TMusicTrack) => void withBusy([track.id], async () => [await savePosition(track, null)]);

  const exportTracks = async () => {
    setIsExporting(true);
    try {
      // Everything stored about the release's songs, as the export panel's "Todo"
      await musicService.exportCatalog(workspaceSlug, {
        format: "xlsx",
        columns: "all",
        filters: { release: releaseId },
        fileName: (release.title || "lanzamiento").replace(/[\\/:*?"<>|]+/g, " ").trim() || "lanzamiento",
      });
    } catch {
      setToast({ type: TOAST_TYPE.ERROR, title: t("music_catalog.release_panel.export_failed") });
    } finally {
      setIsExporting(false);
    }
  };

  const deleteRelease = async () => {
    setIsDeleting(true);
    try {
      await musicService.deleteRelease(workspaceSlug, releaseId);
      setToast({ type: TOAST_TYPE.SUCCESS, title: t("music_catalog.release_panel.deleted") });
      setIsDeleteOpen(false);
      onDeleted();
    } catch (error) {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: t("music_catalog.release_panel.delete_failed"),
        message: getApiError(error),
      });
    } finally {
      setIsDeleting(false);
    }
  };

  // Statuses and types named in the user's language when known
  const statusOptions = (options?.release_statuses ?? []).map(([value, label]) => ({
    value,
    label: KNOWN_STATUSES.has(value) ? t(`music_catalog.release_panel.statuses.${value}`) : label,
  }));
  const typeOptions = (options?.release_types ?? []).map(([value, label]) => ({
    value,
    label: KNOWN_TYPES.has(value) ? t(`music_catalog.release_panel.types.${value}`) : label,
  }));

  const metadata = release.metadata ?? {};
  const extraData = Object.entries((metadata.extra as Record<string, unknown> | undefined) ?? {});
  const externalIds = Object.entries((metadata.external_ids as Record<string, unknown> | undefined) ?? {});
  const busy = (track: TMusicTrack) => busyTrackIds.includes(track.id);
  const sectionLabels = { add: t("music_catalog.release_panel.add"), cancel: t("common.cancel") };

  return (
    <>
      {/* click-outside catcher — transparent over the catalog so it stays fully
          visible; dimmed when the release sits on top of another panel */}
      <StackLayer
        layer={layer}
        backdrop={layer.depth > 0 ? "dim" : "clear"}
        onBackdropClick={onClose}
        dialog={{ label: release.title || t("music_catalog.release_panel.untitled") }}
        className={PEEK_PANEL_CLASS}
      >
        {/* header — the cover IS the icon spot: click to add/replace it */}
        <div className="flex shrink-0 items-start justify-between gap-2 border-b border-subtle px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <input
              ref={coverInputRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(event) => void uploadCover(event.target.files?.[0])}
            />
            <button
              type="button"
              onClick={() => coverInputRef.current?.click()}
              className="group/cover relative flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-subtle bg-accent-primary/10 text-accent-primary"
              title={
                release.cover_url
                  ? t("music_catalog.release_panel.cover_change")
                  : t("music_catalog.release_panel.cover_add")
              }
            >
              {uploadingCover ? (
                <Loader2 className="size-4 animate-spin" />
              ) : release.cover_url ? (
                <img src={release.cover_url} alt="" className="size-full object-cover" />
              ) : (
                <Disc3 className="size-5" />
              )}
              <span
                className={cn(
                  "absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 transition-opacity group-hover/cover:opacity-100",
                  uploadingCover && "hidden"
                )}
              >
                <ImagePlus className="size-4 text-white" />
              </span>
            </button>
            <div className="min-w-0">
              <EditableField
                value={release.title}
                onSave={saveTitle}
                displayClassName="text-15 font-semibold"
                placeholder={t("music_catalog.release_panel.untitled")}
              />
              <div className="flex flex-wrap items-center gap-1 px-1.5">
                <EditableField
                  value={release.status}
                  onSave={saveChoice("status")}
                  variant="select"
                  options={statusOptions}
                  format={labelOf(statusOptions)}
                  displayClassName={CHIP}
                />
                <EditableField
                  value={release.release_type}
                  onSave={saveChoice("release_type")}
                  variant="select"
                  options={typeOptions}
                  format={labelOf(typeOptions)}
                  displayClassName={CHIP}
                />
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <AskAssistantButton
              compact
              className={PEEK_ICON_BUTTON}
              mentions={[{ type: "music_release", id: releaseId, label: release.title || releaseId }]}
            />
            <button
              type="button"
              onClick={() => void exportTracks()}
              disabled={isExporting || tracks.length === 0}
              className={cn(PEEK_ICON_BUTTON, "disabled:cursor-not-allowed disabled:opacity-50")}
              title={t("music_catalog.release_panel.export")}
              aria-label={t("music_catalog.release_panel.export")}
            >
              {isExporting ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
            </button>
            <PeekLinkActions onOpenInSection={onOpenInSection} className={PEEK_ICON_BUTTON} small />
            <button
              type="button"
              onClick={() => setIsDeleteOpen(true)}
              className={cn(PEEK_ICON_BUTTON, "hover:text-danger-primary")}
              title={t("music_catalog.release_panel.delete")}
              aria-label={t("music_catalog.release_panel.delete")}
            >
              <Trash2 className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={onClose}
              className={PEEK_ICON_BUTTON}
              title={t("music_catalog.release_panel.close")}
              aria-label={t("music_catalog.release_panel.close")}
            >
              <X className="size-3.5" />
            </button>
          </div>
        </div>

        {/* body */}
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
          <section className="space-y-1">
            <SectionTitle>{t("music_catalog.release_panel.sections.identifiers")}</SectionTitle>
            <FieldRow label="UPC" value={release.upc} onSave={saveText("upc")} mono />
            <FieldRow label="EAN" value={release.ean} onSave={saveText("ean")} mono />
            <FieldRow
              label={t("music_catalog.release_panel.fields.catalog_number")}
              value={release.catalog_number}
              onSave={saveText("catalog_number")}
              mono
            />
          </section>

          <section className="space-y-1">
            <SectionTitle>{t("music_catalog.release_panel.sections.details")}</SectionTitle>
            <FieldRow
              label={t("music_catalog.release_panel.fields.type")}
              value={release.release_type}
              onSave={saveChoice("release_type")}
              variant="select"
              options={typeOptions}
              format={labelOf(typeOptions)}
              copyValue=""
            />
            <FieldRow
              label={t("music_catalog.release_panel.fields.status")}
              value={release.status}
              onSave={saveChoice("status")}
              variant="select"
              options={statusOptions}
              format={labelOf(statusOptions)}
              copyValue=""
            />
            <FieldRow
              label={t("music_catalog.release_panel.fields.version")}
              value={release.version}
              onSave={saveText("version")}
              placeholder={t("music_catalog.release_panel.fields.version_placeholder")}
            />
            <FieldRow
              label={t("music_catalog.release_panel.fields.release_date")}
              value={release.release_date}
              onSave={saveDate("release_date")}
              variant="date"
            />
            <FieldRow
              label={t("music_catalog.release_panel.fields.original_release_date")}
              value={release.original_release_date}
              onSave={saveDate("original_release_date")}
              variant="date"
            />
            <FieldRow
              label={t("music_catalog.release_panel.fields.language")}
              value={release.language}
              onSave={saveText("language")}
            />
            <FieldRow
              label={t("music_catalog.release_panel.fields.label")}
              value={release.label_name}
              onSave={saveText("label_name")}
            />
            <FieldRow
              label={t("music_catalog.release_panel.fields.copyright_year")}
              value={release.copyright_year ? String(release.copyright_year) : null}
              onSave={saveCopyrightYear}
            />
            <FieldRow
              label={t("music_catalog.release_panel.fields.territories")}
              value={release.territories?.length ? release.territories.join(", ") : null}
              onSave={saveTerritories}
              placeholder={t("music_catalog.release_panel.fields.territories_placeholder")}
            />
            <FieldRow
              label={t("music_catalog.release_panel.fields.cover_url")}
              value={release.cover_url}
              onSave={saveText("cover_url")}
            />
          </section>

          <section className="space-y-1.5">
            <SectionTitle
              action={
                <AddAction
                  isOpen={isAddingArtist}
                  onClick={() => setIsAddingArtist((open) => !open)}
                  labels={sectionLabels}
                />
              }
            >
              {artists.length
                ? `${t("music_catalog.release_panel.sections.artists")} · ${artists.length}`
                : t("music_catalog.release_panel.sections.artists")}
            </SectionTitle>
            <div className="space-y-1">
              {artists.map((artist, index) => (
                <div
                  key={`${artist.id}-${artist.role}`}
                  className="group/row flex items-center gap-1.5 rounded-sm px-1.5 py-1 hover:bg-layer-1-hover"
                >
                  <span className="min-w-0 flex-1 truncate text-12 font-medium">{artist.name}</span>
                  <SearchableSelect
                    className="w-32 shrink-0"
                    options={roleOptions}
                    value={artist.role}
                    onSelect={(role) => role !== artist.role && void changeArtistRole(index, role)}
                  />
                  <CopyButton value={artist.name} />
                  <button
                    type="button"
                    onClick={() => void removeArtist(index)}
                    className="shrink-0 rounded-sm p-0.5 text-tertiary hover:text-danger-primary"
                    title={t("music_catalog.release_panel.remove_artist")}
                    aria-label={t("music_catalog.release_panel.remove_artist")}
                  >
                    <X className="size-3" />
                  </button>
                </div>
              ))}
              {artists.length === 0 && (
                <p className="px-1.5 text-12 text-placeholder">{t("music_catalog.release_panel.no_artists")}</p>
              )}
            </div>
            {isAddingArtist && (
              <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-subtle p-2">
                <SearchableSelect
                  className="min-w-44 flex-1"
                  options={parties.map((party) => ({ value: party.id, label: party.display_name }))}
                  onSelect={(partyId) => void addArtist(partyId)}
                  onCreate={(name) => void createArtist(name)}
                  placeholder={t("music_catalog.release_panel.artist_search")}
                />
                <SearchableSelect
                  className="w-32"
                  options={roleOptions}
                  value={newArtistRole}
                  onSelect={setNewArtistRole}
                />
              </div>
            )}
          </section>

          <section className="space-y-1.5">
            <SectionTitle
              action={
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setIsMergeOpen(true)}
                    className="flex items-center gap-1 text-11 text-accent-primary hover:underline"
                    title={t("music_catalog.release_merge.action_hint")}
                  >
                    <Combine className="size-3" /> {t("music_catalog.release_merge.action")}
                  </button>
                  <AddAction
                    isOpen={isAddingTrack}
                    onClick={() => setIsAddingTrack((open) => !open)}
                    labels={sectionLabels}
                  />
                </div>
              }
            >
              {[
                t("music_catalog.release_panel.sections.tracks"),
                tracks.length ? String(tracks.length) : "",
                totalDuration ? formatDuration(totalDuration) : "",
              ]
                .filter(Boolean)
                .join(" · ")}
            </SectionTitle>
            {isAddingTrack && (
              <TrackSearch
                workspaceSlug={workspaceSlug}
                excludeIds={tracks.map((track) => track.id)}
                onSelect={addTrack}
                onCancel={() => setIsAddingTrack(false)}
              />
            )}
            {tracksLoading && !trackData ? (
              <p className="flex items-center gap-1.5 px-1.5 text-12 text-tertiary">
                <Loader2 className="size-3 animate-spin" /> {t("common.loading")}
              </p>
            ) : tracks.length === 0 ? (
              <p className="px-1.5 text-12 text-placeholder">{t("music_catalog.release_panel.tracks.empty")}</p>
            ) : (
              <div className="space-y-0.5">
                {tracks.map((track, index) => {
                  const position = positionIn(track, releaseId);
                  const startsDisc =
                    multiDisc && (index === 0 || positionIn(tracks[index - 1], releaseId).disc !== position.disc);
                  const isBusy = busy(track);
                  return (
                    <div key={track.id}>
                      {startsDisc && (
                        <p className="px-1.5 pt-1.5 pb-0.5 text-10 font-medium tracking-wide text-tertiary uppercase">
                          {t("music_catalog.release_panel.tracks.disc_heading", { number: position.disc })}
                        </p>
                      )}
                      <div className="group/row flex items-center gap-1.5 rounded-sm px-1 py-1 hover:bg-layer-1-hover">
                        <div className="flex shrink-0 items-center">
                          <PositionInput
                            value={position.disc}
                            label={t("music_catalog.release_panel.tracks.disc")}
                            disabled={isBusy}
                            onCommit={(disc) => void setPosition(track, { disc })}
                            className={cn(
                              "w-6",
                              !multiDisc && "opacity-0 group-hover/row:opacity-100 focus:opacity-100"
                            )}
                          />
                          <PositionInput
                            value={position.number}
                            label={t("music_catalog.release_panel.tracks.number")}
                            disabled={isBusy}
                            onCommit={(number) => void setPosition(track, { number })}
                          />
                        </div>
                        <button
                          type="button"
                          onClick={() => openPeek({ kind: "music_track", id: track.id })}
                          className="group/track min-w-0 flex-1 text-left"
                          title={t("music_catalog.release_panel.tracks.open")}
                        >
                          <span className="block truncate text-12 font-medium group-hover/track:text-accent-primary group-hover/track:underline">
                            {track.title || t("music_catalog.release_panel.untitled")}
                            {track.version && <span className="font-normal text-tertiary"> ({track.version})</span>}
                          </span>
                          <span className="block truncate text-10 text-tertiary">{trackArtists(track) || "—"}</span>
                        </button>
                        <span className="font-mono hidden w-28 shrink-0 truncate text-11 text-tertiary sm:block">
                          {track.isrc || "—"}
                        </span>
                        <span className="w-10 shrink-0 text-right text-11 text-tertiary tabular-nums">
                          {formatDuration(track.duration_ms)}
                        </span>
                        <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100">
                          {isBusy ? (
                            <Loader2 className="mx-1 size-3 animate-spin text-tertiary" />
                          ) : (
                            <>
                              <button
                                type="button"
                                onClick={() => move(index, -1)}
                                disabled={index === 0}
                                className="rounded-sm p-0.5 text-tertiary hover:text-primary disabled:opacity-30"
                                title={t("music_catalog.release_panel.tracks.move_up")}
                                aria-label={t("music_catalog.release_panel.tracks.move_up")}
                              >
                                <ArrowUp className="size-3" />
                              </button>
                              <button
                                type="button"
                                onClick={() => move(index, 1)}
                                disabled={index === tracks.length - 1}
                                className="rounded-sm p-0.5 text-tertiary hover:text-primary disabled:opacity-30"
                                title={t("music_catalog.release_panel.tracks.move_down")}
                                aria-label={t("music_catalog.release_panel.tracks.move_down")}
                              >
                                <ArrowDown className="size-3" />
                              </button>
                            </>
                          )}
                          <button
                            type="button"
                            onClick={() => removeTrack(track)}
                            disabled={isBusy}
                            className="rounded-sm p-0.5 text-tertiary hover:text-danger-primary disabled:opacity-30"
                            title={t("music_catalog.release_panel.tracks.remove")}
                            aria-label={t("music_catalog.release_panel.tracks.remove")}
                          >
                            <X className="size-3" />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section className="space-y-1">
            <SectionTitle>{t("music_catalog.release_panel.sections.rights")}</SectionTitle>
            <FieldRow
              label={t("music_catalog.release_panel.fields.p_line")}
              value={release.p_line}
              onSave={saveText("p_line")}
            />
            <FieldRow
              label={t("music_catalog.release_panel.fields.c_line")}
              value={release.c_line}
              onSave={saveText("c_line")}
            />
            <FieldRow
              label={t("music_catalog.release_panel.fields.notes")}
              value={release.notes}
              onSave={saveText("notes")}
              variant="textarea"
            />
          </section>

          {referencesEnabled && (
            <>
              <section className="space-y-1.5">
                <SectionTitle>{t("references.tags.title")}</SectionTitle>
                <SharedTagPicker workspaceSlug={workspaceSlug} entityName="music_release" entityId={releaseId} />
              </section>
              <EntityBacklinks
                workspaceSlug={workspaceSlug}
                entityName="music_release"
                entityId={releaseId}
                className="space-y-1.5"
                renderTitle={(label, count) => <SectionTitle>{`${label} · ${count}`}</SectionTitle>}
              />
            </>
          )}

          <WorkContractsSection
            workspaceSlug={workspaceSlug}
            kind="music_release"
            entityId={releaseId}
            entityTitle={release.title}
            onDialogOpenChange={setContractsDialogOpen}
            className="space-y-1.5"
            renderTitle={(label, count) => <SectionTitle>{count ? `${label} · ${count}` : label}</SectionTitle>}
          />

          {/* Distributor ids and the file columns kept as extra data (read-only) */}
          {(extraData.length > 0 || externalIds.length > 0) && (
            <details className="group/extra space-y-1">
              <summary className="cursor-pointer list-none">
                <SectionTitle>{`${t("music_catalog.credits.extra_title")} · ${extraData.length + externalIds.length}`}</SectionTitle>
              </summary>
              <p className="px-1.5 text-11 text-tertiary">{t("music_catalog.credits.extra_hint")}</p>
              {externalIds.map(([key, value]) => (
                <FieldRow
                  key={`id-${key}`}
                  label={`${t("music_catalog.credits.external_id")} (${key})`}
                  value={String(value ?? "")}
                  mono
                />
              ))}
              {extraData.map(([key, value]) => (
                <FieldRow key={key} label={key} value={String(value ?? "")} />
              ))}
            </details>
          )}
        </div>
      </StackLayer>
      <MusicReleaseMergeModal
        workspaceSlug={workspaceSlug}
        release={release}
        isOpen={isMergeOpen}
        onClose={() => setIsMergeOpen(false)}
        onMerged={() => {
          void mutateTracks();
          onSaved();
        }}
      />
      <AlertModalCore
        isOpen={isDeleteOpen}
        isSubmitting={isDeleting}
        handleClose={() => !isDeleting && setIsDeleteOpen(false)}
        handleSubmit={() => void deleteRelease()}
        primaryButtonText={{ default: t("common.delete"), loading: t("common.deleting") }}
        secondaryButtonText={t("common.cancel")}
        title={t("music_catalog.release_panel.delete_title", { title: release.title })}
        content={t("music_resources.delete_release_impact")}
      />
    </>
  );
}
