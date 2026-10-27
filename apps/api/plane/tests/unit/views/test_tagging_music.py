# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""AI tag mapping over songs and releases: opt-in kinds, a compact text per
item, the catalog's admin-only rule, and the run's `types` filter."""

from types import SimpleNamespace
from unittest import mock

import pytest

from plane.db.models import (
    EntityTagLink,
    FileTag,
    MusicCompany,
    MusicCredit,
    MusicDistribution,
    MusicGenre,
    MusicParty,
    MusicRelease,
    MusicReleaseArtist,
    MusicReleaseTrack,
    MusicTrack,
    MusicTrackGenre,
    TaggingRun,
    WorkspaceFeature,
    WorkspaceMember,
)
from plane.utils.tagging import DEFAULT_TYPES, count_scannable, inventory, runnable_types

SECRET = "test-internal-secret"
FEATURE = WorkspaceFeature.FeatureKey


def enable(workspace, *keys):
    for key in keys:
        WorkspaceFeature.objects.create(workspace=workspace, key=key, is_enabled=True)


@pytest.fixture
def catalog(workspace):
    artist = MusicParty.objects.create(workspace=workspace, display_name="Los Tigres")
    guest = MusicParty.objects.create(workspace=workspace, display_name="Ana Voz")
    writer = MusicParty.objects.create(workspace=workspace, display_name="Juan Pluma")
    release = MusicRelease.objects.create(
        workspace=workspace, title="Corridos 2024", release_type="ALBUM", label_name="Sello Norte"
    )
    MusicReleaseArtist.objects.create(workspace=workspace, release=release, party=artist)
    track = MusicTrack.objects.create(
        workspace=workspace, title="La Puerta", version="En vivo", isrc="MXA112400001", language="Spanish"
    )
    MusicReleaseTrack.objects.create(workspace=workspace, release=release, track=track, track_number=1)
    MusicCredit.objects.create(workspace=workspace, track=track, party=artist, role="PRIMARY_ARTIST")
    MusicCredit.objects.create(workspace=workspace, track=track, party=guest, role="FEATURED_ARTIST")
    MusicCredit.objects.create(workspace=workspace, track=track, party=writer, role="COMPOSER")
    genre = MusicGenre.objects.create(workspace=workspace, name="Regional mexicano")
    MusicTrackGenre.objects.create(workspace=workspace, track=track, genre=genre)
    company = MusicCompany.objects.create(workspace=workspace, kind="DISTRIBUTOR", name="DistroMX")
    MusicDistribution.objects.create(workspace=workspace, track=track, company=company)
    return SimpleNamespace(artist=artist, release=release, track=track)


@pytest.mark.unit
@pytest.mark.django_db
class TestMusicInventory:
    def test_song_descriptor(self, workspace, catalog):
        page = inventory(workspace.id, "music_track", 0, 10)
        assert page["total"] == 1
        item = page["results"][0]
        assert item["id"] == str(catalog.track.id)
        assert item["title"] == "La Puerta (En vivo)"
        text = item["text"]
        assert "artistas: Los Tigres (Primary Artist), Ana Voz (Featured Artist)" in text
        assert "créditos: Juan Pluma (Composer)" in text
        assert "lanzamientos: Corridos 2024 (Album)" in text
        assert "géneros: Regional mexicano" in text
        assert "ISRC: MXA112400001" in text
        assert "sello: Sello Norte" in text
        assert "DistroMX (distribuidora)" in text
        assert "idioma: Spanish" in text
        assert item["tags"] == []

    def test_release_descriptor(self, workspace, catalog):
        item = inventory(workspace.id, "music_release", 0, 10)["results"][0]
        assert item["title"] == "Corridos 2024"
        assert "tipo: Album" in item["text"]
        assert "artistas: Los Tigres" in item["text"]
        assert "sello: Sello Norte" in item["text"]
        assert "canciones (1): La Puerta" in item["text"]

    def test_tags_include_artist_tag_reached_through_credits(self, workspace, catalog):
        FileTag.objects.create(workspace=workspace, name="Los Tigres", kind="ARTIST", party=catalog.artist)
        campaign = FileTag.objects.create(workspace=workspace, name="Campaña Verano")
        EntityTagLink.objects.create(
            workspace=workspace,
            tag=campaign,
            entity_type="music_track",
            entity_id=catalog.track.id,
            status=EntityTagLink.Status.CONFIRMED,
        )
        song = inventory(workspace.id, "music_track", 0, 10)["results"][0]
        assert set(song["tags"]) == {"Los Tigres", "Campaña Verano"}
        release = inventory(workspace.id, "music_release", 0, 10)["results"][0]
        assert release["tags"] == ["Los Tigres"]

    def test_paging_and_counts(self, workspace):
        for index in range(5):
            MusicTrack.objects.create(workspace=workspace, title=f"Song {index}")
        first = inventory(workspace.id, "music_track", 0, 3)
        second = inventory(workspace.id, "music_track", 3, 3)
        assert first["total"] == 5 and len(first["results"]) == 3 and len(second["results"]) == 2
        assert {item["id"] for item in first["results"]}.isdisjoint({item["id"] for item in second["results"]})
        assert count_scannable(workspace.id, ["music_track", "music_release"]) == {
            "music_track": 5,
            "music_release": 0,
        }


@pytest.mark.unit
@pytest.mark.django_db
class TestRunnableTypes:
    def ctx(self, role, features):
        return SimpleNamespace(role=role, features=frozenset(features))

    def test_music_needs_admin_and_module(self):
        everything = [*DEFAULT_TYPES, "music_track", "music_release"]
        allowed, skipped = runnable_types(self.ctx(20, {FEATURE.MUSIC_CATALOG}), everything)
        assert allowed == everything and skipped == []
        allowed, skipped = runnable_types(self.ctx(15, {FEATURE.MUSIC_CATALOG}), everything)
        assert allowed == list(DEFAULT_TYPES) and skipped == ["music_track", "music_release"]
        allowed, skipped = runnable_types(self.ctx(20, set()), everything)
        assert skipped == ["music_track", "music_release"]

    def test_unknown_kinds_are_dropped(self):
        allowed, skipped = runnable_types(self.ctx(20, set()), ["contract", "payroll", "contract"])
        assert allowed == ["contract"] and skipped == []


@pytest.mark.unit
@pytest.mark.django_db
class TestTaggingRunEndpoint:
    url = "/api/workspaces/test-workspace/tagging-runs/"

    def test_overview_offers_music_unchecked(self, session_client, workspace, catalog):
        enable(workspace, FEATURE.REFERENCES, FEATURE.MUSIC_CATALOG)
        data = session_client.get(self.url).json()
        assert "music_track" in data["scannable"] and "music_release" in data["scannable"]
        assert data["defaults"] == list(DEFAULT_TYPES)
        assert data["counts"]["music_track"] == 1 and data["counts"]["music_release"] == 1

    def test_overview_hides_music_without_module(self, session_client, workspace):
        enable(workspace, FEATURE.REFERENCES)
        data = session_client.get(self.url).json()
        assert "music_track" not in data["scannable"] and "music_track" not in data["counts"]

    @mock.patch("plane.app.views.references.tagging.trigger_tagging_run", return_value="instance-1")
    def test_start_with_music(self, trigger, session_client, workspace, catalog):
        enable(workspace, FEATURE.REFERENCES, FEATURE.MUSIC_CATALOG)
        response = session_client.post(self.url, {"types": ["contract", "music_track"]}, format="json")
        assert response.status_code == 201, response.content
        run = TaggingRun.objects.get(id=response.json()["id"])
        assert run.scope == {"types": ["contract", "music_track"]}
        assert trigger.call_args.args[2] == ["contract", "music_track"]

    @mock.patch("plane.app.views.references.tagging.trigger_tagging_run", return_value="instance-1")
    def test_default_types_leave_music_out(self, trigger, session_client, workspace, catalog):
        enable(workspace, FEATURE.REFERENCES, FEATURE.MUSIC_CATALOG)
        response = session_client.post(self.url, {}, format="json")
        assert response.status_code == 201
        assert trigger.call_args.args[2] == list(DEFAULT_TYPES)

    @mock.patch("plane.app.views.references.tagging.trigger_tagging_run", return_value="instance-1")
    def test_music_skipped_and_reported_without_module(self, trigger, session_client, workspace):
        enable(workspace, FEATURE.REFERENCES)
        response = session_client.post(self.url, {"types": ["contract", "music_release"]}, format="json")
        assert response.status_code == 201
        assert response.json()["scope"] == {"types": ["contract"], "skipped": ["music_release"]}
        assert trigger.call_args.args[2] == ["contract"]
        only_music = session_client.post(self.url, {"types": ["music_track"]}, format="json")
        assert only_music.status_code == 400 and only_music.json()["skipped"] == ["music_track"]

    def test_members_cannot_start(self, session_client, workspace, create_user):
        enable(workspace, FEATURE.REFERENCES, FEATURE.MUSIC_CATALOG)
        WorkspaceMember.objects.filter(workspace=workspace, member=create_user).update(role=15)
        response = session_client.post(self.url, {"types": ["music_track"]}, format="json")
        assert response.status_code == 403
        assert not TaggingRun.objects.exists()


@pytest.mark.unit
@pytest.mark.django_db
class TestInternalInventory:
    @pytest.fixture(autouse=True)
    def secret(self, settings):
        settings.PLANE_INTERNAL_API_SECRET = SECRET

    def get(self, api_client, workspace, entity_type, run=None):
        url = f"/api/internal/workspaces/{workspace.id}/tagging/inventory/?type={entity_type}&offset=0&limit=50"
        if run is not None:
            url += f"&run_id={run.id}"
        return api_client.get(url, HTTP_X_PLANE_INTERNAL_KEY=SECRET)

    def test_serves_music_kinds(self, api_client, workspace, catalog):
        run = TaggingRun.objects.create(workspace=workspace, scope={"types": ["music_track", "music_release"]})
        response = self.get(api_client, workspace, "music_track", run)
        assert response.status_code == 200
        assert response.json()["results"][0]["title"] == "La Puerta (En vivo)"
        assert self.get(api_client, workspace, "music_release", run).json()["total"] == 1

    def test_kinds_outside_the_run_read_nothing(self, api_client, workspace, catalog):
        run = TaggingRun.objects.create(workspace=workspace, scope={"types": ["contract"], "skipped": ["music_track"]})
        assert self.get(api_client, workspace, "music_track", run).json() == {"total": 0, "results": []}


@pytest.mark.unit
@pytest.mark.django_db
class TestImportLinksArtistTags:
    """After an import, a song's artists join the tag the workspace already
    has with their name, so the songs show under it; nothing is created."""

    def test_ties_performers_to_tags_written_differently(self, workspace, catalog):
        from plane.utils.tagging_music import link_artist_tags

        tigres = FileTag.objects.create(workspace=workspace, name="LOS  tigres", kind=FileTag.Kind.GROUP)
        guest = FileTag.objects.create(workspace=workspace, name="Ána Voz", kind=FileTag.Kind.PERSON)
        writer = FileTag.objects.create(workspace=workspace, name="Juan Pluma", kind=FileTag.Kind.PERSON)

        preview = link_artist_tags(workspace.id, [catalog.track.id], dry_run=True)
        assert {entry["tag"] for entry in preview} == {"LOS  tigres", "Ána Voz"}
        assert not FileTag.objects.filter(party__isnull=False).exists()

        link_artist_tags(workspace.id, [catalog.track.id])
        tigres.refresh_from_db()
        guest.refresh_from_db()
        writer.refresh_from_db()
        assert tigres.party_id == catalog.artist.id
        assert guest.party_id is not None
        # Composers are not whose the song is
        assert writer.party_id is None
        assert FileTag.objects.filter(workspace=workspace).count() == 3

    def test_never_takes_a_tag_of_another_artist_nor_creates_one(self, workspace, catalog):
        from plane.utils.tagging_music import link_artist_tags

        other = MusicParty.objects.create(workspace=workspace, display_name="Otros Tigres")
        taken = FileTag.objects.create(workspace=workspace, name="Los Tigres", party=other)
        assert link_artist_tags(workspace.id, [catalog.track.id]) == []
        taken.refresh_from_db()
        assert taken.party_id == other.id
        assert FileTag.objects.filter(workspace=workspace).count() == 1
