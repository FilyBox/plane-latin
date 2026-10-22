# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""One-off, repeatable backfill for shared tags and references.

Insert-only and idempotent: it never edits or deletes an existing row of any
module. The only existing column it writes is the new, empty
file_tags.party_id. Run with --dry-run first to see the counts.

    python manage.py link_shared_tags --dry-run
    python manage.py link_shared_tags --workspace my-slug
"""

from django.core.management.base import BaseCommand
from django.db import transaction

from plane.db.models import (
    EntityTagLink,
    Expense,
    FileTag,
    Issue,
    IssueComment,
    MusicParty,
    Page,
    Workspace,
)

PARTY_TAG_KIND = {
    MusicParty.Kind.ARTIST: FileTag.Kind.ARTIST,
    MusicParty.Kind.GROUP: FileTag.Kind.GROUP,
    MusicParty.Kind.PERSON: FileTag.Kind.PERSON,
}


class Command(BaseCommand):
    help = "Link artist tags to the music catalog, copy expense tags and index existing mentions (insert-only)."

    def add_arguments(self, parser):
        parser.add_argument("--workspace", help="Workspace slug (default: all)")
        parser.add_argument("--dry-run", action="store_true", help="Count only, write nothing")

    def handle(self, *args, **options):
        dry = options["dry_run"]
        workspaces = Workspace.objects.all()
        if options.get("workspace"):
            workspaces = workspaces.filter(slug=options["workspace"])
        totals = {"tags_linked": 0, "tags_created": 0, "expense_links": 0, "mention_sources": 0, "mentions": 0}
        for workspace in workspaces:
            counts = self.workspace(workspace, dry)
            for key, value in counts.items():
                totals[key] += value
            if any(counts.values()):
                self.stdout.write(f"{workspace.slug}: {counts}")
        prefix = "[dry-run] " if dry else ""
        self.stdout.write(self.style.SUCCESS(f"{prefix}{totals}"))

    def workspace(self, workspace, dry):
        counts = {"tags_linked": 0, "tags_created": 0, "expense_links": 0, "mention_sources": 0, "mentions": 0}

        # 1. Catalog artists <-> artist tags (case-insensitive, like the
        #    contract pipeline). A tag already linked is left alone.
        tags_by_name = {tag.name.lower(): tag for tag in FileTag.objects.filter(workspace=workspace)}
        claimed = set(
            FileTag.objects.filter(workspace=workspace, party__isnull=False).values_list("party_id", flat=True)
        )
        for party in MusicParty.objects.filter(workspace=workspace, disabled=False, kind__in=list(PARTY_TAG_KIND)):
            if party.id in claimed:
                continue
            tag = tags_by_name.get(party.display_name.strip().lower())
            if tag is not None:
                if tag.party_id is None:
                    counts["tags_linked"] += 1
                    if not dry:
                        FileTag.objects.filter(id=tag.id, party__isnull=True).update(party=party)
                continue
            counts["tags_created"] += 1
            if not dry:
                created = FileTag.objects.create(
                    workspace=workspace,
                    name=" ".join(party.display_name.split())[:255],
                    kind=PARTY_TAG_KIND[party.kind],
                    party=party,
                )
                tags_by_name[created.name.lower()] = created

        # 2. Expense tag names -> shared tags. Expense.tags itself is untouched;
        #    category names (mirrored there) stay a category, not a tag.
        for expense in Expense.objects.filter(workspace=workspace).exclude(tags=[]).select_related("category"):
            category = expense.category.name.lower() if expense.category_id and expense.category else None
            for name in expense.tags or []:
                clean = " ".join(str(name).split())
                if not clean or clean.lower() == category:
                    continue
                tag = tags_by_name.get(clean.lower())
                if (
                    tag is not None
                    and EntityTagLink.objects.filter(tag=tag, entity_type="expense", entity_id=expense.id).exists()
                ):
                    continue
                counts["expense_links"] += 1
                if dry:
                    continue
                with transaction.atomic():
                    if tag is None:
                        tag = FileTag.objects.create(workspace=workspace, name=clean[:255], kind=FileTag.Kind.CUSTOM)
                        tags_by_name[tag.name.lower()] = tag
                    EntityTagLink.objects.get_or_create(
                        tag=tag,
                        entity_type="expense",
                        entity_id=expense.id,
                        deleted_at__isnull=True,
                        defaults={
                            "workspace": workspace,
                            "source": EntityTagLink.Source.IMPORT,
                            "status": EntityTagLink.Status.CONFIRMED,
                        },
                    )

        # 3. Mentions already written in work items, comments and pages.
        from plane.utils.references import extract_mentions, sync_mentions

        sources = (
            ("issue", Issue.objects.filter(workspace=workspace), "description_html"),
            ("issue_comment", IssueComment.objects.filter(workspace=workspace), "comment_html"),
            ("page", Page.objects.filter(workspace=workspace), "description_html"),
        )
        for source_type, queryset, field in sources:
            for source_id, html in queryset.filter(**{f"{field}__contains": "mention-component"}).values_list(
                "id", field
            ):
                found = extract_mentions(html or "")
                if not found:
                    continue
                counts["mention_sources"] += 1
                if dry:
                    counts["mentions"] += len(found)
                else:
                    counts["mentions"] += sync_mentions(workspace.id, source_type, source_id, html)["added"]
        return counts
