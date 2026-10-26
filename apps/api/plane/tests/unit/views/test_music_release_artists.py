# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Release artists from the release panel: primary and featured people via
`artist_entries`, the older `artist_ids` (all primary) still accepted, and
unknown roles or people from another workspace rejected. Also the song list
filtered to one release (the panel's tracklist and its export)."""

import pytest

from plane.db.models import (
    MusicParty,
    MusicRelease,
    MusicReleaseArtist,
    MusicReleaseTrack,
    MusicTrack,
    Workspace,
    WorkspaceFeature,
)


@pytest.fixture
def music(workspace):
    WorkspaceFeature.objects.create(workspace=workspace, key=WorkspaceFeature.FeatureKey.MUSIC_CATALOG, is_enabled=True)
    return workspace


def _url(workspace, release=None):
    base = f"/api/workspaces/{workspace.slug}/music/releases/"
    return f"{base}{release.id}/" if release else base


def _roles(release):
    return sorted(
        (link.party.display_name, link.role)
        for link in MusicReleaseArtist.objects.filter(release=release).select_related("party")
    )


@pytest.mark.django_db
def test_artist_entries_set_primary_and_featured(session_client, music):
    release = MusicRelease.objects.create(workspace=music, title="Disco")
    ana = MusicParty.objects.create(workspace=music, display_name="Ana")
    beto = MusicParty.objects.create(workspace=music, display_name="Beto")

    response = session_client.patch(
        _url(music, release),
        {
            "artist_entries": [
                {"party_id": str(ana.id), "role": "PRIMARY"},
                {"party_id": str(beto.id), "role": "FEATURED"},
            ]
        },
        format="json",
    )
    assert response.status_code == 200
    assert _roles(release) == [("Ana", "PRIMARY"), ("Beto", "FEATURED")]
    assert {item["role"] for item in response.json()["artist_details"]} == {"PRIMARY", "FEATURED"}

    # Changing a role replaces the list; the old link is revived, not duplicated
    response = session_client.patch(
        _url(music, release), {"artist_entries": [{"party_id": str(ana.id), "role": "FEATURED"}]}, format="json"
    )
    assert response.status_code == 200
    assert _roles(release) == [("Ana", "FEATURED")]

    # Other fields alone leave the artists untouched
    response = session_client.patch(_url(music, release), {"label_name": "Sello"}, format="json")
    assert response.status_code == 200
    assert _roles(release) == [("Ana", "FEATURED")]


@pytest.mark.django_db
def test_artist_ids_still_primary(session_client, music):
    ana = MusicParty.objects.create(workspace=music, display_name="Ana")
    response = session_client.post(_url(music), {"title": "Nuevo", "artist_ids": [str(ana.id)]}, format="json")
    assert response.status_code == 201
    release = MusicRelease.objects.get(id=response.json()["id"])
    assert _roles(release) == [("Ana", "PRIMARY")]


@pytest.mark.django_db
def test_rejects_unknown_role_and_foreign_people(session_client, music, create_user):
    release = MusicRelease.objects.create(workspace=music, title="Disco")
    ana = MusicParty.objects.create(workspace=music, display_name="Ana")
    other = Workspace.objects.create(name="Otro", slug="otro-ws", owner=create_user)
    stranger = MusicParty.objects.create(workspace=other, display_name="Ajeno")

    bad_role = session_client.patch(
        _url(music, release), {"artist_entries": [{"party_id": str(ana.id), "role": "COMPOSER"}]}, format="json"
    )
    assert bad_role.status_code == 400
    foreign = session_client.patch(
        _url(music, release), {"artist_entries": [{"party_id": str(stranger.id), "role": "PRIMARY"}]}, format="json"
    )
    assert foreign.status_code == 400
    invalid = session_client.patch(
        _url(music, release), {"artist_entries": [{"party_id": "nope", "role": "PRIMARY"}]}, format="json"
    )
    assert invalid.status_code == 400
    assert _roles(release) == []


@pytest.mark.django_db
def test_tracks_filtered_by_release(session_client, music):
    release = MusicRelease.objects.create(workspace=music, title="Disco")
    first = MusicTrack.objects.create(workspace=music, title="Uno")
    second = MusicTrack.objects.create(workspace=music, title="Dos")
    MusicTrack.objects.create(workspace=music, title="Fuera")
    MusicReleaseTrack.objects.create(workspace=music, release=release, track=first, disc_number=1, track_number=2)
    MusicReleaseTrack.objects.create(workspace=music, release=release, track=second, disc_number=1, track_number=1)

    response = session_client.get(f"/api/workspaces/{music.slug}/music/tracks/", {"release": str(release.id)})
    assert response.status_code == 200
    rows = response.json()
    assert sorted(row["title"] for row in rows) == ["Dos", "Uno"]
    positions = {
        row["title"]: next(item["track_number"] for item in row["release_details"] if item["id"] == str(release.id))
        for row in rows
    }
    assert positions == {"Uno": 2, "Dos": 1}
