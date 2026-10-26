import csv
import json
import re
import unicodedata
from datetime import date, datetime, time, timedelta
from decimal import Decimal, InvalidOperation
from io import BytesIO, StringIO

from crum import impersonate
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import DatabaseError, connection, models, transaction
from django.db.models import Count, Exists, F, OuterRef, Q
from django.http import HttpResponse, StreamingHttpResponse
from django.utils import timezone
from django.utils.dateparse import parse_date
from openpyxl import load_workbook
from rest_framework import status
from rest_framework.negotiation import DefaultContentNegotiation
from rest_framework.response import Response

from plane.app.permissions import ROLE, allow_permission
from rest_framework.exceptions import ValidationError

from plane.app.serializers import (
    MusicCompanySerializer,
    MusicGenreSerializer,
    MusicPartySerializer,
    MusicReleaseSerializer,
    MusicTrackSerializer,
)
from plane.db.models import (
    FileAsset,
    MusicCompany,
    MusicCredit,
    MusicCreditRole,
    MusicDistribution,
    MusicGenre,
    MusicImportRun,
    MusicLink,
    MusicParty,
    MusicRelease,
    MusicReleaseArtist,
    MusicReleaseTrack,
    MusicTrack,
    MusicTrackGenre,
    Workspace,
    WorkspaceFeature,
)
from plane.utils.contract_works import filter_by_contract, release_contract_count, track_contract_count
from plane.utils.exception_logger import log_exception
from plane.utils.music_credits import (
    ARTIST_CATEGORY,
    CATEGORIES,
    ROLE_KEY,
    SKIP_ROLE,
    TAGGED_CREDIT_FIELDS,
    guess_category,
    merge_details,
    normalize_tag,
    role_key,
    similar_names,
    tag_counts,
    tagged_entries,
    workspace_role_catalog,
)
from plane.utils.music_release_types import release_type_value, with_track_counts
from plane.utils.workspace_feature import is_workspace_feature_enabled

from ..base import BaseAPIView


class MusicBaseView(BaseAPIView):
    def initial(self, request, *args, **kwargs):
        super().initial(request, *args, **kwargs)
        slug = kwargs.get("slug")
        if slug and not is_workspace_feature_enabled(WorkspaceFeature.FeatureKey.MUSIC_CATALOG, slug=slug):
            self.permission_denied(request, message="Music catalog is not enabled for this workspace")


class MusicReportContentNegotiation(DefaultContentNegotiation):
    """Keep DRF's reserved format parameter from rejecting file exports."""

    def filter_renderers(self, renderers, format):
        if format in ("csv", "xlsx"):
            return renderers
        return super().filter_renderers(renderers, format)


ARTIST_SEPARATOR = re.compile(
    r"\s*(?:;|\||,|&|\band\b|\by\b|\bfeat(?:uring)?\.?\b|\bf\.?t\.?[,]?\b)\s*",
    re.IGNORECASE,
)

MONTHS = {
    "enero": "january", "febrero": "february", "marzo": "march", "abril": "april",
    "mayo": "may", "junio": "june", "julio": "july", "agosto": "august",
    "septiembre": "september", "setiembre": "september", "octubre": "october",
    "noviembre": "november", "diciembre": "december",
}


def _plain(value):
    return "".join(
        char for char in unicodedata.normalize("NFKD", str(value or "").lower()) if not unicodedata.combining(char)
    )


# Distributor exports tag each person with a role: "Ana <Lyricist>, Ana <Composer>"
ROLE_TAG = re.compile(r"\s*<[^<>]*>")


def _split(value):
    """Names in a cell, without role tags and without repeating a name."""
    names = []
    for part in ARTIST_SEPARATOR.split(ROLE_TAG.sub("", str(value or ""))):
        name = part.strip(" .")
        if name and name.lower() not in (existing.lower() for existing in names):
            names.append(name)
    return names


def _prune(queryset):
    """Soft-delete relations one by one (keeps Plane's soft-delete semantics;
    `_restore_or_create` can revive them on a later import)."""
    for instance in queryset:
        instance.delete()


def _choice_value(raw, choices):
    """The TextChoices VALUE a raw cell names (by value or label, ignoring
    case: "Released" -> "RELEASED"), or None when it names none of them."""
    lowered = str(raw or "").strip().lower()
    if not lowered:
        return None
    for value, label in choices:
        if lowered in (str(value).lower(), str(label).lower()):
            return value
    return None


def _choice(raw, choices, default):
    """Normalize a raw cell to a TextChoices VALUE. Text that names no choice
    ("AudioTrack" as a track type) falls back to the default instead of being
    stored as an invalid value; the review lists it for the user to decide."""
    return _choice_value(raw, choices) or default


# Distributor exports tag each credited name with its role. A tagged name only
# feeds the credit fields its tag belongs to (tags compared lowercase, letters only).
ROLE_TAG_FIELDS = {
    "artists": ("primaryartist", "mainartist", "artist"),
    "featured_artists": ("featuredartist", "featuring", "featured"),
    "writers": ("writer", "songwriter", "lyricist", "composer", "author", "composerlyricist"),
    "authors": ("lyricist", "author", "writer"),
    "composers": ("composer", "composerlyricist"),
    "producers": ("producer",),
    "recording_engineers": ("recordingengineer", "engineer", "recording"),
    "mixers": ("mixingengineer", "mixer", "mixing"),
    "mastering_engineers": ("masteringengineer", "mastering"),
}


def _names_for(value, field):
    """Names in a cell for one credit field. Untagged names always count; a
    name tagged "<Composer>" only counts for the fields that tag belongs to."""
    text = str(value or "")
    if not ROLE_TAG.search(text):
        return _split(text)
    wanted = ROLE_TAG_FIELDS.get(field)
    names = []
    # Split at the tags only: "Hermanos Vargas y Ríos <Composer>" is one name.
    for name, tag in tagged_entries(text):
        if tag and wanted is not None and normalize_tag(tag) not in wanted:
            continue
        if name.lower() not in (existing.lower() for existing in names):
            names.append(name)
    return names


# Fixed values ("constants") travel as synthetic columns of the row, so they
# go through exactly the same parsing and validation as a real cell.
CONSTANT_PREFIX = "__constant__"


def _apply_constants(row, mapping, constants):
    """A fixed value per field for the whole file. With no column mapped the
    field takes it on every row; with a column mapped it only fills the rows
    whose cell is blank (a default)."""
    if not constants:
        return row, mapping
    next_row, next_mapping = row, mapping
    for field, value in constants.items():
        if field not in IMPORT_FIELDS:
            continue
        values = [
            str(item).strip() for item in (value if isinstance(value, list) else [value])
            if item is not None and str(item).strip()
        ]
        if not values:
            continue
        if any(str(row.get(column) or "").strip() for column in _columns_for(mapping, field)):
            continue
        if next_row is row:
            next_row, next_mapping = dict(row), dict(mapping)
        multi = field in MULTI_COLUMN_FIELDS
        columns = []
        for index, item in enumerate(values if multi else values[:1]):
            column = f"{CONSTANT_PREFIX}{field}#{index}"
            next_row[column] = item
            columns.append(column)
        next_mapping[field] = columns if multi else columns[0]
    return next_row, next_mapping


def _mapped_cells(row, mapping, key):
    """(column, text) for every non-empty cell mapped to the field."""
    for column in _columns_for(mapping, key):
        raw = row.get(column)
        text = str(raw).strip() if raw is not None else ""
        if text:
            yield column, text


def _names_in(row, mapping, key, parse):
    """Names across the field's cells. A fixed value is one name as typed
    (or picked) — never split on "y", "&" or commas."""
    names = []
    for column, text in _mapped_cells(row, mapping, key):
        found = [text] if column.startswith(CONSTANT_PREFIX) else parse(text)
        for name in found:
            if name.lower() not in (existing.lower() for existing in names):
                names.append(name)
    return names


def _named_tags_in(row, mapping, key):
    """{name: [tags]} across a credit field's cells, names in order (same
    names and filtering as `_names_in(..., _names_for)`), keeping the tags
    each name came with: "Ana <Lyricist>, Ana <Composer>" in a writers column
    is Ana with ["Lyricist", "Composer"]."""
    found = {}
    wanted = ROLE_TAG_FIELDS.get(key)
    for column, text in _mapped_cells(row, mapping, key):
        if column.startswith(CONSTANT_PREFIX):
            entries = [(text, None)]
        elif not ROLE_TAG.search(text):
            entries = [(name, None) for name in _split(text)]
        else:
            entries = [
                (name, tag)
                for name, tag in tagged_entries(text)
                if not (tag and wanted is not None and normalize_tag(tag) not in wanted)
            ]
        for name, tag in entries:
            existing = next((item for item in found if item.lower() == name.lower()), name)
            tags = found.setdefault(existing, [])
            if tag and tag not in tags:
                tags.append(tag)
    return found


def _tagged_in(row, mapping, key):
    """(name, tag | None) across the field's cells; a fixed value without
    tags is a single untagged name."""
    entries = []
    for column, text in _mapped_cells(row, mapping, key):
        if column.startswith(CONSTANT_PREFIX) and not ROLE_TAG.search(text):
            entries.append((text, None))
        else:
            entries.extend(tagged_entries(text))
    return entries


def _clean_role_map(value):
    """{normalized tag: role key | SKIP_ROLE}. Keys are checked against the
    workspace's roles (and the roles the file creates) when importing, so a
    tag may point at a role another tag of the same file brings."""
    if not isinstance(value, dict):
        return {}
    return {
        normalize_tag(tag): role
        for tag, role in value.items()
        if isinstance(role, str) and (role == SKIP_ROLE or ROLE_KEY.match(role))
    }


def _clean_constants(value):
    """{field: value | [values]} for known import fields only."""
    if not isinstance(value, dict):
        return {}
    cleaned = {}
    for field, item in value.items():
        if field not in IMPORT_FIELDS:
            continue
        if isinstance(item, list):
            items = [str(entry).strip() for entry in item if entry is not None and str(entry).strip()]
            if items:
                cleaned[field] = items
        elif item is not None and str(item).strip():
            cleaned[field] = str(item).strip()
    return cleaned


def _column_role_tags(headers, rows, catalog, performer_columns=()):
    """Per column holding tagged names ("Ana <Tuba>"): every tag with how often
    it appears and the role it imports as by default — an existing role, or
    a new one named after the tag (role_is_new). Untagged names ("" tag) have
    no role here: the field they are mapped to decides."""
    result = {}
    for header in headers:
        values = [row.get(header) for row in rows if isinstance(row.get(header), str) and row.get(header).strip()]
        if not any(ROLE_TAG.search(value) for value in values):
            continue
        field = "performers" if header in performer_columns else "contributors"
        entries = []
        for key, entry in tag_counts(values).items():
            role = catalog.describe(entry["tag"], field) if key else None
            entries.append(
                {
                    "tag": key,
                    "label": entry["tag"],
                    "count": entry["count"],
                    "role": role["key"] if role else None,
                    "role_label": role["label"] if role else None,
                    "role_category": role["category"] if role else None,
                    "role_is_new": bool(role and role["is_new"]),
                }
            )
        result[header] = sorted(entries, key=lambda item: (-item["count"], item["tag"]))
    return result


def _plan_file_roles(catalog, rows, mapping, constants=None):
    """Registers in the catalog every new role the file's tagged columns
    would create, so the role map can point at any of them."""
    if not any(_columns_for(mapping, field) for field in TAGGED_CREDIT_FIELDS) and not any(
        field in (constants or {}) for field in TAGGED_CREDIT_FIELDS
    ):
        return
    for row in rows:
        effective_row, effective_mapping = _apply_constants(row, mapping, constants)
        for field in TAGGED_CREDIT_FIELDS:
            for _name, tag in _tagged_in(effective_row, effective_mapping, field):
                if tag:
                    catalog.describe(tag, field)


def _create_planned_roles(workspace, catalog, dry_run=False):
    """The new roles the import's credits actually use, with how many credits
    each has; created in the workspace unless this is a dry run."""
    if not catalog.planned:
        return []
    used = {
        entry["role"]: entry["count"]
        for entry in MusicCredit.objects.filter(workspace=workspace, role__in=list(catalog.planned))
        .values("role")
        .annotate(count=Count("id"))
    }
    existing = set(
        MusicCreditRole.objects.filter(workspace=workspace, key__in=list(used)).values_list("key", flat=True)
    )
    created = []
    for key, count in sorted(used.items(), key=lambda item: -item[1]):
        plan = catalog.planned[key]
        if not dry_run and key not in existing:
            MusicCreditRole.objects.create(
                workspace=workspace,
                key=key,
                label=plan["label"],
                category=plan["category"],
                source_tags=plan["tags"][:20],
            )
        created.append(
            {"key": key, "label": plan["label"], "category": plan["category"], "tags": plan["tags"], "count": count}
        )
    return created


def _validate_credit_roles(workspace, entries):
    """Raises a 400 when a credit names a role the workspace doesn't have."""
    if not entries:
        return
    catalog = workspace_role_catalog(workspace.id)
    unknown = sorted(
        {str(entry.get("role") or "") for entry in entries if not catalog.exists(str(entry.get("role") or ""))}
    )
    if unknown:
        raise ValidationError({"credit_entries": [f"Unknown credit role: {', '.join(unknown)}"]})


def _restore_or_create(model, workspace, lookup, values=None):
    """Revive a soft-deleted unique relation instead of inserting a duplicate."""
    values = values or {}
    instance = model.all_objects.filter(**lookup).order_by("-created_at").first()
    if instance:
        instance.deleted_at = None
        instance.workspace = workspace
        for field, value in values.items():
            setattr(instance, field, value)
        instance.save()
        return instance
    return model.objects.create(workspace=workspace, **lookup, **values)


def _date(value, year_only=False):
    if value in (None, ""):
        return None
    if isinstance(value, datetime):
        value = value.date()
    if isinstance(value, date):
        if year_only and value.year < 1910:
            serial = (value - date(1899, 12, 30)).days
            if 1900 <= serial <= 2100:
                return date(serial, 1, 1)
        return value
    text = str(value).strip()
    if re.fullmatch(r"\d{4}(?:\.0)?", text):
        year = int(float(text))
        if 1900 <= year <= 2100:
            return date(year, 1, 1)
    # "2024-12-13", "2024-12-13 00:00:00", "2024-12-13T00:00:00Z": the date part
    iso = re.match(r"^(\d{4}-\d{2}-\d{2})(?:[T ]\d{1,2}:\d{2}.*)?$", text)
    parsed = parse_date(iso.group(1)) if iso else None
    if parsed:
        return _date(parsed, year_only=year_only)
    normalized = _plain(text).replace(" de ", " ")
    for spanish, english in MONTHS.items():
        normalized = re.sub(rf"\b{spanish}\b", english, normalized)
    formats = (
        "%d/%m/%Y", "%m/%d/%Y", "%d-%m-%Y", "%m-%d-%Y", "%Y/%m/%d",
        "%d.%m.%Y", "%d %B %Y", "%B %d %Y", "%B %d, %Y", "%B %Y",
    )
    for fmt in formats:
        try:
            return _date(datetime.strptime(normalized, fmt).date(), year_only=year_only)
        except ValueError:
            continue
    return None


