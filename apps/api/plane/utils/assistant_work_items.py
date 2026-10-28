# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Work items read and edited by the assistant ("todas las tareas de Ana en
Lanzamientos", "pasa estas 5 a Hecho", "comenta en LAN-12 que…").

Edits take the path of Plane's own PATCH: the partial IssueCreateSerializer
and issue_activity with the current instance, so history, notifications and
webhooks behave as for a hand edit. Names ("Hecho", "Ana", "renovación") are
resolved in a dry run; an ambiguous one comes back with choices for the card.
Undo goes field by field and only where the value is still the assistant's,
recording the activity again. A comment is deleted only if nobody edited it.
"""

import json
from datetime import date

from django.core.serializers.json import DjangoJSONEncoder
from django.db.models import Q
from django.utils import timezone

from plane.db.models import (
    AssistantAction,
    Cycle,
    CycleIssue,
    Issue,
    IssueAssignee,
    IssueComment,
    IssueLabel,
    Label,
    Module,
    ModuleIssue,
    Project,
    ProjectMember,
    State,
    WorkspaceMember,
)
from plane.utils.assistant_actions import ActionError, register_undo
from plane.utils.assistant_undo import to_json
from plane.utils.assistant_workspace import register_apply

MEMBER = 15
MAX_ITEMS = 100
PRIORITIES = ("urgent", "high", "medium", "low", "none")
STATE_GROUPS = ("backlog", "unstarted", "started", "completed", "cancelled", "triage")
# Fields the serializer writes; cycle and modules have their own tables
SERIALIZED = ("name", "state_id", "priority", "start_date", "target_date", "parent_id", "description_html")
LISTS = ("assignee_ids", "label_ids")


def _norm(text) -> str:
    import unicodedata

    text = unicodedata.normalize("NFKD", str(text or "")).encode("ascii", "ignore").decode()
    return " ".join(text.lower().split())


def _visible(ctx):
    from plane.utils.entities import _visible_issues

    return _visible_issues(ctx)


def _key(issue) -> str:
    return f"{issue.project.identifier}-{issue.sequence_id}"


def _member_names(workspace_id) -> dict:
    rows = WorkspaceMember.objects.filter(workspace_id=workspace_id, is_active=True).select_related("member")
    return {str(row.member_id): row.member.display_name or row.member.first_name or row.member.email for row in rows}


# ----------------------------------------------------------------- reading


def _find_issues(ctx, query):
    """Issues by key ("LAN-12"), id or text, within what the viewer sees."""
    import re

    queryset = _visible(ctx)
    match = re.fullmatch(r"\s*([A-Za-z0-9]+)-(\d+)\s*", str(query or ""))
    if match:
        return queryset.filter(project__identifier__iexact=match.group(1), sequence_id=int(match.group(2)))
    try:
        from uuid import UUID

        UUID(str(query))
        return queryset.filter(id=query)
    except ValueError:
        return queryset.filter(name__icontains=str(query))


def _projects(ctx, value):
    projects = Project.objects.filter(
        workspace_id=ctx.workspace_id,
        project_projectmember__member=ctx.user,
        project_projectmember__is_active=True,
        archived_at__isnull=True,
    )
    if not value:
        return projects
    text = str(value).strip()
    return projects.filter(Q(identifier__iexact=text) | Q(name__icontains=text) | Q(id__in=_uuids([text])))


def _uuids(values):
    from uuid import UUID

    found = []
    for value in values:
        try:
            found.append(str(UUID(str(value))))
        except ValueError:
            continue
    return found


def _users(ctx, value):
    """Members matching a name, email, id or "me"."""
    text = str(value or "").strip()
    if text.lower() in {"me", "yo", "mí", "mi"}:
        return [str(ctx.user.id)]
    rows = WorkspaceMember.objects.filter(workspace_id=ctx.workspace_id, is_active=True).select_related("member")
    wanted = _norm(text)
    exact, partial = [], []
    for row in rows:
        user = row.member
        names = [user.display_name, user.first_name, f"{user.first_name} {user.last_name}", user.email, str(user.id)]
        normalised = [_norm(name) for name in names if name]
        if wanted in normalised:
            exact.append(str(user.id))
        elif any(wanted and wanted in name for name in normalised):
            partial.append(str(user.id))
    return exact or partial


def query_work_items(ctx, filters: dict) -> dict:
    filters = filters if isinstance(filters, dict) else {}
    queryset = _visible(ctx).select_related("project", "state", "parent").prefetch_related("assignees", "labels")
    if filters.get("project"):
        queryset = queryset.filter(project__in=_projects(ctx, filters["project"]))
    if filters.get("assignee"):
        queryset = queryset.filter(assignees__id__in=_users(ctx, filters["assignee"])).distinct()
    groups = [group for group in filters.get("state_group") or [] if group in STATE_GROUPS]
    if groups:
        queryset = queryset.filter(state__group__in=groups)
    if filters.get("state"):
        queryset = queryset.filter(state__name__iexact=str(filters["state"]))
    for label in filters.get("labels") or []:
        queryset = queryset.filter(labels__name__iexact=str(label)).distinct()
    for key, lookup in (("due_before", "target_date__lte"), ("due_after", "target_date__gte")):
        if filters.get(key):
            try:
                queryset = queryset.filter(**{lookup: date.fromisoformat(str(filters[key])[:10])})
            except ValueError:
                pass
    if filters.get("priority") in PRIORITIES:
        queryset = queryset.filter(priority=filters["priority"])
    if filters.get("text"):
        text = str(filters["text"])
        queryset = queryset.filter(Q(name__icontains=text) | Q(description_stripped__icontains=text))
    limit = max(1, min(int(filters.get("limit") or 50), MAX_ITEMS))
    total = queryset.count()
    names = _member_names(ctx.workspace_id)
    rows = []
    for issue in queryset.order_by("-updated_at")[:limit]:
        rows.append(
            {
                "id": str(issue.id),
                "key": _key(issue),
                "name": issue.name,
                "project": issue.project.name,
                "state": issue.state.name if issue.state else None,
                "state_group": issue.state.group if issue.state else None,
                "priority": issue.priority,
                "assignees": [names.get(str(user.id), user.display_name) for user in issue.assignees.all()],
                "labels": [label.name for label in issue.labels.all()],
                "start_date": to_json(issue.start_date),
                "target_date": to_json(issue.target_date),
                "parent": _key(issue.parent) if issue.parent_id and issue.parent else None,
                "path": f"/{ctx.slug}/browse/{_key(issue)}/",
            }
        )
    return {"total": total, "items": rows, "truncated": total > len(rows) or None}


# ------------------------------------------------------------- state now


def _cycle_id(issue):
    row = CycleIssue.objects.filter(issue=issue, deleted_at__isnull=True).first()
    return str(row.cycle_id) if row else None


def _module_ids(issue):
    return sorted(
        str(value)
        for value in ModuleIssue.objects.filter(issue=issue, deleted_at__isnull=True).values_list(
            "module_id", flat=True
        )
    )


def _now(issue) -> dict:
    """Every field the assistant may change, as plain JSON."""
    return {
        "name": issue.name,
        "state_id": to_json(issue.state_id),
        "priority": issue.priority,
        "start_date": to_json(issue.start_date),
        "target_date": to_json(issue.target_date),
        "parent_id": to_json(issue.parent_id),
        "description_html": issue.description_html,
        "assignee_ids": sorted(
            str(value)
            for value in IssueAssignee.objects.filter(issue=issue, deleted_at__isnull=True).values_list(
                "assignee_id", flat=True
            )
        ),
        "label_ids": sorted(
            str(value)
            for value in IssueLabel.objects.filter(issue=issue, deleted_at__isnull=True).values_list(
                "label_id", flat=True
            )
        ),
        "cycle_id": _cycle_id(issue),
        "module_ids": _module_ids(issue),
    }


# ---------------------------------------------------------------- dry run


def _pick(rows, wanted, label=lambda row: row.name):
    """One row by name; several close ones come back as choices."""
    text = _norm(wanted)
    exact = [row for row in rows if _norm(label(row)) == text]
    if len(exact) == 1:
        return exact[0], None
    partial = exact or [row for row in rows if text and text in _norm(label(row))]
    if len(partial) == 1:
        return partial[0], None
    return None, [{"id": str(row.id), "label": label(row)} for row in partial[:10]]


def _html(ctx, markdown: str) -> str:
    from plane.utils.assistant_actions import _page_mention_check
    from plane.utils.assistant_markdown import markdown_to_html
    from plane.utils.entities import REGISTRY

    markdown = str(markdown or "")[:50_000]
    return markdown_to_html(
        markdown,
        set(REGISTRY) | {"user_mention"},
        _page_mention_check(ctx, markdown),
        tag_href=lambda identifier: f"/{ctx.slug}/tags/{identifier}/",
    )


def _resolve(ctx, issue, wanted: dict, names: dict) -> tuple[list[dict], list[str]]:
    """The requested changes as rows {field, before, after, value, choices}."""
    project = issue.project
    now = _now(issue)
    rows, problems = [], []

    def row(field, value, after_label, before_label=None, choices=None):
        rows.append(
            {
                "field": field,
                "before": before_label,
                "after": after_label,
                "value": value,
                "choices": choices,
            }
        )

    if wanted.get("name"):
        name = " ".join(str(wanted["name"]).split())[:255]
        if name != issue.name:
            row("name", name, name, issue.name)
    if wanted.get("state"):
        states = list(State.objects.filter(project=project, deleted_at__isnull=True))
        state, choices = _pick(states, wanted["state"])
        if state is None and not choices:
            group = str(wanted["state"]).lower()
            in_group = [item for item in states if item.group == group]
            state, choices = (in_group[0], None) if len(in_group) == 1 else (None, None)
            if in_group and len(in_group) > 1:
                choices = [{"id": str(item.id), "label": item.name} for item in in_group]
        if state is None and not choices:
            problems.append(f"{_key(issue)}: state «{wanted['state']}» not found")
        elif state is None or str(state.id) != now["state_id"]:
            current = next((item.name for item in states if str(item.id) == now["state_id"]), None)
            row("state_id", str(state.id) if state else None, state.name if state else None, current, choices)
    if wanted.get("priority"):
        if wanted["priority"] not in PRIORITIES:
            problems.append(f"{_key(issue)}: priority «{wanted['priority']}» is not valid")
        elif wanted["priority"] != issue.priority:
            row("priority", wanted["priority"], wanted["priority"], issue.priority)
    for field in ("start_date", "target_date"):
        if field in wanted:
            value = wanted[field]
            if value:
                try:
                    value = date.fromisoformat(str(value)[:10]).isoformat()
                except ValueError:
                    problems.append(f"{_key(issue)}: {field} «{value}» is not a date")
                    continue
            value = value or None
            if value != now[field]:
                row(field, value, value, now[field])

    project_users = {
        str(value)
        for value in ProjectMember.objects.filter(project=project, is_active=True).values_list("member_id", flat=True)
    }
    for key, sign in (("assignees_add", 1), ("assignees_remove", -1)):
        for person in wanted.get(key) or []:
            found = [user_id for user_id in _users(ctx, person) if user_id in project_users]
            if len(found) != 1:
                if not found:
                    problems.append(f"{_key(issue)}: «{person}» is not a member of {project.name}")
                    continue
                row(
                    "assignee_ids",
                    None,
                    None,
                    None,
                    [{"id": user_id, "label": names.get(user_id, user_id)} for user_id in found[:10]],
                )
                rows[-1]["op"] = "add" if sign > 0 else "remove"
                continue
            user_id = found[0]
            if (user_id in now["assignee_ids"]) == (sign > 0):
                continue
            row("assignee_ids", user_id, names.get(user_id, user_id))
            rows[-1]["op"] = "add" if sign > 0 else "remove"

    labels = None
    for key, sign in (("labels_add", 1), ("labels_remove", -1)):
        for name in wanted.get(key) or []:
            if labels is None:
                labels = list(
                    Label.objects.filter(
                        Q(project=project) | Q(project__isnull=True, workspace_id=project.workspace_id)
                    )
                )
            label, choices = _pick(labels, name)
            if label is None and not choices:
                problems.append(f"{_key(issue)}: label «{name}» not found in {project.name}")
                continue
            if label is not None and (str(label.id) in now["label_ids"]) == (sign > 0):
                continue
            row("label_ids", str(label.id) if label else None, label.name if label else None, None, choices)
            rows[-1]["op"] = "add" if sign > 0 else "remove"

    if "cycle" in wanted:
        if not wanted["cycle"]:
            if now["cycle_id"]:
                row(
                    "cycle_id",
                    None,
                    None,
                    Cycle.objects.filter(id=now["cycle_id"]).values_list("name", flat=True).first(),
                )
        else:
            cycles = list(Cycle.objects.filter(project=project, archived_at__isnull=True))
            cycle, choices = _pick(cycles, wanted["cycle"])
            if cycle is None and not choices:
                problems.append(f"{_key(issue)}: cycle «{wanted['cycle']}» not found")
            elif cycle is not None and cycle.end_date and cycle.end_date < timezone.now():
                problems.append(f"{_key(issue)}: cycle «{cycle.name}» is already completed")
            elif cycle is None or str(cycle.id) != now["cycle_id"]:
                row("cycle_id", str(cycle.id) if cycle else None, cycle.name if cycle else None, None, choices)
    for name in wanted.get("modules_add") or []:
        modules = list(Module.objects.filter(project=project, archived_at__isnull=True))
        module, choices = _pick(modules, name)
        if module is None and not choices:
            problems.append(f"{_key(issue)}: module «{name}» not found")
        elif module is None or str(module.id) not in now["module_ids"]:
            row("module_ids", str(module.id) if module else None, module.name if module else None, None, choices)
            rows[-1]["op"] = "add"
    if "parent" in wanted:
        if not wanted["parent"]:
            if now["parent_id"]:
                row("parent_id", None, None, _key(issue.parent))
        else:
            parents = list(_find_issues(ctx, wanted["parent"]).filter(project=project).exclude(id=issue.id)[:10])
            parent, choices = (parents[0], None) if len(parents) == 1 else (None, None)
            if len(parents) > 1:
                choices = [{"id": str(item.id), "label": f"{_key(item)} {item.name}"} for item in parents]
            if parent is None and not choices:
                problems.append(f"{_key(issue)}: parent «{wanted['parent']}» not found in {project.name}")
            elif parent is None or str(parent.id) != now["parent_id"]:
                row("parent_id", str(parent.id) if parent else None, _key(parent) if parent else None, None, choices)
    if wanted.get("append_description"):
        html = _html(ctx, wanted["append_description"])
        row("description_append", html, str(wanted["append_description"])[:500])
    if wanted.get("description") is not None and wanted.get("rewrite_description") is True:
        html = _html(ctx, wanted["description"])
        row("description_html", html, str(wanted["description"])[:500], "…")
    return rows, problems


def update_preview(ctx, items) -> dict:
    items = [item for item in (items or []) if isinstance(item, dict)][:MAX_ITEMS]
    names = _member_names(ctx.workspace_id)
    result, problems = [], []
    editable = _editable_projects(ctx)
    for item in items:
        issues = list(_find_issues(ctx, item.get("issue_id")).select_related("project", "parent")[:2])
        if len(issues) != 1:
            problems.append(f"«{item.get('issue_id')}» {'is ambiguous' if issues else 'not found'}")
            continue
        issue = issues[0]
        if str(issue.project_id) not in editable:
            problems.append(f"{_key(issue)}: you can't edit work items in {issue.project.name}")
            continue
        rows, issue_problems = _resolve(ctx, issue, item.get("set") or {}, names)
        problems.extend(issue_problems)
        if rows:
            result.append(
                {
                    "issue_id": str(issue.id),
                    "key": _key(issue),
                    "name": issue.name,
                    "path": f"/{ctx.slug}/browse/{_key(issue)}/",
                    "changes": rows,
                }
            )
    return {"items": result, "problems": problems or None}


def _editable_projects(ctx) -> set:
    return {
        str(value)
        for value in ProjectMember.objects.filter(
            project__workspace_id=ctx.workspace_id, member=ctx.user, is_active=True, role__gte=MEMBER
        ).values_list("project_id", flat=True)
    }


# ------------------------------------------------------------------ write


def _patch(issue, desired: dict, user, origin):
    """Writes the fields like Plane's PATCH (serializer + activity), and the
    cycle and modules like their own endpoints."""
    from plane.app.serializers import IssueCreateSerializer
    from plane.bgtasks.issue_activities_task import issue_activity
    from plane.bgtasks.webhook_task import model_activity

    now = _now(issue)
    epoch = int(timezone.now().timestamp())
    data = {field: desired[field] for field in (*SERIALIZED, *LISTS) if field in desired}
    if data:
        current_instance = json.dumps({field: now[field] for field in data}, cls=DjangoJSONEncoder)
        serializer = IssueCreateSerializer(issue, data=data, partial=True, context={"project_id": issue.project_id})
        if not serializer.is_valid():
            raise ActionError(f"{_key(issue)}: {json.dumps(serializer.errors)[:250]}")
        serializer.save()
        issue_activity.delay(
            type="issue.activity.updated",
            requested_data=json.dumps(data, cls=DjangoJSONEncoder),
            actor_id=str(user.id),
            issue_id=str(issue.id),
            project_id=str(issue.project_id),
            current_instance=current_instance,
            epoch=epoch,
            notification=True,
            origin=origin,
        )
        model_activity.delay(
            model_name="issue",
            model_id=str(issue.id),
            requested_data=data,
            current_instance=current_instance,
            actor_id=user.id,
            slug=issue.workspace.slug,
            origin=origin,
        )
    if "cycle_id" in desired and desired["cycle_id"] != now["cycle_id"]:
        _set_cycle(issue, now["cycle_id"], desired["cycle_id"], user, origin, epoch)
    if "module_ids" in desired:
        _set_modules(issue, now["module_ids"], desired["module_ids"], user, origin, epoch)


def _set_cycle(issue, old, new, user, origin, epoch):
    from plane.bgtasks.issue_activities_task import issue_activity

    if old:
        issue_activity.delay(
            type="cycle.activity.deleted",
            requested_data=json.dumps({"cycle_id": old, "issues": [str(issue.id)]}),
            actor_id=str(user.id),
            issue_id=str(issue.id),
            project_id=str(issue.project_id),
            current_instance=None,
            epoch=epoch,
            notification=True,
            origin=origin,
        )
        CycleIssue.objects.filter(issue=issue).delete()
    if new:
        record = CycleIssue.objects.create(
            project_id=issue.project_id,
            workspace_id=issue.workspace_id,
            cycle_id=new,
            issue=issue,
            created_by=user,
            updated_by=user,
        )
        from django.core import serializers

        issue_activity.delay(
            type="cycle.activity.created",
            requested_data=json.dumps({"cycles_list": [str(issue.id)]}),
            actor_id=str(user.id),
            issue_id=None,
            project_id=str(issue.project_id),
            current_instance=json.dumps(
                {"updated_cycle_issues": [], "created_cycle_issues": serializers.serialize("json", [record])}
            ),
            epoch=epoch,
            notification=True,
            origin=origin,
        )


def _set_modules(issue, old, new, user, origin, epoch):
    from plane.bgtasks.issue_activities_task import issue_activity

    for module_id in sorted(set(new) - set(old)):
        ModuleIssue.objects.create(
            issue=issue,
            module_id=module_id,
            project_id=issue.project_id,
            workspace_id=issue.workspace_id,
            created_by=user,
            updated_by=user,
        )
        issue_activity.delay(
            type="module.activity.created",
            requested_data=json.dumps({"module_id": module_id}),
            actor_id=str(user.id),
            issue_id=str(issue.id),
            project_id=str(issue.project_id),
            current_instance=None,
            epoch=epoch,
            notification=True,
            origin=origin,
        )
    for module_id in sorted(set(old) - set(new)):
        issue_activity.delay(
            type="module.activity.deleted",
            requested_data=json.dumps({"module_id": module_id, "issues": [str(issue.id)]}),
            actor_id=str(user.id),
            issue_id=str(issue.id),
            project_id=str(issue.project_id),
            current_instance=json.dumps({"module_name": Module.objects.get(id=module_id).name}),
            epoch=epoch,
            notification=True,
            origin=origin,
        )
        ModuleIssue.objects.filter(issue=issue, module_id=module_id).delete()


def _desired(issue, now, changes, project):
    """The changes the card sent (ids, checked again) as final values."""
    desired = {}
    states = None
    for change in changes:
        field, value, op = change.get("field"), change.get("value"), change.get("op")
        if field == "name" and value:
            desired["name"] = " ".join(str(value).split())[:255]
        elif field == "state_id":
            states = states or {
                str(item) for item in State.objects.filter(project=project).values_list("id", flat=True)
            }
            if str(value) not in states:
                raise ActionError(f"{_key(issue)}: choose a state.")
            desired["state_id"] = str(value)
        elif field == "priority" and value in PRIORITIES:
            desired["priority"] = value
        elif field in ("start_date", "target_date"):
            desired[field] = date.fromisoformat(str(value)[:10]).isoformat() if value else None
        elif field == "assignee_ids":
            if not ProjectMember.objects.filter(project=project, member_id=value, is_active=True).exists():
                raise ActionError(f"{_key(issue)}: choose a project member.")
            current = set(desired.get("assignee_ids", now["assignee_ids"]))
            current = current | {str(value)} if op != "remove" else current - {str(value)}
            desired["assignee_ids"] = sorted(current)
        elif field == "label_ids":
            if not Label.objects.filter(
                Q(project=project) | Q(project__isnull=True, workspace_id=project.workspace_id), id=value
            ).exists():
                raise ActionError(f"{_key(issue)}: choose a label.")
            current = set(desired.get("label_ids", now["label_ids"]))
            current = current | {str(value)} if op != "remove" else current - {str(value)}
            desired["label_ids"] = sorted(current)
        elif field == "cycle_id":
            if value and not Cycle.objects.filter(project=project, id=value).exists():
                raise ActionError(f"{_key(issue)}: choose a cycle.")
            desired["cycle_id"] = str(value) if value else None
        elif field == "module_ids":
            if not Module.objects.filter(project=project, id=value).exists():
                raise ActionError(f"{_key(issue)}: choose a module.")
            desired["module_ids"] = sorted(set(desired.get("module_ids", now["module_ids"])) | {str(value)})
        elif field == "parent_id":
            if value and not Issue.issue_objects.filter(project=project, id=value).exclude(id=issue.id).exists():
                raise ActionError(f"{_key(issue)}: choose a parent work item.")
            desired["parent_id"] = str(value) if value else None
        elif field == "description_append" and value:
            desired["description_html"] = desired.get("description_html", issue.description_html or "") + str(value)
        elif field == "description_html" and value:
            desired["description_html"] = str(value)
    return desired


@register_apply(AssistantAction.Kind.EDIT_WORK_ITEMS)
def edit_work_items(ctx, request, data) -> AssistantAction:
    from plane.utils.host import base_host

    items = [item for item in (data.get("items") or []) if isinstance(item, dict)][:MAX_ITEMS]
    if not items:
        raise ActionError("Nothing to change.")
    origin = base_host(request=request, is_app=True)
    editable = _editable_projects(ctx)
    issues = {
        str(issue.id): issue
        for issue in _visible(ctx)
        .select_related("project", "workspace")
        .filter(id__in=_uuids([item.get("issue_id") for item in items]))
    }
    edited = []
    for item in items:
        issue = issues.get(str(item.get("issue_id")))
        if issue is None:
            raise ActionError("A work item was not found or you can't see it.")
        if str(issue.project_id) not in editable:
            raise ActionError(f"You can't edit work items in {issue.project.name}.")
        before = _now(issue)
        desired = _desired(issue, before, item.get("changes") or [], issue.project)
        desired = {field: value for field, value in desired.items() if value != before.get(field)}
        if not desired:
            continue
        _patch(issue, desired, request.user, origin)
        issue.refresh_from_db()
        after = _now(issue)
        edited.append(
            {
                "issue_id": str(issue.id),
                "key": _key(issue),
                "name": issue.name,
                "changes": [
                    {"field": field, "before": before[field], "after": after[field]}
                    for field in desired
                    if before[field] != after[field]
                ],
            }
        )
    if not edited:
        raise ActionError("The work items already have those values.")
    summary = f"Editó {edited[0]['key']}: {edited[0]['name']}" if len(edited) == 1 else f"Editó {len(edited)} tareas"
    return AssistantAction.objects.create(
        workspace_id=ctx.workspace_id,
        kind=AssistantAction.Kind.EDIT_WORK_ITEMS,
        summary=summary[:300],
        payload=data,
        result={"items": edited},
    )


@register_undo(AssistantAction.Kind.EDIT_WORK_ITEMS)
def undo_edit_work_items(action, user, origin, cookie):
    rows = (action.result or {}).get("items") or []
    issues = {
        str(issue.id): issue
        for issue in Issue.issue_objects.select_related("project", "workspace").filter(
            workspace_id=action.workspace_id, id__in=[row["issue_id"] for row in rows]
        )
    }
    conflicts = []
    for row in rows:
        issue = issues.get(row["issue_id"])
        if issue is None:
            continue
        now = _now(issue)
        desired = {}
        for change in row["changes"]:
            if now.get(change["field"]) != change["after"]:
                conflicts.append(
                    {
                        "issue_id": row["issue_id"],
                        "key": row["key"],
                        "field": change["field"],
                        "expected": change["after"],
                        "current": now.get(change["field"]),
                    }
                )
                continue
            desired[change["field"]] = change["before"]
        if desired:
            _patch(issue, desired, user, origin)
    return {"conflicts": conflicts} if conflicts else None


# ---------------------------------------------------------------- comment


def comment_preview(ctx, issue_ref, markdown) -> dict:
    issues = list(_find_issues(ctx, issue_ref).select_related("project")[:2])
    if len(issues) != 1:
        raise ActionError(f"«{issue_ref}» {'is ambiguous' if issues else 'was not found'}.")
    issue = issues[0]
    return {
        "issue_id": str(issue.id),
        "key": _key(issue),
        "name": issue.name,
        "path": f"/{ctx.slug}/browse/{_key(issue)}/",
        "comment_html": _html(ctx, markdown),
        "markdown": str(markdown or "")[:50_000],
    }


@register_apply(AssistantAction.Kind.COMMENT_WORK_ITEM)
def comment_work_item(ctx, request, data) -> AssistantAction:
    from plane.app.serializers import IssueCommentSerializer
    from plane.bgtasks.issue_activities_task import issue_activity
    from plane.bgtasks.webhook_task import model_activity
    from plane.utils.host import base_host

    issue = _visible(ctx).select_related("project").filter(id__in=_uuids([data.get("issue_id")])).first()
    if issue is None:
        raise ActionError("Work item not found.")
    member = ProjectMember.objects.filter(project=issue.project, member=request.user, is_active=True).first()
    if member is None or (
        member.role < MEMBER and not issue.project.guest_view_all_features and issue.created_by_id != request.user.id
    ):
        raise ActionError("You can't comment on this work item.")
    html = _html(ctx, data.get("markdown"))
    if not html or html == "<p></p>":
        raise ActionError("The comment is empty.")
    serializer = IssueCommentSerializer(data={"comment_html": html})
    if not serializer.is_valid():
        raise ActionError(json.dumps(serializer.errors)[:300])
    serializer.save(project_id=issue.project_id, issue_id=issue.id, actor=request.user)
    origin = base_host(request=request, is_app=True)
    issue_activity.delay(
        type="comment.activity.created",
        requested_data=json.dumps(serializer.data, cls=DjangoJSONEncoder),
        actor_id=str(request.user.id),
        issue_id=str(issue.id),
        project_id=str(issue.project_id),
        current_instance=None,
        epoch=int(timezone.now().timestamp()),
        notification=True,
        origin=origin,
    )
    model_activity.delay(
        model_name="issue_comment",
        model_id=str(serializer.data["id"]),
        requested_data={"comment_html": html},
        current_instance=None,
        actor_id=request.user.id,
        slug=ctx.slug,
        origin=origin,
    )
    return AssistantAction.objects.create(
        workspace_id=ctx.workspace_id,
        kind=AssistantAction.Kind.COMMENT_WORK_ITEM,
        summary=f"Comentó en {_key(issue)}: {issue.name}"[:300],
        payload=data,
        result={
            "issue_id": str(issue.id),
            "key": _key(issue),
            "comment_id": str(serializer.data["id"]),
            "path": f"/{ctx.slug}/browse/{_key(issue)}/",
        },
    )


@register_undo(AssistantAction.Kind.COMMENT_WORK_ITEM)
def undo_comment(action, user, origin, cookie):
    from plane.app.serializers import IssueCommentSerializer
    from plane.bgtasks.issue_activities_task import issue_activity

    result = action.result or {}
    comment = IssueComment.objects.filter(workspace_id=action.workspace_id, id=result.get("comment_id")).first()
    if comment is None:
        return None
    if comment.edited_at is not None:
        raise ActionError("Someone edited this comment; delete it from the work item itself.")
    current_instance = json.dumps(IssueCommentSerializer(comment).data, cls=DjangoJSONEncoder)
    comment.delete()
    issue_activity.delay(
        type="comment.activity.deleted",
        requested_data=json.dumps({"comment_id": str(comment.id)}),
        actor_id=str(user.id),
        issue_id=str(comment.issue_id),
        project_id=str(comment.project_id),
        current_instance=current_instance,
        epoch=int(timezone.now().timestamp()),
        notification=True,
        origin=origin,
    )
    return None
