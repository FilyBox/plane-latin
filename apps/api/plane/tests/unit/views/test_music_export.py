# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Catalog export: the column registry (default, all, specific), credits in
the distributor format ("Name <Role>, …") and their round trip through the
importer, links / contracts / extra data / tags, the selected-songs filter
and a query count that doesn't grow with the number of songs."""

import csv
from datetime import date
from decimal import Decimal
from io import BytesIO, StringIO

import pytest
from django.db import connection
from django.test.utils import CaptureQueriesContext
from openpyxl import load_workbook

from plane.app.views.music.base import IMPORT_FIELDS, MusicImportEndpoint, _infer_mapping, _urls_in
from plane.app.views.music.export import BASIC, COLUMNS, LEGACY_HEADERS, build_rows, parse_columns
from plane.app.views.music.importer import run_import
from plane.db.models import (
    Contract,
    ContractWorkLink,
    EntityTagLink,
    FileAsset,
    FileTag,
    MusicCompany,
    MusicCredit,
    MusicCreditRole,
    MusicDistribution,
    MusicGenre,
    MusicImportRun,
    MusicLink,
    MusicParty,
    MusicRelease,
    MusicReleaseArtist,
    MusicReleaseTrack,
    MusicTrack,
    MusicTrackGenre,
    MusicTrackImport,
    WorkspaceFeature,
)
from plane.utils.music_credits import CreditTagger, RoleCatalog, camel_tag, format_tagged, tagged_entries

LEGACY = [
    "Song", "Version", "Artists", "Featured artists", "ISRC", "Status", "Release date", "Releases", "UPC",
    "Genres", "Videos", "Video ISRCs", "Video dates", "Video URLs", "Credits and rights", "Companies and shares",
    "Ownership", "P line", "C line",
]


@pytest.fixture
def music(workspace):
    WorkspaceFeature.objects.create(workspace=workspace, key=WorkspaceFeature.FeatureKey.MUSIC_CATALOG, is_enabled=True)
    return workspace


def _url(workspace):
    return f"/api/workspaces/{workspace.slug}/music/reports/"


def _csv(response):
    text = b"".join(response.streaming_content if response.streaming else [response.content]).decode("utf-8")
    assert text.startswith("﻿")
    return list(csv.reader(StringIO(text.lstrip("﻿"))))


def _credit(workspace, track, name, role, detail=""):
    party, _ = MusicParty.objects.get_or_create(workspace=workspace, display_name=name)
    return MusicCredit.objects.create(workspace=workspace, track=track, party=party, role=role, role_detail=detail)


def _run(workspace, rows, mapping, **options):
    options.setdefault("strategy", "update")
    result = None
    for event in run_import(MusicImportEndpoint(), workspace, rows, 1, mapping, **options):
        if event[0] == "result":
            result = event[1]
    return result


def _export(workspace, keys, queryset=None):
    queryset = queryset or MusicTrack.objects.filter(workspace=workspace, parent_track__isnull=True)
    headers, rows = build_rows(workspace, queryset, keys)
    return [dict(zip(headers, row)) for row in rows], headers


@pytest.fixture
def mixed_song(workspace):
    """A song with every kind of credit."""
    MusicCreditRole.objects.create(
        workspace=workspace, key="LEAD_VOCALS", label="Lead Vocals", category="PERFORMER", source_tags=["LeadVocals"]
    )
    MusicCreditRole.objects.create(workspace=workspace, key="BAJO_QUINTO", label="Bajo Quinto", category="PERFORMER")
    MusicCreditRole.objects.create(
        workspace=workspace,
        key="ASSISTANT_MIXING_ENGINEER",
        label="Assistant Mixing Engineer",
        category="ENGINEER",
        source_tags=["AssistantMixingEngineer"],
    )
    track = MusicTrack.objects.create(workspace=workspace, title="Él Soy Yo", isrc="MXA3Y2400193")
    _credit(workspace, track, "Los Primos MX", "PRIMARY_ARTIST")
    _credit(workspace, track, "Koray", "FEATURED_ARTIST")
    _credit(workspace, track, "Francisco Iram", "LEAD_VOCALS")
    _credit(workspace, track, "Jose Ramon", "BAJO_QUINTO")
    _credit(workspace, track, "Ana", "PERFORMER")
    _credit(workspace, track, "Miguel Ángel Estrada", "LYRICIST")
    _credit(workspace, track, "Miguel Ángel Estrada", "COMPOSER")
    _credit(workspace, track, 'Sergio "Keko" Vazquez', "MIXER")
    _credit(workspace, track, 'Sergio "Keko" Vazquez', "MASTERING_ENGINEER")
    _credit(workspace, track, "Carlos Avitia", "RECORDING_ENGINEER")
    _credit(workspace, track, "Pp Montoya", "A_AND_R")
    _credit(workspace, track, "Luis", "EXECUTIVE_PRODUCER")
    _credit(workspace, track, "Lola", "CO_PRODUCER")
    _credit(workspace, track, "Eva", "ASSISTANT_MIXING_ENGINEER")
    _credit(workspace, track, "Boby Sigala", "PRODUCER")
    return track