def _mapped_date(row, mapping, key):
    columns = _columns_for(mapping, key)
    column = columns[0] if columns else ""
    return _date(row.get(column), year_only=any(token in _plain(column) for token in ("year", "ano")))


def _duration_ms(value):
    if value in (None, ""):
        return None

    if isinstance(value, timedelta):
        return max(0, round(value.total_seconds() * 1000))
    if isinstance(value, (datetime, time)):
        return round(
            (value.hour * 3600 + value.minute * 60 + value.second + value.microsecond / 1_000_000) * 1000
        )

    text = str(value).strip()
    clock = re.search(r"(?<!\d)(\d{1,3}):(\d{1,2})(?::(\d{1,2}(?:\.\d+)?))?", text)
    if clock:
        first, second, third = clock.groups()
        seconds = (
            int(first) * 3600 + int(second) * 60 + float(third)
            if third is not None
            else int(first) * 60 + float(second)
        )
        return max(0, round(seconds * 1000))

    normalized = _plain(text).replace(",", ".")
    unit_parts = re.findall(
        r"(\d+(?:\.\d+)?)\s*(horas?|hrs?|h|minutos?|mins?|min|m|segundos?|segs?|secs?|seg|sec|s)\b",
        normalized,
    )
    if unit_parts:
        hours = sum(float(number) for number, unit in unit_parts if unit.startswith(("h", "hora")))
        minutes = sum(float(number) for number, unit in unit_parts if unit.startswith(("m", "minuto")))
        seconds = sum(float(number) for number, unit in unit_parts if unit.startswith(("s", "seg")))
        return max(0, round((hours * 3600 + minutes * 60 + seconds) * 1000))

    try:
        number = float(normalized)
        # Excel stores formatted times as a fraction of one day.
        if 0 < number < 1:
            return round(number * 86_400_000)
        return round(number * 1000) if number < 36000 else round(number)
    except ValueError:
        return None


def _position(value):
    """A track or disc number: "1", "01", "3/12", 2.0 -> int; None otherwise."""
    match = re.match(r"^\s*0*(\d{1,5})(?:\.0+)?(?:\s*(?:/|of|de)\s*\d+)?\s*$", str(value if value is not None else ""))
    number = int(match.group(1)) if match else None
    return number if number and number <= 32767 else None


def _decimal(value):
    try:
        return Decimal(str(value).replace("%", "").strip()) if value not in (None, "") else None
    except InvalidOperation:
        return None


def _bool(value):
    return str(value).strip().lower() in {"1", "true", "yes", "si", "sí", "y"}


def _columns_for(mapping, key):
    """Columns mapped to a field. Multi-capable fields (links, credits…) may
    map SEVERAL columns: the mapping value is then a list instead of a str."""
    value = mapping.get(key)
    if not value:
        return []
    return [column for column in (value if isinstance(value, list) else [value]) if column]


def _mapped(row, mapping, key, default=""):
    columns = _columns_for(mapping, key)
    column = columns[0] if columns else None
    return str(row.get(column, default)).strip() if column and row.get(column) is not None else default


def _mapped_many(row, mapping, key):
    """Non-empty values across EVERY column mapped to the field."""
    values = []
    for column in _columns_for(mapping, key):
        raw = row.get(column)
        if raw is None:
            continue
        text = str(raw).strip()
        if text:
            values.append(text)
    return values


def _import_error_message(exc):
    # Row-parsing helpers below raise ValueError/KeyError with a deliberate,
    # human-authored message ("Track title is empty", "Duplicate track: X") —
    # that IS the intended per-row feedback for this feature and is safe to
    # show as-is. A DB-layer failure (IntegrityError/DatabaseError) is not:
    # its message can include real constraint, column and table names, so it
    # gets a generic message instead of the raw driver text — except the one
    # known case worth a specific, actionable message.
    if isinstance(exc, DatabaseError):
        message = str(exc)
        if "music_tracks.parent_track_id" in message and "does not exist" in message:
            return (
                "The music catalog database is not ready. Apply migration "
                "db.0136_musictrack_parent_track and restart the API before importing."
            )
        log_exception(exc)
        return "This row could not be saved due to a database error. Please try again or contact support."
    return str(exc)


def _jsonable_import_value(value):
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def _import_error_detail(index, exc, row, mapping):
    message = _import_error_message(exc)
    field = None
    code = "ROW_VALIDATION_ERROR"
    if message == "Track title is empty":
        field = "track.title"
        code = "REQUIRED_FIELD"
    elif message.startswith("Duplicate track:"):
        field = "track.isrc" if mapping.get("track.isrc") else "track.title"
        code = "DUPLICATE"
    elif message.startswith("The music catalog database is not ready"):
        code = "DATABASE_NOT_READY"
    elif message.startswith("Too long: "):
        field = message.removeprefix("Too long: ")
        code = "TOO_LONG"
    field_columns = _columns_for(mapping, field) if field else []
    column = field_columns[0] if field_columns else None
    return {
        "row": index,
        "code": code,
        "field": field,
        "column": column,
        "value": _jsonable_import_value(row.get(column)) if column else None,
        "message": message,
        "row_data": {
            str(key): _jsonable_import_value(value) for key, value in list(row.items())[:12]
        },
    }


def _apply_row_overrides(row, mapping, overrides):
    if not overrides:
        return row, mapping
    next_row = dict(row)
    next_mapping = dict(mapping)
    for field, value in overrides.items():
        override_column = f"__override__{field}"
        next_row[override_column] = value
        next_mapping[field] = override_column
    return next_row, next_mapping


def _music_schema_ready():
    try:
        with connection.cursor() as cursor:
            columns = {
                column.name for column in connection.introspection.get_table_description(cursor, "music_tracks")
            }
        return "parent_track_id" in columns
    except Exception:
        return False


def _unique_headers(values):
    headers, counts = [], {}
    for index, value in enumerate(values, start=1):
        base = str(value or "").strip() or f"Column {index}"
        counts[base] = counts.get(base, 0) + 1
        headers.append(base if counts[base] == 1 else f"{base} ({counts[base]})")
    return headers


def _header_index(rows):
    best_index, best_score = 0, -1
    for index, row in enumerate(rows[:25]):
        values = [str(value).strip() for value in row if value not in (None, "")]
        words = sum(bool(re.search(r"[A-Za-z\u00c0-\u024f]", value)) for value in values)
        score = words * 3 + len(set(values)) - index * 0.05
        if len(values) >= 2 and score > best_score:
            best_index, best_score = index, score
    return best_index


# Excel's "keep as text" trick in CSV exports: ="0198704887383"
EXCEL_TEXT_WRAPPER = re.compile(r'^="(.*)"$', re.DOTALL)
NUMERIC_DATE = re.compile(r"^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$")


def _unwrap_cell(value):
    if isinstance(value, str):
        match = EXCEL_TEXT_WRAPPER.match(value.strip())
        if match:
            return match.group(1)
    return value


def _normalize_month_first_dates(headers, rows):
    """"12/4/2025" is April 12 or December 4 depending on the file. A single
    value per column settles it: "5/17/2024" can only be month-first. Such
    columns are rewritten as ISO dates; columns without that evidence keep the
    day-first reading used everywhere else."""
    for header in headers:
        month_first = day_first = False
        for row in rows:
            value = row.get(header)
            match = NUMERIC_DATE.match(value.strip()) if isinstance(value, str) else None
            if not match:
                continue
            first, second = int(match.group(1)), int(match.group(2))
            day_first = day_first or first > 12
            month_first = month_first or second > 12
        if not month_first or day_first:
            continue
        for row in rows:
            value = row.get(header)
            match = NUMERIC_DATE.match(value.strip()) if isinstance(value, str) else None
            if match:
                month, day, year = (int(part) for part in match.groups())
                try:
                    row[header] = date(year, month, day).isoformat()
                except ValueError:
                    continue


def _read_table(upload, sheet_name=None):
    content = upload.read()
    filename = upload.name.lower()
    sheets = []
    if filename.endswith((".xlsx", ".xlsm")):
        workbook = load_workbook(BytesIO(content), read_only=True, data_only=True)
        sheets = workbook.sheetnames
        worksheet = workbook[sheet_name] if sheet_name in sheets else workbook[workbook.sheetnames[0]]
        raw_rows = [list(row) for row in worksheet.iter_rows(values_only=True)]
    else:
        decoded = None
        for encoding in ("utf-8-sig", "cp1252", "latin-1"):
            try:
                decoded = content.decode(encoding)
                break
            except UnicodeDecodeError:
                continue
        sample = (decoded or "")[:8192]
        try:
            delimiter = csv.Sniffer().sniff(sample, delimiters=",;\t|").delimiter
        except csv.Error:
            delimiter = ","
        raw_rows = list(csv.reader(StringIO(decoded or ""), delimiter=delimiter))
    if not raw_rows or not any(any(value not in (None, "") for value in row) for row in raw_rows):
        return [], [], sheets, 0
    raw_rows = [[_unwrap_cell(value) for value in row] for row in raw_rows]
    header_row = _header_index(raw_rows)
    width = max(len(row) for row in raw_rows)
    headers = _unique_headers(list(raw_rows[header_row]) + [None] * (width - len(raw_rows[header_row])))
    rows = [
        {headers[index]: value for index, value in enumerate(list(row) + [None] * (width - len(row)))}
        for row in raw_rows[header_row + 1 :]
        if any(value not in (None, "") for value in row)
    ]
    _normalize_month_first_dates(headers, rows)
    return headers, rows, sheets, header_row + 1


class _StoredUpload:
    """File-like (.read() + .name) over a stored import asset so every import
    endpoint can consume a saved file exactly like a fresh browser upload."""

    def __init__(self, content, name):
        self._content = content
        self.name = name

    def read(self):
        return self._content

    def seek(self, _position):
        return None


def _asset_upload(slug, asset_id):
    """Loads a saved MUSIC_CATALOG import asset as an upload-like object (for
    re-imports the file is never re-uploaded by the browser)."""
    from plane.settings.storage import S3Storage

    asset = FileAsset.objects.get(
        id=asset_id,
        workspace__slug=slug,
        entity_type=FileAsset.EntityTypeContext.MUSIC_CATALOG,
        is_deleted=False,
    )
    storage = S3Storage()
    obj = storage.s3_client.get_object(Bucket=storage.aws_storage_bucket_name, Key=asset.asset.name)
    name = (asset.attributes or {}).get("name") or asset.asset.name
    return asset, _StoredUpload(obj["Body"].read(), name)


IMPORT_ALIASES = {
    "track.title": (
        "track", "song", "song name", "track name", "track title", "song title", "titulo", "cancion",
        "nombre cancion", "nombre de la cancion",
    ),
    "track.version": ("track version",),
    "track.status": ("submission status", "track status"),
    "track.external_id": ("track id", "song id", "track identifier", "id cancion"),
    "track.p_line": ("track p line", "linea p cancion"),
    "track.c_line": ("track c line", "linea c cancion"),
    "track.tiktok_preview_start_ms": (
        "sample start time", "preview start", "preview start time", "clip start", "clip start time",
        "tiktok start", "inicio preview", "inicio del preview",
    ),
    "track.language": ("audio language", "track language", "idioma"),
    "track.explicit": ("explicit lyrics", "explicit", "explicitlyrics", "explicito"),
    "track.isrc": ("isrc", "isrc audio", "isrc song"),
    "track.isrc_video": ("isrc video", "video isrc"),
    "track.catalog": ("catalog", "catalogo", "catalog number", "no cat", "cat"),
    "track.upc": ("upc", "ean", "barcode"),
    "track.release_date": ("track release date", "fecha lanzamiento cancion"),
    "track.duration_ms": ("duration", "duracion", "duracion tipo", "time"),
    "release.title": (
        "album", "album name", "album title", "product title", "release title", "release name",
        "titulo album single lp ep",
    ),
    "release.p_line": ("product p line", "p line"),
    "release.c_line": ("product c line", "c line"),
    "release.version": ("product version", "release version", "album version"),
    # Not "Product Type": distributors use it for Audio / Video
    "release.type": (
        "release type", "tipo de lanzamiento", "tipo lanzamiento", "product format", "release format", "format",
        "formato", "configuration", "product configuration", "album type", "tipo de album",
    ),
    "release.status": ("submission status", "product status", "release status", "album status"),
    "release.language": (
        "primary metadata language", "metadata language", "product language", "release language", "album language",
    ),
    "release.external_id": ("product id", "release id", "album id", "id lanzamiento"),
    "release.artists": (
        "product display artist", "product artist", "release artist", "release artists", "album artist",
        "album artists", "artista del album",
    ),
    "release.track_number": ("track number", "track no", "track num", "numero de pista", "no pista", "pista"),
    "release.disc_number": ("track volume", "disc number", "disc", "volume number", "disco", "numero de disco"),
    "release.upc": ("upc",),
    "release.catalog_number": ("catalog", "catalog number", "product catalog"),
    "release.release_date": ("album release date", "release date", "fecha ano", "fecha"),
    "artists": (
        "artist", "artists", "artista", "main artist", "track display artist", "display artist",
        "track artist", "product display artist",
    ),
    "genres": ("genre", "genero", "track genre", "product genre"),
    "writers": ("writer", "writers", "escritor", "escritores", "songwriter", "songwriters"),
    "record_label": ("label", "label name", "licencia", "statement", "sello", "disquera"),
    "contributors": (
        "non performing contributors", "nonperforming contributors", "contributors", "credits", "creditos",
        "colaboradores", "other contributors",
    ),
    "performers": ("performing contributors", "performers", "musicians", "musicos", "interpretes"),
    "publishers": (
        "publishers collection societies", "publishers", "publisher", "publisher s", "editoras", "editora",
        "editorial", "publishing",
    ),
    "aggregator": ("agregadora", "agregador"),
    "distributor": ("distribuidora", "distribuidor"),
    "track.video_url": ("video url", "video link", "link video", "url video", "youtube", "music video url"),
    "track.video_release_date": ("video release date", "fecha video", "fecha lanzamiento video"),
    "track.streaming_url": (
        "streaming url", "spotify", "spotify url", "enlace", "song url", "track play link", "play link",
    ),
}

