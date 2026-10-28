# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Contract templates edited by the assistant.

The assistant never touches Word or Collabora: it proposes text operations
("replace «Juan Pérez» with {{NombreArtista}}") and Django applies them to the
.docx bytes with plane/utils/docx_edit.py, which keeps every format and
refuses anything else.

Saving never alters what exists:
- by default the result is a NEW variant of the same template (with its
  revision 1), copied from the variant or revision used as base;
- editing an existing variant (only when the person asked for it) adds a new
  revision and leaves the earlier ones, and the requests built on them, as
  they were; it is refused while someone has a Word draft open on it.
"""

import hashlib
from datetime import timedelta

from django.db import IntegrityError, transaction
from django.db.models import Q
from django.utils import timezone

from plane.db.models import (
    AssistantAction,
    ContractSignatureRequest,
    ContractTemplate,
    ContractTemplateRevision,
    ContractTemplateVariant,
    FileAsset,
)
from plane.utils.assistant_actions import ActionError, register_undo
from plane.utils.assistant_workspace import register_apply
from plane.utils.docx_edit import EditError, NotPreserved, apply_edits, docx_outline, verify_preserved

ADMIN = 20


def _workflow():
    from plane.app.views.contract import workflow

    return workflow


def can_edit(ctx) -> bool:
    # Contracts and their templates are for workspace admins only
    return ctx is not None and ctx.role >= ADMIN and "file_library" in ctx.features


def _require(ctx):
    if not can_edit(ctx):
        raise ActionError("Only workspace admins can change contract templates.")


# ----------------------------------------------------------------- reading


def _user_name(user_id):
    if not user_id:
        return None
    from plane.db.models import User

    user = User.objects.filter(id=user_id).first()
    return (user.display_name or user.first_name or user.email) if user else None


def template_list(workspace_id, query: str = "") -> list[dict]:
    templates = ContractTemplate.objects.filter(workspace_id=workspace_id, is_active=True).prefetch_related(
        "variants__revisions"
    )
    if query:
        templates = templates.filter(Q(name__icontains=query) | Q(variants__name__icontains=query)).distinct()
    rows = []
    for template in templates.order_by("name")[:50]:
        variants = []
        for variant in template.variants.all():
            revisions = sorted(variant.revisions.all(), key=lambda item: -item.revision)
            latest = revisions[0] if revisions else None
            schema = (latest.variable_schema if latest else {}) or {}
            variants.append(
                {
                    "variant_id": str(variant.id),
                    "name": variant.name,
                    "is_default": variant.is_default,
                    "generated_by_assistant": (variant.origin or {}).get("by") == "assistant" or None,
                    "revisions": [
                        {
                            "revision": item.revision,
                            "name": item.name or None,
                            "created_at": item.created_at.date().isoformat(),
                        }
                        for item in revisions[:10]
                    ],
                    "variables": [item["key"] for item in schema.get("variables") or []],
                    "signers": len(schema.get("recipients") or []),
                    "recipient_roles": variant.recipient_roles or None,
                    "draft_open": bool(variant.draft_asset_id) or None,
                }
            )
        rows.append(
            {
                "template_id": str(template.id),
                "name": template.name,
                "description": template.description or None,
                "variants": variants,
            }
        )
    return rows


def find_variant(workspace_id, variant_id):
    try:
        return (
            ContractTemplateVariant.objects.select_related("template", "source_asset", "workspace")
            .filter(workspace_id=workspace_id, id=variant_id, template__is_active=True)
            .first()
        )
    except Exception:
        return None


def base_source(variant, revision_number=None):
    """The Word file the assistant works on: a given revision, or what is
    published on the variant (an unpublished Word draft is never used)."""
    workflow = _workflow()
    if revision_number:
        revision = (
            ContractTemplateRevision.objects.filter(variant=variant, revision=int(revision_number))
            .select_related("source_asset")
            .first()
        )
        if revision is None:
            raise ActionError(f"Version {revision_number} does not exist in this variant.")
        data = workflow._read_asset(revision.source_asset)
    else:
        revision = ContractTemplateRevision.objects.filter(variant=variant).order_by("-revision").first()
        data = workflow._read_asset(variant.source_asset)
    return data, {
        "variant_id": str(variant.id),
        "variant_name": variant.name,
        "template_id": str(variant.template_id),
        "template_name": variant.template.name,
        "revision": revision.revision if revision_number and revision else None,
        "latest_revision": revision.revision if revision and not revision_number else None,
        "base_sha256": hashlib.sha256(data).hexdigest(),
        "has_unpublished_draft": bool(variant.draft_asset_id) or None,
    }


def template_outline(variant, revision_number=None) -> dict:
    from plane.integrations.contract_docx import analyse_docx_variables, analyse_docx_warnings

    data, base = base_source(variant, revision_number)
    schema = analyse_docx_variables(data)
    return {
        "base": base,
        **docx_outline(data),
        "schema": schema,
        "variable_settings": variant.variable_settings or {},
        "recipient_roles": variant.recipient_roles or {},
        "warnings": analyse_docx_warnings(data, schema, variant.signature_blueprint),
        "manual_fields": len(variant.signature_blueprint or []) or None,
    }


def _edited(data, edits):
    """Applies and verifies; any problem becomes an ActionError the card shows."""
    try:
        result, report = apply_edits(data, edits)
        verification = verify_preserved(data, result, report)
    except NotPreserved as error:
        raise ActionError(str(error))
    except EditError as error:
        raise TemplateEditError(error)
    return result, report, verification


class TemplateEditError(ActionError):
    """An edit that can't apply, with where the anchor was found."""

    def __init__(self, error: EditError):
        super().__init__(str(error))
        self.detail = error.as_dict()


