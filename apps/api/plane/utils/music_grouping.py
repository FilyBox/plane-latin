# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Group songs into albums, and merge releases that are really one album.

An earlier import created one release per row when the file had no UPC, so
the same album can exist several times with a song each. Two halves:

- `match_albums` (read-only): for a list of albums with their tracklists
  (typed by the user or read from a PDF by the assistant), the releases that
  already hold each album — every duplicate with the same title and artist,
  with its song count — a suggested target, and the catalog song for every
  track (ISRC, then title + artist, then title), ambiguous ones with their
  candidates. Nothing is written.
- `apply_grouping` (one transaction): links the chosen songs to the target
  with their numbers, moves the songs of the releases being merged into it,
  fills the target's empty fields from them, re-points their contract links
  and tags, and soft-deletes the merged releases left empty. Only releases
  the request names are touched. A dry run does the same and rolls back.
"""

import re
import uuid

from django.db.models import Count, Q
from django.utils import timezone

from plane.db.models import (
    ContractWorkLink,
    EntityTagLink,
    MusicCredit,
    MusicDistribution,
    MusicLink,
    MusicRelease,
    MusicReleaseArtist,
    MusicReleaseTrack,
    MusicTrack,
)
from plane.utils.contract_works import (
    _artists_by_track,
    _match_isrcs,
    artists_overlap,
    fold,
    normalize_isrc,
    normalize_title,
    normalize_upc,
    split_artists,
)
from plane.utils.music_release_types import release_type_value

MAX_ALBUMS = 50
MAX_TRACKS = 300
MAX_CANDIDATES = 3

# Words that mark an edition of the same album: "(Deluxe)", "[Remastered
# 2020]", "- Edición Especial". "En vivo" or "Acústico" are other albums.
_EDITION_WORDS = (
    "deluxe",
    "edition",
    "edicion",
    "expanded",
    "expandida",
    "expandido",
    "remaster",
    "remastered",
    "remasterizado",
    "remasterizada",
    "special",
    "especial",
    "anniversary",
    "aniversario",
    "bonus",
    "version",
    "explicit",
    "clean",
    "reissue",
    "reedicion",
)
_EDITION = re.compile(r"\b(?:" + "|".join(_EDITION_WORDS) + r")\b")
_GROUP = re.compile(r"[\(\[]([^\)\]]*)[\)\]]")
_DASH_TAIL = re.compile(r"\s[-–—:]\s(.*)$")

# Release fields filled from a merged release when the target's is empty
COPY_FIELDS = (
    "upc",
    "ean",
    "catalog_number",
    "release_date",
    "original_release_date",
    "copyright_year",
    "p_line",
    "c_line",
    "label_name",
    "language",
    "cover_url",
)


class GroupingError(Exception):
    """A request that can't be applied as given (unknown id, bad shape)."""


# ----------------------------------------------------------- normalization


def album_key(title):
    """Title without its edition suffix: "Album (Deluxe Edition)" and
    "Album - Remastered" are both "album"."""
    text = fold(title)
    text = _GROUP.sub(lambda match: " " if _EDITION.search(match.group(1)) else match.group(0), text)
    tail = _DASH_TAIL.search(text)
    if tail and _EDITION.search(tail.group(1)):
        text = text[: tail.start()]
    return normalize_title(text)


def release_path(slug, release_id):
    return f"/{slug}/music?release={release_id}"


def track_path(slug, track_id):
    return f"/{slug}/music?track={track_id}"


def _text(value, limit=500):
    return str(value or "").strip()[:limit]


def _names(value):
    """Artist names as given (a list or "A, B")."""
    if isinstance(value, (list, tuple)):
        raw = [str(item.get("name") or "") if isinstance(item, dict) else str(item) for item in value]
    else:
        raw = re.split(r"\s*[,;]\s*", str(value or ""))
    return [name.strip()[:255] for name in raw if name and name.strip()][:20]


def _number(value):
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    return number if 1 <= number <= 999 else None


def _iso(value):
    return value.isoformat() if value else None


def _parse_date(value):
    if not value:
        return None
    from plane.app.views.music.base import _date

    return _date(value)


def _uuid(value, field):
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError, AttributeError):
        raise GroupingError(f"{field}: invalid id {value!r}")


# ---------------------------------------------------------------- matching


