# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Cross-module links: references between any two entities, shared tags on
any entity, and the AI runs that suggest both.

Entities are addressed by registry type + UUID (see plane.utils.entities)
rather than foreign keys, the way PageLog, Notification and UserFavorite do it:
removing a link never touches either side, and deleting an entity never
cascades into the work items or pages that mention it.
"""

from django.db import models
from django.db.models import Q

from .base import BaseModel


class EntityReference(BaseModel):
    """`source` mentions or attaches `target` — read in both directions."""

    class Kind(models.TextChoices):
        MENTION = "mention", "Mention"
        ATTACHMENT = "attachment", "Attachment"

    workspace = models.ForeignKey("db.Workspace", on_delete=models.CASCADE, related_name="entity_references")
    source_type = models.CharField(max_length=40)
    source_id = models.UUIDField()
    target_type = models.CharField(max_length=40)
    target_id = models.UUIDField()
    kind = models.CharField(max_length=20, choices=Kind.choices, default=Kind.MENTION)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["source_type", "source_id", "target_type", "target_id", "kind"],
                condition=Q(deleted_at__isnull=True),
                name="unique_entity_reference_when_not_deleted",
            )
        ]
        indexes = [
            models.Index(fields=["workspace", "target_type", "target_id"], name="entity_ref_target_idx"),
            models.Index(fields=["workspace", "source_type", "source_id"], name="entity_ref_source_idx"),
        ]
        verbose_name = "Entity Reference"
        verbose_name_plural = "Entity References"
        db_table = "entity_references"
        ordering = ("-created_at",)

    def __str__(self):
        return f"{self.source_type}:{self.source_id} -> {self.target_type}:{self.target_id}"


class TaggingRun(BaseModel):
    """One AI scan of the workspace. Everything it proposes points back here,
    so a whole run can be reviewed, applied or undone at once."""

    class Status(models.TextChoices):
        QUEUED = "QUEUED", "Queued"
        RUNNING = "RUNNING", "Running"
        REVIEW = "REVIEW", "Ready for review"
        COMPLETED = "COMPLETED", "Completed"
        FAILED = "FAILED", "Failed"
        CANCELLED = "CANCELLED", "Cancelled"
        UNDONE = "UNDONE", "Undone"

    workspace = models.ForeignKey("db.Workspace", on_delete=models.CASCADE, related_name="tagging_runs")
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.QUEUED)
    # Entity types scanned and options (e.g. {"types": [...], "vision": false})
    scope = models.JSONField(default=dict, blank=True)
    provider = models.CharField(max_length=60, blank=True)
    workflow_instance_id = models.CharField(max_length=255, blank=True)
    progress = models.JSONField(default=dict, blank=True)
    summary = models.JSONField(default=dict, blank=True)
    error = models.TextField(blank=True)
    started_at = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        verbose_name = "Tagging Run"
        verbose_name_plural = "Tagging Runs"
        db_table = "tagging_runs"
        ordering = ("-created_at",)

    def __str__(self):
        return f"{self.workspace_id} {self.status}"


class EntityTagLink(BaseModel):
    """A shared tag (FileTag) on any registered entity.

    Files keep their original FileTagLink rows; this table is where every
    module — files included — reads and writes shared tags from now on.
    """

    class Source(models.TextChoices):
        MANUAL = "manual", "Manual"
        AI = "ai", "AI"
        IMPORT = "import", "Import"
        SYSTEM = "system", "System"

    class Status(models.TextChoices):
        CONFIRMED = "confirmed", "Confirmed"
        SUGGESTED = "suggested", "Suggested"

    workspace = models.ForeignKey("db.Workspace", on_delete=models.CASCADE, related_name="entity_tag_links")
    tag = models.ForeignKey("db.FileTag", on_delete=models.CASCADE, related_name="entity_links")
    entity_type = models.CharField(max_length=40)
    entity_id = models.UUIDField()
    source = models.CharField(max_length=20, choices=Source.choices, default=Source.MANUAL)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.CONFIRMED)
    confidence = models.FloatField(null=True, blank=True)
    run = models.ForeignKey("db.TaggingRun", on_delete=models.SET_NULL, null=True, blank=True, related_name="tag_links")
    # Why the AI proposed it, shown in the review screen
    reason = models.CharField(max_length=500, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["tag", "entity_type", "entity_id"],
                condition=Q(deleted_at__isnull=True),
                name="unique_entity_tag_link_when_not_deleted",
            )
        ]
        indexes = [
            models.Index(fields=["workspace", "entity_type", "entity_id"], name="entity_tag_entity_idx"),
            models.Index(fields=["workspace", "tag", "status"], name="entity_tag_tag_idx"),
        ]
        verbose_name = "Entity Tag Link"
        verbose_name_plural = "Entity Tag Links"
        db_table = "entity_tag_links"
        ordering = ("-created_at",)

    def __str__(self):
        return f"{self.tag_id} -> {self.entity_type}:{self.entity_id}"
