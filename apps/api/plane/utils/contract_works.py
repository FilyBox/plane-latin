# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Songs and releases a contract covers.

The AI (or the assistant) reads works out of a contract; `match_works` finds
them in the catalog and `record_suggestions` stores them as SUGGESTED links
without ever touching what a person already confirmed or dismissed. The rest
is shared by the web, music and internal endpoints: catalog filters, counts
and the link payloads.
"""

import re
import unicodedata
from difflib import SequenceMatcher

from django.core.exceptions import ValidationError
from django.db import transaction
from django.db.models import Case, Count, Exists, F, Func, IntegerField, OuterRef, Q, Subquery, Value, When
from django.db.models.functions import Coalesce, Replace, Upper
from django.utils import timezone

from plane.db.models import (
    Contract,
    ContractWorkLink,
    MusicCredit,
    MusicRelease,
    MusicReleaseArtist,
    MusicReleaseTrack,
    MusicTrack,
    WorkspaceFeature,
)
from plane.utils.contract_views import active_q, expired_q

TRACK = ContractWorkLink.EntityType.MUSIC_TRACK
RELEASE = ContractWorkLink.EntityType.MUSIC_RELEASE
ENTITY_TYPES = (TRACK.value, RELEASE.value)
Status = ContractWorkLink.Status
Source = ContractWorkLink.Source
RIGHTS_TYPES = set(ContractWorkLink.RightsType.values)

MIN_CONFIDENCE = 0.7
FUZZY_RATIO = 0.9
MAX_WORKS = 300
ARTIST_ROLES = (
    MusicCredit.Role.PRIMARY_ARTIST,
    MusicCredit.Role.FEATURED_ARTIST,
    MusicCredit.Role.PERFORMER,
)

# "(feat. X)", "[ft X]", "(con X)", "(with X)" and a trailing "feat. X"
_FEAT_GROUP = re.compile(r"[\(\[]\s*(?:feat\.?|ft\.?|featuring|con|with)\s[^\)\]]*[\)\]]")
_FEAT_TAIL = re.compile(r"\s(?:feat\.?|ft\.?|featuring)\s.*$")
_ARTIST_SPLIT = re.compile(r"\s*(?:,|;|/|&|\+)\s*|\s+(?:y|and|x|feat\.?|ft\.?|featuring|con|with)\s+")
_NON_WORD = re.compile(r"[^a-z0-9]+")


# ------------------------------------------------------------ normalization


def fold(value):
    """Lowercase, no accents."""
    text = unicodedata.normalize("NFKD", str(value or ""))
    return "".join(char for char in text if not unicodedata.combining(char)).lower()


def normalize_title(value):
    text = fold(value)
    text = _FEAT_GROUP.sub(" ", text)
    text = _FEAT_TAIL.sub(" ", text)
    return " ".join(_NON_WORD.sub(" ", text).split())


def normalize_name(value):
    return " ".join(_NON_WORD.sub(" ", fold(value)).split())


def normalize_isrc(value):
    code = re.sub(r"[^A-Za-z0-9]", "", str(value or "")).upper()
    return code if len(code) == 12 else None


def normalize_upc(value):
    digits = re.sub(r"\D", "", str(value or ""))
    if not 8 <= len(digits) <= 14:
        return None
    # UPC-A and its EAN-13 form differ only by a leading zero
    return digits.lstrip("0") or None


def split_artists(value):
    """Names from a list or a "A, B feat. C" string, normalized."""
    if isinstance(value, (list, tuple)):
        raw = [str(item.get("nombre") or item.get("name") or "") if isinstance(item, dict) else str(item) for item in value]
    else:
        raw = [str(value or "")]
    names = []
    for item in raw:
        for part in _ARTIST_SPLIT.split(fold(item)):
            name = normalize_name(part)
            if name and name not in names:
                names.append(name)
    return names


def artists_overlap(left, right):
    """Any shared artist; "bad bunny" also matches "bad bunny pr" style names."""
    for a in left:
        for b in right:
            if a == b:
                return True
            short, long_ = (a, b) if len(a) <= len(b) else (b, a)
            short_tokens, long_tokens = short.split(), long_.split()
            if (len(short_tokens) >= 2 or len(short) >= 4) and set(short_tokens) <= set(long_tokens):
                return True
    return False


def work_key(title, kind=None):
    """Dedupe key for a work that is not in the catalog."""
    normalized = normalize_title(title)
    if not normalized:
        return ""
    return f"{'release' if kind == 'release' else 'track'}:{normalized}"


def _kind(value):
    value = fold(value).strip()
    if value in ("track", "cancion", "song", "tema", "fonograma", "music_track"):
        return "track"
    if value in ("release", "album", "ep", "lanzamiento", "disco", "music_release"):
        return "release"
    return None


def _evidence(raw):
    evidence = raw.get("evidence") if isinstance(raw.get("evidence"), dict) else {}
    quote = raw.get("cita") or raw.get("quote") or evidence.get("quote")
    page = raw.get("pagina") or raw.get("page") or evidence.get("page")
    result = {}
    if quote:
        result["quote"] = str(quote)[:1000]
    if page not in (None, ""):
        try:
            result["page"] = int(page)
        except (TypeError, ValueError):
            result["page"] = str(page)[:20]
    return result


def clean_work(raw):
    """One work in the shape match_works uses; accepts the Spanish keys the
    analysis prompt returns (titulo, artistas, tipo, cita, pagina)."""
    if not isinstance(raw, dict):
        return None
    title = str(raw.get("title") or raw.get("titulo") or "").strip()[:500]
    isrc = normalize_isrc(raw.get("isrc"))
    upc = normalize_upc(raw.get("upc"))
    if not title and not isrc and not upc:
        return None
    artists_raw = raw.get("artists", raw.get("artistas"))
    if isinstance(artists_raw, (list, tuple)):
        artists = [
            str(item.get("nombre") or item.get("name") or "") if isinstance(item, dict) else str(item)
            for item in artists_raw
        ]
    else:
        artists = [part for part in re.split(r"\s*[,;]\s*", str(artists_raw or "")) if part]
    rights = str(raw.get("rights_type") or "").upper()
    return {
        "title": title,
        "artists": [name.strip()[:255] for name in artists if name.strip()][:20],
        "isrc": isrc,
        "upc": upc,
        "version": str(raw.get("version") or "").strip()[:255],
        "kind": _kind(raw.get("kind") or raw.get("tipo")),
        "evidence": _evidence(raw),
        "rights_type": rights if rights in RIGHTS_TYPES else None,
    }


# ----------------------------------------------------------------- matching


def _match_isrcs(workspace_id, isrcs):
    """ISRC -> song id; a video's ISRC points to its song."""
    if not isrcs:
        return {}
    rows = (
        MusicTrack.objects.filter(workspace_id=workspace_id)
        .annotate(
            n_isrc=Upper(Replace(Replace("isrc", Value("-"), Value("")), Value(" "), Value(""))),
            n_video=Upper(Replace(Replace("isrc_video", Value("-"), Value("")), Value(" "), Value(""))),
        )
        .filter(Q(n_isrc__in=isrcs) | Q(n_video__in=isrcs))
        .order_by(F("parent_track_id").asc(nulls_first=True), "created_at")
        .values_list("id", "parent_track_id", "n_isrc", "n_video")
    )
    found = {}
    for track_id, parent_id, n_isrc, n_video in rows:
        for code in (n_isrc, n_video):
            if code in isrcs:
                found.setdefault(code, parent_id or track_id)
    return found


