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
