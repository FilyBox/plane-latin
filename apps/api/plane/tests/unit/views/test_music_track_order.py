# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Song list ordering: whitelisted `order_by` values, undated songs last in
both directions, and unknown values falling back to the default order."""

from datetime import date

import pytest

from plane.db.models import MusicTrack, WorkspaceFeature


@pytest.fixture
def music(workspace):
    WorkspaceFeature.objects.create(workspace=workspace, key=WorkspaceFeature.FeatureKey.MUSIC_CATALOG, is_enabled=True)
    return workspace


def _titles(session_client, workspace, **params):
    response = session_client.get(
        f"/api/workspaces/{workspace.slug}/music/tracks/", {"songs_only": "true", "page": "1", **params}
    )
    assert response.status_code == 200
    return [row["title"] for row in response.json()["results"]]


@pytest.mark.django_db
def test_order_by(session_client, music):
    MusicTrack.objects.create(workspace=music, title="Beta", isrc="MX2", release_date=date(2024, 1, 1))
    MusicTrack.objects.create(workspace=music, title="Alfa", isrc="MX3", release_date=date(2025, 1, 1))
    MusicTrack.objects.create(workspace=music, title="Gamma", isrc="MX1", release_date=None)

    assert _titles(session_client, music, order_by="title") == ["Alfa", "Beta", "Gamma"]
    assert _titles(session_client, music, order_by="-title") == ["Gamma", "Beta", "Alfa"]
    assert _titles(session_client, music, order_by="isrc") == ["Gamma", "Beta", "Alfa"]
    # Undated songs go last either way
    assert _titles(session_client, music, order_by="-release_date") == ["Alfa", "Beta", "Gamma"]
    assert _titles(session_client, music, order_by="release_date") == ["Beta", "Alfa", "Gamma"]
    assert _titles(session_client, music, order_by="contract_count")[0] == "Alfa"
    # Unknown fields are ignored, not passed to the database
    assert len(_titles(session_client, music, order_by="workspace__owner")) == 3
