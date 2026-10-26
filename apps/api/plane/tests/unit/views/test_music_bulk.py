# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Catalog bulk actions: "Editar en lote" (bulk-update), "Ligar a contrato"
for selected songs, and linking/unlinking a contract from a song's panel."""

from datetime import date
from decimal import Decimal

import pytest

from plane.db.models import (
    Contract,
    ContractWorkLink,
    FileAsset,
    MusicCompany,
    MusicCredit,
    MusicCreditRole,
    MusicDistribution,
    MusicGenre,
    MusicParty,
    MusicRelease,
    MusicReleaseTrack,
    MusicTrack,
    MusicTrackGenre,
    User,
    WorkspaceFeature,
    WorkspaceMember,
)

Status = ContractWorkLink.Status


@pytest.fixture
def modules(workspace):
    for key in (WorkspaceFeature.FeatureKey.FILE_LIBRARY, WorkspaceFeature.FeatureKey.MUSIC_CATALOG):
        WorkspaceFeature.objects.create(workspace=workspace, key=key, is_enabled=True)


@pytest.fixture
def songs(workspace):
    return [MusicTrack.objects.create(workspace=workspace, title=f"Song {index}") for index in range(3)]


@pytest.fixture
def make_contract(workspace, create_user):
    def make(name, **fields):
        asset = FileAsset.objects.create(
            workspace=workspace,
            asset=f"{workspace.slug}/{name}.pdf",
            attributes={"name": f"{name}.pdf", "size": 10, "type": "application/pdf"},
            entity_type="FILE_LIBRARY",
            created_by=create_user,
        )
        fields.setdefault("processing_status", "COMPLETED")
        return Contract.objects.create(workspace=workspace, file_asset=asset, titulo=name, **fields)

    return make


def bulk(client, workspace, track_ids, *changes):
    return client.post(
        f"/api/workspaces/{workspace.slug}/music/tracks/bulk-update/",
        {"track_ids": [str(track_id) for track_id in track_ids], "changes": list(changes)},
        format="json",
    )


def companies_of(track, kind):
    return set(
        MusicDistribution.objects.filter(track=track, company__kind=kind).values_list("company__name", flat=True)
    )


