"""Contracts are for workspace admins only: every contracts URL turns members
and guests away, the library hides contract files (and the "Contratos"
category) from them, and mentions, tags and the assistant follow suit."""

import re
from uuid import uuid4

import pytest
from django.urls import URLPattern, URLResolver, get_resolver
from rest_framework.test import APIClient

from plane.db.models import Contract, FileAsset, FileCategory, FileCategoryLink, WorkspaceFeature
from plane.tests.factories import UserFactory, WorkspaceFactory, WorkspaceMemberFactory
from plane.utils import assistant_files, assistant_templates
from plane.utils.entities import REGISTRY, AccessContext

pytestmark = [pytest.mark.unit, pytest.mark.django_db]

CONTRACT_VIEW_MODULES = (
    "plane.app.views.contract.base",
    "plane.app.views.contract.chat",
    "plane.app.views.contract.works",
    "plane.app.views.contract.workflow",
    "plane.app.views.contract.template_drafts",
    "plane.app.views.assistant.templates",
)
METHODS = ("get", "post", "patch", "put", "delete")


@pytest.fixture
def setup():
    workspace = WorkspaceFactory()
    WorkspaceFeature.objects.create(workspace=workspace, key="file_library", is_enabled=True)
    admin = workspace.owner
    WorkspaceMemberFactory(workspace=workspace, member=admin, role=20)
    member = UserFactory(username=f"member-{uuid4().hex[:8]}")
    WorkspaceMemberFactory(workspace=workspace, member=member, role=15)
    guest = UserFactory(username=f"guest-{uuid4().hex[:8]}")
    WorkspaceMemberFactory(workspace=workspace, member=guest, role=5)
    contracts_category = FileCategory.objects.create(workspace=workspace, name="Contratos", is_default=True)
    return {
        "workspace": workspace,
        "admin": admin,
        "member": member,
        "guest": guest,
        "contracts_category": contracts_category,
    }


def client_for(user):
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def library_file(setup, name):
    return FileAsset.objects.create(
        workspace=setup["workspace"],
        asset=f"{setup['workspace'].id}/{uuid4().hex}.pdf",
        attributes={"name": name, "type": "application/pdf", "size": 10},
        size=10,
        entity_type=FileAsset.EntityTypeContext.WORKSPACE_FILE_LIBRARY,
        is_uploaded=True,
    )


def files(setup):
    """A plain PDF, an analyzed contract and a file only in "Contratos"."""
    plain = library_file(setup, "factura.pdf")
    analyzed = library_file(setup, "contrato.pdf")
    Contract.objects.create(workspace=setup["workspace"], file_asset=analyzed, titulo="Contrato editorial")
    categorized = library_file(setup, "pendiente.pdf")
    FileCategoryLink.objects.create(
        workspace=setup["workspace"], file_asset=categorized, category=setup["contracts_category"]
    )
    return plain, analyzed, categorized


def _contract_urls():
    """Every routed contracts URL as (path, view class), ids filled in."""
    found = []

    def walk(patterns, prefix):
        for entry in patterns:
            if isinstance(entry, URLResolver):
                walk(entry.url_patterns, prefix + str(entry.pattern))
            elif isinstance(entry, URLPattern):
                view = getattr(entry.callback, "view_class", None) or getattr(entry.callback, "cls", None)
                if view is None or view.__module__ not in CONTRACT_VIEW_MODULES:
                    continue
                if view.__name__.startswith(("Internal", "Documenso")):
                    continue
                found.append((prefix + str(entry.pattern), view))

    walk(get_resolver().url_patterns, "/")
    return found


def _fill(path, slug):
    def value(match):
        return slug if match.group(1) == "slug" else str(uuid4())

    return re.sub(r"<(?:\w+:)?(\w+)>", value, path).replace("^", "").replace("$", "")