def _match_upcs(workspace_id, upcs):
    if not upcs:
        return {}
    found = {}
    rows = MusicRelease.objects.filter(workspace_id=workspace_id).exclude(upc="").order_by("created_at")
    for release_id, upc in rows.values_list("id", "upc"):
        code = normalize_upc(upc)
        if code in upcs:
            found.setdefault(code, release_id)
    return found


def _artists_by_track(track_ids):
    names = {}
    credits = MusicCredit.objects.filter(track_id__in=track_ids, role__in=ARTIST_ROLES).values_list(
        "track_id", "party__display_name"
    )
    for track_id, name in credits:
        names.setdefault(track_id, []).append(name)
    # Songs without credits fall back to their releases' artists
    missing = [track_id for track_id in track_ids if track_id not in names]
    if missing:
        rows = MusicReleaseTrack.objects.filter(track_id__in=missing).values_list(
            "track_id", "release__artist_links__party__display_name"
        )
        for track_id, name in rows:
            if name:
                names.setdefault(track_id, []).append(name)
    return names


def _artists_by_release(release_ids):
    names = {}
    rows = MusicReleaseArtist.objects.filter(release_id__in=release_ids).values_list("release_id", "party__display_name")
    for release_id, name in rows:
        names.setdefault(release_id, []).append(name)
    return names