IMPORT_FIELDS = [
    "track.title", "track.version", "track.isrc", "track.isrc_video", "track.catalog", "track.upc",
    # The distributor's own id for the song ("Track Id"), kept in metadata
    "track.external_id", "track.kind",
    "track.status", "track.release_date", "track.original_release_date", "track.duration_ms",
    "track.tiktok_preview_start_ms",
    "track.country_of_recording", "track.language", "track.explicit", "track.ownership",
    "track.us_publishing_obligations", "track.recoupment", "track.digital_format", "track.p_line", "track.c_line",
    "track.lyrics",
    "track.aggregator_percentage", "track.distributor_percentage", "track.record_label_percentage",
    "track.artist_percentage", "track.writer_percentage", "release.title", "release.version", "release.type",
    "release.status", "release.upc", "release.external_id", "release.catalog_number", "release.release_date",
    "release.language", "release.p_line", "release.c_line", "release.artists",
    # Where the song sits in its release
    "release.track_number", "release.disc_number", "artists",
    "featured_artists", "writers", "authors", "composers", "producers", "recording_engineers", "mixers",
    "mastering_engineers", "legal_representatives", "genres", "record_label", "aggregator", "distributor",
    # Tagged credits with any role ("Ana <Tuba>", "Luis <MixingEngineer>") and publishers
    "contributors", "performers", "publishers",
    # Content-detected columns: a column of URLs maps here even when its
    # header says nothing useful (the assistant decides by LOOKING at values)
    "track.video_url", "track.video_release_date", "track.streaming_url",
]


# One line per import field, for the AI mapper (what each field holds).
FIELD_DESCRIPTIONS = {
    "track.title": "Song title (required)",
    "track.version": "Version of the song: Live, Remix, Acoustic, Radio Edit",
    "track.isrc": "ISRC code of the audio recording, e.g. USRC17607839",
    "track.isrc_video": "ISRC code of the music video",
    "track.catalog": "Catalog number of the song",
    "track.upc": "UPC/EAN barcode attached to the song row",
    "track.external_id": "The distributor's internal id for the song (Track Id)",
    "track.kind": "Audio or video",
    "track.status": "Status of the song: draft, ready, released, taken down",
    "track.release_date": "Release date of the song",
    "track.original_release_date": "Original release date",
    "track.duration_ms": "Duration, e.g. 3:16",
    "track.tiktok_preview_start_ms": "Start time of the preview / sample clip, e.g. 00:00:47",
    "track.country_of_recording": "Country where it was recorded (2-letter code)",
    "track.language": "Language of the song's audio/lyrics",
    "track.explicit": "Explicit lyrics yes/no",
    "track.ownership": "Ownership / rights holder notes",
    "track.us_publishing_obligations": "US publishing obligations notes",
    "track.recoupment": "Recoupment notes",
    "track.digital_format": "Digital format",
    "track.p_line": "Song-level (P) phonographic copyright line, e.g. ℗ 2025 Label",
    "track.c_line": "Song-level (C) copyright line, e.g. © 2025 Label",
    "track.lyrics": "Full lyrics text",
    "track.aggregator_percentage": "Aggregator share %",
    "track.distributor_percentage": "Distributor share %",
    "track.record_label_percentage": "Record label share %",
    "track.artist_percentage": "Artist share %",
    "track.writer_percentage": "Writer share %",
    "release.title": "Album / EP / single (product) title",
    "release.version": "Version of the release (product version)",
    "release.type": (
        "Release type / format: single, EP, LP, album, compilation, soundtrack (NOT 'Product Type', "
        "which holds Audio/Video)"
    ),
    "release.status": "Status of the release (e.g. submission status Released)",
    "release.upc": "UPC/EAN of the release",
    "release.external_id": "The distributor's internal id for the release (Product Id)",
    "release.catalog_number": "Catalog number of the release",
    "release.release_date": "Release date of the album/product",
    "release.language": "Metadata language of the release",
    "release.p_line": "Release-level (P) line, e.g. Product P Line",
    "release.c_line": "Release-level (C) line, e.g. Product C Line",
    "release.artists": "Display artists of the release/product (may differ from the song's)",
    "release.track_number": "Position of the song in its release (track number)",
    "release.disc_number": "Disc / volume number of the song in its release",
    "artists": "Main / display artists of the song",
    "featured_artists": "Featured artists (feat.)",
    "writers": "Songwriters",
    "authors": "Lyricists / authors",
    "composers": "Composers",
    "producers": "Producers",
    "recording_engineers": "Recording engineers",
    "mixers": "Mixing engineers",
    "mastering_engineers": "Mastering engineers",
    "legal_representatives": "Legal representatives",
    "genres": "Genres",
    "record_label": "Record label",
    "aggregator": "Aggregator company",
    "distributor": "Distributor company",
    "contributors": "Credited people tagged with ANY role, e.g. 'Ana <MixingEngineer>, Luis <AR>'",
    "performers": "Performing musicians tagged with their instrument/voice, e.g. 'Ana <Vocals>'",
    "publishers": "Publishers / collection societies, e.g. 'Top Music <ASCAP>'",
    "track.video_url": "Music video URL (YouTube…)",
    "track.video_release_date": "Release date of the music video",
    "track.streaming_url": "Streaming / store / play link of the song (Spotify, Apple Music…)",
}


def _clean_mapping(value, headers):
    """{field: column | [columns]} with real fields and real headers only."""
    if not isinstance(value, dict):
        return {}
    header_set = set(headers)
    mapping = {}
    for field, item in value.items():
        if field not in IMPORT_FIELDS:
            continue
        columns = [column for column in (item if isinstance(item, list) else [item]) if column in header_set]
        if columns:
            mapping[field] = columns if field in MULTI_COLUMN_FIELDS else columns[0]
    return mapping


def _clean_ai_suggestions(data, headers, locked):
    """Per field {columns, confidence, reason, replace, locked} from the
    Worker. An older Worker only returns `mapping`: those suggestions come
    without confidence or reason."""
    header_set = set(headers)
    raw = data.get("suggestions")
    if not isinstance(raw, dict):
        raw = {field: {"columns": value} for field, value in (data.get("mapping") or {}).items()}
    suggestions = {}
    for field, entry in raw.items():
        if field not in IMPORT_FIELDS or not isinstance(entry, dict):
            continue
        value = entry.get("columns")
        columns = []
        for column in value if isinstance(value, list) else [value]:
            if column in header_set and column not in columns:
                columns.append(column)
        if not columns:
            continue
        multi = field in MULTI_COLUMN_FIELDS
        try:
            confidence = entry.get("confidence")
            confidence = None if confidence is None else min(1.0, max(0.0, float(confidence)))
        except (TypeError, ValueError):
            confidence = None
        suggestions[field] = {
            "columns": columns if multi else columns[:1],
            "confidence": confidence,
            "reason": str(entry.get("reason") or "").strip()[:300],
            "replace": bool(multi and entry.get("replace") is True),
            "locked": field in locked,
        }
    return suggestions


def _urls_in(values):
    """The http(s) URLs in some cells; a cell may hold several separated by
    spaces, ";" or "|" (how the catalog export writes them)."""
    urls = []
    for value in values:
        for part in re.split(r"[\s;|]+", str(value or "")):
            part = part.strip(" ,")
            if part.startswith(("http://", "https://")) and part not in urls:
                urls.append(part)
    return urls


def _link_platform(url):
    """Readable platform name from a URL's host ("YouTube", "Spotify"…)."""
    match = re.search(r"https?://(?:www\.)?([^/:]+)", str(url or ""))
    if not match:
        return ""
    host = match.group(1)
    known = {
        "youtube.com": "YouTube", "youtu.be": "YouTube", "open.spotify.com": "Spotify",
        "music.apple.com": "Apple Music", "deezer.com": "Deezer", "tidal.com": "Tidal",
        "soundcloud.com": "SoundCloud", "music.amazon.com": "Amazon Music",
    }
    for domain, name in known.items():
        if host == domain or host.endswith("." + domain):
            return name
    return host.split(".")[0].capitalize()


# Typed canonical fields: raw values that fail these parsers are "variables"
# ("ringtone" in a duration column) the user must resolve via value_overrides
UNPARSED_CHECKS = {
    # Synonyms included ("Sencillo", "Banda sonora"); anything else is decided by the user
    "release.type": release_type_value,
    "track.duration_ms": _duration_ms,
    "track.release_date": _date,
    "track.original_release_date": _date,
    "track.video_release_date": _date,
    "release.release_date": _date,
    "track.tiktok_preview_start_ms": _duration_ms,
    "release.track_number": _position,
    "release.disc_number": _position,
    "track.aggregator_percentage": _decimal,
    "track.distributor_percentage": _decimal,
    "track.record_label_percentage": _decimal,
    "track.artist_percentage": _decimal,
    "track.writer_percentage": _decimal,
}

def _field_length_limits():
    """{import field: max characters} for plain text columns of tracks and
    releases. Choice fields are left out: their raw text is normalized first."""
    limits = {}
    models_by_prefix = {"track": MusicTrack, "release": MusicRelease}
    for field in IMPORT_FIELDS:
        prefix, _, attr = field.partition(".")
        model = models_by_prefix.get(prefix)
        if not model or not attr:
            continue
        try:
            model_field = model._meta.get_field(attr)
        except Exception:
            continue
        if isinstance(model_field, models.CharField) and model_field.max_length and not model_field.choices:
            limits[field] = model_field.max_length
    return limits


FIELD_LENGTH_LIMITS = _field_length_limits()


def _fits(limit):
    return lambda value: value if len(str(value).strip()) <= limit else None


# A value longer than its column ("Spanish (Latin America)" in a 20-character
# language field) is a value to decide on, grouped like any other misfit.
for _field, _limit in FIELD_LENGTH_LIMITS.items():
    UNPARSED_CHECKS.setdefault(_field, _fits(_limit))


def _check_lengths(row, mapping):
    """Fails the row with a clear, field-level message instead of a database
    error when a mapped text value is longer than its column."""
    for field, limit in FIELD_LENGTH_LIMITS.items():
        value = _mapped(row, mapping, field)
        if field in ("track.isrc", "track.isrc_video"):
            value = value.upper().replace("-", "")
        if len(value) > limit:
            raise ValueError(f"Too long: {field}")


CHOICE_FIELDS = {
    "track.kind": MusicTrack.Kind.choices,
    "track.status": MusicTrack.Status.choices,
    "release.type": MusicRelease.Type.choices,
    "release.status": MusicRelease.Status.choices,
}
for _field, _choices in CHOICE_FIELDS.items():
    UNPARSED_CHECKS.setdefault(_field, lambda value, choices=_choices: _choice_value(value, choices))


# value_overrides sentinel: rows whose raw value maps to this are not imported
SKIP_ROW = "__SKIP_ROW__"

# Fields that accept SEVERAL source columns (mapping value = list of columns):
# link columns and people/genre/company columns can appear more than once.
MULTI_COLUMN_FIELDS = [
    "artists", "featured_artists", "writers", "authors", "composers", "producers", "recording_engineers",
    "mixers", "mastering_engineers", "legal_representatives", "genres", "record_label",
    "aggregator", "distributor", "track.video_url", "track.streaming_url",
    "contributors", "performers", "publishers", "release.artists",
]

# Company fields and the kind of company each one creates/links
COMPANY_FIELD_KINDS = {
    "record_label": MusicCompany.Kind.RECORD_LABEL,
    "aggregator": MusicCompany.Kind.AGGREGATOR,
    "distributor": MusicCompany.Kind.DISTRIBUTOR,
    "publishers": MusicCompany.Kind.PUBLISHER,
}

# Fields whose values are people/artists (MusicParty)
PARTY_FIELDS = (
    "artists", "featured_artists", "writers", "authors", "composers", "producers", "recording_engineers",
    "mixers", "mastering_engineers", "legal_representatives", "contributors", "performers", "release.artists",
)

# Example of the expected format per typed field, shown when the user decides
# to replace an unparseable "variable" token
FIELD_FORMAT_EXAMPLES = {
    "track.duration_ms": "3:16",
    "track.release_date": "2023-05-01",
    "track.original_release_date": "2023-05-01",
    "track.video_release_date": "2023-05-01",
    "release.release_date": "2023-05-01",
    "track.tiktok_preview_start_ms": "0:47",
    "release.track_number": "1",
    "release.disc_number": "1",
    "track.aggregator_percentage": "50",
    "track.distributor_percentage": "50",
    "track.record_label_percentage": "50",
    "track.artist_percentage": "50",
    "track.writer_percentage": "50",
}
# Fixed-choice fields show their valid options as the expected format
for _field, _choices in CHOICE_FIELDS.items():
    FIELD_FORMAT_EXAMPLES.setdefault(_field, " / ".join(str(label) for _, label in _choices))


def _column_samples(headers, rows, limit=10):
    """Per column: fill count and up to `limit` non-empty examples scanned over
    the WHOLE file — a column empty for thousands of rows and populated later
    must still be classifiable (by the AI mapper or the user)."""
    samples = {}
    for header in headers:
        examples = []
        non_empty = 0
        for row in rows:
            value = row.get(header)
            if value in (None, ""):
                continue
            non_empty += 1
            if len(examples) < limit:
                text = value.isoformat() if isinstance(value, (date, datetime)) else str(value)
                examples.append(text[:120])
        samples[header] = {"non_empty": non_empty, "total": len(rows), "examples": examples}
    return samples


def _collect_unparsed(row, mapping):
    """{canonical_field: raw_token} for typed columns whose value parses to
    nothing — the import would silently drop them without user input."""
    found = {}
    for field, parser in UNPARSED_CHECKS.items():
        for column in _columns_for(mapping, field):
            raw = row.get(column)
            if raw in (None, ""):
                continue
            if parser(raw) is None:
                found[field] = str(raw).strip()
                break
    return found


def _apply_overrides(row, mapping, value_overrides):
    """Returns (row_with_replacements, skip_row). Overrides are keyed by
    canonical field → {raw_token(lower): replacement}; empty replacement
    imports the row with that cell blank, SKIP_ROW drops the whole row."""
    if not value_overrides:
        return row, False
    patched = dict(row)
    for field, tokens in value_overrides.items():
        if not isinstance(tokens, dict):
            continue
        for column in _columns_for(mapping, field):
            raw = patched.get(column)
            if raw in (None, ""):
                continue
            replacement = tokens.get(str(raw).strip().lower())
            if replacement is None:
                continue
            if replacement == SKIP_ROW:
                return patched, True
            patched[column] = replacement
    return patched, False


# "unchanged" (matched, nothing to update) keeps the record as it was.
OUTCOME_ACTION = {"created": "CREATED", "updated": "UPDATED", "unchanged": "PRESERVED", "skipped": "PRESERVED"}


def _record_import_run(workspace, *, file_asset, source_name, source, sheet, rules, summary, touched):
    """Persists the provenance of one applied import: the run itself plus a
    link per affected track (created/updated/preserved, with its row)."""
    from plane.db.models import MusicImportRun, MusicTrackImport

    run = MusicImportRun.objects.create(
        workspace=workspace,
        file_asset=file_asset,
        source_name=(source_name or "")[:500],
        source=source,
        sheet=sheet or "",
        rules=rules,
        summary=summary,
    )
    # unique (track, run): if several rows touched the same track keep the last
    by_track = {}
    for track_id, outcome, row_number in touched:
        by_track[track_id] = (OUTCOME_ACTION.get(outcome, "PRESERVED"), row_number)
    MusicTrackImport.objects.bulk_create(
        [
            MusicTrackImport(
                workspace=workspace,
                track_id=track_id,
                import_run=run,
                action=action,
                row_number=row_number,
            )
            for track_id, (action, row_number) in by_track.items()
        ],
        ignore_conflicts=True,
    )
    return run


