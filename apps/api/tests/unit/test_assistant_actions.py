"""Changes the assistant makes after approval: tagging in bulk and creating
work items, each recorded so undo reverts exactly that."""

from datetime import timedelta
from unittest.mock import patch
from uuid import uuid4

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from plane.db.models import (
    AssistantAction,
    EntityTagLink,
    FileAsset,
    FileTag,
    FileTagLink,
    Issue,
    MusicTrack,
    State,
    WorkspaceFeature,
)
from plane.db.models.reference import EntityReference
from plane.tests.factories import (
    ProjectFactory,
    ProjectMemberFactory,
    UserFactory,
    WorkspaceFactory,
    WorkspaceMemberFactory,
)

pytestmark = [pytest.mark.unit, pytest.mark.django_db]


@pytest.fixture
def setup():
    workspace = WorkspaceFactory()
    for key in ("file_library", "music_catalog", "references"):
        WorkspaceFeature.objects.create(workspace=workspace, key=key, is_enabled=True)
    admin = workspace.owner
    WorkspaceMemberFactory(workspace=workspace, member=admin, role=20)
    member = UserFactory(username=f"member-{uuid4().hex[:8]}")
    WorkspaceMemberFactory(workspace=workspace, member=member, role=15)
    project = ProjectFactory(workspace=workspace)
    for user, role in ((admin, 20), (member, 15)):
        ProjectMemberFactory(project=project, member=user, role=role)
    State.objects.create(name="Todo", project=project, workspace=workspace, group="unstarted", default=True)
    asset = FileAsset.objects.create(
        workspace=workspace,
        asset=f"{workspace.id}/{uuid4().hex}.pdf",
        attributes={"name": "minuta.pdf", "type": "application/pdf", "size": 10},
        entity_type=FileAsset.EntityTypeContext.WORKSPACE_FILE_LIBRARY,
        is_uploaded=True,
    )
    return {"workspace": workspace, "admin": admin, "member": member, "project": project, "asset": asset}


def client_for(user):
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def url(setup, suffix=""):
    return f"/api/workspaces/{setup['workspace'].slug}/assistant/actions/{suffix}"


class TestTagging:
    def test_undo_reverts_only_what_changed(self, setup):
        workspace = setup["workspace"]
        tag = FileTag.objects.create(workspace=workspace, name="3BallMTY")
        tagged = MusicTrack.objects.create(workspace=workspace, title="Mirala")
        fresh = MusicTrack.objects.create(workspace=workspace, title="El Nene")
        EntityTagLink.objects.create(
            workspace=workspace, tag=tag, entity_type="music_track", entity_id=tagged.id, status=EntityTagLink.Status.CONFIRMED
        )
        items = [{"entity_name": "music_track", "id": str(t.id)} for t in (tagged, fresh)]
        items.append({"entity_name": "file", "id": str(setup["asset"].id)})
        client = client_for(setup["admin"])
        action = client.post(url(setup), {"kind": "TAG_ITEMS", "tag_id": str(tag.id), "items": items}, format="json")
        assert action.status_code == 201, action.content
        assert len(action.json()["result"]["changed"]) == 2
        assert FileTagLink.objects.filter(tag=tag, file_asset=setup["asset"]).exists()

        undone = client.post(url(setup, f"{action.json()['id']}/undo/"), format="json")
        assert undone.status_code == 200 and undone.json()["status"] == "UNDONE"
        # The song that already had the tag keeps it.
        assert EntityTagLink.objects.filter(tag=tag, entity_id=tagged.id).exists()
        assert not EntityTagLink.objects.filter(tag=tag, entity_id=fresh.id).exists()
        assert not FileTagLink.objects.filter(tag=tag, file_asset=setup["asset"]).exists()
        assert client.post(url(setup, f"{action.json()['id']}/undo/"), format="json").status_code == 409

    def test_members_skip_music_and_new_tags_go_away_on_undo(self, setup):
        workspace = setup["workspace"]
        song = MusicTrack.objects.create(workspace=workspace, title="Mirala")
        items = [
            {"entity_name": "music_track", "id": str(song.id)},
            {"entity_name": "file", "id": str(setup["asset"].id)},
        ]
        client = client_for(setup["member"])
        action = client.post(url(setup), {"kind": "TAG_ITEMS", "tag_name": "Minutas", "items": items}, format="json")
        assert action.status_code == 201, action.content
        result = action.json()["result"]
        assert result["skipped"] == 1 and result["created_tag"] is True
        client.post(url(setup, f"{action.json()['id']}/undo/"), format="json")
        assert not FileTag.objects.filter(workspace=workspace, name="Minutas").exists()


