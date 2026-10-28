# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Before/after per field for the assistant's edits, and undo that refuses
field by field when someone changed the value since.

An edit records, per object, only the fields it changed:
    {"field": "fecha_fin", "before": "2026-01-31", "after": "2027-01-31"}
Values are stored as JSON (dates in ISO, ids as strings, lists sorted when
order doesn't matter), so comparing what is there now with what the edit
left is exact. Undo puts back `before` only where the field still holds
`after`; the rest come back as conflicts the card lists.
"""

import json
from datetime import date, datetime
from decimal import Decimal
from uuid import UUID

from django.core.serializers.json import DjangoJSONEncoder


def to_json(value):
    """A model value as plain JSON (what is stored and compared)."""
    if value is None or isinstance(value, (bool, int, str)):
        return value
    if isinstance(value, float):
        return value
    if isinstance(value, Decimal):
        # "1500.00" and "1500" are the same amount: compare without trailing zeros
        return format(value.normalize(), "f")
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, (list, tuple, set)):
        return [to_json(item) for item in value]
    if isinstance(value, dict):
        return {str(key): to_json(item) for key, item in value.items()}
    return json.loads(json.dumps(value, cls=DjangoJSONEncoder))


def field_value(obj, field: str):
    """The stored value of a model field (a foreign key reads as its id)."""
    model_field = obj._meta.get_field(field)
    if model_field.is_relation and model_field.many_to_one:
        return to_json(getattr(obj, model_field.attname))
    return to_json(getattr(obj, field))


def diff(before: dict, after: dict) -> list[dict]:
    """The fields whose value changed, as {field, before, after}."""
    return [
        {"field": key, "before": before.get(key), "after": after.get(key)}
        for key in after
        if before.get(key) != after.get(key)
    ]


def snapshot(obj, fields) -> dict:
    return {field: field_value(obj, field) for field in fields}


def revert_fields(obj, changes: list[dict], *, read=None, write=None) -> tuple[list[str], list[dict]]:
    """Puts back each field still holding what the edit wrote.

    `read(obj, field)` and `write(obj, field, value)` override how a value is
    read and set (for many-to-many fields or derived values); by default they
    are the model field. Returns (reverted fields, conflicts); the caller saves.
    """
    read = read or field_value
    reverted, conflicts = [], []
    for change in changes:
        field = change["field"]
        current = read(obj, field)
        if current != change["after"]:
            conflicts.append({"field": field, "expected": change["after"], "current": current})
            continue
        if write is not None:
            write(obj, field, change["before"])
        else:
            model_field = obj._meta.get_field(field)
            name = model_field.attname if model_field.is_relation and model_field.many_to_one else field
            setattr(obj, name, model_field.to_python(change["before"]) if change["before"] is not None else None)
        reverted.append(field)
    return reverted, conflicts