def _title_candidates(rows, title, has_artists):
    """(id, exact) pairs whose title equals or (with artists) closely matches."""
    exact, fuzzy = [], []
    matcher = SequenceMatcher(autojunk=False)
    matcher.set_seq2(title)
    for row_id, normalized in rows:
        if not normalized:
            continue
        if normalized == title:
            exact.append(row_id)
            continue
        if not has_artists:
            continue
        # Cheap length bound first: ratio can't beat 2*shorter/(sum)
        if 2 * min(len(normalized), len(title)) < FUZZY_RATIO * (len(normalized) + len(title)):
            continue
        matcher.set_seq1(normalized)
        if matcher.real_quick_ratio() >= FUZZY_RATIO and matcher.quick_ratio() >= FUZZY_RATIO:
            if matcher.ratio() >= FUZZY_RATIO:
                fuzzy.append(row_id)
    return [(row_id, True) for row_id in exact] + [(row_id, False) for row_id in fuzzy]


def match_works(workspace_id, works):
    """Finds each work in the catalog. Returns one result per usable work:
    {index, work, matched, entity_type, entity_id, confidence, match_type,
    title, artists}. Unmatched works keep entity_id None."""
    cleaned = [(index, clean_work(raw)) for index, raw in enumerate((works or [])[:MAX_WORKS])]
    cleaned = [(index, work) for index, work in cleaned if work]
    if not cleaned:
        return []

    isrc_hits = _match_isrcs(workspace_id, {work["isrc"] for _, work in cleaned if work["isrc"]})
    upc_hits = _match_upcs(workspace_id, {work["upc"] for _, work in cleaned if work["upc"]})

    needs_titles = any(
        work["title"] and not (work["isrc"] in isrc_hits or work["upc"] in upc_hits) for _, work in cleaned
    )
    songs, releases = [], []
    if needs_titles:
        songs = [
            (track_id, normalize_title(title))
            for track_id, title in MusicTrack.objects.filter(
                workspace_id=workspace_id, parent_track__isnull=True
            ).values_list("id", "title")
        ]
        releases = [
            (release_id, normalize_title(title))
            for release_id, title in MusicRelease.objects.filter(workspace_id=workspace_id).values_list("id", "title")
        ]

    # First pass: candidates per work, so artists load in two queries
    plans = []
    track_ids, release_ids = set(), set()
    for index, work in cleaned:
        plan = {"index": index, "work": work, "direct": None, "tracks": [], "releases": []}
        kind = work["kind"]
        if work["isrc"] and kind != "release" and work["isrc"] in isrc_hits:
            plan["direct"] = (TRACK.value, isrc_hits[work["isrc"]], "isrc")
        elif work["upc"] and kind != "track" and work["upc"] in upc_hits:
            plan["direct"] = (RELEASE.value, upc_hits[work["upc"]], "upc")
        elif work["title"]:
            title = normalize_title(work["title"])
            artists = bool(work["artists"])
            if kind != "release":
                plan["tracks"] = _title_candidates(songs, title, artists)
                track_ids.update(row_id for row_id, _ in plan["tracks"])
            if kind != "track":
                plan["releases"] = _title_candidates(releases, title, artists)
                release_ids.update(row_id for row_id, _ in plan["releases"])
        if plan["direct"]:
            if plan["direct"][0] == TRACK.value:
                track_ids.add(plan["direct"][1])
            else:
                release_ids.add(plan["direct"][1])
        plans.append(plan)

    track_artists = _artists_by_track(list(track_ids)) if track_ids else {}
    release_artists = _artists_by_release(list(release_ids)) if release_ids else {}
    track_titles = dict(MusicTrack.objects.filter(id__in=track_ids).values_list("id", "title")) if track_ids else {}
    release_titles = (
        dict(MusicRelease.objects.filter(id__in=release_ids).values_list("id", "title")) if release_ids else {}
    )

    results = []
    for plan in plans:
        work = plan["work"]
        wanted = split_artists(work["artists"])
        best = None
        if plan["direct"]:
            entity_type, entity_id, match_type = plan["direct"]
            best = (1.0, entity_type, entity_id, match_type)
        else:
            options = [(TRACK.value, row, exact, track_artists) for row, exact in plan["tracks"]]
            options += [(RELEASE.value, row, exact, release_artists) for row, exact in plan["releases"]]
            for entity_type, row_id, exact, artist_map in options:
                overlap = bool(wanted) and artists_overlap(wanted, split_artists(artist_map.get(row_id, [])))
                if exact and overlap:
                    score, match_type = 0.9, "title_artist"
                elif exact:
                    score, match_type = 0.7, "title"
                elif overlap:
                    score, match_type = 0.75, "fuzzy_artist"
                else:
                    continue
                # Ties keep the first option: songs before releases unless the work says album
                if best is None or score > best[0]:
                    best = (score, entity_type, row_id, match_type)
        if best and best[0] >= MIN_CONFIDENCE:
            score, entity_type, entity_id, match_type = best
            is_track = entity_type == TRACK.value
            titles = track_titles if is_track else release_titles
            artists = (track_artists if is_track else release_artists).get(entity_id, [])
            results.append(
                {
                    "index": plan["index"],
                    "work": work,
                    "matched": True,
                    "entity_type": entity_type,
                    "entity_id": str(entity_id),
                    "confidence": score,
                    "match_type": match_type,
                    "title": titles.get(entity_id, ""),
                    "artists": list(dict.fromkeys(artists)),
                }
            )
        else:
            results.append(
                {
                    "index": plan["index"],
                    "work": work,
                    "matched": False,
                    "entity_type": RELEASE.value if work["kind"] == "release" else TRACK.value,
                    "entity_id": None,
                    "confidence": None,
                    "match_type": None,
                    "title": work["title"],
                    "artists": work["artists"],
                }
            )
    return results


