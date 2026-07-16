# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Internal music-catalog endpoints consumed by the Cloudflare Worker's
assistant agent (shared-secret auth, no user session). Reads wrap the same
filter helpers the user-facing endpoints use; the import wraps the exact
deterministic import machinery (mapping, dedupe, dry-run) so the AI only
contributes the column mapping — never its own write path.
"""

from io import BytesIO

from rest_framework import status
from rest_framework.response import Response

from plane.app.permissions.internal import WorkerServicePermission
from plane.app.views.base import BaseAPIView
from plane.db.models import FileAsset, MusicCredit, MusicLink, MusicTrack
from plane.settings.storage import S3Storage

from .base import IMPORT_FIELDS, MusicImportEndpoint, _filter_tracks, _infer_mapping, _read_table


class InternalMusicBaseView(BaseAPIView):
    authentication_classes = []
    permission_classes = [WorkerServicePermission]
    # Server-to-server: without a session the global AnonRateThrottle would
    # 429 the agent mid-conversation.
    throttle_classes = []


def _compact_track(track):
    """Small row the model can reason over without blowing the context."""
    credits = list(track.credits.all())
    videos = list(track.videos.all())
    return {
        "id": str(track.id),
        "title": track.title,
        "version": track.version or None,
        "isrc": track.isrc or None,
        "status": track.status,
        "release_date": track.release_date.isoformat() if track.release_date else None,
        "original_release_date": (
            track.original_release_date.isoformat() if track.original_release_date else None
        ),
        "artists": [c.party.display_name for c in credits if c.role == MusicCredit.Role.PRIMARY_ARTIST],
        "featured": [c.party.display_name for c in credits if c.role == MusicCredit.Role.FEATURED_ARTIST],
        "writers": [
            c.party.display_name
            for c in credits
            if c.role in (MusicCredit.Role.WRITER, MusicCredit.Role.AUTHOR, MusicCredit.Role.COMPOSER)
        ],
        "releases": [
            {"title": link.release.title, "upc": link.release.upc or None}
            for link in track.release_links.all()
        ],
        "videos": [
            {
                "title": video.title,
                "isrc_video": video.isrc_video or None,
                "release_date": video.release_date.isoformat() if video.release_date else None,
                "urls": [
                    link.url for link in video.links.all() if link.kind == MusicLink.Kind.MUSIC_VIDEO
                ],
            }
            for video in videos
        ],
    }


class InternalMusicTracksEndpoint(InternalMusicBaseView):
    """Track search for the agent: the shared `_filter_tracks` filters plus
    `artist_name` (the model knows names, not party ids)."""

    model = MusicTrack

    def get(self, request, workspace_id):
        params = request.query_params
        queryset = MusicTrack.objects.filter(
            workspace_id=workspace_id, parent_track__isnull=True
        ).prefetch_related("credits__party", "release_links__release", "videos__links")
        artist_name = params.get("artist_name")
        if artist_name:
            queryset = queryset.filter(credits__party__display_name__icontains=artist_name)
        queryset = _filter_tracks(queryset, params)

        try:
            limit = min(max(int(params.get("limit", 50)), 1), 200)
        except (TypeError, ValueError):
            limit = 50

        total = queryset.count()
        results = [_compact_track(track) for track in queryset[:limit]]
        return Response({"total": total, "returned": len(results), "results": results})


class InternalWorkspaceAssetsEndpoint(InternalMusicBaseView):
    """File-library assets lookup so the agent can resolve "importa el excel
    de reportes de marzo" into an asset id."""

    model = FileAsset

    def get(self, request, workspace_id):
        assets = FileAsset.objects.filter(
            workspace_id=workspace_id,
            entity_type=FileAsset.EntityTypeContext.WORKSPACE_FILE_LIBRARY,
            is_uploaded=True,
            is_deleted=False,
        ).order_by("-created_at")
        search = request.query_params.get("search")
        if search:
            assets = assets.filter(attributes__name__icontains=search)
        return Response(
            {
                "results": [
                    {
                        "asset_id": str(asset.id),
                        "name": (asset.attributes or {}).get("name"),
                        "type": (asset.attributes or {}).get("type"),
                        "size": asset.size,
                        "created_at": asset.created_at.isoformat(),
                    }
                    for asset in assets[:25]
                ]
            }
        )


