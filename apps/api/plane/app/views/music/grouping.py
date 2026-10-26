# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Group songs into albums and merge duplicate releases.

POST music/releases/group/ (workspace admin, one transaction)
    {dry_run?, albums: [{target: {release_id} | {create: {...}},
     merge_release_ids?, tracks?: [{track_id, disc_number?, track_number?}],
     create_tracks?: [...], remove_empty_merged?: true}]}
    → per-album summary. A dry run reports the same and writes nothing.

POST internal/workspaces/<id>/assistant/music/album-grouping/match/
    {user_id, albums: [{title, artists?, upc?, type?, release_date?, tracks}]}
    → the assistant's proposal (existing releases, suggested target, the
    catalog song for each track). Read-only, as the asking user.
"""

from django.core.exceptions import ValidationError
from django.db import transaction
from rest_framework import status
from rest_framework.response import Response

from plane.app.permissions import ROLE, allow_permission
from plane.db.models import User, Workspace
from plane.utils.contract_works import has_music_access
from plane.utils.entities import AccessContext
from plane.utils.music_grouping import GroupingError, apply_grouping, match_albums

from .base import MusicBaseView
from .internal import InternalMusicBaseView


def _truthy(value, default):
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in ("true", "1", "yes")


class MusicReleaseGroupEndpoint(MusicBaseView):
    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def post(self, request, slug):
        data = request.data if isinstance(request.data, dict) else {}
        dry_run = _truthy(data.get("dry_run"), False)
        workspace = Workspace.objects.get(slug=slug)
        try:
            with transaction.atomic():
                albums = apply_grouping(workspace, data.get("albums"))
                if dry_run:
                    transaction.set_rollback(True)
        except GroupingError as error:
            return Response({"error": str(error)}, status=status.HTTP_400_BAD_REQUEST)
        return Response(
            {
                "dry_run": dry_run,
                "albums": albums,
                "totals": {
                    "albums": len(albums),
                    "tracks": sum(
                        album["tracks_linked"] + album["tracks_moved"] + album["tracks_created"] for album in albums
                    ),
                    "merged_releases": sum(len(album["merged_releases"]) for album in albums),
                    "deleted_releases": sum(
                        1 for album in albums for merged in album["merged_releases"] if merged["deleted"]
                    ),
                },
            },
            status=status.HTTP_200_OK,
        )


def _assistant_ctx(workspace_id, user_id):
    """The asking user's access, or None when they are not an active member."""
    workspace = Workspace.objects.filter(id=workspace_id).only("slug").first()
    try:
        user = User.objects.filter(id=user_id).first() if user_id else None
    except (ValueError, ValidationError):
        user = None
    if workspace is None or user is None:
        return None
    return AccessContext.build(workspace.slug, user)


class InternalMusicAlbumGroupingMatchEndpoint(InternalMusicBaseView):
    def post(self, request, workspace_id):
        data = request.data if isinstance(request.data, dict) else {}
        ctx = _assistant_ctx(workspace_id, data.get("user_id"))
        # Same rule as the music endpoints: module on and workspace admin
        if not has_music_access(ctx):
            return Response({"error": "Not available"}, status=status.HTTP_403_FORBIDDEN)
        albums = data.get("albums")
        if not isinstance(albums, list) or not albums:
            return Response({"error": "albums must be a non-empty list"}, status=status.HTTP_400_BAD_REQUEST)
        return Response({"albums": match_albums(workspace_id, ctx.slug, albums)}, status=status.HTTP_200_OK)