def _live_track_counts(release_ids):
    rows = (
        MusicRelease.objects.filter(id__in=release_ids)
        .annotate(
            live_tracks=Count(
                "track_links",
                filter=Q(track_links__deleted_at__isnull=True, track_links__track__deleted_at__isnull=True),
                distinct=True,
            )
        )
        .values_list("id", "live_tracks")
    )
    return dict(rows)


def _release_artists(release_ids):
    """Release id -> artist names; releases without their own artists fall
    back to the primary artists of their songs."""
    names = {}
    for release_id, name in MusicReleaseArtist.objects.filter(release_id__in=release_ids).values_list(
        "release_id", "party__display_name"
    ):
        names.setdefault(release_id, []).append(name)
    missing = [release_id for release_id in release_ids if release_id not in names]
    if missing:
        rows = MusicCredit.objects.filter(
            track__release_links__release_id__in=missing,
            track__release_links__deleted_at__isnull=True,
            role=MusicCredit.Role.PRIMARY_ARTIST,
        ).values_list("track__release_links__release_id", "party__display_name")
        for release_id, name in rows:
            names.setdefault(release_id, [])
            if name not in names[release_id]:
                names[release_id].append(name)
    return {key: list(dict.fromkeys(value)) for key, value in names.items()}


def _track_releases(track_ids):
    """Song id -> its current releases [{id, title}]."""
    result = {}
    rows = (
        MusicReleaseTrack.objects.filter(track_id__in=track_ids, release__deleted_at__isnull=True)
        .order_by("release__release_date", "release__created_at")
        .values_list("track_id", "release_id", "release__title")
    )
    for track_id, release_id, title in rows:
        result.setdefault(track_id, []).append({"id": str(release_id), "title": title})
    return result


def _clean_album(raw):
    if not isinstance(raw, dict):
        return None
    title = _text(raw.get("title") or raw.get("titulo"))
    tracks = []
    for position, item in enumerate((raw.get("tracks") or [])[:MAX_TRACKS]):
        if isinstance(item, str):
            item = {"title": item}
        if not isinstance(item, dict):
            continue
        track_title = _text(item.get("title") or item.get("titulo"))
        isrc = normalize_isrc(item.get("isrc"))
        if not track_title and not isrc:
            continue
        tracks.append(
            {
                "position": position,
                "title": track_title,
                "isrc": isrc,
                "artists": _names(item.get("artists", item.get("artistas"))),
                "disc_number": _number(item.get("disc_number")),
                "track_number": _number(item.get("track_number")),
                "duration": _text(item.get("duration"), 20) or None,
            }
        )
    if not title and not tracks:
        return None
    return {
        "title": title,
        "artists": _names(raw.get("artists", raw.get("artistas"))),
        "upc": normalize_upc(raw.get("upc")),
        "upc_raw": re.sub(r"\D", "", str(raw.get("upc") or ""))[:32],
        "type": release_type_value(raw.get("type")) if raw.get("type") else None,
        "release_date": _iso(_parse_date(raw.get("release_date"))),
        "tracks": tracks,
    }


def _number_tracks(tracks):
    """Disc 1 and the list order when the source gave no numbers."""
    counters = {}
    for track in tracks:
        disc = track["disc_number"] or 1
        counters[disc] = counters.get(disc, 0) + 1
        track["disc_number"] = disc
        track["track_number"] = track["track_number"] or counters[disc]