def _suggested_settings(variant, report, schema_after, extra=None):
    """The variant's variable settings after the edit: renamed tokens keep
    theirs, values written in capitals stay in capitals, new variables get a
    readable label, and what the assistant proposed goes on top."""
    workflow = _workflow()
    settings = dict(variant.variable_settings or {})
    for old, new in (report.get("renamed_tokens") or {}).items():
        if old in settings and new not in settings:
            settings[new] = settings.pop(old)
    known = {item["key"]: item for item in schema_after.get("variables") or []}
    for key, item in known.items():
        if key not in settings:
            settings[key] = {"label": item["label"], "required": True}
    for key in report.get("upper_tokens") or []:
        if key in known:
            settings[key] = {**settings.get(key, {}), "case": "upper"}
    if isinstance(extra, dict):
        for key, value in extra.items():
            if isinstance(value, dict):
                settings[str(key)] = {**settings.get(str(key), {}), **value}
    try:
        return workflow._normalise_variable_settings(settings)
    except ValueError as error:
        raise ActionError(str(error))


def _roles(variant, extra):
    roles = dict(variant.recipient_roles or {})
    if isinstance(extra, dict):
        roles.update({str(key): value for key, value in extra.items()})
    try:
        return _workflow()._normalise_recipient_roles(roles)
    except ValueError as error:
        raise ActionError(str(error))


def dry_run(variant, revision_number, edits, variable_settings=None) -> dict:
    """What applying the edits would do, without saving anything."""
    from plane.integrations.contract_docx import analyse_docx_variables, analyse_docx_warnings, schema_changes

    data, base = base_source(variant, revision_number)
    result, report, verification = _edited(data, edits)
    before, after = analyse_docx_variables(data), analyse_docx_variables(result)
    return {
        "base": base,
        "operations": report["operations"],
        "warnings": report["warnings"],
        "document_warnings": analyse_docx_warnings(result, after, variant.signature_blueprint),
        "schema_changes": schema_changes(before, after),
        "schema": after,
        "variable_settings": _suggested_settings(variant, report, after, variable_settings),
        "renamed_tokens": report["renamed_tokens"],
        "upper_tokens": report["upper_tokens"],
        "verification": verification,
        "manual_fields": len(variant.signature_blueprint or []) or None,
    }


def preview(variant, revision_number, edits):
    """The edited Word as a PDF (cached by content, like every conversion),
    plus a note when the number of pages changed."""
    workflow = _workflow()
    data, _ = base_source(variant, revision_number)
    result, _, _ = _edited(data, edits)
    pdf = workflow._pdf_for_content(variant.workspace, result, f"{variant.name}.docx", store=True)
    if not pdf:
        raise ActionError("Collabora could not convert the edited Word to PDF.")
    base_pdf = workflow._pdf_for_content(variant.workspace, data, f"{variant.name}.docx", store=True)
    note = None
    if base_pdf:
        before = workflow._pdf_layout_signature(base_pdf).get("page_count")
        after = workflow._pdf_layout_signature(pdf).get("page_count")
        if before and after and before != after:
            note = f"page_count:{before}->{after}"
    return pdf, note


