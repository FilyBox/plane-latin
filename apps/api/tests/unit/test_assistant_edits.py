"""Edits the assistant makes to existing data after approval: contract
corrections (same path as the panel, marked as manual) and work items (same
path as Plane's PATCH, with activity), each undone field by field."""

from datetime import date
from unittest.mock import patch
from uuid import uuid4

import pytest
from rest_framework.test import APIClient

from plane.db.models import (
    AssistantAction,
    Contract,
    FileAsset,
    FileTag,
    FileTagLink,
    Issue,
    IssueAssignee,
    IssueComment,
    Label,
    State,
    WorkspaceFeature,
)
from plane.tests.factories import (
    ProjectFactory,
    ProjectMemberFactory,
    UserFactory,
    WorkspaceFactory,
    WorkspaceMemberFactory,
)
from plane.utils.contract_extraction import proposed_changes

pytestmark = [pytest.mark.unit, pytest.mark.django_db]


@pytest.fixture
def setup():
    workspace = WorkspaceFactory()
    for key in ("file_library", "references"):
        WorkspaceFeature.objects.create(workspace=workspace, key=key, is_enabled=True)
    admin = workspace.owner
    admin.display_name = "Admin"
    admin.save()
    WorkspaceMemberFactory(workspace=workspace, member=admin, role=20)
    ana = UserFactory(username=f"ana-{uuid4().hex[:8]}", display_name="Ana López", first_name="Ana")
    WorkspaceMemberFactory(workspace=workspace, member=ana, role=15)
    guest = UserFactory(username=f"guest-{uuid4().hex[:8]}", display_name="Invitado")
    WorkspaceMemberFactory(workspace=workspace, member=guest, role=5)
    project = ProjectFactory(workspace=workspace, name="Lanzamientos", identifier="LAN")
    for user, role in ((admin, 20), (ana, 15), (guest, 5)):
        ProjectMemberFactory(project=project, member=user, role=role)
    todo = State.objects.create(name="Por hacer", project=project, workspace=workspace, group="unstarted", default=True)
    done = State.objects.create(name="Hecho", project=project, workspace=workspace, group="completed")
    return {
        "workspace": workspace,
        "admin": admin,
        "ana": ana,
        "guest": guest,
        "project": project,
        "todo": todo,
        "done": done,
    }


def client_for(user):
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def url(setup, suffix=""):
    return f"/api/workspaces/{setup['workspace'].slug}/assistant/actions/{suffix}"


def internal(setup, path, body):
    from django.test import override_settings

    with override_settings(PLANE_INTERNAL_API_SECRET="secret"):
        return (
            APIClient()
            .post(
                f"/api/internal/workspaces/{setup['workspace'].id}/assistant/{path}",
                {"user_id": str(setup["admin"].id), **body},
                format="json",
                HTTP_X_PLANE_INTERNAL_KEY="secret",
            )
            .json()
        )


# ------------------------------------------------------------- contracts


@pytest.fixture
def contract(setup):
    asset = FileAsset.objects.create(
        workspace=setup["workspace"],
        asset=f"{setup['workspace'].id}/{uuid4().hex}.pdf",
        attributes={"name": "edicion.pdf", "type": "application/pdf"},
        entity_type=FileAsset.EntityTypeContext.WORKSPACE_FILE_LIBRARY,
        is_uploaded=True,
    )
    return Contract.objects.create(
        workspace=setup["workspace"],
        file_asset=asset,
        titulo="Edición Juan",
        artistas="Juan Pérez",
        fecha_inicio=date(2024, 1, 1),
        fecha_fin=date(2026, 1, 1),
        fecha_fin_efectiva=date(2027, 1, 1),
        estatus_contrato="vigente",
        evidence={"fecha_fin": {"quote": "dos años", "page": 2}},
    )


