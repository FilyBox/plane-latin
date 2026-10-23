"""The import flow: duplicate matching, outcomes, progress and provenance."""

import json

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from rest_framework.test import APIRequestFactory

from plane.app.views.music.base import (
    MusicImportAssetEndpoint,
    MusicImportEndpoint,
    MusicImportPreviewEndpoint,
)
from plane.app.views.music.importer import run_import
from plane.db.models import (
    FileAsset,
    MusicCredit,
    MusicImportRun,
    MusicParty,
    MusicTrack,
    MusicTrackImport,
)
from plane.tests.factories import WorkspaceFactory

MAPPING = {"track.title": "Title", "track.isrc": "ISRC", "artists": "Artist"}


def song(workspace, title, isrc="", artist=None):
    track = MusicTrack.objects.create(workspace=workspace, title=title, isrc=isrc)
    if artist:
        party = MusicParty.objects.create(workspace=workspace, display_name=artist, kind="ARTIST")
        MusicCredit.objects.create(workspace=workspace, track=track, party=party, role="PRIMARY_ARTIST")
    return track


def run(workspace, rows, **options):
    """Drives run_import to completion; returns (result, progress_events)."""
    progress, result = [], None
    for event in run_import(MusicImportEndpoint(), workspace, rows, 1, MAPPING, **options):
        if event[0] == "progress":
            progress.append(event[1])
        else:
            result = event[1]
    return result, progress


@pytest.mark.unit
@pytest.mark.django_db
class TestDuplicateMatching:
    def test_same_title_with_a_different_isrc_is_a_new_recording(self):
        workspace = WorkspaceFactory()
        existing = song(workspace, "Feliz Navidad", "MX1881800225")
        row = {"Title": "Feliz Navidad", "ISRC": "MXA3Y2400031", "Artist": "3BallMTY"}

        outcome, track, match = MusicImportEndpoint()._import_row(workspace, row, MAPPING, "update")

        assert outcome == "created"
        assert match is None
        assert track.id != existing.id
        existing.refresh_from_db()
        assert existing.isrc == "MX1881800225"

    def test_same_isrc_matches(self):
        workspace = WorkspaceFactory()
        existing = song(workspace, "Besos al Aire", "MXA3Y2400039")
        row = {"Title": "Besos al aire (remaster)", "ISRC": "mxa3y2400039", "Artist": ""}

        outcome, track, match = MusicImportEndpoint()._import_row(workspace, row, MAPPING, "skip")

        assert outcome == "skipped"
        assert track.id == existing.id
        assert match["by"] == "isrc"

    def test_without_isrc_the_title_needs_the_same_primary_artist(self):
        workspace = WorkspaceFactory()
        existing = song(workspace, "Morenita", artist="Los HH")
        row = {"Title": "morenita", "ISRC": "", "Artist": "Los HH"}

        outcome, track, match = MusicImportEndpoint()._import_row(workspace, row, MAPPING, "skip")

        assert (outcome, track.id, match["by"]) == ("skipped", existing.id, "title_artist")

    def test_a_title_alone_is_only_a_possible_duplicate(self):
        workspace = WorkspaceFactory()
        existing = song(workspace, "El Pistolero", artist="Otro Grupo")
        row = {"Title": "El Pistolero", "ISRC": "", "Artist": "Los Del Nido"}
        importer = MusicImportEndpoint()

        outcome, track, match = importer._import_row(workspace, row, MAPPING, "skip")
        assert outcome == "created"
        assert match["by"] == "ambiguous" and match["track_id"] == str(existing.id)
        assert track.id != existing.id

    def test_possible_duplicates_follow_the_users_decision(self):
        workspace = WorkspaceFactory()
        existing = song(workspace, "Quisiera")
        row = {"Title": "Quisiera", "ISRC": "", "Artist": ""}
        importer = MusicImportEndpoint()

        skipped = importer._import_row(workspace, row, MAPPING, "skip", ambiguous_strategy="skip")
        matched = importer._import_row(workspace, row, MAPPING, "skip", ambiguous_strategy="match")

        assert skipped[0] == "skipped" and skipped[1] is None
        assert matched[0] == "skipped" and matched[1].id == existing.id
        assert MusicTrack.objects.filter(workspace=workspace).count() == 1

    def test_explicit_title_dedupe_still_matches_on_title_alone(self):
        workspace = WorkspaceFactory()
        existing = song(workspace, "Abusa de mi", "MX1881600025")
        row = {"Title": "Abusa de mi", "ISRC": "MXZZZ0000001", "Artist": ""}

        outcome, track, _ = MusicImportEndpoint()._import_row(workspace, row, MAPPING, "skip", dedupe_by="title")

        assert (outcome, track.id) == ("skipped", existing.id)


