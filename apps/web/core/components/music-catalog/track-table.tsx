/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * The catalog's song list, built like the contracts list (ContractsTable):
 * checkbox column, sortable headers, title + secondary line first, a row
 * click opens the song's panel, cards on phones.
 */

import type { KeyboardEvent, ReactNode } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, FileSignature, Music2, Video } from "lucide-react";
import { useTranslation } from "@plane/i18n";
import type { TMusicCatalogOptions, TMusicTrack } from "@plane/types";
import { cn } from "@plane/utils";
import { ContractSelectionCheckbox } from "@/components/file-library/contracts/list-controls";
import { formatContractDate } from "@/components/file-library/contracts/utils";

/** Default order of the list (newest release first, undated songs last) */
export const DEFAULT_TRACK_ORDER = "-release_date";

/** Status → design-system tone (no hardcoded palette colors) */
const STATUS_TONE: Record<string, string> = {
  RELEASED: "bg-success-subtle text-success-primary",
  SCHEDULED: "bg-accent-primary/10 text-accent-primary",
  READY: "bg-warning-subtle text-warning-primary",
  TAKEN_DOWN: "bg-danger-subtle text-danger-primary",
  DRAFT: "bg-layer-1 text-secondary",
};
const KNOWN_STATUSES = Object.keys(STATUS_TONE);

/** Legacy rows may hold the label ("Released") instead of the key */
const statusKey = (value: string) => value.trim().toUpperCase().replaceAll(" ", "_");

export function TrackStatusPill({ status }: { status: string }) {
  const { t } = useTranslation();
  if (!status) return <span className="text-placeholder">—</span>;
  const key = statusKey(status);
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-11 font-medium whitespace-nowrap",
        STATUS_TONE[key] ?? STATUS_TONE.DRAFT
      )}
    >
      {KNOWN_STATUSES.includes(key) ? t(`music_catalog.status.${key}`) : status.replaceAll("_", " ")}
    </span>
  );
}

export const artistNames = (track: TMusicTrack) =>
  track.credits
    .filter((credit) => credit.role === "PRIMARY_ARTIST" || credit.role === "FEATURED_ARTIST")
    .map((credit) => credit.party.display_name)
    .join(", ");

type TSortColumn = { asc: string; desc: string };
const SORTS = {
  title: { asc: "title", desc: "-title" },
  isrc: { asc: "isrc", desc: "-isrc" },
  status: { asc: "status", desc: "-status" },
  contract_count: { asc: "contract_count", desc: "-contract_count" },
  release_date: { asc: "release_date", desc: "-release_date" },
} satisfies Record<string, TSortColumn>;

type Props = {
  tracks: TMusicTrack[];
  options?: TMusicCatalogOptions;
  openTrackId: string | null;
  onOpen: (track: TMusicTrack) => void;
  onOpenRelease: (releaseId: string) => void;
  selectedIds: string[];
  onToggleSelect: (trackId: string) => void;
  onToggleSelectAll: () => void;
  order: string;
  onOrderChange: (order: string) => void;
  /** Rendered instead of the rows when there are none */
  emptyState: ReactNode;
  /** "N de M" + load more, below the rows */
  footer?: ReactNode;
  /** Above the rows (e.g. "load previous" after jumping to a page) */
  header?: ReactNode;
  /** Id of the scroll box, so the page can scroll it back to the top */
  scrollId?: string;
};

