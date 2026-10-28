# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""What the Worker reads and checks before a card: contract corrections,
work items (query, changes resolved by name, comments). Nothing is saved
here; the card applies through the actions endpoint."""

from rest_framework import status
from rest_framework.response import Response

from plane.app.views.contract.internal import InternalBaseView
from plane.utils.assistant_actions import ActionError
from plane.utils.assistant_contract_edits import edit_preview
from plane.utils.assistant_work_items import comment_preview, query_work_items, update_preview

from .templates import asking_context


def _body(request):
    return request.data if isinstance(request.data, dict) else {}


def _run(request, workspace_id, work):
    data = _body(request)
    ctx = asking_context(request, workspace_id, data.get("user_id"))
    if ctx is None:
        return Response({"error": "Not available"}, status=status.HTTP_403_FORBIDDEN)
    try:
        return Response(work(ctx, data), status=status.HTTP_200_OK)
    except ActionError as error:
        return Response({"error": str(error)}, status=status.HTTP_200_OK)


class InternalAssistantContractEditPreviewEndpoint(InternalBaseView):
    def post(self, request, workspace_id):
        return _run(request, workspace_id, lambda ctx, data: edit_preview(ctx, data.get("items")))


class InternalAssistantWorkItemsQueryEndpoint(InternalBaseView):
    def post(self, request, workspace_id):
        return _run(request, workspace_id, lambda ctx, data: query_work_items(ctx, data))


class InternalAssistantWorkItemsPreviewEndpoint(InternalBaseView):
    def post(self, request, workspace_id):
        return _run(request, workspace_id, lambda ctx, data: update_preview(ctx, data.get("items")))


class InternalAssistantWorkItemCommentPreviewEndpoint(InternalBaseView):
    def post(self, request, workspace_id):
        return _run(
            request, workspace_id, lambda ctx, data: comment_preview(ctx, data.get("issue_id"), data.get("markdown"))
        )