@pytest.mark.unit
@pytest.mark.django_db
class TestBulkUpdate:
    def test_scalar_set_and_clear(self, session_client, workspace, songs, modules):
        ids = [song.id for song in songs]
        songs[0].language = "Spanish"
        songs[0].save()
        response = bulk(
            session_client,
            workspace,
            ids,
            {"field": "status", "op": "set", "value": "Released"},
            {"field": "release_date", "op": "set", "value": "2024-05-01"},
            {"field": "explicit", "op": "set", "value": True},
            {"field": "p_line", "op": "set", "value": "℗ 2024 Sello"},
            {"field": "aggregator_percentage", "op": "set", "value": "12.5"},
            {"field": "language", "op": "clear"},
        )
        assert response.status_code == 200, response.json()
        assert response.json()["updated"] == 3 and response.json()["skipped"] == 0
        for song in MusicTrack.objects.filter(id__in=ids):
            assert song.status == "RELEASED"
            assert song.release_date == date(2024, 5, 1)
            assert song.explicit is True
            assert song.p_line == "℗ 2024 Sello"
            assert song.aggregator_percentage == Decimal("12.5")
            assert song.language == ""

        # Same values again: nothing changes
        again = bulk(session_client, workspace, ids, {"field": "status", "op": "set", "value": "RELEASED"})
        assert again.json()["updated"] == 0 and again.json()["unchanged"] == 3

    def test_company_add_replace_remove_clear(self, session_client, workspace, songs, modules):
        kind = MusicCompany.Kind.AGGREGATOR
        old = MusicCompany.objects.create(workspace=workspace, kind=kind, name="OldAgg")
        label = MusicCompany.objects.create(workspace=workspace, kind=MusicCompany.Kind.RECORD_LABEL, name="Label")
        virgin = MusicCompany.objects.create(workspace=workspace, kind=kind, name="VirginAgregadora")
        for song in songs:
            MusicDistribution.objects.create(workspace=workspace, track=song, company=old)
            MusicDistribution.objects.create(workspace=workspace, track=song, company=label)
        ids = [song.id for song in songs]

        # add keeps the existing aggregator; the name is matched ignoring case
        response = bulk(
            session_client, workspace, ids, {"field": "aggregator", "op": "add", "value": ["virginagregadora"]}
        )
        assert response.status_code == 200, response.json()
        assert "created" not in response.json() or not response.json()["created"]
        assert companies_of(songs[0], kind) == {"OldAgg", "VirginAgregadora"}
        assert MusicCompany.objects.filter(workspace=workspace, kind=kind).count() == 2
        # adding twice doesn't duplicate the distribution
        bulk(session_client, workspace, ids, {"field": "aggregator", "op": "add", "value": "VirginAgregadora"})
        assert MusicDistribution.objects.filter(track=songs[0], company=virgin).count() == 1

        # replace drops the other aggregators, never the companies of other kinds
        response = bulk(
            session_client, workspace, ids, {"field": "aggregator", "op": "replace", "value": ["Nueva Agg"]}
        )
        assert response.json()["created"] == {"companies": ["Nueva Agg"]}
        for song in songs:
            assert companies_of(song, kind) == {"Nueva Agg"}
            assert companies_of(song, MusicCompany.Kind.RECORD_LABEL) == {"Label"}

        bulk(session_client, workspace, ids[:1], {"field": "aggregator", "op": "remove", "value": ["Nueva Agg"]})
        assert companies_of(songs[0], kind) == set() and companies_of(songs[1], kind) == {"Nueva Agg"}
        bulk(session_client, workspace, ids, {"field": "record_label", "op": "clear"})
        assert companies_of(songs[1], MusicCompany.Kind.RECORD_LABEL) == set()
        # remove never creates the company it names
        bulk(session_client, workspace, ids, {"field": "distributor", "op": "remove", "value": ["Ghost"]})
        assert not MusicCompany.objects.filter(name="Ghost").exists()

    def test_genres_and_release(self, session_client, workspace, songs, modules):
        rock = MusicGenre.objects.create(workspace=workspace, name="Rock")
        MusicTrackGenre.objects.create(workspace=workspace, track=songs[0], genre=rock)
        album = MusicRelease.objects.create(workspace=workspace, title="Album")
        MusicReleaseTrack.objects.create(workspace=workspace, release=album, track=songs[0], track_number=1)
        ids = [song.id for song in songs]

        bulk(session_client, workspace, ids, {"field": "genres", "op": "add", "value": ["Pop", "rock"]})
        assert set(songs[1].genre_links.values_list("genre__name", flat=True)) == {"Pop", "Rock"}
        bulk(session_client, workspace, ids[:1], {"field": "genres", "op": "remove", "value": ["Rock"]})
        assert set(songs[0].genre_links.values_list("genre__name", flat=True)) == {"Pop"}
        # A removed link is revived (unique row), not duplicated
        bulk(session_client, workspace, ids[:1], {"field": "genres", "op": "add", "value": ["Rock"]})
        assert MusicTrackGenre.all_objects.filter(track=songs[0], genre=rock).count() == 1
        bulk(session_client, workspace, ids, {"field": "genres", "op": "replace", "value": ["Latin"]})
        assert set(songs[2].genre_links.values_list("genre__name", flat=True)) == {"Latin"}

        response = bulk(session_client, workspace, ids, {"field": "release", "op": "add", "value": ["album"]})
        assert response.status_code == 200
        numbers = dict(MusicReleaseTrack.objects.filter(release=album).values_list("track_id", "track_number"))
        assert numbers[songs[0].id] == 1 and sorted(numbers.values()) == [1, 2, 3]
        response = bulk(session_client, workspace, ids[:1], {"field": "release", "op": "replace", "value": ["Single"]})
        assert response.json()["created"] == {"releases": ["Single"]}
        assert list(songs[0].release_links.values_list("release__title", flat=True)) == ["Single"]
        bulk(session_client, workspace, ids, {"field": "release", "op": "clear"})
        assert not MusicReleaseTrack.objects.filter(track_id__in=ids).exists()

    def test_credit_with_custom_role(self, session_client, workspace, songs, modules):
        MusicCreditRole.objects.create(
            workspace=workspace, key="LEAD_VOCALS", label="Lead Vocals", category="PERFORMER"
        )
        ids = [song.id for song in songs]
        response = bulk(
            session_client,
            workspace,
            ids,
            {"field": "credit", "op": "add", "value": {"role": "LEAD_VOCALS", "names": ["Ana Voz"]}},
            {"field": "credit", "op": "add", "value": {"role": "PRIMARY_ARTIST", "names": ["La Banda"]}},
        )
        assert response.status_code == 200, response.json()
        assert set(response.json()["created"]["people"]) == {"Ana Voz", "La Banda"}
        assert (
            MusicCredit.objects.filter(track__in=songs, role="LEAD_VOCALS", party__display_name="Ana Voz").count() == 3
        )
        assert MusicParty.objects.get(display_name="La Banda").kind == MusicParty.Kind.ARTIST
        assert MusicParty.objects.get(display_name="Ana Voz").kind == MusicParty.Kind.PERSON

        # replace: only that role is rewritten
        bulk(
            session_client,
            workspace,
            ids,
            {"field": "credit", "op": "replace", "value": {"role": "LEAD_VOCALS", "names": ["Otra"]}},
        )
        assert set(songs[0].credits.values_list("party__display_name", "role")) == {
            ("Otra", "LEAD_VOCALS"),
            ("La Banda", "PRIMARY_ARTIST"),
        }
        # remove without role takes the person out of every role
        bulk(session_client, workspace, ids, {"field": "credit", "op": "remove", "value": {"names": ["La Banda"]}})
        assert set(songs[1].credits.values_list("party__display_name", flat=True)) == {"Otra"}

        unknown = bulk(
            session_client, workspace, ids, {"field": "credit", "op": "add", "value": {"role": "NOPE", "names": ["X"]}}
        )
        assert unknown.status_code == 400 and unknown.json()["errors"][0]["field"] == "credit"

    def test_invalid_change_writes_nothing(self, session_client, workspace, songs, modules):
        ids = [song.id for song in songs]
        response = bulk(
            session_client,
            workspace,
            ids,
            {"field": "genres", "op": "add", "value": ["Nuevo Genero"]},
            {"field": "aggregator", "op": "add", "value": ["Nueva"]},
            {"field": "release_date", "op": "set", "value": "no es fecha"},
            {"field": "aggregator_percentage", "op": "set", "value": "150"},
            {"field": "status", "op": "clear"},
            {"field": "title", "op": "set", "value": "x"},
        )
        assert response.status_code == 400
        assert [error["index"] for error in response.json()["errors"]] == [2, 3, 4, 5]
        assert not MusicGenre.objects.filter(name="Nuevo Genero").exists()
        assert not MusicCompany.objects.filter(name="Nueva").exists()
        assert not MusicTrackGenre.objects.filter(track_id__in=ids).exists()

    def test_skips_unknown_ids_and_other_workspaces(self, session_client, workspace, songs, modules, create_user):
        from plane.db.models import Workspace

        other = Workspace.objects.create(name="Other", owner=create_user, slug="other-ws")
        foreign = MusicTrack.objects.create(workspace=other, title="Foreign")
        response = bulk(
            session_client,
            workspace,
            [songs[0].id, foreign.id, "not-a-uuid"],
            {"field": "status", "op": "set", "value": "READY"},
        )
        assert response.json()["updated"] == 1 and response.json()["skipped"] == 2
        foreign.refresh_from_db()
        assert foreign.status == "DRAFT"

    def test_admin_only(self, api_client, workspace, songs, modules):
        member = User.objects.create(email="member-bulk@plane.so", username="member_bulk")
        WorkspaceMember.objects.create(workspace=workspace, member=member, role=15)
        api_client.force_authenticate(user=member)
        response = bulk(api_client, workspace, [songs[0].id], {"field": "status", "op": "set", "value": "READY"})
        assert response.status_code == 403


