# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Reading and rewriting an existing page for the assistant.

Reading turns the page into Markdown (see page_markdown). Writing goes
through the live collaboration server when it is configured, so whoever has
the page open sees the change and their editor doesn't save over it; without
it, the page's stored copy is replaced and the editor rebuilds from it the
next time it opens.
"""

import logging
import os

import requests
from django.conf import settings

from plane.db.models import ProjectMember, WorkspaceMember
from plane.utils.page_markdown import fingerprint, mention_targets, page_to_markdown

logger = logging.getLogger("plane.api")

# Member and admin may edit pages; guests may only read them.
EDIT_ROLE = 15


class PageUnavailable(Exception):
    pass


def live_url() -> str | None:
    """The live server as the API reaches it (its private address first)."""
    base = os.environ.get("LIVE_INTERNAL_URL") or getattr(settings, "LIVE_URL", None)
    return base.rstrip("/") if base else None


def find_page(ctx, user, page_id, for_edit=False):
    """The page and its project, if the user can open it (and edit it)."""
    from plane.utils.entities import REGISTRY

    definition = REGISTRY.get("page")
    page = (
        definition.visible(ctx).filter(id=page_id).first()
        if ctx is not None and definition is not None and definition.allows(ctx)
        else None
    )
    if page is None:
        raise PageUnavailable("Page not found.")
    project = page.projects.filter(deleted_at__isnull=True).first()
    if project is None:
        raise PageUnavailable("This page isn't in a project.")
    if for_edit:
        if not ProjectMember.objects.filter(
            project=project, member=user, is_active=True, role__gte=EDIT_ROLE
        ).exists():
            raise PageUnavailable("You can't edit pages in this project.")
        if page.access == 1 and page.owned_by_id != user.id:
            raise PageUnavailable("Only the owner can edit a private page.")
        if page.is_locked:
            raise PageUnavailable("The page is locked.")
        if page.archived_at:
            raise PageUnavailable("The page is archived.")
    return page, project


def mention_labels(ctx, html: str) -> dict:
    """{(kind, id): name} for the page's mentions the reader may see."""
    from plane.utils.entities import resolve_entities

    targets = mention_targets(html)
    labels = {}
    items = [{"entity_name": kind, "id": identifier} for kind, identifier in targets if kind != "user_mention"]
    for card in resolve_entities(ctx, items) if items else []:
        if card.get("status") == "ok" and card.get("title"):
            labels[(card["entity_name"], str(card["id"]).lower())] = card["title"]
    people = [identifier for kind, identifier in targets if kind == "user_mention"]
    if people:
        for member in WorkspaceMember.objects.filter(
            workspace_id=ctx.workspace_id, member_id__in=people
        ).select_related("member"):
            labels[("user_mention", str(member.member_id).lower())] = (
                member.member.display_name or member.member.first_name or "usuario"
            )
    return labels


def read_page(ctx, user, page_id) -> dict:
    page, project = find_page(ctx, user, page_id)
    html = page.description_html or ""
    markdown, kept = page_to_markdown(html, mention_labels(ctx, html))
    can_edit = True
    try:
        find_page(ctx, user, page_id, for_edit=True)
    except PageUnavailable:
        can_edit = False
    return {
        "id": str(page.id),
        "name": page.name,
        "project_id": str(project.id),
        "path": f"/{ctx.slug}/projects/{project.id}/pages/{page.id}/",
        "markdown": markdown,
        "kept_blocks": kept,
        "base_version": fingerprint(html),
        "can_edit": can_edit,
    }


def write_page_html(page, project, html: str, user, cookie: str) -> None:
    """Replaces the page's body with `html`."""
    from plane.bgtasks.page_transaction_task import page_transaction

    old_html = page.description_html
    base = live_url()
    secret = os.environ.get("LIVE_SERVER_SECRET_KEY", "")
    if base and secret and cookie:
        try:
            response = requests.post(
                f"{base}/pages/replace-content",
                json={
                    "page_id": str(page.id),
                    "workspace_slug": page.workspace.slug,
                    "project_id": str(project.id),
                    "html": html,
                    "cookie": cookie,
                    "user_id": str(user.id),
                },
                headers={"live-server-secret-key": secret},
                timeout=30,
            )
        except requests.RequestException as error:
            logger.error("live page replace unreachable: %s", error)
            raise PageUnavailable("The page couldn't be saved. Try again.")
        if response.status_code != 200:
            logger.error("live page replace failed: %s %s", response.status_code, response.text[:300])
            raise PageUnavailable("The page couldn't be saved. Try again.")
        # The live server stores it through the API (right away, or with the
        # next save of whoever has the page open)
    else:
        # No live server: replace the stored copy; the editor rebuilds from
        # the HTML the next time the page opens
        page.description_html = html
        page.description_binary = None
        page.save(update_fields=["description_html", "description_binary", "updated_at"])
    page_transaction.delay(new_description_html=html, old_description_html=old_html, page_id=str(page.id))