def match_albums(workspace_id, slug, albums):
    """Proposal for grouping songs into albums. Writes nothing."""
    cleaned = [album for album in (_clean_album(raw) for raw in (albums or [])[:MAX_ALBUMS]) if album]
    if not cleaned:
        return []

    releases = list(
        MusicRelease.objects.filter(workspace_id=workspace_id).values_list(
            "id", "title", "version", "upc", "release_date", "release_type", "created_at"
        )
    )
    by_key = {}
    for row in releases:
        by_key.setdefault(album_key(row[1]), []).append(row)
    release_rows = {row[0]: row for row in releases}

    songs = list(
        MusicTrack.objects.filter(workspace_id=workspace_id, parent_track__isnull=True).values_list(
            "id", "title", "version", "isrc", "created_at"
        )
    )
    song_rows = {row[0]: row for row in songs}
    by_title = {}
    for row in songs:
        keys = {normalize_title(row[1])}
        if row[2]:
            keys.add(normalize_title(f"{row[1]} {row[2]}"))
        for key in keys:
            if key:
                by_title.setdefault(key, []).append(row[0])

    isrc_hits = _match_isrcs(
        workspace_id, {track["isrc"] for album in cleaned for track in album["tracks"] if track["isrc"]}
    )

    # Candidate releases per album (UPC, then title), artists in one query
    plans = []
    release_ids = set()
    track_ids = set(isrc_hits.values())
    for album in cleaned:
        _number_tracks(album["tracks"])
        candidates = {}
        if album["upc"]:
            for row in releases:
                if normalize_upc(row[3]) == album["upc"]:
                    candidates[row[0]] = "upc"
        key = album_key(album["title"])
        if key:
            for row in by_key.get(key, []):
                candidates.setdefault(row[0], "title")
        release_ids.update(candidates)
        for track in album["tracks"]:
            if not (track["isrc"] and track["isrc"] in isrc_hits) and track["title"]:
                track_ids.update(by_title.get(normalize_title(track["title"]), []))
        plans.append({"album": album, "candidates": candidates})

    track_artists = _artists_by_track(list(track_ids)) if track_ids else {}
    current_releases = _track_releases(list(track_ids)) if track_ids else {}
    # Releases the matched songs sit in may be fragments of the album too
    release_ids.update(uuid.UUID(item["id"]) for releases_of in current_releases.values() for item in releases_of)
    release_artists = _release_artists(list(release_ids)) if release_ids else {}
    counts = _live_track_counts(list(release_ids)) if release_ids else {}

    results = []
    for index, plan in enumerate(plans):
        album = plan["album"]
        wanted = split_artists(album["artists"])
        exact_title = normalize_title(album["title"])
        rows = []
        for release_id, how in plan["candidates"].items():
            row = release_rows[release_id]
            names = release_artists.get(release_id, [])
            have = split_artists(names)
            overlap = bool(wanted and have) and artists_overlap(wanted, have)
            if how == "title" and wanted and have and not overlap:
                # Same title, someone else's album ("Grandes éxitos")
                continue
            same_title = normalize_title(row[1]) == exact_title
            match_type = how if how == "upc" else ("title_artist" if overlap else "title")
            if how == "title" and not same_title:
                match_type = "edition"
            rows.append(
                {
                    "id": str(release_id),
                    "title": row[1],
                    "version": row[2] or None,
                    "upc": row[3] or None,
                    "release_date": _iso(row[4]),
                    "release_type": row[5],
                    "artists": names,
                    "track_count": counts.get(release_id, 0),
                    "match_type": match_type,
                    # Ticked by default in the card: the same album listed twice
                    "same_title_artist": how == "upc" or (same_title and (overlap or not wanted or not have)),
                    "path": release_path(slug, release_id),
                    "_created": row[6],
                }
            )

        # Tracks
        candidate_ids = {row["id"] for row in rows}
        tracks_out = []
        matched_ids = []
        for track in album["tracks"]:
            wanted_track = split_artists(track["artists"] or album["artists"])
            options = []
            if track["isrc"] and track["isrc"] in isrc_hits:
                options = [(1.0, "isrc", isrc_hits[track["isrc"]])]
            elif track["title"]:
                for track_id in dict.fromkeys(by_title.get(normalize_title(track["title"]), [])):
                    have = split_artists(track_artists.get(track_id, []))
                    if wanted_track and have and artists_overlap(wanted_track, have):
                        options.append((0.9, "title_artist", track_id))
                    else:
                        options.append((0.7, "title", track_id))

            def in_album(track_id):
                return any(item["id"] in candidate_ids for item in current_releases.get(track_id, []))

            options.sort(key=lambda option: (-option[0], not in_album(option[2]), song_rows[option[2]][4]))
            best = options[0] if options else None
            ambiguous = False
            if best:
                ties = [option for option in options if option[0] == best[0]]
                if len(ties) > 1:
                    preferred = [option for option in ties if in_album(option[2])]
                    ambiguous = len(preferred) != 1
            describe = lambda option: _song_out(  # noqa: E731
                slug, song_rows[option[2]], option, track_artists, current_releases
            )
            tracks_out.append(
                {
                    "index": track["position"],
                    "input": {key: track[key] for key in ("title", "isrc", "artists", "duration")},
                    "disc_number": track["disc_number"],
                    "track_number": track["track_number"],
                    "match": describe(best) if best else None,
                    "candidates": [describe(option) for option in options[:MAX_CANDIDATES]] if ambiguous else [],
                    "ambiguous": ambiguous,
                }
            )
            if best:
                matched_ids.append(best[2])

        # Releases made only of this album's songs: likely fragments of it
        matched_set = set(matched_ids)
        for track_id in matched_ids:
            for item in current_releases.get(track_id, []):
                release_id = uuid.UUID(item["id"])
                if item["id"] in candidate_ids:
                    continue
                total = counts.get(release_id, 0)
                inside = sum(
                    1 for other in matched_set if any(r["id"] == item["id"] for r in current_releases.get(other, []))
                )
                if total and inside >= total:
                    row = release_rows.get(release_id)
                    if row is None:
                        continue
                    candidate_ids.add(item["id"])
                    rows.append(
                        {
                            "id": item["id"],
                            "title": row[1],
                            "version": row[2] or None,
                            "upc": row[3] or None,
                            "release_date": _iso(row[4]),
                            "release_type": row[5],
                            "artists": release_artists.get(release_id, []),
                            "track_count": total,
                            "match_type": "contained",
                            "same_title_artist": False,
                            "path": release_path(slug, release_id),
                            "_created": row[6],
                        }
                    )

        # Suggested target: the UPC match, else the one with a UPC, else the
        # most songs, then the oldest. Fragments ("contained") never lead.
        leaders = [row for row in rows if row["match_type"] != "contained"]
        leaders.sort(
            key=lambda row: (
                row["match_type"] != "upc",
                not row["same_title_artist"],
                not row["upc"],
                -row["track_count"],
                row["_created"],
            )
        )
        suggested = leaders[0]["id"] if leaders else None
        order = {"upc": 0, "title_artist": 1, "title": 2, "edition": 3, "contained": 4}
        rows.sort(
            key=lambda row: (row["id"] != suggested, order[row["match_type"]], -row["track_count"], row["_created"])
        )
        for row in rows:
            row.pop("_created")
        results.append(
            {
                "index": index,
                "album": {key: album[key] for key in ("title", "artists", "type", "release_date")}
                | {"upc": album["upc_raw"] or None},
                "release_candidates": rows,
                "suggested_target_id": suggested,
                "tracks": tracks_out,
                "summary": {
                    "tracks": len(tracks_out),
                    "matched": sum(1 for row in tracks_out if row["match"] and not row["ambiguous"]),
                    "ambiguous": sum(1 for row in tracks_out if row["ambiguous"]),
                    "unmatched": sum(1 for row in tracks_out if not row["match"]),
                    "duplicates": sum(1 for row in rows if row["id"] != suggested and row["same_title_artist"]),
                },
            }
        )
    return results