# ── Column selection ─────────────────────────────────────────────────────────


@pytest.mark.unit
def test_parse_columns():
    assert parse_columns(None) == (BASIC, True)
    assert parse_columns("") == (BASIC, True)
    keys, legacy = parse_columns("all")
    assert keys == [column.key for column in COLUMNS] and legacy is False
    assert parse_columns("isrc, title,nope,isrc") == (["isrc", "title"], False)
    with pytest.raises(ValueError):
        parse_columns("nope")
    assert [LEGACY_HEADERS[key] for key in BASIC] == LEGACY


@pytest.mark.unit
def test_headers_map_back_to_import_fields():
    """An exported file maps itself on import (no manual mapping)."""
    headers = [column.header for column in COLUMNS]
    mapping = _infer_mapping(headers, IMPORT_FIELDS)
    expected = {
        "track.title": "Track Name",
        "track.version": "Track Version",
        "track.status": "Track Status",
        "track.kind": "Track Kind",
        "track.isrc": "Isrc",
        "track.isrc_video": "Isrc Video",
        "track.upc": "Track UPC",
        "track.catalog": "Catalog",
        "track.external_id": "Track Id",
        "track.release_date": "Track Release Date",
        "track.original_release_date": "Original Release Date",
        "track.duration_ms": "Duration",
        "track.language": "Audio Language",
        "track.country_of_recording": "Country Of Recording",
        "track.explicit": "Explicit Lyrics",
        "track.digital_format": "Digital Format",
        "track.tiktok_preview_start_ms": "Sample Start Time",
        "track.p_line": "Track P Line",
        "track.c_line": "Track C Line",
        "track.ownership": "Ownership",
        "track.us_publishing_obligations": "US Publishing Obligations",
        "track.recoupment": "Recoupment",
        "track.lyrics": "Lyrics",
        "track.aggregator_percentage": "Aggregator Percentage",
        "track.writer_percentage": "Writer Percentage",
        "release.title": "Product Title",
        "release.version": "Product Version",
        "release.type": "Release Type",
        "release.status": "Product Status",
        "release.upc": "UPC",
        "release.external_id": "Product Id",
        "release.catalog_number": "Catalog Number",
        "release.release_date": "Release Date",
        "release.language": "Primary Metadata Language",
        "release.p_line": "Product P Line",
        "release.c_line": "Product C Line",
        "release.artists": "Product Display Artist",
        "release.track_number": "Track Number",
        "release.disc_number": "Track Volume",
        "artists": "Track Display Artist",
        "featured_artists": "Featured Artists",
        "writers": "Writers",
        "producers": "Producers",
        "contributors": "Non-Performing Contributors",
        "performers": "Performing Contributors",
        "publishers": "Publishers/Collection Societies",
        "record_label": "Label",
        "aggregator": "Aggregator",
        "distributor": "Distributor",
        "genres": "Track Genre",
        "track.video_url": "Video URL",
        "track.video_release_date": "Video Release Date",
        "track.streaming_url": "Track Play Link",
    }
    assert {field: mapping.get(field) for field in expected} == expected


