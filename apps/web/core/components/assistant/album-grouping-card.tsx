/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * Card for `propose_album_grouping`: the albums the assistant read from a
 * list or a file, each with the release that will hold it (an existing one
 * or a new album), the duplicate releases to merge into it and the catalog
 * song for every track. Ambiguous tracks pick among their candidates; tracks
 * the catalog lacks can be added as draft songs. Nothing is written until the
 * user applies, with their own session, in one all-or-nothing request.
 */

import { useState } from "react";
import { makeAssistantToolUI } from "@assistant-ui/react";
import { Check, Disc3, X } from "lucide-react";
import { useParams } from "react-router";
import { mutate as mutateGlobal } from "swr";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TMusicReleaseGroupAlbum, TMusicReleaseGroupSummary } from "@plane/types";
import { cn } from "@plane/utils";
import { musicService } from "@/services/music.service";
import { CARD, FIELD, errorText, useOutcome } from "./action-cards";
import { AssistantLink } from "./links";
import { TraceLine } from "./steps";

type TSong = {
  id?: string;
  track_id: string;
  title: string;
  version?: string | null;
  isrc?: string | null;
  artists?: string[];
  confidence?: number;
  match_type?: string;
  releases?: { id: string; title: string }[];
  path?: string;
};

type TCandidate = {
  id: string;
  title: string;
  version?: string | null;
  upc?: string | null;
  release_date?: string | null;
  artists?: string[];
  track_count: number;
  match_type: "upc" | "title_artist" | "title" | "edition" | "contained" | string;
  same_title_artist: boolean;
  path?: string;
};

type TTrack = {
  index: number;
  input: { title?: string; isrc?: string | null; artists?: string[]; duration?: string | null };
  disc_number: number;
  track_number: number;
  match: TSong | null;
  candidates: TSong[];
  ambiguous: boolean;
};

type TAlbum = {
  index: number;
  album: {
    title: string;
    artists?: string[];
    upc?: string | null;
    type?: string | null;
    release_date?: string | null;
  };
  release_candidates: TCandidate[];
  suggested_target_id: string | null;
  tracks: TTrack[];
};

type TProposal = {
  albums?: TAlbum[];
  workspace_slug?: string;
  error?: string;
};

const RELEASE_MATCHES = new Set(["upc", "title_artist", "title", "edition", "contained"]);

/** Target value for "create a new album" */
const NEW = "__new__";
/** Track choices besides a song id */
const CREATE = "__create__";
const SKIP = "__skip__";

type TAlbumState = {
  include: boolean;
  target: string;
  merge: string[];
  /** Per track: a song id, CREATE or SKIP */
  choices: string[];
};

const initialState = (album: TAlbum): TAlbumState => {
  const target = album.suggested_target_id ?? NEW;
  return {
    include: true,
    target,
    merge: album.release_candidates
      .filter((candidate) => candidate.same_title_artist && candidate.id !== target)
      .map((candidate) => candidate.id),
    // The best match is preselected, ambiguous ones included (they are
    // ordered: songs already in one of the album's releases first)
    choices: album.tracks.map((track) => track.match?.track_id ?? SKIP),
  };
};

const songLabel = (song: TSong) =>
  [song.version ? `${song.title} (${song.version})` : song.title, song.artists?.join(", "), song.releases?.[0]?.title]
    .filter(Boolean)
    .join(" · ");

const refreshMusic = () =>
  mutateGlobal((key) => {
    const head = Array.isArray(key) ? String(key[0]) : typeof key === "string" ? key : "";
    return head.startsWith("MUSIC_TRACKS") || head.startsWith("MUSIC_RELEASES");
  });

