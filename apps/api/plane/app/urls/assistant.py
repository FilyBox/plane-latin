# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from django.urls import path

from plane.app.views import AssistantChatEndpoint, AssistantModelsEndpoint, AssistantMusicImportEndpoint

urlpatterns = [
    path(
        "workspaces/<str:slug>/assistant/chat/",
        AssistantChatEndpoint.as_view(),
        name="assistant-chat",
    ),
    path(
        "workspaces/<str:slug>/assistant/models/",
        AssistantModelsEndpoint.as_view(),
        name="assistant-models",
    ),
    path(
        "workspaces/<str:slug>/assistant/music-import/",
        AssistantMusicImportEndpoint.as_view(),
        name="assistant-music-import",
    ),
]
