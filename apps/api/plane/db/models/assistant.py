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


class AssistantMemory(BaseModel):
    """Something the whole workspace's assistant should always know ("3BallMTY
    is the official spelling", "editorial contracts are reviewed by Ana").

    Shared by every member, written only by admins: the assistant can propose
    one from what a user said, an admin approves it. A correction never
    overwrites: the new memory `supersedes` the old one, which stays archived
    as history (Supermemory's "updates" relation, without automatic deletes).
    """

    class Kind(models.TextChoices):
        FACT = "FACT", "Fact"
        RULE = "RULE", "Rule"
        GLOSSARY = "GLOSSARY", "Glossary"
        OWNER = "OWNER", "Owner"
        CONTEXT = "CONTEXT", "Temporary context"

    class Status(models.TextChoices):
        PROPOSED = "PROPOSED", "Proposed"
        ACTIVE = "ACTIVE", "Active"
        REJECTED = "REJECTED", "Rejected"
        ARCHIVED = "ARCHIVED", "Archived"

    class Source(models.TextChoices):
        MANUAL = "MANUAL", "Manual"
        ASSISTANT = "ASSISTANT", "Assistant"

    workspace = models.ForeignKey("db.Workspace", on_delete=models.CASCADE, related_name="assistant_memories")
    kind = models.CharField(max_length=20, choices=Kind.choices, default=Kind.FACT)
    # The sentence injected into the prompt; kept short on purpose.
    content = models.CharField(max_length=300)
    # Other ways people say it ("el sello", "LMR"): matched against each
    # message without an LLM call.
    aliases = models.JSONField(default=list, blank=True)
    # Items it is about ([{"entity_name": "tag", "id": ...}]): pulled in when
    # the user looks at or mentions them, hidden from who can't open them.
    entities = models.JSONField(default=list, blank=True)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.PROPOSED)
    # Always in the prompt (at most a few dozen); the rest is retrieved.
    pinned = models.BooleanField(default=False)
    # Temporary context stops applying after this date.
    valid_until = models.DateField(null=True, blank=True)
    supersedes = models.ForeignKey(
        "self", on_delete=models.SET_NULL, null=True, blank=True, related_name="superseded_by"
    )
    source = models.CharField(max_length=20, choices=Source.choices, default=Source.MANUAL)
    source_chat = models.ForeignKey(
        "db.AssistantChat", on_delete=models.SET_NULL, null=True, blank=True, related_name="memories"
    )
    # The user's own words it came from (never a document's).
    evidence = models.TextField(blank=True)
    approved_by = models.ForeignKey(
        "db.User", on_delete=models.SET_NULL, null=True, blank=True, related_name="approved_assistant_memories"
    )
    approved_at = models.DateTimeField(null=True, blank=True)
    use_count = models.PositiveIntegerField(default=0)
    last_used_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        verbose_name = "Assistant Memory"
        verbose_name_plural = "Assistant Memories"
        db_table = "assistant_memories"
        ordering = ("-pinned", "kind", "created_at")
        indexes = [models.Index(fields=["workspace", "status"], name="assistant_memory_ws_status")]

    def __str__(self):
        return self.content[:60]


class AssistantMemoryRevision(BaseModel):
    """Every change to a memory, with a snapshot: audit and undo."""

    workspace = models.ForeignKey("db.Workspace", on_delete=models.CASCADE, related_name="assistant_memory_revisions")
    memory = models.ForeignKey("db.AssistantMemory", on_delete=models.CASCADE, related_name="revisions")
    action = models.CharField(max_length=30)
    snapshot = models.JSONField(default=dict)

    class Meta:
        verbose_name = "Assistant Memory Revision"
        verbose_name_plural = "Assistant Memory Revisions"
        db_table = "assistant_memory_revisions"
        ordering = ("-created_at",)