@pytest.mark.django_db
def test_default_export_keeps_the_original_columns(session_client, music, mixed_song):
    response = session_client.get(_url(music), {"format": "csv"})
    assert response.status_code == 200
    rows = _csv(response)
    assert rows[0] == LEGACY
    row = dict(zip(rows[0], rows[1]))
    assert row["Song"] == "Él Soy Yo" and row["Artists"] == "Los Primos MX"
    assert "Lead Vocals: -%, publishing -%" in row["Credits and rights"]


@pytest.mark.django_db
def test_specific_all_and_unknown_columns(session_client, music, mixed_song):
    mixed_song.metadata = {"extra": {"Price Tier": "$3.50", "Vevo": "x"}}
    mixed_song.save()
    response = session_client.get(_url(music), {"format": "csv", "columns": "isrc,title,writers"})
    assert _csv(response)[0] == ["Isrc", "Track Name", "Writers"]
    everything = _csv(session_client.get(_url(music), {"format": "csv", "columns": "all"}))
    headers = everything[0]
    assert len(headers) == len(COLUMNS) - 1 + 2
    assert "Extra: Price Tier" in headers and "Extra: Vevo" in headers and "Extra: …" not in headers
    assert dict(zip(headers, everything[1]))["Extra: Price Tier"] == "$3.50"
    assert session_client.get(_url(music), {"format": "csv", "columns": "nope"}).status_code == 400
    described = session_client.get(_url(music), {"describe": "1"}).json()
    assert described["presets"]["basic"] == BASIC
    assert described["extra_keys"] == ["Price Tier", "Vevo"]
    assert {"key": "writers", "header": "Writers", "group": "credits"} in described["columns"]


@pytest.mark.django_db
def test_selected_songs_only(session_client, music):
    first = MusicTrack.objects.create(workspace=music, title="Uno")
    MusicTrack.objects.create(workspace=music, title="Dos")
    response = session_client.get(_url(music), {"format": "csv", "columns": "title", "ids": str(first.id)})
    assert _csv(response) == [["Track Name"], ["Uno"]]
    assert 'music-catalog-selected.csv' in response["Content-Disposition"]


# ── Credits format ───────────────────────────────────────────────────────────


@pytest.mark.unit
def test_tags_for_roles():
    tagger = CreditTagger([{"key": "VOZ", "label": "Voz principal", "category": "PERFORMER", "source_tags": []}])
    assert tagger.tags_for("MIXER") == ["MixingEngineer"]
    assert tagger.tags_for("EXECUTIVE_PRODUCER") == ["Executiveproducer"]
    assert tagger.tags_for("A_AND_R") == ["AR"]
    assert tagger.tags_for("ARRANGER") == ["Arranger"]
    assert tagger.tags_for("VOZ") == ["VozPrincipal"]
    # The original tag kept as the detail wins, one entry per tag
    assert tagger.tags_for("WRITER", "Lyricist, Composer") == ["Lyricist", "Composer"]
    assert tagger.tags_for("UNKNOWN_KEY") == ["UnknownKey"]
    assert camel_tag("Bajo Quinto") == "BajoQuinto" and camel_tag("Co-Producer") == "CoProducer"
    assert format_tagged([("Ana <x>", "Tuba"), ("", "Tuba"), ("Luis", None)]) == "Ana (x) <Tuba>, Luis"


@pytest.mark.django_db
def test_credit_columns_in_distributor_format(workspace, mixed_song):
    MusicDistribution.objects.create(
        workspace=workspace,
        track=mixed_song,
        company=MusicCompany.objects.create(
            workspace=workspace, kind="PUBLISHER", name="EDITORA SOLMAR", notes="PRO: BMI"
        ),
    )
    MusicDistribution.objects.create(
        workspace=workspace,
        track=mixed_song,
        company=MusicCompany.objects.create(workspace=workspace, kind="PUBLISHER", name="Top Music"),
    )
    rows, _ = _export(
        workspace,
        ["artists", "featured_artists", "performing_contributors", "non_performing_contributors", "writers",
         "producers", "publishers"],
    )
    row = rows[0]
    assert row["Track Display Artist"] == "Los Primos MX"
    assert row["Featured Artists"] == "Koray"
    assert row["Performing Contributors"] == "Francisco Iram <LeadVocals>, Jose Ramon <BajoQuinto>, Ana <Performer>"
    assert row["Non-Performing Contributors"] == (
        'Sergio "Keko" Vazquez <MixingEngineer>, Sergio "Keko" Vazquez <MasteringEngineer>, '
        "Carlos Avitia <RecordingEngineer>, Pp Montoya <AR>, Luis <Executiveproducer>, Lola <CoProducer>, "
        "Eva <AssistantMixingEngineer>"
    )
    assert row["Writers"] == "Miguel Ángel Estrada <Lyricist>, Miguel Ángel Estrada <Composer>"
    assert row["Producers"] == "Boby Sigala"
    assert row["Publishers/Collection Societies"] == "EDITORA SOLMAR <BMI>, Top Music"


