"""Workspace assistant: conversations stored per user, the page context it
receives, who gets which tools, and the contract lookups for large sets."""

from unittest.mock import MagicMock, patch
from uuid import uuid4

import pytest
from django.test import override_settings
from rest_framework.test import APIClient

from plane.db.models import (
    AssistantChat,
    AssistantChatMessage,
    Contract,
    FileAsset,
    WorkspaceFeature,
)
from plane.tests.factories import UserFactory, WorkspaceFactory, WorkspaceMemberFactory

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
    return {"workspace": workspace, "admin": admin, "member": member}


def client_for(user):
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def contract(workspace, title, text, **extra):
    asset = FileAsset.objects.create(
        workspace=workspace,
        asset=f"{workspace.id}/{uuid4().hex}.pdf",
        attributes={"name": f"{title}.pdf", "type": "application/pdf", "size": 10},
        entity_type=FileAsset.EntityTypeContext.WORKSPACE_FILE_LIBRARY,
        is_uploaded=True,
    )
    return Contract.objects.create(workspace=workspace, file_asset=asset, titulo=title, extracted_text=text, **extra)


class TestChats:
    def test_each_user_sees_only_their_chats(self, setup):
        slug = setup["workspace"].slug
        admin, member = client_for(setup["admin"]), client_for(setup["member"])
        chat = admin.post(f"/api/workspaces/{slug}/assistant/chats/", {}, format="json").json()
        assert [row["id"] for row in admin.get(f"/api/workspaces/{slug}/assistant/chats/").json()] == [chat["id"]]
        assert member.get(f"/api/workspaces/{slug}/assistant/chats/").json() == []
        assert member.get(f"/api/workspaces/{slug}/assistant/chats/{chat['id']}/").status_code == 404

    def test_transcript_replaces_titles_and_shrinks_big_results(self, setup):
        slug = setup["workspace"].slug
        client = client_for(setup["admin"])
        chat = client.post(f"/api/workspaces/{slug}/assistant/chats/", {}, format="json").json()
        url = f"/api/workspaces/{slug}/assistant/chats/{chat['id']}/messages/"
        big = {"total": 900, "results": [{"title": "x" * 200}] * 400}
        transcript = [
            {"id": "1", "role": "user", "parts": [{"type": "text", "text": "Canciones de   3BallMTY en 2024"}]},
            {
                "id": "2",
                "role": "assistant",
                "parts": [
                    {"type": "tool-query_music_tracks", "toolCallId": "a", "state": "output-available", "output": big},
                    {"type": "text", "text": "Encontré 900."},
                ],
            },
        ]
        assert client.put(url, {"messages": transcript}, format="json").status_code == 200
        client.put(url, {"messages": transcript}, format="json")
        stored = AssistantChatMessage.objects.filter(chat_id=chat["id"]).order_by("position")
        assert stored.count() == 2
        assert stored[1].parts[0]["output"] == {"total": 900, "_truncated": True}
        assert AssistantChat.objects.get(id=chat["id"]).title == "Canciones de 3BallMTY en 2024"
        detail = client.get(f"/api/workspaces/{slug}/assistant/chats/{chat['id']}/").json()
        assert [message["role"] for message in detail["messages"]] == ["user", "assistant"]


class TestChatPayload:
    def run_chat(self, setup, user, body):
        upstream = MagicMock(status_code=200, headers={"Content-Type": "text/event-stream"})
        upstream.iter_content.return_value = iter([b"data: [DONE]\n\n"])
        with patch("plane.app.views.assistant.base.stream_assistant_chat", return_value=upstream) as stream:
            response = client_for(user).post(
                f"/api/workspaces/{setup['workspace'].slug}/assistant/chat/",
                {"messages": [{"role": "user", "parts": [{"type": "text", "text": "hola"}]}], **body},
                format="json",
            )
            assert response.status_code == 200
            return stream.call_args[0][0]

    def test_members_do_not_get_music_tools(self, setup):
        assert self.run_chat(setup, setup["admin"], {})["capabilities"]["music"] is True
        assert self.run_chat(setup, setup["member"], {})["capabilities"]["music"] is False

    def test_page_context_is_resolved_on_the_server(self, setup):
        item = contract(setup["workspace"], "Contrato editorial 3Ball", "texto")
        context = {"page": "contracts", "items": [{"entity_name": "contract", "id": str(item.id), "title": "X"}]}
        payload = self.run_chat(setup, setup["member"], {"context": context})
        assert payload["context"]["page"] == "contracts"
        assert payload["context"]["items"][0]["title"] == "Contrato editorial 3Ball"
        assert payload["today"] and payload["user_id"] == str(setup["member"].id)


class TestContractLookups:
    def post(self, path, body):
        with override_settings(PLANE_INTERNAL_API_SECRET="secret"):
            return APIClient().post(path, body, format="json", HTTP_X_PLANE_INTERNAL_KEY="secret")

    def test_group_counts_without_rows(self, setup):
        workspace = setup["workspace"]
        contract(workspace, "A", "", estatus_contrato="VIGENTE", artistas="3BallMTY, El Bebeto")
        contract(workspace, "B", "", estatus_contrato="VIGENTE", artistas="3ballmty")
        contract(workspace, "C", "", estatus_contrato="FINALIZADO", artistas="Shaira")
        base = f"/api/internal/workspaces/{workspace.id}/contracts/group/"
        by_status = self.post(base, {"group_by": "estatus"}).json()
        assert by_status["total"] == 3
        assert {row["value"]: row["count"] for row in by_status["buckets"]} == {"VIGENTE": 2, "FINALIZADO": 1}
        by_artist = self.post(base, {"group_by": "artista"}).json()
        assert by_artist["buckets"][0] == {"value": "3BallMTY", "count": 2}
        assert self.post(base, {"group_by": "color"}).status_code == 400

    def test_scan_reads_the_whole_filtered_set_and_returns_only_matches(self, setup):
        workspace = setup["workspace"]
        for index in range(30):
            text = "cláusula de regalías estándar" if index % 10 else "INE de Juan Pérez"
            contract(workspace, f"Doc {index}", text)
        contract(workspace, "Sin texto", "")
        scan = f"/api/internal/workspaces/{workspace.id}/contracts/scan/"
        result = self.post(scan, {"keywords": ["juan perez"]}).json()
        assert result["candidates"] == 31 and result["without_text"] == 1 and result["scanned"] == 30
        assert result["matched"] == 3 and len(result["results"]) == 3
        assert "Juan Pérez" in result["results"][0]["excerpts"][0]["text"]
        both = self.post(scan, {"keywords": ["INE", "regalías"], "match": "all"}).json()
        assert both["matched"] == 0


class TestTrackVideos:
    def test_video_append_keeps_existing_videos(self, setup):
        from plane.db.models import MusicLink, MusicTrack

        workspace = setup["workspace"]
        track = MusicTrack.objects.create(workspace=workspace, title="Feliz Navidad")
        old = MusicTrack.objects.create(
            workspace=workspace, parent_track=track, title="Video viejo", kind=MusicTrack.Kind.MUSIC_VIDEO
        )
        response = client_for(setup["admin"]).patch(
            f"/api/workspaces/{workspace.slug}/music/tracks/{track.id}/",
            {"video_append": [{"video_url": "https://youtu.be/nuevo", "release_date": "2024-12-13"}]},
            format="json",
        )
        assert response.status_code == 200, response.content
        videos = MusicTrack.objects.filter(parent_track=track)
        assert videos.count() == 2 and videos.filter(id=old.id).exists()
        assert MusicLink.objects.filter(track__parent_track=track, url="https://youtu.be/nuevo").exists()