@pytest.mark.unit
@pytest.mark.django_db
class TestOutcomes:
    def test_reimporting_identical_data_is_unchanged_and_new_data_is_updated(self):
        workspace = WorkspaceFactory()
        row = {"Title": "Night Drive", "ISRC": "MXABC2600001", "Artist": "Nova"}
        importer = MusicImportEndpoint()

        assert importer._import_row(workspace, row, MAPPING, "update")[0] == "created"
        assert importer._import_row(workspace, row, MAPPING, "update")[0] == "unchanged"
        changed = {**row, "Artist": "Nova; Echo"}
        assert importer._import_row(workspace, changed, MAPPING, "update")[0] == "updated"

    def test_empty_rows_are_ignored_not_reported_as_errors(self):
        workspace = WorkspaceFactory()
        rows = [
            {"Title": "Song", "ISRC": "MXABC2600002", "Artist": "A"},
            {"Title": "", "ISRC": "", "Artist": ""},
            {"Title": None, "ISRC": None, "Artist": None},
        ]

        result, _ = run(workspace, rows, dry_run=True)

        assert result["created"] == 1
        assert result["empty"] == 2
        assert result["errors"] == []

    def test_rows_without_any_song_identity_are_ignored(self):
        # A trailing "Top Music | Top Music" line: only the label repeats.
        workspace = WorkspaceFactory()
        mapping = {**MAPPING, "record_label": "Label"}
        rows = [
            {"Title": "Song", "ISRC": "MXABC2600004", "Artist": "A", "Label": "Top Music"},
            {"Title": "", "ISRC": "", "Artist": "", "Label": "Top Music"},
        ]

        events = list(
            run_import(MusicImportEndpoint(), workspace, rows, 1, mapping, dry_run=True)
        )
        result = events[-1][1]

        assert result["created"] == 1
        assert result["empty"] == 1
        assert result["errors"] == []

    def test_rows_with_data_but_no_title_are_still_errors(self):
        workspace = WorkspaceFactory()

        result, _ = run(workspace, [{"Title": "", "ISRC": "MXABC2600003", "Artist": "A"}], dry_run=True)

        assert result["errors"][0]["code"] == "REQUIRED_FIELD"

    def test_validation_reports_each_row_outcome_and_possible_duplicates(self):
        workspace = WorkspaceFactory()
        song(workspace, "Existing", "MXABC2600010")
        song(workspace, "Same Name")
        rows = [
            {"Title": "Existing", "ISRC": "MXABC2600010", "Artist": ""},
            {"Title": "Brand new", "ISRC": "MXABC2600011", "Artist": ""},
            {"Title": "Same Name", "ISRC": "", "Artist": ""},
        ]

        result, _ = run(workspace, rows, dry_run=True, strategy="update")

        assert [entry["outcome"] for entry in result["rows"]] == ["unchanged", "created", "created"]
        assert result["rows"][2]["possible_duplicate"] is True
        assert result["possible_duplicate_count"] == 1
        assert result["possible_duplicates"][0]["row"] == 4

    def test_repeated_isrcs_within_the_file_are_reported(self):
        workspace = WorkspaceFactory()
        rows = [
            {"Title": "Feliz Navidad", "ISRC": "MXA3Y2400031", "Artist": "3BallMTY"},
            {"Title": "Feliz Navidad", "ISRC": "MXA3Y2400031", "Artist": "3BallMTY"},
        ]

        result, _ = run(workspace, rows, dry_run=True)

        assert result["in_file_duplicates"] == [{"isrc": "MXA3Y2400031", "rows": [2, 3]}]
        assert result["created"] == 2

    def test_reimporting_a_file_with_repeated_isrcs_changes_nothing(self):
        workspace = WorkspaceFactory()
        rows = [
            {"Title": "Feliz Navidad", "ISRC": "MXA3Y2400031", "Artist": "3BallMTY"},
            {"Title": "Feliz Navidad (Edit)", "ISRC": "MXA3Y2400031", "Artist": "3BallMTY"},
        ]
        first, _ = run(workspace, rows, strategy="update")
        second, _ = run(workspace, rows, strategy="update")

        assert first["created"] == 2
        assert (second["unchanged"], second["updated"], second["created"]) == (2, 0, 0)
        titles = set(MusicTrack.objects.filter(workspace=workspace).values_list("title", flat=True))
        assert titles == {"Feliz Navidad", "Feliz Navidad (Edit)"}

    def test_unparseable_values_are_grouped_ignoring_case(self):
        workspace = WorkspaceFactory()
        mapping = {**MAPPING, "track.duration_ms": "Duration"}
        rows = [
            {"Title": f"Song {index}", "ISRC": "", "Artist": "", "Duration": value}
            for index, value in enumerate(["Mastertone", "MASTERTONE", "Mastertone", "4:02", "Ringtone"])
        ]
        result = None
        for event in run_import(MusicImportEndpoint(), workspace, rows, 1, mapping, dry_run=True):
            if event[0] == "result":
                result = event[1]

        tokens = result["unparseable"]["track.duration_ms"]
        assert tokens[0] == {"value": "Mastertone", "count": 3, "variants": ["Mastertone", "MASTERTONE"]}
        assert tokens[1]["value"] == "Ringtone"

    def test_progress_is_reported_from_zero_to_total(self):
        workspace = WorkspaceFactory()
        rows = [{"Title": f"Song {index}", "ISRC": "", "Artist": ""} for index in range(5)]

        _, progress = run(workspace, rows, dry_run=True)

        assert progress[0]["processed"] == 0
        assert progress[-1] == {**progress[-1], "processed": 5, "total": 5}