@pytest.mark.django_db
def test_tagged_columns_parse_back_to_the_same_roles(workspace, mixed_song):
    """Export -> the importer's tag parser -> the same (name, role) pairs."""
    rows, _ = _export(workspace, ["contributors_all", "performing_contributors", "non_performing_contributors"])
    roles = MusicCreditRole.objects.filter(workspace=workspace).values("key", "label", "category", "source_tags")
    catalog = RoleCatalog(roles)
    credits = MusicCredit.objects.filter(track=mixed_song).select_related("party")
    stored = {(credit.party.display_name, credit.role) for credit in credits}

    def parsed(text, field):
        return {(name, catalog.resolve(tag, field)[0]) for name, tag in tagged_entries(text)}

    assert parsed(rows[0]["Contributors (all roles)"], "contributors") == stored
    split = parsed(rows[0]["Performing Contributors"], "performers") | parsed(
        rows[0]["Non-Performing Contributors"], "contributors"
    )
    assert split == {pair for pair in stored if pair[1] not in
                     ("PRIMARY_ARTIST", "FEATURED_ARTIST", "LYRICIST", "COMPOSER", "PRODUCER")}


SAMPLE = {
    "Track Name": "Sólo Dejé Yo A Mi Padre",
    "Isrc": "MXA3Y2400261",
    "Track Display Artist": "Cano Aguilar",
    "Writers": "Reyna José <Lyricist>, Reyna José <Composer>",
    "Publishers/Collection Societies": "EDITORA SOLMAR <BMI>",
    "Performing Contributors": (
        "Giovanni Jesus Martínez Lara <Accordion>, Jose Ramon Trejo Montes <BajoQuinto>, "
        "Cano Aguilar <LeadVocals>, Francisco Alejandro Dominguez Lucero <Vocals>, Juan <Chorus>"
    ),
    "Non-Performing Contributors": (
        'Pp Montoya <AR>, Alex "Carajillo" Navarro <AR>, Francisco Lizarraga Lizarraga <MusicalDirector>, '
        'Sergio "Keko" Vazquez <VocalProducer>, Sergio "Keko" Vazquez <RecordingEngineer>, '
        'Sergio "Keko" Vazquez <MixingEngineer>, Sergio "Keko" Vazquez <MasteringEngineer>, '
        "Luis <Executiveproducer>, Lola <CoProducer>, Ana <AssistantRecordingEngineer>, Zoe <FilmDirector>, "
        "Eva <VocalArranger>, Pepe <Librettist>, Abel <VideoProducer>"
    ),
    "Producers": "Cano Aguilar",
}


@pytest.mark.django_db
def test_distributor_file_round_trip_is_identical(workspace):
    """A row of the distributor's file, imported and exported again, gives
    back the same credit cells."""
    mapping = _infer_mapping(list(SAMPLE), IMPORT_FIELDS)
    result = _run(workspace, [SAMPLE], mapping)
    assert result["errors"] == [], result["errors"]
    rows, _ = _export(
        workspace,
        ["title", "isrc", "artists", "writers", "publishers", "performing_contributors",
         "non_performing_contributors", "producers"],
    )
    assert rows[0] == SAMPLE

    # …and that export imports back to the same credits
    track = MusicTrack.objects.get(workspace=workspace)
    before = {(c.party.display_name, c.role, c.role_detail) for c in track.credits.select_related("party")}
    MusicTrack.all_objects.filter(workspace=workspace).delete()
    exported_mapping = _infer_mapping(list(rows[0]), IMPORT_FIELDS)
    assert _run(workspace, [rows[0]], exported_mapping)["errors"] == []
    track = MusicTrack.objects.get(workspace=workspace)
    assert {(c.party.display_name, c.role, c.role_detail) for c in track.credits.select_related("party")} == before