# ----------------------------------------------------------------- saving


def _unique_name(template, name: str) -> str:
    name = " ".join(str(name or "").split())[:240] or "Variante del asistente"
    taken = {value.lower() for value in template.variants.values_list("name", flat=True)}
    candidate, number = name, 2
    while candidate.lower() in taken:
        candidate = f"{name} ({number})"
        number += 1
    return candidate


def _checked_base(ctx, data):
    _require(ctx)
    base = data.get("base") if isinstance(data.get("base"), dict) else {}
    variant = find_variant(ctx.workspace_id, base.get("variant_id"))
    if variant is None:
        raise ActionError("Template variant not found.")
    source, info = base_source(variant, base.get("revision"))
    if data.get("base_sha256") and data["base_sha256"] != info["base_sha256"]:
        raise ActionError("The template changed after the assistant read it. Ask it to read it again.")
    edits = data.get("edits") if isinstance(data.get("edits"), list) else []
    return variant, base.get("revision"), source, edits, info


def _converted(variant, content, name):
    pdf = _workflow()._pdf_for_content(variant.workspace, content, name, store=False)
    if not pdf:
        raise ActionError("Collabora could not convert the edited Word to PDF; nothing was saved.")
    return pdf


def _upload_word(variant, user, content, name, uploaded):
    workflow = _workflow()
    return workflow._create_asset(
        workspace=variant.workspace,
        user=user,
        key=workflow._asset_key(variant.workspace_id, "variants", "docx"),
        name=name,
        mime_type=workflow.DOCX_MIME,
        content=content,
        entity_type=FileAsset.EntityTypeContext.CONTRACT_TEMPLATE,
        track=uploaded,
    )


def _summary_payload(report, verification, schema_changes):
    return {
        "operations": len(report["operations"]),
        "verification": verification,
        "schema_changes": schema_changes,
        "warnings": report["warnings"],
    }


@register_apply(AssistantAction.Kind.CREATE_TEMPLATE_VARIANT)
def create_template_variant(ctx, request, data) -> AssistantAction:
    """A new variant of the same template with the edits; the base stays."""
    from plane.integrations.contract_docx import analyse_docx_variables, schema_changes

    workflow = _workflow()
    variant, revision_number, source, edits, info = _checked_base(ctx, data)
    result, report, verification = _edited(source, edits)
    after = analyse_docx_variables(result)
    changes = schema_changes(analyse_docx_variables(source), after)
    settings = _suggested_settings(variant, report, after, data.get("variable_settings"))
    roles = _roles(variant, data.get("recipient_roles"))
    template = variant.template
    name = _unique_name(template, data.get("name") or f"{variant.name} – cambios del asistente")
    pdf = _converted(variant, result, f"{name}.docx")
    uploaded = []
    try:
        with transaction.atomic():
            asset = _upload_word(variant, request.user, result, f"{name}.docx", uploaded)
            created = ContractTemplateVariant.objects.create(
                workspace=variant.workspace,
                template=template,
                name=name,
                source_asset=asset,
                signature_blueprint=variant.signature_blueprint,
                signature_blueprint_layout=variant.signature_blueprint_layout,
                recipient_blueprint=variant.recipient_blueprint,
                authoring_settings=variant.authoring_settings,
                variable_settings=settings,
                recipient_roles=roles,
                origin={
                    "by": "assistant",
                    "from_variant": str(variant.id),
                    "from_revision": info["revision"] or info["latest_revision"],
                },
                created_by=request.user,
            )
            revision, _ = workflow._create_revision(created, request.user, result, track=uploaded, pdf_bytes=pdf)
            action = AssistantAction.objects.create(
                workspace_id=ctx.workspace_id,
                kind=AssistantAction.Kind.CREATE_TEMPLATE_VARIANT,
                summary=f"Creó la variante «{name}» de «{template.name}»"[:300],
                payload=data,
                result={
                    "template_id": str(template.id),
                    "template_name": template.name,
                    "variant_id": str(created.id),
                    "variant_name": name,
                    "revision_id": str(revision.id),
                    "revision": revision.revision,
                    "base": info,
                    "manual_fields": len(variant.signature_blueprint or []) or None,
                    "path": f"/{ctx.slug}/file-library/contracts/templates/{template.id}?variant={created.id}",
                    **_summary_payload(report, verification, changes),
                },
            )
            created.origin = {**created.origin, "action_id": str(action.id)}
            created.save(update_fields=["origin", "updated_at"])
    except IntegrityError:
        workflow._delete_uploaded(uploaded)
        raise ActionError("A variant with that name already exists; choose another name.")
    except Exception:
        workflow._delete_uploaded(uploaded)
        raise
    return action


