# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Release types: reading them from a cell (synonyms), inferring them when the
file doesn't say (title hints, song-count thresholds) on import, and fixing an
existing catalog with music/releases/infer-types/."""

import pytest

from plane.app.views.music.base import IMPORT_FIELDS, UNPARSED_CHECKS, MusicImportEndpoint, _infer_mapping
from plane.app.views.music.importer import run_import
from plane.db.models import MusicRelease, MusicReleaseTrack, MusicTrack, User, WorkspaceFeature, WorkspaceMember
from plane.utils.music_release_types import (
    TRACK_COUNT_THRESHOLDS,
    infer_release_type,
    release_type_value,
    type_from_title,
    type_from_track_count,
)

Type = MusicRelease.Type


@pytest.fixture
def music(workspace):
    WorkspaceFeature.objects.create(workspace=workspace, key=WorkspaceFeature.FeatureKey.MUSIC_CATALOG, is_enabled=True)
    return workspace


def _run(workspace, rows, mapping, **options):
    options.setdefault("strategy", "update")
    result = None
    for event in run_import(MusicImportEndpoint(), workspace, rows, 1, mapping, **options):
        if event[0] == "result":
            result = event[1]
    return result


def _rows(release, count, start=0, **extra):
    return [
        {
            "Track Name": f"{release} song {index}",
            "Product Title": release,
            "Isrc": f"MXA3Y24{start + index:05d}",
            **extra,
        }
        for index in range(count)
    ]


MAPPING = {"track.title": "Track Name", "release.title": "Product Title", "track.isrc": "Isrc"}


def _type(workspace, title):
    return MusicRelease.objects.get(workspace=workspace, title=title).release_type


def _release(workspace, title, tracks, release_type=Type.ALBUM):
    release = MusicRelease.objects.create(workspace=workspace, title=title, release_type=release_type)
    for index in range(tracks):
        track = MusicTrack.objects.create(workspace=workspace, title=f"{title} {index}")
        MusicReleaseTrack.objects.create(workspace=workspace, release=release, track=track, track_number=index + 1)
    return release


# ── Parsing ──────────────────────────────────────────────────────────────────


@pytest.mark.unit
@pytest.mark.parametrize(
    "raw, expected",
    [
        ("Single", Type.SINGLE),
        ("SINGLE", Type.SINGLE),
        ("sencillo", Type.SINGLE),
        ("Maxi-Single", Type.SINGLE),
        ("EP", Type.EP),
        ("e.p.", Type.EP),
        ("LP", Type.LP),
        ("Álbum", Type.ALBUM),
        ("album", Type.ALBUM),
        ("Full-length", Type.ALBUM),
        ("Compilation", Type.COMPILATION),
        ("Compilado", Type.COMPILATION),
        ("Recopilatorio", Type.COMPILATION),
        ("Soundtrack", Type.SOUNDTRACK),
        ("Banda sonora", Type.SOUNDTRACK),
        ("OST", Type.SOUNDTRACK),
        ("Audio", None),
        ("Mixtape", None),
        ("", None),
        (None, None),
    ],
)
def test_release_type_synonyms(raw, expected):
    assert release_type_value(raw) == expected
    if raw:
        # Unknown values go to the review's value decisions
        assert UNPARSED_CHECKS["release.type"](raw) == expected


@pytest.mark.unit
def test_aliases_map_release_type_but_not_product_type():
    for header in (
        "Release Type",
        "Product Format",
        "Format",
        "Tipo de lanzamiento",
        "Release Format",
        "Configuration",
    ):
        assert _infer_mapping(["Product Type", header], IMPORT_FIELDS).get("release.type") == header
    assert "release.type" not in _infer_mapping(["Product Type", "Product Title"], IMPORT_FIELDS)


# ── Inference rule ───────────────────────────────────────────────────────────


@pytest.mark.unit
def test_track_count_thresholds():
    assert TRACK_COUNT_THRESHOLDS == ((1, Type.SINGLE), (6, Type.EP))
    assert type_from_track_count(0) is None
    assert type_from_track_count(1) == Type.SINGLE
    assert type_from_track_count(2) == Type.EP
    assert type_from_track_count(6) == Type.EP
    assert type_from_track_count(7) == Type.ALBUM
    assert type_from_track_count(20) == Type.ALBUM


@pytest.mark.unit
@pytest.mark.parametrize(
    "title, expected",
    [
        ('Single "Cómo estás tú"', Type.SINGLE),
        ("Sencillo: Amor", Type.SINGLE),
        ("Amor - Single", Type.SINGLE),
        ("Amor (Single)", Type.SINGLE),
        ("Verano EP", Type.EP),
        ("EP Navidad", Type.EP),
        ("Amor - EP", Type.EP),
        ("De Fiesta y Amanecida Vol. 2", None),
        ("Epílogo", None),
        ("Deep", None),
        ("Lonely Single Life", None),
    ],
)
def test_title_hints(title, expected):
    assert type_from_title(title) == expected


@pytest.mark.unit
def test_title_hint_wins_over_track_count():
    assert infer_release_type('Single "Amor"', 3) == Type.SINGLE
    assert infer_release_type("Verano EP", 1) == Type.EP
    assert infer_release_type("Grandes éxitos", 12) == Type.ALBUM
    assert infer_release_type("Vacío", 0) is None


# ── Import ───────────────────────────────────────────────────────────────────


@pytest.mark.django_db
def test_import_infers_types_of_new_releases(workspace):
    rows = (
        _rows("Uno", 1)
        + _rows("Cuatro", 4, start=10)
        + _rows("Grande", 8, start=20)
        + _rows('Single "Dos"', 2, start=40)
    )
    result = _run(workspace, rows, MAPPING)
    assert result["errors"] == []
    assert result["release_types_inferred"] == {"SINGLE": 2, "EP": 1, "ALBUM": 1}
    assert _type(workspace, "Uno") == Type.SINGLE
    assert _type(workspace, "Cuatro") == Type.EP
    assert _type(workspace, "Grande") == Type.ALBUM
    assert _type(workspace, 'Single "Dos"') == Type.SINGLE


@pytest.mark.django_db
def test_dry_run_reports_without_writing(workspace):
    from django.db import transaction

    with transaction.atomic():
        result = _run(workspace, _rows("Uno", 1), MAPPING, dry_run=True)
        assert result["release_types_inferred"] == {"SINGLE": 1}
        # Reported, not written (the caller rolls the dry run back anyway)
        assert _type(workspace, "Uno") == Type.ALBUM
        transaction.set_rollback(True)


@pytest.mark.django_db
def test_import_never_infers_existing_releases(workspace):
    existing = _release(workspace, "Viejo", 0)
    result = _run(workspace, _rows("Viejo", 1) + _rows("Nuevo", 1, start=5), MAPPING)
    assert result["release_types_inferred"] == {"SINGLE": 1}
    existing.refresh_from_db()
    assert existing.release_type == Type.ALBUM
    assert _type(workspace, "Nuevo") == Type.SINGLE


@pytest.mark.django_db
def test_explicit_column_wins(workspace):
    rows = _rows("Uno", 1, **{"Release Type": "Compilado"}) + _rows("Dos", 1, start=5, **{"Release Type": "Album"})
    result = _run(workspace, rows, {**MAPPING, "release.type": "Release Type"})
    assert result["release_types_inferred"] == {}
    assert _type(workspace, "Uno") == Type.COMPILATION
    assert _type(workspace, "Dos") == Type.ALBUM


@pytest.mark.django_db
def test_fixed_value_wins(workspace):
    result = _run(workspace, _rows("Uno", 3), MAPPING, constants={"release.type": "SINGLE"})
    assert result["release_types_inferred"] == {}
    assert _type(workspace, "Uno") == Type.SINGLE


@pytest.mark.django_db
def test_unknown_value_is_listed_and_inferred_until_decided(workspace):
    from django.db import transaction

    rows = _rows("Uno", 1, **{"Release Type": "Mixtape"})
    mapping = {**MAPPING, "release.type": "Release Type"}
    with transaction.atomic():
        review = _run(workspace, rows, mapping, dry_run=True)
        transaction.set_rollback(True)
    assert review["unparseable"]["release.type"][0]["value"] == "Mixtape"
    # The user's decision makes it explicit
    result = _run(workspace, rows, mapping, value_overrides={"release.type": {"mixtape": "EP"}})
    assert result["release_types_inferred"] == {}
    assert _type(workspace, "Uno") == Type.EP


@pytest.mark.django_db
def test_file_type_upgrades_default_album_of_existing_release(workspace):
    """Re-importing an export with "Release Type" fixes a release still on the
    default, but never one whose type someone chose."""
    default = _release(workspace, "Por defecto", 0)
    chosen = _release(workspace, "Elegido", 0, release_type=Type.LP)
    rows = _rows("Por defecto", 1, **{"Release Type": "Single"}) + _rows(
        "Elegido", 1, start=5, **{"Release Type": "Single"}
    )
    _run(workspace, rows, {**MAPPING, "release.type": "Release Type"})
    default.refresh_from_db()
    chosen.refresh_from_db()
    assert default.release_type == Type.SINGLE
    assert chosen.release_type == Type.LP


# ── Fixing an existing catalog ───────────────────────────────────────────────


def _infer(client, workspace, **payload):
    return client.post(f"/api/workspaces/{workspace.slug}/music/releases/infer-types/", payload, format="json")


@pytest.mark.unit
@pytest.mark.django_db
class TestInferTypesEndpoint:
    def test_dry_run_then_apply(self, session_client, music):
        one = _release(music, "Uno", 1)
        three = _release(music, "Tres", 3)
        big = _release(music, "Grande", 9)
        hinted = _release(music, 'Single "Amor"', 2)
        chosen = _release(music, "Elegido", 1, release_type=Type.LP)
        empty = _release(music, "Vacío", 0)

        response = _infer(session_client, music, dry_run=True)
        assert response.status_code == 200
        body = response.json()
        assert body["counts"] == {"SINGLE": 2, "EP": 1, "ALBUM": 0}
        changes = {change["title"]: change for change in body["changes"]}
        assert set(changes) == {"Uno", "Tres", 'Single "Amor"'}
        assert changes["Tres"] == {"id": str(three.id), "title": "Tres", "tracks": 3, "from": "ALBUM", "to": "EP"}
        for release in (one, three, big, hinted, chosen, empty):
            release.refresh_from_db()
            assert release.release_type == (Type.LP if release == chosen else Type.ALBUM)

        response = _infer(session_client, music, dry_run=False)
        assert response.status_code == 200
        assert response.json()["updated"] == 3
        for release, expected in (
            (one, Type.SINGLE),
            (three, Type.EP),
            (big, Type.ALBUM),
            (hinted, Type.SINGLE),
            (chosen, Type.LP),
            (empty, Type.ALBUM),
        ):
            release.refresh_from_db()
            assert release.release_type == expected
        # Nothing left to fix
        assert _infer(session_client, music, dry_run=True).json()["changes"] == []

    def test_apply_only_checked_releases(self, session_client, music):
        one = _release(music, "Uno", 1)
        two = _release(music, "Dos", 1)
        response = _infer(session_client, music, dry_run=False, release_ids=[str(one.id), "not-a-uuid"])
        assert response.json()["updated"] == 1
        one.refresh_from_db()
        two.refresh_from_db()
        assert (one.release_type, two.release_type) == (Type.SINGLE, Type.ALBUM)

    def test_deleted_songs_do_not_count(self, music, session_client):
        release = _release(music, "Dos", 2)
        release.track_links.first().track.delete()
        change = _infer(session_client, music, dry_run=True).json()["changes"][0]
        assert (change["tracks"], change["to"]) == (1, "SINGLE")

    def test_admin_only(self, api_client, music):
        _release(music, "Uno", 1)
        member = User.objects.create(email="member-types@plane.so", username="member_types")
        WorkspaceMember.objects.create(workspace=music, member=member, role=15)
        api_client.force_authenticate(user=member)
        assert _infer(api_client, music, dry_run=False).status_code == 403
        assert MusicRelease.objects.get(workspace=music, title="Uno").release_type == Type.ALBUM

    def test_bulk_edit_sets_release_type(self, session_client, music):
        release = _release(music, "Uno", 2)
        other = _release(music, "Otro", 1)
        track_ids = [str(link.track_id) for link in release.track_links.all()]
        response = session_client.post(
            f"/api/workspaces/{music.slug}/music/tracks/bulk-update/",
            {"track_ids": track_ids, "changes": [{"field": "release_type", "op": "set", "value": "Sencillo"}]},
            format="json",
        )
        assert response.status_code == 200, response.json()
        assert response.json()["updated"] == 2
        release.refresh_from_db()
        other.refresh_from_db()
        assert (release.release_type, other.release_type) == (Type.SINGLE, Type.ALBUM)
        bad = session_client.post(
            f"/api/workspaces/{music.slug}/music/tracks/bulk-update/",
            {"track_ids": track_ids, "changes": [{"field": "release_type", "op": "set", "value": "Mixtape"}]},
            format="json",
        )
        assert bad.status_code == 400