# --------------------------------------------------------------- recording


def _suggested(work):
    return {
        "title": work["title"],
        "artists": work["artists"],
        "isrc": work["isrc"],
        "upc": work["upc"],
        "version": work["version"],
        "kind": work["kind"],
        "key": work_key(work["title"], work["kind"]),
    }


def _refresh(link, match):
    """Newer evidence for a suggestion still waiting for a decision."""
    work = match["work"]
    if work["evidence"].get("quote"):
        link.evidence = work["evidence"]
    if match["confidence"] is not None:
        link.confidence = max(link.confidence or 0, match["confidence"])
    link.suggested = {**(link.suggested or {}), **{k: v for k, v in _suggested(work).items() if v}}
    if work["rights_type"] and not link.rights_type:
        link.rights_type = work["rights_type"]


def record_suggestions(contract, matches, source=Source.AI, user=None):
    """Stores match results as SUGGESTED links.

    LINKED and DISMISSED rows are never changed; a suggestion still pending
    gets the newer evidence. A work stored earlier as "not in the catalog"
    becomes the matched suggestion once the catalog has it.
    Returns {linked, suggested, unmatched, skipped}: works already linked,
    suggestions stored or refreshed, of those without a catalog match, and
    works left alone because someone dismissed them.
    """
    counts = {"linked": 0, "suggested": 0, "unmatched": 0, "skipped": 0}
    ordered = sorted(matches or [], key=lambda match: -(match.get("confidence") or 0))
    with transaction.atomic():
        Contract.objects.select_for_update().filter(id=contract.id).values_list("id", flat=True).first()
        existing = list(ContractWorkLink.objects.filter(contract_id=contract.id))
        by_entity = {(link.entity_type, str(link.entity_id)): link for link in existing if link.entity_id}
        by_key = {}
        for link in existing:
            key = (link.suggested or {}).get("key")
            if key:
                by_key.setdefault(key, []).append(link)
        seen = set()

        for match in ordered:
            work = match["work"]
            key = work_key(work["title"], work["kind"])
            if match.get("matched"):
                entity = (match["entity_type"], str(match["entity_id"]))
                if entity in seen:
                    continue
                seen.add(entity)
                link = by_entity.get(entity)
                if link is None:
                    pending = [row for row in by_key.get(key, []) if row.entity_id is None]
                    if any(row.status == Status.DISMISSED for row in pending):
                        counts["skipped"] += 1
                        continue
                    link = next((row for row in pending if row.status == Status.SUGGESTED), None)
                    if link is not None:
                        link.entity_type, link.entity_id = entity
                        by_entity[entity] = link
                if link is None:
                    link = ContractWorkLink(
                        workspace_id=contract.workspace_id,
                        contract_id=contract.id,
                        entity_type=entity[0],
                        entity_id=entity[1],
                        status=Status.SUGGESTED,
                        source=source,
                        created_by=user,
                    )
                    by_entity[entity] = link
                    if key:
                        by_key.setdefault(key, []).append(link)
                elif link.status == Status.LINKED:
                    counts["linked"] += 1
                    continue
                elif link.status == Status.DISMISSED:
                    counts["skipped"] += 1
                    continue
                _refresh(link, match)
                link.save()
                counts["suggested"] += 1
            else:
                if not key or key in seen:
                    continue
                seen.add(key)
                rows = by_key.get(key, [])
                if any(row.status == Status.LINKED for row in rows):
                    counts["linked"] += 1
                    continue
                link = next((row for row in rows if row.status == Status.SUGGESTED and row.entity_id is None), None)
                if link is None and rows:
                    counts["skipped"] += 1
                    continue
                if link is None:
                    link = ContractWorkLink(
                        workspace_id=contract.workspace_id,
                        contract_id=contract.id,
                        entity_type=match["entity_type"],
                        entity_id=None,
                        status=Status.SUGGESTED,
                        source=source,
                        created_by=user,
                    )
                    by_key.setdefault(key, []).append(link)
                _refresh(link, match)
                link.save()
                counts["suggested"] += 1
                counts["unmatched"] += 1
    return counts


