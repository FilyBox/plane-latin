# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Workspace assistant conversations, stored per user so they follow them
across devices (they used to live in the browser's localStorage)."""

from django.db import models

from .base import BaseModel


class AssistantChat(BaseModel):
    workspace = models.ForeignKey("db.Workspace", on_delete=models.CASCADE, related_name="assistant_chats")
    user = models.ForeignKey("db.User", on_delete=models.CASCADE, related_name="assistant_chats")
    title = models.CharField(max_length=255, blank=True)

    class Meta:
        verbose_name = "Assistant Chat"
        verbose_name_plural = "Assistant Chats"
        db_table = "assistant_chats"
        ordering = ("-updated_at",)

    def __str__(self):
        return self.title or str(self.id)


class AssistantChatMessage(BaseModel):
    """One turn, as the assistant-ui / AI SDK UIMessage parts (text, reasoning
    and tool calls with their results), so a reopened chat replays its cards."""

    class Role(models.TextChoices):
        USER = "USER", "User"
        ASSISTANT = "ASSISTANT", "Assistant"

    workspace = models.ForeignKey("db.Workspace", on_delete=models.CASCADE, related_name="assistant_chat_messages")
    chat = models.ForeignKey("db.AssistantChat", on_delete=models.CASCADE, related_name="messages")
    role = models.CharField(max_length=20, choices=Role.choices)
    # Plain text of the turn, for titles and search.
    content = models.TextField(blank=True)
    parts = models.JSONField(default=list)
    # The client rewrites the whole transcript on each settled turn, so order
    # is explicit rather than by created_at.
    position = models.PositiveIntegerField(default=0)

    class Meta:
        verbose_name = "Assistant Chat Message"
        verbose_name_plural = "Assistant Chat Messages"
        db_table = "assistant_chat_messages"
        ordering = ("position",)
