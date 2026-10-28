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
    AssistantMemory,
    AssistantMemoryRevision,
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


    def test_title_shows_mention_names(self, setup):
        slug = setup["workspace"].slug
        client = client_for(setup["admin"])
        chat = client.post(f"/api/workspaces/{slug}/assistant/chats/", {}, format="json").json()
        text = f"Canciones de :tag[3BallMTY]{{name={uuid4()}}} este año"
        client.put(
            f"/api/workspaces/{slug}/assistant/chats/{chat['id']}/messages/",
            {"messages": [{"id": "1", "role": "user", "parts": [{"type": "text", "text": text}]}]},
            format="json",
        )
        assert AssistantChat.objects.get(id=chat["id"]).title == "Canciones de 3BallMTY este año"


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

    def test_contract_tools_are_for_admins_and_the_library_for_members(self, setup):
        admin = self.run_chat(setup, setup["admin"], {})["capabilities"]
        member = self.run_chat(setup, setup["member"], {})["capabilities"]
        assert admin["contracts"] is True and admin["library"] is True
        assert member["contracts"] is False and member["library"] is True

    def test_only_admins_get_tag_admin_tools(self, setup):
        assert self.run_chat(setup, setup["admin"], {})["capabilities"]["tag_admin"] is True
        assert self.run_chat(setup, setup["member"], {})["capabilities"]["tag_admin"] is False

    def test_mentions_are_resolved_as_the_user(self, setup):
        from plane.db.models import FileTag

        item = contract(setup["workspace"], "Contrato editorial 3Ball", "texto")
        tag = FileTag.objects.create(workspace=setup["workspace"], name="3BallMTY")
        text = (
            f"¿Qué tiene :tag[3Ball falso]{{name={tag.id}}} en :contract[X]{{name={item.id}}} "
            f"y :contract[Borrado]{{name={uuid4()}}}?"
        )
        body = {"messages": [{"role": "user", "parts": [{"type": "text", "text": text}]}]}
        payload = self.run_chat(setup, setup["admin"], body)
        mentions = {(row["entity_name"], row["title"]) for row in payload["mentions"]}
        # Names come from the database, never from the message; unknown ids are dropped.
        assert mentions == {("tag", "3BallMTY"), ("contract", "Contrato editorial 3Ball")}
        # Contracts are admin-only: a member's mention never names one
        mentioned = self.run_chat(setup, setup["member"], body)["mentions"]
        member = {(row["entity_name"], row.get("title")) for row in mentioned}
        assert ("contract", "Contrato editorial 3Ball") not in member

    def test_page_context_is_resolved_on_the_server(self, setup):
        item = contract(setup["workspace"], "Contrato editorial 3Ball", "texto")
        context = {"page": "contracts", "items": [{"entity_name": "contract", "id": str(item.id), "title": "X"}]}
        payload = self.run_chat(setup, setup["admin"], {"context": context})
        assert payload["context"]["page"] == "contracts"
        assert payload["context"]["items"][0]["title"] == "Contrato editorial 3Ball"
        assert payload["today"] and payload["user_id"] == str(setup["admin"].id)


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


class TestTagMergeFromAssistant:
    def test_merge_is_recorded_as_a_run_and_undo_puts_it_back(self, setup):
        from plane.db.models import EntityTagLink, FileTag, FileTagLink, TaggingRun

        workspace = setup["workspace"]
        keep = FileTag.objects.create(workspace=workspace, name="3BallMTY", kind=FileTag.Kind.GROUP)
        variant = FileTag.objects.create(workspace=workspace, name="3Ball Mty", kind=FileTag.Kind.CUSTOM)
        item = contract(workspace, "Contrato 3Ball", "")
        FileTagLink.objects.create(workspace=workspace, file_asset=item.file_asset, tag=variant)
        EntityTagLink.objects.create(
            workspace=workspace, tag=variant, entity_type="music_track", entity_id=uuid4()
        )
        url = f"/api/workspaces/{workspace.slug}/shared-tags/merge/"
        body = {"keep_id": str(keep.id), "variant_ids": [str(variant.id)]}

        assert client_for(setup["member"]).post(url, body, format="json").status_code == 403
        response = client_for(setup["admin"]).post(url, body, format="json")
        assert response.status_code == 201, response.content
        run = TaggingRun.objects.get(id=response.json()["id"])
        assert run.status == TaggingRun.Status.COMPLETED and run.scope["source"] == "assistant"
        assert response.json()["counts"]["applied_merges"] == 1
        assert not FileTag.objects.filter(id=variant.id).exists()
        assert FileTagLink.objects.filter(tag=keep, file_asset=item.file_asset).exists()
        assert EntityTagLink.objects.filter(tag=keep, entity_type="music_track").exists()

        undo = client_for(setup["admin"]).post(
            f"/api/workspaces/{workspace.slug}/tagging-runs/{run.id}/", {"action": "undo"}, format="json"
        )
        assert undo.status_code == 200, undo.content
        assert FileTag.objects.filter(id=variant.id).exists()
        assert FileTagLink.objects.filter(tag=variant, file_asset=item.file_asset).exists()
        assert not FileTagLink.objects.filter(tag=keep).exists()
        assert not EntityTagLink.objects.filter(tag=keep).exists()

    def test_rejects_merging_a_tag_into_itself_or_another_workspace(self, setup):
        from plane.db.models import FileTag

        workspace = setup["workspace"]
        keep = FileTag.objects.create(workspace=workspace, name="Shaira")
        other_workspace = WorkspaceFactory(owner=UserFactory(username=f"owner-{uuid4().hex[:8]}"))
        other = FileTag.objects.create(workspace=other_workspace, name="Shiara")
        url = f"/api/workspaces/{workspace.slug}/shared-tags/merge/"
        client = client_for(setup["admin"])
        assert client.post(url, {"keep_id": str(keep.id), "variant_ids": [str(keep.id)]}, format="json").status_code == 404
        assert client.post(url, {"keep_id": str(keep.id), "variant_ids": [str(other.id)]}, format="json").status_code == 404
        assert client.post(url, {"keep_id": str(keep.id), "variant_ids": []}, format="json").status_code == 400
        assert FileTag.objects.filter(id=other.id).exists()


