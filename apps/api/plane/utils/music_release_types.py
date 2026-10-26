# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Release types (single, EP, album…): reading them from a spreadsheet cell
and inferring them when nobody says.

Distributor exports rarely carry a release-type column, so a catalog
imported from one would be all "Album" (the model's default). When the file
says nothing, the type is inferred from the release's title ("Single «…»",
"… - EP") and, failing that, from how many songs it holds.
"""

# Python imports
import re
import unicodedata

# Django imports
from django.db.models import Count, Q

# Module imports
from plane.db.models import MusicRelease

Type = MusicRelease.Type

# Spellings a release-type cell may use, by type (compared lowercase, without
# accents or punctuation: "Álbum", "full-length" and "E.P." all match).
RELEASE_TYPE_SYNONYMS = {
    Type.SINGLE: ("single", "sencillo", "maxi single", "maxisingle"),
    Type.EP: ("ep", "e p", "extended play", "mini album", "minialbum"),
    Type.LP: ("lp", "l p", "long play", "long playing"),
    Type.ALBUM: ("album", "full length", "full length album", "studio album", "larga duracion"),
    Type.COMPILATION: (
        "compilation",
        "compilado",
        "compilacion",
        "recopilatorio",
        "recopilacion",
        "compilation album",
    ),
    Type.SOUNDTRACK: (
        "soundtrack",
        "banda sonora",
        "banda sonora original",
        "ost",
        "original soundtrack",
        "bso",
        "original motion picture soundtrack",
    ),
}

# How many songs make each type when the file doesn't say: up to the first
# number is a single, up to the second an EP, more is an album.
TRACK_COUNT_THRESHOLDS = ((1, Type.SINGLE), (6, Type.EP))
TRACK_COUNT_FALLBACK = Type.ALBUM

# Types an inference may produce (and the order results are reported in)
INFERRED_TYPES = (Type.SINGLE, Type.EP, Type.ALBUM)

# 'Single "Amor"', 'Sencillo: Amor' / 'Amor - Single', 'Amor (Single)'
# The word must be followed by a quote, colon or dash, so a song title that
# merely starts with it ("Single Ladies") is not read as a single
_SINGLE_PREFIX = re.compile(r"^\W*(single|sencillo)\s*[:\-–—\"“”«'‘’(]", re.IGNORECASE)
_SINGLE_SUFFIX = re.compile(r"[-–—(\[]\s*(single|sencillo)\s*[)\]]?\s*$", re.IGNORECASE)
# "EP" (or "E.P.") as a word: "Verano EP", "EP Navidad", "Amor - EP"
_EP_WORD = re.compile(r"(?<![A-Za-z0-9])(EP|E\.P\.?)(?![A-Za-z0-9])")


def _key(value):
    text = "".join(
        char for char in unicodedata.normalize("NFKD", str(value or "").lower()) if not unicodedata.combining(char)
    )
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


_SYNONYM_INDEX = {_key(spelling): value for value, spellings in RELEASE_TYPE_SYNONYMS.items() for spelling in spellings}


def release_type_value(raw):
    """The MusicRelease.Type VALUE a cell names — by value, label or any
    synonym ("Sencillo" -> SINGLE, "Banda sonora" -> SOUNDTRACK) — or None
    when it names none (the import then asks the user)."""
    key = _key(raw)
    if not key:
        return None
    for value, label in Type.choices:
        if key in (_key(value), _key(label)):
            return value
    return _SYNONYM_INDEX.get(key)


def type_from_title(title):
    """SINGLE / EP when the title says so, else None."""
    text = str(title or "").strip()
    if not text:
        return None
    if _SINGLE_PREFIX.search(text) or _SINGLE_SUFFIX.search(text):
        return Type.SINGLE
    if _EP_WORD.search(text):
        return Type.EP
    return None


def type_from_track_count(count):
    """SINGLE / EP / ALBUM for a number of songs (None for an empty release)."""
    if not count or count < 1:
        return None
    for limit, value in TRACK_COUNT_THRESHOLDS:
        if count <= limit:
            return value
    return TRACK_COUNT_FALLBACK


def infer_release_type(title, track_count):
    """The title's hint first, then the number of songs."""
    return type_from_title(title) or type_from_track_count(track_count)


def with_track_counts(queryset):
    """Annotates `track_count`: live songs linked to each release."""
    return queryset.annotate(
        track_count=Count(
            "track_links",
            filter=Q(track_links__deleted_at__isnull=True, track_links__track__deleted_at__isnull=True),
            distinct=True,
        )
    )


def plan_inferred_types(queryset, include_unchanged=False):
    """[{release, tracks, from, to}] for the releases whose inferred type
    differs from the one they have — or, with `include_unchanged`, for every
    release a type can be inferred for. Releases with no songs and no title
    hint are left alone."""
    changes = []
    for release in with_track_counts(queryset).order_by("title", "id"):
        inferred = infer_release_type(release.title, release.track_count)
        if inferred and (include_unchanged or inferred != release.release_type):
            changes.append(
                {"release": release, "tracks": release.track_count, "from": release.release_type, "to": inferred}
            )
    return changes


def count_by_type(changes):
    """{SINGLE: n, EP: m, ALBUM: k} — every inferable type, zeros included."""
    counts = {value: 0 for value in INFERRED_TYPES}
    for change in changes:
        counts[change["to"]] = counts.get(change["to"], 0) + 1
    return counts


def apply_inferred_types(changes, user=None):
    """Writes the planned types: one UPDATE per target type."""
    from django.utils import timezone

    now = timezone.now()
    by_type = {}
    for change in changes:
        if change["to"] != change["from"]:
            by_type.setdefault(change["to"], []).append(change["release"].id)
    for value, ids in by_type.items():
        extra = {"updated_by": user} if user is not None and getattr(user, "is_authenticated", False) else {}
        MusicRelease.objects.filter(id__in=ids).update(release_type=value, updated_at=now, **extra)
