# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Reports the assistant turns into pages, built from the database.

A report about a tag (an artist, a group, a kind of document) lists its
contracts, songs and releases in tables, with real dates, video and
streaming links, and a mention per row. Building it here keeps every value
exact and spares the model from copying hundreds of rows into a page.
"""

from django.db.models import Prefetch
from django.utils import timezone

from plane.db.models import Contract, FileTag, MusicLink, MusicRelease, MusicTrack
from plane.utils.shared_tags import entities_for_tag

MAX_ROWS = {"contract": 300, "music_track": 500, "music_release": 300}
SECTIONS = ("contracts", "tracks", "releases")

STATUS = {"VIGENTE": "Vigente", "FINALIZADO": "Finalizado", "NO_ESPECIFICADO": "Sin estatus"}
CONTRACT_TYPE = {
    "ARRENDAMIENTOS": "Arrendamiento",
    "ALQUILERES": "Alquiler",
    "VEHICULOS": "Vehículos",
    "SERVICIOS": "Servicios",
    "ARTISTAS": "Artistas",
}


def _cell(value) -> str:
    """Table cells can't hold pipes or line breaks."""
    if value in (None, ""):
        return "—"
    return " ".join(str(value).replace("|", "/").split())


def _date(value) -> str:
    return value.isoformat() if value else "—"


def _mention(kind: str, label: str, identifier) -> str:
    label = " ".join(str(label or "").replace("[", "(").replace("]", ")").split())[:150] or "—"
    return f":{kind}[{label}]{{name={identifier}}}"


def _links(links, *, video: bool) -> list[str]:
    out = []
    for link in links:
        if (link.kind == MusicLink.Kind.MUSIC_VIDEO) != video:
            continue
        label = link.platform or link.name or ("Video" if video else "Enlace")
        out.append(f"[{_cell(label)}]({link.url})")
    return out


def _ids(groups: dict, kind: str) -> list[str]:
    return [card["id"] for card in (groups.get(kind) or {}).get("items") or []]


def build_tag_report(ctx, tag: FileTag, include=SECTIONS, date_from=None, date_to=None) -> dict:
    include = [section for section in include or SECTIONS if section in SECTIONS] or list(SECTIONS)
    types = {"contracts": "contract", "tracks": "music_track", "releases": "music_release"}
    lines = [f"# Reporte de {_cell(tag.name)}", ""]
    period = ""
    if date_from or date_to:
        period = f" (del {_date(date_from)} al {_date(date_to)})"
    lines += [f"Generado el {timezone.localdate().isoformat()} con los datos del workspace{period}.", ""]
    counts: dict[str, int] = {}

    for section in include:
        kind = types[section]
        # Contracts aren't dated in the tag view, so the period only narrows songs and releases.
        dated = date_from or date_to
        groups = entities_for_tag(
            ctx,
            tag,
            [kind],
            date_from=date_from if dated and kind != "contract" else None,
            date_to=date_to if dated and kind != "contract" else None,
            limit_per_type=MAX_ROWS[kind],
        )
        ids = _ids(groups, kind)
        counts[section] = (groups.get(kind) or {}).get("count", 0)
        if section == "contracts":
            lines += _contracts(ids, counts[section])
        elif section == "tracks":
            # The catalog's own date for each song (its release's date when the
            # song has none), as the tag view shows it, newest first.
            dates = {card["id"]: card.get("date") for card in (groups.get(kind) or {}).get("items") or []}
            lines += _tracks(ids, counts[section], dates)
        else:
            lines += _releases(ids, counts[section])

    return {"title": f"Reporte de {tag.name}", "markdown": "\n".join(lines).strip(), "counts": counts}


def _truncated(shown: int, total: int) -> list[str]:
    return [f"_Se muestran {shown} de {total}._", ""] if total > shown else []


