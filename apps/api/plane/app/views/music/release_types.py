# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Fix the type of releases imported before the type was inferred.

POST music/releases/infer-types/ {dry_run: true|false, release_ids?: [...]}

Only releases still on the default type (Album) are considered — a type
someone chose stays. The type comes from the same rule the import uses (the
title's hint, then the number of songs). A dry run lists the changes; applying
writes them (all of them, or the `release_ids` the user kept checked).
"""

# Python imports
import uuid

# Django imports
from django.db import transaction

# Third party imports
from rest_framework import status
from rest_framework.response import Response

# Module imports
from plane.app.permissions import ROLE, allow_permission
from plane.db.models import MusicRelease
from plane.utils.music_release_types import apply_inferred_types, count_by_type, plan_inferred_types

from .base import MusicBaseView


def _truthy(value, default):
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in ("true", "1", "yes")


class MusicReleaseInferTypesEndpoint(MusicBaseView):
    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def post(self, request, slug):
        data = request.data if isinstance(request.data, dict) else {}
        dry_run = _truthy(data.get("dry_run"), True)
        releases = MusicRelease.objects.filter(workspace__slug=slug, release_type=MusicRelease.Type.ALBUM)
        release_ids = data.get("release_ids")
        if release_ids is not None:
            if not isinstance(release_ids, list):
                return Response({"release_ids": ["Expected a list."]}, status=status.HTTP_400_BAD_REQUEST)
            clean = []
            for raw in release_ids:
                try:
                    clean.append(uuid.UUID(str(raw)))
                except (TypeError, ValueError):
                    continue
            releases = releases.filter(id__in=clean)
        with transaction.atomic():
            changes = plan_inferred_types(releases)
            if not dry_run and changes:
                apply_inferred_types(changes, request.user)
        return Response(
            {
                "dry_run": dry_run,
                "changes": [
                    {
                        "id": str(change["release"].id),
                        "title": change["release"].title,
                        "tracks": change["tracks"],
                        "from": change["from"],
                        "to": change["to"],
                    }
                    for change in changes
                ],
                "counts": count_by_type(changes),
                "updated": 0 if dry_run else len(changes),
            },
            status=status.HTTP_200_OK,
        )