# ── Links, contracts, extra data, tags ───────────────────────────────────────


def _full_song(workspace, index, contract=None):
    track = MusicTrack.objects.create(
        workspace=workspace,
        title=f"Song {index}",
        isrc=f"USRC1760{index:04d}",
        upc='="0198704887383"',
        duration_ms=196000,
        tiktok_preview_start_ms=47000,
        explicit=True,
        aggregator_percentage=Decimal("50.0000"),
        metadata={"external_ids": {"track_id": f"t{index}"}, "extra": {"Price Tier": "$3.50"}},
    )
    release = MusicRelease.objects.create(
        workspace=workspace, title=f"Album {index}", upc=f"19870488{index:04d}", release_type="EP",
        release_date=date(2025, 12, 4), metadata={"external_ids": {"product_id": f"p{index}"}},
    )
    MusicReleaseTrack.objects.create(workspace=workspace, release=release, track=track, disc_number=1, track_number=3)
    artist = MusicParty.objects.create(workspace=workspace, display_name=f"Artist {index}")
    MusicReleaseArtist.objects.create(workspace=workspace, release=release, party=artist)
    _credit(workspace, track, f"Artist {index}", "PRIMARY_ARTIST")
    genre = MusicGenre.objects.create(workspace=workspace, name=f"Genre {index}")
    MusicTrackGenre.objects.create(workspace=workspace, track=track, genre=genre)
    label = MusicCompany.objects.create(workspace=workspace, kind="RECORD_LABEL", name=f"Label {index}")
    MusicDistribution.objects.create(workspace=workspace, track=track, company=label)
    for kind, url in (
        ("STREAMING", f"https://open.spotify.com/track/{index}"),
        ("STREAMING", f"https://music.apple.com/{index}"),
        ("SOCIAL", f"https://www.tiktok.com/@x/{index}"),
    ):
        MusicLink.objects.create(workspace=workspace, track=track, kind=kind, platform="P", name="n", url=url)
    video = MusicTrack.objects.create(
        workspace=workspace, parent_track=track, kind="MUSIC_VIDEO", title=f"Video {index}", isrc_video=f"V{index}",
    )
    MusicLink.objects.create(
        workspace=workspace, track=video, kind="MUSIC_VIDEO", name="YouTube", url=f"https://youtu.be/{index}"
    )
    run = MusicImportRun.objects.create(workspace=workspace, source_name="ReleasesExport.csv")
    MusicTrackImport.objects.create(workspace=workspace, track=track, import_run=run, action="CREATED", row_number=7)
    tag = FileTag.objects.create(workspace=workspace, name=f"Tag {index}")
    EntityTagLink.objects.create(workspace=workspace, tag=tag, entity_type="music_track", entity_id=track.id)
    if contract:
        ContractWorkLink.objects.create(
            workspace=workspace, contract=contract, entity_type="music_release", entity_id=release.id,
            status="LINKED", rights_type="DISTRIBUCION",
        )
    return track


def _contract(workspace, name, **fields):
    asset = FileAsset.objects.create(
        workspace=workspace,
        asset=f"{workspace.slug}/{name}.pdf",
        attributes={"name": f"{name}.pdf", "size": 1, "type": "application/pdf"},
        entity_type="FILE_LIBRARY",
    )
    return Contract.objects.create(workspace=workspace, file_asset=asset, titulo=name, **fields)


