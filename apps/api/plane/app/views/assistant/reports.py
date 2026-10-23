# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Reports the assistant can turn into pages, built as the asking user."""

from datetime import date

from rest_framework import status
from rest_framework.response import Response

from plane.app.views.contract.internal import InternalBaseView
from plane.db.models import FileTag, User, Workspace, WorkspaceMember
from plane.utils.assistant_reports import build_tag_report


def _parse(value):
    try:
        return date.fromisoformat(str(value)[:10]) if value else None
    except ValueError:
        return None


class InternalAssistantReportEndpoint(InternalBaseView):
    def post(self, request, workspace_id):
        from plane.utils.entities import AccessContext

        data = request.data if isinstance(request.data, dict) else {}
        workspace = Workspace.objects.filter(id=workspace_id).first()
        user = User.objects.filter(id=data.get("user_id")).first()
        if workspace is None or user is None:
            return Response({"error": "Not available"}, status=status.HTTP_403_FORBIDDEN)
        if not WorkspaceMember.objects.filter(workspace=workspace, member=user, is_active=True).exists():
            return Response({"error": "Not available"}, status=status.HTTP_403_FORBIDDEN)
        ctx = AccessContext.build(workspace.slug, user)
        tags = FileTag.objects.filter(workspace=workspace)
        tag = tags.filter(id=data["tag_id"]).first() if data.get("tag_id") else None
        if tag is None and data.get("tag"):
            tag = tags.filter(name__iexact=str(data["tag"]).strip()).first()
        if tag is None:
            return Response({"error": "Tag not found; look it up with find_tags"}, status=status.HTTP_404_NOT_FOUND)
        report = build_tag_report(
            ctx,
            tag,
            include=data.get("include"),
            date_from=_parse(data.get("date_from")),
            date_to=_parse(data.get("date_to")),
        )
        return Response({**report, "tag": {"id": str(tag.id), "name": tag.name}}, status=status.HTTP_200_OK)