export function MusicTrackTable(props: Props) {
  const {
    tracks,
    options,
    openTrackId,
    onOpen,
    onOpenRelease,
    selectedIds,
    onToggleSelect,
    onToggleSelectAll,
    order,
    onOrderChange,
    emptyState,
    footer,
    header,
    scrollId,
  } = props;
  const { t, currentLocale } = useTranslation();

  if (tracks.length === 0) return <>{emptyState}</>;

  const allSelected = tracks.every((track) => selectedIds.includes(track.id));
  const date = (value: string | null) =>
    value ? (
      formatContractDate(value, currentLocale)
    ) : (
      <span className="text-placeholder">{t("music_catalog.list.not_scheduled")}</span>
    );
  const releaseTypeLabel = (value: string) =>
    options?.release_types.find(([key]) => key === value)?.[1] ?? value.replaceAll("_", " ");

  /** Header that sorts: ascending, then descending, then back to the default order */
  const sortHeader = (column: keyof typeof SORTS, label: string) => {
    const sort = SORTS[column];
    const direction = order === sort.asc ? "ascending" : order === sort.desc ? "descending" : "none";
    const next = direction === "none" ? sort.asc : direction === "ascending" ? sort.desc : DEFAULT_TRACK_ORDER;
    const Icon = direction === "ascending" ? ArrowUp : direction === "descending" ? ArrowDown : ArrowUpDown;
    return (
      <th className="px-3 py-2" aria-sort={direction}>
        <button
          type="button"
          onClick={() => onOrderChange(next)}
          className={cn(
            "-mx-1 inline-flex items-center gap-1 rounded-sm px-1 py-0.5 whitespace-nowrap hover:bg-layer-1-hover hover:text-secondary",
            direction !== "none" && "text-primary"
          )}
        >
          {label}
          <Icon className={cn("size-3", direction === "none" && "opacity-40")} aria-hidden />
        </button>
      </th>
    );
  };

  const onRowKey = (event: KeyboardEvent<HTMLElement>, track: TMusicTrack) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpen(track);
    }
  };

  const cover = (track: TMusicTrack, size: "sm" | "md") => (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden rounded-sm bg-accent-primary/10 text-accent-primary",
        size === "sm" ? "size-8" : "size-10"
      )}
    >
      {track.cover_url ? (
        <img src={track.cover_url} alt="" className="size-full object-cover" />
      ) : (
        <Music2 className="size-4" />
      )}
    </div>
  );

  const titleLine = (track: TMusicTrack) => (
    <p className="flex min-w-0 items-center gap-1.5">
      <span className="truncate font-medium">{track.title}</span>
      {track.version && <span className="shrink-0 text-11 text-tertiary">({track.version})</span>}
      {track.video_details.length > 0 && (
        <span
          className="inline-flex shrink-0 items-center gap-0.5 text-11 text-tertiary"
          title={t("music_catalog.list.videos", { count: track.video_details.length })}
        >
          <Video className="size-3" aria-hidden />
          <span className="sr-only">{t("music_catalog.list.videos", { count: track.video_details.length })}</span>
          <span aria-hidden>{track.video_details.length}</span>
        </span>
      )}
    </p>
  );

  const contractCell = (track: TMusicTrack) =>
    track.contract_count ? (
      <span className="inline-flex items-center gap-1 rounded-full bg-accent-primary/10 px-2 py-0.5 text-11 font-medium whitespace-nowrap text-accent-primary">
        <FileSignature className="size-3" aria-hidden />
        {t("music_catalog.list.contracts", { count: track.contract_count })}
      </span>
    ) : (
      <span className="text-12 text-placeholder">{t("music_catalog.list.no_contract")}</span>
    );

  const releaseCell = (track: TMusicTrack) => {
    const [first, ...rest] = track.release_details;
    if (!first) return <span className="text-placeholder">{t("music_catalog.list.no_release")}</span>;
    return (
      <div className="min-w-0">
        <p className="flex min-w-0 items-center gap-1">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onOpenRelease(first.id);
            }}
            className="truncate text-left underline-offset-2 hover:underline"
          >
            {first.title}
          </button>
          {rest.length > 0 && <span className="shrink-0 text-11 text-tertiary">+{rest.length}</span>}
        </p>
        {first.release_type && <p className="truncate text-11 text-tertiary">{releaseTypeLabel(first.release_type)}</p>}
      </div>
    );
  };

  return (
    <div id={scrollId} className="h-full overflow-auto">
      {header}
      {/* desktop table */}
      <table className="hidden w-full min-w-[900px] border-collapse text-left md:table">
        <thead className="sticky top-0 z-[1] bg-surface-1">
          <tr className="border-b border-subtle text-11 font-medium text-tertiary">
            <th className="w-10 px-4 py-2">
              <ContractSelectionCheckbox
                checked={allSelected}
                onChange={onToggleSelectAll}
                label={t("music_catalog.list.select_all")}
              />
            </th>
            {sortHeader("title", t("music_catalog.list.columns.song"))}
            <th className="px-3 py-2">{t("music_catalog.list.columns.release")}</th>
            {sortHeader("isrc", t("music_catalog.list.columns.isrc"))}
            {sortHeader("status", t("music_catalog.list.columns.status"))}
            {sortHeader("contract_count", t("music_catalog.list.columns.contract"))}
            {sortHeader("release_date", t("music_catalog.list.columns.release_date"))}
          </tr>
        </thead>
        <tbody>
          {tracks.map((track) => {
            const isOpen = openTrackId === track.id;
            const artists = artistNames(track);
            return (
              <tr
                key={track.id}
                tabIndex={0}
                aria-current={isOpen || undefined}
                onClick={() => onOpen(track)}
                onKeyDown={(event) => onRowKey(event, track)}
                className={cn(
                  "cursor-pointer border-b border-subtle text-13 outline-none hover:bg-layer-1-hover focus-visible:bg-layer-1-hover focus-visible:ring-1 focus-visible:ring-accent-strong focus-visible:ring-inset",
                  isOpen ? "bg-layer-1" : ""
                )}
              >
                <td className="px-4 py-2.5">
                  <ContractSelectionCheckbox
                    checked={selectedIds.includes(track.id)}
                    onChange={() => onToggleSelect(track.id)}
                    label={t("music_catalog.list.toggle", { title: track.title })}
                  />
                </td>
                <td className="max-w-80 px-2 py-2.5">
                  <div className="flex items-center gap-2.5">
                    {cover(track, "sm")}
                    <div className="min-w-0">
                      {titleLine(track)}
                      <p className={cn("truncate text-11", artists ? "text-tertiary" : "text-placeholder")}>
                        {artists || t("music_catalog.list.no_artist")}
                      </p>
                    </div>
                  </div>
                </td>
                <td className="max-w-56 px-3 py-2.5 text-12">{releaseCell(track)}</td>
                <td className="px-3 py-2.5 whitespace-nowrap">
                  {track.isrc ? (
                    <code className="font-mono text-11 text-secondary">{track.isrc}</code>
                  ) : (
                    <span className="text-placeholder">—</span>
                  )}
                </td>
                <td className="px-3 py-2.5 whitespace-nowrap">
                  <TrackStatusPill status={track.status} />
                </td>
                <td className="px-3 py-2.5 whitespace-nowrap">{contractCell(track)}</td>
                <td className="px-3 py-2.5 text-12 whitespace-nowrap tabular-nums">{date(track.release_date)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* mobile cards: a stretched button opens the song; the checkbox sits above it */}
      <ul className="space-y-2 p-3 md:hidden">
        {tracks.map((track) => {
          const artists = artistNames(track);
          return (
            <li
              key={track.id}
              className={cn(
                "relative rounded-lg border border-subtle p-3 focus-within:ring-1 focus-within:ring-accent-strong",
                openTrackId === track.id ? "border-accent-strong" : ""
              )}
            >
              <button
                type="button"
                onClick={() => onOpen(track)}
                aria-label={track.title}
                className="absolute inset-0 rounded-lg outline-none"
              />
              <div className="pointer-events-none relative flex items-start gap-2.5">
                <span className="pointer-events-auto mt-0.5">
                  <ContractSelectionCheckbox
                    checked={selectedIds.includes(track.id)}
                    onChange={() => onToggleSelect(track.id)}
                    label={t("music_catalog.list.toggle", { title: track.title })}
                  />
                </span>
                {cover(track, "md")}
                <div className="min-w-0 flex-1 text-13">
                  {titleLine(track)}
                  <p className={cn("mt-0.5 truncate text-11", artists ? "text-tertiary" : "text-placeholder")}>
                    {artists || t("music_catalog.list.no_artist")}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5 text-11">
                    <TrackStatusPill status={track.status} />
                    <span className="rounded-full bg-layer-1 px-2 py-0.5 text-tertiary tabular-nums">
                      {date(track.release_date)}
                    </span>
                    {track.isrc && (
                      <code className="font-mono rounded-full bg-layer-1 px-2 py-0.5 text-tertiary">{track.isrc}</code>
                    )}
                    {!!track.contract_count && (
                      <span className="rounded-full bg-accent-primary/10 px-2 py-0.5 text-accent-primary">
                        {t("music_catalog.list.contracts", { count: track.contract_count })}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      {footer}
    </div>
  );
}