/** What one album sends, or null when it would change nothing */
function albumPayload(album: TAlbum, state: TAlbumState): TMusicReleaseGroupAlbum | null {
  if (!state.include) return null;
  const merge = state.merge.filter((id) => id !== state.target);
  const seen = new Set<string>();
  const tracks: NonNullable<TMusicReleaseGroupAlbum["tracks"]> = [];
  const creates: NonNullable<TMusicReleaseGroupAlbum["create_tracks"]> = [];
  album.tracks.forEach((track, index) => {
    const choice = state.choices[index];
    if (!choice || choice === SKIP) return;
    if (choice === CREATE) {
      creates.push({
        title: track.input.title ?? "",
        isrc: track.input.isrc ?? undefined,
        artists: track.input.artists?.length ? track.input.artists : album.album.artists,
        disc_number: track.disc_number,
        track_number: track.track_number,
      });
      return;
    }
    if (seen.has(choice)) return;
    seen.add(choice);
    tracks.push({ track_id: choice, disc_number: track.disc_number, track_number: track.track_number });
  });
  if (!tracks.length && !creates.length && !merge.length) return null;
  const target: TMusicReleaseGroupAlbum["target"] =
    state.target === NEW
      ? {
          create: {
            title: album.album.title,
            artists: album.album.artists,
            upc: album.album.upc ?? undefined,
            type: album.album.type ?? undefined,
            release_date: album.album.release_date ?? undefined,
          },
        }
      : { release_id: state.target };
  return { target, merge_release_ids: merge, tracks, create_tracks: creates, remove_empty_merged: true };
}