class TestWorkItems:
    @patch("plane.bgtasks.issue_activities_task.issue_activity.delay")
    def test_create_with_references_and_undo(self, _activity, setup):
        client = client_for(setup["member"])
        body = {
            "kind": "CREATE_WORK_ITEM",
            "project_id": str(setup["project"].id),
            "name": "Renovar contrato de Alvara2",
            "description": "Antes de febrero.\nRevisar regalías.",
            "priority": "high",
            "assignee_ids": [str(setup["admin"].id)],
            "target_date": "2027-01-31",
            "references": [{"entity_name": "file", "id": str(setup["asset"].id)}],
        }
        response = client.post(url(setup), body, format="json")
        assert response.status_code == 201, response.content
        result = response.json()["result"]
        issue = Issue.objects.get(id=result["issue_id"])
        assert issue.priority == "high" and str(issue.target_date) == "2027-01-31"
        assert result["path"].endswith(f"/browse/{result['key']}/")
        assert EntityReference.objects.filter(source_id=issue.id, target_id=setup["asset"].id).exists()

        undone = client.post(url(setup, f"{response.json()['id']}/undo/"), format="json")
        assert undone.status_code == 200
        assert not Issue.issue_objects.filter(id=issue.id).exists()

    @patch("plane.bgtasks.issue_activities_task.issue_activity.delay")
    def test_undo_refuses_after_someone_edited_it(self, _activity, setup):
        client = client_for(setup["admin"])
        response = client.post(
            url(setup),
            {"kind": "CREATE_WORK_ITEM", "project_id": str(setup["project"].id), "name": "Video de Mirala"},
            format="json",
        )
        issue_id = response.json()["result"]["issue_id"]
        Issue.objects.filter(id=issue_id).update(updated_at=timezone.now() + timedelta(minutes=5))
        assert client.post(url(setup, f"{response.json()['id']}/undo/"), format="json").status_code == 409
        assert Issue.issue_objects.filter(id=issue_id).exists()
        assert AssistantAction.objects.get(id=response.json()["id"]).status == "APPLIED"

    def test_only_project_members_create(self, setup):
        from plane.db.models import Project, ProjectMember

        outsider_project = Project.objects.create(
            name=f"Fuera {uuid4().hex[:6]}", identifier=uuid4().hex[:5].upper(), workspace=setup["workspace"]
        )
        assert not ProjectMember.objects.filter(project=outsider_project, member=setup["member"]).exists()
        response = client_for(setup["member"]).post(
            url(setup), {"kind": "CREATE_WORK_ITEM", "project_id": str(outsider_project.id), "name": "X"}, format="json"
        )
        assert response.status_code == 400


class TestHistory:
    def test_members_see_their_own_admins_see_everything(self, setup):
        from plane.db.models import TaggingRun

        workspace = setup["workspace"]
        tag = FileTag.objects.create(workspace=workspace, name="Minutas")
        item = [{"entity_name": "file", "id": str(setup["asset"].id)}]
        client_for(setup["member"]).post(url(setup), {"kind": "TAG_ITEMS", "tag_id": str(tag.id), "items": item}, format="json")
        client_for(setup["admin"]).post(url(setup), {"kind": "UNTAG_ITEMS", "tag_id": str(tag.id), "items": item}, format="json")
        TaggingRun.objects.create(
            workspace=workspace,
            status=TaggingRun.Status.COMPLETED,
            scope={"source": "assistant", "merge": {"keep": "3BallMTY", "variants": ["3Ball Mty"]}},
            created_by=setup["admin"],
        )
        mine = client_for(setup["member"]).get(url(setup), {"scope": "all"}).json()
        assert [row["kind"] for row in mine["actions"]] == ["TAG_ITEMS"] and mine["can_see_all"] is False
        everything = client_for(setup["admin"]).get(url(setup), {"scope": "all"}).json()
        assert {row["kind"] for row in everything["actions"]} == {"TAG_ITEMS", "UNTAG_ITEMS", "MERGE_TAGS"}
        merge = next(row for row in everything["actions"] if row["kind"] == "MERGE_TAGS")
        assert "3Ball Mty" in merge["summary"]
        tagged = next(row for row in everything["actions"] if row["kind"] == "TAG_ITEMS")
        assert tagged["actor"]


