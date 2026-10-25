# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from django.urls import path

from plane.app.views import AssistantChatEndpoint, AssistantModelsEndpoint, AssistantMusicImportEndpoint
from plane.app.views.assistant import (
    AssistantBalanceEndpoint,
    AssistantActionUndoEndpoint,
    AssistantActionsEndpoint,
    AssistantChatDetailEndpoint,
    AssistantChatMessagesEndpoint,
    AssistantChatsEndpoint,
    AssistantMemoriesEndpoint,
    AssistantMemoryDetailEndpoint,
    InternalAssistantFileReadEndpoint,
    InternalAssistantMemorySearchEndpoint,
    InternalAssistantReportEndpoint,
)

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
        "workspaces/<str:slug>/assistant/balance/",
        AssistantBalanceEndpoint.as_view(),
        name="assistant-balance",
    ),
    path(
        "workspaces/<str:slug>/assistant/music-import/",
        AssistantMusicImportEndpoint.as_view(),
        name="assistant-music-import",
    ),
    path("workspaces/<str:slug>/assistant/chats/", AssistantChatsEndpoint.as_view(), name="assistant-chats"),
    path(
        "workspaces/<str:slug>/assistant/chats/<uuid:chat_id>/",
        AssistantChatDetailEndpoint.as_view(),
        name="assistant-chat-detail",
    ),
    path(
        "workspaces/<str:slug>/assistant/chats/<uuid:chat_id>/messages/",
        AssistantChatMessagesEndpoint.as_view(),
        name="assistant-chat-messages",
    ),
    path("workspaces/<str:slug>/assistant/memories/", AssistantMemoriesEndpoint.as_view(), name="assistant-memories"),
    path(
        "workspaces/<str:slug>/assistant/memories/<uuid:memory_id>/",
        AssistantMemoryDetailEndpoint.as_view(),
        name="assistant-memory-detail",
    ),
    # Worker callback (shared secret), answered as the asking user
    path(
        "internal/workspaces/<uuid:workspace_id>/assistant/memories/search/",
        InternalAssistantMemorySearchEndpoint.as_view(),
        name="internal-assistant-memory-search",
    ),
    path(
        "internal/workspaces/<uuid:workspace_id>/assistant/files/<uuid:asset_id>/read/",
        InternalAssistantFileReadEndpoint.as_view(),
        name="internal-assistant-file-read",
    ),
    path("workspaces/<str:slug>/assistant/actions/", AssistantActionsEndpoint.as_view(), name="assistant-actions"),
    path(
        "workspaces/<str:slug>/assistant/actions/<uuid:action_id>/undo/",
        AssistantActionUndoEndpoint.as_view(),
        name="assistant-action-undo",
    ),
    path(
        "internal/workspaces/<uuid:workspace_id>/assistant/report/",
        InternalAssistantReportEndpoint.as_view(),
        name="internal-assistant-report",
    ),
]
