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
    # The note injected into the prompt; kept short on purpose.
    content = models.CharField(max_length=500)
    # Longer notes: never injected on their own, read when the assistant
    # searches the memory (keeps every turn cheap).
    details = models.TextField(blank=True)
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


class AssistantAction(BaseModel):
    """A change the assistant made after the user approved it in a card.

    Stores what was asked and exactly what changed, so "Undo" reverts only
    that (and refuses when someone edited the result since). This is the
    shared log for every write the assistant can do.
    """

    class Kind(models.TextChoices):
        TAG_ITEMS = "TAG_ITEMS", "Tag items"
        UNTAG_ITEMS = "UNTAG_ITEMS", "Untag items"
        CREATE_WORK_ITEM = "CREATE_WORK_ITEM", "Create work item"
        CREATE_PAGE = "CREATE_PAGE", "Create page"
        EDIT_PAGE = "EDIT_PAGE", "Edit page"

    class Status(models.TextChoices):
        APPLIED = "APPLIED", "Applied"
        UNDONE = "UNDONE", "Undone"

    workspace = models.ForeignKey("db.Workspace", on_delete=models.CASCADE, related_name="assistant_actions")
    kind = models.CharField(max_length=30, choices=Kind.choices)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.APPLIED)
    # One line for the history ("Etiquetó 12 canciones con 3BallMTY").
    summary = models.CharField(max_length=300, blank=True)
    # What the user approved, and what actually changed (used to undo).
    payload = models.JSONField(default=dict)
    result = models.JSONField(default=dict)
    undone_at = models.DateTimeField(null=True, blank=True)
    undone_by = models.ForeignKey(
        "db.User", on_delete=models.SET_NULL, null=True, blank=True, related_name="undone_assistant_actions"
    )

    class Meta:
        verbose_name = "Assistant Action"
        verbose_name_plural = "Assistant Actions"
        db_table = "assistant_actions"
        ordering = ("-created_at",)


class AssistantDeepReview(BaseModel):
    """Every contract read by the AI against one question, launched from the
    assistant after an admin confirmed the estimate.

    The Worker fans the contracts out to parallel lanes; each finished
    contract lands as an item and adds to the counters here, so the chat card
    can show progress and spend live and the run can pause when it goes over
    the estimate.
    """

    class Status(models.TextChoices):
        DRAFT = "DRAFT", "Waiting for confirmation"
        SCHEDULED = "SCHEDULED", "Waiting for off-peak hours"
        RUNNING = "RUNNING", "Running"
        PAUSED = "PAUSED", "Paused: over the estimate"
        STOPPING = "STOPPING", "Stopping: answering with what was read"
        SYNTHESIZING = "SYNTHESIZING", "Writing the answer"
        COMPLETED = "COMPLETED", "Completed"
        PARTIAL = "PARTIAL", "Answered with part of the contracts"
        FAILED = "FAILED", "Failed"
        CANCELLED = "CANCELLED", "Cancelled"

    workspace = models.ForeignKey("db.Workspace", on_delete=models.CASCADE, related_name="assistant_deep_reviews")
    user = models.ForeignKey("db.User", on_delete=models.CASCADE, related_name="assistant_deep_reviews")
    # Short name for the card and the page ("Cláusulas de exclusividad").
    title = models.CharField(max_length=200, blank=True)
    # What every contract is checked against, self-contained.
    question = models.TextField()
    model = models.CharField(max_length=100, blank=True)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.DRAFT)
    off_peak = models.BooleanField(default=False)
    # "Continue with the rest" of a partial answer.
    parent = models.ForeignKey("self", on_delete=models.SET_NULL, null=True, blank=True, related_name="continuations")
    total_count = models.PositiveIntegerField(default=0)
    total_bytes = models.BigIntegerField(default=0)
    # Ranges per model and time window, computed by the Worker from the sizes.
    estimate = models.JSONField(default=dict)
    # The high end for the chosen model and window: the projection is
    # compared against it.
    estimate_usd = models.FloatField(null=True, blank=True)
    done_count = models.PositiveIntegerField(default=0)
    failed_count = models.PositiveIntegerField(default=0)
    done_bytes = models.BigIntegerField(default=0)
    spent_usd = models.FloatField(default=0)
    input_tokens = models.BigIntegerField(default=0)
    output_tokens = models.BigIntegerField(default=0)
    # Set once the admin chose to continue past the estimate.
    alerts_muted = models.BooleanField(default=False)
    pause_reason = models.CharField(max_length=40, blank=True)
    paused_at = models.DateTimeField(null=True, blank=True)
    summary = models.TextField(blank=True)
    error = models.JSONField(default=dict, blank=True)
    # What happened, in order ({"at", "kind", ...}): started, paused,
    # continued, stopped… shown as the review's process in the chat.
    events = models.JSONField(default=list, blank=True)
    workflow_instance_id = models.CharField(max_length=255, blank=True)
    started_at = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)
    emailed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        verbose_name = "Assistant Deep Review"
        verbose_name_plural = "Assistant Deep Reviews"
        db_table = "assistant_deep_reviews"
        ordering = ("-created_at",)

    def __str__(self):
        return self.question[:60]


class AssistantDeepReviewItem(BaseModel):
    """One contract of a deep review and what the AI found in it."""

    class Status(models.TextChoices):
        PENDING = "PENDING", "Pending"
        RUNNING = "RUNNING", "Being read"
        DONE = "DONE", "Done"
        FAILED = "FAILED", "Failed"

    workspace = models.ForeignKey("db.Workspace", on_delete=models.CASCADE, related_name="assistant_deep_review_items")
    review = models.ForeignKey("db.AssistantDeepReview", on_delete=models.CASCADE, related_name="items")
    contract = models.ForeignKey("db.Contract", on_delete=models.CASCADE, related_name="assistant_deep_review_items")
    # Size of the extracted text when the run started (octet_length).
    bytes = models.BigIntegerField(default=0)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.PENDING)
    matches = models.BooleanField(null=True, blank=True)
    confidence = models.PositiveSmallIntegerField(null=True, blank=True)
    reason = models.TextField(blank=True)
    # Short verbatim passage backing the answer.
    quote = models.TextField(blank=True)
    # Dates and artists as the AI read them in this contract.
    details = models.JSONField(default=dict, blank=True)
    # Kept after the final pass weeded out false positives.
    selected = models.BooleanField(default=False)
    chunks = models.PositiveSmallIntegerField(default=1)
    input_tokens = models.PositiveIntegerField(default=0)
    output_tokens = models.PositiveIntegerField(default=0)
    cost_usd = models.FloatField(default=0)
    error = models.CharField(max_length=500, blank=True)

    class Meta:
        verbose_name = "Assistant Deep Review Item"
        verbose_name_plural = "Assistant Deep Review Items"
        db_table = "assistant_deep_review_items"
        ordering = ("created_at",)
        constraints = [
            models.UniqueConstraint(
                fields=["review", "contract"],
                condition=models.Q(deleted_at__isnull=True),
                name="assistant_deep_review_item_unique",
            )
        ]
        indexes = [models.Index(fields=["review", "status"], name="assistant_deep_review_status")]
