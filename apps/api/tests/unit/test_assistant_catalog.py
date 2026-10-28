"""The catalog audit (deterministic checks) and the corrections that come
from it: only with a source, never inventing a missing ISRC, undone field by
field."""

from datetime import date, timedelta
from uuid import uuid4

import pytest
from django.test import override_settings
from rest_framework.test import APIClient

from plane.db.models import (
    AssistantAction,
    Contract,
    ContractWorkLink,
    FileAsset,
    FileTag,
    MusicCredit,
    MusicParty,
    MusicRelease,
    MusicReleaseTrack,
    MusicTrack,
    WorkspaceFeature,
)
from plane.tests.factories import UserFactory, WorkspaceFactory, WorkspaceMemberFactory
from plane.utils.assistant_catalog import valid_upc

pytestmark = [pytest.mark.unit, pytest.mark.django_db]


@pytest.fixture
def setup():
    workspace = WorkspaceFactory()
    for key in ("music_catalog", "file_library"):
        WorkspaceFeature.objects.create(workspace=workspace, key=key, is_enabled=True)
    admin = workspace.owner
    WorkspaceMemberFactory(workspace=workspace, member=admin, role=20)
    member = UserFactory(username=f"member-{uuid4().hex[:8]}")
    WorkspaceMemberFactory(workspace=workspace, member=member, role=15)
    return {"workspace": workspace, "admin": admin, "member": member}


def internal(setup, path, body, user="admin"):
    with override_settings(PLANE_INTERNAL_API_SECRET="secret"):
        return (
            APIClient()
            .post(
                f"/api/internal/workspaces/{setup['workspace'].id}/assistant/catalog/{path}",
                {"user_id": str(setup[user].id), **body},
                format="json",
                HTTP_X_PLANE_INTERNAL_KEY="secret",
            )
            .json()
        )


def client_for(user):
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def contract(setup, artistas, end, editorial=False):
    asset = FileAsset.objects.create(
        workspace=setup["workspace"],
        asset=f"{uuid4().hex}.pdf",
        attributes={"name": "c.pdf"},
        entity_type=FileAsset.EntityTypeContext.WORKSPACE_FILE_LIBRARY,
        is_uploaded=True,
    )
    return Contract.objects.create(
        workspace=setup["workspace"], file_asset=asset, titulo=f"Contrato {artistas}", artistas=artistas,
        fecha_fin_efectiva=end, es_editorial=editorial,
    )


def test_upc_check_digit():
    assert valid_upc("036000291452") and valid_upc("4006381333931")
    assert not valid_upc("036000291453") and not valid_upc("123")


class TestAudit:
    def test_every_check(self, setup):
        workspace = setup["workspace"]
        ana = MusicParty.objects.create(workspace=workspace, display_name="Ana López")
        juan = MusicParty.objects.create(workspace=workspace, display_name="Juan Pérez")
        FileTag.objects.create(workspace=workspace, name="Juan Pérez", kind=FileTag.Kind.ARTIST, party=juan)
        FileTag.objects.create(workspace=workspace, name="Sin artista", kind=FileTag.Kind.ARTIST)
        covered = MusicTrack.objects.create(workspace=workspace, title="Cubierta", isrc="MXA012400001", cover_url="x")
        expired = MusicTrack.objects.create(workspace=workspace, title="Vencida", isrc="MXA012400001")
        bad = MusicTrack.objects.create(
            workspace=workspace, title="Mala", isrc="123", artist_percentage=60, record_label_percentage=50
        )
        missing = MusicTrack.objects.create(workspace=workspace, title="Sin ISRC")
        release = MusicRelease.objects.create(workspace=workspace, title="Disco", upc="036000291453", release_date=date(2024, 1, 1))
        MusicRelease.objects.create(workspace=workspace, title="Vacío")
        MusicReleaseTrack.objects.create(workspace=workspace, release=release, track=covered)
        MusicCredit.objects.create(workspace=workspace, track=covered, party=ana, role="PRIMARY_ARTIST")
        MusicCredit.objects.create(workspace=workspace, track=covered, party=juan, role="COMPOSER", publishing_share=60)
        live = contract(setup, "Juan Pérez", date.today() + timedelta(days=30))
        old = contract(setup, "Ana López", date.today() - timedelta(days=1))
        contract(setup, "Ana López", None, editorial=True)
        ContractWorkLink.objects.create(workspace=workspace, contract=live, entity_id=covered.id, status="LINKED")
        ContractWorkLink.objects.create(workspace=workspace, contract=old, entity_id=expired.id, status="LINKED")

        report = internal(setup, "audit/", {})["checks"]
        uncovered = {row["title"]: row["detail"] for row in report["uncovered_tracks"]["examples"]}
        assert "Cubierta" not in uncovered and uncovered["Vencida"] == "expired" and uncovered["Mala"] == "none"
        assert report["editorial_without_works"]["count"] == 1
        codes = {row["title"]: row["detail"] for row in report["codes"]["examples"]}
        assert codes["Mala"].startswith("isrc_invalid") and codes["Sin ISRC"] == "isrc_missing"
        assert codes["Cubierta"] == "isrc_repeated:MXA012400001"
        upcs = {row["title"]: row["detail"] for row in report["codes"]["releases"]["examples"]}
        assert upcs["Disco"].startswith("upc_invalid") and upcs["Vacío"] == "upc_missing"
        credits = {row["title"]: row["detail"] for row in report["credits"]["examples"]}
        assert credits["Cubierta"] == "publishing_sum:60"
        assert "no_primary_artist" in credits["Mala"]
        assert report["track_shares"]["examples"][0]["title"] == "Mala"
        # The contract says Juan; the song credits Ana
        assert report["contract_artist_mismatch"]["examples"][0]["title"] == "Cubierta"
        assert report["tags"]["examples"][0]["title"] == "Ana López"
        assert report["tags"]["tags_without_artist"]["examples"][0]["title"] == "Sin artista"
        gaps = {row["title"]: row["detail"] for row in report["gaps"]["examples"]}
        assert gaps["Sin ISRC"] == "no_release,no_date,no_cover" and "Cubierta" not in gaps
        assert report["gaps"]["releases"]["examples"][0]["title"] == "Vacío"
        assert missing.id

    def test_scope_by_artist_and_members_cannot(self, setup):
        workspace = setup["workspace"]
        ana = MusicParty.objects.create(workspace=workspace, display_name="Ana López")
        mine = MusicTrack.objects.create(workspace=workspace, title="De Ana")
        MusicTrack.objects.create(workspace=workspace, title="Otra")
        MusicCredit.objects.create(workspace=workspace, track=mine, party=ana, role="PRIMARY_ARTIST")
        report = internal(setup, "audit/", {"artist": "ana lópez", "checks": ["gaps"]})
        assert report["scope"]["tracks"] == 1 and list(report["checks"]) == ["gaps"]
        assert "error" in internal(setup, "audit/", {}, user="member")


