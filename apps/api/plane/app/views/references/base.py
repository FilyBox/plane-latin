# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Endpoints for cross-module mentions, references and shared tags.

Every response goes through the entity registry, so a viewer only ever gets
names for things their role and the workspace's modules let them open;
anything else comes back as "restricted".
"""

from datetime import date
from uuid import UUID

from django.db import transaction

from rest_framework import status
from rest_framework.response import Response

from plane.app.permissions import ROLE, allow_permission
from plane.app.views.base import BaseAPIView
from plane.db.models import ExporterHistory, FileTag, Workspace
from plane.utils.entities import REGISTRY, AccessContext, allowed_types, resolve_entities, search_entities
from plane.utils.references import add_attachment, backlinks, outgoing, remove_attachment
from plane.utils.shared_tags import (
    apply_tag_to_many,
    delete_tag,
    entities_for_tag,
    find_or_create_tag,
    get_tags,
    rename_tag,
    search_tags,
    set_tags,
    tag_payload,
    tag_usage,
    tag_years,
    tagged_ids,
)

# What can hold references (and what a reference may point to: the registry).
SOURCE_TYPES = {"issue", "issue_comment", "page"}
TAG_KINDS = {choice for choice, _ in FileTag.Kind.choices}


class ReferenceBaseView(BaseAPIView):
    def context(self, slug):
        ctx = AccessContext.build(slug, self.request.user)
        if ctx is None:
            self.permission_denied(self.request, message="Not a member of this workspace")
        # Rolled out per workspace from the instance admin.
        if "references" not in ctx.features:
            self.permission_denied(self.request, message="References are not enabled for this workspace")
        return ctx

    def can_open(self, ctx, entity_type, entity_id) -> bool:
        if entity_type == "issue_comment":
            from plane.db.models import IssueComment

            issue_id = (
                IssueComment.objects.filter(id=entity_id, workspace_id=ctx.workspace_id)
                .values_list("issue_id", flat=True)
                .first()
            )
            if not issue_id:
                return False
            entity_type, entity_id = "issue", str(issue_id)
        cards = resolve_entities(ctx, [{"entity_name": entity_type, "id": str(entity_id)}])
        return bool(cards) and cards[0]["status"] == "ok"


class EntitySearchEndpoint(ReferenceBaseView):
    """Mention picker and "attach" search across every module."""

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def get(self, request, slug):
        ctx = self.context(slug)
        types = [value for value in request.query_params.get("types", "").split(",") if value] or None
        try:
            count = max(1, min(int(request.query_params.get("count", 5)), 25))
        except ValueError:
            count = 5
        results = search_entities(ctx, request.query_params.get("q", ""), types, count)
        return Response({"types": allowed_types(ctx), "results": results}, status=status.HTTP_200_OK)


class EntityResolveEndpoint(ReferenceBaseView):
    """Cards for mention chips: title and link, or restricted / missing."""

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def post(self, request, slug):
        ctx = self.context(slug)
        items = request.data.get("items") or []
        if not isinstance(items, list):
            return Response({"error": "items must be a list"}, status=status.HTTP_400_BAD_REQUEST)
        return Response({"results": resolve_entities(ctx, items[:200])}, status=status.HTTP_200_OK)


class EntityReferencesEndpoint(ReferenceBaseView):
    """What an entity references, and where it is referenced."""

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def get(self, request, slug, entity_type, entity_id):
        ctx = self.context(slug)
        if entity_type not in REGISTRY and entity_type not in SOURCE_TYPES:
            return Response({"error": "Unknown entity type"}, status=status.HTTP_400_BAD_REQUEST)
        if not self.can_open(ctx, entity_type, entity_id):
            return Response({"error": "Not found"}, status=status.HTTP_404_NOT_FOUND)
        payload = {"outgoing": [], "backlinks": backlinks(ctx, entity_type, str(entity_id))}
        if entity_type in SOURCE_TYPES:
            payload["outgoing"] = outgoing(ctx, entity_type, str(entity_id))
        return Response(payload, status=status.HTTP_200_OK)

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def post(self, request, slug, entity_type, entity_id):
        """Attaches something to a work item or page."""
        ctx = self.context(slug)
        target_type, target_id = request.data.get("entity_name"), str(request.data.get("id") or "")
        if entity_type not in SOURCE_TYPES or target_type not in REGISTRY or not target_id:
            return Response({"error": "Invalid reference"}, status=status.HTTP_400_BAD_REQUEST)
        if not self.can_open(ctx, entity_type, entity_id) or not self.can_open(ctx, target_type, target_id):
            return Response({"error": "Not found"}, status=status.HTTP_404_NOT_FOUND)
        add_attachment(ctx.workspace_id, entity_type, str(entity_id), target_type, target_id, request.user.id)
        return Response(outgoing(ctx, entity_type, str(entity_id)), status=status.HTTP_201_CREATED)


class EntityReferenceDetailEndpoint(ReferenceBaseView):
    @allow_permission([ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def delete(self, request, slug, entity_type, entity_id, target_type, target_id):
        ctx = self.context(slug)
        if entity_type not in SOURCE_TYPES or not self.can_open(ctx, entity_type, entity_id):
            return Response({"error": "Not found"}, status=status.HTTP_404_NOT_FOUND)
        # Only the attachment goes; a mention lives in the text and follows it.
        remove_attachment(entity_type, str(entity_id), target_type, str(target_id))
        return Response(status=status.HTTP_204_NO_CONTENT)


class SharedTagEndpoint(ReferenceBaseView):
    """The workspace's shared tags (FileTag), for every module's picker."""

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def get(self, request, slug):
        ctx = self.context(slug)
        kind = request.query_params.get("kind")
        tags = search_tags(
            ctx.workspace_id,
            request.query_params.get("search", "").strip(),
            kind if kind in TAG_KINDS else None,
            limit=500,
        )
        usage = tag_usage(ctx.workspace_id) if request.query_params.get("usage") == "1" else {}
        return Response(
            [{**tag_payload(tag), "usage": usage.get(str(tag.id), 0)} for tag in tags], status=status.HTTP_200_OK
        )

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def post(self, request, slug):
        ctx = self.context(slug)
        name = (request.data.get("name") or "").strip()
        if not name:
            return Response({"error": "name is required"}, status=status.HTTP_400_BAD_REQUEST)
        kind = request.data.get("kind") if request.data.get("kind") in TAG_KINDS else FileTag.Kind.CUSTOM
        tag = find_or_create_tag(ctx.workspace_id, name, kind, request.user.id)
        return Response(tag_payload(tag), status=status.HTTP_201_CREATED)


class SharedTagDetailEndpoint(ReferenceBaseView):
    @allow_permission([ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def patch(self, request, slug, tag_id):
        ctx = self.context(slug)
        tag = FileTag.objects.filter(workspace_id=ctx.workspace_id, id=tag_id).first()
        if tag is None:
            return Response({"error": "Not found"}, status=status.HTTP_404_NOT_FOUND)
        name = " ".join((request.data.get("name") or tag.name).split())[:255]
        if (
            name.lower() != tag.name.lower()
            and FileTag.objects.filter(workspace_id=ctx.workspace_id, name__iexact=name).exclude(id=tag.id).exists()
        ):
            return Response({"error": "A tag with this name already exists"}, status=status.HTTP_409_CONFLICT)
        kind = request.data.get("kind") if request.data.get("kind") in TAG_KINDS else None
        rename_tag(tag, name, kind)
        return Response(tag_payload(tag), status=status.HTTP_200_OK)

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def delete(self, request, slug, tag_id):
        ctx = self.context(slug)
        # Soft delete: its links go with it, the tagged things stay.
        tag = FileTag.objects.filter(workspace_id=ctx.workspace_id, id=tag_id).first()
        if tag is not None:
            delete_tag(tag)
        return Response(status=status.HTTP_204_NO_CONTENT)


class EntityTagsEndpoint(ReferenceBaseView):
    """Shared tags of one entity, in whichever store that module uses."""

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def get(self, request, slug, entity_type, entity_id):
        ctx = self.context(slug)
        if entity_type not in REGISTRY or not self.can_open(ctx, entity_type, entity_id):
            return Response({"error": "Not found"}, status=status.HTTP_404_NOT_FOUND)
        return Response(get_tags(ctx.workspace_id, entity_type, [str(entity_id)])[str(entity_id)])

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def put(self, request, slug, entity_type, entity_id):
        ctx = self.context(slug)
        if entity_type not in REGISTRY or not self.can_open(ctx, entity_type, entity_id):
            return Response({"error": "Not found"}, status=status.HTTP_404_NOT_FOUND)
        tag_ids = request.data.get("tag_ids")
        if not isinstance(tag_ids, list):
            return Response({"error": "tag_ids must be a list"}, status=status.HTTP_400_BAD_REQUEST)
        valid = {
            str(value)
            for value in FileTag.objects.filter(workspace_id=ctx.workspace_id, id__in=tag_ids).values_list(
                "id", flat=True
            )
        }
        return Response(set_tags(ctx.workspace_id, entity_type, str(entity_id), valid, request.user.id))


class EntityTagsBulkEndpoint(ReferenceBaseView):
    """Tags for a page of rows in one call (tables and lists)."""

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def post(self, request, slug):
        ctx = self.context(slug)
        entity_type = request.data.get("entity_name")
        ids = request.data.get("ids") or []
        definition = REGISTRY.get(entity_type)
        if definition is None or not isinstance(ids, list):
            return Response({"error": "Invalid request"}, status=status.HTTP_400_BAD_REQUEST)
        if not definition.allows(ctx):
            return Response({}, status=status.HTTP_200_OK)
        visible = {
            str(value) for value in definition.visible(ctx).filter(id__in=ids[:500]).values_list("id", flat=True)
        }
        return Response(get_tags(ctx.workspace_id, entity_type, visible), status=status.HTTP_200_OK)


class SharedTagApplyEndpoint(ReferenceBaseView):
    """Adds or removes one tag on many items of one kind (a selection of
    songs, contracts…). Items the user may not open are skipped."""

    MAX_ITEMS = 5000

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def post(self, request, slug, tag_id):
        ctx = self.context(slug)
        tag = FileTag.objects.filter(workspace_id=ctx.workspace_id, id=tag_id).first()
        entity_type = request.data.get("entity_name")
        ids = request.data.get("ids")
        definition = REGISTRY.get(entity_type)
        if tag is None or definition is None:
            return Response({"error": "Not found"}, status=status.HTTP_404_NOT_FOUND)
        if not isinstance(ids, list) or not ids or len(ids) > self.MAX_ITEMS:
            return Response({"error": f"ids must list 1-{self.MAX_ITEMS} items"}, status=status.HTTP_400_BAD_REQUEST)
        if not definition.allows(ctx):
            return Response({"error": "Not allowed"}, status=status.HTTP_403_FORBIDDEN)
        valid = [value for value in ids if _is_uuid(value)]
        visible = list(definition.visible(ctx).filter(id__in=valid).values_list("id", flat=True))
        with transaction.atomic():
            changed = apply_tag_to_many(
                ctx.workspace_id,
                entity_type,
                visible,
                tag.id,
                request.user.id,
                remove=request.data.get("action") == "remove",
            )
        return Response(
            {"changed": changed, "matched": len(visible), "skipped": len(ids) - len(visible), "tag": tag_payload(tag)},
            status=status.HTTP_200_OK,
        )


def _is_uuid(value) -> bool:
    try:
        UUID(str(value))
        return True
    except (TypeError, ValueError):
        return False


def tag_filters(params) -> dict:
    """Search text and date range for browsing a tag. Raises ValueError on a
    malformed date."""

    def parse(key):
        value = (params.get(key) or "").strip()
        return date.fromisoformat(value) if value else None

    return {
        "query": " ".join(str(params.get("q") or "").split())[:200],
        "date_from": parse("date_from"),
        "date_to": parse("date_to"),
    }


MAX_COMBINED_TAGS = 10


def combined_tags(workspace_id, params, main_tag_id) -> tuple[list, str]:
    """The extra tags (`with`: ids, comma separated or a list) and how they
    combine with the main one (`mode`: all, the default, or any). Raises
    ValueError on a malformed id or mode. Ids that are not tags of this
    workspace (deleted, or someone else's) are dropped, so a shared link to
    a combination still opens; the response lists the ones applied."""
    raw = params.get("with") or ""
    values = raw if isinstance(raw, (list, tuple)) else str(raw).split(",")
    ids = []
    for value in (str(value).strip() for value in values):
        if not value:
            continue
        if not _is_uuid(value):
            raise ValueError("with")
        if value != str(main_tag_id) and value not in ids:
            ids.append(value)
    mode = str(params.get("mode") or "all").strip().lower()
    if mode not in ("all", "any"):
        raise ValueError("mode")
    if not ids:
        return [], mode
    found = {
        str(tag.id): tag
        for tag in FileTag.objects.filter(workspace_id=workspace_id, id__in=ids[:MAX_COMBINED_TAGS]).select_related(
            "party"
        )
    }
    return [found[value] for value in ids[:MAX_COMBINED_TAGS] if value in found], mode


class SharedTagEntitiesEndpoint(ReferenceBaseView):
    """Everything carrying a tag, from every module, grouped by type."""

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def get(self, request, slug, tag_id):
        ctx = self.context(slug)
        tag = FileTag.objects.filter(workspace_id=ctx.workspace_id, id=tag_id).select_related("party").first()
        if tag is None:
            return Response({"error": "Not found"}, status=status.HTTP_404_NOT_FOUND)
        try:
            filters = tag_filters(request.query_params)
            offset = max(0, int(request.query_params.get("offset", 0)))
            limit = max(1, min(int(request.query_params.get("limit", 50)), 200))
            with_tags, mode = combined_tags(ctx.workspace_id, request.query_params, tag.id)
        except ValueError:
            return Response({"error": "Invalid filters"}, status=status.HTTP_400_BAD_REQUEST)
        types = [value for value in request.query_params.get("types", "").split(",") if value] or None
        groups = entities_for_tag(
            ctx, tag, types, offset=offset, limit_per_type=limit, with_tags=with_tags, mode=mode, **filters
        )
        # Where the tagged things are mentioned, so work items about an artist
        # show up even when only their songs were tagged. Only on the first,
        # unfiltered page of a single tag: it describes the tag, not a search
        # or a combination.
        mentioned_in: dict[tuple, dict] = {}
        if offset == 0 and not types and not with_tags and not any(filters.values()):
            for name in groups:
                for entity_id in tagged_ids(ctx.workspace_id, tag, name)[:50]:
                    for link in backlinks(ctx, name, entity_id):
                        if link["status"] == "ok":
                            mentioned_in.setdefault((link["entity_name"], link["id"]), link)
        payload = {
            "tag": tag_payload(tag),
            "with_tags": [tag_payload(extra) for extra in with_tags],
            "mode": mode,
            "groups": groups,
            "mentioned_in": list(mentioned_in.values())[:100],
        }
        if offset == 0:
            payload["years"] = tag_years(ctx, tag, types, filters["query"], with_tags=with_tags, mode=mode)
        return Response(payload, status=status.HTTP_200_OK)


class SharedTagExportEndpoint(ReferenceBaseView):
    """ZIP of every file under a tag plus a summary of everything else."""

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def post(self, request, slug, tag_id):
        from plane.bgtasks.reference_task import shared_tag_export_task

        ctx = self.context(slug)
        if not FileTag.objects.filter(workspace_id=ctx.workspace_id, id=tag_id).exists():
            return Response({"error": "Not found"}, status=status.HTTP_404_NOT_FOUND)
        types = request.data.get("types") or []
        try:
            filters = tag_filters(request.data)
            with_tags, mode = combined_tags(ctx.workspace_id, request.data, tag_id)
        except ValueError:
            return Response({"error": "Invalid filters"}, status=status.HTTP_400_BAD_REQUEST)
        exporter = ExporterHistory.objects.create(
            workspace=Workspace.objects.get(id=ctx.workspace_id),
            type="shared_tag",
            provider="zip",
            status="queued",
            initiated_by=request.user,
            filters={
                "tag_id": str(tag_id),
                "types": [value for value in types if value in REGISTRY],
                # Downloads what the view shows: the same search and dates.
                "query": filters["query"],
                "date_from": filters["date_from"].isoformat() if filters["date_from"] else None,
                "date_to": filters["date_to"].isoformat() if filters["date_to"] else None,
                # And the same combination of tags.
                "with": [str(extra.id) for extra in with_tags],
                "mode": mode,
                "origin": request.headers.get("Origin", ""),
            },
        )
        shared_tag_export_task.delay(str(exporter.id))
        return Response({"export_id": str(exporter.id)}, status=status.HTTP_201_CREATED)

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def get(self, request, slug, tag_id):
        ctx = self.context(slug)
        exporter = ExporterHistory.objects.filter(
            id=request.query_params.get("export_id"),
            workspace_id=ctx.workspace_id,
            type="shared_tag",
            initiated_by=request.user,
        ).first()
        if exporter is None:
            return Response({"error": "Not found"}, status=status.HTTP_404_NOT_FOUND)
        return Response({"status": exporter.status, "url": exporter.url, "reason": exporter.reason or None})


__all__ = [
    "SharedTagApplyEndpoint",
    "EntitySearchEndpoint",
    "EntityResolveEndpoint",
    "EntityReferencesEndpoint",
    "EntityReferenceDetailEndpoint",
    "SharedTagEndpoint",
    "SharedTagDetailEndpoint",
    "EntityTagsEndpoint",
    "EntityTagsBulkEndpoint",
    "SharedTagEntitiesEndpoint",
    "SharedTagExportEndpoint",
]