class TestWorkspaceMemory:
    def url(self, setup, memory_id=None):
        base = f"/api/workspaces/{setup['workspace'].slug}/assistant/memories/"
        return f"{base}{memory_id}/" if memory_id else base

    def test_admins_save_members_suggest(self, setup):
        admin, member = client_for(setup["admin"]), client_for(setup["member"])
        saved = admin.post(self.url(setup), {"content": "3BallMTY es la grafía oficial"}, format="json").json()
        suggested = member.post(self.url(setup), {"content": "El sello es Latin Music"}, format="json").json()
        assert saved["status"] == "ACTIVE" and suggested["status"] == "PROPOSED"
        assert member.patch(self.url(setup, saved["id"]), {"pinned": True}, format="json").status_code == 403
        approved = admin.patch(self.url(setup, suggested["id"]), {"status": "ACTIVE"}, format="json").json()
        assert approved["status"] == "ACTIVE" and approved["approved_by"] == str(setup["admin"].id)
        listed = member.get(self.url(setup)).json()
        assert {row["id"] for row in listed["memories"]} == {saved["id"], suggested["id"]}
        assert listed["can_edit"] is False

    def test_correction_supersedes_and_undo_restores(self, setup):
        admin = client_for(setup["admin"])
        old = admin.post(self.url(setup), {"content": "Los editoriales los revisa Ana"}, format="json").json()
        new = admin.post(
            self.url(setup), {"content": "Los editoriales los revisa Luis", "supersedes": old["id"]}, format="json"
        ).json()
        assert AssistantMemory.objects.get(id=old["id"]).status == "ARCHIVED"
        admin.patch(self.url(setup, new["id"]), {"status": "ARCHIVED"}, format="json")
        assert AssistantMemory.objects.get(id=old["id"]).status == "ACTIVE"
        assert AssistantMemoryRevision.objects.filter(memory_id=old["id"], action="restored").exists()

    def test_links_and_markup_are_stripped(self, setup):
        admin = client_for(setup["admin"])
        row = admin.post(
            self.url(setup), {"content": "<b>Ver</b> https://evil.example/x las reglas del sello"}, format="json"
        ).json()
        assert row["content"] == "Ver las reglas del sello"

    def test_turn_context_pins_matches_aliases_and_skips_expired(self, setup):
        from datetime import date, timedelta

        from plane.utils.assistant_memory import memory_context
        from plane.utils.entities import AccessContext

        workspace = setup["workspace"]

        def make(content, **extra):
            return AssistantMemory.objects.create(workspace=workspace, content=content, status="ACTIVE", **extra)

        make("Responde siempre con fechas ISO", pinned=True, kind="RULE")
        make("«El sello» es Latin Music Records", aliases=["el sello", "LMR"], kind="GLOSSARY")
        make("El lanzamiento de Mirala va primero", valid_until=date.today() - timedelta(days=1))
        make("Las regalías editoriales se reparten 50/50")
        ctx = AccessContext.build(workspace.slug, setup["admin"])
        result = memory_context(workspace.id, ctx, "¿Cuántos contratos tiene el sello?", set())
        assert [line["content"] for line in result["pinned"]] == ["Responde siempre con fechas ISO"]
        relevant = [line["content"] for line in result["relevant"]]
        assert relevant[0] == "«El sello» es Latin Music Records"
        assert "El lanzamiento de Mirala va primero" not in relevant
        assert AssistantMemory.objects.get(kind="GLOSSARY").use_count == 1

    def test_chat_payload_carries_memory(self, setup):
        AssistantMemory.objects.create(
            workspace=setup["workspace"], content="3BallMTY es la grafía oficial", status="ACTIVE", pinned=True
        )
        payload = TestChatPayload().run_chat(setup, setup["member"], {})
        assert payload["memory"]["pinned"][0]["content"] == "3BallMTY es la grafía oficial"
        assert payload["capabilities"]["memory_admin"] is False
        assert TestChatPayload().run_chat(setup, setup["admin"], {})["capabilities"]["memory_admin"] is True
