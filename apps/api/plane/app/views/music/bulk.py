# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Bulk edit of selected songs ("Editar en lote").

POST music/tracks/bulk-update/ {track_ids, changes: [{field, op, value}]}

Every change is validated before anything is written, and all of them are
applied in one transaction: either every selected song gets every change or
none does. Companies, genres, people and releases are named as the import's
fixed values name them (find by name, case-insensitive; create when missing),
so the picker's "already exists" warning (field-values endpoint) applies here
too. Relation writes are set-based: a selection of thousands of songs costs a
handful of queries per change, not per song.
"""

import uuid
from decimal import ROUND_HALF_UP, Decimal

from django.db import transaction
from django.utils import timezone
from rest_framework import status
from rest_framework.response import Response

from plane.app.permissions import ROLE, allow_permission
from plane.db.models import (
    MusicCompany,
    MusicCredit,
    MusicDistribution,
    MusicGenre,
    MusicParty,
    MusicRelease,
    MusicReleaseTrack,
    MusicTrack,
    MusicTrackGenre,
    Workspace,
)
from plane.utils.music_credits import ARTIST_CATEGORY, workspace_role_catalog

from plane.utils.music_release_types import release_type_value

from .base import MusicBaseView, _choice_value, _date, _decimal, _party

MAX_TRACKS = 10000
MAX_NAMES = 50

COMPANY_FIELDS = {
    "aggregator": MusicCompany.Kind.AGGREGATOR,
    "distributor": MusicCompany.Kind.DISTRIBUTOR,
    "record_label": MusicCompany.Kind.RECORD_LABEL,
    "publisher": MusicCompany.Kind.PUBLISHER,
}
CHOICE_FIELDS = {"status": MusicTrack.Status.choices, "kind": MusicTrack.Kind.choices}
DATE_FIELDS = ("release_date", "original_release_date", "recording_date")
BOOL_FIELDS = ("explicit", "instrumental")
# field -> max length (None: long text)
TEXT_FIELDS = {
    "language": 100,
    "p_line": 500,
    "c_line": 500,
    "ownership": None,
    "us_publishing_obligations": None,
    "recoupment": None,
}
PERCENT_FIELDS = (
    "aggregator_percentage",
    "distributor_percentage",
    "record_label_percentage",
    "artist_percentage",
    "writer_percentage",
)
SCALAR_FIELDS = (*CHOICE_FIELDS, *DATE_FIELDS, *BOOL_FIELDS, *TEXT_FIELDS, *PERCENT_FIELDS)
RELATION_FIELDS = (*COMPANY_FIELDS, "genres", "release")
# Fields of the selected songs' RELEASES (every release each song is in)
RELEASE_FIELDS = ("release_type",)
RELATION_OPS = ("add", "remove", "replace", "clear")
SCALAR_OPS = ("set", "clear")
# Fields that can't be emptied
NOT_CLEARABLE = (*CHOICE_FIELDS,)


class _Invalid(Exception):
    pass


def _names(value, limit=255):
    """["Virgin", " virgin ", "Sony"] -> ["Virgin", "Sony"] (trimmed, unique ignoring case)."""
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list):
        raise _Invalid("value must be a name or a list of names")
    names, seen = [], set()
    for raw in value:
        name = " ".join(str(raw or "").split())[:limit]
        if name and name.lower() not in seen:
            seen.add(name.lower())
            names.append(name)
    if len(names) > MAX_NAMES:
        raise _Invalid(f"at most {MAX_NAMES} names per change")
    return names


def _scalar(field, op, value):
    """The value to store for a scalar change (validated)."""
    if op == "clear":
        if field in NOT_CLEARABLE:
            raise _Invalid("this field can't be emptied")
        if field in BOOL_FIELDS:
            return False
        if field in TEXT_FIELDS:
            return ""
        return None
    if field in CHOICE_FIELDS:
        choice = _choice_value(value, CHOICE_FIELDS[field])
        if choice is None:
            raise _Invalid(f"unknown value «{value}»")
        return choice
    if field in DATE_FIELDS:
        parsed = _date(value)
        if parsed is None:
            raise _Invalid(f"«{value}» is not a date")
        return parsed
    if field in BOOL_FIELDS:
        if isinstance(value, bool):
            return value
        text = str(value).strip().lower()
        if text in ("true", "1", "yes", "si", "sí"):
            return True
        if text in ("false", "0", "no"):
            return False
        raise _Invalid("value must be true or false")
    if field in TEXT_FIELDS:
        text = str(value if value is not None else "").strip()
        limit = TEXT_FIELDS[field] or 10000
        if not text:
            raise _Invalid("value is empty (use clear to empty the field)")
        if len(text) > limit:
            raise _Invalid(f"at most {limit} characters")
        return text
    number = _decimal(value)
    if number is None or not number.is_finite() or number < 0 or number > 100:
        raise _Invalid("value must be a percentage between 0 and 100")
    return number.quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)


def _validate(workspace, changes):
    """[(field, op, parsed)] or raises _Invalid with every problem found."""
    if not isinstance(changes, list) or not changes:
        raise _Invalid([{"index": None, "field": None, "error": "changes must list at least one change"}])
    catalog = None
    parsed, errors = [], []
    for index, change in enumerate(changes):
        field = change.get("field") if isinstance(change, dict) else None
        op = change.get("op") if isinstance(change, dict) else None
        value = change.get("value") if isinstance(change, dict) else None
        try:
            if field in SCALAR_FIELDS:
                if op not in SCALAR_OPS:
                    raise _Invalid(f"op must be one of {', '.join(SCALAR_OPS)}")
                parsed.append((field, op, _scalar(field, op, value)))
            elif field in RELEASE_FIELDS:
                if op != "set":
                    raise _Invalid("op must be set")
                choice = release_type_value(value)
                if choice is None:
                    raise _Invalid(f"unknown value «{value}»")
                parsed.append((field, op, choice))
            elif field in RELATION_FIELDS:
                if op not in RELATION_OPS:
                    raise _Invalid(f"op must be one of {', '.join(RELATION_OPS)}")
                names = [] if op == "clear" else _names(value, 120 if field == "genres" else 255)
                if op in ("add", "remove") and not names:
                    raise _Invalid("name at least one value")
                parsed.append((field, op, names))
            elif field == "credit":
                if op not in RELATION_OPS:
                    raise _Invalid(f"op must be one of {', '.join(RELATION_OPS)}")
                value = value if isinstance(value, dict) else {}
                role = str(value.get("role") or "").strip()
                if role:
                    catalog = catalog or workspace_role_catalog(workspace.id)
                    if not catalog.exists(role):
                        role = catalog.match(role) or ""
                        if not role:
                            raise _Invalid(f"unknown credit role «{value.get('role')}»")
                elif op != "remove":
                    raise _Invalid("choose a credit role")
                names = [] if op == "clear" else _names(value.get("names", value.get("name")))
                if op in ("add", "remove") and not names:
                    raise _Invalid("name at least one person")
                category = catalog.category(role) if (catalog and role) else None
                parsed.append((field, op, {"role": role, "names": names, "category": category}))
            else:
                raise _Invalid(f"unknown field «{field}»")
        except _Invalid as error:
            errors.append({"index": index, "field": field, "error": str(error.args[0])})
    if errors:
        raise _Invalid(errors)
    return parsed


class _Applier:
    """Writes the validated changes for one selection of track ids."""

    def __init__(self, workspace, user, track_ids):
        self.workspace = workspace
        self.user = user
        self.track_ids = track_ids
        self.touched = set()
        self.created = {"companies": [], "genres": [], "people": [], "releases": []}
        self.now = timezone.now()

    # ---------------------------------------------------------------- helpers

    def _soft_delete(self, queryset):
        """Soft-deletes relation rows (they own nothing) in one update."""
        self.touched.update(queryset.values_list("track_id", flat=True))
        queryset.update(deleted_at=self.now, updated_at=self.now, updated_by=self.user)

    def _ensure(self, model, lookup, revive=True, values=None):
        """A live (track, lookup) row for every selected track: soft-deleted
        unique rows are revived, missing ones created in one insert."""
        live, dead = set(), {}
        rows = model.all_objects.filter(track_id__in=self.track_ids, **lookup).values_list(
            "track_id", "id", "deleted_at"
        )
        for track_id, row_id, deleted_at in rows:
            if deleted_at is None:
                live.add(track_id)
            elif revive:
                dead.setdefault(track_id, row_id)
        revived = {track_id: row_id for track_id, row_id in dead.items() if track_id not in live}
        if revived:
            reset = values(None) if values else {}
            model.all_objects.filter(id__in=list(revived.values())).update(
                deleted_at=None, updated_at=self.now, updated_by=self.user, **reset
            )
        missing = [track_id for track_id in self.track_ids if track_id not in live and track_id not in revived]
        model.objects.bulk_create(
            [
                model(
                    workspace=self.workspace,
                    track_id=track_id,
                    created_by=self.user,
                    **lookup,
                    **(values(track_id) if values else {}),
                )
                for track_id in missing
            ],
            batch_size=500,
        )
        self.touched.update(revived)
        self.touched.update(missing)

    def _company(self, name, kind, create=True):
        company = MusicCompany.objects.filter(workspace=self.workspace, kind=kind, name__iexact=name).first()
        if company is None and create:
            company = MusicCompany.objects.create(workspace=self.workspace, kind=kind, name=name)
            self.created["companies"].append(name)
        return company

    def _genre(self, name, create=True):
        genre = MusicGenre.objects.filter(workspace=self.workspace, name__iexact=name).first()
        if genre is None and create:
            genre = MusicGenre.objects.create(workspace=self.workspace, name=name)
            self.created["genres"].append(name)
        return genre

    def _release(self, name, create=True):
        release = (
            MusicRelease.objects.filter(workspace=self.workspace, title__iexact=name).order_by("-created_at").first()
        )
        if release is None and create:
            release = MusicRelease.objects.create(
                workspace=self.workspace, title=name[:500], status=MusicRelease.Status.DRAFT
            )
            self.created["releases"].append(name)
        return release

    def _person(self, name, category, create=True):
        if not create:
            return MusicParty.objects.filter(workspace=self.workspace, display_name__iexact=name).first()
        existed = MusicParty.objects.filter(workspace=self.workspace, display_name__iexact=name).exists()
        kind = MusicParty.Kind.ARTIST if category == ARTIST_CATEGORY else MusicParty.Kind.PERSON
        party = _party(self.workspace, name, kind)
        if not existed:
            self.created["people"].append(name)
        return party

    def _tracks(self, model, scope=None):
        rows = model.objects.filter(track_id__in=self.track_ids)
        return rows.filter(**scope) if scope else rows

    def _detach(self, model, fk, items, op, scope=None):
        """The removing half of remove / replace / clear, inside `scope`."""
        rows = self._tracks(model, scope)
        ids = [item.id for item in items if item is not None]
        if op == "clear":
            self._soft_delete(rows)
        elif op == "remove" and ids:
            self._soft_delete(rows.filter(**{f"{fk}_id__in": ids}))
        elif op == "replace":
            self._soft_delete(rows.exclude(**{f"{fk}_id__in": ids}))

    @staticmethod
    def _numbering(release):
        """New songs go to the end of the release, in selection order; a
        revived link keeps its old position."""
        position = {"next": MusicReleaseTrack.objects.filter(release=release).count()}

        def values(track_id):
            if track_id is None:
                return {}
            position["next"] += 1
            return {"disc_number": 1, "track_number": min(position["next"], 32767)}

        return values

    # ---------------------------------------------------------------- changes

    def scalar(self, field, value):
        tracks = MusicTrack.objects.filter(id__in=self.track_ids)
        changed = tracks.filter(**{f"{field}__isnull": False}) if value is None else tracks.exclude(**{field: value})
        ids = list(changed.values_list("id", flat=True))
        if ids:
            MusicTrack.objects.filter(id__in=ids).update(**{field: value}, updated_at=self.now, updated_by=self.user)
            self.touched.update(ids)

    def release_type(self, value):
        """Sets the type of every release the selected songs are in."""
        links = MusicReleaseTrack.objects.filter(
            track_id__in=self.track_ids, release__deleted_at__isnull=True
        ).exclude(release__release_type=value)
        release_ids = set(links.values_list("release_id", flat=True))
        if not release_ids:
            return
        self.touched.update(links.values_list("track_id", flat=True))
        MusicRelease.objects.filter(id__in=release_ids).update(
            release_type=value, updated_at=self.now, updated_by=self.user
        )

    def apply(self, field, op, value):
        adds = op in ("add", "replace")
        if field in SCALAR_FIELDS:
            self.scalar(field, value)
        elif field == "release_type":
            self.release_type(value)
        elif field in COMPANY_FIELDS:
            kind = COMPANY_FIELDS[field]
            companies = [self._company(name, kind, create=adds) for name in value]
            self._detach(MusicDistribution, "company", companies, op, scope={"company__kind": kind})
            for company in companies if adds else []:
                # No unique row per (track, company): nothing to revive
                self._ensure(MusicDistribution, {"company_id": company.id}, revive=False)
        elif field == "genres":
            genres = [self._genre(name, create=adds) for name in value]
            self._detach(MusicTrackGenre, "genre", genres, op)
            for genre in genres if adds else []:
                self._ensure(MusicTrackGenre, {"genre_id": genre.id})
        elif field == "release":
            releases = [self._release(name, create=adds) for name in value]
            self._detach(MusicReleaseTrack, "release", releases, op)
            for release in releases if adds else []:
                self._ensure(MusicReleaseTrack, {"release_id": release.id}, values=self._numbering(release))
        elif field == "credit":
            role, category = value["role"], value["category"]
            people = [self._person(name, category, create=adds) for name in value["names"]]
            # Without a role (remove only) the person leaves every role
            self._detach(MusicCredit, "party", people, op, scope={"role": role} if role else None)
            for party in people if adds else []:
                self._ensure(MusicCredit, {"party_id": party.id, "role": role}, values=lambda _id: {"role_detail": ""})


class MusicTrackBulkUpdateEndpoint(MusicBaseView):
    """POST {track_ids: [...], changes: [{field, op, value}]} -> {updated, unchanged, skipped, created, errors}."""

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def post(self, request, slug):
        data = request.data if isinstance(request.data, dict) else {}
        track_ids = data.get("track_ids")
        if not isinstance(track_ids, list) or not track_ids:
            return Response(
                {"error": "track_ids must contain at least one song", "errors": []},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if len(track_ids) > MAX_TRACKS:
            return Response(
                {"error": f"At most {MAX_TRACKS} songs per bulk edit", "errors": []},
                status=status.HTTP_400_BAD_REQUEST,
            )
        workspace = Workspace.objects.get(slug=slug)
        try:
            changes = _validate(workspace, data.get("changes"))
        except _Invalid as invalid:
            errors = invalid.args[0]
            return Response(
                {"error": errors[0]["error"] if errors else "Invalid changes", "errors": errors},
                status=status.HTTP_400_BAD_REQUEST,
            )
        clean_ids = []
        for raw in track_ids:
            try:
                clean_ids.append(str(uuid.UUID(str(raw))))
            except (TypeError, ValueError):
                continue
        found = list(MusicTrack.objects.filter(workspace=workspace, id__in=clean_ids).values_list("id", flat=True))
        if not found:
            return Response(
                {"updated": 0, "unchanged": 0, "skipped": len(track_ids), "created": {}, "errors": []},
                status=status.HTTP_200_OK,
            )
        applier = _Applier(workspace, request.user, found)
        with transaction.atomic():
            for field, op, value in changes:
                applier.apply(field, op, value)
        updated = len(applier.touched)
        return Response(
            {
                "updated": updated,
                "unchanged": len(found) - updated,
                "skipped": len(track_ids) - len(found),
                "created": {key: names for key, names in applier.created.items() if names},
                "errors": [],
            },
            status=status.HTTP_200_OK,
        )
