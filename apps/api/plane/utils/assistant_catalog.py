# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""The music catalog checked by the assistant, and the corrections it
proposes from it.

audit() is deterministic: each check returns its count, up to 50 examples
and the ids, so the chat can summarise, write a report page, and propose the
fixes (link contracts, link tags, correct data, or a task for what needs a
person). CATALOG_FIXES writes only values with a source (the contract's
text, another song with the same ISRC, what the user said); a missing ISRC is
reported, never filled. Undo goes field by field, only where the value is
still the assistant's.
"""

import re
from collections import defaultdict
from datetime import date
from decimal import Decimal, InvalidOperation

from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from plane.db.models import (
    AssistantAction,
    Contract,
    ContractWorkLink,
    FileTag,
    MusicCredit,
    MusicLink,
    MusicParty,
    MusicRelease,
    MusicReleaseTrack,
    MusicTrack,
)
from plane.utils.assistant_actions import ActionError, register_undo
from plane.utils.assistant_undo import diff, revert_fields, snapshot, to_json
from plane.utils.assistant_workspace import register_apply

ADMIN = 20
EXAMPLES = 50
MAX_IDS = 500
ISRC_RE = re.compile(r"^[A-Z]{2}[A-Z0-9]{3}\d{7}$")
CHECKS = (
    "uncovered_tracks",
    "editorial_without_works",
    "codes",
    "credits",
    "track_shares",
    "contract_artist_mismatch",
    "tags",
    "gaps",
)
ARTIST_ROLES = {"PRIMARY_ARTIST", "FEATURED_ARTIST"}
WRITER_ROLES = {"AUTHOR", "COMPOSER", "LYRICIST", "WRITER"}
PUBLISHING_ROLES = WRITER_ROLES | {"PUBLISHER"}
SHARE_FIELDS = ("artist_percentage", "record_label_percentage", "distributor_percentage", "aggregator_percentage")


def can_use(ctx) -> bool:
    return ctx is not None and ctx.role >= ADMIN and "music_catalog" in ctx.features


def _require(ctx):
    if not can_use(ctx):
        raise ActionError("Only workspace admins with the music catalog can change it.")


def valid_upc(value) -> bool:
    """UPC-A (12) or EAN-13 (13) with a correct check digit."""
    digits = re.sub(r"\D", "", str(value or ""))
    if len(digits) not in (12, 13):
        return False
    body, check = digits[:-1], int(digits[-1])
    # Weights 3,1,3… from the right of the body
    total = sum(int(digit) * (3 if index % 2 == 0 else 1) for index, digit in enumerate(reversed(body)))
    return (10 - total % 10) % 10 == check


def _norm(text) -> str:
    from plane.utils.contract_works import normalize_name

    return normalize_name(text or "")


# ------------------------------------------------------------------- audit


def _scope(ctx, artist=None, release=None):
    """Audio tracks and releases in scope (an artist's, a release's)."""
    tracks = MusicTrack.objects.filter(workspace_id=ctx.workspace_id, parent_track__isnull=True).exclude(
        kind__in=[MusicTrack.Kind.MUSIC_VIDEO, MusicTrack.Kind.OTHER_VIDEO]
    )
    releases = MusicRelease.objects.filter(workspace_id=ctx.workspace_id)
    if artist:
        parties = MusicParty.objects.filter(workspace_id=ctx.workspace_id).filter(
            Q(id__in=_uuids([artist])) | Q(display_name__iexact=str(artist).strip())
        )
        tracks = tracks.filter(credits__party__in=parties).distinct()
        releases = releases.filter(Q(artists__in=parties) | Q(tracks__in=tracks)).distinct()
    if release:
        chosen = releases.filter(Q(id__in=_uuids([release])) | Q(title__iexact=str(release).strip()))
        releases = chosen
        tracks = tracks.filter(releases__in=chosen).distinct()
    return tracks, releases


def _uuids(values):
    from uuid import UUID

    found = []
    for value in values:
        try:
            found.append(str(UUID(str(value))))
        except ValueError:
            continue
    return found


def _result(rows, kind):
    return {"count": len(rows), "examples": rows[:EXAMPLES], "ids": [row["id"] for row in rows][:MAX_IDS], "kind": kind}


def audit(ctx, checks=None, artist=None, release=None) -> dict:
    _require(ctx)
    wanted = [check for check in (checks or CHECKS) if check in CHECKS] or list(CHECKS)
    tracks, releases = _scope(ctx, artist, release)
    track_rows = list(tracks.values("id", "title", "isrc", "release_date", "cover_url", *SHARE_FIELDS))
    track_ids = [row["id"] for row in track_rows]
    titles = {row["id"]: row["title"] for row in track_rows}
    slug = ctx.slug
    path = lambda track_id: f"/{slug}/music?track={track_id}"  # noqa: E731
    release_path = lambda release_id: f"/{slug}/music?release={release_id}"  # noqa: E731
    today = timezone.localdate()

    credits = defaultdict(list)
    for credit in MusicCredit.objects.filter(track_id__in=track_ids).values(
        "track_id", "role", "percentage", "publishing_share", "party_id", "party__display_name"
    ):
        credits[credit["track_id"]].append(credit)
    release_of = defaultdict(list)
    for link in MusicReleaseTrack.objects.filter(track_id__in=track_ids).values(
        "track_id", "release_id", "release__release_date", "release__cover_url"
    ):
        release_of[link["track_id"]].append(link)

    report: dict = {}

    if "uncovered_tracks" in wanted:
        links = ContractWorkLink.objects.filter(
            workspace_id=ctx.workspace_id, status=ContractWorkLink.Status.LINKED
        ).values("entity_type", "entity_id", "contract__fecha_fin_efectiva")
        live, expired = set(), set()
        by_release = defaultdict(list)
        for link in links:
            end = link["contract__fecha_fin_efectiva"]
            target = live if end is None or end >= today else expired
            if link["entity_type"] == ContractWorkLink.EntityType.MUSIC_RELEASE:
                by_release[link["entity_id"]].append(target is live)
            else:
                target.add(link["entity_id"])
        rows = []
        for track_id in track_ids:
            via_release = [ok for item in release_of[track_id] for ok in by_release.get(item["release_id"], [])]
            if track_id in live or any(via_release):
                continue
            only_expired = track_id in expired or (via_release and not any(via_release))
            rows.append(
                {
                    "id": str(track_id),
                    "title": titles[track_id],
                    "detail": "expired" if only_expired else "none",
                    "path": path(track_id),
                }
            )
        report["uncovered_tracks"] = _result(rows, "music_track")

    if "editorial_without_works" in wanted:
        contracts = Contract.objects.filter(
            workspace_id=ctx.workspace_id, es_editorial=True, file_asset__is_deleted=False
        )
        linked = set(
            ContractWorkLink.objects.filter(
                workspace_id=ctx.workspace_id, status=ContractWorkLink.Status.LINKED
            ).values_list("contract_id", flat=True)
        )
        pending = defaultdict(int)
        for contract_id in ContractWorkLink.objects.filter(
            workspace_id=ctx.workspace_id, status=ContractWorkLink.Status.SUGGESTED
        ).values_list("contract_id", flat=True):
            pending[contract_id] += 1
        rows = [
            {
                "id": str(contract.id),
                "title": contract.titulo,
                "detail": f"{pending[contract.id]} suggested" if pending[contract.id] else "none",
                "path": f"/{slug}/file-library/contracts?peek={contract.id}",
            }
            for contract in contracts.only("id", "titulo")
            if contract.id not in linked
        ]
        report["editorial_without_works"] = _result(rows, "contract")

    if "codes" in wanted:
        rows = []
        seen = defaultdict(list)
        for row in track_rows:
            code = (row["isrc"] or "").upper().replace("-", "").replace(" ", "")
            if not code:
                rows.append(
                    {"id": str(row["id"]), "title": row["title"], "detail": "isrc_missing", "path": path(row["id"])}
                )
            elif not ISRC_RE.match(code):
                rows.append(
                    {
                        "id": str(row["id"]),
                        "title": row["title"],
                        "detail": f"isrc_invalid:{row['isrc']}",
                        "path": path(row["id"]),
                    }
                )
            else:
                seen[code].append(row)
        for code, group in seen.items():
            if len(group) > 1:
                rows.extend(
                    {
                        "id": str(row["id"]),
                        "title": row["title"],
                        "detail": f"isrc_repeated:{code}",
                        "others": [str(other["id"]) for other in group if other["id"] != row["id"]],
                        "path": path(row["id"]),
                    }
                    for row in group
                )
        release_rows = []
        for item in releases.values("id", "title", "upc"):
            if not item["upc"]:
                release_rows.append(
                    {
                        "id": str(item["id"]),
                        "title": item["title"],
                        "detail": "upc_missing",
                        "path": release_path(item["id"]),
                    }
                )
            elif not valid_upc(item["upc"]):
                release_rows.append(
                    {
                        "id": str(item["id"]),
                        "title": item["title"],
                        "detail": f"upc_invalid:{item['upc']}",
                        "path": release_path(item["id"]),
                    }
                )
        report["codes"] = {**_result(rows, "music_track"), "releases": _result(release_rows, "music_release")}

    if "credits" in wanted:
        rows = []
        for track_id in track_ids:
            items = credits[track_id]
            problems = []
            shares = [
                item["publishing_share"]
                for item in items
                if item["role"] in PUBLISHING_ROLES and item["publishing_share"] is not None
            ]
            if shares and sum(shares) != Decimal("100"):
                problems.append(f"publishing_sum:{format(sum(shares).normalize(), 'f')}")
            if any((item["percentage"] or 0) > 100 or (item["publishing_share"] or 0) > 100 for item in items):
                problems.append("over_100")
            if not any(item["role"] == "PRIMARY_ARTIST" for item in items):
                problems.append("no_primary_artist")
            if not any(item["role"] in WRITER_ROLES for item in items):
                problems.append("no_writer")
            if problems:
                rows.append(
                    {
                        "id": str(track_id),
                        "title": titles[track_id],
                        "detail": ",".join(problems),
                        "path": path(track_id),
                    }
                )
        report["credits"] = _result(rows, "music_track")

    if "track_shares" in wanted:
        rows = []
        for row in track_rows:
            total = sum((row[field] or Decimal("0")) for field in SHARE_FIELDS)
            if total > 100:
                rows.append(
                    {
                        "id": str(row["id"]),
                        "title": row["title"],
                        "detail": f"sum:{format(total.normalize(), 'f')}",
                        "path": path(row["id"]),
                    }
                )
        report["track_shares"] = _result(rows, "music_track")

    if "contract_artist_mismatch" in wanted:
        rows = []
        links = ContractWorkLink.objects.filter(
            workspace_id=ctx.workspace_id,
            status=ContractWorkLink.Status.LINKED,
            entity_type=ContractWorkLink.EntityType.MUSIC_TRACK,
            entity_id__in=track_ids,
        ).select_related("contract")
        for link in links:
            contract = link.contract
            named = {_norm(name) for name in re.split(r",|;| y | & ", contract.artistas or "") if _norm(name)}
            named |= {_norm(contract.nombre_grupo)} - {""}
            credited = {
                _norm(item["party__display_name"]) for item in credits[link.entity_id] if item["role"] in ARTIST_ROLES
            }
            if named and credited and not (named & credited):
                rows.append(
                    {
                        "id": str(link.entity_id),
                        "title": titles.get(link.entity_id),
                        "detail": f"contract:{contract.titulo or contract.id}",
                        "contract_id": str(contract.id),
                        "path": path(link.entity_id),
                    }
                )
        report["contract_artist_mismatch"] = _result(rows, "music_track")

    if "tags" in wanted:
        credited = {
            item["party_id"]: item["party__display_name"]
            for track_id in track_ids
            for item in credits[track_id]
            if item["role"] in ARTIST_ROLES
        }
        tagged = set(
            FileTag.objects.filter(workspace_id=ctx.workspace_id, party_id__isnull=False).values_list(
                "party_id", flat=True
            )
        )
        rows = [
            {
                "id": str(party_id),
                "title": name,
                "detail": "artist_without_tag",
                "path": f"/{slug}/music?artist={party_id}",
            }
            for party_id, name in credited.items()
            if party_id not in tagged
        ]
        orphan = [
            {"id": str(tag.id), "title": tag.name, "detail": "tag_without_artist", "path": f"/{slug}/tags/{tag.id}/"}
            for tag in FileTag.objects.filter(
                workspace_id=ctx.workspace_id, kind=FileTag.Kind.ARTIST, party__isnull=True
            ).only("id", "name")
        ]
        report["tags"] = {**_result(rows, "music_artist"), "tags_without_artist": _result(orphan, "tag")}

    if "gaps" in wanted:
        with_tracks = set(MusicReleaseTrack.objects.filter(release__in=releases).values_list("release_id", flat=True))
        empty_releases = [
            {
                "id": str(item["id"]),
                "title": item["title"],
                "detail": "release_without_tracks",
                "path": release_path(item["id"]),
            }
            for item in releases.values("id", "title")
            if item["id"] not in with_tracks
        ]
        rows = []
        for row in track_rows:
            linked = release_of[row["id"]]
            problems = []
            if not linked:
                problems.append("no_release")
            if not row["release_date"] and not any(item["release__release_date"] for item in linked):
                problems.append("no_date")
            if not row["cover_url"] and not any(item["release__cover_url"] for item in linked):
                problems.append("no_cover")
            if problems:
                rows.append(
                    {"id": str(row["id"]), "title": row["title"], "detail": ",".join(problems), "path": path(row["id"])}
                )
        report["gaps"] = {**_result(rows, "music_track"), "releases": _result(empty_releases, "music_release")}

    return {
        "scope": {"artist": artist, "release": release, "tracks": len(track_ids), "releases": releases.count()},
        "checks": report,
    }


# ------------------------------------------------------------------- fixes

TRACK_FIELDS = {
    "title": "text",
    "version": "text",
    "isrc": "isrc",
    "isrc_video": "isrc",
    "release_date": "date",
    "original_release_date": "date",
    "recording_date": "date",
    "language": "text",
    "explicit": "bool",
    "instrumental": "bool",
    "p_line": "text",
    "c_line": "text",
    "artist_percentage": "share",
    "record_label_percentage": "share",
    "distributor_percentage": "share",
    "aggregator_percentage": "share",
    "writer_percentage": "share",
}
RELEASE_FIELDS = {
    "title": "text",
    "version": "text",
    "upc": "upc",
    "release_date": "date",
    "original_release_date": "date",
    "label_name": "text",
    "catalog_number": "text",
    "p_line": "text",
    "c_line": "text",
    "copyright_year": "year",
    "language": "text",
}
CREDIT_FIELDS = {"percentage": "share", "publishing_share": "share"}
ENTITIES = {
    "music_track": (MusicTrack, TRACK_FIELDS),
    "music_release": (MusicRelease, RELEASE_FIELDS),
    "music_credit": (MusicCredit, CREDIT_FIELDS),
}


def _clean(kind, field, value):
    """The value as stored, or ActionError. Blank clears (except an ISRC:
    a missing one is reported, never filled or invented)."""
    if value is None or value == "":
        if kind in ("isrc", "upc", "date", "share", "year"):
            return None if kind in ("date", "share", "year") else ""
        return ""
    text = str(value).strip()
    if kind == "isrc":
        code = text.upper().replace("-", "").replace(" ", "")
        if not ISRC_RE.match(code):
            raise ActionError(f"{field}: «{value}» is not a valid ISRC.")
        return code
    if kind == "upc":
        if not valid_upc(text):
            raise ActionError(f"{field}: «{value}» is not a valid UPC/EAN.")
        return re.sub(r"\D", "", text)
    if kind == "date":
        try:
            return date.fromisoformat(text[:10])
        except ValueError:
            raise ActionError(f"{field}: «{value}» is not a date (YYYY-MM-DD).")
    if kind == "share":
        try:
            number = Decimal(text.rstrip("%"))
        except InvalidOperation:
            raise ActionError(f"{field}: «{value}» is not a percentage.")
        if not 0 <= number <= 100:
            raise ActionError(f"{field}: {value} must be between 0 and 100.")
        return number
    if kind == "year":
        if not text.isdigit() or not 1900 <= int(text) <= 2100:
            raise ActionError(f"{field}: «{value}» is not a year.")
        return int(text)
    if kind == "bool":
        return text.lower() in ("true", "1", "yes", "sí", "si")
    return text[:500]


def fixes_preview(ctx, items) -> dict:
    """Before → after per field, checked; no source, no change."""
    _require(ctx)
    rows, problems = [], []
    for index, item in enumerate([item for item in (items or []) if isinstance(item, dict)][:200]):
        entity = item.get("entity")
        try:
            if entity not in ENTITIES:
                raise ActionError(f"Unknown entity «{entity}».")
            if not str(item.get("source") or "").strip():
                raise ActionError("Every correction needs its source (contract text, another song, the user).")
            model, fields = ENTITIES[entity]
            obj = model.objects.filter(workspace_id=ctx.workspace_id, id__in=_uuids([item.get("id")])).first()
            if obj is None:
                raise ActionError(f"{entity} {item.get('id')} not found.")
            changes = []
            for field, value in (item.get("changes") or {}).items():
                if field not in fields:
                    raise ActionError(f"«{field}» can't be changed here.")
                after = to_json(_clean(fields[field], field, value))
                before = to_json(getattr(obj, field))
                if fields[field] == "isrc" and before and not after:
                    raise ActionError("An ISRC is never cleared from here.")
                if fields[field] == "isrc" and not before and item.get("source_type") != "user":
                    # Only a code the user gives is written; otherwise it is reported
                    raise ActionError("A missing ISRC is reported, not filled: ask the user for the code.")
                if before != after:
                    changes.append({"field": field, "before": before, "after": after})
            video = item.get("add_video") if entity == "music_track" else None
            if not changes and not video:
                continue
            rows.append(
                {
                    "index": index,
                    "entity": entity,
                    "id": str(obj.id),
                    "title": getattr(obj, "title", None) or str(getattr(obj, "party", "") or obj.id),
                    "changes": changes,
                    "add_video": video or None,
                    "source": str(item["source"])[:300],
                    "source_type": item.get("source_type"),
                }
            )
        except ActionError as error:
            problems.append({"index": index, "error": str(error)})
    return {"items": rows, "problems": problems or None}


@register_apply(AssistantAction.Kind.CATALOG_FIXES)
def catalog_fixes(ctx, request, data) -> AssistantAction:
    checked = fixes_preview(ctx, data.get("items"))
    if checked["problems"]:
        raise ActionError(checked["problems"][0]["error"])
    if not checked["items"]:
        raise ActionError("The catalog already has those values.")
    done = []
    with transaction.atomic():
        for row in checked["items"]:
            model, fields = ENTITIES[row["entity"]]
            obj = model.objects.select_for_update().get(id=row["id"])
            names = [change["field"] for change in row["changes"]]
            before = snapshot(obj, names)
            for change in row["changes"]:
                setattr(obj, change["field"], _clean(fields[change["field"]], change["field"], change["after"]))
            if names:
                obj.save()
            entry = {"entity": row["entity"], "id": row["id"], "title": row["title"], "source": row["source"]}
            entry["changes"] = diff(before, snapshot(obj, names))
            video = row.get("add_video")
            if video and video.get("video_url"):
                isrc_video = _clean("isrc", "video_isrc", video.get("isrc")) if video.get("isrc") else ""
                created = MusicTrack.objects.create(
                    workspace_id=ctx.workspace_id,
                    parent_track=obj,
                    title=video.get("title") or obj.title,
                    kind=MusicTrack.Kind.MUSIC_VIDEO,
                    status=MusicTrack.Status.DRAFT,
                    isrc_video=isrc_video,
                    release_date=_clean("date", "video_release_date", video.get("release_date")),
                )
                MusicLink.objects.create(
                    workspace_id=ctx.workspace_id,
                    track=created,
                    kind=MusicLink.Kind.MUSIC_VIDEO,
                    name="Music video",
                    url=str(video["video_url"])[:1000],
                    isrc=isrc_video,
                )
                entry["video_id"] = str(created.id)
            done.append(entry)
        fields = sum(len(entry["changes"]) for entry in done)
        summary = (
            f"Corrigió «{done[0]['title']}» en el catálogo"
            if len(done) == 1
            else f"Corrigió {fields} dato(s) en {len(done)} elementos del catálogo"
        )
        return AssistantAction.objects.create(
            workspace_id=ctx.workspace_id,
            kind=AssistantAction.Kind.CATALOG_FIXES,
            summary=summary[:300],
            payload=data,
            result={"items": done, "path": f"/{ctx.slug}/music"},
        )


@register_undo(AssistantAction.Kind.CATALOG_FIXES)
def undo_catalog_fixes(action, user, origin, cookie):
    conflicts = []
    for entry in reversed((action.result or {}).get("items") or []):
        model, _ = ENTITIES[entry["entity"]]
        obj = model.objects.select_for_update().filter(id=entry["id"]).first()
        if obj is not None and entry["changes"]:
            reverted, clashes = revert_fields(obj, entry["changes"])
            conflicts.extend({**clash, "name": entry.get("title")} for clash in clashes)
            if reverted:
                obj.save()
        if entry.get("video_id"):
            MusicTrack.objects.filter(id=entry["video_id"]).delete()
    return {"conflicts": conflicts} if conflicts else None