def test_every_contracts_url_is_admin_only(setup):
    urls = _contract_urls()
    # The sweep must actually find the module's views
    assert len(urls) > 40
    slug = setup["workspace"].slug
    for role in ("member", "guest"):
        client = client_for(setup[role])
        for path, view in urls:
            url = _fill(path, slug)
            for method in METHODS:
                if not hasattr(view, method):
                    continue
                response = getattr(client, method)(url, {}, format="json")
                assert response.status_code == 403, f"{role} {method.upper()} {url} -> {response.status_code}"


def test_admins_still_reach_the_contracts_list(setup):
    response = client_for(setup["admin"]).get(f"/api/workspaces/{setup['workspace'].slug}/contracts/")
    assert response.status_code == 200


def test_the_library_hides_contract_files_from_members(setup):
    plain, analyzed, categorized = files(setup)
    url = f"/api/workspaces/{setup['workspace'].slug}/file-library/files/"
    member_ids = {row["id"] for row in client_for(setup["member"]).get(url).json()}
    admin_ids = {row["id"] for row in client_for(setup["admin"]).get(url).json()}
    assert member_ids == {str(plain.id)}
    assert admin_ids == {str(plain.id), str(analyzed.id), str(categorized.id)}


def test_members_cannot_open_or_change_a_contract_file(setup):
    _, analyzed, _ = files(setup)
    slug = setup["workspace"].slug
    member = client_for(setup["member"])
    download = member.get(f"/api/workspaces/{slug}/file-library/files/{analyzed.id}/download/?response=json")
    assert download.status_code == 404
    rename = member.patch(f"/api/workspaces/{slug}/file-library/files/{analyzed.id}/", {"name": "x.pdf"})
    assert rename.status_code == 404
    contract_scope = member.get(
        f"/api/workspaces/{slug}/file-library/files/{analyzed.id}/download/?scope=contract&response=json"
    )
    assert contract_scope.status_code == 403


def test_members_never_see_or_use_the_contracts_category(setup):
    plain, _, categorized = files(setup)
    slug = setup["workspace"].slug
    member = client_for(setup["member"])
    names = {row["name"] for row in member.get(f"/api/workspaces/{slug}/file-categories/").json()}
    assert "Contratos" not in names
    link = member.post(
        f"/api/workspaces/{slug}/file-library/files/{plain.id}/categories/",
        {"category_ids": [str(setup["contracts_category"].id)]},
        format="json",
    )
    assert link.status_code == 400
    assert not Contract.objects.filter(file_asset=plain).exists()


def test_mentions_and_tags_treat_contracts_as_admin_only(setup):
    plain, analyzed, categorized = files(setup)
    slug = setup["workspace"].slug
    member_ctx = AccessContext.build(slug, setup["member"])
    admin_ctx = AccessContext.build(slug, setup["admin"])
    assert not REGISTRY["contract"].allows(member_ctx)
    assert REGISTRY["contract"].allows(admin_ctx)
    member_files = set(REGISTRY["file"].visible(member_ctx).values_list("id", flat=True))
    assert member_files == {plain.id}
    admin_files = set(REGISTRY["file"].visible(admin_ctx).values_list("id", flat=True))
    assert admin_files == {plain.id, analyzed.id, categorized.id}


def test_the_assistant_keeps_contracts_from_members(setup):
    plain, _, _ = files(setup)
    slug = setup["workspace"].slug
    member_ctx = AccessContext.build(slug, setup["member"])
    admin_ctx = AccessContext.build(slug, setup["admin"])
    assert set(assistant_files._files(member_ctx).values_list("id", flat=True)) == {plain.id}
    assert assistant_files._files(admin_ctx).count() == 3
    assert not assistant_templates.can_edit(member_ctx)
    assert assistant_templates.can_edit(admin_ctx)
    # Organizing stays with members, but never into "Contratos"
    checked = assistant_files.plan(
        member_ctx, [{"op": "categorize", "file_id": str(plain.id), "category": "Contratos"}]
    )
    assert checked["problems"]