class TestFixes:
    def test_a_sourced_fix_a_video_and_undo(self, setup):
        workspace = setup["workspace"]
        track = MusicTrack.objects.create(workspace=workspace, title="Canción", isrc="MXA012400009", artist_percentage=50)
        items = [
            {
                "entity": "music_track",
                "id": str(track.id),
                "changes": {"release_date": "2024-05-01", "artist_percentage": "45"},
                "add_video": {"video_url": "https://youtu.be/x", "release_date": "2024-05-02"},
                "source": "Contrato de distribución, cláusula 3",
                "source_type": "contract",
            }
        ]
        preview = internal(setup, "fixes-preview/", {"items": items})
        assert preview["problems"] is None and len(preview["items"][0]["changes"]) == 2
        client = client_for(setup["admin"])
        url = f"/api/workspaces/{workspace.slug}/assistant/actions/"
        response = client.post(url, {"kind": "CATALOG_FIXES", "items": items}, format="json")
        assert response.status_code == 201, response.content
        track.refresh_from_db()
        assert track.release_date == date(2024, 5, 1) and track.artist_percentage == 45
        video = MusicTrack.objects.get(parent_track=track)
        assert video.kind == MusicTrack.Kind.MUSIC_VIDEO

        undone = client.post(f"{url}{response.json()['id']}/undo/", format="json")
        assert undone.status_code == 200, undone.content
        track.refresh_from_db()
        assert track.release_date is None and track.artist_percentage == 50
        assert not MusicTrack.objects.filter(parent_track=track).exists()

    @pytest.mark.parametrize(
        "item, error",
        [
            ({"changes": {"isrc": "MXA012400010"}, "source": "otra canción", "source_type": "catalog"}, "reported"),
            ({"changes": {"isrc": "MXA012400010"}}, "source"),
            ({"changes": {"artist_percentage": "120"}, "source": "x"}, "between 0 and 100"),
            ({"changes": {"isrc": "ABC"}, "source": "x", "source_type": "user"}, "valid ISRC"),
        ],
    )
    def test_what_is_refused(self, setup, item, error):
        track = MusicTrack.objects.create(workspace=setup["workspace"], title="Sin ISRC")
        response = client_for(setup["admin"]).post(
            f"/api/workspaces/{setup['workspace'].slug}/assistant/actions/",
            {"kind": "CATALOG_FIXES", "items": [{"entity": "music_track", "id": str(track.id), **item}]},
            format="json",
        )
        assert response.status_code == 400 and error in response.json()["error"]
        assert not AssistantAction.objects.exists()

    def test_the_user_may_give_a_missing_isrc(self, setup):
        track = MusicTrack.objects.create(workspace=setup["workspace"], title="Sin ISRC")
        response = client_for(setup["admin"]).post(
            f"/api/workspaces/{setup['workspace'].slug}/assistant/actions/",
            {
                "kind": "CATALOG_FIXES",
                "items": [
                    {
                        "entity": "music_track",
                        "id": str(track.id),
                        "changes": {"isrc": "mx-a01-24-00011"},
                        "source": "Lo dictó el usuario",
                        "source_type": "user",
                    }
                ],
            },
            format="json",
        )
        assert response.status_code == 201, response.content
        track.refresh_from_db()
        assert track.isrc == "MXA012400011"
