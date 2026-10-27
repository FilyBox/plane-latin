# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""The spreadsheet import loop, shared by the manual import and the assistant.

`run_import` is a generator: it reports progress while it works, so the
browser can show "1 240 of 2 291 rows" instead of a spinner that hides for
minutes, and ends with the full result. The caller owns the transaction and
decides whether to commit (apply) or roll back (validation dry run).
"""

# Python imports
import time

# Django imports
from django.db import transaction
from django.db.models import Count

# Module imports
from plane.db.models import MusicCredit, MusicRelease
from plane.utils.music_credits import workspace_role_catalog
from plane.utils.tagging_music import link_artist_tags
from plane.utils.music_release_types import (
    apply_inferred_types,
    count_by_type,
    plan_inferred_types,
    release_type_value,
)

from .base import (
    _apply_constants,
    _apply_overrides,
    _apply_row_overrides,
    _collect_unparsed,
    _columns_for,
    _create_planned_roles,
    _import_error_detail,
    _mapped,
    _mapped_many,
    _plan_file_roles,
)

# Cap on the per-row outcome list a validation returns; the review step filters
# it client-side, and a catalog file rarely exceeds a few thousand rows.
ROW_OUTCOME_LIMIT = 5000
# Lists of examples (possible duplicates, repeated identifiers) stay readable.
EXAMPLE_LIMIT = 500
PROGRESS_INTERVAL_SECONDS = 0.4

AMBIGUOUS_STRATEGIES = ("create", "match", "skip")
# When updating an existing song, an empty cell in a mapped column either
# keeps the value the song already has (default) or clears it.
BLANK_CELL_MODES = ("keep", "clear")


def _is_empty_row(row):
    """A spreadsheet row with nothing in it — trailing blank lines, totals
    rows emptied by the reader. Ignored instead of reported as an error."""
    return all(value is None or str(value).strip() == "" for value in row.values())


# Fields that say which song a row is about. A row with none of them (say, a
# trailing "Top Music | Top Music" line where only the label repeats) is not a
# song with a missing title: it is filler, and is ignored like a blank row.
SONG_IDENTITY_SINGLE = ("track.title", "track.isrc", "track.upc", "release.title", "release.upc")
SONG_IDENTITY_MULTI = ("artists",)


def _identity_mapped(mapping):
    return any(_columns_for(mapping, key) for key in SONG_IDENTITY_SINGLE + SONG_IDENTITY_MULTI)


def _has_song_data(row, mapping):
    return any(_mapped(row, mapping, key) for key in SONG_IDENTITY_SINGLE) or any(
        _mapped_many(row, mapping, key) for key in SONG_IDENTITY_MULTI
    )


def _group_unparseable(collected):
    """{field: {lower_token: {variant: count}}} → the response shape, one entry
    per token ignoring case: "Mastertone", "MASTERTONE" and "mastertone" are a
    single decision, which is also how value overrides are applied."""
    grouped = {}
    for field, tokens in collected.items():
        entries = []
        for variants in tokens.values():
            display = max(variants.items(), key=lambda item: item[1])[0]
            entries.append(
                {
                    "value": display,
                    "count": sum(variants.values()),
                    "variants": sorted(variants, key=lambda variant: -variants[variant]),
                }
            )
        grouped[field] = sorted(entries, key=lambda entry: -entry["count"])
    return grouped


def run_import(
    importer,
    workspace,
    rows,
    header_row,
    mapping,
    *,
    strategy="skip",
    dedupe_by="auto",
    relations_mode="merge",
    dedupe_within_file=False,
    defaults=None,
    row_overrides=None,
    value_overrides=None,
    ambiguous_strategy="create",
    blank_cells="keep",
    dry_run=False,
    constants=None,
    role_map=None,
    keep_unmapped=False,
):
    """Imports `rows`, yielding ("progress", payload) events and finally
    ("result", result, touched). `touched` lists (track_id, outcome, row) for
    the provenance links of an applied import.

    `constants` ({field: value}) give a field a fixed value for the whole
    file (or fill its blank cells); `role_map` ({tag: role}) decides what
    each tag of a contributors/performers column means (a role key, or
    SKIP). Tags become roles of their own when no existing role matches;
    those roles are created at the end of an applied run (a dry run only
    lists them in `new_roles`). `keep_unmapped` saves every column no field
    took into each song's metadata["extra"]."""
    row_overrides = row_overrides or {}
    # The workspace's roles plus every role the file's tags would create
    role_catalog = workspace_role_catalog(workspace.id)
    _plan_file_roles(role_catalog, rows, mapping, constants)
    mapped_columns = {column for field in mapping for column in _columns_for(mapping, field)}
    unmapped_columns = (
        [column for column in (rows[0].keys() if rows else ()) if column not in mapped_columns]
        if keep_unmapped
        else None
    )
    value_overrides = value_overrides or {}
    total = len(rows)
    result = {
        "total": total,
        "created": 0,
        "updated": 0,
        "unchanged": 0,
        "skipped": 0,
        # Rows dropped on purpose by a value decision ("omit those rows")
        "omitted": 0,
        "empty": 0,
        "errors": [],
        "possible_duplicates": [],
        "possible_duplicate_count": 0,
        "in_file_duplicates": [],
    }
    unparseable = {}
    touched = []
    outcomes = []
    # Songs already claimed by a row of this run. With "treat repeated rows as
    # one" off, every file row is its own record: a second row sharing an
    # identifier must reach another song (or create one), not overwrite the
    # song the first row already matched. That is what keeps re-importing a
    # file with repeated ISRCs a no-op instead of flipping data between rows.
    claimed_ids = set()
    rows_by_isrc = {}
    # Releases this run creates, and whether the file (a column or a fixed
    # value) gave each one its type: the rest get one inferred at the end.
    # Releases that existed before the run are never touched by inference.
    existing_release_ids = set(MusicRelease.all_objects.filter(workspace=workspace).values_list("id", flat=True))
    new_releases = {}
    last_report = 0.0

    def progress(processed):
        return (
            "progress",
            {
                "processed": processed,
                "total": total,
                "created": result["created"],
                "updated": result["updated"],
                "unchanged": result["unchanged"],
                "skipped": result["skipped"],
                "errors": len(result["errors"]),
            },
        )

    yield progress(0)
    for position, (index, row) in enumerate(enumerate(rows, start=header_row + 1), start=1):
        now = time.monotonic()
        if now - last_report >= PROGRESS_INTERVAL_SECONDS:
            last_report = now
            yield progress(position - 1)

        if _is_empty_row(row):
            result["empty"] += 1
            continue
        effective_row, effective_mapping = _apply_row_overrides(row, mapping, row_overrides.get(str(index), {}))
        file_row, file_mapping = effective_row, effective_mapping
        # Fixed values join before value decisions and parsing, exactly like
        # a cell would.
        effective_row, effective_mapping = _apply_constants(effective_row, effective_mapping, constants)
        effective_row, skip_row = _apply_overrides(effective_row, effective_mapping, value_overrides)
        # Whether a row is about a song is judged on the FILE's cells: a fixed
        # artist must not turn a trailing filler line into a song.
        if file_mapping is effective_mapping:
            has_data = _has_song_data(effective_row, effective_mapping)
        else:
            has_data = _has_song_data(_apply_overrides(file_row, file_mapping, value_overrides)[0], file_mapping) or (
                not _identity_mapped(file_mapping) and _has_song_data(effective_row, effective_mapping)
            )
        if not has_data:
            result["empty"] += 1
            continue
        title = _mapped(effective_row, effective_mapping, "track.title")
        isrc = _mapped(effective_row, effective_mapping, "track.isrc").upper().replace("-", "")
        if skip_row:
            result["omitted"] += 1
            if dry_run and len(outcomes) < ROW_OUTCOME_LIMIT:
                outcomes.append({"row": index, "outcome": "omitted", "title": title, "isrc": isrc})
            continue
        if isrc:
            rows_by_isrc.setdefault(isrc, []).append(index)
        if dry_run:
            for field, token in _collect_unparsed(effective_row, effective_mapping).items():
                variants = unparseable.setdefault(field, {}).setdefault(token.lower(), {})
                variants[token] = variants.get(token, 0) + 1
        importer._last_import_release = None
        try:
            # Each row in its own savepoint: a failing row must not leave the
            # rest of the spreadsheet's transaction aborted.
            with transaction.atomic():
                outcome, track, match = importer._import_row(
                    workspace,
                    effective_row,
                    effective_mapping,
                    strategy,
                    defaults or {},
                    dedupe_by,
                    relations_mode=relations_mode,
                    exclude_ids=None if dedupe_within_file else claimed_ids,
                    ambiguous_strategy=ambiguous_strategy,
                    blank_cells=blank_cells,
                    role_map=role_map,
                    role_catalog=role_catalog,
                    unmapped_columns=unmapped_columns,
                )
        except Exception as exc:
            detail = _import_error_detail(index, exc, effective_row, effective_mapping)
            result["errors"].append(detail)
            if dry_run and len(outcomes) < ROW_OUTCOME_LIMIT:
                outcomes.append({"row": index, "outcome": "error", "title": title, "isrc": isrc})
            if detail["code"] == "DATABASE_NOT_READY":
                break
            continue

        result[outcome] += 1
        release = getattr(importer, "_last_import_release", None)
        if release is not None and release.id not in existing_release_ids:
            typed = release_type_value(_mapped(effective_row, effective_mapping, "release.type")) is not None
            new_releases[release.id] = new_releases.get(release.id, False) or typed
        if track is not None:
            claimed_ids.add(track.id)
            touched.append((track.id, outcome, index))
        possible_duplicate = bool(match and match["by"] == "ambiguous")
        if possible_duplicate:
            result["possible_duplicate_count"] += 1
            if len(result["possible_duplicates"]) < EXAMPLE_LIMIT:
                result["possible_duplicates"].append({"row": index, "title": title, "isrc": isrc, "match": match})
        if dry_run and len(outcomes) < ROW_OUTCOME_LIMIT:
            outcomes.append(
                {
                    "row": index,
                    "outcome": outcome,
                    "title": title,
                    "isrc": isrc,
                    "match": match,
                    "possible_duplicate": possible_duplicate,
                }
            )

    # The same identifier on several rows of the file: each row still becomes
    # its own record unless "treat repeated rows as one" is on — surfacing the
    # groups lets the user make that call knowingly.
    result["in_file_duplicates"] = [
        {"isrc": isrc, "rows": indexes} for isrc, indexes in rows_by_isrc.items() if len(indexes) > 1
    ][:EXAMPLE_LIMIT]
    # Roles named after the file's tags that its credits use: created now
    # when applying; a dry run reports what would be created.
    result["new_roles"] = _create_planned_roles(workspace, role_catalog, dry_run=dry_run)
    # New releases the file gave no type: inferred from their title and how
    # many songs they hold (a dry run reports what would be inferred).
    untyped = [release_id for release_id, typed in new_releases.items() if not typed]
    inferred = (
        plan_inferred_types(MusicRelease.objects.filter(id__in=untyped), include_unchanged=True) if untyped else []
    )
    if inferred and not dry_run:
        apply_inferred_types(inferred)
    result["release_types_inferred"] = {key: count for key, count in count_by_type(inferred).items() if count}
    # The songs' artists join the tag the workspace already has for them
    # (a dry run reports which would)
    result["artist_tags_linked"] = link_artist_tags(
        workspace.id, {track_id for track_id, _outcome, _row in touched}, dry_run=dry_run
    )
    if dry_run:
        result["rows"] = outcomes
        result["unparseable"] = _group_unparseable(unparseable)
        # Credits the checked songs would end up with, per role — read before
        # the caller rolls the validation back.
        track_ids = list({track_id for track_id, _outcome, _row in touched})
        result["credit_roles"] = (
            {
                entry["role"]: entry["count"]
                for entry in MusicCredit.objects.filter(track_id__in=track_ids)
                .values("role")
                .annotate(count=Count("id"))
            }
            if track_ids
            else {}
        )
        result["role_labels"] = {key: role_catalog.label(key) for key in result["credit_roles"]}
    yield progress(total)
    yield "result", result, touched