def _song_out(slug, row, option, track_artists, current_releases):
    track_id, title, version, isrc, _ = row
    return {
        "id": str(track_id),
        "track_id": str(track_id),
        "title": title,
        "version": version or None,
        "isrc": isrc or None,
        "artists": list(dict.fromkeys(track_artists.get(track_id, []))),
        "confidence": option[0],
        "match_type": option[1],
        "releases": current_releases.get(track_id, []),
        "path": track_path(slug, track_id),
    }


# ----------------------------------------------------------------- applying


def _clean_request(workspace, albums):
    """Validates the whole request (shape and that every id is this
    workspace's) before anything is written."""
    if not isinstance(albums, list) or not albums:
        raise GroupingError("albums must be a non-empty list")
    if len(albums) > MAX_ALBUMS:
        raise GroupingError(f"at most {MAX_ALBUMS} albums per request")
    plans = []
    seen_targets, seen_merged = set(), set()
    for position, raw in enumerate(albums):
        if not isinstance(raw, dict):
            raise GroupingError(f"albums[{position}] must be an object")
        target = raw.get("target") if isinstance(raw.get("target"), dict) else {}
        create = target.get("create") if isinstance(target.get("create"), dict) else None
        target_id = None
        if target.get("release_id"):
            target_id = _uuid(target["release_id"], f"albums[{position}].target.release_id")
        elif create is not None:
            if not _text(create.get("title")):
                raise GroupingError(f"albums[{position}].target.create.title is required")
        else:
            raise GroupingError(f"albums[{position}].target needs release_id or create")
        merged = []
        for value in raw.get("merge_release_ids") or []:
            release_id = _uuid(value, f"albums[{position}].merge_release_ids")
            if release_id != target_id and release_id not in merged:
                merged.append(release_id)
        tracks = []
        for item in raw.get("tracks") or []:
            if not isinstance(item, dict):
                raise GroupingError(f"albums[{position}].tracks items must be objects")
            tracks.append(
                {
                    "track_id": _uuid(item.get("track_id"), f"albums[{position}].tracks.track_id"),
                    "disc_number": _number(item.get("disc_number")),
                    "track_number": _number(item.get("track_number")),
                }
            )
        creates = []
        for item in raw.get("create_tracks") or []:
            if not isinstance(item, dict) or not _text(item.get("title")):
                raise GroupingError(f"albums[{position}].create_tracks items need a title")
            creates.append(
                {
                    "title": _text(item.get("title")),
                    "isrc": item.get("isrc"),
                    "artists": _names(item.get("artists")),
                    "disc_number": _number(item.get("disc_number")),
                    "track_number": _number(item.get("track_number")),
                }
            )
        if len(tracks) + len(creates) > MAX_TRACKS:
            raise GroupingError(f"at most {MAX_TRACKS} songs per album")
        if target_id:
            if target_id in seen_targets or target_id in seen_merged:
                raise GroupingError(f"release {target_id} is used twice")
            seen_targets.add(target_id)
        for release_id in merged:
            if release_id in seen_targets or release_id in seen_merged:
                raise GroupingError(f"release {release_id} is used twice")
            seen_merged.add(release_id)
        remove_empty = raw.get("remove_empty_merged", True)
        plans.append(
            {
                "target_id": target_id,
                "create": create,
                "merged": merged,
                "tracks": tracks,
                "creates": creates,
                "remove_empty": remove_empty is not False and str(remove_empty).lower() not in ("false", "0"),
            }
        )

    release_ids = seen_targets | seen_merged
    known = set(MusicRelease.objects.filter(workspace=workspace, id__in=release_ids).values_list("id", flat=True))
    missing = release_ids - known
    if missing:
        raise GroupingError(f"unknown release: {', '.join(sorted(str(value) for value in missing))}")
    track_ids = {item["track_id"] for plan in plans for item in plan["tracks"]}
    known_tracks = set(MusicTrack.objects.filter(workspace=workspace, id__in=track_ids).values_list("id", flat=True))
    missing = track_ids - known_tracks
    if missing:
        raise GroupingError(f"unknown song: {', '.join(sorted(str(value) for value in missing))}")
    return plans


