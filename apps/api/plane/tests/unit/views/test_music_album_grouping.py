# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Grouping songs into albums: the assistant's read-only matching (ISRC,
title + artist, ambiguous titles, every duplicate release listed) and the
admin endpoint that applies it (create or reuse the album, merge duplicates,
numbering, metadata filled without overwriting, contract links and tags
re-pointed, empty merged releases removed, all or nothing, dry run)."""

import pytest
from django.test import override_settings

from plane.db.models import (
    Contract,
    ContractWorkLink,
    EntityTagLink,
    FileAsset,
    FileTag,
    MusicCredit,
    MusicParty,
    MusicRelease,
    MusicReleaseArtist,
    MusicReleaseTrack,
    MusicTrack,
    User,
    WorkspaceFeature,
    WorkspaceMember,
)
from plane.utils.music_grouping import album_key

SECRET = "grouping-secret"


@pytest.fixture
def music(workspace):
    WorkspaceFeature.objects.create(workspace=workspace, key=WorkspaceFeature.FeatureKey.MUSIC_CATALOG, is_enabled=True)
    return workspace


@pytest.fixture
def artist(music):
    return MusicParty.objects.create(workspace=music, display_name="Banda VIP")


def _song(workspace, title, party=None, isrc=""):
    track = MusicTrack.objects.create(workspace=workspace, title=title, isrc=isrc)
    if party:
        MusicCredit.objects.create(workspace=workspace, track=track, party=party, role=MusicCredit.Role.PRIMARY_ARTIST)
    return track


def _release(workspace, title, songs=(), party=None, **fields):
    release = MusicRelease.objects.create(workspace=workspace, title=title, **fields)
    if party:
        MusicReleaseArtist.objects.create(workspace=workspace, release=release, party=party)
    for number, song in enumerate(songs, start=1):
        MusicReleaseTrack.objects.create(workspace=workspace, release=release, track=song, track_number=number)
    return release


def _tracklist(release):
    return [
        (link.disc_number, link.track_number, link.track.title)
        for link in MusicReleaseTrack.objects.filter(release=release)
        .select_related("track")
        .order_by("disc_number", "track_number")
    ]


def _group(client, workspace, albums, **extra):
    return client.post(
        f"/api/workspaces/{workspace.slug}/music/releases/group/", {"albums": albums, **extra}, format="json"
    )


def _match(client, workspace, user, albums):
    return client.post(
        f"/api/internal/workspaces/{workspace.id}/assistant/music/album-grouping/match/",
        {"user_id": str(user.id), "albums": albums},
        format="json",
        HTTP_X_PLANE_INTERNAL_KEY=SECRET,
    )


# ── Normalization ────────────────────────────────────────────────────────────


@pytest.mark.unit
def test_album_key_drops_edition_suffixes_only():
    assert album_key("Álbum Acústico (Deluxe Edition)") == album_key("album acustico")
    assert album_key("Disco - Remastered 2020") == "disco"
    assert album_key("Disco [Edición Especial]") == "disco"
    assert album_key("20 años VIP V1") == "20 anos vip v1"
    # A live or acoustic album is another album
    assert album_key("Disco (En Vivo)") != album_key("Disco")


# ── Matching (assistant, read-only) ──────────────────────────────────────────


@pytest.mark.django_db
@override_settings(PLANE_INTERNAL_API_SECRET=SECRET)
def test_match_lists_every_duplicate_and_suggests_target(api_client, create_user, music, artist):
    songs = [_song(music, f"Canción {n}", artist, isrc=f"MXA112400{n:03d}") for n in range(1, 4)]
    oldest = _release(music, "20 años VIP V1", [songs[0]], artist)
    _release(music, "20 Años VIP V1", [songs[1]], artist)
    _release(music, "20 años vip v1", [songs[2]], artist)
    _release(music, "20 años VIP V1", [], MusicParty.objects.create(workspace=music, display_name="Otra Banda"))
    with_upc = _release(music, "20 años VIP V1 (Deluxe)", [], artist, upc="0123456789012")

    response = _match(
        api_client,
        music,
        create_user,
        [
            {
                "title": "20 años VIP V1",
                "artists": ["Banda VIP"],
                "tracks": [
                    {"title": "Cancion 1"},
                    {"title": "Otra cosa", "isrc": "MXA-11-24-00002"},
                    {"title": "canción 3", "artists": ["Banda VIP"]},
                    {"title": "No existe"},
                ],
            }
        ],
    )
    assert response.status_code == 200
    album = response.json()["albums"][0]
    candidates = {row["id"]: row for row in album["release_candidates"]}
    # The three same-title releases plus the deluxe edition; not the other band's
    assert len(candidates) == 4
    assert all(row["track_count"] == 1 for row in candidates.values() if row["match_type"] == "title_artist")
    assert candidates[str(with_upc.id)]["match_type"] == "edition"
    assert candidates[str(with_upc.id)]["same_title_artist"] is False
    # No UPC was given: the edition with a UPC doesn't lead over the exact title
    assert album["suggested_target_id"] == str(oldest.id)
    assert album["summary"]["duplicates"] == 2

    tracks = album["tracks"]
    assert tracks[0]["match"]["track_id"] == str(songs[0].id)
    assert tracks[0]["match"]["match_type"] == "title_artist" and tracks[0]["match"]["confidence"] == 0.9
    assert tracks[1]["match"]["track_id"] == str(songs[1].id) and tracks[1]["match"]["confidence"] == 1.0
    assert tracks[2]["match"]["releases"][0]["title"].lower() == "20 años vip v1"
    assert tracks[3]["match"] is None
    # Numbers default to the list order
    assert [row["track_number"] for row in tracks] == [1, 2, 3, 4]
    assert album["summary"] == {"tracks": 4, "matched": 3, "ambiguous": 0, "unmatched": 1, "duplicates": 2}


@pytest.mark.django_db
@override_settings(PLANE_INTERNAL_API_SECRET=SECRET)
def test_match_upc_wins_and_ambiguous_titles_list_candidates(api_client, create_user, music, artist):
    other = MusicParty.objects.create(workspace=music, display_name="Nadie")
    intro_a = _song(music, "Intro", other)
    intro_b = _song(music, "Intro", other)
    _song(music, "Intro")
    by_upc = _release(music, "Nombre distinto", [], upc="0123456789012")
    response = _match(
        api_client,
        music,
        create_user,
        [{"title": "Disco", "upc": "123456789012", "artists": "Banda VIP", "tracks": [{"title": "Intro"}]}],
    )
    album = response.json()["albums"][0]
    assert album["suggested_target_id"] == str(by_upc.id)
    assert album["release_candidates"][0]["match_type"] == "upc"
    track = album["tracks"][0]
    assert track["ambiguous"] is True
    assert track["match"]["confidence"] == 0.7
    assert len(track["candidates"]) == 3
    assert {row["track_id"] for row in track["candidates"]} >= {str(intro_a.id), str(intro_b.id)}


@pytest.mark.django_db
@override_settings(PLANE_INTERNAL_API_SECRET=SECRET)
def test_match_prefers_the_song_already_in_the_album_and_flags_fragments(api_client, create_user, music, artist):
    in_album = _song(music, "Intro", artist)
    _song(music, "Intro", artist)
    single = _song(music, "Sencillo", artist)
    album_release = _release(music, "Disco", [in_album], artist)
    fragment = _release(music, "Sencillo (Single)", [single], artist)
    response = _match(
        api_client,
        music,
        create_user,
        [{"title": "Disco", "artists": ["Banda VIP"], "tracks": [{"title": "Intro"}, {"title": "Sencillo"}]}],
    )
    album = response.json()["albums"][0]
    track = album["tracks"][0]
    assert track["ambiguous"] is False and track["match"]["track_id"] == str(in_album.id)
    rows = {row["id"]: row for row in album["release_candidates"]}
    assert album["suggested_target_id"] == str(album_release.id)
    assert rows[str(fragment.id)]["match_type"] == "contained"
    assert rows[str(fragment.id)]["same_title_artist"] is False


@pytest.mark.django_db
@override_settings(PLANE_INTERNAL_API_SECRET=SECRET)
def test_match_requires_music_admin_and_writes_nothing(api_client, music, artist):
    member = User.objects.create(email="member@grouping.so", username="grouping_member")
    WorkspaceMember.objects.create(workspace=music, member=member, role=15)
    response = _match(api_client, music, member, [{"title": "Disco", "tracks": [{"title": "Intro"}]}])
    assert response.status_code == 403
    response = api_client.post(
        f"/api/internal/workspaces/{music.id}/assistant/music/album-grouping/match/",
        {"user_id": str(member.id), "albums": []},
        format="json",
    )
    assert response.status_code in (401, 403)


# ── Applying (admin, atomic) ─────────────────────────────────────────────────


@pytest.mark.django_db
def test_apply_creates_album_with_numbering_and_draft_songs(session_client, music, artist):
    one = _song(music, "Uno", artist)
    two = _song(music, "Dos", artist)
    response = _group(
        session_client,
        music,
        [
            {
                "target": {"create": {"title": "Nuevo disco", "artists": ["Banda VIP"], "upc": "0123456789012"}},
                "tracks": [
                    {"track_id": str(two.id), "track_number": 2},
                    {"track_id": str(one.id), "track_number": 1},
                ],
                "create_tracks": [{"title": "Tres", "artists": ["Banda VIP"], "track_number": 3}],
            }
        ],
    )
    assert response.status_code == 200, response.json()
    summary = response.json()["albums"][0]
    assert summary["target"]["created"] is True
    assert summary["tracks_linked"] == 2 and summary["tracks_created"] == 1 and summary["total_tracks"] == 3
    release = MusicRelease.objects.get(id=summary["target"]["id"])
    assert release.upc == "0123456789012" and release.status == "DRAFT"
    assert list(release.artist_links.values_list("party_id", flat=True)) == [artist.id]
    assert _tracklist(release) == [(1, 1, "Uno"), (1, 2, "Dos"), (1, 3, "Tres")]
    assert MusicTrack.objects.get(title="Tres").status == "DRAFT"


@pytest.mark.django_db
def test_apply_merges_duplicates_copies_metadata_and_repoints_links(session_client, music, artist, create_user):
    songs = [_song(music, f"Tema {n}", artist) for n in range(1, 4)]
    target = _release(music, "Album Acustico", [songs[0]], artist, label_name="Sello propio")
    dup_a = _release(
        music,
        "Album Acustico",
        [songs[1]],
        artist,
        upc="0123456789012",
        label_name="Otro sello",
        cover_url="https://img/cover.jpg",
    )
    featured = MusicParty.objects.create(workspace=music, display_name="Invitada")
    MusicReleaseArtist.objects.create(workspace=music, release=dup_a, party=featured, role="FEATURED")
    dup_b = _release(music, "Album Acustico", [songs[2]], artist)
    untouched = _release(music, "Album Acustico", [], artist)

    asset = FileAsset.objects.create(
        workspace=music, asset="c.pdf", attributes={"name": "c.pdf"}, entity_type="FILE_LIBRARY", created_by=create_user
    )
    contract = Contract.objects.create(workspace=music, file_asset=asset, titulo="C")
    other_asset = FileAsset.objects.create(
        workspace=music, asset="d.pdf", attributes={"name": "d.pdf"}, entity_type="FILE_LIBRARY", created_by=create_user
    )
    other_contract = Contract.objects.create(workspace=music, file_asset=other_asset, titulo="D")
    Rel = ContractWorkLink.EntityType.MUSIC_RELEASE
    ContractWorkLink.objects.create(
        workspace=music, contract=contract, entity_type=Rel, entity_id=target.id, status="SUGGESTED"
    )
    ContractWorkLink.objects.create(
        workspace=music, contract=contract, entity_type=Rel, entity_id=dup_a.id, status="LINKED"
    )
    ContractWorkLink.objects.create(
        workspace=music, contract=other_contract, entity_type=Rel, entity_id=dup_b.id, status="LINKED"
    )
    tag = FileTag.objects.create(workspace=music, name="Acústicos")
    EntityTagLink.objects.create(workspace=music, tag=tag, entity_type="music_release", entity_id=dup_b.id)

    response = _group(
        session_client,
        music,
        [{"target": {"release_id": str(target.id)}, "merge_release_ids": [str(dup_a.id), str(dup_b.id)]}],
    )
    assert response.status_code == 200, response.json()
    summary = response.json()["albums"][0]
    assert summary["tracks_moved"] == 2 and summary["total_tracks"] == 3
    # Every single was track 1: the moved ones go to the end
    assert _tracklist(target) == [(1, 1, "Tema 1"), (1, 2, "Tema 2"), (1, 3, "Tema 3")]
    target.refresh_from_db()
    assert target.upc == "0123456789012" and target.cover_url == "https://img/cover.jpg"
    assert target.label_name == "Sello propio"  # not overwritten
    assert set(summary["metadata_copied"]) == {"upc", "cover_url"}
    assert MusicReleaseArtist.objects.filter(release=target, party=featured, role="FEATURED").exists()
    # Merged releases are gone; the one not listed stays
    assert not MusicRelease.objects.filter(id__in=[dup_a.id, dup_b.id]).exists()
    assert MusicRelease.objects.filter(id=untouched.id).exists()
    assert [row["deleted"] for row in summary["merged_releases"]] == [True, True]
    # One link per contract on the target, the confirmed one kept
    links = ContractWorkLink.objects.filter(entity_type=Rel, entity_id=target.id)
    assert sorted((link.contract_id, link.status) for link in links) == sorted(
        [(contract.id, "LINKED"), (other_contract.id, "LINKED")]
    )
    assert not ContractWorkLink.objects.filter(entity_id__in=[dup_a.id, dup_b.id]).exists()
    assert EntityTagLink.objects.filter(tag=tag, entity_id=target.id).exists()


@pytest.mark.django_db
def test_apply_keeps_merged_releases_when_asked_and_renumbers(session_client, music, artist):
    songs = [_song(music, f"Tema {n}", artist) for n in range(1, 3)]
    target = _release(music, "Disco", [songs[0]], artist)
    dup = _release(music, "Disco", [songs[1]], artist)
    response = _group(
        session_client,
        music,
        [
            {
                "target": {"release_id": str(target.id)},
                "merge_release_ids": [str(dup.id)],
                "tracks": [
                    {"track_id": str(songs[1].id), "disc_number": 1, "track_number": 1},
                    {"track_id": str(songs[0].id), "disc_number": 1, "track_number": 2},
                ],
                "remove_empty_merged": False,
            }
        ],
    )
    assert response.status_code == 200, response.json()
    summary = response.json()["albums"][0]
    assert _tracklist(target) == [(1, 1, "Tema 2"), (1, 2, "Tema 1")]
    assert summary["tracks_linked"] == 1 and summary["tracks_renumbered"] == 1
    assert MusicRelease.objects.filter(id=dup.id).exists()
    assert summary["merged_releases"] == [{"id": str(dup.id), "title": "Disco", "deleted": False}]
    # A soft-deleted link is revived, not duplicated, when the song returns
    assert MusicReleaseTrack.all_objects.filter(release=dup, track=songs[1]).count() == 1


@pytest.mark.django_db
def test_apply_turns_a_grouped_single_into_an_album_type(session_client, music, artist):
    songs = [_song(music, f"Tema {n}", artist) for n in range(1, 9)]
    singles = [_release(music, "Disco", [song], artist, release_type="SINGLE") for song in songs]
    response = _group(
        session_client,
        music,
        [{"target": {"release_id": str(singles[0].id)}, "merge_release_ids": [str(r.id) for r in singles[1:]]}],
    )
    assert response.status_code == 200
    singles[0].refresh_from_db()
    assert singles[0].release_type == "ALBUM"
    assert response.json()["totals"] == {"albums": 1, "tracks": 7, "merged_releases": 7, "deleted_releases": 7}


@pytest.mark.django_db
def test_apply_is_atomic_on_a_bad_id(session_client, music, artist):
    song = _song(music, "Tema", artist)
    target = _release(music, "Disco", [], artist)
    foreign = MusicRelease.objects.create(workspace=_other_workspace(), title="Ajeno")
    response = _group(
        session_client,
        music,
        [
            {"target": {"create": {"title": "Debe desaparecer"}}, "tracks": [{"track_id": str(song.id)}]},
            {"target": {"release_id": str(target.id)}, "merge_release_ids": [str(foreign.id)]},
        ],
    )
    assert response.status_code == 400
    assert "unknown release" in response.json()["error"]
    assert not MusicRelease.objects.filter(title="Debe desaparecer").exists()
    assert not MusicReleaseTrack.objects.filter(track=song).exists()

    response = _group(session_client, music, [{"target": {"release_id": "not-a-uuid"}}])
    assert response.status_code == 400
    response = _group(
        session_client,
        music,
        [
            {"target": {"release_id": str(target.id)}},
            {"target": {"create": {"title": "X"}}, "merge_release_ids": [str(target.id)]},
        ],
    )
    assert response.status_code == 400 and "used twice" in response.json()["error"]


def _other_workspace():
    from plane.db.models import Workspace

    owner = User.objects.create(email="owner@other.so", username="other_owner")
    return Workspace.objects.create(name="Otro", slug="otro-grouping", owner=owner)


@pytest.mark.django_db
def test_apply_dry_run_writes_nothing(session_client, music, artist):
    songs = [_song(music, f"Tema {n}", artist) for n in range(1, 3)]
    target = _release(music, "Disco", [songs[0]], artist)
    dup = _release(music, "Disco", [songs[1]], artist, upc="0123456789012")
    response = _group(
        session_client,
        music,
        [
            {"target": {"release_id": str(target.id)}, "merge_release_ids": [str(dup.id)]},
            {"target": {"create": {"title": "Nuevo"}}, "create_tracks": [{"title": "Borrador"}]},
        ],
        dry_run=True,
    )
    assert response.status_code == 200
    body = response.json()
    assert body["dry_run"] is True
    assert body["albums"][0]["tracks_moved"] == 1 and body["albums"][0]["merged_releases"][0]["deleted"] is True
    assert body["albums"][1]["tracks_created"] == 1
    assert _tracklist(target) == [(1, 1, "Tema 1")]
    assert MusicRelease.objects.filter(id=dup.id).exists()
    target.refresh_from_db()
    assert target.upc == ""
    assert not MusicRelease.objects.filter(title="Nuevo").exists()
    assert not MusicTrack.objects.filter(title="Borrador").exists()


@pytest.mark.django_db
def test_apply_requires_workspace_admin(api_client, music, artist):
    member = User.objects.create(email="member2@grouping.so", username="grouping_member2")
    WorkspaceMember.objects.create(workspace=music, member=member, role=15)
    api_client.force_authenticate(user=member)
    target = _release(music, "Disco", [], artist)
    response = _group(api_client, music, [{"target": {"release_id": str(target.id)}}])
    assert response.status_code == 403
