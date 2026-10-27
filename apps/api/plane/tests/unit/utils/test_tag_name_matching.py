# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""A name already used by a tag, written with other case, spaces, accents or
punctuation, reuses that tag instead of creating a second one: "3ball Mty"
from one contract and the group "3BallMTY" from another are one tag."""

import pytest

from plane.db.models import Contract, FileAsset, FileTag, FileTagLink
from plane.utils.shared_tags import find_or_create_tag, find_tag_by_name, tag_name_key


def test_key_ignores_case_spaces_accents_and_punctuation():
    assert tag_name_key("3ball Mty") == tag_name_key("3BallMTY") == tag_name_key("3-Ball MTY") == "3ballmty"
    assert tag_name_key("Ángela  Aguilar") == tag_name_key("angela aguilar")
    assert tag_name_key("3BALLMNTY") != tag_name_key("3BallMTY")


@pytest.mark.django_db
def test_reuses_the_tag_a_name_already_has(workspace):
    group = FileTag.objects.create(workspace=workspace, name="3BallMTY", kind=FileTag.Kind.GROUP)
    assert find_tag_by_name(workspace.id, "3ball Mty") == group
    assert find_or_create_tag(workspace.id, "3ball  mty", FileTag.Kind.ARTIST) == group
    # A typo is another name: the AI mapping proposes joining it, nothing here guesses
    other = find_or_create_tag(workspace.id, "3BALLMNTY", FileTag.Kind.ARTIST)
    assert other != group
    assert FileTag.objects.filter(workspace=workspace).count() == 2
    assert find_tag_by_name(workspace.id, "   ") is None


@pytest.mark.django_db
def test_contract_artist_reuses_a_group_spelled_differently(workspace, create_user):
    from plane.app.views.contract.internal import link_contract_tag

    group = FileTag.objects.create(workspace=workspace, name="3BallMTY", kind=FileTag.Kind.GROUP)
    asset = FileAsset.objects.create(
        workspace=workspace,
        asset="c.pdf",
        attributes={"name": "c.pdf"},
        entity_type=FileAsset.EntityTypeContext.WORKSPACE_FILE_LIBRARY,
        is_uploaded=True,
        created_by=create_user,
    )
    contract = Contract.objects.create(workspace=workspace, file_asset=asset, titulo="Contrato")
    link_contract_tag(contract, "3ball Mty", FileTag.Kind.ARTIST)
    assert FileTag.objects.filter(workspace=workspace).count() == 1
    assert FileTagLink.objects.filter(file_asset=asset, tag=group).exists()


@pytest.mark.django_db
def test_merge_with_an_edited_name_keeps_one_link_per_item_and_undoes(workspace, create_user):
    from plane.db.models import EntityTagLink, TaggingRun
    from plane.utils.shared_tags import search_tags
    from plane.utils.tagging import merge_tags, undo_run

    keep = FileTag.objects.create(workspace=workspace, name="José Serrano Montoya", kind=FileTag.Kind.PERSON)
    variant = FileTag.objects.create(workspace=workspace, name="jose serano montoyaa", kind=FileTag.Kind.PERSON)
    asset = FileAsset.objects.create(
        workspace=workspace,
        asset="c.pdf",
        attributes={"name": "c.pdf"},
        entity_type=FileAsset.EntityTypeContext.WORKSPACE_FILE_LIBRARY,
        is_uploaded=True,
        created_by=create_user,
    )
    only_variant = FileAsset.objects.create(
        workspace=workspace,
        asset="d.pdf",
        attributes={"name": "d.pdf"},
        entity_type=FileAsset.EntityTypeContext.WORKSPACE_FILE_LIBRARY,
        is_uploaded=True,
        created_by=create_user,
    )
    # The same contract carries both tags; another file only the variant
    FileTagLink.objects.create(workspace=workspace, file_asset=asset, tag=keep)
    FileTagLink.objects.create(workspace=workspace, file_asset=asset, tag=variant)
    FileTagLink.objects.create(workspace=workspace, file_asset=only_variant, tag=variant)
    EntityTagLink.objects.create(workspace=workspace, tag=keep, entity_type="issue", entity_id=asset.id)
    EntityTagLink.objects.create(workspace=workspace, tag=variant, entity_type="issue", entity_id=asset.id)

    # Search ignores accents
    assert [tag.name for tag in search_tags(workspace.id, "jose serrano")] == ["José Serrano Montoya"]

    record = merge_tags(workspace.id, keep.name, [variant.name], new_name="José Serrano")
    keep.refresh_from_db()
    assert keep.name == "José Serrano"
    assert not FileTag.objects.filter(id=variant.id).exists()
    assert FileTagLink.objects.filter(tag=keep, file_asset=asset).count() == 1
    assert FileTagLink.objects.filter(tag=keep, file_asset=only_variant).count() == 1
    assert EntityTagLink.objects.filter(tag=keep, entity_type="issue", entity_id=asset.id).count() == 1

    run = TaggingRun.objects.create(
        workspace=workspace,
        status=TaggingRun.Status.COMPLETED,
        summary={"applied": {"links": [], "created_tags": [], "merges": [record]}},
    )
    undo_run(run)
    keep.refresh_from_db()
    assert keep.name == "José Serrano Montoya"
    assert FileTag.objects.filter(id=variant.id).exists()
    assert not FileTagLink.objects.filter(tag=keep, file_asset=only_variant).exists()
    assert FileTagLink.objects.filter(tag=variant, file_asset=only_variant).exists()


@pytest.mark.django_db
def test_an_edited_name_already_taken_joins_that_tag_too(workspace):
    from plane.utils.tagging import merge_tags

    keep = FileTag.objects.create(workspace=workspace, name="3ball Mty")
    variant = FileTag.objects.create(workspace=workspace, name="3BALLMNTY")
    other = FileTag.objects.create(workspace=workspace, name="3BallMTY", kind=FileTag.Kind.GROUP)
    record = merge_tags(workspace.id, keep.name, [variant.name], new_name="3BallMTY")
    keep.refresh_from_db()
    assert keep.name == "3BallMTY"
    assert keep.kind == FileTag.Kind.GROUP
    assert {variant["id"] for variant in record["variants"]} == {str(variant.id), str(other.id)}
    assert list(FileTag.objects.filter(workspace=workspace).values_list("name", flat=True)) == ["3BallMTY"]


@pytest.mark.django_db
def test_merge_tells_apart_tags_that_only_differ_in_case(workspace):
    from plane.utils.tagging import merge_tags

    keep = FileTag.objects.create(workspace=workspace, name="3Ball Mty")
    lower = FileTag.objects.create(workspace=workspace, name="3ball Mty")
    record = merge_tags(workspace.id, "3Ball Mty", ["3ball Mty"])
    assert [variant["id"] for variant in record["variants"]] == [str(lower.id)]
    assert list(FileTag.objects.filter(workspace=workspace).values_list("id", flat=True)) == [keep.id]