class _Tracklist:
    """The target's live links, to place songs without colliding numbers."""

    def __init__(self, release):
        self.release = release
        self.links = {
            link.track_id: link
            for link in MusicReleaseTrack.objects.filter(release=release, track__deleted_at__isnull=True)
        }

    def taken(self, disc, number, except_track=None):
        return any(
            link.disc_number == disc and link.track_number == number and track_id != except_track
            for track_id, link in self.links.items()
        )

    def next_number(self, disc):
        numbers = [link.track_number for link in self.links.values() if link.disc_number == disc]
        return max(numbers, default=0) + 1

    def last_disc(self):
        return max((link.disc_number for link in self.links.values()), default=1)

    def place(self, workspace, track_id, disc, number):
        """Links (or renumbers) a song. Returns "linked", "renumbered" or None."""
        from plane.app.views.music.base import _restore_or_create

        current = self.links.get(track_id)
        if current and current.disc_number == disc and current.track_number == number:
            return None
        link = _restore_or_create(
            MusicReleaseTrack,
            workspace,
            {"release": self.release, "track_id": track_id},
            {"disc_number": disc, "track_number": number},
        )
        self.links[track_id] = link
        return "renumbered" if current else "linked"


def _create_target(workspace, create):
    from plane.app.views.music.base import _party, _restore_or_create

    upc_digits = re.sub(r"\D", "", str(create.get("upc") or ""))[:32]
    release = MusicRelease.objects.create(
        workspace=workspace,
        title=_text(create.get("title")),
        release_type=release_type_value(create.get("type")) or MusicRelease.Type.ALBUM,
        upc=upc_digits if normalize_upc(upc_digits) else "",
        release_date=_parse_date(create.get("release_date")),
        status=MusicRelease.Status.DRAFT,
    )
    for name in _names(create.get("artists")):
        _restore_or_create(
            MusicReleaseArtist,
            workspace,
            {"release": release, "party": _party(workspace, name), "role": MusicReleaseArtist.Role.PRIMARY},
        )
    return release