def _post(view_class, workspace, data):
    view = view_class()
    request = view.initialize_request(APIRequestFactory().post("/", data, format="multipart"))
    return view_class.post.__wrapped__(view, request, workspace.slug)


def _csv(name="catalog.csv", body=b"Title,ISRC\nNight Drive,MXABC2600020\nDay Ride,MXABC2600021\n"):
    return SimpleUploadedFile(name, body, content_type="text/csv")


@pytest.mark.unit
@pytest.mark.django_db
class TestEndpoints:
    def test_streamed_import_sends_progress_then_the_result(self):
        workspace = WorkspaceFactory()

        response = _post(
            MusicImportEndpoint,
            workspace,
            {
                "file": _csv(),
                "mapping": json.dumps({"track.title": "Title", "track.isrc": "ISRC"}),
                "dry_run": "true",
                "stream": "true",
            },
        )

        assert response["Content-Type"] == "text/event-stream"
        body = b"".join(response.streaming_content).decode()
        events = [block for block in body.split("\n\n") if block]
        assert events[0].startswith("event: progress")
        assert events[-1].startswith("event: result")
        result = json.loads(events[-1].split("data: ", 1)[1])
        assert result["created"] == 2
        # A validation never writes
        assert not MusicTrack.objects.filter(workspace=workspace).exists()

    def test_applied_import_links_every_track_to_its_file_and_run(self):
        workspace = WorkspaceFactory()

        response = _post(
            MusicImportEndpoint,
            workspace,
            {"file": _csv(), "mapping": json.dumps({"track.title": "Title", "track.isrc": "ISRC"}), "dry_run": "false"},
        )

        run_ = MusicImportRun.objects.get(id=response.data["import_run_id"])
        assert run_.summary["created"] == 2
        assert set(MusicTrackImport.objects.filter(import_run=run_).values_list("row_number", flat=True)) == {2, 3}
        assert run_.file_asset.attributes["name"] == "catalog.csv"

        history = _get_assets(workspace).data["results"]
        assert history[0]["run_count"] == 1
        assert history[0]["runs"][0]["summary"]["created"] == 2

    def test_reimporting_the_same_file_reuses_its_asset_and_reports_unchanged(self):
        workspace = WorkspaceFactory()
        data = {
            "mapping": json.dumps({"track.title": "Title", "track.isrc": "ISRC"}),
            "dry_run": "false",
            "duplicate_strategy": "update",
        }

        _post(MusicImportEndpoint, workspace, {**data, "file": _csv()})
        second = _post(MusicImportEndpoint, workspace, {**data, "file": _csv()})

        assert second.data["unchanged"] == 2 and second.data["created"] == 0
        assert FileAsset.objects.filter(workspace=workspace, attributes__music_asset_kind="IMPORT_SOURCE").count() == 1
        assert _get_assets(workspace).data["results"][0]["run_count"] == 2

    def test_preview_warns_about_previous_imports_and_existing_songs(self):
        workspace = WorkspaceFactory()
        _post(
            MusicImportEndpoint,
            workspace,
            {"file": _csv(), "mapping": json.dumps({"track.title": "Title", "track.isrc": "ISRC"}), "dry_run": "false"},
        )

        preview = _post(MusicImportPreviewEndpoint, workspace, {"file": _csv()}).data

        assert preview["isrc_count"] == 2
        assert preview["existing_isrc_count"] == 2
        assert len(preview["previous_imports"]) == 1

    def test_preview_explains_how_year_serials_are_read(self):
        workspace = WorkspaceFactory()
        upload = _csv(body="Fecha (año),Track\n1/7/1905,Song\n".encode())

        preview = _post(MusicImportPreviewEndpoint, workspace, {"file": upload}).data

        assert preview["date_interpretations"]["Fecha (año)"] == {
            "raw": "1/7/1905",
            "parsed": "2009-01-01",
            "year_only": True,
        }