function AlbumBlock({
  album,
  state,
  onChange,
  locked,
  showToggle,
}: {
  album: TAlbum;
  state: TAlbumState;
  onChange: (next: TAlbumState) => void;
  locked: boolean;
  showToggle: boolean;
}) {
  const { t } = useTranslation();
  const candidates = album.release_candidates;
  const target = candidates.find((candidate) => candidate.id === state.target);
  const others = candidates.filter((candidate) => candidate.id !== state.target);
  const songs = state.choices.filter((choice) => choice !== SKIP).length;
  const merging = state.merge.filter((id) => id !== state.target).length;
  const disabled = locked || !state.include;
  const matchLabel = (candidate: TCandidate) =>
    RELEASE_MATCHES.has(candidate.match_type) ? t(`assistant.album_grouping.match.${candidate.match_type}`) : "";
  const setChoice = (index: number, choice: string) =>
    onChange({ ...state, choices: state.choices.map((value, position) => (position === index ? choice : value)) });

  return (
    <div className={cn("rounded-md border border-subtle p-2", !state.include && "opacity-60")}>
      <div className="flex items-center gap-2">
        {showToggle && (
          <input
            type="checkbox"
            className="accent-accent-primary"
            checked={state.include}
            disabled={locked}
            onChange={() => onChange({ ...state, include: !state.include })}
            aria-label={album.album.title}
          />
        )}
        <Disc3 className="size-3.5 shrink-0 text-tertiary" aria-hidden />
        <p className="min-w-0 flex-1 truncate text-12 font-medium text-primary">{album.album.title}</p>
        {album.album.artists?.length ? (
          <span className="max-w-[40%] shrink-0 truncate text-11 text-tertiary">{album.album.artists.join(", ")}</span>
        ) : null}
      </div>

      {/* Target */}
      <label className="mt-2 block text-11 text-tertiary">
        {t("assistant.album_grouping.target")}
        <select
          className={cn(FIELD, "mt-0.5")}
          value={state.target}
          disabled={disabled}
          onChange={(event) =>
            onChange({
              ...state,
              target: event.target.value,
              merge: state.merge.filter((id) => id !== event.target.value),
            })
          }
        >
          {candidates.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {t("assistant.album_grouping.target_existing", {
                title: candidate.title,
                count: candidate.track_count,
              })}
              {candidate.id === album.suggested_target_id ? ` · ${t("assistant.album_grouping.suggested")}` : ""}
            </option>
          ))}
          <option value={NEW}>{t("assistant.album_grouping.target_new", { title: album.album.title })}</option>
        </select>
      </label>
      {target?.path && (
        <AssistantLink href={target.path} className="mt-0.5 inline-block text-11">
          {t("assistant.album_grouping.open_release")}
        </AssistantLink>
      )}

      {/* Duplicates */}
      {others.length > 0 && (
        <div className="mt-2">
          <p className="text-11 text-tertiary">{t("assistant.album_grouping.merge_title")}</p>
          <ul className="mt-0.5 max-h-40 space-y-0.5 overflow-y-auto">
            {others.map((candidate) => {
              const checked = state.merge.includes(candidate.id);
              return (
                <li key={candidate.id} className="flex items-center gap-2 px-1 py-0.5 text-12">
                  <input
                    type="checkbox"
                    className="accent-accent-primary"
                    checked={checked}
                    disabled={disabled}
                    onChange={() =>
                      onChange({
                        ...state,
                        merge: checked
                          ? state.merge.filter((id) => id !== candidate.id)
                          : [...state.merge, candidate.id],
                      })
                    }
                    aria-label={candidate.title}
                  />
                  <span className="min-w-0 flex-1">
                    {candidate.path ? (
                      <AssistantLink href={candidate.path} className="block truncate">
                        {candidate.title}
                      </AssistantLink>
                    ) : (
                      <span className="block truncate">{candidate.title}</span>
                    )}
                    <span className="block truncate text-11 text-tertiary">
                      {[
                        t("assistant.album_grouping.songs", { count: candidate.track_count }),
                        matchLabel(candidate),
                        candidate.upc ? `UPC ${candidate.upc}` : "",
                        candidate.release_date ?? "",
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Tracklist */}
      {album.tracks.length > 0 && (
        <ul className="mt-2 max-h-72 space-y-0.5 overflow-y-auto">
          {album.tracks.map((track, index) => {
            const choice = state.choices[index] ?? SKIP;
            const number = `${track.disc_number > 1 ? `${track.disc_number}-` : ""}${track.track_number}`;
            const chosen =
              track.match?.track_id === choice
                ? track.match
                : track.candidates.find((candidate) => candidate.track_id === choice);
            return (
              <li
                key={`${track.index}:${track.input.title ?? ""}`}
                className="flex items-start gap-2 px-1 py-0.5 text-12"
              >
                <span className="w-7 shrink-0 pt-0.5 text-right text-11 text-tertiary tabular-nums">{number}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-primary">{track.input.title || track.input.isrc}</span>
                  {track.match && track.ambiguous ? (
                    <>
                      <select
                        className={cn(FIELD, "mt-0.5 py-1 text-11")}
                        value={choice}
                        disabled={disabled}
                        onChange={(event) => setChoice(index, event.target.value)}
                        aria-label={track.input.title}
                      >
                        {track.candidates.map((candidate) => (
                          <option key={candidate.track_id} value={candidate.track_id}>
                            {songLabel(candidate)}
                          </option>
                        ))}
                        <option value={SKIP}>{t("assistant.album_grouping.skip")}</option>
                      </select>
                      <span className="block text-11 text-warning-primary">
                        {t("assistant.album_grouping.ambiguous", { count: track.candidates.length })}
                      </span>
                    </>
                  ) : track.match ? (
                    <span className="flex min-w-0 items-center gap-1.5 text-11 text-tertiary">
                      <input
                        type="checkbox"
                        className="accent-accent-primary"
                        checked={choice !== SKIP}
                        disabled={disabled}
                        onChange={() => setChoice(index, choice === SKIP ? track.match!.track_id : SKIP)}
                        aria-label={track.input.title}
                      />
                      <span aria-hidden>→</span>
                      {track.match.path ? (
                        <AssistantLink href={track.match.path} className="truncate">
                          {track.match.version ? `${track.match.title} (${track.match.version})` : track.match.title}
                        </AssistantLink>
                      ) : (
                        <span className="truncate">{track.match.title}</span>
                      )}
                      <span className="shrink-0">
                        {track.match.match_type === "isrc"
                          ? "ISRC"
                          : track.match.match_type === "title_artist"
                            ? t("assistant.album_grouping.track_match.title_artist")
                            : t("assistant.album_grouping.track_match.title")}
                      </span>
                    </span>
                  ) : (
                    <label className="flex cursor-pointer items-center gap-1.5 text-11 text-tertiary">
                      <input
                        type="checkbox"
                        className="accent-accent-primary"
                        checked={choice === CREATE}
                        disabled={disabled}
                        onChange={() => setChoice(index, choice === CREATE ? SKIP : CREATE)}
                      />
                      {t("assistant.album_grouping.not_found_create")}
                    </label>
                  )}
                  {chosen && track.ambiguous && chosen.path && (
                    <AssistantLink href={chosen.path} className="text-11">
                      {t("assistant.album_grouping.open_song")}
                    </AssistantLink>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {state.include && (
        <p className="mt-2 text-11 text-secondary">
          {t("assistant.album_grouping.album_summary", {
            songs,
            title: target?.title ?? album.album.title,
            merged: merging,
          })}
        </p>
      )}
    </div>
  );
}

function AlbumGroupingForm({ proposal, toolCallId, slug }: { proposal: TProposal; toolCallId: string; slug: string }) {
  const { t } = useTranslation();
  const albums = proposal.albums ?? [];
  const [outcome, remember] = useOutcome(`assistant-album-grouping:${toolCallId}`);
  const [states, setStates] = useState<TAlbumState[]>(() => albums.map(initialState));
  const busy = outcome.state === "busy";
  const done = outcome.state !== "idle" && outcome.state !== "busy";
  const payload = albums
    .map((album, index) => (states[index] ? albumPayload(album, states[index]) : null))
    .filter((item): item is TMusicReleaseGroupAlbum => Boolean(item));

  const apply = async () => {
    remember({ state: "busy" });
    try {
      const response = await musicService.groupReleases(slug, payload);
      remember({ state: "applied", result: { albums: response.albums } });
      void refreshMusic();
    } catch (error) {
      remember({ state: "idle" });
      setToast({ type: TOAST_TYPE.ERROR, title: errorText(error, t("assistant.actions.failed")) });
    }
  };

  const applied = (outcome.result?.albums as TMusicReleaseGroupSummary[] | undefined) ?? [];
  return (
    <div className={CARD}>
      <div className="flex items-center gap-2">
        <Disc3 className="size-4 shrink-0 text-tertiary" aria-hidden />
        <p className="min-w-0 flex-1 truncate text-13 font-medium text-primary">
          {t("assistant.album_grouping.title", { count: albums.length })}
        </p>
      </div>
      {outcome.state === "applied" ? (
        <ul className="mt-2 space-y-1">
          {applied.map((album) => (
            <li key={album.target.id} className="flex min-w-0 items-center gap-1.5 text-12 text-success-primary">
              <Check className="size-3.5 shrink-0" />
              <span className="min-w-0 truncate">
                {t("assistant.album_grouping.applied", {
                  title: album.target.title,
                  songs: album.total_tracks,
                  merged: album.merged_releases.length,
                })}
              </span>
              <AssistantLink href={album.target.path} className="shrink-0 text-12">
                {t("assistant.actions.open")}
              </AssistantLink>
            </li>
          ))}
        </ul>
      ) : (
        <div className="mt-2 space-y-2">
          {albums.map((album, index) =>
            states[index] ? (
              <AlbumBlock
                key={`${album.index}:${album.album.title}`}
                album={album}
                state={states[index]}
                locked={busy || done}
                showToggle={albums.length > 1}
                onChange={(next) =>
                  setStates((current) => current.map((value, position) => (position === index ? next : value)))
                }
              />
            ) : null
          )}
        </div>
      )}
      {outcome.state === "discarded" ? (
        <p className="mt-2.5 flex items-center gap-1.5 text-12 text-tertiary">
          <X className="size-3.5" />
          {t("assistant.actions.discarded")}
        </p>
      ) : outcome.state !== "applied" ? (
        <div className="mt-2.5 flex justify-end gap-1.5">
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => remember({ state: "discarded" })}>
            {t("assistant.actions.discard")}
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={busy}
            disabled={payload.length === 0}
            onClick={() => void apply()}
          >
            {t("assistant.album_grouping.apply", { count: payload.length })}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export const AlbumGroupingCard = makeAssistantToolUI<Record<string, unknown>, TProposal>({
  toolName: "propose_album_grouping",
  render: function AlbumGroupingRender({ result, status, toolCallId }) {
    const { t } = useTranslation();
    const { workspaceSlug } = useParams();
    if (status.type === "running" || !result) {
      return <TraceLine live icon={Disc3} label={t("assistant.steps.propose_album_grouping.running")} />;
    }
    const slug = result.workspace_slug ?? (workspaceSlug ? String(workspaceSlug) : "");
    if (result.error || !slug) {
      return <p className="text-12 text-tertiary">{result.error ?? t("assistant.actions.failed")}</p>;
    }
    if (!result.albums?.length) {
      return <p className="text-12 text-tertiary">{t("assistant.album_grouping.none")}</p>;
    }
    return <AlbumGroupingForm proposal={result} toolCallId={toolCallId} slug={slug} />;
  },
});
