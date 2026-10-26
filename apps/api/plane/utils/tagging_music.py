# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""What the AI mapping reads about songs and releases.

One compact line of text per item, in the same shape as the other kinds
(id, title, text): the model then proposes the artist's tag and any existing
workspace tag (project, campaign, catalog…) the line clearly supports.

Songs and releases already reach their catalog artist's tag through their
credits (FileTag.party); those tags are listed as the item's own, so the run
never proposes what the item already has.
"""

from django.db.models import Prefetch

from plane.db.models import (
    FileTag,
    MusicCredit,
    MusicCreditRole,
    MusicDistribution,
    MusicRelease,
    MusicReleaseArtist,
    MusicReleaseTrack,
    MusicTrack,
)
from plane.utils.music_credits import ARTIST_CATEGORY, BUILTIN_ROLES, PERFORMER_CATEGORY, humanize_key

# Kinds of music the mapping can read. The catalog is workspace-admin only.
MUSIC_KINDS = ("music_track", "music_release")

# Credits that say whose the song is; every other role is listed as a credit.
_ARTIST_CATEGORIES = {ARTIST_CATEGORY, PERFORMER_CATEGORY}
_ROLE_ORDER = {"PRIMARY_ARTIST": 0, "FEATURED_ARTIST": 1}
_RELEASE_TYPES = dict(MusicRelease.Type.choices)
_COMPANY_KINDS = {
    "AGGREGATOR": "agregadora",
    "DISTRIBUTOR": "distribuidora",
    "RECORD_LABEL": "sello",
    "PUBLISHER": "editora",
    "MANAGEMENT": "management",
    "OTHER": "empresa",
}
TRACK_TEXT_LIMIT = 700
RELEASE_TEXT_LIMIT = 700
MAX_TRACKLIST = 25


def _clip(text, limit):
    text = " ".join(str(text or "").split())
    return text if len(text) <= limit else f"{text[: limit - 1]}…"


def _join(parts, separator=" | "):
    return separator.join(part for part in parts if part)


def _roles(workspace_id):
    """key -> (label, category) for built-in and workspace roles."""
    roles = dict(BUILTIN_ROLES)
    for key, label, category in MusicCreditRole.objects.filter(workspace_id=workspace_id).values_list(
        "key", "label", "category"
    ):
        roles[key] = (label, category)
    return roles


def party_tag_names(workspace_id, party_ids) -> dict[str, list[str]]:
    """Catalog artist -> names of the tags that stand for them."""
    names: dict[str, list[str]] = {}
    if not party_ids:
        return names
    for party_id, name in FileTag.objects.filter(workspace_id=workspace_id, party_id__in=list(party_ids)).values_list(
        "party_id", "name"
    ):
        names.setdefault(str(party_id), []).append(name)
    return names


def _extra(metadata, limit=200):
    """Columns an import kept without a field (metadata["extra"])."""
    extra = (metadata or {}).get("extra")
    if not isinstance(extra, dict):
        return ""
    return _clip("; ".join(f"{key}: {value}" for key, value in extra.items() if value not in (None, "")), limit)


def track_inventory(workspace_id, offset, limit):
    """Songs (and their videos) as (total, items, credited party ids)."""
    rows = MusicTrack.objects.filter(workspace_id=workspace_id)
    total = rows.count()
    if limit <= 0:
        return total, [], {}
    page = list(
        rows.order_by("created_at", "id").prefetch_related(
            Prefetch("credits", queryset=MusicCredit.objects.select_related("party").order_by("role", "id")),
            Prefetch(
                "release_links",
                queryset=MusicReleaseTrack.objects.select_related("release").order_by("release__release_date"),
            ),
            "genre_links__genre",
            Prefetch("distributions", queryset=MusicDistribution.objects.select_related("company")),
        )[offset : offset + limit]
    )
    roles = _roles(workspace_id)
    items, parties = [], {}
    for track in page:
        artists, credits = [], []
        # Main artists first, then guests, then everyone else.
        for credit in sorted(track.credits.all(), key=lambda credit: _ROLE_ORDER.get(credit.role, 2)):
            label, category = roles.get(credit.role, (humanize_key(credit.role), None))
            entry = f"{credit.party.display_name} ({label})"
            (artists if category in _ARTIST_CATEGORIES else credits).append(entry)
        releases = []
        labels = []
        for link in track.release_links.all():
            release = link.release
            year = str(release.release_date.year) if release.release_date else ""
            kind = _RELEASE_TYPES.get(release.release_type, release.release_type)
            releases.append(f"{release.title} ({_join([kind, year], ', ')})")
            if release.label_name:
                labels.append(release.label_name)
        companies = [
            f"{distribution.company.name} ({_COMPANY_KINDS.get(distribution.company.kind, 'empresa')})"
            for distribution in track.distributions.all()
        ]
        genres = [link.genre.name for link in track.genre_links.all()]
        title = f"{track.title} ({track.version})" if track.version else track.title
        text = _join(
            [
                "video musical" if track.kind != MusicTrack.Kind.AUDIO else "",
                f"subtítulo: {track.subtitle}" if track.subtitle else "",
                f"artistas: {', '.join(artists)}" if artists else "",
                f"créditos: {', '.join(credits[:12])}" if credits else "",
                f"lanzamientos: {', '.join(releases[:5])}" if releases else "",
                f"géneros: {', '.join(genres)}" if genres else "",
                f"ISRC: {track.isrc}" if track.isrc else "",
                f"sello: {', '.join(dict.fromkeys(labels))}" if labels else "",
                f"empresas: {', '.join(companies[:6])}" if companies else "",
                f"℗: {track.p_line}" if track.p_line else "",
                f"idioma: {track.language}" if track.language else "",
                f"catálogo: {track.catalog}" if track.catalog else "",
                f"titularidad: {_clip(track.ownership, 120)}" if track.ownership else "",
                f"notas: {_extra(track.metadata)}" if _extra(track.metadata) else "",
            ]
        )
        items.append({"id": str(track.id), "title": title, "text": _clip(text, TRACK_TEXT_LIMIT)})
        parties[str(track.id)] = {str(credit.party_id) for credit in track.credits.all()}
    return total, items, parties


def release_inventory(workspace_id, offset, limit):
    """Releases as (total, items, artist party ids)."""
    rows = MusicRelease.objects.filter(workspace_id=workspace_id)
    total = rows.count()
    if limit <= 0:
        return total, [], {}
    page = list(
        rows.order_by("created_at", "id").prefetch_related(
            Prefetch("artist_links", queryset=MusicReleaseArtist.objects.select_related("party").order_by("role")),
            Prefetch(
                "track_links",
                queryset=MusicReleaseTrack.objects.select_related("track").order_by("disc_number", "track_number"),
            ),
            Prefetch("distributions", queryset=MusicDistribution.objects.select_related("company")),
        )[offset : offset + limit]
    )
    items, parties = [], {}
    for release in page:
        artists = [
            f"{link.party.display_name}{' (invitado)' if link.role == MusicReleaseArtist.Role.FEATURED else ''}"
            for link in release.artist_links.all()
        ]
        tracklist = [link.track.title for link in release.track_links.all()]
        companies = [
            f"{distribution.company.name} ({_COMPANY_KINDS.get(distribution.company.kind, 'empresa')})"
            for distribution in release.distributions.all()
        ]
        title = f"{release.title} ({release.version})" if release.version else release.title
        text = _join(
            [
                f"tipo: {_RELEASE_TYPES.get(release.release_type, release.release_type)}",
                f"artistas: {', '.join(artists)}" if artists else "",
                f"sello: {release.label_name}" if release.label_name else "",
                f"empresas: {', '.join(companies[:6])}" if companies else "",
                f"año: {release.release_date.year}" if release.release_date else "",
                f"idioma: {release.language}" if release.language else "",
                f"℗: {release.p_line}" if release.p_line else "",
                f"canciones ({len(tracklist)}): {'; '.join(tracklist[:MAX_TRACKLIST])}" if tracklist else "",
                f"notas: {_clip(release.notes, 150)}" if release.notes else "",
            ]
        )
        items.append({"id": str(release.id), "title": title, "text": _clip(text, RELEASE_TEXT_LIMIT)})
        parties[str(release.id)] = {str(link.party_id) for link in release.artist_links.all()}
    return total, items, parties
