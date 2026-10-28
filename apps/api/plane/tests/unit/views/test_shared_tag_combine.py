# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Browsing several shared tags at once: an artist's tag combined with an
album's tag gives what carries both (contracts tagged with both, songs
credited to the artist and tagged with the album…), or either with
mode=any. Credits count as carrying the artist's tag, exactly as for one
tag; filters, paging, years and the export follow the combination; ids from
another workspace are ignored; permissions are the same as for one tag."""

from datetime import date
from unittest import mock

import pytest
from django.test import override_settings

from plane.db.models import (
    Contract,
    EntityTagLink,
    ExporterHistory,
    FileAsset,
    FileTag,
    FileTagLink,
    MusicCredit,
    MusicParty,
    MusicRelease,
    MusicReleaseArtist,
    MusicTrack,
    User,
    Workspace,
    WorkspaceFeature,
    WorkspaceMember,
)
from plane.utils.shared_tags import combined_ids

SECRET = "combine-secret"


@pytest.fixture
def space(workspace):
    for key in ("references", "file_library", "music_catalog"):
        WorkspaceFeature.objects.create(workspace=workspace, key=key, is_enabled=True)
    return workspace


def _contract(workspace, user, title, tags=(), fecha_inicio=None):
    asset = FileAsset.objects.create(
        workspace=workspace,
        asset=f"{title}.pdf",
        attributes={"name": f"{title}.pdf"},
        entity_type=FileAsset.EntityTypeContext.WORKSPACE_FILE_LIBRARY,
        is_uploaded=True,
        created_by=user,
    )
    contract = Contract.objects.create(workspace=workspace, file_asset=asset, titulo=title, fecha_inicio=fecha_inicio)
    for tag in tags:
        FileTagLink.objects.create(workspace=workspace, file_asset=asset, tag=tag)
    return contract


def _tag_entity(workspace, tag, entity_type, entity_id):
    EntityTagLink.objects.create(
        workspace=workspace,
        tag=tag,
        entity_type=entity_type,
        entity_id=entity_id,
        status=EntityTagLink.Status.CONFIRMED,
    )


@pytest.fixture
def catalog(space, create_user):
    """3BallMTY (artist tag, linked to the catalog artist) and "Álbum X":

    - contract "Ambas" tagged with both; contract "Solo artista" only with the artist;
    - song "Uno" credited to the artist and tagged with the album (both);
    - song "Dos" only credited; song "Tres" only tagged with the album;
    - release "Álbum X" credited to the artist and tagged with the album (both).
    """
    party = MusicParty.objects.create(workspace=space, display_name="3BallMTY")
    artist = FileTag.objects.create(workspace=space, name="3BallMTY", kind=FileTag.Kind.ARTIST, party=party)
    album = FileTag.objects.create(workspace=space, name="Álbum X")
    both = _contract(space, create_user, "Ambas", [artist, album], fecha_inicio=date(2023, 5, 1))
    only_artist = _contract(space, create_user, "Solo artista", [artist], fecha_inicio=date(2021, 1, 1))

    def song(title, credited, tagged, release_date):
        track = MusicTrack.objects.create(workspace=space, title=title, release_date=release_date)
        if credited:
            MusicCredit.objects.create(workspace=space, track=track, party=party, role=MusicCredit.Role.PRIMARY_ARTIST)
        if tagged:
            _tag_entity(space, album, "music_track", track.id)
        return track

    uno = song("Uno", True, True, date(2024, 3, 1))
    dos = song("Dos", True, False, date(2022, 3, 1))
    tres = song("Tres", False, True, date(2020, 3, 1))
    release = MusicRelease.objects.create(workspace=space, title="Álbum X", release_date=date(2024, 3, 1))
    MusicReleaseArtist.objects.create(workspace=space, release=release, party=party)
    _tag_entity(space, album, "music_release", release.id)
    return {
        "party": party,
        "artist": artist,
        "album": album,
        "both": both,
        "only_artist": only_artist,
        "uno": uno,
        "dos": dos,
        "tres": tres,
        "release": release,
    }


def _get(client, workspace, tag, **params):
    return client.get(f"/api/workspaces/{workspace.slug}/shared-tags/{tag.id}/entities/", params)


def _ids(group):
    return {item["id"] for item in group["items"]}


# ── Combining ────────────────────────────────────────────────────────────────


@pytest.mark.django_db
def test_combined_ids_intersects_and_unites_with_credits(space, catalog):
    artist, album = catalog["artist"], catalog["album"]
    assert set(combined_ids(space.id, [artist, album], "music_track")) == {str(catalog["uno"].id)}
    assert set(combined_ids(space.id, [artist, album], "music_track", "any")) == {
        str(catalog[name].id) for name in ("uno", "dos", "tres")
    }
    assert set(combined_ids(space.id, [artist, album], "contract")) == {str(catalog["both"].id)}
    # One tag is the same as tagged_ids
    assert set(combined_ids(space.id, [artist], "music_release")) == {str(catalog["release"].id)}


@pytest.mark.django_db
def test_all_mode_gives_what_carries_every_tag(session_client, space, catalog):
    response = _get(session_client, space, catalog["artist"], **{"with": str(catalog["album"].id)})
    assert response.status_code == 200
    data = response.json()
    assert [tag["name"] for tag in data["with_tags"]] == ["Álbum X"]
    assert data["mode"] == "all"
    groups = data["groups"]
    assert _ids(groups["contract"]) == {str(catalog["both"].id)}
    # Song credited to the artist + tagged with the album
    assert _ids(groups["music_track"]) == {str(catalog["uno"].id)}
    assert _ids(groups["music_release"]) == {str(catalog["release"].id)}
    # The artist itself only carries the artist's tag
    assert "music_artist" not in groups
    assert groups["music_track"]["count"] == 1
    # Backlinks describe one tag, not a combination
    assert data["mentioned_in"] == []
    assert data["years"] == [2024, 2023]


@pytest.mark.django_db
def test_any_mode_gives_the_union(session_client, space, catalog):
    response = _get(session_client, space, catalog["album"], **{"with": str(catalog["artist"].id), "mode": "any"})
    assert response.status_code == 200
    groups = response.json()["groups"]
    assert groups["contract"]["count"] == 2
    assert groups["music_track"]["count"] == 3
    assert groups["music_release"]["count"] == 1
    assert _ids(groups["music_artist"]) == {str(catalog["party"].id)}


@pytest.mark.django_db
def test_filters_and_paging_apply_to_the_combination(session_client, space, catalog):
    artist, album = catalog["artist"], catalog["album"]
    common = {"with": str(album.id), "mode": "any", "types": "music_track"}
    first = _get(session_client, space, artist, limit=2, **common).json()
    assert list(first["groups"]) == ["music_track"]
    assert first["groups"]["music_track"]["count"] == 3
    # Newest first
    assert [item["title"] for item in first["groups"]["music_track"]["items"]] == ["Uno", "Dos"]
    second = _get(session_client, space, artist, limit=2, offset=2, **common).json()
    assert [item["title"] for item in second["groups"]["music_track"]["items"]] == ["Tres"]
    assert "years" not in second

    searched = _get(session_client, space, artist, q="tres", **common).json()
    assert _ids(searched["groups"]["music_track"]) == {str(catalog["tres"].id)}

    dated = _get(session_client, space, artist, date_from="2021-01-01", date_to="2023-12-31", **common).json()
    assert _ids(dated["groups"]["music_track"]) == {str(catalog["dos"].id)}

    years = _get(session_client, space, artist, **common).json()["years"]
    assert years == [2024, 2022, 2020]


@pytest.mark.django_db
def test_nothing_in_common_gives_no_groups(session_client, space, catalog, create_user):
    lonely = FileTag.objects.create(workspace=space, name="Otra cosa")
    _contract(space, create_user, "Ajeno", [lonely])
    data = _get(session_client, space, catalog["artist"], **{"with": str(lonely.id)}).json()
    assert data["groups"] == {}
    assert data["years"] == []


@pytest.mark.django_db
def test_foreign_or_unknown_tags_are_ignored_and_bad_input_rejected(session_client, space, catalog, create_user):
    other = Workspace.objects.create(name="Otro", owner=create_user, slug="otro-ws")
    foreign = FileTag.objects.create(workspace=other, name="Ajena")
    artist = catalog["artist"]
    single = _get(session_client, space, artist).json()
    combined = _get(session_client, space, artist, **{"with": f"{foreign.id},{artist.id}"}).json()
    # Dropped: neither the foreign tag nor the main tag itself combine
    assert combined["with_tags"] == []
    assert {name: group["count"] for name, group in combined["groups"].items()} == {
        name: group["count"] for name, group in single["groups"].items()
    }
    assert _get(session_client, space, artist, **{"with": "not-an-id"}).status_code == 400
    assert _get(session_client, space, artist, **{"with": str(catalog["album"].id), "mode": "some"}).status_code == 400


# ── Permissions ──────────────────────────────────────────────────────────────


@pytest.mark.django_db
def test_guest_only_sees_what_their_role_opens(api_client, space, catalog):
    guest = User.objects.create(email="guest@example.com", username="guest-combine")
    WorkspaceMember.objects.create(workspace=space, member=guest, role=5)
    api_client.force_authenticate(user=guest)
    data = _get(api_client, space, catalog["artist"], **{"with": str(catalog["album"].id)}).json()
    # Music and contracts are admin-only
    assert list(data["groups"]) == []


@pytest.mark.django_db
def test_outsiders_and_disabled_references_are_refused(api_client, session_client, space, catalog):
    outsider = User.objects.create(email="out@example.com", username="out-combine")
    api_client.force_authenticate(user=outsider)
    params = {"with": str(catalog["album"].id)}
    assert _get(api_client, space, catalog["artist"], **params).status_code == 403
    WorkspaceFeature.objects.filter(workspace=space, key="references").update(is_enabled=False)
    assert _get(session_client, space, catalog["artist"], **params).status_code == 403


# ── Export and assistant ─────────────────────────────────────────────────────


@pytest.mark.django_db
def test_export_keeps_the_combination(session_client, space, catalog):
    with mock.patch("plane.bgtasks.reference_task.shared_tag_export_task.delay") as delay:
        response = session_client.post(
            f"/api/workspaces/{space.slug}/shared-tags/{catalog['artist'].id}/export/",
            {"types": ["contract"], "with": [str(catalog["album"].id)], "mode": "all"},
            format="json",
        )
    assert response.status_code == 201
    delay.assert_called_once()
    filters = ExporterHistory.objects.get(id=response.json()["export_id"]).filters
    assert filters["with"] == [str(catalog["album"].id)]
    assert filters["mode"] == "all"


@pytest.mark.django_db
@override_settings(PLANE_INTERNAL_API_SECRET=SECRET)
def test_assistant_finds_by_several_tags(api_client, space, catalog, create_user):
    url = f"/api/internal/workspaces/{space.id}/assistant/tagged/"
    headers = {"HTTP_X_PLANE_INTERNAL_KEY": SECRET}
    ids = f"{catalog['artist'].id},{catalog['album'].id}"
    data = api_client.get(url, {"user_id": str(create_user.id), "tag_ids": ids}, **headers).json()
    assert data["tag"]["name"] == "3BallMTY"
    assert [tag["name"] for tag in data["with_tags"]] == ["Álbum X"]
    assert data["groups"]["contract"]["count"] == 1
    assert data["groups"]["music_track"]["count"] == 1
    assert data["link"].endswith(f"?with={catalog['album'].id}&mode=all")

    any_mode = api_client.get(url, {"user_id": str(create_user.id), "tag_ids": ids, "mode": "any"}, **headers).json()
    assert any_mode["groups"]["music_track"]["count"] == 3

    # tag_id alone still works
    single = api_client.get(url, {"user_id": str(create_user.id), "tag_id": str(catalog["album"].id)}, **headers)
    assert single.status_code == 200
    assert "with_tags" not in single.json()

    missing = api_client.get(
        url, {"user_id": str(create_user.id), "tag_ids": f"{catalog['artist'].id},{space.id}"}, **headers
    )
    assert missing.status_code == 404