# --------------------------------------------------------- catalog access


def has_music_access(ctx):
    """Same rule as the music endpoints: module on and workspace admin."""
    return (
        ctx is not None
        and WorkspaceFeature.FeatureKey.MUSIC_CATALOG in ctx.features
        and ctx.role >= 20
    )


def entity_exists(workspace_id, entity_type, entity_id):
    model = MusicTrack if entity_type == TRACK.value else MusicRelease if entity_type == RELEASE.value else None
    if model is None or not entity_id:
        return False
    try:
        return model.objects.filter(workspace_id=workspace_id, id=entity_id).exists()
    except (ValueError, ValidationError):
        return False


def live_links(queryset):
    """Links of contracts still in the library whose song/release still exists."""
    tracks = MusicTrack.objects.filter(id=OuterRef("entity_id"))
    releases = MusicRelease.objects.filter(id=OuterRef("entity_id"))
    return queryset.filter(contract__file_asset__is_deleted=False).filter(
        Q(entity_id__isnull=True) | (Q(entity_type=TRACK) & Exists(tracks)) | (Q(entity_type=RELEASE) & Exists(releases))
    )


def works_summary(contract_id):
    return live_links(ContractWorkLink.objects.filter(contract_id=contract_id)).aggregate(
        linked=Count("id", filter=Q(status=Status.LINKED)),
        suggested=Count("id", filter=Q(status=Status.SUGGESTED)),
    )


