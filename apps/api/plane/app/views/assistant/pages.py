# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""A page as the assistant reads it before proposing changes (worker callback,
answered as the asking user)."""

from rest_framework import status
from rest_framework.response import Response

from plane.app.views.contract.internal import InternalBaseView
from plane.db.models import User, Workspace
from plane.utils.assistant_pages import PageUnavailable, read_page
from plane.utils.entities import AccessContext


class InternalAssistantPageReadEndpoint(InternalBaseView):
    def get(self, request, workspace_id, page_id):
        workspace = Workspace.objects.filter(id=workspace_id).first()
        user = User.objects.filter(id=request.query_params.get("user_id")).first()
        ctx = AccessContext.build(workspace.slug, user) if workspace and user else None
        if ctx is None:
            return Response({"error": "Not available"}, status=status.HTTP_403_FORBIDDEN)
        try:
            return Response(read_page(ctx, user, page_id), status=status.HTTP_200_OK)
        except PageUnavailable as error:
            return Response({"error": str(error)}, status=status.HTTP_404_NOT_FOUND)