# Fields whose bare name ("Version", "Status", "Artists") belongs to the
# song's own field: they only map through their explicit aliases.
ALIAS_ONLY_FIELDS = {
    "release.version", "release.status", "release.language", "release.artists", "release.external_id",
}


def _infer_mapping(headers, fields):
    key = lambda value: re.sub(r"[^a-z0-9]+", " ", _plain(value)).strip()
    normalized = {key(header): header for header in headers}
    result = {}
    for field in fields:
        bare = () if field in ALIAS_ONLY_FIELDS else (field, field.split(".")[-1])
        candidates = (*bare, *IMPORT_ALIASES.get(field, ()))
        for candidate in candidates:
            wanted = key(candidate)
            match = next((header for key, header in normalized.items() if key == wanted), None)
            if match:
                result[field] = match
                break
    return result


def _party(workspace, name, kind=MusicParty.Kind.ARTIST):
    """Same name and kind first; otherwise the same name of another kind (the
    writer who is also the artist, a group created by hand) before creating
    a near-identical second record."""
    name = str(name)[:255]
    parties = MusicParty.objects.filter(workspace=workspace, display_name__iexact=name)
    party = parties.filter(kind=kind).first() or parties.order_by("created_at").first()
    return party or MusicParty.objects.create(workspace=workspace, kind=kind, display_name=name)


def _save_credit(workspace, track, party, role, detail="", replace=False):
    """Adds (or revives) one credit. (track, party, role) is unique, so extra
    details for the same person and role are merged into `role_detail`; in
    replace mode the file's detail, when it has one, replaces the stored one."""
    credit = MusicCredit.all_objects.filter(track=track, party=party, role=role).order_by("-created_at").first()
    if credit is None:
        return MusicCredit.objects.create(
            workspace=workspace, track=track, party=party, role=role, role_detail=detail[:120]
        )
    restored = credit.deleted_at is not None
    current = "" if restored else credit.role_detail
    next_detail = detail[:120] if replace and detail else merge_details(current, detail)
    if restored or next_detail != credit.role_detail:
        credit.deleted_at = None
        credit.workspace = workspace
        credit.role_detail = next_detail
        credit.save()
    return credit


def _genre(workspace, name):
    genre = MusicGenre.objects.filter(workspace=workspace, name__iexact=name).first()
    return genre or MusicGenre.objects.create(workspace=workspace, name=name)


def _filter_releases(queryset, params):
    search = params.get("search")
    if search:
        queryset = queryset.filter(
            Q(title__icontains=search)
            | Q(upc__icontains=search)
            | Q(catalog_number__icontains=search)
            | Q(artist_links__party__display_name__icontains=search)
        )
    if params.get("type"):
        queryset = queryset.filter(release_type=params["type"])
    if params.get("status"):
        queryset = queryset.filter(status=params["status"])
    if params.get("artist"):
        queryset = queryset.filter(artist_links__party_id=params["artist"])
    if params.get("year"):
        queryset = queryset.filter(release_date__year=params["year"])
    if params.get("from"):
        queryset = queryset.filter(release_date__gte=params["from"])
    if params.get("to"):
        queryset = queryset.filter(release_date__lte=params["to"])
    if params.get("upc"):
        queryset = queryset.filter(upc__iexact=params["upc"])
    if params.get("contract"):
        queryset = filter_by_contract(queryset, params["contract"], "release")
    return queryset.distinct()


def _filter_tracks(queryset, params):
    search = params.get("search")
    if search:
        queryset = queryset.filter(
            Q(title__icontains=search)
            | Q(isrc__icontains=search)
            | Q(isrc_video__icontains=search)
            | Q(catalog__icontains=search)
            | Q(credits__party__display_name__icontains=search)
            | Q(videos__title__icontains=search)
            | Q(videos__isrc_video__icontains=search)
        )
    def _values(key):
        return [value for value in params.get(key, "").split(",") if value]

    for field in ("kind", "isrc", "isrc_video", "language", "country_of_recording"):
        if params.get(field):
            queryset = queryset.filter(**{field: params[field]})
    # Dynamic-entity filters accept comma-separated lists (multi-select UI)
    if params.get("status"):
        # iexact per value so legacy rows stored with the label ("Released")
        # still match the canonical enum sent by the UI ("RELEASED").
        status_q = Q()
        for value in _values("status"):
            status_q |= Q(status__iexact=value)
        queryset = queryset.filter(status_q)
    if params.get("artist"):
        queryset = queryset.filter(credits__party_id__in=_values("artist"))
    if params.get("genre"):
        queryset = queryset.filter(genre_links__genre_id__in=_values("genre"))
    if params.get("release"):
        queryset = queryset.filter(release_links__release_id__in=_values("release"))
    if params.get("year"):
        years = [value for value in _values("year") if value.isdigit()]
        if years:
            queryset = queryset.filter(
                Q(release_date__year__in=years) | Q(release_links__release__release_date__year__in=years)
            )
    if params.get("has_lyrics") == "true":
        queryset = queryset.exclude(lyrics="")
    if params.get("from"):
        queryset = queryset.filter(release_date__gte=params["from"])
    if params.get("to"):
        queryset = queryset.filter(release_date__lte=params["to"])
    if params.get("has_video") == "true":
        # A real music video carries at least one identifier or a video URL —
        # a bare child track (e.g. a stray import row) is not "having video".
        videos = MusicTrack.objects.filter(
            parent_track_id=OuterRef("pk"),
            kind=MusicTrack.Kind.MUSIC_VIDEO,
        ).filter(
            Q(links__kind=MusicLink.Kind.MUSIC_VIDEO)
            | ~Q(isrc_video="")
            | ~Q(upc="")
            | ~Q(catalog="")
        )
        queryset = queryset.filter(Exists(videos))
    if params.get("has_links") == "true":
        queryset = queryset.filter(Exists(MusicLink.objects.filter(track_id=OuterRef("pk"))))
    # A video's own identifiers (videos are child tracks with their ISRC/UPC).
    if params.get("video_isrc"):
        value = params["video_isrc"].strip()
        queryset = queryset.filter(Q(videos__isrc_video__icontains=value) | Q(videos__isrc__icontains=value))
    if params.get("video_upc"):
        queryset = queryset.filter(videos__upc__icontains=params["video_upc"].strip())
    if params.get("video_from"):
        queryset = queryset.filter(videos__release_date__gte=params["video_from"])
    if params.get("video_to"):
        queryset = queryset.filter(videos__release_date__lte=params["video_to"])
    if params.get("company"):
        queryset = queryset.filter(distributions__company_id__in=_values("company"))
    if params.get("ids"):
        queryset = queryset.filter(id__in=_values("ids"))
    if params.get("import_run"):
        queryset = queryset.filter(import_links__import_run_id=params["import_run"])
    if params.get("import_file"):
        # Any run of those source files (re-imports of the same upload included);
        # "run:<id>" picks a run that kept no source file
        values = _values("import_file")
        asset_ids = [value for value in values if not value.startswith("run:")]
        run_ids = [value[4:] for value in values if value.startswith("run:")]
        queryset = queryset.filter(
            Q(import_links__import_run__file_asset_id__in=asset_ids) | Q(import_links__import_run_id__in=run_ids)
        )
    # with | without | expired: covered by a linked contract (a song also by its releases')
    if params.get("contract"):
        queryset = filter_by_contract(queryset, params["contract"], "track")
    return queryset.distinct()


def _release_artist_entries(workspace, data):
    """The release's artists from a request, or None when it doesn't set them.
    `artist_entries` ([{party_id, role}], role PRIMARY or FEATURED) wins over
    the older `artist_ids` (all primary). Only the workspace's own people."""
    if "artist_entries" in data:
        raw = data.get("artist_entries") or []
        if not isinstance(raw, list):
            raise ValidationError({"artist_entries": ["Expected a list."]})
        entries = []
        for item in raw:
            role = (item or {}).get("role") or MusicReleaseArtist.Role.PRIMARY
            if role not in MusicReleaseArtist.Role.values:
                raise ValidationError({"artist_entries": [f"Unknown artist role: {role}"]})
            entries.append((str((item or {}).get("party_id") or ""), role))
    elif "artist_ids" in data:
        entries = [(str(artist_id), MusicReleaseArtist.Role.PRIMARY) for artist_id in data.get("artist_ids") or []]
    else:
        return None
    try:
        known = {
            str(pk)
            for pk in MusicParty.objects.filter(
                workspace=workspace, id__in=[party_id for party_id, _ in entries if party_id]
            ).values_list("id", flat=True)
        }
    except DjangoValidationError:
        raise ValidationError({"artist_entries": ["Invalid artist id."]})
    unknown = [party_id for party_id, _ in entries if party_id not in known]
    if unknown:
        raise ValidationError({"artist_entries": [f"Unknown artist: {', '.join(unknown)}"]})
    # One link per person and role, in the order given
    return list(dict.fromkeys(entries))


def _sync_release_artists(release, workspace, entries):
    for party_id, role in entries or []:
        _restore_or_create(MusicReleaseArtist, workspace, {"release": release, "party_id": party_id, "role": role})


class MusicReleaseEndpoint(MusicBaseView):
    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def get(self, request, slug):
        # Live songs only: a song taken off the release (or deleted) no longer counts
        queryset = with_track_counts(
            MusicRelease.objects.filter(workspace__slug=slug).prefetch_related("artist_links__party")
        )
        queryset = _filter_releases(queryset, request.query_params).annotate(contract_count=release_contract_count())
        return Response(MusicReleaseSerializer(queryset, many=True).data)

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def post(self, request, slug):
        workspace = Workspace.objects.get(slug=slug)
        serializer = MusicReleaseSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        entries = _release_artist_entries(workspace, request.data)
        with transaction.atomic():
            release = serializer.save(workspace=workspace)
            _sync_release_artists(release, workspace, entries)
        return Response(MusicReleaseSerializer(release).data, status=status.HTTP_201_CREATED)


