/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * "Unir con otro lanzamiento…" from the release panel: an earlier import made
 * one release per row when the file had no UPC, so the same album can exist
 * several times with a song each. Pick the other copies (the ones with the
 * same title and artist come first, with their song counts), see what will
 * move, and merge: their songs, empty fields, contract links and tags pass
 * to this release and the emptied copies are removed — in one request.
 */

import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { Loader2, Search } from "lucide-react";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TMusicRelease, TMusicReleaseGroupSummary } from "@plane/types";
import { Checkbox, EModalPosition, EModalWidth, ModalCore } from "@plane/ui";
import { musicService } from "@/services/music.service";
import { getApiError } from "./shared";

type Props = {
  workspaceSlug: string;
  release: TMusicRelease;
  isOpen: boolean;
  onClose: () => void;
  /** After merging: refresh releases and songs */
  onMerged: () => void;
};

// Same rule as the server's album_key: no accents or case, and no edition
// suffix ("(Deluxe)", "- Remastered"); "(En vivo)" stays another album.
const EDITION =
  /\b(deluxe|edition|edicion|expanded|expandida|expandido|remaster|remastered|remasterizado|remasterizada|special|especial|anniversary|aniversario|bonus|version|explicit|clean|reissue|reedicion)\b/;
const fold = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
const words = (value: string) =>
  value
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");

export function albumKey(title: string): string {
  let text = fold(title || "").replace(/[([]([^)\]]*)[)\]]/g, (group: string, inner: string) =>
    EDITION.test(inner) ? " " : group
  );
  const tail = /\s[-–—:]\s(.*)$/.exec(text);
  if (tail && EDITION.test(tail[1])) text = text.slice(0, tail.index);
  text = text
    .replace(/[([]\s*(?:feat\.?|ft\.?|featuring|con|with)\s[^)\]]*[)\]]/g, " ")
    .replace(/\s(?:feat\.?|ft\.?|featuring)\s.*$/, " ");
  return words(text);
}

const artistKeys = (release: TMusicRelease) => release.artist_details.map((artist) => words(fold(artist.name)));
const sameArtists = (a: TMusicRelease, b: TMusicRelease) => {
  const left = artistKeys(a);
  const right = artistKeys(b);
  return !left.length || !right.length || left.some((name) => right.includes(name));
};