def _get_assets(workspace):
    view = MusicImportAssetEndpoint()
    request = view.initialize_request(APIRequestFactory().get("/"))
    return MusicImportAssetEndpoint.get.__wrapped__(view, request, workspace.slug)


@pytest.mark.unit
@pytest.mark.django_db
class TestBlankCellsOnUpdate:
    """An empty cell in a mapped column only erases the song's value when the
    user picks "clear"; by default the current value stays."""

    mapping = {**MAPPING, "track.version": "Version"}

    def existing(self):
        workspace = WorkspaceFactory()
        track = song(workspace, "Song", "MXABC2600050")
        track.version = "Remix"
        track.save()
        return workspace, track

    def test_blank_cell_keeps_the_current_value_by_default(self):
        workspace, track = self.existing()
        row = {"Title": "Song", "ISRC": "MXABC2600050", "Artist": "", "Version": ""}

        outcome, _, _ = MusicImportEndpoint()._import_row(workspace, row, self.mapping, "update")

        track.refresh_from_db()
        assert track.version == "Remix"
        assert outcome == "unchanged"

    def test_blank_cell_clears_the_value_when_asked(self):
        workspace, track = self.existing()
        row = {"Title": "Song", "ISRC": "MXABC2600050", "Artist": "", "Version": ""}

        outcome, _, _ = MusicImportEndpoint()._import_row(
            workspace, row, self.mapping, "update", blank_cells="clear"
        )

        track.refresh_from_db()
        assert track.version == ""
        assert outcome == "updated"

    def test_filled_cell_still_updates_in_keep_mode(self):
        workspace, track = self.existing()
        row = {"Title": "Song", "ISRC": "MXABC2600050", "Artist": "", "Version": "Live"}

        outcome, _, _ = MusicImportEndpoint()._import_row(workspace, row, self.mapping, "update")

        track.refresh_from_db()
        assert track.version == "Live"
        assert outcome == "updated"


@pytest.mark.unit
class TestDistributorExportFormats:
    """Cases from a distributor "Releases export" CSV (one row per track)."""

    @staticmethod
    def read(text):
        from plane.app.views.music.base import _read_table

        upload = SimpleUploadedFile("export.csv", text.encode("utf-8"))
        headers, rows, _, _ = _read_table(upload)
        return headers, rows

    def test_excel_text_wrappers_are_removed(self):
        _, rows = self.read('Track Name,UPC,Duration\nSong,"=""198704887383""","=""00:03:03"""\n')

        assert rows[0]["UPC"] == "198704887383"
        assert rows[0]["Duration"] == "00:03:03"

    def test_month_first_date_columns_are_detected(self):
        _, rows = self.read("Track Name,Release Date\nA,12/4/2025\nB,5/17/2024\n")

        assert rows[0]["Release Date"] == "2025-12-04"
        assert rows[1]["Release Date"] == "2024-05-17"

    def test_day_first_and_ambiguous_columns_are_left_alone(self):
        _, rows = self.read("Track Name,Fecha,Otra\nA,17/05/2024,03/04/2024\nB,12/04/2025,05/06/2024\n")

        assert rows[1]["Fecha"] == "12/04/2025"
        assert rows[0]["Otra"] == "03/04/2024"

    def test_role_tags_and_repeated_names_are_dropped(self):
        from plane.app.views.music.base import _split

        cell = "Marco Antonio Solis <Lyricist>, Marco Antonio Solis <Composer>, Ana Paula <Composer>"

        assert _split(cell) == ["Marco Antonio Solis", "Ana Paula"]

    def test_export_headers_are_mapped_automatically(self):
        from plane.app.views.music.base import IMPORT_FIELDS, _infer_mapping

        headers = [
            "Product Title", "Product Display Artist", "Track Name", "Track Display Artist", "Isrc",
            "Track Genre", "Explicit Lyrics", "Audio Language", "Track P Line", "Track Play Link",
        ]

        mapping = _infer_mapping(headers, IMPORT_FIELDS)

        assert mapping["track.title"] == "Track Name"
        assert mapping["release.title"] == "Product Title"
        assert mapping["artists"] == "Track Display Artist"
        assert mapping["genres"] == "Track Genre"
        assert mapping["track.explicit"] == "Explicit Lyrics"
        assert mapping["track.language"] == "Audio Language"
        assert mapping["release.p_line"] == "Track P Line"
        assert mapping["track.streaming_url"] == "Track Play Link"


