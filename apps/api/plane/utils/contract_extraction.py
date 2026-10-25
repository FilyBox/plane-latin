# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Turns an AI extraction payload into the values the contract columns take.

The model answers in loose shapes ("SI, por 2 años", "24", "false", dates out
of range, titles longer than the column). Everything here degrades to a safe
value or drops the field with a warning; nothing raises, so a bad answer can
never block saving the rest of the analysis.
"""

import re
from datetime import date

from dateutil.relativedelta import relativedelta

from plane.db.models import Contract
from plane.db.models.contract import ContractStatus, ContractType
from plane.utils.contract_text_search import fold

# Prompt keys (camelCase, Spanish) -> Contract columns. Lists are joined to
# comma-separated text (crm-new reference schema).
SIMPLE_FIELD_MAP = {
    "tituloContrato": "titulo",
    "resumenGeneral": "resumen_general",
    "nombreGrupo": "nombre_grupo",
    "esPosibleExpandirlo": "es_posible_expandirlo",
    "tiempoExtensionPosible": "tiempo_extension_posible",
    "clausulaRenovacion": "expansion_time_description",
    "estatusContrato": "estatus_contrato",
    "tipoContrato": "tipo_contrato",
    "periodoColeccion": "periodo_coleccion",
    "descripcionPeriodoColeccion": "collection_period_description",
    "duracionPeriodoColeccion": "collection_period_duration",
    "periodoRetencion": "periodo_retencion",
    "descripcionPeriodoRetencion": "retention_period_description",
    "duracionPeriodoRetencion": "retention_period_duration",
}
LIST_FIELD_MAP = {
    "involucrados": "involucrados",
    "testigos": "testigos",
    "artistas": "artistas",
}
DATE_FIELD_MAP = {"fechaInicio": "fecha_inicio", "fechaFin": "fecha_fin"}
BOOL_FIELD_MAP = {"esNotariado": "es_notariado", "esEditorial": "es_editorial"}

# Evidence keys that do not name a column of their own
EVIDENCE_EXTRA_MAP = {
    "tiempoExtensionMeses": "fecha_fin_efectiva",
    "fechaFinEfectiva": "fecha_fin_efectiva",
    # Kept apart so it does not collide with fechaFin's own quote; it becomes
    # fecha_fin's evidence only when the end is computed from the term.
    "duracionMeses": "duracion_meses",
}
CAMEL_TO_FIELD = {**SIMPLE_FIELD_MAP, **LIST_FIELD_MAP, **DATE_FIELD_MAP, **BOOL_FIELD_MAP, **EVIDENCE_EXTRA_MAP}

YES_NO_FIELDS = ("es_posible_expandirlo", "periodo_coleccion", "periodo_retencion")
ENUM_FIELDS = (*YES_NO_FIELDS, "estatus_contrato", "tipo_contrato")
# Columns that cannot hold NULL; clearing them means "not specified"
NOT_NULL_DEFAULTS = {"es_posible_expandirlo": "NO_ESPECIFICADO"}

MIN_DATE = date(1950, 1, 1)
MAX_DATE = date(2100, 12, 31)
MAX_EXTENSION_MONTHS = 1200
EVIDENCE_QUOTE_CHARS = 400

# Fields whose value the term rules derive (effective end and status)
TERM_KEYS = ("fechaFin", "esPosibleExpandirlo", "tiempoExtensionMeses", "duracionMeses")

STATUS_SYNONYMS = {
    ContractStatus.VIGENTE: ("VIGENTE", "ACTIVO", "EN VIGOR", "ACTIVE", "VIGOR", "EN CURSO"),
    ContractStatus.FINALIZADO: (
        "FINALIZADO",
        "VENCIDO",
        "TERMINADO",
        "EXPIRADO",
        "CONCLUIDO",
        "EXPIRED",
        "FINISHED",
        "RESCINDIDO",
        "CANCELADO",
    ),
}

# Keyword -> type, first match wins (checked against the folded answer)
TYPE_KEYWORDS = (
    ("CESION", ContractType.CESION_DERECHOS),
    ("CONFIDENCIAL", ContractType.CONFIDENCIALIDAD),
    ("NDA", ContractType.CONFIDENCIALIDAD),
    ("MANAGEMENT", ContractType.REPRESENTACION),
    ("REPRESENTACION", ContractType.REPRESENTACION),
    ("PRODUC", ContractType.PRODUCCION),
    ("GRABACION", ContractType.PRODUCCION),
    ("MASTER", ContractType.PRODUCCION),
    ("EDITORIAL", ContractType.EDICION),
    ("PUBLISHING", ContractType.EDICION),
    ("EDICION", ContractType.EDICION),
    ("SINCRONIZACION", ContractType.LICENCIA),
    ("SYNC", ContractType.LICENCIA),
    ("LICENCIA", ContractType.LICENCIA),
    ("LICENSE", ContractType.LICENCIA),
    ("DISTRIBU", ContractType.DISTRIBUCION),
    ("COLABORACION", ContractType.COLABORACION),
    ("FEATURING", ContractType.COLABORACION),
    ("COAUTOR", ContractType.COLABORACION),
    ("SPLIT", ContractType.COLABORACION),
    ("EVENTO", ContractType.EVENTOS),
    ("PRESENTACION", ContractType.EVENTOS),
    ("BOOKING", ContractType.EVENTOS),
    ("GIRA", ContractType.EVENTOS),
    ("CONCIERTO", ContractType.EVENTOS),
    ("SHOW", ContractType.EVENTOS),
    ("PATROCINIO", ContractType.PATROCINIO),
    ("SPONSOR", ContractType.PATROCINIO),
    ("ENDORSE", ContractType.PATROCINIO),
    ("LABORAL", ContractType.LABORAL),
    ("EMPLEO", ContractType.LABORAL),
    ("TRABAJO", ContractType.LABORAL),
    ("HONORARIOS", ContractType.LABORAL),
    ("ARRENDAMIENTO", ContractType.ARRENDAMIENTOS),
    ("ALQUILER", ContractType.ALQUILERES),
    ("RENTA", ContractType.ALQUILERES),
    ("VEHICULO", ContractType.VEHICULOS),
    ("AUTOMOVIL", ContractType.VEHICULOS),
    ("ARTIST", ContractType.ARTISTAS),
    ("EXCLUSIVIDAD", ContractType.ARTISTAS),
    ("SERVICIO", ContractType.SERVICIOS),
)

UNSPECIFIED_HINTS = ("ESPECIFIC", "MENCION", "INDICA", "APLICA", "CLARO", "DEFIN", "DESCONOC", "CONSTA")


def as_bool(value):
    """The models answer booleans as true/false, "true"/"false" or "sí"/"no"."""
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and value in (0, 1):
        return bool(value)
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in ("true", "si", "sí", "yes", "1", "verdadero"):
            return True
        if lowered in ("false", "no", "0", "falso"):
            return False
    return None


def as_months(value):
    """24, "24", 24.0 or "24 meses" -> 24; anything else -> None."""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        number = value
    else:
        match = re.search(r"-?\d+(?:[.,]\d+)?", str(value))
        if not match:
            return None
        number = float(match.group(0).replace(",", "."))
    try:
        months = int(round(float(number)))
    except (TypeError, ValueError, OverflowError):
        return None
    return months if 0 <= months <= MAX_EXTENSION_MONTHS else None


def parse_date(value):
    if not value:
        return None
    try:
        return date.fromisoformat(str(value).strip()[:10])
    except ValueError:
        return None


def _key(value):
    return re.sub(r"\s+", " ", fold(str(value)).upper().replace("_", " ").replace("-", " ")).strip()


def normalize_yes_no(value):
    """SI / NO / NO_ESPECIFICADO from loose answers like "SI, por 2 años"."""
    if isinstance(value, bool):
        return "SI" if value else "NO"
    text = _key(value)
    if not text:
        return "NO_ESPECIFICADO"
    if text.startswith("NO ESPECIFICADO") or any(hint in text for hint in UNSPECIFIED_HINTS):
        return "NO_ESPECIFICADO"
    if re.match(r"^(SI|YES|TRUE|VERDADERO)\b", text):
        return "SI"
    if re.match(r"^(NO|FALSE|FALSO)\b", text):
        return "NO"
    return "NO_ESPECIFICADO"


def normalize_status(value):
    text = _key(value)
    for status, words in STATUS_SYNONYMS.items():
        if any(text.startswith(word) for word in words):
            return status.value
    return ContractStatus.NO_ESPECIFICADO.value


def normalize_type(value):
    text = _key(value)
    compact = text.replace(" ", "_")
    if compact in ContractType.values:
        return compact
    if f"{compact}S" in ContractType.values:
        return f"{compact}S"
    for keyword, contract_type in TYPE_KEYWORDS:
        if re.search(rf"\b{keyword}", text):
            return contract_type.value
    return ContractType.OTRO.value


def normalize_enum(field, value):
    if field in YES_NO_FIELDS:
        return normalize_yes_no(value)
    if field == "estatus_contrato":
        return normalize_status(value)
    return normalize_type(value)


def _max_length(field):
    return getattr(Contract._meta.get_field(field), "max_length", None)


def _as_text(value):
    if isinstance(value, list):
        return ", ".join(str(item).strip() for item in value if str(item).strip())
    if isinstance(value, dict):
        return str(value.get("nombre") or value.get("valor") or "")
    return str(value).strip()


def _is_empty(value):
    if isinstance(value, str):
        return not value.strip()
    return value is None or (isinstance(value, (list, dict)) and not value)


def camel_to_snake(key):
    if key in CAMEL_TO_FIELD:
        return CAMEL_TO_FIELD[key]
    return re.sub(r"(?<!^)(?=[A-Z])", "_", str(key)).lower()


def normalize_evidence(raw):
    """`_evidence` from the worker ({camelKey: {cita, pagina, aproximada?,
    calculada?}}) -> {column: {quote, page, approximate?, computed?}}."""
    if not isinstance(raw, dict):
        return {}
    evidence = {}
    for key, item in raw.items():
        if not isinstance(item, dict):
            if isinstance(item, str) and item.strip():
                item = {"cita": item}
            else:
                continue
        quote = item.get("cita", item.get("quote"))
        quote = str(quote).strip()[:EVIDENCE_QUOTE_CHARS] if quote else ""
        page = item.get("pagina", item.get("page"))
        try:
            page = int(page) if page not in (None, "") and not isinstance(page, bool) else None
        except (TypeError, ValueError):
            page = None
        entry = {"quote": quote, "page": page}
        if as_bool(item.get("aproximada", item.get("approximate"))):
            entry["approximate"] = True
        if as_bool(item.get("calculada", item.get("computed"))):
            entry["computed"] = True
        if not quote and page is None and not entry.get("computed"):
            continue
        evidence[camel_to_snake(key)] = entry
    return evidence


def status_for(effective_end, today=None):
    """Same rule as the daily status sync."""
    if effective_end is None:
        return None
    today = today or date.today()
    return ContractStatus.FINALIZADO.value if effective_end < today else ContractStatus.VIGENTE.value


def normalize_extracted(contract, data, allow_clear=False, today=None):
    """Values the payload would write, keyed by column.

    Returns {"values": {column: value}, "evidence": {column: {...}},
    "warnings": [{"field", "code", "value"}]}. Empty answers are skipped unless
    `allow_clear` (an accepted proposal), where an explicit null clears.
    """
    data = data if isinstance(data, dict) else {}
    values, warnings = {}, []

    def warn(field, code, value):
        warnings.append({"field": field, "code": code, "value": str(value)[:120]})

    for key, field in SIMPLE_FIELD_MAP.items():
        if key not in data:
            continue
        raw = data[key]
        if _is_empty(raw):
            if allow_clear:
                values[field] = NOT_NULL_DEFAULTS.get(field)
            continue
        if field in ENUM_FIELDS:
            value = normalize_enum(field, _as_text(raw))
            fallback = ContractType.OTRO.value if field == "tipo_contrato" else "NO_ESPECIFICADO"
            if value == fallback and _key(raw).replace(" ", "_") != fallback:
                warn(field, "unknown_value", raw)
        else:
            value = _as_text(raw)
            limit = _max_length(field)
            if limit and len(value) > limit:
                value = value[:limit]
                warn(field, "truncated", raw)
            if not value:
                continue
        values[field] = value

    for key, field in LIST_FIELD_MAP.items():
        if key not in data:
            continue
        raw = data[key]
        if isinstance(raw, list):
            names = [str(item.get("nombre", item) if isinstance(item, dict) else item).strip() for item in raw]
            names = [name for name in names if name]
            values[field] = ", ".join(names) if names else None
        elif isinstance(raw, str) and raw.strip():
            values[field] = raw.strip()
        elif raw is None and allow_clear:
            values[field] = None

    for key, field in DATE_FIELD_MAP.items():
        if key not in data:
            continue
        raw = data[key]
        if _is_empty(raw):
            if allow_clear:
                values[field] = None
            continue
        parsed = parse_date(raw)
        if parsed is None:
            warn(field, "invalid_date", raw)
        elif not (MIN_DATE <= parsed <= MAX_DATE):
            warn(field, "date_out_of_range", raw)
        else:
            values[field] = parsed

    start = values.get("fecha_inicio", contract.fecha_inicio)
    if values.get("fecha_fin") and start and values["fecha_fin"] < start:
        warn("fecha_fin", "end_before_start", values.pop("fecha_fin"))

    evidence = normalize_evidence(data.get("_evidence"))

    # "3 años desde la firma": the end follows from the start and the term
    duration = as_months(data.get("duracionMeses"))
    if duration and "fecha_fin" not in values and not parse_date(data.get("fechaFin")) and start:
        computed = start + relativedelta(months=duration)
        if computed <= MAX_DATE:
            values["fecha_fin"] = computed
            source = evidence.get("duracion_meses") or {}
            entry = {"quote": source.get("quote", ""), "page": source.get("page"), "computed": True}
            if source.get("approximate"):
                entry["approximate"] = True
            evidence["fecha_fin"] = entry

    for key, field in BOOL_FIELD_MAP.items():
        if key not in data:
            continue
        parsed = as_bool(data[key])
        if parsed is not None:
            values[field] = parsed
        elif data[key] is None and allow_clear:
            values[field] = None
        elif data[key] is not None:
            warn(field, "unknown_value", data[key])

    # Effective end: fecha_fin + extension months when the contract can be
    # extended. Only a payload that speaks about the term recomputes it, so a
    # classification-only run never resets an end someone set by hand.
    if any(key in data for key in TERM_KEYS) or "fecha_fin" in values:
        end = values.get("fecha_fin", contract.fecha_fin)
        expandable = values.get("es_posible_expandirlo", contract.es_posible_expandirlo)
        months = as_months(data.get("tiempoExtensionMeses"))
        if data.get("tiempoExtensionMeses") not in (None, "") and months is None:
            warn("fecha_fin_efectiva", "invalid_extension", data.get("tiempoExtensionMeses"))
        if end and expandable == "SI" and months is not None:
            effective = end + relativedelta(months=months)
            if effective <= MAX_DATE:
                values["fecha_fin_efectiva"] = effective
        elif end and (contract.fecha_fin_efectiva is None or expandable != "SI" or "fecha_fin" in values):
            # With no usable extension the effective end simply is the end
            if expandable != "SI" or contract.fecha_fin_efectiva is None or contract.fecha_fin_efectiva < end:
                values["fecha_fin_efectiva"] = end
        elif end is None and "fecha_fin" in values:
            values["fecha_fin_efectiva"] = None

    # Status follows the effective end (same rule as the daily sync); the
    # AI's own reading only stands when there is no date to go by.
    if "fecha_fin_efectiva" in values or "estatus_contrato" in values or any(key in data for key in TERM_KEYS):
        effective = values.get("fecha_fin_efectiva", contract.fecha_fin_efectiva)
        derived = status_for(effective, today)
        if derived:
            values["estatus_contrato"] = derived

    evidence = {field: entry for field, entry in evidence.items() if field in values}
    return {"values": values, "evidence": evidence, "warnings": warnings}


def db_repr(value):
    if isinstance(value, date):
        return value.isoformat()
    return value


def proposed_changes(contract, proposed):
    """[{field, current, proposed}] for the fields a proposal would change."""
    if not isinstance(proposed, dict):
        return []
    result = normalize_extracted(contract, proposed, allow_clear=True)
    changes = []
    for field, value in result["values"].items():
        current = getattr(contract, field)
        if db_repr(current) != db_repr(value):
            changes.append({"field": field, "current": db_repr(current), "proposed": db_repr(value)})
    return changes