class TestContractEdit:
    def body(self, contract, changes, **extra):
        return {
            "kind": "EDIT_CONTRACT",
            "items": [{"contract_id": str(contract.id), "changes": changes, "quote": "hasta 2028", "page": 3, **extra}],
        }

    def test_the_preview_validates_and_shows_before_and_after(self, setup, contract):
        preview = internal(
            setup,
            "contracts/edit-preview/",
            {"items": [{"contract_id": str(contract.id), "changes": {"fecha_fin": "2027-01-01", "tipo_contrato": "x"}}]},
        )
        row = preview["contracts"][0]
        assert "tipo_contrato" in row["errors"]

    def test_the_end_carries_the_effective_end_and_undo_restores_it(self, setup, contract):
        client = client_for(setup["admin"])
        response = client.post(url(setup), self.body(contract, {"fecha_fin": "2027-01-01"}), format="json")
        assert response.status_code == 201, response.content
        contract.refresh_from_db()
        # One year of extension stays: 2027 → 2028
        assert contract.fecha_fin == date(2027, 1, 1) and contract.fecha_fin_efectiva == date(2028, 1, 1)
        assert contract.evidence["fecha_fin"]["manual"] is True and contract.evidence["fecha_fin"]["page"] == 3
        fields = {change["field"] for change in response.json()["result"]["contracts"][0]["changes"]}
        assert fields >= {"fecha_fin", "fecha_fin_efectiva"}
        # A re-analysis flags the hand correction
        changes = proposed_changes(contract, {"fechaFin": "2030-01-01"})
        assert next(change for change in changes if change["field"] == "fecha_fin")["manual"] is True

        undone = client.post(url(setup, f"{response.json()['id']}/undo/"), format="json")
        assert undone.status_code == 200, undone.content
        contract.refresh_from_db()
        assert contract.fecha_fin == date(2026, 1, 1) and contract.fecha_fin_efectiva == date(2027, 1, 1)
        assert contract.evidence["fecha_fin"] == {"quote": "dos años", "page": 2}

    def test_undo_keeps_what_someone_changed_since(self, setup, contract):
        client = client_for(setup["admin"])
        body = self.body(contract, {"fecha_inicio": "2024-03-01", "titulo": "Edición Juan Pérez"})
        action = client.post(url(setup), body, format="json").json()
        Contract.objects.filter(id=contract.id).update(titulo="Editado a mano")
        undone = client.post(url(setup, f"{action['id']}/undo/"), format="json").json()
        contract.refresh_from_db()
        assert contract.fecha_inicio == date(2024, 1, 1) and contract.titulo == "Editado a mano"
        conflict = undone["result"]["undo_conflicts"][0]
        assert conflict["field"] == "titulo" and conflict["current"] == "Editado a mano"
        assert "manual" in contract.evidence["titulo"]

    def test_artist_tags_follow_the_correction(self, setup, contract):
        client = client_for(setup["admin"])
        client.post(url(setup), self.body(contract, {"artistas": "Ana López"}), format="json")
        tag = FileTag.objects.get(workspace=setup["workspace"], name__icontains="Ana López")
        assert FileTagLink.objects.filter(tag=tag, file_asset=contract.file_asset).exists()

    def test_guests_cannot(self, setup, contract):
        response = client_for(setup["guest"]).post(url(setup), self.body(contract, {"titulo": "x"}), format="json")
        assert response.status_code in (400, 403)
        assert not AssistantAction.objects.exists()


# ------------------------------------------------------------- work items


def make_issue(setup, name, **extra):
    return Issue.objects.create(
        workspace=setup["workspace"], project=setup["project"], name=name, state=setup["todo"], **extra
    )


