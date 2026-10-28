# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""What the Worker reads and checks before a card: contract corrections,
work items (query, changes resolved by name, comments). Nothing is saved
here; the card applies through the actions endpoint."""

from rest_framework import status
from rest_framework.response import Response

from plane.app.permissions import ROLE, allow_permission
from plane.app.views.base import BaseAPIView
from plane.app.views.contract.internal import InternalBaseView
from plane.utils.assistant_actions import ActionError
from plane.utils.assistant_catalog import audit, fixes_preview
from plane.utils.assistant_contract_edits import edit_preview
from plane.utils.assistant_expenses import can_use as can_use_expenses
from plane.utils.assistant_expenses import drafts as expense_drafts
from plane.utils.assistant_expenses import start as start_expenses
from plane.utils.assistant_files import find_duplicates, list_folder, plan
from plane.utils.assistant_work_items import comment_preview, query_work_items, update_preview

from plane.utils.entities import AccessContext

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


class InternalAssistantExpensesFromDocumentsEndpoint(InternalBaseView):
    """One analysis per file (a CFDI XML is ready at once); the card follows
    them with the session endpoint below."""

    def post(self, request, workspace_id):
        return _run(
            request,
            workspace_id,
            lambda ctx, data: start_expenses(ctx, ctx.user, data.get("asset_ids"), data.get("scenario_id")),
        )


class AssistantExpenseDraftsEndpoint(BaseAPIView):
    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def get(self, request, slug):
        ctx = AccessContext.build(slug, request.user)
        if not can_use_expenses(ctx):
            return Response({"error": "Not available"}, status=status.HTTP_403_FORBIDDEN)
        ids = [item for item in str(request.query_params.get("job_ids") or "").split(",") if item][:30]
        try:
            return Response(expense_drafts(ctx, ids), status=status.HTTP_200_OK)
        except Exception:
            return Response({"error": "Invalid job ids"}, status=status.HTTP_400_BAD_REQUEST)


class InternalAssistantFolderEndpoint(InternalBaseView):
    def post(self, request, workspace_id):
        def work(ctx, data):
            if "file_library" not in ctx.features:
                raise ActionError("The file library is not on in this workspace.")
            return list_folder(ctx, data.get("folder_id"), data.get("path"), bool(data.get("recursive")))

        return _run(request, workspace_id, work)


class InternalAssistantDuplicatesEndpoint(InternalBaseView):
    def post(self, request, workspace_id):
        def work(ctx, data):
            if "file_library" not in ctx.features:
                raise ActionError("The file library is not on in this workspace.")
            return find_duplicates(ctx, data.get("folder_id"), data.get("path"))

        return _run(request, workspace_id, work)


class InternalAssistantOrganizePlanEndpoint(InternalBaseView):
    def post(self, request, workspace_id):
        return _run(request, workspace_id, lambda ctx, data: plan(ctx, data.get("ops")))


class InternalAssistantCatalogAuditEndpoint(InternalBaseView):
    def post(self, request, workspace_id):
        return _run(
            request,
            workspace_id,
            lambda ctx, data: audit(ctx, data.get("checks"), data.get("artist"), data.get("release")),
        )


class InternalAssistantCatalogFixesEndpoint(InternalBaseView):
    def post(self, request, workspace_id):
        return _run(request, workspace_id, lambda ctx, data: fixes_preview(ctx, data.get("items")))