def _merge_into(workspace, target, merged, tracklist, explicit, summary, now):
    """Moves one merged release's songs, metadata, links and tags into the
    target. Songs the request numbers itself are placed later."""
    from plane.app.views.music.base import _restore_or_create

    links = list(
        MusicReleaseTrack.objects.filter(release=merged, track__deleted_at__isnull=True).order_by(
            "disc_number", "track_number", "created_at"
        )
    )
    for link in links:
        if link.track_id not in explicit:
            if link.track_id in tracklist.links:
                summary["tracks_already"] += 1
            else:
                disc = link.disc_number or 1
                number = link.track_number or 1
                if tracklist.taken(disc, number, except_track=link.track_id):
                    number = tracklist.next_number(disc)
                tracklist.place(workspace, link.track_id, disc, number)
                summary["tracks_moved"] += 1
    MusicReleaseTrack.objects.filter(id__in=[link.id for link in links]).update(deleted_at=now)

    # Fields the target lacks
    changed = []
    for field in COPY_FIELDS:
        value = getattr(merged, field)
        if value not in (None, "") and getattr(target, field) in (None, ""):
            setattr(target, field, value)
            changed.append(field)
    if not target.territories and merged.territories:
        target.territories = merged.territories
        changed.append("territories")
    if changed:
        target.save(update_fields=[*changed, "updated_at"])
        summary["metadata_copied"] = sorted(set(summary["metadata_copied"]) | set(changed))

    # Artists the target doesn't have yet
    have = set(MusicReleaseArtist.objects.filter(release=target).values_list("party_id", "role"))
    for party_id, role in MusicReleaseArtist.objects.filter(release=merged).values_list("party_id", "role"):
        if (party_id, role) not in have:
            _restore_or_create(MusicReleaseArtist, workspace, {"release": target, "party_id": party_id, "role": role})
            have.add((party_id, role))
            summary["artists_added"] += 1

    # The release's own links and distributions follow it
    target_urls = set(MusicLink.objects.filter(release=target).values_list("url", flat=True))
    for link in MusicLink.objects.filter(release=merged):
        if link.url in target_urls:
            MusicLink.objects.filter(id=link.id).update(deleted_at=now)
        else:
            MusicLink.objects.filter(id=link.id).update(release=target)
            target_urls.add(link.url)
    target_shares = set(MusicDistribution.objects.filter(release=target).values_list("company_id", "territory"))
    for share in MusicDistribution.objects.filter(release=merged):
        if (share.company_id, share.territory) in target_shares:
            MusicDistribution.objects.filter(id=share.id).update(deleted_at=now)
        else:
            MusicDistribution.objects.filter(id=share.id).update(release=target)
            target_shares.add((share.company_id, share.territory))

    # Contract links: one per contract on the target, the stronger one kept
    release_type = ContractWorkLink.EntityType.MUSIC_RELEASE
    strength = {
        ContractWorkLink.Status.LINKED: 2,
        ContractWorkLink.Status.SUGGESTED: 1,
        ContractWorkLink.Status.DISMISSED: 0,
    }
    on_target = {
        link.contract_id: link
        for link in ContractWorkLink.objects.filter(entity_type=release_type, entity_id=target.id)
    }
    for link in ContractWorkLink.objects.filter(entity_type=release_type, entity_id=merged.id):
        existing = on_target.get(link.contract_id)
        if existing is None:
            ContractWorkLink.objects.filter(id=link.id).update(entity_id=target.id)
            on_target[link.contract_id] = link
            summary["contract_links_moved"] += 1
            continue
        if strength.get(link.status, 0) > strength.get(existing.status, 0):
            ContractWorkLink.objects.filter(id=existing.id).update(deleted_at=now)
            ContractWorkLink.objects.filter(id=link.id).update(entity_id=target.id)
            on_target[link.contract_id] = link
        else:
            ContractWorkLink.objects.filter(id=link.id).update(deleted_at=now)
        summary["contract_links_merged"] += 1

    # Shared tags
    target_tags = set(
        EntityTagLink.objects.filter(entity_type="music_release", entity_id=target.id).values_list("tag_id", flat=True)
    )
    for link in EntityTagLink.objects.filter(entity_type="music_release", entity_id=merged.id):
        if link.tag_id in target_tags:
            EntityTagLink.objects.filter(id=link.id).update(deleted_at=now)
        else:
            EntityTagLink.objects.filter(id=link.id).update(entity_id=target.id)
            target_tags.add(link.tag_id)