def pending_suggestions_count():
    """Per-contract count of suggestions waiting for a decision (list badge)."""
    links = live_links(ContractWorkLink.objects.filter(contract_id=OuterRef("pk"), status=Status.SUGGESTED))
    counted = links.order_by().annotate(total=Func(F("id"), function="COUNT")).values("total")
    return Coalesce(Subquery(counted[:1], output_field=IntegerField()), Value(0))


def link_order(queryset):
    """LINKED first, then SUGGESTED (catalog matches before new works), then DISMISSED."""
    return queryset.annotate(
        link_rank=Case(
            When(status=Status.LINKED, then=Value(0)),
            When(status=Status.SUGGESTED, then=Value(1)),
            default=Value(2),
            output_field=IntegerField(),
        ),
        link_new=Case(When(entity_id__isnull=True, then=Value(1)), default=Value(0), output_field=IntegerField()),
    ).order_by("link_rank", "link_new", F("confidence").desc(nulls_last=True), "created_at")


# ----------------------------------------------------------- catalog filters


def _linked_ids(entity_type, active_today=None):
    links = ContractWorkLink.objects.filter(
        entity_type=entity_type, status=Status.LINKED, contract__file_asset__is_deleted=False
    )
    if active_today is not None:
        links = links.filter(contract_id__in=Contract.objects.filter(active_q(active_today)).values("id"))
    return links.values("entity_id")


def _track_covered(active_today=None):
    via_release = MusicReleaseTrack.objects.filter(
        track_id=OuterRef("pk"), release_id__in=_linked_ids(RELEASE, active_today)
    )
    return Q(id__in=_linked_ids(TRACK, active_today)) | Exists(via_release)


def _release_covered(active_today=None):
    return Q(id__in=_linked_ids(RELEASE, active_today))


def filter_by_contract(queryset, value, kind):
    """`contract=with|without|expired` on the catalog lists. A song is covered
    by its own links and by its releases'; expired means every linked
    contract has ended."""
    value = str(value or "").lower()
    if value not in ("with", "without", "expired"):
        return queryset
    covered = _track_covered if kind == "track" else _release_covered
    if value == "with":
        return queryset.filter(covered())
    if value == "without":
        return queryset.filter(~covered())
    today = timezone.now().date()
    return queryset.filter(covered()).filter(~covered(today))


def _count_distinct_contracts(links):
    counted = links.order_by().annotate(
        total=Func(F("contract_id"), function="COUNT", template="COUNT(DISTINCT %(expressions)s)")
    )
    return Coalesce(Subquery(counted.values("total")[:1], output_field=IntegerField()), Value(0))


def track_contract_count():
    links = ContractWorkLink.objects.filter(status=Status.LINKED, contract__file_asset__is_deleted=False).filter(
        Q(entity_type=TRACK, entity_id=OuterRef("pk"))
        | Q(
            entity_type=RELEASE,
            entity_id__in=MusicReleaseTrack.objects.filter(track_id=OuterRef(OuterRef("pk"))).values("release_id"),
        )
    )
    return _count_distinct_contracts(links)


def release_contract_count():
    links = ContractWorkLink.objects.filter(
        status=Status.LINKED, contract__file_asset__is_deleted=False, entity_type=RELEASE, entity_id=OuterRef("pk")
    )
    return _count_distinct_contracts(links)


# ----------------------------------------------------------------- payloads


def is_expired(contract, today):
    if contract.fecha_fin_efectiva is not None:
        return contract.fecha_fin_efectiva < today
    return contract.estatus_contrato == "FINALIZADO"


def _iso(value):
    return value.isoformat() if value else None


