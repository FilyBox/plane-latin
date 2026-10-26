# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Contract <-> music works: matching, saved suggestions, catalog filters and
the apply endpoint."""

from datetime import timedelta

import pytest
from django.test import override_settings
from django.utils import timezone

from plane.app.views.contract.base import is_classify_only
from plane.db.models import (
    Contract,
    ContractWorkLink,
    FileAsset,
    MusicCredit,
    MusicParty,
    MusicRelease,
    MusicReleaseTrack,
    MusicTrack,
    WorkspaceFeature,
)
from plane.utils.contract_works import (
    match_works,
    normalize_isrc,
    normalize_title,
    normalize_upc,
    record_suggestions,
    split_artists,
)

SECRET = "test-internal-secret"
Status = ContractWorkLink.Status


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


@pytest.fixture
def modules(workspace):
    for key in (WorkspaceFeature.FeatureKey.FILE_LIBRARY, WorkspaceFeature.FeatureKey.MUSIC_CATALOG):
        WorkspaceFeature.objects.create(workspace=workspace, key=key, is_enabled=True)


@pytest.fixture
def catalog(workspace):
    bunny = MusicParty.objects.create(workspace=workspace, display_name="Bad Bunny")
    callaita = MusicTrack.objects.create(workspace=workspace, title="Callaíta", isrc="USUM71900001")
    safaera = MusicTrack.objects.create(workspace=workspace, title="Safaera")
    video = MusicTrack.objects.create(
        workspace=workspace,
        title="Callaíta",
        parent_track=callaita,
        kind=MusicTrack.Kind.MUSIC_VIDEO,
        isrc_video="USUV71900002",
    )
    for track in (callaita, safaera):
        MusicCredit.objects.create(
            workspace=workspace, track=track, party=bunny, role=MusicCredit.Role.PRIMARY_ARTIST
        )
    album = MusicRelease.objects.create(workspace=workspace, title="YHLQMDLG", upc="0193483000001")
    MusicReleaseTrack.objects.create(workspace=workspace, release=album, track=safaera)
    return {"callaita": callaita, "safaera": safaera, "video": video, "album": album}


def link(contract, entity, status=Status.LINKED, entity_type="music_track"):
    return ContractWorkLink.objects.create(
        workspace=contract.workspace,
        contract=contract,
        entity_type=entity_type,
        entity_id=entity.id,
        status=status,
    )


@pytest.mark.unit
class TestNormalization:
    @pytest.mark.parametrize(
        "raw,expected",
        [
            ("Despacito (feat. Justin Bieber)", "despacito"),
            ("Callaíta [ft. Tainy]", "callaita"),
            ("Safaera feat. Jowell & Randy", "safaera"),
            ("¿Qué Pretendes?", "que pretendes"),
            ("La Canción (con J Balvin)", "la cancion"),
        ],
    )
    def test_title(self, raw, expected):
        assert normalize_title(raw) == expected

    def test_codes(self):
        assert normalize_isrc("us-um7-19-00001") == "USUM71900001"
        assert normalize_isrc("123") is None
        assert normalize_upc("0193483000001") == normalize_upc("193483000001")
        assert normalize_upc("12") is None

    def test_artists(self):
        assert split_artists("Bad Bunny feat. Drake & J Balvin") == ["bad bunny", "drake", "j balvin"]
        assert split_artists(["Rosalía", {"nombre": "J. Balvin"}]) == ["rosalia", "j balvin"]

    def test_works_retry_is_quiet(self):
        assert is_classify_only({"works": True})
        assert is_classify_only({"works": True, "classify": True})
        assert not is_classify_only({"works": True, "ai_analysis": True})


@pytest.mark.unit
@pytest.mark.django_db
class TestMatchWorks:
    def test_each_rule(self, workspace, catalog):
        works = [
            {"isrc": "US-UM7-19-00001", "title": "otra cosa"},
            {"isrc": "USUV71900002"},
            {"upc": "193483000001", "kind": "release"},
            {"titulo": "Safaera (feat. Jowell)", "artistas": ["Bad Bunny"], "cita": "Anexo A", "pagina": 4},
            {"title": "SAFAERA"},
            {"title": "Safaeras", "artists": "Bad Bunny"},
            {"title": "Safaeras"},
            {"title": "Canción que no existe", "artists": ["Nadie"], "isrc": "XX0000000000"},
        ]
        results = {row["index"]: row for row in match_works(workspace.id, works)}
        expect = {
            0: (str(catalog["callaita"].id), 1.0, "isrc"),
            1: (str(catalog["callaita"].id), 1.0, "isrc"),
            2: (str(catalog["album"].id), 1.0, "upc"),
            3: (str(catalog["safaera"].id), 0.9, "title_artist"),
            4: (str(catalog["safaera"].id), 0.7, "title"),
            5: (str(catalog["safaera"].id), 0.75, "fuzzy_artist"),
        }
        for index, (entity_id, confidence, match_type) in expect.items():
            row = results[index]
            assert (row["entity_id"], row["confidence"], row["match_type"]) == (entity_id, confidence, match_type)
        assert results[2]["entity_type"] == "music_release"
        assert results[3]["work"]["evidence"] == {"quote": "Anexo A", "page": 4}
        assert results[3]["artists"] == ["Bad Bunny"]
        for index in (6, 7):
            assert results[index]["matched"] is False
            assert results[index]["entity_id"] is None

    def test_album_kind_prefers_release(self, workspace, catalog):
        MusicTrack.objects.create(workspace=workspace, title="YHLQMDLG")
        [row] = match_works(workspace.id, [{"title": "YHLQMDLG", "tipo": "album"}])
        assert (row["entity_type"], row["entity_id"]) == ("music_release", str(catalog["album"].id))


@pytest.mark.unit
@pytest.mark.django_db
class TestRecordSuggestions:
    def test_saves_once_and_respects_decisions(self, workspace, catalog, make_contract):
        contract = make_contract("deal")
        link(contract, catalog["callaita"], Status.LINKED)
        dismissed = link(contract, catalog["album"], Status.DISMISSED, "music_release")
        works = [
            {"isrc": "USUM71900001"},
            {"upc": "0193483000001", "kind": "release"},
            {"title": "Safaera", "artists": ["Bad Bunny"]},
            {"title": "Safaera (feat. Jowell)", "artists": ["Bad Bunny"]},
            {"title": "Obra Nueva", "artists": ["Alguien"]},
            {"title": "obra nueva"},
        ]
        counts = record_suggestions(contract, match_works(workspace.id, works))
        assert counts == {"linked": 1, "suggested": 2, "unmatched": 1, "skipped": 1}

        again = record_suggestions(contract, match_works(workspace.id, works))
        assert again["suggested"] == 2
        assert ContractWorkLink.objects.filter(contract=contract).count() == 4
        assert ContractWorkLink.objects.get(contract=contract, entity_id=catalog["callaita"].id).status == Status.LINKED
        dismissed.refresh_from_db()
        assert dismissed.status == Status.DISMISSED
        pending = ContractWorkLink.objects.get(contract=contract, entity_id__isnull=True)
        assert pending.suggested["title"] == "Obra Nueva"

    def test_dismissed_new_work_stays_dismissed_and_pending_one_upgrades(self, workspace, catalog, make_contract):
        contract = make_contract("deal2")
        record_suggestions(contract, match_works(workspace.id, [{"title": "Obra Nueva"}, {"title": "Otra Obra"}]))
        ContractWorkLink.objects.filter(contract=contract, suggested__title="Otra Obra").update(
            status=Status.DISMISSED
        )
        new_track = MusicTrack.objects.create(workspace=workspace, title="Obra Nueva")
        MusicTrack.objects.create(workspace=workspace, title="Otra Obra")

        record_suggestions(contract, match_works(workspace.id, [{"title": "Obra Nueva"}, {"title": "Otra Obra"}]))
        rows = list(ContractWorkLink.objects.filter(contract=contract))
        assert len(rows) == 2
        upgraded = next(row for row in rows if row.suggested["title"] == "Obra Nueva")
        assert upgraded.entity_id == new_track.id and upgraded.status == Status.SUGGESTED
        kept = next(row for row in rows if row.suggested["title"] == "Otra Obra")
        assert kept.entity_id is None and kept.status == Status.DISMISSED


@pytest.mark.unit
@pytest.mark.django_db
class TestCatalogFilters:
    def test_with_without_expired(self, session_client, workspace, catalog, modules, make_contract):
        today = timezone.now().date()
        active = make_contract("vigente", fecha_fin_efectiva=today + timedelta(days=30))
        ended = make_contract("vencido", fecha_fin_efectiva=today - timedelta(days=1))
        lonely = MusicTrack.objects.create(workspace=workspace, title="Sola")
        suggested_only = MusicTrack.objects.create(workspace=workspace, title="Sugerida")
        link(active, catalog["callaita"])
        link(ended, lonely)
        link(active, suggested_only, Status.SUGGESTED)
        # Safaera is covered through its album
        link(ended, catalog["album"], entity_type="music_release")

        def titles(value):
            response = session_client.get(
                f"/api/workspaces/{workspace.slug}/music/tracks/", {"songs_only": "true", "contract": value}
            )
            assert response.status_code == 200
            return {row["title"]: row["contract_count"] for row in response.json()}

        assert titles("with") == {"Callaíta": 1, "Sola": 1, "Safaera": 1}
        assert set(titles("without")) == {"Sugerida"}
        assert set(titles("expired")) == {"Sola", "Safaera"}

        # Another, still active contract on the album takes Safaera out of "expired"
        link(active, catalog["album"], entity_type="music_release")
        assert set(titles("expired")) == {"Sola"}
        assert titles("with")["Safaera"] == 2

        releases = session_client.get(f"/api/workspaces/{workspace.slug}/music/releases/", {"contract": "with"}).json()
        assert [(row["title"], row["contract_count"]) for row in releases] == [("YHLQMDLG", 2)]

    def test_track_contracts_include_its_releases(self, session_client, workspace, catalog, modules, make_contract):
        contract = make_contract("album deal")
        link(contract, catalog["album"], entity_type="music_release")
        response = session_client.get(f"/api/workspaces/{workspace.slug}/music/tracks/{catalog['safaera'].id}/contracts/")
        assert response.status_code == 200
        [row] = response.json()["links"]
        assert row["via_release"] == {"id": str(catalog["album"].id), "title": "YHLQMDLG"}
        assert row["contract"]["titulo"] == "album deal"


@pytest.mark.unit
@pytest.mark.django_db
class TestEndpoints:
    def test_apply_creates_catalog_track_and_links(self, session_client, workspace, catalog, modules, make_contract):
        contract = make_contract("assistant")
        record_suggestions(contract, match_works(workspace.id, [{"title": "Tema Inédito", "artists": ["Bad Bunny"]}]))
        response = session_client.post(
            f"/api/workspaces/{workspace.slug}/contracts/{contract.id}/works/apply/",
            {
                "link": [{"entity_type": "music_track", "entity_id": str(catalog["safaera"].id), "rights_type": "MASTER"}],
                "create": [{"title": "Tema Inédito", "artists": ["Bad Bunny", "Nuevo Artista"], "isrc": "QZ-ES8-24-00001"}],
            },
            format="json",
        )
        assert response.status_code == 200, response.json()
        assert (response.json()["linked"], response.json()["created"]) == (1, 1)

        track = MusicTrack.objects.get(workspace=workspace, title="Tema Inédito")
        assert track.status == MusicTrack.Status.DRAFT and track.isrc == "QZES82400001"
        assert set(track.credits.values_list("party__display_name", flat=True)) == {"Bad Bunny", "Nuevo Artista"}
        links = ContractWorkLink.objects.filter(contract=contract)
        # The pending AI suggestion was resolved, not duplicated
        assert links.count() == 2
        assert set(links.values_list("status", flat=True)) == {Status.LINKED}
        created = links.get(entity_id=track.id)
        assert created.decided_by_id is not None
        assert links.get(entity_id=catalog["safaera"].id).source == ContractWorkLink.Source.ASSISTANT

        listing = session_client.get(f"/api/workspaces/{workspace.slug}/contracts/{contract.id}/works/").json()
        entities = {row["entity"]["title"]: row for row in listing["links"]}
        assert entities["Safaera"]["rights_type"] == "MASTER"
        assert entities["Tema Inédito"]["entity"]["path"].endswith(f"?track={track.id}")
        detail = session_client.get(f"/api/workspaces/{workspace.slug}/contracts/{contract.id}/").json()
        assert detail["works_summary"] == {"linked": 2, "suggested": 0}

    def test_dismiss_then_create_in_catalog(self, session_client, workspace, catalog, modules, make_contract):
        contract = make_contract("panel")
        record_suggestions(contract, match_works(workspace.id, [{"title": "Safaera"}, {"title": "Nueva"}]))
        matched = ContractWorkLink.objects.get(contract=contract, entity_id__isnull=False)
        pending = ContractWorkLink.objects.get(contract=contract, entity_id__isnull=True)

        base = f"/api/workspaces/{workspace.slug}/contract-work-links"
        assert session_client.patch(f"{base}/{matched.id}/", {"status": "DISMISSED"}, format="json").status_code == 200
        assert session_client.patch(f"{base}/{pending.id}/", {"status": "LINKED"}, format="json").status_code == 400
        response = session_client.post(f"{base}/{pending.id}/create-in-catalog/", {}, format="json")
        assert response.status_code == 200
        assert response.json()["status"] == "LINKED" and response.json()["entity"]["title"] == "Nueva"

        listing = session_client.get(f"/api/workspaces/{workspace.slug}/contracts/{contract.id}/works/").json()
        assert [row["status"] for row in listing["links"]] == ["LINKED"]
        assert session_client.delete(f"{base}/{pending.id}/").status_code == 204
        assert ContractWorkLink.objects.filter(contract=contract).count() == 1

    @override_settings(PLANE_INTERNAL_API_SECRET=SECRET)
    def test_internal_suggest_and_assistant_match(self, api_client, workspace, create_user, catalog, modules, make_contract):
        contract = make_contract("worker")
        response = api_client.post(
            f"/api/internal/workspaces/{workspace.id}/contracts/{contract.id}/works/suggest/",
            {"works": [{"titulo": "Safaera", "artistas": ["Bad Bunny"]}, {"titulo": "Inexistente"}], "source": "AI"},
            format="json",
            HTTP_X_PLANE_INTERNAL_KEY=SECRET,
        )
        assert response.status_code == 200
        assert response.json() == {"linked": 0, "suggested": 2, "unmatched": 1, "skipped": 0}

        before = ContractWorkLink.objects.count()
        response = api_client.post(
            f"/api/internal/workspaces/{workspace.id}/assistant/contract-works/match/",
            {
                "user_id": str(create_user.id),
                "contract_id": str(contract.id),
                "works": [{"title": "Safaera", "artists": ["Bad Bunny"]}, {"title": "Otra"}],
            },
            format="json",
            HTTP_X_PLANE_INTERNAL_KEY=SECRET,
        )
        assert response.status_code == 200
        body = response.json()
        assert body["matched"][0]["entity_id"] == str(catalog["safaera"].id)
        assert body["matched"][0]["existing_status"] == "SUGGESTED"
        assert [row["work"]["title"] for row in body["unmatched"]] == ["Otra"]
        assert ContractWorkLink.objects.count() == before

    def test_member_sees_links_without_catalog_details(self, api_client, workspace, catalog, modules, make_contract):
        from plane.db.models import User, WorkspaceMember

        member = User.objects.create(email="member@plane.so", username="member_works")
        WorkspaceMember.objects.create(workspace=workspace, member=member, role=15)
        api_client.force_authenticate(user=member)
        contract = make_contract("member view")
        link(contract, catalog["safaera"])
        base = f"/api/workspaces/{workspace.slug}/contracts/{contract.id}/works/"

        [row] = api_client.get(base).json()["links"]
        assert row["entity"] is None and row["restricted"] is True
        items = {"items": [{"entity_type": "music_track", "entity_id": str(catalog["callaita"].id)}]}
        assert api_client.post(base, items, format="json").status_code == 403
