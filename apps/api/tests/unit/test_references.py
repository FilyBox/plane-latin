"""Cross-module references and shared tags: who sees what, mentions that
follow the saved HTML, tags kept in each module's own store, and a backfill
that only ever inserts."""

from datetime import date
from decimal import Decimal
from io import StringIO
from unittest.mock import patch
from uuid import uuid4

import pytest
from django.core.management import call_command
from rest_framework.test import APIClient

from plane.db.models import (
    Contract,
    EntityReference,
    EntityTagLink,
    Expense,
    ExpenseCategory,
    FileAsset,
    FileTag,
    FileTagLink,
    Issue,
    MusicCredit,
    MusicParty,
    MusicTrack,
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
from plane.utils.entities import AccessContext, resolve_entities, search_entities
from plane.utils.references import backlinks, extract_mentions, outgoing, sync_mentions
from plane.utils.shared_tags import entities_for_tag, get_tags, set_tags, tagged_ids

pytestmark = [pytest.mark.unit, pytest.mark.django_db]

FEATURES = ("file_library", "music_catalog", "payments", "references")


def enable(workspace, *keys):
    for key in keys:
        WorkspaceFeature.objects.create(workspace=workspace, key=key, is_enabled=True)


def mention(name, identifier):
    return (
        f'<mention-component id="{uuid4()}" entity_name="{name}" entity_identifier="{identifier}"></mention-component>'
    )


def library_file(workspace, name="portada.png"):
    return FileAsset.objects.create(
        workspace=workspace,
        asset=f"{workspace.id}/{uuid4().hex}-{name}",
        attributes={"name": name, "type": "image/png", "size": 10},
        entity_type=FileAsset.EntityTypeContext.WORKSPACE_FILE_LIBRARY,
        is_uploaded=True,
    )


@pytest.fixture
def setup():
    workspace = WorkspaceFactory()
    enable(workspace, *FEATURES)
    admin = workspace.owner
    WorkspaceMemberFactory(workspace=workspace, member=admin, role=20)
    member = UserFactory(username=f"member-{uuid4().hex[:8]}")
    WorkspaceMemberFactory(workspace=workspace, member=member, role=15)
    project = ProjectFactory(workspace=workspace)
    for user, role in ((admin, 20), (member, 15)):
        ProjectMemberFactory(project=project, member=user, role=role)
    state = State.objects.create(name="Todo", project=project, workspace=workspace, group="unstarted")
    issue = Issue.objects.create(name="Lanzamiento", project=project, workspace=workspace, state=state)
    track = MusicTrack.objects.create(workspace=workspace, title="Canción")
    asset = library_file(workspace, "contrato.pdf")
    contract = Contract.objects.create(workspace=workspace, file_asset=asset, titulo="Contrato editorial")
    return {
        "workspace": workspace,
        "admin": admin,
        "member": member,
        "issue": issue,
        "track": track,
        "asset": asset,
        "contract": contract,
    }


def ctx_for(setup, user):
    return AccessContext.build(setup["workspace"].slug, user)


class TestRegistryAccess:
    def test_contracts_and_music_are_restricted_for_members(self, setup):
        items = [
            {"entity_name": "contract", "id": str(setup["contract"].id)},
            {"entity_name": "music_track", "id": str(setup["track"].id)},
            {"entity_name": "music_track", "id": str(uuid4())},
        ]
        cards = resolve_entities(ctx_for(setup, setup["member"]), items)
        # Contracts and music are admin-only: they exist, but their names are not revealed.
        assert cards[0] == {"entity_name": "contract", "id": str(setup["contract"].id), "status": "restricted"}
        assert cards[1] == {"entity_name": "music_track", "id": str(setup["track"].id), "status": "restricted"}
        assert cards[2]["status"] == "missing"
        admin_cards = resolve_entities(ctx_for(setup, setup["admin"]), items)
        assert admin_cards[0]["status"] == "ok" and admin_cards[0]["title"] == "Contrato editorial"

    def test_a_disabled_module_hides_everything_in_it(self, setup):
        WorkspaceFeature.objects.filter(workspace=setup["workspace"], key="music_catalog").delete()
        ctx = ctx_for(setup, setup["admin"])
        assert "music_track" not in search_entities(ctx, "Can")
        card = resolve_entities(ctx, [{"entity_name": "music_track", "id": str(setup["track"].id)}])[0]
        assert card["status"] == "restricted"

    def test_payroll_is_not_referenceable(self, setup):
        assert extract_mentions(mention("employee", uuid4())) == set()
        assert "employee" not in search_entities(ctx_for(setup, setup["admin"]), "")


class TestMentionSync:
    def test_follows_the_html_without_touching_it(self, setup):
        issue = setup["issue"]
        html = f"<p>Ver {mention('contract', setup['contract'].id)} y {mention('music_track', setup['track'].id)}</p>"
        first = sync_mentions(setup["workspace"].id, "issue", issue.id, html)
        again = sync_mentions(setup["workspace"].id, "issue", issue.id, html)
        assert first == {"added": 2, "removed": 0} and again == {"added": 0, "removed": 0}

        sync_mentions(setup["workspace"].id, "issue", issue.id, f"<p>{mention('contract', setup['contract'].id)}</p>")
        live = EntityReference.objects.filter(source_id=issue.id)
        assert list(live.values_list("target_type", flat=True)) == ["contract"]
        # The removed one is soft-deleted, and comes back if re-mentioned.
        assert EntityReference.all_objects.filter(source_id=issue.id, deleted_at__isnull=False).count() == 1
        sync_mentions(setup["workspace"].id, "issue", issue.id, html)
        assert EntityReference.objects.filter(source_id=issue.id).count() == 2

    def test_backlinks_respect_who_is_asking(self, setup):
        sync_mentions(setup["workspace"].id, "issue", setup["issue"].id, mention("contract", setup["contract"].id))
        links = backlinks(ctx_for(setup, setup["member"]), "contract", str(setup["contract"].id))
        assert [(link["entity_name"], link["id"], link["status"]) for link in links] == [
            ("issue", str(setup["issue"].id), "ok")
        ]
        out = outgoing(ctx_for(setup, setup["member"]), "issue", str(setup["issue"].id))
        assert out[0]["kinds"] == ["mention"]

    def test_saving_a_mention_queues_the_sync(self, setup, django_capture_on_commit_callbacks):
        with patch("plane.bgtasks.reference_task.sync_entity_mentions.delay") as delay:
            with django_capture_on_commit_callbacks(execute=True):
                issue = setup["issue"]
                issue.description_html = f"<p>{mention('contract', setup['contract'].id)}</p>"
                issue.save()
        delay.assert_called_once_with("issue", str(setup["issue"].id))

    def test_plain_saves_do_not_queue_anything(self, setup, django_capture_on_commit_callbacks):
        with patch("plane.bgtasks.reference_task.sync_entity_mentions.delay") as delay:
            with django_capture_on_commit_callbacks(execute=True):
                issue = setup["issue"]
                issue.name = "Renombrado"
                issue.save()
        delay.assert_not_called()


class TestSharedTags:
    def test_files_and_contracts_keep_using_file_tag_links(self, setup):
        workspace = setup["workspace"]
        tag = FileTag.objects.create(workspace=workspace, name="Bad Bunny", kind=FileTag.Kind.ARTIST)
        set_tags(workspace.id, "contract", setup["contract"].id, [tag.id])
        # Stored on the contract's PDF, where the library and the AI read it.
        assert FileTagLink.objects.filter(file_asset=setup["asset"], tag=tag).exists()
        assert not EntityTagLink.objects.filter(tag=tag).exists()
        assert get_tags(workspace.id, "file", [setup["asset"].id])[str(setup["asset"].id)][0]["name"] == "Bad Bunny"

    def test_expense_tags_mirror_into_the_old_field_keeping_the_category(self, setup):
        workspace = setup["workspace"]
        category = ExpenseCategory.objects.create(workspace=workspace, name="Renta")
        expense = Expense.objects.create(
            workspace=workspace,
            concept="Oficina",
            amount=Decimal("100"),
            currency="MXN",
            expense_date=date(2026, 1, 5),
            category=category,
            tags=["Renta"],
        )
        tag = FileTag.objects.create(workspace=workspace, name="Gira 2026")
        set_tags(workspace.id, "expense", expense.id, [tag.id])
        expense.refresh_from_db()
        assert expense.tags == ["Renta", "Gira 2026"]

    def test_songs_credited_to_an_artist_count_under_their_tag(self, setup):
        workspace = setup["workspace"]
        party = MusicParty.objects.create(workspace=workspace, display_name="Bad Bunny")
        MusicCredit.objects.create(workspace=workspace, track=setup["track"], party=party, role="MAIN_ARTIST")
        tag = FileTag.objects.create(workspace=workspace, name="Bad Bunny", kind=FileTag.Kind.ARTIST, party=party)
        assert tagged_ids(workspace.id, tag, "music_track") == [str(setup["track"].id)]
        # A member can't open music, so the hub leaves it out for them.
        assert "music_track" in entities_for_tag(ctx_for(setup, setup["admin"]), tag)
        assert "music_track" not in entities_for_tag(ctx_for(setup, setup["member"]), tag)


class TestBackfill:
    def test_inserts_only_and_is_repeatable(self, setup):
        workspace = setup["workspace"]
        party = MusicParty.objects.create(workspace=workspace, display_name="Grupo X", kind=MusicParty.Kind.GROUP)
        expense = Expense.objects.create(
            workspace=workspace,
            concept="Viáticos",
            amount=Decimal("50"),
            currency="MXN",
            expense_date=date(2026, 2, 1),
        )
        # Written before shared tags existed: no signal ran for it.
        Expense.objects.filter(id=expense.id).update(tags=["gira"])
        setup["issue"].description_html = mention("contract", setup["contract"].id)
        Issue.objects.filter(id=setup["issue"].id).update(description_html=setup["issue"].description_html)

        out = StringIO()
        call_command("link_shared_tags", "--dry-run", stdout=out)
        assert not FileTag.objects.filter(workspace=workspace).exists()

        call_command("link_shared_tags", stdout=StringIO())
        call_command("link_shared_tags", stdout=StringIO())
        assert FileTag.objects.get(workspace=workspace, party=party).kind == FileTag.Kind.GROUP
        assert EntityTagLink.objects.filter(entity_type="expense", entity_id=expense.id).count() == 1
        assert EntityReference.objects.filter(source_id=setup["issue"].id).count() == 1
        expense.refresh_from_db()
        assert expense.tags == ["gira"]


class TestEndpoints:
    def client_for(self, user):
        client = APIClient()
        client.force_authenticate(user=user)
        return client

    def test_needs_the_feature_flag(self, setup):
        WorkspaceFeature.objects.filter(workspace=setup["workspace"], key="references").delete()
        response = self.client_for(setup["admin"]).get(f"/api/workspaces/{setup['workspace'].slug}/entities/search/")
        assert response.status_code == 403

    def test_attach_then_read_both_directions(self, setup):
        slug, client = setup["workspace"].slug, self.client_for(setup["admin"])
        search = client.get(f"/api/workspaces/{slug}/entities/search/", {"q": "editorial", "types": "contract"})
        assert search.status_code == 200
        assert search.json()["results"]["contract"][0]["id"] == str(setup["contract"].id)

        attach = client.post(
            f"/api/workspaces/{slug}/entities/issue/{setup['issue'].id}/references/",
            {"entity_name": "contract", "id": str(setup["contract"].id)},
            format="json",
        )
        assert attach.status_code == 201 and attach.json()[0]["kinds"] == ["attachment"]

        back = client.get(f"/api/workspaces/{slug}/entities/contract/{setup['contract'].id}/references/")
        assert back.json()["backlinks"][0]["id"] == str(setup["issue"].id)

        removed = client.delete(
            f"/api/workspaces/{slug}/entities/issue/{setup['issue'].id}/references/contract/{setup['contract'].id}/"
        )
        assert removed.status_code == 204
        assert not EntityReference.objects.filter(source_id=setup["issue"].id).exists()
        assert Contract.objects.filter(id=setup["contract"].id).exists()

    def test_members_neither_find_nor_attach_contracts(self, setup):
        slug, client = setup["workspace"].slug, self.client_for(setup["member"])
        search = client.get(f"/api/workspaces/{slug}/entities/search/", {"q": "editorial", "types": "contract"})
        assert "contract" not in search.json()["results"]
        attach = client.post(
            f"/api/workspaces/{slug}/entities/issue/{setup['issue'].id}/references/",
            {"entity_name": "contract", "id": str(setup["contract"].id)},
            format="json",
        )
        assert attach.status_code == 404

    def test_members_cannot_attach_what_they_cannot_open(self, setup):
        response = self.client_for(setup["member"]).post(
            f"/api/workspaces/{setup['workspace'].slug}/entities/issue/{setup['issue'].id}/references/",
            {"entity_name": "music_track", "id": str(setup["track"].id)},
            format="json",
        )
        assert response.status_code == 404


class TestTaggingRun:
    def test_apply_then_undo_puts_everything_back(self, setup):
        from plane.db.models import TaggingRun
        from plane.utils.tagging import apply_run, undo_run

        workspace, issue, asset = setup["workspace"], setup["issue"], setup["asset"]
        cover = library_file(workspace, "portada.png")
        old_issue = Issue.objects.create(name="Otra", project=issue.project, workspace=workspace, state=issue.state)
        keep = FileTag.objects.create(workspace=workspace, name="Shaira", kind=FileTag.Kind.ARTIST)
        variant = FileTag.objects.create(workspace=workspace, name="Shiara", kind=FileTag.Kind.ARTIST)
        FileTagLink.objects.create(workspace=workspace, file_asset=cover, tag=variant)
        EntityTagLink.objects.create(workspace=workspace, tag=variant, entity_type="issue", entity_id=issue.id)
        # Removed by hand long before the run: undo must not bring it back.
        removed = EntityTagLink.objects.create(
            workspace=workspace, tag=variant, entity_type="issue", entity_id=old_issue.id
        )
        removed.delete()

        def snapshot():
            return (
                sorted(FileTag.objects.filter(workspace=workspace).values_list("name", flat=True)),
                sorted(FileTagLink.objects.filter(workspace=workspace).values_list("file_asset_id", "tag_id")),
                sorted(EntityTagLink.objects.filter(workspace=workspace).values_list("entity_id", "tag_id")),
            )

        before = snapshot()
        run = TaggingRun.objects.create(workspace=workspace, status=TaggingRun.Status.REVIEW)
        approved = {
            "merges": [{"keep": "Shaira", "variants": ["Shiara"]}],
            "tags": [
                {
                    "name": "Contrato editorial",
                    "kind": "TYPE",
                    "items": [{"entity_name": "contract", "id": str(setup["contract"].id)}],
                },
                {"name": "Shaira", "kind": "ARTIST", "items": [{"entity_name": "file", "id": str(asset.id)}]},
            ],
        }
        apply_run(run, ctx_for(setup, setup["admin"]), approved, setup["admin"].id)

        assert not FileTag.objects.filter(id=variant.id).exists()
        assert FileTagLink.objects.filter(tag=keep, file_asset__in=[cover, asset]).count() == 2
        assert EntityTagLink.objects.filter(tag=keep, entity_id=issue.id).exists()
        assert FileTagLink.objects.filter(tag__name="Contrato editorial", file_asset=asset).exists()

        undo_run(run)
        run.refresh_from_db()
        assert run.status == TaggingRun.Status.UNDONE
        assert snapshot() == before
        assert not EntityTagLink.objects.filter(id=removed.id).exists()


class TestFileLibraryTagsAreShared:
    """Renaming, merging or deleting a tag from Archivos reaches every module."""

    def client(self, setup):
        client = APIClient()
        client.force_authenticate(user=setup["admin"])
        return client

    def expense(self, setup, names):
        expense = Expense.objects.create(
            workspace=setup["workspace"],
            concept="Viáticos",
            amount=Decimal("50"),
            currency="MXN",
            expense_date=date(2026, 2, 1),
            tags=names,
        )
        expense.refresh_from_db()
        return expense

    def test_merge_carries_work_items_songs_and_expenses(self, setup):
        workspace, issue = setup["workspace"], setup["issue"]
        party = MusicParty.objects.create(workspace=workspace, display_name="3Ball Mty", kind=MusicParty.Kind.GROUP)
        MusicCredit.objects.create(workspace=workspace, track=setup["track"], party=party, role="primary")
        keep = FileTag.objects.create(workspace=workspace, name="3BallMTY", kind=FileTag.Kind.CUSTOM)
        source = FileTag.objects.create(workspace=workspace, name="3Ball Mty", kind=FileTag.Kind.GROUP, party=party)
        FileTagLink.objects.create(workspace=workspace, file_asset=setup["asset"], tag=source)
        EntityTagLink.objects.create(workspace=workspace, tag=source, entity_type="issue", entity_id=issue.id)
        expense = self.expense(setup, ["3Ball Mty"])

        response = self.client(setup).post(
            f"/api/workspaces/{workspace.slug}/file-tags/{source.id}/merge/",
            {"into_tag_id": str(keep.id)},
            format="json",
        )
        assert response.status_code == 200
        keep.refresh_from_db()
        assert keep.kind == FileTag.Kind.GROUP and keep.party_id == party.id
        assert FileTagLink.objects.filter(tag=keep, file_asset=setup["asset"]).exists()
        assert EntityTagLink.objects.filter(tag=keep, entity_type="issue", entity_id=issue.id).exists()
        assert str(setup["track"].id) in tagged_ids(workspace.id, keep, "music_track")
        expense.refresh_from_db()
        assert expense.tags == ["3BallMTY"]
        assert not FileTag.objects.filter(id=source.id).exists()

    def test_delete_unlinks_everywhere_and_keeps_the_things(self, setup):
        workspace, issue = setup["workspace"], setup["issue"]
        tag = FileTag.objects.create(workspace=workspace, name="gira")
        FileTagLink.objects.create(workspace=workspace, file_asset=setup["asset"], tag=tag)
        EntityTagLink.objects.create(workspace=workspace, tag=tag, entity_type="issue", entity_id=issue.id)
        expense = self.expense(setup, ["gira"])

        response = self.client(setup).delete(f"/api/workspaces/{workspace.slug}/file-tags/{tag.id}/")
        assert response.status_code == 204
        assert not EntityTagLink.objects.filter(tag=tag).exists()
        assert not FileTagLink.objects.filter(tag=tag).exists()
        expense.refresh_from_db()
        assert expense.tags == []
        # Saving the expense again must not bring the tag back.
        expense.save()
        assert not FileTag.objects.filter(workspace=workspace, name__iexact="gira").exists()
        assert Issue.objects.filter(id=issue.id).exists() and FileAsset.objects.filter(id=setup["asset"].id).exists()

    def test_rename_updates_the_name_expenses_keep(self, setup):
        workspace = setup["workspace"]
        expense = self.expense(setup, ["gira"])
        tag = FileTag.objects.get(workspace=workspace, name="gira")
        response = self.client(setup).patch(
            f"/api/workspaces/{workspace.slug}/file-tags/{tag.id}/", {"name": "Gira 2026"}, format="json"
        )
        assert response.status_code == 200
        expense.refresh_from_db()
        assert expense.tags == ["Gira 2026"]
        expense.save()
        assert not FileTag.objects.filter(workspace=workspace, name="gira").exists()


class TestBrowsingATag:
    def test_search_dates_years_and_pages(self, setup):
        from plane.db.models import MusicRelease, MusicReleaseTrack
        from plane.utils.shared_tags import entities_for_tag, tag_years

        workspace = setup["workspace"]
        tag = FileTag.objects.create(workspace=workspace, name="3BallMTY", kind=FileTag.Kind.GROUP)
        tracks = [MusicTrack.objects.create(workspace=workspace, title=f"Canción {index}") for index in range(5)]
        navidad = MusicTrack.objects.create(workspace=workspace, title="Feliz Navidad")
        old = MusicRelease.objects.create(workspace=workspace, title="Viejo", release_date=date(2018, 5, 1))
        new = MusicRelease.objects.create(workspace=workspace, title="Nuevo", release_date=date(2024, 12, 13))
        MusicReleaseTrack.objects.create(workspace=workspace, release=new, track=navidad)
        MusicReleaseTrack.objects.create(workspace=workspace, release=old, track=tracks[0])
        for item in [*tracks, navidad]:
            EntityTagLink.objects.create(workspace=workspace, tag=tag, entity_type="music_track", entity_id=item.id)
        for release in (old, new):
            EntityTagLink.objects.create(
                workspace=workspace, tag=tag, entity_type="music_release", entity_id=release.id
            )
        ctx = ctx_for(setup, setup["admin"])

        found = entities_for_tag(ctx, tag, query="navidad")
        assert [card["title"] for card in found["music_track"]["items"]] == ["Feliz Navidad"]
        # A song takes its release's date.
        assert found["music_track"]["items"][0]["date"] == "2024-12-13"

        year = entities_for_tag(ctx, tag, date_from=date(2024, 1, 1), date_to=date(2024, 12, 31))
        assert year["music_release"]["count"] == 1 and year["music_track"]["count"] == 1
        assert tag_years(ctx, tag) == [2024, 2018]

        first = entities_for_tag(ctx, tag, types=["music_track"], limit_per_type=4)
        rest = entities_for_tag(ctx, tag, types=["music_track"], offset=4, limit_per_type=4)
        assert first["music_track"]["count"] == 6 and len(first["music_track"]["items"]) == 4
        seen = {card["id"] for card in first["music_track"]["items"] + rest["music_track"]["items"]}
        assert len(seen) == 6
        # Newest first, undated last.
        assert first["music_track"]["items"][0]["title"] == "Feliz Navidad"

    def test_bad_dates_are_rejected(self, setup):
        workspace = setup["workspace"]
        tag = FileTag.objects.create(workspace=workspace, name="gira")
        client = APIClient()
        client.force_authenticate(user=setup["admin"])
        response = client.get(f"/api/workspaces/{workspace.slug}/shared-tags/{tag.id}/entities/?date_from=2024-13-01")
        assert response.status_code == 400
        response = client.get(
            f"/api/workspaces/{workspace.slug}/shared-tags/{tag.id}/entities/?q=x&date_from=2024-01-01"
        )
        assert response.status_code == 200 and "years" in response.json()


class TestWorkItemSharedTagFilter:
    def test_project_list_filters_by_workspace_tag(self, setup):
        import json

        workspace, issue = setup["workspace"], setup["issue"]
        other = Issue.objects.create(name="Otra", project=issue.project, workspace=workspace, state=issue.state)
        tag = FileTag.objects.create(workspace=workspace, name="3BallMTY", kind=FileTag.Kind.GROUP)
        set_tags(workspace.id, "issue", issue.id, [tag.id])
        client = APIClient()
        client.force_authenticate(user=setup["admin"])
        response = client.get(
            f"/api/workspaces/{workspace.slug}/projects/{issue.project_id}/issues/",
            {"filters": json.dumps({"shared_tag_id__in": str(tag.id)})},
        )
        assert response.status_code == 200, response.content
        ids = {row["id"] for row in response.json()["results"]}
        assert str(issue.id) in ids and str(other.id) not in ids


class TestAssistantLookups:
    """The assistant's cross-module lookups answer as the asking user."""

    def get(self, path, **params):
        from django.test import override_settings

        with override_settings(PLANE_INTERNAL_API_SECRET="test-secret"):
            return APIClient().get(path, params, HTTP_X_PLANE_INTERNAL_KEY="test-secret")

    def test_find_by_tag_respects_the_users_role(self, setup):
        workspace = setup["workspace"]
        tag = FileTag.objects.create(workspace=workspace, name="3BallMTY", kind=FileTag.Kind.GROUP)
        set_tags(workspace.id, "contract", setup["contract"].id, [tag.id])
        set_tags(workspace.id, "music_track", setup["track"].id, [tag.id])
        base = f"/api/internal/workspaces/{workspace.id}/assistant"

        tags = self.get(f"{base}/tags/", q="3ball", user_id=str(setup["admin"].id))
        assert tags.status_code == 200 and tags.json()["results"][0]["name"] == "3BallMTY"

        admin = self.get(f"{base}/tagged/", tag="3ballmty", user_id=str(setup["admin"].id)).json()
        assert set(admin["groups"]) == {"contract", "music_track"}
        member = self.get(f"{base}/tagged/", tag="3BallMTY", user_id=str(setup["member"].id)).json()
        # Contracts and the music catalog are admin-only: the assistant must not name them.
        assert set(member["groups"]) == set()

        found = self.get(f"{base}/search/", q="Canción", user_id=str(setup["member"].id)).json()
        assert "music_track" not in found["results"]

    def test_needs_the_key_a_member_and_the_flag(self, setup):
        workspace = setup["workspace"]
        base = f"/api/internal/workspaces/{workspace.id}/assistant"
        assert APIClient().get(f"{base}/tags/", {"user_id": str(setup["admin"].id)}).status_code in (401, 403)
        assert self.get(f"{base}/tags/").status_code == 403
        WorkspaceFeature.objects.filter(workspace=workspace, key="references").update(is_enabled=False)
        assert self.get(f"{base}/tags/", user_id=str(setup["admin"].id)).status_code == 403

    def test_references_of_an_item(self, setup):
        workspace, issue = setup["workspace"], setup["issue"]
        sync_mentions(workspace.id, "issue", issue.id, mention("contract", setup["contract"].id), setup["admin"].id)
        base = f"/api/internal/workspaces/{workspace.id}/assistant"
        data = self.get(f"{base}/references/contract/{setup['contract'].id}/", user_id=str(setup["admin"].id)).json()
        assert [card["id"] for card in data["referenced_by"]] == [str(issue.id)]
        # A member cannot open the contract, so its references stay hidden too
        hidden = self.get(f"{base}/references/contract/{setup['contract'].id}/", user_id=str(setup["member"].id))
        assert "referenced_by" not in hidden.json()


class TestAutoClassifyUploads:
    def test_new_uploads_start_one_review_run(self, setup):
        from plane.bgtasks.reference_task import auto_classify_new_files
        from plane.db.models import TaggingRun

        workspace = setup["workspace"]
        cover = library_file(workspace, "portada.png")
        tagged = library_file(workspace, "ya-etiquetado.png")
        FileTagLink.objects.create(
            workspace=workspace, file_asset=tagged, tag=FileTag.objects.create(workspace=workspace, name="x")
        )
        with patch("plane.utils.worker_client.trigger_tagging_run", return_value="instance-1") as trigger:
            auto_classify_new_files(str(workspace.id))
        run = TaggingRun.objects.get(workspace=workspace)
        # Only the new, untagged, non-contract file; contracts have their own analysis.
        assert run.scope["ids"] == [str(cover.id)] and run.scope["auto"] is True
        assert run.status == TaggingRun.Status.RUNNING
        trigger.assert_called_once()

        # Nothing new since: no second run.
        with patch("plane.utils.worker_client.trigger_tagging_run") as trigger:
            auto_classify_new_files(str(workspace.id))
        trigger.assert_not_called()

    def test_inventory_reads_only_the_runs_files(self, setup):
        from plane.utils.tagging import inventory

        workspace = setup["workspace"]
        library_file(workspace, "a.png")
        second = library_file(workspace, "b.png")
        page = inventory(workspace.id, "file", ids=[str(second.id)])
        assert [item["id"] for item in page["results"]] == [str(second.id)]
        assert inventory(workspace.id, "file")["total"] == 2  # contract PDF excluded

    def test_off_without_the_flags(self, setup):
        from plane.bgtasks.reference_task import auto_classify_new_files
        from plane.db.models import TaggingRun

        workspace = setup["workspace"]
        library_file(workspace, "portada.png")
        WorkspaceFeature.objects.filter(workspace=workspace, key="references").update(is_enabled=False)
        with patch("plane.utils.worker_client.trigger_tagging_run") as trigger:
            auto_classify_new_files(str(workspace.id))
        trigger.assert_not_called()
        assert not TaggingRun.objects.filter(workspace=workspace).exists()


class TestBulkTagging:
    def test_add_and_remove_a_tag_on_selected_songs(self, setup):
        workspace = setup["workspace"]
        songs = [setup["track"], *[MusicTrack.objects.create(workspace=workspace, title=f"S{i}") for i in range(3)]]
        tag = FileTag.objects.create(workspace=workspace, name="Gira 2026")
        set_tags(workspace.id, "music_track", songs[0].id, [tag.id])
        client = APIClient()
        client.force_authenticate(user=setup["admin"])
        url = f"/api/workspaces/{workspace.slug}/shared-tags/{tag.id}/apply/"
        ids = [str(song.id) for song in songs] + [str(uuid4()), "not-a-uuid"]

        added = client.post(url, {"entity_name": "music_track", "ids": ids}, format="json").json()
        assert added["changed"] == 3 and added["matched"] == 4 and added["skipped"] == 2
        assert set(tagged_ids(workspace.id, tag, "music_track")) == {str(song.id) for song in songs}

        removed = client.post(url, {"entity_name": "music_track", "ids": ids[:2], "action": "remove"}, format="json")
        assert removed.json()["changed"] == 2
        assert len(tagged_ids(workspace.id, tag, "music_track")) == 2

    def test_contracts_use_their_pdf_and_members_cannot_tag_them_or_music(self, setup):
        workspace = setup["workspace"]
        tag = FileTag.objects.create(workspace=workspace, name="Editorial")
        admin, member = APIClient(), APIClient()
        admin.force_authenticate(user=setup["admin"])
        member.force_authenticate(user=setup["member"])
        url = f"/api/workspaces/{workspace.slug}/shared-tags/{tag.id}/apply/"
        response = admin.post(url, {"entity_name": "contract", "ids": [str(setup["contract"].id)]}, format="json")
        assert response.json()["changed"] == 1
        assert FileTagLink.objects.filter(file_asset=setup["asset"], tag=tag).exists()
        contract = member.post(url, {"entity_name": "contract", "ids": [str(setup["contract"].id)]}, format="json")
        assert contract.status_code == 403
        music = member.post(url, {"entity_name": "music_track", "ids": [str(setup["track"].id)]}, format="json")
        assert music.status_code == 403