@pytest.mark.django_db
def test_links_contracts_extra_and_tags(workspace):
    on_release = _contract(
        workspace, "Distribución Top", estatus_contrato="VIGENTE", fecha_fin_efectiva=date(2027, 1, 1)
    )
    track = _full_song(workspace, 1, contract=on_release)
    direct = _contract(workspace, "Master Cano")
    ContractWorkLink.objects.create(
        workspace=workspace, contract=direct, entity_type="music_track", entity_id=track.id, status="LINKED",
        rights_type="MASTER",
    )
    suggested = _contract(workspace, "Sugerido")
    ContractWorkLink.objects.create(
        workspace=workspace, contract=suggested, entity_type="music_track", entity_id=track.id, status="SUGGESTED",
    )
    rows, headers = _export(workspace, [column.key for column in COLUMNS])
    row = rows[0]
    assert row["Track Play Link"] == "https://open.spotify.com/track/1; https://music.apple.com/1"
    assert row["Social Links"] == "https://www.tiktok.com/@x/1"
    assert row["Video URL"] == "https://youtu.be/1" and row["Videos"] == "Video 1" and row["Video ISRCs"] == "V1"
    assert row["Contracts"] == "Master Cano; Distribución Top"
    assert row["Contract Rights"] == "Master; Distribución"
    assert row["Contract Status"] == "No especificado; Vigente"
    assert row["Contract End Date"] == "-; 2027-01-01"
    assert row["Extra: Price Tier"] == "$3.50"
    assert row["Tags"] == "Tag 1"
    assert (row["Track Id"], row["Product Id"]) == ("t1", "p1")
    assert (row["Product Title"], row["UPC"], row["Release Type"]) == ("Album 1", "198704880001", "EP")
    assert row["Release Date"] == date(2025, 12, 4)
    assert (row["Track Volume"], row["Track Number"], row["Product Display Artist"]) == (1, 3, "Artist 1")
    assert (row["Duration"], row["Sample Start Time"], row["Explicit Lyrics"]) == ("3:16", "00:00:47", "Yes")
    assert row["Aggregator Percentage"] == "50"
    assert (row["Label"], row["Track Genre"]) == ("Label 1", "Genre 1")
    assert (row["Import File"], row["Import Row"]) == ("ReleasesExport.csv", 7)


@pytest.mark.django_db
def test_excel_freezes_header_and_keeps_text(session_client, music):
    _full_song(music, 1)
    response = session_client.get(_url(music), {"format": "xlsx", "columns": "title,track_upc,release_release_date"})
    assert response.status_code == 200
    sheet = load_workbook(BytesIO(response.content)).active
    assert sheet.freeze_panes == "A2"
    assert [cell.value for cell in sheet[1]] == ["Track Name", "Track UPC", "Release Date"]
    # A value that looks like a formula stays text
    assert sheet["B2"].value == '="0198704887383"' and sheet["B2"].data_type == "s"
    assert sheet["C2"].value.date() == date(2025, 12, 4)
    assert sheet.column_dimensions["A"].width >= 10


@pytest.mark.django_db
def test_query_count_does_not_grow_with_songs(workspace):
    contract = _contract(workspace, "Contrato")
    keys = [column.key for column in COLUMNS]
    _full_song(workspace, 0, contract=contract)
    with CaptureQueriesContext(connection) as one:
        rows, _ = _export(workspace, keys)
    assert len(rows) == 1
    for index in range(1, 20):
        _full_song(workspace, index, contract=contract)
    with CaptureQueriesContext(connection) as many:
        rows, _ = _export(workspace, keys)
    assert len(rows) == 20
    assert len(many) == len(one), [query["sql"][:120] for query in many.captured_queries]
    assert len(one) <= 20


# ── Importer side of the round trip ──────────────────────────────────────────


@pytest.mark.unit
def test_several_urls_in_one_cell():
    assert _urls_in(["https://a.com/1; https://b.com/2", "not a url", "https://a.com/1 | https://c.com"]) == [
        "https://a.com/1",
        "https://b.com/2",
        "https://c.com",
    ]


@pytest.mark.django_db
def test_exported_links_and_extra_data_import_back(workspace):
    row = {
        "Track Name": "Uno",
        "Track Play Link": "https://open.spotify.com/track/1; https://music.apple.com/1",
        "Extra: Price Tier": "$3.50",
    }
    mapping = _infer_mapping(list(row), IMPORT_FIELDS)
    assert _run(workspace, [row], mapping, keep_unmapped=True)["errors"] == []
    track = MusicTrack.objects.get(workspace=workspace, title="Uno")
    assert set(track.links.values_list("url", flat=True)) == {
        "https://open.spotify.com/track/1",
        "https://music.apple.com/1",
    }
    assert track.metadata["extra"] == {"Price Tier": "$3.50"}