@patch("plane.bgtasks.webhook_task.model_activity.delay")
@patch("plane.bgtasks.issue_activities_task.issue_activity.delay")
class TestWorkItems:
    def test_query_with_names(self, activity, webhook, setup):
        issue = make_issue(setup, "Masterizar sencillo")
        IssueAssignee.objects.create(
            issue=issue, assignee=setup["ana"], project=setup["project"], workspace=setup["workspace"]
        )
        make_issue(setup, "Otra")
        found = internal(setup, "work-items/query/", {"project": "LAN", "assignee": "ana"})
        assert [row["key"] for row in found["items"]] == [f"LAN-{issue.sequence_id}"]
        assert found["items"][0]["assignees"] == ["Ana López"]

    def test_five_to_done_with_activity_and_undo(self, activity, webhook, setup):
        issues = [make_issue(setup, f"Tarea {index}") for index in range(5)]
        preview = internal(
            setup,
            "work-items/update-preview/",
            {"items": [{"issue_id": f"LAN-{issue.sequence_id}", "set": {"state": "hecho"}} for issue in issues]},
        )
        assert len(preview["items"]) == 5 and preview["items"][0]["changes"][0]["after"] == "Hecho"
        body = {
            "kind": "EDIT_WORK_ITEMS",
            "items": [{"issue_id": row["issue_id"], "changes": row["changes"]} for row in preview["items"]],
        }
        client = client_for(setup["admin"])
        response = client.post(url(setup), body, format="json")
        assert response.status_code == 201, response.content
        assert Issue.issue_objects.filter(state=setup["done"]).count() == 5
        updated = [call for call in activity.call_args_list if call.kwargs["type"] == "issue.activity.updated"]
        assert len(updated) == 5 and '"state_id"' in updated[0].kwargs["current_instance"]

        Issue.objects.filter(id=issues[0].id).update(priority="urgent")  # unrelated field: no conflict
        undone = client.post(url(setup, f"{response.json()['id']}/undo/"), format="json")
        assert undone.status_code == 200, undone.content
        assert Issue.issue_objects.filter(state=setup["todo"]).count() == 5
        assert len([call for call in activity.call_args_list if call.kwargs["type"] == "issue.activity.updated"]) == 10

    def test_assignees_labels_and_ambiguity(self, activity, webhook, setup):
        issue = make_issue(setup, "Video")
        Label.objects.create(project=setup["project"], workspace=setup["workspace"], name="Renovación")
        Label.objects.create(project=setup["project"], workspace=setup["workspace"], name="Renovación 2025")
        preview = internal(
            setup,
            "work-items/update-preview/",
            {"items": [{"issue_id": str(issue.id), "set": {"assignees_add": ["Ana"], "labels_add": ["renova"]}}]},
        )
        changes = preview["items"][0]["changes"]
        assert changes[0]["value"] == str(setup["ana"].id)
        # Two labels match: the card asks
        assert changes[1]["value"] is None and len(changes[1]["choices"]) == 2
        changes[1]["value"] = changes[1]["choices"][0]["id"]
        client_for(setup["admin"]).post(
            url(setup),
            {"kind": "EDIT_WORK_ITEMS", "items": [{"issue_id": str(issue.id), "changes": changes}]},
            format="json",
        )
        assert list(issue.assignees.all()) == [setup["ana"]] and issue.labels.count() == 1

    def test_a_guest_cannot_edit(self, activity, webhook, setup):
        issue = make_issue(setup, "Video")
        body = {
            "kind": "EDIT_WORK_ITEMS",
            "items": [{"issue_id": str(issue.id), "changes": [{"field": "priority", "value": "high"}]}],
        }
        response = client_for(setup["guest"]).post(url(setup), body, format="json")
        assert response.status_code in (400, 403)
        issue.refresh_from_db()
        assert issue.priority != "high"

    def test_comment_and_undo(self, activity, webhook, setup):
        issue = make_issue(setup, "Video")
        body = {"kind": "COMMENT_WORK_ITEM", "issue_id": str(issue.id), "markdown": "Listo el **master**"}
        client = client_for(setup["admin"])
        response = client.post(url(setup), body, format="json")
        assert response.status_code == 201, response.content
        comment = IssueComment.objects.get(issue=issue)
        assert "<strong>master</strong>" in comment.comment_html
        client.post(url(setup, f"{response.json()['id']}/undo/"), format="json")
        assert not IssueComment.objects.filter(id=comment.id).exists()
        assert {call.kwargs["type"] for call in activity.call_args_list} >= {
            "comment.activity.created",
            "comment.activity.deleted",
        }