def _requests_on(revisions):
    return ContractSignatureRequest.objects.filter(revision__in=revisions).exists()


def _discard_assets(assets):
    workflow = _workflow()
    keys = [asset.asset.name for asset in assets if asset is not None]
    for asset in assets:
        if asset is not None:
            FileAsset.objects.filter(id=asset.id).update(is_deleted=True, deleted_at=timezone.now())
    transaction.on_commit(lambda: workflow._delete_uploaded(keys))


@register_undo(AssistantAction.Kind.CREATE_TEMPLATE_VARIANT)
def undo_create_template_variant(action, user, origin, cookie):
    result = action.result or {}
    variant = (
        ContractTemplateVariant.objects.select_for_update()
        .select_related("source_asset")
        .filter(workspace_id=action.workspace_id, id=result.get("variant_id"))
        .first()
    )
    if variant is None:
        return None
    revisions = list(
        ContractTemplateRevision.objects.filter(variant=variant).select_related("source_asset", "pdf_asset")
    )
    if _requests_on(revisions):
        raise ActionError("This variant was already used for a contract; archive it from the template instead.")
    if variant.draft_asset_id:
        raise ActionError("Someone has a Word draft open on this variant; publish or discard it first.")
    if variant.is_default:
        sibling = ContractTemplateVariant.objects.filter(template_id=variant.template_id).exclude(id=variant.id).first()
        if sibling is None:
            raise ActionError("It is the template's only variant.")
        ContractTemplateVariant.objects.filter(id=sibling.id).update(is_default=True)
    assets = [variant.source_asset] + [
        item for revision in revisions for item in (revision.source_asset, revision.pdf_asset)
    ]
    # Unused: nothing points at them, so they go for good (the base never changed)
    ContractTemplateRevision.objects.filter(id__in=[revision.id for revision in revisions]).delete(soft=False)
    ContractTemplateVariant.objects.filter(id=variant.id).delete(soft=False)
    _discard_assets(assets)
    return None


def _lock(variant, user):
    workflow = _workflow()
    if variant.draft_asset_id:
        by = _user_name(variant.draft_active_by_id or variant.draft_started_by_id) or "someone"
        raise ActionError(
            f"{by} has a Word draft open on this variant; publish or discard it before the assistant edits it."
        )
    if (
        variant.draft_active_by_id
        and variant.draft_active_by_id != user.id
        and variant.draft_active_at
        and variant.draft_active_at > timezone.now() - timedelta(seconds=workflow.DRAFT_LOCK_SECONDS)
    ):
        raise ActionError(f"{_user_name(variant.draft_active_by_id)} is editing this variant in Word right now.")


