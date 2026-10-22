# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from django.urls import path

from plane.app.views.references import (
    EntityReferenceDetailEndpoint,
    EntityReferencesEndpoint,
    EntityResolveEndpoint,
    EntitySearchEndpoint,
    EntityTagsBulkEndpoint,
    EntityTagsEndpoint,
    SharedTagApplyEndpoint,
    SharedTagDetailEndpoint,
    SharedTagEndpoint,
    SharedTagEntitiesEndpoint,
    SharedTagExportEndpoint,
    InternalAssistantReferencesEndpoint,
    InternalAssistantSearchEndpoint,
    InternalAssistantTaggedEndpoint,
    InternalAssistantTagsEndpoint,
    InternalTaggingContextEndpoint,
    InternalTaggingInventoryEndpoint,
    InternalTaggingRunEndpoint,
    TaggingRunDetailEndpoint,
    TaggingRunEndpoint,
)

urlpatterns = [
    path("workspaces/<str:slug>/entities/search/", EntitySearchEndpoint.as_view(), name="entities-search"),
    path("workspaces/<str:slug>/entities/resolve/", EntityResolveEndpoint.as_view(), name="entities-resolve"),
    path("workspaces/<str:slug>/entities/tags/", EntityTagsBulkEndpoint.as_view(), name="entities-tags-bulk"),
    path(
        "workspaces/<str:slug>/entities/<str:entity_type>/<uuid:entity_id>/references/",
        EntityReferencesEndpoint.as_view(),
        name="entity-references",
    ),
    path(
        "workspaces/<str:slug>/entities/<str:entity_type>/<uuid:entity_id>/references/<str:target_type>/<uuid:target_id>/",
        EntityReferenceDetailEndpoint.as_view(),
        name="entity-reference-detail",
    ),
    path(
        "workspaces/<str:slug>/entities/<str:entity_type>/<uuid:entity_id>/tags/",
        EntityTagsEndpoint.as_view(),
        name="entity-tags",
    ),
    path("workspaces/<str:slug>/shared-tags/", SharedTagEndpoint.as_view(), name="shared-tags"),
    path(
        "workspaces/<str:slug>/shared-tags/<uuid:tag_id>/",
        SharedTagDetailEndpoint.as_view(),
        name="shared-tag-detail",
    ),
    path(
        "workspaces/<str:slug>/shared-tags/<uuid:tag_id>/entities/",
        SharedTagEntitiesEndpoint.as_view(),
        name="shared-tag-entities",
    ),
    path(
        "workspaces/<str:slug>/shared-tags/<uuid:tag_id>/apply/",
        SharedTagApplyEndpoint.as_view(),
        name="shared-tag-apply",
    ),
    path(
        "workspaces/<str:slug>/shared-tags/<uuid:tag_id>/export/",
        SharedTagExportEndpoint.as_view(),
        name="shared-tag-export",
    ),
    path("workspaces/<str:slug>/tagging-runs/", TaggingRunEndpoint.as_view(), name="tagging-runs"),
    path(
        "workspaces/<str:slug>/tagging-runs/<uuid:run_id>/",
        TaggingRunDetailEndpoint.as_view(),
        name="tagging-run-detail",
    ),
    # Worker callbacks (shared secret)
    path(
        "internal/workspaces/<uuid:workspace_id>/tagging/inventory/",
        InternalTaggingInventoryEndpoint.as_view(),
        name="internal-tagging-inventory",
    ),
    path(
        "internal/workspaces/<uuid:workspace_id>/tagging/context/",
        InternalTaggingContextEndpoint.as_view(),
        name="internal-tagging-context",
    ),
    path(
        "internal/tagging-runs/<uuid:run_id>/",
        InternalTaggingRunEndpoint.as_view(),
        name="internal-tagging-run",
    ),
    # Workspace assistant lookups (shared secret, answered as the asking user)
    path(
        "internal/workspaces/<uuid:workspace_id>/assistant/tags/",
        InternalAssistantTagsEndpoint.as_view(),
        name="internal-assistant-tags",
    ),
    path(
        "internal/workspaces/<uuid:workspace_id>/assistant/tagged/",
        InternalAssistantTaggedEndpoint.as_view(),
        name="internal-assistant-tagged",
    ),
    path(
        "internal/workspaces/<uuid:workspace_id>/assistant/search/",
        InternalAssistantSearchEndpoint.as_view(),
        name="internal-assistant-search",
    ),
    path(
        "internal/workspaces/<uuid:workspace_id>/assistant/references/<str:entity_type>/<uuid:entity_id>/",
        InternalAssistantReferencesEndpoint.as_view(),
        name="internal-assistant-references",
    ),
]
