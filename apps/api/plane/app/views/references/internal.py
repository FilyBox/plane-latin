# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Read-only lookups for the workspace assistant (Worker → Django).

The Worker calls with the shared internal key and says which user is asking;
every answer goes through the entity registry as that user, so the assistant
never names something the user could not open themselves.
"""

from datetime import date

from django.db.models import Q
from rest_framework import status
from rest_framework.response import Response

from plane.app.views.contract.internal import InternalBaseView
from plane.db.models import FileTag, User, Workspace
from plane.utils.entities import REGISTRY, AccessContext, search_entities
from plane.utils.references import backlinks, outgoing
from plane.utils.shared_tags import entities_for_tag, tag_payload, tag_usage, tag_years

MAX_PER_TYPE = 30


class InternalAssistantView(InternalBaseView):
    def context(self, request, workspace_id):
        """The asking user's access, or None when they are not a member or
        references are off for the workspace."""
        workspace = Workspace.objects.filter(id=workspace_id).first()
        user = User.objects.filter(id=request.query_params.get("user_id") or request.data.get("user_id")).first()
        if workspace is None or user is None:
            return None
        ctx = AccessContext.build(workspace.slug, user)
        if ctx is None or "references" not in ctx.features:
            return None
        return ctx

    def denied(self):
        return Response({"error": "Not available"}, status=status.HTTP_403_FORBIDDEN)


def _card(card):
    """Only what the assistant needs to answer and link."""
    return {
        key: card.get(key)
        for key in ("entity_name", "id", "title", "subtitle", "date", "path")
        if card.get(key) not in (None, "")
    }


class InternalAssistantTagsEndpoint(InternalAssistantView):
    """Tags whose name matches, most used first: lets the assistant pick the
    right spelling ("3ball" → 3BallMTY, 3Ball Mty)."""

    def get(self, request, workspace_id):
        ctx = self.context(request, workspace_id)
        if ctx is None:
            return self.denied()
        query = (request.query_params.get("q") or "").strip()
        squashed = "".join(ch for ch in query.lower() if ch.isalnum())
        tags = FileTag.objects.filter(workspace_id=ctx.workspace_id)
        if query:
            tags = [
                tag
                for tag in tags
                if query.lower() in tag.name.lower()
                or (squashed and squashed in "".join(ch for ch in tag.name.lower() if ch.isalnum()))
            ]
        usage = tag_usage(ctx.workspace_id)
        rows = sorted(
            ({**tag_payload(tag), "usage": usage.get(str(tag.id), 0)} for tag in tags),
            key=lambda row: -row["usage"],
        )
        return Response({"results": rows[:40]}, status=status.HTTP_200_OK)


class InternalAssistantTaggedEndpoint(InternalAssistantView):
    """Everything under one tag the user may open, grouped by kind, with the
    same search and date narrowing as the tag view."""

    def get(self, request, workspace_id):
        ctx = self.context(request, workspace_id)
        if ctx is None:
            return self.denied()
        params = request.query_params
        # Several tags at once: tag_ids (comma separated) combined by mode
        # (all, the default, or any), as the tag view's `with`.
        tag_ids = [value.strip() for value in (params.get("tag_ids") or "").split(",") if value.strip()]
        if any(not _is_uuid(value) for value in tag_ids):
            return Response({"error": "tag_ids must be ids"}, status=status.HTTP_400_BAD_REQUEST)
        if tag_ids and not params.get("tag_id") and not params.get("tag"):
            first = tag_ids[0]
        else:
            first = params.get("tag_id")
        lookup = Q(id=first) if _is_uuid(first) else Q(name__iexact=params.get("tag", ""))
        tag = FileTag.objects.filter(workspace_id=ctx.workspace_id).filter(lookup).first()
        if tag is None:
            return Response({"error": "Tag not found"}, status=status.HTTP_404_NOT_FOUND)
        mode = "any" if params.get("mode") == "any" else "all"
        found = {
            str(extra.id): extra
            for extra in FileTag.objects.filter(workspace_id=ctx.workspace_id, id__in=tag_ids).exclude(id=tag.id)
        }
        with_tags = [found[value] for value in dict.fromkeys(tag_ids) if value in found]
        missing = [value for value in tag_ids if value not in found and value != str(tag.id)]
        if missing:
            return Response({"error": "Tag not found", "missing": missing}, status=status.HTTP_404_NOT_FOUND)
        try:
            date_from = date.fromisoformat(params["date_from"]) if params.get("date_from") else None
            date_to = date.fromisoformat(params["date_to"]) if params.get("date_to") else None
        except ValueError:
            return Response({"error": "Dates must be YYYY-MM-DD"}, status=status.HTTP_400_BAD_REQUEST)
        types = [value for value in params.get("types", "").split(",") if value in REGISTRY] or None
        query = (params.get("q") or "").strip()
        groups = entities_for_tag(
            ctx,
            tag,
            types,
            query=query,
            date_from=date_from,
            date_to=date_to,
            limit_per_type=MAX_PER_TYPE,
            with_tags=with_tags,
            mode=mode,
        )
        link = f"/{ctx.slug}/tags/{tag.id}"
        if with_tags:
            link += f"?with={','.join(str(extra.id) for extra in with_tags)}&mode={mode}"
        return Response(
            {
                "tag": tag_payload(tag),
                **({"with_tags": [tag_payload(extra) for extra in with_tags], "mode": mode} if with_tags else {}),
                "link": link,
                "years": tag_years(ctx, tag, types, query, with_tags=with_tags, mode=mode),
                "groups": {
                    name: {"count": group["count"], "items": [_card(card) for card in group["items"]]}
                    for name, group in groups.items()
                },
            },
            status=status.HTTP_200_OK,
        )


class InternalAssistantSearchEndpoint(InternalAssistantView):
    """Find contracts, files, songs, releases, artists, budgets, expenses or
    work items by name."""

    def get(self, request, workspace_id):
        ctx = self.context(request, workspace_id)
        if ctx is None:
            return self.denied()
        query = (request.query_params.get("q") or "").strip()
        if not query:
            return Response({"error": "q is required"}, status=status.HTTP_400_BAD_REQUEST)
        types = [value for value in request.query_params.get("types", "").split(",") if value in REGISTRY] or None
        results = search_entities(ctx, query, types, count=8)
        return Response(
            {"results": {name: [_card(card) for card in cards] for name, cards in results.items() if cards}},
            status=status.HTTP_200_OK,
        )


class InternalAssistantReferencesEndpoint(InternalAssistantView):
    """What one item references and where it is referenced."""

    def get(self, request, workspace_id, entity_type, entity_id):
        ctx = self.context(request, workspace_id)
        if ctx is None:
            return self.denied()
        if entity_type not in REGISTRY and entity_type not in ("issue_comment",):
            return Response({"error": "Unknown type"}, status=status.HTTP_400_BAD_REQUEST)
        definition = REGISTRY.get(entity_type)
        if definition and (not definition.allows(ctx) or not definition.visible(ctx).filter(id=entity_id).exists()):
            return Response({"error": "Not found"}, status=status.HTTP_404_NOT_FOUND)
        return Response(
            {
                "references": [
                    _card(card) for card in outgoing(ctx, entity_type, str(entity_id)) if card["status"] == "ok"
                ],
                "referenced_by": [
                    _card(card) for card in backlinks(ctx, entity_type, str(entity_id)) if card["status"] == "ok"
                ],
            },
            status=status.HTTP_200_OK,
        )


def _is_uuid(value) -> bool:
    from uuid import UUID

    try:
        UUID(str(value))
        return True
    except (TypeError, ValueError):
        return False