def _entities(links, ctx):
    """Song/release cards for the links, only when the viewer may open music."""
    from plane.utils.entities import REGISTRY

    if not has_music_access(ctx):
        return {}
    track_ids = [link.entity_id for link in links if link.entity_id and link.entity_type == TRACK]
    release_ids = [link.entity_id for link in links if link.entity_id and link.entity_type == RELEASE]
    cards = {}
    if track_ids:
        artists = _artists_by_track(track_ids)
        # Only the card columns: a contract can cover thousands of songs
        tracks = MusicTrack.objects.filter(workspace_id=ctx.workspace_id, id__in=track_ids).only(
            "id", "title", "version", "cover_url", "release_date", "isrc", "status"
        )
        for track in tracks:
            names = list(dict.fromkeys(artists.get(track.id, [])))
            cards[(TRACK.value, str(track.id))] = {
                "title": track.title,
                "version": track.version or None,
                "subtitle": ", ".join(names),
                "artists": names,
                "path": REGISTRY["music_track"].describe(track, ctx)["path"],
                "cover_url": track.cover_url or None,
                "release_date": _iso(track.release_date),
                "isrc": track.isrc or None,
                "status": track.status,
            }
    if release_ids:
        artists = _artists_by_release(release_ids)
        releases = MusicRelease.objects.filter(workspace_id=ctx.workspace_id, id__in=release_ids).only(
            "id", "title", "version", "cover_url", "release_date", "upc", "status"
        )
        for release in releases:
            names = list(dict.fromkeys(artists.get(release.id, [])))
            cards[(RELEASE.value, str(release.id))] = {
                "title": release.title,
                "version": release.version or None,
                "subtitle": ", ".join(names),
                "artists": names,
                "path": REGISTRY["music_release"].describe(release, ctx)["path"],
                "cover_url": release.cover_url or None,
                "release_date": _iso(release.release_date),
                "upc": release.upc or None,
                "status": release.status,
            }
    return cards


def contract_links_payload(links, ctx):
    """Links as the contract panel shows them."""
    links = list(links)
    cards = _entities(links, ctx)
    music = has_music_access(ctx)
    rows = []
    for link in links:
        entity = cards.get((link.entity_type, str(link.entity_id))) if link.entity_id else None
        rows.append(
            {
                "id": str(link.id),
                "status": link.status,
                "source": link.source,
                "rights_type": link.rights_type,
                "entity_type": link.entity_type,
                "entity_id": str(link.entity_id) if link.entity_id else None,
                "entity": entity,
                # Linked to the catalog but this viewer can't open music
                "restricted": bool(link.entity_id) and not music,
                "suggested": link.suggested or {},
                "evidence": link.evidence or {},
                "confidence": link.confidence,
                "created_at": _iso(link.created_at),
                "decided_at": _iso(link.decided_at),
            }
        )
    return rows


def contract_card(contract, slug, today):
    effective = contract.fecha_fin_efectiva
    return {
        "id": str(contract.id),
        "titulo": contract.titulo,
        "file_name": (contract.file_asset.attributes or {}).get("name") if contract.file_asset_id else None,
        "estatus_contrato": contract.estatus_contrato,
        "fecha_fin_efectiva": _iso(effective),
        "days_to_expiry": (effective - today).days if effective else None,
        "expired": is_expired(contract, today),
        "path": f"/{slug}/file-library/contracts/analyzed?peek={contract.id}",
    }


def entity_contracts_payload(workspace_id, slug, entity_type, entity_id):
    """Contracts covering a song or release (LINKED + SUGGESTED). A song also
    lists the links of its releases, marked with `via_release`."""
    today = timezone.now().date()
    links = ContractWorkLink.objects.filter(
        workspace_id=workspace_id,
        status__in=[Status.LINKED, Status.SUGGESTED],
        contract__file_asset__is_deleted=False,
    )
    releases = {}
    if entity_type == TRACK.value:
        releases = {
            release_id: title
            for release_id, title in MusicReleaseTrack.objects.filter(track_id=entity_id).values_list(
                "release_id", "release__title"
            )
        }
        links = links.filter(
            Q(entity_type=TRACK, entity_id=entity_id) | Q(entity_type=RELEASE, entity_id__in=list(releases))
        )
    else:
        links = links.filter(entity_type=RELEASE, entity_id=entity_id)
    # The contract's full text is never needed for its card
    links = link_order(links.select_related("contract__file_asset").defer("contract__extracted_text"))
    rows = []
    for link in links:
        via = None
        if entity_type == TRACK.value and link.entity_type == RELEASE:
            via = {"id": str(link.entity_id), "title": releases.get(link.entity_id, "")}
        rows.append(
            {
                "id": str(link.id),
                "status": link.status,
                "source": link.source,
                "rights_type": link.rights_type,
                "entity_type": link.entity_type,
                "entity_id": str(link.entity_id),
                "contract": contract_card(link.contract, slug, today),
                "evidence": link.evidence or {},
                "confidence": link.confidence,
                "via_release": via,
                "created_at": _iso(link.created_at),
            }
        )
    # Direct links before the ones inherited from a release
    rows.sort(key=lambda row: (row["status"] != Status.LINKED, row["via_release"] is not None))
    return rows