class MusicReleaseDetailEndpoint(MusicBaseView):
    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def get(self, request, slug, release_id):
        release = MusicRelease.objects.prefetch_related("artist_links__party").get(id=release_id, workspace__slug=slug)
        return Response(MusicReleaseSerializer(release).data)

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def patch(self, request, slug, release_id):
        release = MusicRelease.objects.get(id=release_id, workspace__slug=slug)
        serializer = MusicReleaseSerializer(release, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        entries = _release_artist_entries(release.workspace, request.data)
        with transaction.atomic():
            serializer.save()
            if entries is not None:
                release.artist_links.all().delete()
                _sync_release_artists(release, release.workspace, entries)
        return Response(MusicReleaseSerializer(release).data)

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def delete(self, request, slug, release_id):
        MusicRelease.objects.get(id=release_id, workspace__slug=slug).delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


# `order_by` values the song list accepts (a leading "-" sorts descending);
# anything else keeps the model's default (newest release first).
TRACK_ORDERINGS = {"title", "created_at", "updated_at", "release_date", "isrc", "status", "contract_count"}


def _order_tracks(queryset, value):
    field = (value or "").lstrip("-")
    if field not in TRACK_ORDERINGS:
        return queryset
    expression = F(field)
    # Songs without a date go last whichever way dates are sorted.
    ordered = expression.desc(nulls_last=True) if value.startswith("-") else expression.asc(nulls_last=True)
    return queryset.order_by(ordered, "title", "id")


class MusicTrackEndpoint(MusicBaseView):
    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def get(self, request, slug):
        queryset = MusicTrack.objects.filter(workspace__slug=slug).prefetch_related(
            "credits__party", "genre_links__genre", "release_links__release", "links",
            "distributions__company", "videos__links",
        )
        if request.query_params.get("songs_only") == "true":
            queryset = queryset.filter(parent_track__isnull=True)
        queryset = _filter_tracks(queryset, request.query_params)

        # Lightweight id list so the UI can select EVERYTHING matching the
        # active filters without serializing thousands of full tracks.
        if request.query_params.get("ids_only") == "true":
            return Response({"ids": [str(pk) for pk in queryset.values_list("id", flat=True)]})

        queryset = queryset.annotate(contract_count=track_contract_count())
        queryset = _order_tracks(queryset, request.query_params.get("order_by"))

        # Keep the original array response for existing consumers that do not request a page.
        if "page" not in request.query_params:
            return Response(MusicTrackSerializer(queryset, many=True).data)

        try:
            requested_page = max(1, int(request.query_params.get("page", 1)))
            page_size = min(100, max(1, int(request.query_params.get("page_size", 25))))
        except (TypeError, ValueError):
            requested_page, page_size = 1, 25

        total = queryset.count()
        page_count = max(1, (total + page_size - 1) // page_size)
        page = min(requested_page, page_count)
        start = (page - 1) * page_size
        results = MusicTrackSerializer(queryset[start : start + page_size], many=True).data
        return Response(
            {
                "results": results,
                "total": total,
                "page": page,
                "page_size": page_size,
                "requested_page": requested_page,
            }
        )

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def post(self, request, slug):
        workspace = Workspace.objects.get(slug=slug)
        serializer = MusicTrackSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        _validate_credit_roles(workspace, request.data.get("credit_entries"))
        track = serializer.save(workspace=workspace)
        self._sync_relations(track, workspace, request.data)
        return Response(MusicTrackSerializer(track).data, status=status.HTTP_201_CREATED)

    @staticmethod
    def _sync_relations(track, workspace, data):
        if "releases" in data:
            track.release_links.all().delete()
            for release in data.get("releases", []):
                _restore_or_create(
                    MusicReleaseTrack,
                    workspace,
                    {"track": track, "release_id": release["id"]},
                    {
                        "disc_number": release.get("disc_number", 1),
                        "track_number": release.get("track_number", 1),
                    },
                )
        if "genre_ids" in data:
            track.genre_links.all().delete()
            for genre_id in data.get("genre_ids", []):
                _restore_or_create(
                    MusicTrackGenre,
                    workspace,
                    {"track": track, "genre_id": genre_id},
                )
        if "credit_entries" in data:
            # Built-in or workspace roles only; checked before touching anything
            _validate_credit_roles(workspace, data.get("credit_entries"))
            track.credits.all().delete()
            for credit in data.get("credit_entries", []):
                _restore_or_create(
                    MusicCredit,
                    workspace,
                    {"track": track, "party_id": credit["party_id"], "role": credit["role"]},
                    {
                        "percentage": credit.get("percentage") or None,
                        "publishing_share": credit.get("publishing_share") or None,
                        "territory": credit.get("territory", ""),
                        "notes": credit.get("notes", ""),
                        # Clients that don't send it keep the revived detail
                        **(
                            {"role_detail": str(credit.get("role_detail") or "").strip()[:120]}
                            if "role_detail" in credit
                            else {}
                        ),
                    },
                )
        if "link_entries" in data:
            track.links.all().delete()
            for link in data.get("link_entries", []):
                MusicLink.objects.create(
                    workspace=workspace,
                    track=track,
                    kind=link.get("kind", MusicLink.Kind.OTHER),
                    platform=link.get("platform", ""),
                    name=link.get("name") or link.get("platform") or "Link",
                    url=link["url"],
                    isrc=link.get("isrc", ""),
                )
        if "distribution_entries" in data:
            track.distributions.all().delete()
            for entry in data.get("distribution_entries", []):
                MusicDistribution.objects.create(
                    workspace=workspace,
                    track=track,
                    company_id=entry["company_id"],
                    percentage=entry.get("percentage") or None,
                    territory=entry.get("territory", ""),
                    valid_from=entry.get("valid_from") or None,
                    valid_to=entry.get("valid_to") or None,
                )
        if "video_entries" in data:
            retained = []
            for entry in data.get("video_entries", []):
                video_id = entry.get("id")
                video = track.videos.filter(id=video_id).first() if video_id else None
                values = {
                    "title": entry.get("title") or track.title,
                    "version": entry.get("version", ""),
                    "status": entry.get("status", MusicTrack.Status.DRAFT),
                    "kind": MusicTrack.Kind.MUSIC_VIDEO,
                    "isrc_video": str(entry.get("isrc", "")).upper().replace("-", ""),
                    "upc": entry.get("upc", ""),
                    "catalog": entry.get("catalog", ""),
                    "release_date": entry.get("release_date") or None,
                    "duration_ms": entry.get("duration_ms") or None,
                    "cover_url": entry.get("cover_url", ""),
                }
                if video:
                    for key, value in values.items():
                        setattr(video, key, value)
                    video.save()
                else:
                    video = MusicTrack.objects.create(workspace=workspace, parent_track=track, **values)
                retained.append(video.id)
                video.links.filter(kind=MusicLink.Kind.MUSIC_VIDEO).delete()
                if entry.get("video_url"):
                    MusicLink.objects.create(
                        workspace=workspace,
                        track=video,
                        kind=MusicLink.Kind.MUSIC_VIDEO,
                        platform=entry.get("platform", ""),
                        name=entry.get("name") or "Music video",
                        url=entry["video_url"],
                        isrc=values["isrc_video"],
                    )
            track.videos.exclude(id__in=retained).delete()
        # Adds videos without touching the existing ones (`video_entries` is
        # the full list and drops whatever it leaves out). Used by the
        # assistant's "add a video" proposals.
        for entry in data.get("video_append") or []:
            if not isinstance(entry, dict) or not entry.get("video_url"):
                continue
            isrc_video = str(entry.get("isrc", "")).upper().replace("-", "")
            video = MusicTrack.objects.create(
                workspace=workspace,
                parent_track=track,
                title=entry.get("title") or track.title,
                kind=MusicTrack.Kind.MUSIC_VIDEO,
                status=entry.get("status", MusicTrack.Status.DRAFT),
                isrc_video=isrc_video,
                release_date=entry.get("release_date") or None,
            )
            MusicLink.objects.create(
                workspace=workspace,
                track=video,
                kind=MusicLink.Kind.MUSIC_VIDEO,
                platform=entry.get("platform", ""),
                name=entry.get("name") or "Music video",
                url=entry["video_url"],
                isrc=isrc_video,
            )


class MusicTrackBulkDeleteEndpoint(MusicBaseView):
    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def post(self, request, slug):
        track_ids = request.data.get("track_ids", [])
        if not isinstance(track_ids, list) or not track_ids:
            return Response({"error": "track_ids must contain at least one song"}, status=status.HTTP_400_BAD_REQUEST)

        with transaction.atomic():
            tracks = list(MusicTrack.objects.filter(workspace__slug=slug, id__in=track_ids))
            for track in tracks:
                track.delete()

        return Response({"deleted": len(tracks), "not_found": len(track_ids) - len(tracks)})


class MusicTrackDetailEndpoint(MusicBaseView):
    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def get(self, request, slug, track_id):
        track = MusicTrack.objects.prefetch_related(
            "credits__party", "genre_links__genre", "release_links__release", "links",
            "distributions__company", "videos__links",
        ).get(id=track_id, workspace__slug=slug)
        return Response(MusicTrackSerializer(track).data)

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def patch(self, request, slug, track_id):
        track = MusicTrack.objects.get(id=track_id, workspace__slug=slug)
        serializer = MusicTrackSerializer(track, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        _validate_credit_roles(track.workspace, request.data.get("credit_entries"))
        serializer.save()
        MusicTrackEndpoint._sync_relations(track, track.workspace, request.data)
        return Response(MusicTrackSerializer(track).data)

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def delete(self, request, slug, track_id):
        MusicTrack.objects.get(id=track_id, workspace__slug=slug).delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class _NamedEndpoint(MusicBaseView):
    model = None
    serializer = None

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def get(self, request, slug):
        return Response(self.serializer(self.model.objects.filter(workspace__slug=slug), many=True).data)

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def post(self, request, slug):
        serializer = self.serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        serializer.save(workspace=Workspace.objects.get(slug=slug))
        return Response(serializer.data, status=status.HTTP_201_CREATED)


class _NamedDetailEndpoint(MusicBaseView):
    model = None
    serializer = None
    lookup_kwarg = "resource_id"

    def _instance(self, slug, **kwargs):
        return self.model.objects.get(id=kwargs[self.lookup_kwarg], workspace__slug=slug)

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def patch(self, request, slug, **kwargs):
        instance = self._instance(slug, **kwargs)
        serializer = self.serializer(instance, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return Response(serializer.data)

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def delete(self, request, slug, **kwargs):
        instance = self._instance(slug, **kwargs)
        if isinstance(instance, MusicParty) and (instance.track_credits.exists() or instance.release_links.exists()):
            return Response(
                {"error": "This person or artist is used by tracks or releases. Disable it instead of deleting it."},
                status=status.HTTP_409_CONFLICT,
            )
        instance.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class MusicPartyEndpoint(_NamedEndpoint):
    model = MusicParty
    serializer = MusicPartySerializer


class MusicGenreEndpoint(_NamedEndpoint):
    model = MusicGenre
    serializer = MusicGenreSerializer


class MusicCompanyEndpoint(_NamedEndpoint):
    model = MusicCompany
    serializer = MusicCompanySerializer


class MusicPartyDetailEndpoint(_NamedDetailEndpoint):
    model = MusicParty
    serializer = MusicPartySerializer
    lookup_kwarg = "party_id"


class MusicGenreDetailEndpoint(_NamedDetailEndpoint):
    model = MusicGenre
    serializer = MusicGenreSerializer
    lookup_kwarg = "genre_id"


class MusicCompanyDetailEndpoint(_NamedDetailEndpoint):
    model = MusicCompany
    serializer = MusicCompanySerializer
    lookup_kwarg = "company_id"


class MusicCatalogOptionsEndpoint(MusicBaseView):
    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def get(self, request, slug):
        workspace = Workspace.objects.get(slug=slug)
        roles = workspace_role_catalog(workspace.id).options()
        return Response(
            {
                "release_types": MusicRelease.Type.choices,
                "release_statuses": MusicRelease.Status.choices,
                "track_kinds": MusicTrack.Kind.choices,
                "track_statuses": MusicTrack.Status.choices,
                # Built-in + the workspace's own roles, labels as stored (English)
                "credit_roles": [[role["key"], role["label"]] for role in roles],
                "credit_role_details": roles,
                "credit_role_categories": MusicCreditRole.Category.choices,
                "party_kinds": MusicParty.Kind.choices,
                "company_kinds": MusicCompany.Kind.choices,
                "import_fields": IMPORT_FIELDS,
                "multi_fields": MULTI_COLUMN_FIELDS,
                # One entry per FILE (several runs of the same upload collapse
                # into it). Deleting the source file afterwards keeps the entry:
                # its songs are still linked to the run.
                "import_files": self._import_files(slug),
            }
        )

    @staticmethod
    def _import_files(slug):
        files = {}
        runs = (
            MusicImportRun.objects.filter(workspace__slug=slug)
            .select_related("file_asset")
            .order_by("-created_at")[:500]
        )
        for run in runs:
            asset_id = str(run.file_asset_id) if run.file_asset_id else f"run:{run.id}"
            entry = files.get(asset_id)
            if entry is None:
                files[asset_id] = {
                    "asset_id": asset_id,
                    "name": run.source_name,
                    "source": run.source,
                    "runs": 1,
                    "last_imported_at": run.created_at.isoformat(),
                    "file_deleted": run.file_asset is None or bool(run.file_asset.is_deleted),
                }
            else:
                entry["runs"] += 1
        return list(files.values())[:100]


class MusicCreditRoleEndpoint(MusicBaseView):
    """The workspace's credit roles (built-in + its own) and creating one
    from the track panel ("Create role «Bajo Quinto»")."""

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def get(self, request, slug):
        workspace = Workspace.objects.get(slug=slug)
        return Response(workspace_role_catalog(workspace.id).options())

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def post(self, request, slug):
        workspace = Workspace.objects.get(slug=slug)
        label = " ".join(str(request.data.get("label") or "").split())[:120]
        if not label:
            return Response({"label": ["Name the role"]}, status=status.HTTP_400_BAD_REQUEST)
        catalog = workspace_role_catalog(workspace.id)
        # The same role under another spelling is reused, never duplicated
        existing = catalog.match(label) or (role_key(label) if catalog.exists(role_key(label)) else None)
        if existing:
            return Response({**catalog.roles[existing], "created": False}, status=status.HTTP_200_OK)
        category = request.data.get("category")
        if category not in CATEGORIES:
            category = guess_category(label)
        role = MusicCreditRole.objects.create(
            workspace=workspace, key=role_key(label), label=label, category=category, source_tags=[]
        )
        return Response(
            {"key": role.key, "label": role.label, "category": role.category, "builtin": False, "created": True},
            status=status.HTTP_201_CREATED,
        )


class MusicImportAssetEndpoint(MusicBaseView):
    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def get(self, request, slug):
        assets = FileAsset.objects.filter(
            workspace__slug=slug,
            entity_type=FileAsset.EntityTypeContext.MUSIC_CATALOG,
            attributes__music_asset_kind="IMPORT_SOURCE",
            is_uploaded=True,
            is_deleted=False,
        ).order_by("-created_at")
        search = request.query_params.get("search", "").strip()
        if search:
            assets = assets.filter(attributes__name__icontains=search)
        assets = list(assets[:500])

        # Every run per asset, newest first: the latest one's rules restore the
        # whole configuration on re-import; the list is the file's history —
        # who imported it, when, and what each run did.
        runs_by_asset = {}
        for run in (
            MusicImportRun.objects.filter(file_asset_id__in=[asset.id for asset in assets])
            .select_related("created_by")
            .order_by("-created_at")
        ):
            runs_by_asset.setdefault(run.file_asset_id, []).append(run)
        last_runs = {asset_id: runs[0] for asset_id, runs in runs_by_asset.items()}

        def run_history(asset):
            return [
                {
                    "id": str(run.id),
                    "imported_at": run.created_at.isoformat(),
                    "source": run.source,
                    "sheet": run.sheet or None,
                    "summary": run.summary or {},
                    "imported_by": (
                        run.created_by.display_name or run.created_by.email if run.created_by_id else None
                    ),
                }
                for run in runs_by_asset.get(asset.id, [])[:20]
            ]

        def last_run_payload(asset):
            run = last_runs.get(asset.id)
            if run is None:
                return None
            return {
                "sheet": run.sheet or None,
                "rules": run.rules or {},
                "summary": run.summary or {},
                "imported_at": run.created_at.isoformat(),
            }

        return Response(
            {
                "results": [
                    {
                        "id": str(asset.id),
                        "name": (asset.attributes or {}).get("name") or "Import file",
                        "content_type": (asset.attributes or {}).get("type") or "application/octet-stream",
                        "size": asset.size,
                        "upload_source": (asset.attributes or {}).get("upload_source") or "manual",
                        "created_at": asset.created_at.isoformat(),
                        "last_run": last_run_payload(asset),
                        "runs": run_history(asset),
                        "run_count": len(runs_by_asset.get(asset.id, [])),
                    }
                    for asset in assets
                ]
            }
        )

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def post(self, request, slug):
        if request.data.get("action") != "delete":
            return Response({"action": ["Unsupported action"]}, status=status.HTTP_400_BAD_REQUEST)
        asset_ids = request.data.get("asset_ids") or []
        if not isinstance(asset_ids, list) or not asset_ids:
            return Response({"asset_ids": ["Select at least one file"]}, status=status.HTTP_400_BAD_REQUEST)
        assets = FileAsset.objects.filter(
            id__in=asset_ids,
            workspace__slug=slug,
            entity_type=FileAsset.EntityTypeContext.MUSIC_CATALOG,
            attributes__music_asset_kind="IMPORT_SOURCE",
            is_deleted=False,
        )
        deleted = assets.count()
        assets.update(is_deleted=True, deleted_at=timezone.now())
        return Response({"deleted": deleted, "not_found": len(set(asset_ids)) - deleted})


def _date_interpretations(headers, rows):
    """How each date-looking column will be read, shown next to its samples:
    a "Fecha (año)" cell holding 1/7/1905 is an Excel year serial and imports
    as 2009 — without saying so the preview looks like corrupt data."""
    interpretations = {}
    for header in headers:
        year_only = any(token in _plain(header) for token in ("year", "ano"))
        for row in rows[:200]:
            raw = row.get(header)
            if raw in (None, "") or isinstance(raw, (int, float)) and not year_only:
                continue
            if not isinstance(raw, (date, datetime)) and not re.search(r"\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}", str(raw)):
                break
            parsed = _date(raw, year_only=year_only)
            if parsed is None:
                break
            raw_text = raw.isoformat() if isinstance(raw, (date, datetime)) else str(raw).strip()
            interpretations[header] = {"raw": raw_text, "parsed": parsed.isoformat(), "year_only": year_only}
            break
    return interpretations


def _previous_imports(workspace_slug, asset_id=None, name=None, size=None):
    """Earlier applied imports of this same file — by stored asset, or by
    name and size for a fresh upload of a file already imported once."""
    runs = MusicImportRun.objects.filter(workspace__slug=workspace_slug, file_asset__is_deleted=False)
    if asset_id:
        runs = runs.filter(file_asset_id=asset_id)
    elif name:
        runs = runs.filter(file_asset__attributes__name=name, file_asset__size=size)
    else:
        return []
    return [
        {
            "id": str(run.id),
            "asset_id": str(run.file_asset_id) if run.file_asset_id else None,
            "imported_at": run.created_at.isoformat(),
            "summary": run.summary or {},
        }
        for run in runs.order_by("-created_at")[:10]
    ]


class MusicImportPreviewEndpoint(MusicBaseView):
    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def post(self, request, slug):
        upload = request.FILES.get("file")
        asset_id = None
        if not upload and request.data.get("asset_id"):
            try:
                _, upload = _asset_upload(slug, request.data["asset_id"])
                asset_id = request.data["asset_id"]
            except FileAsset.DoesNotExist:
                return Response({"error": "Archivo guardado no encontrado"}, status=status.HTTP_404_NOT_FOUND)
        if not upload:
            return Response({"file": ["Choose a CSV or XLSX file"]}, status=status.HTTP_400_BAD_REQUEST)
        try:
            headers, rows, sheets, header_row = _read_table(upload, request.data.get("sheet"))
        except Exception as exc:
            return Response({"error": f"Could not read spreadsheet: {exc}"}, status=status.HTTP_400_BAD_REQUEST)
        sample = [
            {key: value.isoformat() if isinstance(value, (date, datetime)) else value for key, value in row.items()}
            for row in rows[:8]
        ]
        inferred = _infer_mapping(headers, IMPORT_FIELDS)
        artist_column = inferred.get("artists")
        database_ready = _music_schema_ready()
        # How much of this file the catalog already holds, judged by ISRC — the
        # cue to update existing songs instead of creating them again.
        isrc_column = inferred.get("track.isrc")
        isrcs = {
            str(row.get(isrc_column)).strip().upper().replace("-", "")
            for row in rows
            if isrc_column and row.get(isrc_column) not in (None, "")
        }
        existing_isrcs = (
            MusicTrack.objects.filter(
                workspace__slug=slug, parent_track__isnull=True, isrc__in=list(isrcs)
            ).count()
            if isrcs and database_ready
            else 0
        )
        upload_size = getattr(upload, "size", None)
        return Response(
            {
                "file_name": getattr(upload, "name", None),
                "previous_imports": _previous_imports(
                    slug, asset_id=asset_id, name=getattr(upload, "name", None), size=upload_size
                ),
                "isrc_count": len(isrcs),
                "existing_isrc_count": existing_isrcs,
                "date_interpretations": _date_interpretations(headers, rows),
                "headers": headers,
                "rows": sample,
                "sheets": sheets,
                "selected_sheet": request.data.get("sheet") or (sheets[0] if sheets else None),
                "header_row": header_row,
                "total_rows": len(rows),
                "mapping": inferred,
                "column_samples": _column_samples(headers, rows),
                "multi_fields": MULTI_COLUMN_FIELDS,
                # Tags found per column ("Ana <Tuba>") with their default role,
                # for the role map of contributors/performers columns
                "column_role_tags": (
                    _column_role_tags(
                        headers,
                        rows,
                        workspace_role_catalog(Workspace.objects.get(slug=slug).id),
                        performer_columns=_columns_for(inferred, "performers"),
                    )
                    if database_ready
                    else {}
                ),
                "format_examples": FIELD_FORMAT_EXAMPLES,
                "field_limits": FIELD_LENGTH_LIMITS,
                "artist_examples": [
                    {"source": str(row.get(artist_column, "")), "detected": _split(row.get(artist_column, ""))}
                    for row in rows[:5]
                    if artist_column and row.get(artist_column)
                ],
                "database_ready": database_ready,
                "database_error": None if database_ready else "Apply migration db.0136_musictrack_parent_track before importing.",
            }
        )


class MusicImportAIMapEndpoint(MusicBaseView):
    """Optional AI mapping for the manual import panel: column samples from
    the whole file go to the Worker's model, which returns canonical_field →
    column(s). Deterministic validation happens here; the AI only suggests."""

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def post(self, request, slug):
        from plane.utils.worker_client import WorkerTriggerError, ai_map_music_columns

        upload = request.FILES.get("file")
        if not upload and request.data.get("asset_id"):
            try:
                _, upload = _asset_upload(slug, request.data["asset_id"])
            except FileAsset.DoesNotExist:
                return Response({"error": "Archivo guardado no encontrado"}, status=status.HTTP_404_NOT_FOUND)
        if not upload:
            return Response({"file": ["Choose a CSV or XLSX file"]}, status=status.HTTP_400_BAD_REQUEST)
        try:
            headers, rows, _sheets, _header_row = _read_table(upload, request.data.get("sheet"))
        except Exception as exc:
            return Response({"error": f"Could not read spreadsheet: {exc}"}, status=status.HTTP_400_BAD_REQUEST)
        # What the user has now: the AI fills gaps and leaves hand-picked
        # fields alone (multipart form fields arrive as JSON text).
        def _json_field(name, default):
            value = request.data.get(name)
            if isinstance(value, str):
                try:
                    return json.loads(value or "null") or default
                except json.JSONDecodeError:
                    return default
            return value if value is not None else default

        current_mapping = _clean_mapping(_json_field("current_mapping", {}), headers)
        locked = [field for field in _json_field("locked_fields", []) if field in IMPORT_FIELDS]
        constants = _clean_constants(_json_field("constants", {}))
        locale = str(request.data.get("locale") or "es")[:10]
        try:
            data = ai_map_music_columns(
                _column_samples(headers, rows),
                IMPORT_FIELDS,
                MULTI_COLUMN_FIELDS,
                current_mapping=current_mapping,
                locked_fields=locked,
                constants=constants,
                field_descriptions=FIELD_DESCRIPTIONS,
                locale=locale,
            )
        except WorkerTriggerError as exc:
            log_exception(exc)
            return Response({"error": exc.public_message}, status=status.HTTP_502_BAD_GATEWAY)

        # Only real fields mapped to real columns survive; `mapping` keeps
        # its old shape for older clients.
        suggestions = _clean_ai_suggestions(data, headers, set(locked))
        mapping = {
            field: (
                entry["columns"] if field in MULTI_COLUMN_FIELDS and len(entry["columns"]) > 1 else entry["columns"][0]
            )
            for field, entry in suggestions.items()
        }
        return Response(
            {"mapping": mapping, "suggestions": suggestions, "model": data.get("model")}, status=status.HTTP_200_OK
        )


FIELD_VALUE_LIMIT = 20
# Candidates compared for "looks like the same thing" (most used first)
SIMILAR_CANDIDATE_LIMIT = 3000
# Plain text fields where suggesting existing values makes no sense
NO_SUGGESTION_FIELDS = ("track.lyrics", "track.video_url", "track.streaming_url", "track.isrc", "track.isrc_video")


def _field_value_source(slug, field):
    """(kind, queryset of {"value", "count"} rows) for an import field's
    existing values — or (kind, None) when there is nothing to suggest."""
    if field in COMPANY_FIELD_KINDS:
        return "company", (
            MusicCompany.objects.filter(workspace__slug=slug, kind=COMPANY_FIELD_KINDS[field])
            .annotate(count=Count("distributions", filter=Q(distributions__deleted_at__isnull=True), distinct=True))
            .values("count", value=models.F("name"))
        )
    if field in PARTY_FIELDS:
        return "party", (
            MusicParty.objects.filter(workspace__slug=slug, disabled=False)
            .annotate(count=Count("track_credits", filter=Q(track_credits__deleted_at__isnull=True), distinct=True))
            .values("count", value=models.F("display_name"))
        )
    if field == "genres":
        return "genre", (
            MusicGenre.objects.filter(workspace__slug=slug)
            .annotate(count=Count("track_links", filter=Q(track_links__deleted_at__isnull=True), distinct=True))
            .values("count", value=models.F("name"))
        )
    if field == "release.title":
        return "release", (
            MusicRelease.objects.filter(workspace__slug=slug)
            .values(value=models.F("title"))
            .annotate(count=Count("id"))
        )
    prefix, _, attr = field.partition(".")
    model = {"track": MusicTrack, "release": MusicRelease}.get(prefix)
    if model is None or not attr or field in NO_SUGGESTION_FIELDS:
        return "text", None
    try:
        model_field = model._meta.get_field(attr)
    except Exception:
        return "text", None
    kind = (
        "date" if isinstance(model_field, models.DateField)
        else "number" if isinstance(model_field, (models.DecimalField, models.IntegerField))
        else "text"
    )
    if field == "track.duration_ms":
        return "number", None
    queryset = model.objects.filter(workspace__slug=slug).exclude(**{f"{attr}__isnull": True})
    if model is MusicTrack:
        queryset = queryset.filter(parent_track__isnull=True)
    if kind == "text":
        queryset = queryset.exclude(**{attr: ""})
    return kind, queryset.values(value=models.F(attr)).annotate(count=Count("id"))


class MusicImportFieldValuesEndpoint(MusicBaseView):
    """Existing values of an import field, for its "fixed value": companies of
    the field's kind, people, genres, releases, distinct values of text
    fields, or the choices of a choice field — each with how often it is used.
    `similar` lists existing values that look like the typed one ("Virgin" vs
    "VirginAgregadora") so the user can reuse it instead of creating a twin."""

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def get(self, request, slug):
        field = request.query_params.get("field", "")
        query = request.query_params.get("q", "").strip()
        if field not in IMPORT_FIELDS:
            return Response({"field": ["Unknown import field"]}, status=status.HTTP_400_BAD_REQUEST)
        if field in CHOICE_FIELDS or field == "track.explicit":
            choices = CHOICE_FIELDS.get(field) or [("true", "Yes"), ("false", "No")]
            return Response(
                {
                    "field": field,
                    "kind": "choice",
                    "choices": [[value, label] for value, label in choices],
                    "values": [],
                    "exact": None,
                    "similar": [],
                }
            )
        kind, source = _field_value_source(slug, field)
        if source is None:
            return Response({"field": field, "kind": kind, "values": [], "exact": None, "similar": []})

        def serialize(entry):
            value = entry["value"]
            return {
                "value": value.isoformat() if isinstance(value, (date, datetime)) else str(value),
                "count": entry["count"],
            }

        listed = source.filter(value__icontains=query) if query else source
        values = [serialize(entry) for entry in listed.order_by("-count", "value")[:FIELD_VALUE_LIMIT]]

        exact, similar = None, []
        if query and kind in ("company", "party", "genre", "release", "text"):
            candidates = [serialize(entry) for entry in source.order_by("-count", "value")[:SIMILAR_CANDIDATE_LIMIT]]
            exact = next((entry for entry in candidates if entry["value"].strip().lower() == query.lower()), None)
            similar = [
                {**entry, "score": round(score, 2)}
                for score, _name, entry in similar_names(query, [(entry["value"], entry) for entry in candidates])
            ]
        return Response({"field": field, "kind": kind, "values": values, "exact": exact, "similar": similar})


def _sse(event, payload):
    """One server-sent event. The import streams as text/event-stream so the
    gzip middleware leaves it alone and every progress tick reaches the browser
    as it happens (see StreamingSafeGZipMiddleware)."""
    return f"event: {event}\ndata: {json.dumps(payload, default=str)}\n\n"


def _store_import_source(workspace, upload):
    """The FileAsset an applied import is recorded against. Re-importing the
    SAME file (same name and size) reuses its asset so the file shows up once,
    with every run under it."""
    upload.seek(0)
    content = upload.read()
    file_asset = FileAsset.objects.filter(
        workspace=workspace,
        entity_type=FileAsset.EntityTypeContext.MUSIC_CATALOG,
        attributes__music_asset_kind="IMPORT_SOURCE",
        attributes__name=upload.name,
        size=len(content),
        is_deleted=False,
    ).first()
    if file_asset is not None:
        return file_asset
    from plane.settings.storage import S3Storage

    asset_key = f"{workspace.id}/music-imports/{timezone.now().strftime('%Y%m%d%H%M%S')}-{upload.name}"
    storage = S3Storage()
    storage.s3_client.put_object(Bucket=storage.aws_storage_bucket_name, Key=asset_key, Body=content)
    return FileAsset.objects.create(
        workspace=workspace,
        entity_type=FileAsset.EntityTypeContext.MUSIC_CATALOG,
        attributes={
            "name": upload.name,
            "type": getattr(upload, "content_type", "") or "text/csv",
            "size": len(content),
            "music_asset_kind": "IMPORT_SOURCE",
            "upload_source": "manual",
        },
        asset=asset_key,
        size=len(content),
        is_uploaded=True,
    )


SUMMARY_KEYS = ("total", "created", "updated", "unchanged", "skipped", "omitted", "empty")


class MusicImportEndpoint(MusicBaseView):
    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def post(self, request, slug):
        from .importer import AMBIGUOUS_STRATEGIES, BLANK_CELL_MODES, run_import

        upload = request.FILES.get("file")
        source_asset = None
        if not upload and request.data.get("asset_id"):
            # Re-import of a stored file: the browser never re-uploads it
            try:
                source_asset, upload = _asset_upload(slug, request.data["asset_id"])
            except FileAsset.DoesNotExist:
                return Response({"error": "Archivo guardado no encontrado"}, status=status.HTTP_404_NOT_FOUND)
        if not upload:
            return Response({"file": ["A CSV or XLSX file is required"]}, status=status.HTTP_400_BAD_REQUEST)
        try:
            mapping = json.loads(request.data.get("mapping", "{}"))
            defaults = json.loads(request.data.get("defaults", "{}"))
            _, rows, _, header_row = _read_table(upload, request.data.get("sheet"))
        except (json.JSONDecodeError, csv.Error, ValueError) as exc:
            return Response({"error": f"Invalid spreadsheet: {exc}"}, status=status.HTTP_400_BAD_REQUEST)
        try:
            # Fixed values per field and the user's tag -> role decisions;
            # absent in older payloads (they behave as before).
            constants = _clean_constants(json.loads(request.data.get("constants") or "{}"))
            role_map = _clean_role_map(json.loads(request.data.get("role_map") or "{}"))
        except json.JSONDecodeError:
            return Response({"constants": ["Must be valid JSON"]}, status=status.HTTP_400_BAD_REQUEST)
        if not mapping.get("track.title") and not constants.get("track.title"):
            return Response({"mapping": ["track.title must be mapped"]}, status=status.HTTP_400_BAD_REQUEST)

        workspace = Workspace.objects.get(slug=slug)
        strategy = request.data.get("duplicate_strategy", "skip")
        dedupe_by = request.data.get("dedupe_by", "auto")
        relations_mode = request.data.get("relations_mode", "merge")
        if relations_mode not in ("merge", "replace"):
            return Response({"relations_mode": ["Use merge or replace"]}, status=status.HTTP_400_BAD_REQUEST)
        # What to do with a row whose title matches a song but nothing else
        # confirms it is the same recording: create it apart (default), treat
        # it as that song, or leave it out.
        ambiguous_strategy = request.data.get("ambiguous_strategy", "create")
        if ambiguous_strategy not in AMBIGUOUS_STRATEGIES:
            return Response({"ambiguous_strategy": ["Use create, match or skip"]}, status=status.HTTP_400_BAD_REQUEST)
        blank_cells = request.data.get("blank_cells", "keep")
        if blank_cells not in BLANK_CELL_MODES:
            return Response({"blank_cells": ["Use keep or clear"]}, status=status.HTTP_400_BAD_REQUEST)
        # Off by default: a file row only matches PRE-EXISTING records, so rows
        # that share an identifier within the file don't collapse into one.
        dedupe_within_file = str(request.data.get("dedupe_within_file", "false")).lower() == "true"
        dry_run = str(request.data.get("dry_run", "false")).lower() == "true"
        stream = str(request.data.get("stream", "false")).lower() == "true"
        # Off unless the user asks: columns no field took are kept per song
        # as extra data (track.metadata["extra"]).
        keep_unmapped = str(request.data.get("keep_unmapped", "false")).lower() == "true"
        invalid_row_strategy = request.data.get("invalid_row_strategy", "abort")
        try:
            row_overrides = json.loads(request.data.get("row_overrides", "{}"))
            value_overrides = json.loads(request.data.get("value_overrides", "{}"))
        except json.JSONDecodeError:
            return Response({"row_overrides": ["Must be valid JSON"]}, status=status.HTTP_400_BAD_REQUEST)
        if invalid_row_strategy not in ("abort", "skip"):
            return Response(
                {"invalid_row_strategy": ["Use abort or skip"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        sheet = request.data.get("sheet")
        user = request.user

        def execute():
            """Runs the import, yielding (event, payload). Validation and an
            aborted import roll everything back; a successful apply commits
            and records which file each track came from.

            A streamed response is iterated after the view has returned, when
            the per-request current user (crum) is already cleared — every
            record would lose its author. `impersonate` restores it for the run.
            """
            with impersonate(user if getattr(user, "is_authenticated", False) else None), transaction.atomic():
                result, touched = None, []
                for event in run_import(
                    self,
                    workspace,
                    rows,
                    header_row,
                    mapping,
                    strategy=strategy,
                    dedupe_by=dedupe_by,
                    relations_mode=relations_mode,
                    dedupe_within_file=dedupe_within_file,
                    defaults=defaults,
                    row_overrides=row_overrides,
                    value_overrides=value_overrides,
                    ambiguous_strategy=ambiguous_strategy,
                    blank_cells=blank_cells,
                    dry_run=dry_run,
                    constants=constants,
                    role_map=role_map,
                    keep_unmapped=keep_unmapped,
                ):
                    if event[0] == "result":
                        _, result, touched = event
                    else:
                        yield event
                result["invalid_row_strategy"] = invalid_row_strategy
                aborted = bool(result["errors"]) and invalid_row_strategy == "abort"
                result["aborted"] = aborted
                if not dry_run and not aborted:
                    run = _record_import_run(
                        workspace,
                        file_asset=source_asset or _store_import_source(workspace, upload),
                        source_name=upload.name,
                        source="MANUAL",
                        sheet=sheet,
                        # The FULL configuration, so a re-import can restore it
                        # and the user only touches what changed.
                        rules={
                            "mapping": mapping,
                            "duplicate_strategy": strategy,
                            "dedupe_by": dedupe_by,
                            "relations_mode": relations_mode,
                            "dedupe_within_file": dedupe_within_file,
                            "ambiguous_strategy": ambiguous_strategy,
                            "blank_cells": blank_cells,
                            "value_overrides": value_overrides,
                            "row_overrides": row_overrides,
                            "invalid_row_strategy": invalid_row_strategy,
                            "defaults": defaults,
                            "constants": constants,
                            "role_map": role_map,
                            "keep_unmapped": keep_unmapped,
                        },
                        summary={key: result.get(key, 0) for key in SUMMARY_KEYS},
                        touched=touched,
                    )
                    result["import_run_id"] = str(run.id)
                if dry_run or aborted:
                    transaction.set_rollback(True)
            yield "result", result

        if not stream:
            result = None
            for event, payload in execute():
                if event == "result":
                    result = payload
            return Response(
                result, status=status.HTTP_200_OK if not result["errors"] else status.HTTP_207_MULTI_STATUS
            )

        def events():
            try:
                for event, payload in execute():
                    yield _sse(event, payload)
            except Exception as exc:
                log_exception(exc)
                yield _sse("error", {"error": _import_error_message(exc)})

        response = StreamingHttpResponse(events(), content_type="text/event-stream")
        # Progress must not be buffered by intermediaries (nginx) or caches
        response["Cache-Control"] = "no-cache"
        response["X-Accel-Buffering"] = "no"
        return response

    @staticmethod
    def _find_existing(workspace, row, mapping, title, isrc, dedupe_by, exclude_ids=None):
        """The existing song this row refers to, and how sure that is.

        Returns (track, match). `match` is None when nothing matched, otherwise
        {"by": <identifier>, "track_id", "title", "isrc"}; by == "ambiguous"
        means a same-titled song exists but nothing else confirms it is the
        same recording — the caller decides through `ambiguous_strategy`
        instead of silently treating it as a duplicate.

        Dedupe runs against SONGS only: music-video children share the parent's
        title, so an unfiltered title match could wrongly hit the video.
        `exclude_ids` holds records CREATED earlier in this same import: when
        de-duplication within the file is off, two file rows sharing an
        identifier must not collapse into the first row's new track.
        """
        # Oldest first: with several songs sharing an identifier, rows claim
        # them in a stable order run after run. Claimed songs are skipped in
        # Python, not with NOT IN: the identifier narrows each lookup to a
        # handful of rows, while the claimed set grows to the whole file.
        songs = MusicTrack.objects.filter(workspace=workspace, parent_track__isnull=True).order_by("created_at")
        excluded = exclude_ids or ()

        def first(queryset):
            return next((track for track in queryset.iterator() if track.id not in excluded), None)

        def found(track, by):
            if track is None:
                return None, None
            return track, {"by": by, "track_id": str(track.id), "title": track.title, "isrc": track.isrc}

        if dedupe_by == "none":
            return None, None
        if dedupe_by == "isrc":
            return found(first(songs.filter(isrc__iexact=isrc)) if isrc else None, "isrc")
        if dedupe_by == "title":
            # Explicitly chosen by the user: the title alone defines a duplicate.
            return found(first(songs.filter(title__iexact=title)), "title")
        if dedupe_by == "catalog":
            catalog = _mapped(row, mapping, "track.catalog")
            return found(first(songs.filter(catalog__iexact=catalog)) if catalog else None, "catalog")
        if dedupe_by == "upc":
            upc = _mapped(row, mapping, "track.upc")
            return found(first(songs.filter(upc__iexact=upc)) if upc else None, "upc")
        if dedupe_by == "external_id":
            external = _mapped(row, mapping, "track.external_id")
            return found(
                first(songs.filter(metadata__external_ids__track_id=external)) if external else None, "external_id"
            )

        # auto. An ISRC identifies one recording: when the row carries one it
        # is the only thing allowed to match — a same-titled song with another
        # ISRC is a different recording (covers, re-recordings, the countless
        # "Feliz Navidad"), never a duplicate.
        if isrc:
            return found(first(songs.filter(isrc__iexact=isrc)), "isrc")
        same_title = songs.filter(title__iexact=title)
        original = _mapped_date(row, mapping, "track.original_release_date")
        artists = [name for value in _mapped_many(row, mapping, "artists") for name in _split(value)]
        if artists:
            artist_filter = Q()
            for name in artists:
                artist_filter |= Q(display_name__iexact=name)
            confirmed = same_title.filter(
                credits__role=MusicCredit.Role.PRIMARY_ARTIST,
                credits__party__in=MusicParty.objects.filter(workspace=workspace).filter(artist_filter),
            )
            if original:
                confirmed = confirmed.filter(original_release_date=original)
            track = first(confirmed.distinct())
            if track:
                return found(track, "title_artist")
        elif original:
            track = first(same_title.filter(original_release_date=original))
            if track:
                return found(track, "title_date")
        candidate = first(same_title)
        if candidate is None:
            return None, None
        return None, {
            "by": "ambiguous",
            "track_id": str(candidate.id),
            "title": candidate.title,
            "isrc": candidate.isrc,
        }

    @staticmethod
    def _track_state(track, mapping):
        """Everything an import can change on a track: its mapped scalar
        fields and how many relations hang off it. Compared before and after
        an update to tell a real change from a no-op."""
        fields = tuple(
            getattr(track, key.split(".", 1)[1], None) for key in sorted(mapping) if key.startswith("track.")
        )
        counts = MusicTrack.objects.filter(id=track.id).aggregate(
            credits=Count("credits", filter=Q(credits__deleted_at__isnull=True), distinct=True),
            genres=Count("genre_links", filter=Q(genre_links__deleted_at__isnull=True), distinct=True),
            distributions=Count("distributions", filter=Q(distributions__deleted_at__isnull=True), distinct=True),
            releases=Count("release_links", filter=Q(release_links__deleted_at__isnull=True), distinct=True),
            links=Count("links", filter=Q(links__deleted_at__isnull=True), distinct=True),
        )
        # Extra data / external ids and the song's position in its releases
        metadata = json.dumps(track.metadata or {}, sort_keys=True, default=str)
        positions = tuple(
            sorted(
                (str(release_id), disc, number)
                for release_id, disc, number in track.release_links.values_list(
                    "release_id", "disc_number", "track_number"
                )
            )
        )
        return fields, tuple(sorted(counts.items())), metadata, positions

    def _role_catalog(self, workspace):
        """The workspace's roles, read once per importer (a request or run)."""
        cache = self.__dict__.setdefault("_role_catalogs", {})
        if workspace.id not in cache:
            cache[workspace.id] = workspace_role_catalog(workspace.id)
        return cache[workspace.id]

    def _import_row(
        self, workspace, row, mapping, strategy, defaults=None, dedupe_by="auto", relations_mode="merge",
        exclude_ids=None, ambiguous_strategy="create", blank_cells="keep", role_map=None, role_catalog=None,
        unmapped_columns=None,
    ):
        """Imports one spreadsheet row. Returns (outcome, track, match):
        outcome is created | updated | unchanged | skipped, and `match`
        describes the existing song the row was matched to (_find_existing).

        `role_catalog` holds the workspace's credit roles plus the ones this
        file creates; `unmapped_columns` (keep_unmapped) are the file columns
        no field took, saved per song in metadata["extra"]."""
        catalog = role_catalog or self._role_catalog(workspace)
        title = _mapped(row, mapping, "track.title")
        if not title:
            raise ValueError("Track title is empty")
        _check_lengths(row, mapping)
        isrc = _mapped(row, mapping, "track.isrc").upper().replace("-", "")
        track, match = self._find_existing(workspace, row, mapping, title, isrc, dedupe_by, exclude_ids)
        if match and match["by"] == "ambiguous":
            # A same-titled song that nothing else confirms: the user decides.
            if ambiguous_strategy == "skip":
                return "skipped", None, match
            if ambiguous_strategy == "match":
                track = MusicTrack.objects.get(id=match["track_id"])
        if track and strategy == "skip":
            return "skipped", track, match
        if track and strategy == "error":
            raise ValueError(f"Duplicate track: {isrc or title}")
        before = self._track_state(track, mapping) if track else None

        values = {
            "title": title,
            "version": _mapped(row, mapping, "track.version"),
            "isrc": isrc,
            "isrc_video": _mapped(row, mapping, "track.isrc_video").upper().replace("-", ""),
            "catalog": _mapped(row, mapping, "track.catalog"),
            "upc": _mapped(row, mapping, "track.upc"),
            "kind": _choice(_mapped(row, mapping, "track.kind"), MusicTrack.Kind.choices, MusicTrack.Kind.AUDIO),
            "status": _choice(_mapped(row, mapping, "track.status"), MusicTrack.Status.choices, MusicTrack.Status.DRAFT),
            "release_date": _mapped_date(row, mapping, "track.release_date"),
            "original_release_date": _mapped_date(row, mapping, "track.original_release_date"),
            "duration_ms": _duration_ms(_mapped(row, mapping, "track.duration_ms")),
            "tiktok_preview_start_ms": _duration_ms(_mapped(row, mapping, "track.tiktok_preview_start_ms")),
            "country_of_recording": _mapped(row, mapping, "track.country_of_recording"),
            "language": _mapped(row, mapping, "track.language"),
            "explicit": _bool(_mapped(row, mapping, "track.explicit")),
            "ownership": _mapped(row, mapping, "track.ownership"),
            "us_publishing_obligations": _mapped(row, mapping, "track.us_publishing_obligations"),
            "recoupment": _mapped(row, mapping, "track.recoupment"),
            "digital_format": _mapped(row, mapping, "track.digital_format"),
            "p_line": _mapped(row, mapping, "track.p_line"),
            "c_line": _mapped(row, mapping, "track.c_line"),
            "lyrics": _mapped(row, mapping, "track.lyrics"),
            "aggregator_percentage": _decimal(_mapped(row, mapping, "track.aggregator_percentage")),
            "distributor_percentage": _decimal(_mapped(row, mapping, "track.distributor_percentage")),
            "record_label_percentage": _decimal(_mapped(row, mapping, "track.record_label_percentage")),
            "artist_percentage": _decimal(_mapped(row, mapping, "track.artist_percentage")),
            "writer_percentage": _decimal(_mapped(row, mapping, "track.writer_percentage")),
        }
        # A value that names no valid choice was listed for a decision; until
        # then an existing song keeps what it has (a new one takes the default).
        undecided = {
            field.split(".")[1]
            for field in ("track.kind", "track.status")
            if _mapped(row, mapping, field)
            and _choice_value(_mapped(row, mapping, field), CHOICE_FIELDS[field]) is None
        }
        if track:
            changed = False
            for key, value in values.items():
                if f"track.{key}" not in mapping or key in undecided:
                    continue
                # An empty cell only erases what the song has when the user
                # chose so; by default it leaves the current value alone.
                if blank_cells == "keep" and not _mapped(row, mapping, f"track.{key}"):
                    continue
                if getattr(track, key) != value:
                    setattr(track, key, value)
                    changed = True
            if changed:
                track.save()
            outcome = "updated"
        else:
            track = MusicTrack.objects.create(workspace=workspace, **values)
            outcome = "created"
        self._import_metadata(track, row, mapping, unmapped_columns)

        release = self._import_release(workspace, track, row, mapping)
        # The release this row landed in, for run_import's release-type
        # inference (it only reads it after a successful row).
        self._last_import_release = release
        # The release's own artist list ("Product Display Artist") when the
        # file has one; otherwise the song's primary artists also credit it.
        release_artists = _names_in(row, mapping, "release.artists", _split) if release else []
        for name in release_artists:
            _restore_or_create(
                MusicReleaseArtist,
                workspace,
                {
                    "release": release,
                    "party": _party(workspace, name, MusicParty.Kind.ARTIST),
                    "role": MusicReleaseArtist.Role.PRIMARY,
                },
            )

        role_fields = {
            "artists": (MusicParty.Kind.ARTIST, MusicCredit.Role.PRIMARY_ARTIST),
            "featured_artists": (MusicParty.Kind.ARTIST, MusicCredit.Role.FEATURED_ARTIST),
            "writers": (MusicParty.Kind.PERSON, MusicCredit.Role.WRITER),
            "authors": (MusicParty.Kind.PERSON, MusicCredit.Role.AUTHOR),
            "composers": (MusicParty.Kind.PERSON, MusicCredit.Role.COMPOSER),
            "producers": (MusicParty.Kind.PERSON, MusicCredit.Role.PRODUCER),
            "recording_engineers": (MusicParty.Kind.PERSON, MusicCredit.Role.RECORDING_ENGINEER),
            "mixers": (MusicParty.Kind.PERSON, MusicCredit.Role.MIXER),
            "mastering_engineers": (MusicParty.Kind.PERSON, MusicCredit.Role.MASTERING_ENGINEER),
            "legal_representatives": (MusicParty.Kind.PERSON, MusicCredit.Role.LEGAL_REPRESENTATIVE),
        }
        # People/genre/company fields accept SEVERAL mapped columns (e.g. two
        # writer columns); every column's value is split and imported.
        # relations_mode decides what happens with relations the track already
        # has: "merge" only ADDS what the file brings (nothing is removed);
        # "replace" makes mapped fields authoritative — relations no longer
        # coming from any mapped column are removed. Empty cells and unmapped
        # fields never touch existing relations in either mode.
        replace_relations = relations_mode == "replace"
        # Every credit the row brings, collected first: the same person and
        # role may come from several fields (a "Mixing" column and a generic
        # contributors column) — one credit each, with any details merged.
        wanted = {}

        def want(party, role, detail=""):
            entry = wanted.setdefault((party.id, role), (party, []))
            if detail:
                entry[1].append(detail)

        for field, (kind, role) in role_fields.items():
            for name, tags in _named_tags_in(row, mapping, field).items():
                # A tag that names another role ("<Lyricist>" in a writers
                # column) is kept as the credit's detail, so an export
                # writes the credit back the way the file had it.
                details = [tag for tag in tags if catalog.match(tag) != role]
                want(_party(workspace, name, kind), role, ", ".join(details))
        # Tagged names: each tag is its own role (existing or created from
        # the tag) unless the role map sends it elsewhere.
        for field in TAGGED_CREDIT_FIELDS:
            for name, tag in _tagged_in(row, mapping, field):
                role, detail = catalog.resolve(tag, field, role_map)
                if role == SKIP_ROLE or not catalog.is_known(role):
                    continue
                kind = MusicParty.Kind.ARTIST if catalog.category(role) == ARTIST_CATEGORY else MusicParty.Kind.PERSON
                want(_party(workspace, name, kind), role, detail)
        produced_credits = {}
        for (party_id, role), (party, details) in wanted.items():
            _save_credit(workspace, track, party, role, merge_details(*details), replace=replace_relations)
            produced_credits.setdefault(role, set()).add(party_id)
            if release and role == MusicCredit.Role.PRIMARY_ARTIST and not release_artists:
                _restore_or_create(
                    MusicReleaseArtist,
                    workspace,
                    {"release": release, "party": party, "role": MusicReleaseArtist.Role.PRIMARY},
                )
        if replace_relations:
            for role, party_ids in produced_credits.items():
                _prune(track.credits.filter(role=role).exclude(party_id__in=party_ids))
        produced_genres = set()
        for name in _names_in(row, mapping, "genres", _split):
            genre = _genre(workspace, name[:120])
            produced_genres.add(genre.id)
            _restore_or_create(MusicTrackGenre, workspace, {"track": track, "genre": genre})
        if replace_relations and produced_genres:
            _prune(track.genre_links.exclude(genre_id__in=produced_genres))
        for field, kind in COMPANY_FIELD_KINDS.items():
            produced_companies = set()
            for name, tag in _tagged_in(row, mapping, field):
                name = name[:255]
                company = MusicCompany.objects.filter(workspace=workspace, kind=kind, name__iexact=name).first()
                if company is None:
                    # Publishers come tagged with their collection society
                    # ("Top Music <ASCAP>"); kept as a note on a new publisher.
                    society = tag if tag and normalize_tag(tag) not in ("tbd", "na", "none", "unknown") else ""
                    company = MusicCompany.objects.create(
                        workspace=workspace,
                        kind=kind,
                        name=name,
                        notes=f"PRO: {society}" if society and kind == MusicCompany.Kind.PUBLISHER else "",
                    )
                produced_companies.add(company.id)
                MusicDistribution.objects.get_or_create(workspace=workspace, track=track, company=company)
            if replace_relations and produced_companies:
                _prune(track.distributions.filter(company__kind=kind).exclude(company_id__in=produced_companies))
        self._import_links(workspace, track, row, mapping, values, replace_relations)
        self._apply_defaults(workspace, track, release, defaults or {}, catalog)
        if before is not None:
            track.refresh_from_db()
            if self._track_state(track, mapping) == before:
                outcome = "unchanged"
        return outcome, track, match

    @staticmethod
    def _import_metadata(track, row, mapping, unmapped_columns=None):
        """The distributor's id for the song and, when asked, every unmapped
        column with a value, kept in track.metadata (merged, never cleared)."""
        external_id = _mapped(row, mapping, "track.external_id")[:255]
        extra = {}
        for column in unmapped_columns or ():
            raw = row.get(column)
            text = str(_jsonable_import_value(raw)).strip() if raw is not None else ""
            if text:
                # "Extra: Price Tier" from a catalog export is "Price Tier" again
                key = re.sub(r"^Extra:\s*", "", str(column)) or str(column)
                extra[key[:255]] = text[:2000]
        if not external_id and not extra:
            return
        metadata = dict(track.metadata or {})
        if external_id:
            metadata["external_ids"] = {**(metadata.get("external_ids") or {}), "track_id": external_id}
        if extra:
            metadata["extra"] = {**(metadata.get("extra") or {}), **extra}
        if metadata != (track.metadata or {}):
            track.metadata = metadata
            track.save()

    @staticmethod
    def _import_release(workspace, track, row, mapping):
        """The release the row names (found by the distributor's id, UPC, or
        title and date; created otherwise) linked to the song, with the song's
        disc and track number. A found release only gets blanks filled."""
        release_title = _mapped(row, mapping, "release.title")
        if not release_title:
            return None
        upc = _mapped(row, mapping, "release.upc")
        external_id = _mapped(row, mapping, "release.external_id")[:255]
        release_date = _mapped_date(row, mapping, "release.release_date")
        release = (
            MusicRelease.objects.filter(workspace=workspace, metadata__external_ids__product_id=external_id).first()
            if external_id
            else None
        )
        if not release and upc:
            release = MusicRelease.objects.filter(workspace=workspace, upc__iexact=upc).first()
        release = release or MusicRelease.objects.filter(
            workspace=workspace, title__iexact=release_title, release_date=release_date
        ).first()
        status_value = _choice_value(_mapped(row, mapping, "release.status"), MusicRelease.Status.choices)
        type_value = release_type_value(_mapped(row, mapping, "release.type"))
        version = _mapped(row, mapping, "release.version")
        language = _mapped(row, mapping, "release.language")
        if not release:
            release = MusicRelease.objects.create(
                workspace=workspace,
                title=release_title,
                version=version,
                release_type=type_value or MusicRelease.Type.ALBUM,
                status=status_value or MusicRelease.Status.DRAFT,
                upc=upc,
                catalog_number=_mapped(row, mapping, "release.catalog_number"),
                release_date=release_date,
                language=language,
                p_line=_mapped(row, mapping, "release.p_line"),
                c_line=_mapped(row, mapping, "release.c_line"),
                metadata={"external_ids": {"product_id": external_id}} if external_id else {},
            )
        else:
            changed = False
            for attr, value in (("version", version), ("language", language)):
                if value and not getattr(release, attr):
                    setattr(release, attr, value)
                    changed = True
            if status_value and release.status == MusicRelease.Status.DRAFT and status_value != release.status:
                release.status = status_value
                changed = True
            # Like the status: the file's type replaces the default (Album),
            # never a type someone already chose.
            if type_value and release.release_type == MusicRelease.Type.ALBUM and type_value != release.release_type:
                release.release_type = type_value
                changed = True
            stored_ids = (release.metadata or {}).get("external_ids") or {}
            if external_id and not stored_ids.get("product_id"):
                release.metadata = {
                    **(release.metadata or {}),
                    "external_ids": {**stored_ids, "product_id": external_id},
                }
                changed = True
            if changed:
                release.save()
        position = {}
        track_number = _position(_mapped(row, mapping, "release.track_number"))
        disc_number = _position(_mapped(row, mapping, "release.disc_number"))
        if track_number:
            position["track_number"] = track_number
        if disc_number:
            position["disc_number"] = disc_number
        _restore_or_create(MusicReleaseTrack, workspace, {"release": release, "track": track}, position)
        return release

    @staticmethod
    def _import_links(workspace, track, row, mapping, values, replace_relations=False):
        """Content-detected URL columns: a music-video URL materializes the
        video child track (with its ISRC/date when mapped) and both kinds
        attach as MusicLink rows — idempotent per URL so re-imports don't
        duplicate.
        """
        # Several link columns may map to the same field: the first video URL
        # materializes the video child, the rest attach as extra links on it.
        video_urls = _urls_in(_mapped_many(row, mapping, "track.video_url"))
        if video_urls:
            video = track.videos.filter(kind=MusicTrack.Kind.MUSIC_VIDEO).first()
            video_release_date = _mapped_date(row, mapping, "track.video_release_date")
            if video is None:
                video = MusicTrack.objects.create(
                    workspace=workspace,
                    parent_track=track,
                    title=track.title,
                    kind=MusicTrack.Kind.MUSIC_VIDEO,
                    isrc_video=values.get("isrc_video", ""),
                    release_date=video_release_date,
                )
            else:
                changed = False
                if video_release_date and not video.release_date:
                    video.release_date = video_release_date
                    changed = True
                if values.get("isrc_video") and not video.isrc_video:
                    video.isrc_video = values["isrc_video"]
                    changed = True
                if changed:
                    video.save()
            for video_url in video_urls:
                if not video.links.filter(url=video_url).exists():
                    MusicLink.objects.create(
                        workspace=workspace,
                        track=video,
                        kind=MusicLink.Kind.MUSIC_VIDEO,
                        platform=_link_platform(video_url),
                        name=_link_platform(video_url) or "Music video",
                        url=video_url,
                        isrc=values.get("isrc_video", ""),
                    )
            # In replace mode mapped link columns are authoritative for their
            # kind: video links whose URL no longer comes from any mapped
            # column are removed
            if replace_relations:
                _prune(video.links.filter(kind=MusicLink.Kind.MUSIC_VIDEO).exclude(url__in=video_urls))

        streaming_urls = [
            url for url in _urls_in(_mapped_many(row, mapping, "track.streaming_url"))
        ]
        for streaming_url in streaming_urls:
            if not track.links.filter(url=streaming_url).exists():
                MusicLink.objects.create(
                    workspace=workspace,
                    track=track,
                    kind=MusicLink.Kind.STREAMING,
                    platform=_link_platform(streaming_url),
                    name=_link_platform(streaming_url) or "Streaming",
                    url=streaming_url,
                    isrc=values.get("isrc", ""),
                )
        if replace_relations and streaming_urls:
            _prune(track.links.filter(kind=MusicLink.Kind.STREAMING).exclude(url__in=streaming_urls))

    @staticmethod
    def _apply_defaults(workspace, track, release, defaults, catalog=None):
        for entry in defaults.get("credit_entries", []):
            party = MusicParty.objects.get(id=entry["party_id"], workspace=workspace)
            role = entry.get("role") or MusicCredit.Role.PRIMARY_ARTIST
            if catalog is not None and not catalog.exists(role):
                # A role deleted since the run was saved
                role = MusicCredit.Role.OTHER
            credit = _restore_or_create(
                MusicCredit,
                workspace,
                {"track": track, "party": party, "role": role},
            )
            for field in ("percentage", "publishing_share", "territory", "notes"):
                if field in entry:
                    setattr(credit, field, entry[field] or ("" if field in ("territory", "notes") else None))
            credit.save()
            if release and credit.role == MusicCredit.Role.PRIMARY_ARTIST:
                _restore_or_create(
                    MusicReleaseArtist,
                    workspace,
                    {"release": release, "party": party, "role": MusicReleaseArtist.Role.PRIMARY},
                )

        for genre_id in defaults.get("genre_ids", []):
            genre = MusicGenre.objects.get(id=genre_id, workspace=workspace)
            _restore_or_create(MusicTrackGenre, workspace, {"track": track, "genre": genre})

        for entry in defaults.get("distribution_entries", []):
            company = MusicCompany.objects.get(id=entry["company_id"], workspace=workspace)
            distribution, _ = MusicDistribution.objects.get_or_create(
                workspace=workspace,
                track=track,
                company=company,
            )
            for field in ("percentage", "territory", "valid_from", "valid_to"):
                if field in entry:
                    value = entry[field]
                    setattr(distribution, field, value or ("" if field == "territory" else None))
            distribution.save()

        for entry in defaults.get("releases", []):
            selected_release = MusicRelease.objects.get(id=entry["id"], workspace=workspace)
            _restore_or_create(
                MusicReleaseTrack,
                workspace,
                {"track": track, "release": selected_release},
                {
                    "disc_number": entry.get("disc_number", 1),
                    "track_number": entry.get("track_number", 1),
                },
            )


class MusicReportEndpoint(MusicBaseView):
    content_negotiation_class = MusicReportContentNegotiation

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def get(self, request, slug):
        today = date.today()
        window = request.query_params.get("window")
        params = request.query_params.copy()
        if window == "upcoming":
            params["from"] = today.isoformat()
        elif window == "last_30_days":
            params["from"] = (today - timedelta(days=30)).isoformat()
            params["to"] = today.isoformat()
        # Columns come from a registry (see export.py): `columns=all`, a list
        # of keys, or nothing for the original 19 columns.
        from .export import build_rows, describe_columns, parse_columns, report_response

        workspace = Workspace.objects.get(slug=slug)
        if request.query_params.get("describe"):
            return Response(describe_columns(workspace))
        try:
            keys, legacy = parse_columns(request.query_params.get("columns"))
        except ValueError as exc:
            return Response({"error": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        tracks = _filter_tracks(MusicTrack.objects.filter(workspace=workspace, parent_track__isnull=True), params)
        headers, rows = build_rows(workspace, tracks, keys, legacy=legacy)
        export_format = request.query_params.get("format", "csv").lower()
        filename = f'music-catalog-{window or ("selected" if params.get("ids") else "report")}'
        return report_response(headers, rows, export_format, filename)