export function MusicReleaseMergeModal({ workspaceSlug, release, isOpen, onClose, onMerged }: Props) {
  const { t } = useTranslation();
  const { data: releases = [], isLoading } = useSWR(isOpen ? ["MUSIC_RELEASES", workspaceSlug] : null, () =>
    musicService.getReleases(workspaceSlug)
  );
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [preview, setPreview] = useState<TMusicReleaseGroupSummary | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [merging, setMerging] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      setQuery("");
      setSelected([]);
      setPreview(null);
    }
  }, [isOpen]);

  // Copies of this album first (same title without edition, same artist)
  const { duplicates, others } = useMemo(() => {
    const key = albumKey(release.title);
    const rest = releases.filter((item) => item.id !== release.id);
    const dupes = rest
      .filter((item) => key && albumKey(item.title) === key && sameArtists(item, release))
      .sort(
        (a, b) => (b.track_count ?? 0) - (a.track_count ?? 0) || (a.created_at ?? "").localeCompare(b.created_at ?? "")
      );
    const dupeIds = new Set(dupes.map((item) => item.id));
    const search = words(fold(query));
    const found = search
      ? rest
          .filter((item) => !dupeIds.has(item.id))
          .filter((item) =>
            words(fold([item.title, item.upc, ...item.artist_details.map((artist) => artist.name)].join(" "))).includes(
              search
            )
          )
          .slice(0, 50)
      : [];
    return { duplicates: dupes, others: found };
  }, [releases, release, query]);

  // A dry run of the merge: what would move, exactly
  useEffect(() => {
    if (!isOpen || selected.length === 0) {
      setPreview(null);
      return;
    }
    let active = true;
    setPreviewing(true);
    const timer = setTimeout(() => {
      musicService
        .groupReleases(workspaceSlug, [{ target: { release_id: release.id }, merge_release_ids: selected }], true)
        .then((result) => {
          if (active) setPreview(result.albums[0] ?? null);
          return undefined;
        })
        .catch(() => {
          if (active) setPreview(null);
        })
        .finally(() => {
          if (active) setPreviewing(false);
        });
    }, 300);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [isOpen, selected, workspaceSlug, release.id]);

  const toggle = (id: string) =>
    setSelected((current) => (current.includes(id) ? current.filter((value) => value !== id) : [...current, id]));

  const merge = async () => {
    setMerging(true);
    try {
      const result = await musicService.groupReleases(workspaceSlug, [
        { target: { release_id: release.id }, merge_release_ids: selected, remove_empty_merged: true },
      ]);
      const summary = result.albums[0];
      setToast({
        type: TOAST_TYPE.SUCCESS,
        title: t("music_catalog.release_merge.done", {
          count: summary?.merged_releases.length ?? selected.length,
          songs: summary?.tracks_moved ?? 0,
        }),
      });
      onMerged();
      onClose();
    } catch (error) {
      setToast({ type: TOAST_TYPE.ERROR, title: t("music_catalog.release_merge.failed"), message: getApiError(error) });
    } finally {
      setMerging(false);
    }
  };

  const fallbackSongs = releases
    .filter((item) => selected.includes(item.id))
    .reduce((sum, item) => sum + (item.track_count ?? 0), 0);
  const songs = preview ? preview.tracks_moved : fallbackSongs;

  const row = (item: TMusicRelease) => {
    const id = `music-release-merge-${item.id}`;
    return (
      <li key={item.id} className="flex min-w-0 items-center gap-2 rounded-sm px-1 py-1 hover:bg-layer-1-hover">
        <Checkbox id={id} checked={selected.includes(item.id)} onChange={() => toggle(item.id)} />
        <label htmlFor={id} className="flex min-w-0 flex-1 cursor-pointer flex-col text-12">
          <span className="truncate text-primary" title={item.title}>
            {item.title}
            {item.version && <span className="text-tertiary"> ({item.version})</span>}
          </span>
          <span className="truncate text-11 text-tertiary">
            {[
              t("music_catalog.release_merge.songs", { count: item.track_count ?? 0 }),
              item.artist_details.map((artist) => artist.name).join(", "),
              item.upc ? `UPC ${item.upc}` : "",
              item.release_date ?? "",
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </label>
      </li>
    );
  };

  return (
    <ModalCore
      isOpen={isOpen}
      handleClose={() => !merging && onClose()}
      position={EModalPosition.TOP}
      width={EModalWidth.XXL}
    >
      <div className="flex max-h-[80vh] flex-col">
        <div className="shrink-0 border-b border-subtle px-4 py-3">
          <h3 className="text-14 font-medium text-primary">
            {t("music_catalog.release_merge.title", { title: release.title })}
          </h3>
          <p className="mt-0.5 text-12 text-tertiary">{t("music_catalog.release_merge.subtitle")}</p>
          <div className="relative mt-2">
            <Search className="absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-tertiary" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("music_catalog.release_merge.search")}
              aria-label={t("music_catalog.release_merge.search")}
              className="w-full rounded-md border border-subtle bg-transparent py-1.5 pr-2 pl-7 text-12 outline-none focus:border-accent-strong"
            />
          </div>
        </div>

        <div className="vertical-scrollbar min-h-40 flex-1 overflow-y-auto p-4">
          {isLoading && !releases.length ? (
            <p className="flex items-center justify-center gap-2 py-10 text-12 text-tertiary">
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
              {t("common.loading")}
            </p>
          ) : (
            <>
              <p className="mb-1 text-11 font-semibold tracking-wide text-tertiary uppercase">
                {t("music_catalog.release_merge.duplicates", { count: duplicates.length })}
              </p>
              {duplicates.length ? (
                <ul className="space-y-0.5">{duplicates.map(row)}</ul>
              ) : (
                <p className="px-1 text-12 text-placeholder">{t("music_catalog.release_merge.no_duplicates")}</p>
              )}
              {query.trim() && (
                <>
                  <p className="mt-3 mb-1 text-11 font-semibold tracking-wide text-tertiary uppercase">
                    {t("music_catalog.release_merge.others")}
                  </p>
                  {others.length ? (
                    <ul className="space-y-0.5">{others.map(row)}</ul>
                  ) : (
                    <p className="px-1 text-12 text-placeholder">{t("music_catalog.release_merge.no_matches")}</p>
                  )}
                </>
              )}
            </>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2 border-t border-subtle px-4 py-3">
          <p className="min-w-0 flex-1 text-12 text-secondary">
            {selected.length > 0 && (
              <>
                {previewing && <Loader2 className="mr-1 inline size-3 animate-spin text-tertiary" aria-hidden />}
                {t("music_catalog.release_merge.preview", { songs, count: selected.length })}
                {preview?.metadata_copied.length
                  ? ` ${t("music_catalog.release_merge.metadata", { fields: preview.metadata_copied.join(", ") })}`
                  : ""}
              </>
            )}
          </p>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={merging}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={merging}
            disabled={selected.length === 0}
            onClick={() => void merge()}
          >
            {t("music_catalog.release_merge.apply", { count: selected.length })}
          </Button>
        </div>
      </div>
    </ModalCore>
  );
}