class TestPages:
    def test_markdown_becomes_safe_editor_html_with_mentions(self, setup):
        from plane.utils.assistant_markdown import markdown_to_html

        asset_id = str(setup["asset"].id)
        markdown = (
            "# Informe de **3BallMTY**\n\n"
            f"Revisar :file[minuta.pdf]{{name={asset_id}}} y :tag[3BallMTY]{{name={uuid4()}}}.\n\n"
            "- Uno\n- Dos <script>alert(1)</script>\n\n1. Primero\n\n> Nota"
        )
        result = markdown_to_html(markdown, {"file"})
        assert result.startswith("<h1>Informe de <strong>3BallMTY</strong></h1>")
        assert f'entity_name="file" entity_identifier="{asset_id}"' in result
        assert "<strong>3BallMTY</strong>." in result  # tags aren't editor mentions
        assert "<script>" not in result and "&lt;script&gt;" in result
        assert "<ul><li><p>Uno</p></li>" in result and "<ol>" in result and "<blockquote>" in result

    @patch("plane.bgtasks.page_transaction_task.page_transaction.delay")
    def test_create_page_with_references_and_undo(self, _transaction, setup):
        from plane.db.models import Page

        client = client_for(setup["member"])
        body = {
            "kind": "CREATE_PAGE",
            "project_id": str(setup["project"].id),
            "name": "Dossier 3BallMTY",
            "markdown": f"## Archivos\n\n- :file[minuta.pdf]{{name={setup['asset'].id}}}",
        }
        response = client.post(url(setup), body, format="json")
        assert response.status_code == 201, response.content
        result = response.json()["result"]
        page = Page.objects.get(id=result["page_id"])
        assert "mention-component" in page.description_html and page.access == 0
        assert EntityReference.objects.filter(source_id=page.id, target_id=setup["asset"].id).exists()
        assert client.post(url(setup, f"{response.json()['id']}/undo/"), format="json").status_code == 200
        assert not Page.objects.filter(id=page.id).exists()

    @patch("plane.bgtasks.page_transaction_task.page_transaction.delay")
    def test_undo_refuses_once_the_text_changed(self, _transaction, setup):
        from plane.db.models import Page

        client = client_for(setup["admin"])
        response = client.post(
            url(setup),
            {"kind": "CREATE_PAGE", "project_id": str(setup["project"].id), "name": "Notas", "markdown": "Hola"},
            format="json",
        )
        page_id = response.json()["result"]["page_id"]
        Page.objects.filter(id=page_id).update(description_html="<p>Hola y algo más que escribió alguien</p>")
        assert client.post(url(setup, f"{response.json()['id']}/undo/"), format="json").status_code == 409
        assert Page.objects.filter(id=page_id).exists()


