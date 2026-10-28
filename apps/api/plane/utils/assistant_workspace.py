# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""The assistant's edits across the workspace (contracts' data, work items,
the file library, expenses, the music catalog, contract templates).

Each kind registers how it is applied (APPLY_HANDLERS, read by the actions
endpoint) and how it is undone (register_undo). Applying records exactly
what changed, field by field (plane/utils/assistant_undo.py), so undo puts
back only what still holds the assistant's value.
"""

# kind → apply(ctx, request, data) -> AssistantAction
APPLY_HANDLERS: dict = {}


def register_apply(kind):
    def decorator(function):
        APPLY_HANDLERS[kind] = function
        return function

    return decorator


def _load():
    """Each module registers its kinds when imported."""
    from plane.utils import (  # noqa: F401
        assistant_contract_drafts,
        assistant_contract_edits,
        assistant_expenses,
        assistant_templates,
        assistant_work_items,
    )


_load()