@pytest.mark.unit
@pytest.mark.django_db
class TestValuesLongerThanTheirField:
    mapping = {**MAPPING, "track.language": "Language"}

    def test_too_long_values_are_grouped_for_a_decision(self):
        workspace = WorkspaceFactory()
        rows = [
            {"Title": "A", "ISRC": "MXABC2600060", "Artist": "", "Language": "Spanish (Latin America)"},
            {"Title": "B", "ISRC": "MXABC2600061", "Artist": "", "Language": "Spanish (Latin America)"},
        ]

        events = list(run_import(MusicImportEndpoint(), workspace, rows, 1, self.mapping, dry_run=True))
        result = events[-1][1]

        assert result["unparseable"]["track.language"][0] == {
            "value": "Spanish (Latin America)",
            "count": 2,
            "variants": ["Spanish (Latin America)"],
        }
        # Undecided, each row fails with a field-level reason, not a database error
        assert {error["code"] for error in result["errors"]} == {"TOO_LONG"}
        assert result["errors"][0]["field"] == "track.language"

    def test_a_decision_on_the_value_lets_the_rows_through(self):
        workspace = WorkspaceFactory()
        rows = [{"Title": "A", "ISRC": "MXABC2600062", "Artist": "", "Language": "Spanish (Latin America)"}]
        overrides = {"track.language": {"spanish (latin america)": "es-419"}}

        events = list(
            run_import(
                MusicImportEndpoint(), workspace, rows, 1, self.mapping, value_overrides=overrides, dry_run=True
            )
        )
        result = events[-1][1]

        assert result["errors"] == []
        assert result["created"] == 1


@pytest.mark.unit
class TestRoleTaggedCredits:
    cell = "Ana <Composer>, Luis <Lyricist>, Keko <MixingEngineer>, Keko <MasteringEngineer>"

    def test_each_name_only_feeds_the_field_its_tag_belongs_to(self):
        from plane.app.views.music.base import _names_for

        assert _names_for(self.cell, "composers") == ["Ana"]
        assert _names_for(self.cell, "authors") == ["Luis"]
        assert _names_for(self.cell, "writers") == ["Ana", "Luis"]
        assert _names_for(self.cell, "mixers") == ["Keko"]
        assert _names_for(self.cell, "mastering_engineers") == ["Keko"]
        assert _names_for(self.cell, "recording_engineers") == []

    def test_untagged_cells_keep_every_name(self):
        from plane.app.views.music.base import _names_for

        assert _names_for("Ana, Luis", "composers") == ["Ana", "Luis"]


@pytest.mark.unit
@pytest.mark.django_db
class TestFixedChoiceValues:
    mapping = {**MAPPING, "track.kind": "Type"}

    def test_unknown_choice_is_listed_and_never_stored(self):
        workspace = WorkspaceFactory()
        rows = [{"Title": "A", "ISRC": "MXABC2600070", "Artist": "", "Type": "AudioTrack"}]

        events = list(run_import(MusicImportEndpoint(), workspace, rows, 1, self.mapping, dry_run=False))
        result = events[-1][1]

        assert result["created"] == 1
        assert MusicTrack.objects.get(isrc="MXABC2600070").kind == MusicTrack.Kind.AUDIO

        events = list(run_import(MusicImportEndpoint(), workspace, rows, 1, self.mapping, dry_run=True))
        assert events[-1][1]["unparseable"]["track.kind"][0]["value"] == "AudioTrack"

    def test_existing_song_keeps_its_choice_until_decided(self):
        workspace = WorkspaceFactory()
        track = song(workspace, "A", "MXABC2600071")
        track.kind = MusicTrack.Kind.MUSIC_VIDEO
        track.save()
        row = {"Title": "A", "ISRC": "MXABC2600071", "Artist": "", "Type": "AudioTrack"}

        outcome, _, _ = MusicImportEndpoint()._import_row(workspace, row, self.mapping, "update")

        track.refresh_from_db()
        assert track.kind == MusicTrack.Kind.MUSIC_VIDEO
        assert outcome == "unchanged"


@pytest.mark.unit
def test_dates_with_a_time_part_are_read():
    from datetime import date

    from plane.app.views.music.base import _date

    assert _date("2024-12-13 00:00:00") == date(2024, 12, 13)
    assert _date("2024-12-13T00:00:00Z") == date(2024, 12, 13)
    assert _date("2024-12-13") == date(2024, 12, 13)