class TestReports:
    def test_tag_report_lists_contracts_songs_videos_and_links(self, setup):
        from datetime import date

        from django.test import override_settings

        from plane.db.models import Contract, MusicLink, MusicRelease

        workspace = setup["workspace"]
        tag = FileTag.objects.create(workspace=workspace, name="3BallMTY")
        song = MusicTrack.objects.create(workspace=workspace, title="Mirala", isrc="USA2P2501574", release_date=date(2025, 1, 31))
        video = MusicTrack.objects.create(
            workspace=workspace, title="Mirala (video)", kind=MusicTrack.Kind.MUSIC_VIDEO, parent_track=song
        )
        MusicLink.objects.create(workspace=workspace, track=song, platform="Spotify", name="Spotify", url="https://open.spotify.com/track/x")
        MusicLink.objects.create(
            workspace=workspace, track=video, platform="YouTube", name="YouTube", url="https://youtu.be/mirala",
            kind=MusicLink.Kind.MUSIC_VIDEO,
        )
        release = MusicRelease.objects.create(workspace=workspace, title="Mirala", release_date=date(2025, 1, 31), upc="198704319051")
        contract = Contract.objects.create(
            workspace=workspace, file_asset=setup["asset"], titulo="Exclusividad 3Ball",
            fecha_inicio=date(2024, 3, 1), fecha_fin=date(2027, 2, 28), estatus_contrato="VIGENTE",
        )
        for kind, entity in (("music_track", song), ("music_release", release)):
            EntityTagLink.objects.create(
                workspace=workspace, tag=tag, entity_type=kind, entity_id=entity.id, status=EntityTagLink.Status.CONFIRMED
            )
        FileTagLink.objects.create(workspace=workspace, file_asset=setup["asset"], tag=tag)

        with override_settings(PLANE_INTERNAL_API_SECRET="secret"):
            response = APIClient().post(
                f"/api/internal/workspaces/{workspace.id}/assistant/report/",
                {"user_id": str(setup["admin"].id), "tag": "3ballmty"},
                format="json",
                HTTP_X_PLANE_INTERNAL_KEY="secret",
            )
        assert response.status_code == 200, response.content
        report = response.json()
        markdown = report["markdown"]
        assert report["counts"] == {"contracts": 1, "tracks": 1, "releases": 1}
        assert f":contract[Exclusividad 3Ball]{{name={contract.id}}}" in markdown
        assert "| 2024-03-01 | 2027-02-28 |" in markdown
        assert f":music_track[Mirala]{{name={song.id}}} | 2025-01-31 | USA2P2501574" in markdown
        assert "[YouTube](https://youtu.be/mirala)" in markdown and "[Spotify](https://open.spotify.com/track/x)" in markdown
        assert "198704319051" in markdown


class TestVideoFilters:
    def test_assistant_filters_by_video_isrc_upc_and_dates(self, setup):
        from datetime import date

        from django.test import override_settings

        from plane.db.models import MusicLink

        workspace = setup["workspace"]
        song = MusicTrack.objects.create(workspace=workspace, title="Mirala", release_date=date(2025, 1, 31))
        other = MusicTrack.objects.create(workspace=workspace, title="El Nene")
        video = MusicTrack.objects.create(
            workspace=workspace, parent_track=song, title="Mirala (video)", kind=MusicTrack.Kind.MUSIC_VIDEO,
            isrc_video="MXA3Y2500001", upc="198704319099", release_date=date(2025, 2, 14),
        )
        MusicLink.objects.create(workspace=workspace, track=video, kind=MusicLink.Kind.MUSIC_VIDEO, platform="YouTube", name="YouTube", url="https://www.youtube.com/")
        MusicLink.objects.create(workspace=workspace, track=song, platform="Google", name="Google", url="https://www.google.com/")

        def fetch(**params):
            with override_settings(PLANE_INTERNAL_API_SECRET="secret"):
                return APIClient().get(
                    f"/api/internal/workspaces/{workspace.id}/music/tracks/", params, HTTP_X_PLANE_INTERNAL_KEY="secret"
                ).json()

        assert [row["title"] for row in fetch(video_isrc="2500001")["results"]] == ["Mirala"]
        assert [row["title"] for row in fetch(video_upc="319099")["results"]] == ["Mirala"]
        assert fetch(video_from="2025-02-01", video_to="2025-02-28")["total"] == 1
        assert fetch(video_upc="000000")["total"] == 0
        row = fetch(video_isrc="MXA3Y")["results"][0]
        assert row["videos"][0]["upc"] == "198704319099" and row["videos"][0]["urls"] == ["https://www.youtube.com/"]
        assert row["links"][0]["url"] == "https://www.google.com/"
        assert other.title not in [r["title"] for r in fetch(has_links="true")["results"]]