# ------------------------------------------------------------------ writing


def link_entity(contract, entity_type, entity_id, *, source, user, rights_type=None, work=None):
    """Confirms a link to an existing song/release (a person's decision:
    overrides a pending or dismissed suggestion). Returns the link."""
    now = timezone.now()
    link = ContractWorkLink.objects.filter(
        contract_id=contract.id, entity_type=entity_type, entity_id=entity_id
    ).first()
    if link is None and work is not None:
        key = work_key(work.get("title"), work.get("kind"))
        if key:
            link = ContractWorkLink.objects.filter(
                contract_id=contract.id, entity_id__isnull=True, suggested__key=key
            ).exclude(status=Status.LINKED).first()
            if link is not None:
                link.entity_type, link.entity_id = entity_type, entity_id
    if link is None:
        link = ContractWorkLink(
            workspace_id=contract.workspace_id,
            contract_id=contract.id,
            entity_type=entity_type,
            entity_id=entity_id,
            source=source,
            created_by=user,
        )
    if work is not None and not link.suggested:
        link.suggested = _suggested(work)
    link.status = Status.LINKED
    if rights_type:
        link.rights_type = rights_type
    link.decided_by = user
    link.decided_at = now
    link.save()
    return link


def create_catalog_entity(workspace, *, kind="track", title, artists=None, isrc=None, upc=None, version="", release_id=None):
    """A DRAFT song (or release) for a work the catalog doesn't have yet.

    Reuses an existing song with the same ISRC (or release with the same UPC)
    instead of adding a duplicate. Returns (entity_type, instance, created).
    """
    from plane.app.views.music.base import _party, _restore_or_create

    names = [name for name in (artists or []) if str(name).strip()]
    if kind == "release":
        code = normalize_upc(upc)
        if code:
            existing = _match_upcs(workspace.id, {code}).get(code)
            if existing:
                return RELEASE.value, MusicRelease.objects.get(id=existing), False
        release = MusicRelease.objects.create(
            workspace=workspace,
            title=title[:500],
            version=(version or "")[:255],
            upc=re.sub(r"\D", "", str(upc or ""))[:32] if code else "",
            status=MusicRelease.Status.DRAFT,
        )
        for name in names:
            _restore_or_create(
                MusicReleaseArtist,
                workspace,
                {"release": release, "party": _party(workspace, str(name).strip()[:255]), "role": MusicReleaseArtist.Role.PRIMARY},
            )
        return RELEASE.value, release, True

    code = normalize_isrc(isrc)
    if code:
        existing = _match_isrcs(workspace.id, {code}).get(code)
        if existing:
            return TRACK.value, MusicTrack.objects.get(id=existing), False
    track = MusicTrack.objects.create(
        workspace=workspace,
        title=title[:500],
        version=(version or "")[:255],
        isrc=code or "",
        kind=MusicTrack.Kind.AUDIO,
        status=MusicTrack.Status.DRAFT,
    )
    for name in names:
        _restore_or_create(
            MusicCredit,
            workspace,
            {"track": track, "party": _party(workspace, str(name).strip()[:255]), "role": MusicCredit.Role.PRIMARY_ARTIST},
        )
    if release_id:
        release = MusicRelease.objects.get(workspace=workspace, id=release_id)
        position = MusicReleaseTrack.objects.filter(release=release).count() + 1
        _restore_or_create(
            MusicReleaseTrack, workspace, {"track": track, "release": release}, {"disc_number": 1, "track_number": position}
        )
    return TRACK.value, track, True
