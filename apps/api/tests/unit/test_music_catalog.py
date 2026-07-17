from datetime import date, datetime, time, timedelta
from io import BytesIO
import json

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from openpyxl import Workbook
from rest_framework.test import APIRequestFactory

from plane.app.views.music.base import (
    MusicImportEndpoint,
    MusicTrackBulkDeleteEndpoint,
    MusicTrackEndpoint,
    _date,
    _duration_ms,
    _filter_tracks,
    _import_error_message,
    _import_error_detail,
    _infer_mapping,
    _music_schema_ready,
    _read_table,
    _split,
)
from plane.app.serializers.music import MusicTrackSerializer
from plane.db.models import (
    MusicCompany,
    MusicCredit,
    MusicDistribution,
    MusicGenre,
    MusicLink,
    MusicParty,
    MusicRelease,
    MusicReleaseTrack,
    MusicTrack,
)
from plane.tests.factories import WorkspaceFactory


@pytest.mark.unit
@pytest.mark.django_db
def test_has_video_only_matches_real_music_video_children():
    workspace = WorkspaceFactory()
    link_only = MusicTrack.objects.create(workspace=workspace, title="Link only")
    MusicLink.objects.create(
        workspace=workspace,
        track=link_only,
        kind=MusicLink.Kind.STREAMING,
        name="Spotify",
        url="https://open.spotify.com/track/example",
    )
    other_parent = MusicTrack.objects.create(workspace=workspace, title="Other child")
    other_child = MusicTrack.objects.create(
        workspace=workspace,
        parent_track=other_parent,
        title="Visualizer",
        kind=MusicTrack.Kind.OTHER_VIDEO,
    )
    MusicLink.objects.create(
        workspace=workspace,
        track=other_child,
        kind=MusicLink.Kind.MUSIC_VIDEO,
        name="Visualizer",
        url="https://youtube.com/watch?v=visualizer",
    )
    video_parent = MusicTrack.objects.create(workspace=workspace, title="Official video")
    video = MusicTrack.objects.create(
        workspace=workspace,
        parent_track=video_parent,
        title="Official video",
        kind=MusicTrack.Kind.MUSIC_VIDEO,
    )
    MusicLink.objects.create(
        workspace=workspace,
        track=video,
        kind=MusicLink.Kind.MUSIC_VIDEO,
        name="YouTube",
        url="https://youtube.com/watch?v=official",
    )

    tracks = _filter_tracks(MusicTrack.objects.filter(workspace=workspace), {"has_video": "true"})

    assert list(tracks) == [video_parent]


@pytest.mark.unit
@pytest.mark.django_db
def test_has_links_only_matches_tracks_with_direct_links():
    workspace = WorkspaceFactory()
    song_with_link = MusicTrack.objects.create(workspace=workspace, title="Linked song")
    MusicLink.objects.create(
        workspace=workspace,
        track=song_with_link,
        kind=MusicLink.Kind.STREAMING,
        name="Spotify",
        url="https://open.spotify.com/track/example",
    )
    song_with_video_link = MusicTrack.objects.create(workspace=workspace, title="Video only")
    video = MusicTrack.objects.create(
        workspace=workspace,
        parent_track=song_with_video_link,
        title="Official video",
        kind=MusicTrack.Kind.MUSIC_VIDEO,
    )
    MusicLink.objects.create(
        workspace=workspace,
        track=video,
        kind=MusicLink.Kind.MUSIC_VIDEO,
        name="YouTube",
        url="https://youtube.com/watch?v=official",
    )

    tracks = _filter_tracks(MusicTrack.objects.filter(workspace=workspace), {"has_links": "true"})

    assert list(tracks) == [song_with_link]


@pytest.mark.unit
@pytest.mark.parametrize(
    ("source", "expected"),
    [
        ("3:02", 182_000),
        ("3:02 min", 182_000),
        ("01:03:02", 3_782_000),
        ("3 min 2 sec", 182_000),
        ("Duration: 3 min 2 sec", 182_000),
        (time(0, 3, 2), 182_000),
        (timedelta(minutes=3, seconds=2), 182_000),
        (182, 182_000),
        (182_000, 182_000),
    ],
)
def test_duration_normalizes_spreadsheet_and_human_values(source, expected):
    assert _duration_ms(source) == expected