@pytest.mark.unit
@pytest.mark.django_db
class TestBulkLinkContract:
    def test_links_new_upgrades_suggestions_and_counts_existing(
        self, session_client, workspace, songs, modules, make_contract
    ):
        contract = make_contract("deal")
        ContractWorkLink.objects.create(
            workspace=workspace,
            contract=contract,
            entity_type="music_track",
            entity_id=songs[0].id,
            status=Status.LINKED,
        )
        ContractWorkLink.objects.create(
            workspace=workspace,
            contract=contract,
            entity_type="music_track",
            entity_id=songs[1].id,
            status=Status.DISMISSED,
        )
        url = f"/api/workspaces/{workspace.slug}/music/tracks/link-contract/"
        response = session_client.post(
            url,
            {
                "contract_id": str(contract.id),
                "track_ids": [str(song.id) for song in songs] + ["00000000-0000-0000-0000-000000000000"],
                "rights_type": "master",
            },
            format="json",
        )
        assert response.status_code == 200, response.json()
        body = response.json()
        assert (body["linked"], body["already"], body["skipped"]) == (2, 1, 1)
        assert body["contract"]["titulo"] == "deal"
        links = ContractWorkLink.objects.filter(contract=contract)
        assert links.count() == 3
        assert set(links.values_list("status", flat=True)) == {Status.LINKED}
        assert set(links.values_list("rights_type", flat=True)) == {"MASTER"}

        # Again: everything was already there
        again = session_client.post(
            url, {"contract_id": str(contract.id), "track_ids": [str(s.id) for s in songs]}, format="json"
        )
        assert (again.json()["linked"], again.json()["already"]) == (0, 3)
        assert ContractWorkLink.objects.filter(contract=contract).count() == 3

    def test_validation(self, session_client, workspace, songs, modules, make_contract):
        url = f"/api/workspaces/{workspace.slug}/music/tracks/link-contract/"
        contract = make_contract("deal")
        assert (
            session_client.post(url, {"contract_id": str(contract.id), "track_ids": []}, format="json").status_code
            == 400
        )
        bad_rights = {"contract_id": str(contract.id), "track_ids": [str(songs[0].id)], "rights_type": "X"}
        assert session_client.post(url, bad_rights, format="json").status_code == 400
        missing = {"contract_id": "nope", "track_ids": [str(songs[0].id)]}
        assert session_client.post(url, missing, format="json").status_code == 404