@register_apply(AssistantAction.Kind.EDIT_TEMPLATE_VARIANT)
def edit_template_variant(ctx, request, data) -> AssistantAction:
    """A new revision of an existing variant (only when the person asked to
    change that variant). Earlier revisions are never touched."""
    from plane.integrations.contract_docx import analyse_docx_variables, schema_changes

    workflow = _workflow()
    variant, revision_number, source, edits, info = _checked_base(ctx, data)
    if revision_number:
        raise ActionError("Editing a variant starts from what is published on it, not from an older version.")
    _lock(variant, request.user)
    result, report, verification = _edited(source, edits)
    after = analyse_docx_variables(result)
    changes = schema_changes(analyse_docx_variables(source), after)
    settings = _suggested_settings(variant, report, after, data.get("variable_settings"))
    roles = _roles(variant, data.get("recipient_roles"))
    pdf = _converted(variant, result, f"{variant.name}.docx")
    uploaded = []
    try:
        with transaction.atomic():
            locked = (
                ContractTemplateVariant.objects.select_for_update(of=("self",))
                .select_related("source_asset", "template", "workspace")
                .get(id=variant.id)
            )
            _lock(locked, request.user)
            if hashlib.sha256(workflow._read_asset(locked.source_asset)).hexdigest() != info["base_sha256"]:
                raise ActionError("The template changed after the assistant read it. Ask it to read it again.")
            # The published Word as it was, to put it back on undo
            backup = workflow._create_asset(
                workspace=locked.workspace,
                user=request.user,
                key=workflow._asset_key(locked.workspace_id, "assistant-backups", "docx"),
                name=f"{locked.name}-antes-del-asistente.docx",
                mime_type=workflow.DOCX_MIME,
                content=source,
                entity_type=FileAsset.EntityTypeContext.CONTRACT_REVISION,
                track=uploaded,
            )
            revision, _ = workflow._create_revision(
                locked, request.user, result, name="Asistente", track=uploaded, pdf_bytes=pdf
            )
            workflow._overwrite_asset_content(locked.source_asset, result)
            previous = {
                "variable_settings": locked.variable_settings or {},
                "recipient_roles": locked.recipient_roles or {},
            }
            locked.variable_settings, locked.recipient_roles = settings, roles
            locked.save(update_fields=["variable_settings", "recipient_roles", "updated_at"])
            action = AssistantAction.objects.create(
                workspace_id=ctx.workspace_id,
                kind=AssistantAction.Kind.EDIT_TEMPLATE_VARIANT,
                summary=f"Nueva versión {revision.revision} de «{locked.name}» ({locked.template.name})"[:300],
                payload=data,
                result={
                    "template_id": str(locked.template_id),
                    "template_name": locked.template.name,
                    "variant_id": str(locked.id),
                    "variant_name": locked.name,
                    "revision_id": str(revision.id),
                    "revision": revision.revision,
                    "backup_asset_id": str(backup.id),
                    "content_sha256": hashlib.sha256(result).hexdigest(),
                    "previous": previous,
                    "after": {"variable_settings": settings, "recipient_roles": roles},
                    "path": f"/{ctx.slug}/file-library/contracts/templates/{locked.template_id}?variant={locked.id}",
                    **_summary_payload(report, verification, changes),
                },
            )
    except Exception:
        workflow._delete_uploaded(uploaded)
        raise
    return action


@register_undo(AssistantAction.Kind.EDIT_TEMPLATE_VARIANT)
def undo_edit_template_variant(action, user, origin, cookie):
    workflow = _workflow()
    result = action.result or {}
    variant = (
        ContractTemplateVariant.objects.select_for_update(of=("self",))
        .select_related("source_asset")
        .filter(workspace_id=action.workspace_id, id=result.get("variant_id"))
        .first()
    )
    revision = (
        ContractTemplateRevision.objects.select_related("source_asset", "pdf_asset")
        .filter(id=result.get("revision_id"))
        .first()
    )
    if variant is None or revision is None:
        raise ActionError("The variant or its version no longer exists.")
    _lock(variant, user)
    latest = ContractTemplateRevision.objects.filter(variant=variant).order_by("-revision").first()
    if latest is None or latest.id != revision.id:
        raise ActionError("There is a newer version of this variant; undo is no longer possible.")
    if _requests_on([revision]):
        raise ActionError(
            "This version was already used for a contract; publish the previous text as a new version instead."
        )
    current = workflow._read_asset(variant.source_asset)
    if hashlib.sha256(current).hexdigest() != result.get("content_sha256"):
        raise ActionError("The variant's Word changed after the assistant edited it.")
    backup = FileAsset.objects.filter(id=result.get("backup_asset_id")).first()
    if backup is None:
        raise ActionError("The previous Word file is no longer available.")
    workflow._overwrite_asset_content(variant.source_asset, workflow._read_asset(backup))
    conflicts = []
    after = result.get("after") or {}
    previous = result.get("previous") or {}
    for field in ("variable_settings", "recipient_roles"):
        if (getattr(variant, field) or {}) == after.get(field, {}):
            setattr(variant, field, previous.get(field, {}))
        else:
            conflicts.append({"field": field})
    variant.save(update_fields=["variable_settings", "recipient_roles", "updated_at"])
    assets = [revision.source_asset, revision.pdf_asset, backup]
    ContractTemplateRevision.objects.filter(id=revision.id).delete(soft=False)
    _discard_assets(assets)
    return {"conflicts": conflicts} if conflicts else None