@pytest.mark.unit
@pytest.mark.django_db
def test_music_resources_are_isolated_by_workspace():
    first = WorkspaceFactory()
    second = WorkspaceFactory(owner=first.owner)

    MusicGenre.objects.create(workspace=first, name="Pop")
    MusicGenre.objects.create(workspace=second, name="Pop")

    assert MusicGenre.objects.filter(name="Pop").count() == 2
    assert MusicGenre.objects.filter(workspace=first, name="Pop").count() == 1
    assert _music_schema_ready() is True


@pytest.mark.unit
def test_track_serializer_accepts_empty_optional_numbers():
    serializer = MusicTrackSerializer(
        data={
            "title": "Song with optional values",
            "aggregator_percentage": "",
            "artist_percentage": "",
            "duration_ms": "",
            "tiktok_preview_start_ms": "",
        }
    )

    assert serializer.is_valid(), serializer.errors
    assert serializer.validated_data["aggregator_percentage"] is None
    assert serializer.validated_data["duration_ms"] is None


@pytest.mark.unit
@pytest.mark.django_db
def test_tracks_endpoint_returns_a_requested_page_with_total_count():
    workspace = WorkspaceFactory()
    for title in ("Alpha", "Bravo", "Charlie"):
        MusicTrack.objects.create(workspace=workspace, title=title)

    view = MusicTrackEndpoint()
    request = view.initialize_request(APIRequestFactory().get("/", {"page": 2, "page_size": 2, "songs_only": "true"}))
    response = MusicTrackEndpoint.get.__wrapped__(view, request, workspace.slug)

    assert response.data["total"] == 3
    assert response.data["page"] == 2
    assert response.data["page_size"] == 2
    assert response.data["requested_page"] == 2
    assert [track["title"] for track in response.data["results"]] == ["Charlie"]


@pytest.mark.unit
@pytest.mark.django_db
def test_tracks_bulk_delete_only_removes_songs_in_the_current_workspace():
    workspace = WorkspaceFactory()
    other_workspace = WorkspaceFactory(owner=workspace.owner)
    first = MusicTrack.objects.create(workspace=workspace, title="First")
    second = MusicTrack.objects.create(workspace=workspace, title="Second")
    outside_song = MusicTrack.objects.create(workspace=other_workspace, title="Outside")

    view = MusicTrackBulkDeleteEndpoint()
    request = view.initialize_request(
        APIRequestFactory().post("/", {"track_ids": [str(first.id), str(second.id), str(outside_song.id)]}, format="json")
    )
    response = MusicTrackBulkDeleteEndpoint.post.__wrapped__(view, request, workspace.slug)

    assert response.data == {"deleted": 2, "not_found": 1}
    assert not MusicTrack.objects.filter(id__in=[first.id, second.id]).exists()
    assert MusicTrack.objects.filter(id=outside_song.id).exists()


@pytest.mark.unit
@pytest.mark.django_db
def test_csv_row_creates_release_credits_genres_and_distribution():
    workspace = WorkspaceFactory()
    mapping = {
        "track.title": "Song",
        "track.isrc": "ISRC",
        "track.release_date": "Track date",
        "release.title": "Album",
        "release.type": "Type",
        "release.upc": "UPC",
        "release.release_date": "Release date",
        "artists": "Artists",
        "authors": "Authors",
        "genres": "Genres",
        "aggregator": "Aggregator",
    }
    row = {
        "Song": "Night Drive",
        "ISRC": "MX-ABC-26-00001",
        "Track date": "2026-09-10",
        "Album": "After Hours",
        "Type": "SINGLE",
        "UPC": "750000000001",
        "Release date": "2026-09-10",
        "Artists": "Nova; Echo",
        "Authors": "Alex Writer",
        "Genres": "Pop; Synthwave",
        "Aggregator": "Example Distribution",
    }

    outcome = MusicImportEndpoint()._import_row(workspace, row, mapping, "skip")

    track = MusicTrack.objects.get(workspace=workspace, isrc="MXABC2600001")
    release = MusicRelease.objects.get(workspace=workspace, upc="750000000001")
    assert outcome == "created"
    assert MusicReleaseTrack.objects.filter(track=track, release=release).exists()
    assert MusicCredit.objects.filter(track=track).count() == 3
    assert set(track.genres.values_list("name", flat=True)) == {"Pop", "Synthwave"}
    assert MusicCompany.objects.filter(
        workspace=workspace,
        kind=MusicCompany.Kind.AGGREGATOR,
        name="Example Distribution",
    ).exists()
    assert MusicDistribution.objects.filter(track=track).count() == 1