def _apply_album(workspace, slug, plan, now):
    from plane.utils.contract_works import create_catalog_entity

    created_target = plan["target_id"] is None
    target = (
        _create_target(workspace, plan["create"])
        if created_target
        else MusicRelease.objects.get(workspace=workspace, id=plan["target_id"])
    )
    summary = {
        "tracks_linked": 0,
        "tracks_renumbered": 0,
        "tracks_already": 0,
        "tracks_moved": 0,
        "tracks_created": 0,
        "tracks_reused": 0,
        "metadata_copied": [],
        "artists_added": 0,
        "contract_links_moved": 0,
        "contract_links_merged": 0,
        "merged_releases": [],
    }
    tracklist = _Tracklist(target)
    explicit = {item["track_id"] for item in plan["tracks"]}

    # 1. Songs the request numbers: they claim their places first
    for item in plan["tracks"]:
        if item["track_number"] is None:
            continue
        outcome = tracklist.place(workspace, item["track_id"], item["disc_number"] or 1, item["track_number"])
        if outcome:
            summary[f"tracks_{outcome}"] += 1
        else:
            summary["tracks_already"] += 1

    # 2. The merged releases' songs keep their numbers where free
    for release_id in plan["merged"]:
        merged = MusicRelease.objects.get(workspace=workspace, id=release_id)
        _merge_into(workspace, target, merged, tracklist, explicit, summary, now)
        left = MusicReleaseTrack.objects.filter(release=merged, track__deleted_at__isnull=True).exists()
        deleted = plan["remove_empty"] and not left
        if deleted:
            MusicReleaseArtist.objects.filter(release=merged).update(deleted_at=now)
            MusicRelease.objects.filter(id=merged.id).update(deleted_at=now)
        summary["merged_releases"].append({"id": str(merged.id), "title": merged.title, "deleted": deleted})

    # 3. Songs without a number: their place if already there, else the end
    for item in plan["tracks"]:
        if item["track_number"] is not None:
            continue
        if item["track_id"] in tracklist.links and item["disc_number"] in (
            None,
            tracklist.links[item["track_id"]].disc_number,
        ):
            summary["tracks_already"] += 1
            continue
        disc = item["disc_number"] or tracklist.last_disc()
        tracklist.place(workspace, item["track_id"], disc, tracklist.next_number(disc))
        summary["tracks_linked"] += 1

    # 4. New draft songs for tracks the catalog doesn't have
    for item in plan["creates"]:
        _, track, created = create_catalog_entity(
            workspace, kind="track", title=item["title"], artists=item["artists"], isrc=item["isrc"]
        )
        summary["tracks_created" if created else "tracks_reused"] += 1
        disc = item["disc_number"] or tracklist.last_disc()
        number = item["track_number"] or tracklist.next_number(disc)
        tracklist.place(workspace, track.id, disc, number)

    # A release made into an album by grouping stops being a "single"
    total = len(tracklist.links)
    if (
        not created_target
        and target.release_type == MusicRelease.Type.SINGLE
        and total > 1
        and (plan["merged"] or summary["tracks_linked"] or summary["tracks_created"])
    ):
        from plane.utils.music_release_types import infer_release_type

        inferred = infer_release_type(target.title, total)
        if inferred and inferred != target.release_type:
            target.release_type = inferred
            target.save(update_fields=["release_type", "updated_at"])
            summary["release_type"] = inferred

    return {
        "target": {
            "id": str(target.id),
            "title": target.title,
            "created": created_target,
            "path": release_path(slug, target.id),
        },
        "total_tracks": total,
        **summary,
    }


def apply_grouping(workspace, albums):
    """Applies every album in order (the caller holds the transaction)."""
    plans = _clean_request(workspace, albums)
    now = timezone.now()
    return [_apply_album(workspace, workspace.slug, plan, now) for plan in plans]
