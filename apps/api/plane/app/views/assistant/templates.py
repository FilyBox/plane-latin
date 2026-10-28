# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Contract templates for the assistant: list, read a variant's Word as an
outline, and try edits without saving (dry run). The web card asks for the
PDF preview of the edited Word through the session endpoint below."""

from django.http import HttpResponse
from rest_framework import status
from rest_framework.response import Response

from plane.app.permissions import ROLE, allow_permission
from plane.app.views.contract.internal import InternalBaseView
from plane.app.views.file_library.base import FileLibraryBaseView
from plane.db.models import User, Workspace
from plane.utils.assistant_actions import ActionError
from plane.utils.assistant_contract_drafts import proposal, render_preview
from plane.utils.assistant_templates import (
    TemplateEditError,
    can_edit,
    dry_run,
    find_variant,
    preview,
    template_list,
    template_outline,
)
from plane.utils.entities import AccessContext


def asking_context(request, workspace_id, user_id=None):
    """Who asks, as the Worker passes it (user_id), resolved like the app."""
    workspace = Workspace.objects.filter(id=workspace_id).first()
    user = User.objects.filter(id=user_id or request.query_params.get("user_id")).first()
    if workspace is None or user is None:
        return None
    return AccessContext.build(workspace.slug, user)


def _failure(error):
    body = {"error": str(error)}
    if isinstance(error, TemplateEditError):
        body["detail"] = error.detail
    return Response(body, status=status.HTTP_200_OK)


class InternalAssistantTemplatesEndpoint(InternalBaseView):
    def get(self, request, workspace_id):
        ctx = asking_context(request, workspace_id)
        if ctx is None or "file_library" not in ctx.features:
            return Response({"error": "Not available"}, status=status.HTTP_403_FORBIDDEN)
        return Response(
            {"templates": template_list(workspace_id, str(request.query_params.get("q") or "").strip())},
            status=status.HTTP_200_OK,
        )


class InternalAssistantTemplateOutlineEndpoint(InternalBaseView):
    def get(self, request, workspace_id, variant_id):
        ctx = asking_context(request, workspace_id)
        if ctx is None or "file_library" not in ctx.features:
            return Response({"error": "Not available"}, status=status.HTTP_403_FORBIDDEN)
        variant = find_variant(workspace_id, variant_id)
        if variant is None:
            return Response({"error": "Template variant not found"}, status=status.HTTP_404_NOT_FOUND)
        try:
            return Response(
                {**template_outline(variant, request.query_params.get("revision")), "can_edit": can_edit(ctx)},
                status=status.HTTP_200_OK,
            )
        except ActionError as error:
            return _failure(error)


class InternalAssistantTemplateDryRunEndpoint(InternalBaseView):
    def post(self, request, workspace_id, variant_id):
        data = request.data if isinstance(request.data, dict) else {}
        ctx = asking_context(request, workspace_id, data.get("user_id"))
        if not can_edit(ctx):
            return Response({"error": "Not available"}, status=status.HTTP_403_FORBIDDEN)
        variant = find_variant(workspace_id, variant_id)
        if variant is None:
            return Response({"error": "Template variant not found"}, status=status.HTTP_404_NOT_FOUND)
        try:
            return Response(
                dry_run(variant, data.get("revision"), data.get("edits"), data.get("variable_settings")),
                status=status.HTTP_200_OK,
            )
        except ActionError as error:
            return _failure(error)


class AssistantTemplatePreviewEndpoint(FileLibraryBaseView):
    """The edited Word as a PDF, for the card to show before applying."""

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def post(self, request, slug, variant_id):
        workspace = Workspace.objects.get(slug=slug)
        variant = find_variant(workspace.id, variant_id)
        if variant is None:
            return Response({"error": "Template variant not found"}, status=status.HTTP_404_NOT_FOUND)
        data = request.data if isinstance(request.data, dict) else {}
        try:
            pdf, note = preview(variant, data.get("revision"), data.get("edits"))
        except ActionError as error:
            return Response({"error": str(error)}, status=status.HTTP_400_BAD_REQUEST)
        response = HttpResponse(pdf, content_type="application/pdf")
        if note:
            response["X-Layout-Note"] = note
            response["Access-Control-Expose-Headers"] = "X-Layout-Note"
        return response


class InternalAssistantContractProposalEndpoint(InternalBaseView):
    """The card for a contract from a template: the form with the proposed
    values and their origin, the signers by role, and what is missing."""

    def post(self, request, workspace_id, variant_id):
        data = request.data if isinstance(request.data, dict) else {}
        ctx = asking_context(request, workspace_id, data.get("user_id"))
        if not can_edit(ctx):
            return Response({"error": "Not available"}, status=status.HTTP_403_FORBIDDEN)
        variant = find_variant(workspace_id, variant_id)
        if variant is None:
            return Response({"error": "Template variant not found"}, status=status.HTTP_404_NOT_FOUND)
        try:
            return Response(
                proposal(
                    variant,
                    data.get("revision"),
                    data.get("values"),
                    data.get("recipients"),
                    data.get("title"),
                    data.get("document_edits"),
                ),
                status=status.HTTP_200_OK,
            )
        except ActionError as error:
            return _failure(error)


class AssistantContractDraftPreviewEndpoint(FileLibraryBaseView):
    """The contract with the card's values, as a PDF; nothing is stored."""

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def post(self, request, slug, variant_id):
        workspace = Workspace.objects.get(slug=slug)
        variant = find_variant(workspace.id, variant_id)
        if variant is None:
            return Response({"error": "Template variant not found"}, status=status.HTTP_404_NOT_FOUND)
        try:
            pdf = render_preview(variant, request.data if isinstance(request.data, dict) else {})
        except ActionError as error:
            return Response({"error": str(error)}, status=status.HTTP_400_BAD_REQUEST)
        return HttpResponse(pdf, content_type="application/pdf")