@pytest.mark.unit
@pytest.mark.django_db
def test_csv_duplicate_strategy_skips_without_duplicating_relations():
    workspace = WorkspaceFactory()
    mapping = {"track.title": "Title", "track.isrc": "ISRC", "artists": "Artists"}
    row = {"Title": "Same Song", "ISRC": "US-AAA-26-00001", "Artists": "Solo Artist"}
    importer = MusicImportEndpoint()

    assert importer._import_row(workspace, row, mapping, "skip") == "created"
    assert importer._import_row(workspace, row, mapping, "skip") == "skipped"
    assert MusicTrack.objects.filter(workspace=workspace).count() == 1
    assert MusicCredit.objects.filter(track__workspace=workspace).count() == 1


@pytest.mark.unit
@pytest.mark.django_db
def test_import_applies_workspace_defaults_to_every_created_track():
    workspace = WorkspaceFactory()
    artist = MusicParty.objects.create(workspace=workspace, display_name="Shared Artist", kind="ARTIST")
    aggregator = MusicCompany.objects.create(workspace=workspace, name="Shared Aggregator", kind="AGGREGATOR")
    genre = MusicGenre.objects.create(workspace=workspace, name="Shared Genre")
    release = MusicRelease.objects.create(workspace=workspace, title="Shared Release", release_type="ALBUM")

    outcome = MusicImportEndpoint()._import_row(
        workspace,
        {"Song": "Imported with defaults"},
        {"track.title": "Song"},
        "skip",
        {
            "credit_entries": [{"party_id": str(artist.id), "role": "WRITER"}],
            "distribution_entries": [{"company_id": str(aggregator.id)}],
            "genre_ids": [str(genre.id)],
            "releases": [{"id": str(release.id)}],
        },
    )

    track = MusicTrack.objects.get(workspace=workspace, title="Imported with defaults")
    assert outcome == "created"
    assert MusicCredit.objects.filter(track=track, party=artist, role="WRITER").exists()
    assert MusicDistribution.objects.filter(track=track, company=aggregator).exists()
    assert track.genres.filter(id=genre.id).exists()
    assert MusicReleaseTrack.objects.filter(track=track, release=release).exists()


@pytest.mark.unit
@pytest.mark.django_db
def test_track_relation_sync_restores_unique_soft_deleted_credit():
    workspace = WorkspaceFactory()
    track = MusicTrack.objects.create(workspace=workspace, title="Editable song")
    party = MusicParty.objects.create(workspace=workspace, display_name="Artist", kind="ARTIST")
    payload = {
        "credit_entries": [
            {
                "party_id": str(party.id),
                "role": "PRIMARY_ARTIST",
                "percentage": "50",
                "publishing_share": "25",
            }
        ]
    }

    MusicTrackEndpoint._sync_relations(track, workspace, payload)
    MusicTrackEndpoint._sync_relations(track, workspace, payload)

    assert MusicCredit.objects.filter(track=track, party=party, role="PRIMARY_ARTIST").count() == 1
    assert MusicCredit.all_objects.filter(track=track, party=party, role="PRIMARY_ARTIST").count() == 1