class _S3Upload:
    """File-like wrapper (`.read()` + `.name`) so `_read_table` can consume an
    S3 object exactly like a request upload."""

    def __init__(self, content, name):
        self._content = content
        self.name = name

    def read(self):
        return self._content


def _load_asset_table(workspace_id, asset_id, sheet=None):
    asset = FileAsset.objects.get(
        id=asset_id,
        workspace_id=workspace_id,
        entity_type=FileAsset.EntityTypeContext.WORKSPACE_FILE_LIBRARY,
        is_deleted=False,
    )
    storage = S3Storage()
    obj = storage.s3_client.get_object(Bucket=storage.aws_storage_bucket_name, Key=asset.asset.name)
    content = obj["Body"].read()
    name = (asset.attributes or {}).get("name") or asset.asset.name
    return asset, _read_table(_S3Upload(content, name), sheet)


class InternalMusicImportEndpoint(InternalMusicBaseView):
    """Two-phase import over a file-library asset.

    mode=read   → headers, sample rows, sheets and the heuristic mapping (the
                  agent's AI refines this mapping from the sample).
    mode=import → runs the same deterministic row importer as the manual
                  import modal, honoring `dry_run` (proposal) or not (apply).
    """

    model = MusicTrack

    def post(self, request, workspace_id):
        asset_id = request.data.get("asset_id")
        if not asset_id:
            return Response({"error": "asset_id is required"}, status=status.HTTP_400_BAD_REQUEST)
        sheet = request.data.get("sheet")
        try:
            asset, (headers, rows, sheets, header_row) = _load_asset_table(workspace_id, asset_id, sheet)
        except FileAsset.DoesNotExist:
            return Response({"error": "Asset not found"}, status=status.HTTP_404_NOT_FOUND)
        except Exception as exc:
            return Response(
                {"error": f"Could not read spreadsheet: {exc}"}, status=status.HTTP_400_BAD_REQUEST
            )

        if request.data.get("mode", "read") == "read":
            from datetime import date, datetime

            def jsonable(value, limit=120):
                if isinstance(value, (date, datetime)):
                    return value.isoformat()
                text = str(value)
                return text[:limit] + "…" if len(text) > limit else value

            sample = [{key: jsonable(value) for key, value in row.items()} for row in rows[:10]]

            # Per-column samples scanned over the WHOLE file: a column that is
            # empty for the first thousand rows but holds URLs later must
            # still be classifiable — the contiguous head sample can't see it.
            column_samples = {}
            for header in headers:
                examples = []
                non_empty = 0
                for row in rows:
                    value = row.get(header)
                    if value in (None, ""):
                        continue
                    non_empty += 1
                    if len(examples) < 5:
                        examples.append(jsonable(value))
                column_samples[header] = {
                    "non_empty": non_empty,
                    "total": len(rows),
                    "examples": examples,
                }

            return Response(
                {
                    "file_name": (asset.attributes or {}).get("name"),
                    "headers": headers,
                    "sample_rows": sample,
                    "column_samples": column_samples,
                    "total_rows": len(rows),
                    "sheets": sheets,
                    "selected_sheet": sheet or (sheets[0] if sheets else None),
                    "canonical_fields": IMPORT_FIELDS,
                    "heuristic_mapping": _infer_mapping(headers, IMPORT_FIELDS),
                }
            )

        mapping = request.data.get("mapping") or {}
        if not mapping.get("track.title"):
            return Response({"error": "mapping['track.title'] is required"}, status=status.HTTP_400_BAD_REQUEST)
        defaults = request.data.get("defaults") or {}
        strategy = request.data.get("duplicate_strategy", "skip")
        dry_run = bool(request.data.get("dry_run", True))

        from django.db import transaction

        importer = MusicImportEndpoint()
        workspace = asset.workspace
        result = {"total": len(rows), "created": 0, "updated": 0, "skipped": 0, "errors": []}
        with transaction.atomic():
            for index, row in enumerate(rows, start=header_row + 1):
                try:
                    with transaction.atomic():
                        outcome = importer._import_row(workspace, row, mapping, strategy, defaults)
                    result[outcome] += 1
                except Exception as exc:
                    result["errors"].append({"row": index, "message": str(exc)[:300]})
            if dry_run:
                transaction.set_rollback(True)
        result["dry_run"] = dry_run
        return Response(result, status=status.HTTP_200_OK)