@pytest.mark.unit
@pytest.mark.django_db
class TestTrackSideLinking:
    def test_link_from_song_change_rights_and_unlink(self, session_client, workspace, songs, modules, make_contract):
        first, second = make_contract("uno"), make_contract("dos")
        song = songs[0]
        # The song panel's picker posts the song to each chosen contract
        for contract in (first, second):
            response = session_client.post(
                f"/api/workspaces/{workspace.slug}/contracts/{contract.id}/works/",
                {"items": [{"entity_type": "music_track", "entity_id": str(song.id), "rights_type": "EDICION"}]},
                format="json",
            )
            assert response.status_code == 200, response.json()

        listing = session_client.get(f"/api/workspaces/{workspace.slug}/music/tracks/{song.id}/contracts/").json()
        assert {row["contract"]["titulo"] for row in listing["links"]} == {"uno", "dos"}
        link_id = next(row["id"] for row in listing["links"] if row["contract"]["titulo"] == "uno")

        base = f"/api/workspaces/{workspace.slug}/contract-work-links/{link_id}/"
        patched = session_client.patch(base, {"rights_type": "MASTER"}, format="json")
        assert patched.status_code == 200 and patched.json()["rights_type"] == "MASTER"
        assert session_client.delete(base).status_code == 204

        listing = session_client.get(f"/api/workspaces/{workspace.slug}/music/tracks/{song.id}/contracts/").json()
        assert [row["contract"]["titulo"] for row in listing["links"]] == ["dos"]