@pytest.mark.unit
def test_import_normalizes_excel_year_and_artist_variants():
    assert _date("1/7/1905", year_only=True) == date(2009, 1, 1)
    assert _split("Artist One FT. Artist Two & Artist Three, Artist Four") == [
        "Artist One",
        "Artist Two",
        "Artist Three",
        "Artist Four",
    ]

    assert _import_error_message('column music_tracks.parent_track_id does not exist').startswith(
        "The music catalog database is not ready"
    )


@pytest.mark.unit
def test_csv_reader_detects_displaced_header_and_real_catalog_aliases():
    upload = SimpleUploadedFile(
        "historical.csv",
        (
            ",,,,,,,,\n"
            ",,Fecha (año),ISRC,Track,Artista,Duración / Tipo,Titulo (Álbum/Single/LP/EP),Licencia\n"
            ",1,1/7/1905,MX1880900001,Song,Artist,4:02,Album,Label\n"
        ).encode("utf-8"),
        content_type="text/csv",
    )
    headers, rows, _, header_row = _read_table(upload)
    mapping = _infer_mapping(headers, ["track.title", "track.isrc", "artists", "release.release_date"])

    assert header_row == 2
    assert len(rows) == 1
    assert mapping == {
        "track.title": "Track",
        "track.isrc": "ISRC",
        "artists": "Artista",
        "release.release_date": "Fecha (año)",
    }


@pytest.mark.unit
def test_xlsx_reader_preserves_excel_dates_and_detects_headers():
    workbook = Workbook()
    sheet = workbook.active
    sheet.append(["Main Artist", "Song Name", "ISRC", "Album Release Date"])
    sheet.append(["3BallMTY", "Besos al Aire", "MXA3Y2400039", date(2024, 12, 13)])
    output = BytesIO()
    workbook.save(output)
    upload = SimpleUploadedFile(
        "catalog.xlsx",
        output.getvalue(),
        content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )

    headers, rows, sheets, header_row = _read_table(upload)

    assert headers == ["Main Artist", "Song Name", "ISRC", "Album Release Date"]
    assert rows[0]["Album Release Date"] == datetime(2024, 12, 13)
    assert sheets
    assert header_row == 1


@pytest.mark.unit
def test_import_error_detail_explains_required_field_and_serializes_row_values():
    detail = _import_error_detail(
        7,
        ValueError("Track title is empty"),
        {"Song": "", "Release date": date(2025, 4, 2)},
        {"track.title": "Song", "track.release_date": "Release date"},
    )

    assert detail == {
        "row": 7,
        "code": "REQUIRED_FIELD",
        "field": "track.title",
        "column": "Song",
        "value": "",
        "message": "Track title is empty",
        "row_data": {"Song": "", "Release date": "2025-04-02"},
    }


def _import_request(workspace, invalid_row_strategy):
    upload = SimpleUploadedFile(
        "validation.csv",
        b"Song,ISRC\nValid song,\n,USAAA2600001\n",
        content_type="text/csv",
    )
    view = MusicImportEndpoint()
    request = view.initialize_request(
        APIRequestFactory().post(
            "/",
            {
                "file": upload,
                "mapping": json.dumps({"track.title": "Song", "track.isrc": "ISRC"}),
                "invalid_row_strategy": invalid_row_strategy,
                "dry_run": "false",
            },
            format="multipart",
        )
    )
    return MusicImportEndpoint.post.__wrapped__(view, request, workspace.slug)


@pytest.mark.unit
@pytest.mark.django_db
def test_import_abort_rolls_back_valid_rows_when_any_row_is_invalid():
    workspace = WorkspaceFactory()

    response = _import_request(workspace, "abort")

    assert response.data["aborted"] is True
    assert response.data["errors"][0]["row"] == 3
    assert not MusicTrack.objects.filter(workspace=workspace).exists()


@pytest.mark.unit
@pytest.mark.django_db
def test_import_skip_commits_valid_rows_and_reports_invalid_rows():
    workspace = WorkspaceFactory()

    response = _import_request(workspace, "skip")

    assert response.data["aborted"] is False
    assert response.data["created"] == 1
    assert response.data["errors"][0]["code"] == "REQUIRED_FIELD"
    assert MusicTrack.objects.filter(workspace=workspace, title="Valid song").exists()
