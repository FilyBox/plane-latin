"""The assistant's edits across the workspace: each card applies once, every
change is recorded field by field, and undo refuses what someone changed since."""

from datetime import date
from decimal import Decimal
from uuid import uuid4

import pytest
from rest_framework.test import APIClient

from plane.db.models import AssistantAction, AssistantChat, FileAsset, FileTag, FileTagLink, WorkspaceFeature
from plane.tests.factories import (
    ProjectFactory,
    ProjectMemberFactory,
    UserFactory,
    WorkspaceFactory,
    WorkspaceMemberFactory,
)
from plane.utils.assistant_undo import diff, revert_fields, snapshot, to_json

pytestmark = [pytest.mark.unit, pytest.mark.django_db]


@pytest.fixture
def setup():
    workspace = WorkspaceFactory()
    for key in ("file_library", "references", "music_catalog", "payments"):
        WorkspaceFeature.objects.create(workspace=workspace, key=key, is_enabled=True)
    admin = workspace.owner
    WorkspaceMemberFactory(workspace=workspace, member=admin, role=20)
    member = UserFactory(username=f"member-{uuid4().hex[:8]}")
    WorkspaceMemberFactory(workspace=workspace, member=member, role=15)
    project = ProjectFactory(workspace=workspace)
    for user, role in ((admin, 20), (member, 15)):
        ProjectMemberFactory(project=project, member=user, role=role)
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


def actions_url(setup, suffix=""):
    return f"/api/workspaces/{setup['workspace'].slug}/assistant/actions/{suffix}"


class TestCardsApplyOnce:
    def test_a_card_applies_once_and_reports_its_outcome(self, setup):
        workspace = setup["workspace"]
        tag = FileTag.objects.create(workspace=workspace, name="Minutas")
        chat = AssistantChat.objects.create(workspace=workspace, user=setup["member"])
        body = {
            "kind": "TAG_ITEMS",
            "tag_id": str(tag.id),
            "items": [{"entity_name": "file", "id": str(setup["asset"].id)}],
            "tool_call_id": "call-1",
            "chat_id": str(chat.id),
        }
        client = client_for(setup["member"])
        first = client.post(actions_url(setup), body, format="json")
        assert first.status_code == 201, first.content
        again = client.post(actions_url(setup), body, format="json")
        assert again.status_code == 200 and again.json()["id"] == first.json()["id"]
        assert AssistantAction.objects.filter(workspace=workspace).count() == 1
        action = AssistantAction.objects.get()
        assert action.tool_call_id == "call-1" and action.chat_id == chat.id

        outcomes = client.get(actions_url(setup), {"tool_call_ids": "call-1,call-2"}).json()["outcomes"]
        assert list(outcomes) == ["call-1"] and outcomes["call-1"]["status"] == "APPLIED"
        # Someone else's cards are not theirs to read
        assert client_for(setup["admin"]).get(actions_url(setup), {"tool_call_ids": "call-1"}).json()["outcomes"] == {}

        client.post(actions_url(setup, f"{first.json()['id']}/undo/"), format="json")
        assert not FileTagLink.objects.filter(tag=tag).exists()
        outcomes = client.get(actions_url(setup), {"tool_call_ids": "call-1"}).json()["outcomes"]
        assert outcomes["call-1"]["status"] == "UNDONE"
        # An undone card is not applied again
        assert client.post(actions_url(setup), body, format="json").json()["status"] == "UNDONE"

    def test_a_chat_of_someone_else_is_not_linked(self, setup):
        other_chat = AssistantChat.objects.create(workspace=setup["workspace"], user=setup["admin"])
        tag = FileTag.objects.create(workspace=setup["workspace"], name="Minutas")
        body = {
            "kind": "TAG_ITEMS",
            "tag_id": str(tag.id),
            "items": [{"entity_name": "file", "id": str(setup["asset"].id)}],
            "chat_id": str(other_chat.id),
        }
        assert client_for(setup["member"]).post(actions_url(setup), body, format="json").status_code == 201
        assert AssistantAction.objects.get().chat_id is None


class TestFieldUndo:
    def test_values_compare_as_json(self):
        assert to_json(Decimal("1500.00")) == to_json(Decimal("1500")) == "1500"
        assert to_json(date(2026, 3, 1)) == "2026-03-01"

    def test_revert_only_what_still_holds_the_edit(self, setup):
        project = setup["project"]
        before = snapshot(project, ["name", "description"])
        project.name, project.description = "Lanzamientos 2027", "nueva"
        changes = diff(before, snapshot(project, ["name", "description"]))
        assert [change["field"] for change in changes] == ["name", "description"]
        project.description = "alguien la cambió"
        reverted, conflicts = revert_fields(project, changes)
        assert reverted == ["name"] and project.name == before["name"]
        assert conflicts == [{"field": "description", "expected": "nueva", "current": "alguien la cambió"}]
