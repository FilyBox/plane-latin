# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Contracts are for workspace admins only.

That covers analyzed contracts, templates, signature requests and the PDFs
behind them: members and guests never see them, in the contracts views, the
file library, mentions, tags or the assistant. Library files count as
contract files when a Contract tracks them or they sit in the protected
"Contratos" category (a non-PDF dropped there is still a contract document).
"""

from django.db.models import Q

from plane.db.models import FileAsset, FileCategoryLink, WorkspaceMember

ADMIN = 20


def can_view_contracts(user, *, slug=None, workspace_id=None) -> bool:
    if not getattr(user, "is_authenticated", False):
        return False
    scope = {"workspace__slug": slug} if slug is not None else {"workspace_id": workspace_id}
    return WorkspaceMember.objects.filter(member=user, is_active=True, role__gte=ADMIN, **scope).exists()


def contract_file_q(prefix: str = "") -> Q:
    """Library assets that belong to the contracts module. `prefix` reaches
    the asset through a relation ("file_asset__")."""
    in_contracts_category = FileCategoryLink.objects.filter(category__is_default=True).values("file_asset_id")
    return Q(**{f"{prefix}contract__isnull": False}) | Q(**{f"{prefix}id__in": in_contracts_category})


def is_contract_file(asset) -> bool:
    """A template, revision, signature PDF or contract file in the library."""
    if str(asset.entity_type or "").startswith("CONTRACT_"):
        return True
    return FileAsset.all_objects.filter(contract_file_q(), id=asset.id).exists()


def hide_contract_files(queryset, user, *, slug=None, workspace_id=None, prefix: str = ""):
    """The queryset as this user may see it: unchanged for admins, without
    contract files for everyone else."""
    if can_view_contracts(user, slug=slug, workspace_id=workspace_id):
        return queryset
    return queryset.exclude(contract_file_q(prefix))