def _contracts(ids, total) -> list[str]:
    rows = Contract.objects.filter(id__in=ids).order_by("-fecha_fin_efectiva", "-fecha_inicio")
    lines = [f"## Contratos ({total})", ""]
    if not ids:
        return lines + ["Sin contratos con esta etiqueta.", ""]
    lines += [
        "| Contrato | Tipo | Inicio | Fin | Fin efectivo | Estatus | Editorial |",
        "|---|---|---|---|---|---|---|",
    ]
    for contract in rows:
        title = contract.titulo or (contract.file_asset.attributes or {}).get("name") or "Contrato"
        lines.append(
            "| "
            + " | ".join(
                [
                    _mention("contract", title, contract.id),
                    _cell(CONTRACT_TYPE.get(contract.tipo_contrato or "", contract.tipo_contrato)),
                    _date(contract.fecha_inicio),
                    _date(contract.fecha_fin),
                    _date(contract.fecha_fin_efectiva),
                    _cell(STATUS.get(contract.estatus_contrato or "", contract.estatus_contrato)),
                    "Sí" if contract.es_editorial else "No",
                ]
            )
            + " |"
        )
    return lines + [""] + _truncated(len(ids), total)


def _tracks(ids, total, dates=None) -> list[str]:
    dates = dates or {}
    videos = MusicTrack.objects.filter(kind__in=[MusicTrack.Kind.MUSIC_VIDEO, MusicTrack.Kind.OTHER_VIDEO]).prefetch_related(
        "links"
    )
    found = {
        str(track.id): track
        for track in MusicTrack.objects.filter(id__in=ids).prefetch_related("links", Prefetch("videos", queryset=videos))
    }
    rows = [found[track_id] for track_id in ids if track_id in found]
    lines = [f"## Canciones ({total})", ""]
    if not ids:
        return lines + ["Sin canciones con esta etiqueta.", ""]
    lines += ["| Canción | Lanzamiento | ISRC | Estado | Videos | Enlaces |", "|---|---|---|---|---|---|"]
    for track in rows:
        video_links = _links(track.links.all(), video=True)
        for video in track.videos.all():
            found = [f"[{_cell(link.platform or link.name or video.title)}]({link.url})" for link in video.links.all()]
            details = [
                f"ISRC {video.isrc_video or video.isrc}" if (video.isrc_video or video.isrc) else "",
                f"UPC {video.upc}" if video.upc else "",
                _date(video.release_date) if video.release_date else "",
            ]
            suffix = ", ".join(value for value in details if value)
            label = " · ".join(found) or _cell(video.title)
            video_links.append(f"{label} ({suffix})" if suffix else label)
        title = f"{track.title} ({track.version})" if track.version else track.title
        lines.append(
            "| "
            + " | ".join(
                [
                    _mention("music_track", title, track.id),
                    (dates.get(str(track.id)) or "")[:10] or _date(track.release_date),
                    _cell(track.isrc),
                    _cell(track.status.title() if track.status else ""),
                    " · ".join(video_links) or "—",
                    " · ".join(_links(track.links.all(), video=False)) or "—",
                ]
            )
            + " |"
        )
    return lines + [""] + _truncated(len(ids), total)


def _releases(ids, total) -> list[str]:
    rows = MusicRelease.objects.filter(id__in=ids).prefetch_related("links").order_by("-release_date", "title")
    lines = [f"## Lanzamientos ({total})", ""]
    if not ids:
        return lines + ["Sin lanzamientos con esta etiqueta.", ""]
    lines += ["| Lanzamiento | Tipo | Fecha | UPC | Enlaces |", "|---|---|---|---|---|"]
    for release in rows:
        links = [f"[{_cell(link.platform or link.name)}]({link.url})" for link in release.links.all()]
        lines.append(
            "| "
            + " | ".join(
                [
                    _mention("music_release", release.title, release.id),
                    _cell(release.get_release_type_display()),
                    _date(release.release_date),
                    _cell(release.upc),
                    " · ".join(links) or "—",
                ]
            )
            + " |"
        )
    return lines + [""] + _truncated(len(ids), total)
