# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Contract lookups for questions over hundreds of documents (Worker → Django).

The contracts agent locates documents and then reads them one batch at a
time. Two questions don't fit that shape and would otherwise drag many rows
or documents through the model's context:

- "How many …?" / "how are they split by …?" → counted here (group-by), the
  model only sees the buckets.
- "Which contracts mention …?" across a whole filtered set → scanned here,
  server-side, and only the matching windows come back.

Both reuse the contracts agent's filters, so they understand the same terms.
"""

from collections import Counter

from django.db.models import Count
from django.db.models.functions import ExtractYear
from rest_framework import status
from rest_framework.response import Response

from plane.db.models import Contract

from .internal import (
    DATE_FIELD_CHOICES,
    InternalBaseView,
    _apply_contract_filters,
    _as_int,
    _asset_name,
    _strip_accents,
)

GROUPABLE = {
    "estatus": "estatus_contrato",
    "tipo": "tipo_contrato",
    "editorial": "es_editorial",
    "notariado": "es_notariado",
    "procesamiento": "processing_status",
}
# Text columns holding comma-separated names: counted per name.
NAME_GROUPS = {"artista": "artistas", "grupo": "nombre_grupo"}

SCAN_MAX_DOCUMENTS = 800
SCAN_MAX_MATCHES = 40
SCAN_WINDOW = 320
SCAN_EXCERPTS_PER_CONTRACT = 2


def _base(workspace_id, data):
    contracts = Contract.objects.filter(workspace_id=workspace_id, file_asset__is_deleted=False)
    return _apply_contract_filters(contracts, data if isinstance(data, dict) else {})


class InternalContractGroupEndpoint(InternalBaseView):
    """Counts of contracts per value of one field, under the usual filters."""

    def post(self, request, workspace_id):
        data = request.data if isinstance(request.data, dict) else {}
        group_by = str(data.get("group_by") or "").lower()
        contracts = _base(workspace_id, data)
        total = contracts.count()

        if group_by in GROUPABLE:
            field = GROUPABLE[group_by]
            rows = contracts.values(field).annotate(count=Count("id", distinct=True)).order_by("-count")
            buckets = [{"value": row[field], "count": row["count"]} for row in rows]
        elif group_by == "year":
            field = DATE_FIELD_CHOICES.get(str(data.get("date_field") or "fin").lower(), "fecha_fin")
            rows = (
                contracts.annotate(year=ExtractYear(field))
                .values("year")
                .annotate(count=Count("id", distinct=True))
                .order_by("-year")
            )
            buckets = [{"value": row["year"], "count": row["count"]} for row in rows]
        elif group_by in NAME_GROUPS:
            counter: Counter = Counter()
            spellings: dict[str, Counter] = {}
            for value in contracts.values_list(NAME_GROUPS[group_by], flat=True)[:10000]:
                for name in str(value or "").replace(";", ",").split(","):
                    clean = " ".join(name.split())
                    if not clean:
                        continue
                    key = _strip_accents(clean)
                    spellings.setdefault(key, Counter())[clean] += 1
                    counter[key] += 1
            # Shown as its most common spelling (ties: the more capitalised).
            buckets = [
                {
                    "value": max(spellings[key].items(), key=lambda item: (item[1], sum(c.isupper() for c in item[0])))[
                        0
                    ],
                    "count": count,
                }
                for key, count in counter.most_common()
            ]
        else:
            return Response(
                {"error": f"group_by must be one of {sorted([*GROUPABLE, *NAME_GROUPS, 'year'])}"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        limit = min(max(1, _as_int(data.get("limit")) or 30), 100)
        return Response(
            {
                "total": total,
                "group_by": group_by,
                "buckets": buckets[:limit],
                "more_buckets": max(0, len(buckets) - limit),
            },
            status=status.HTTP_200_OK,
        )


class InternalContractScanEndpoint(InternalBaseView):
    """Looks for literal terms inside every contract of a filtered set and
    returns only the matches, each with a short window around the hit."""

    def post(self, request, workspace_id):
        data = request.data if isinstance(request.data, dict) else {}
        keywords = data.get("keywords") or []
        if isinstance(keywords, str):
            keywords = [keywords]
        keywords = [str(keyword).strip() for keyword in keywords if str(keyword).strip()][:6]
        if not keywords:
            return Response({"error": "keywords is required"}, status=status.HTTP_400_BAD_REQUEST)
        mode = "all" if str(data.get("match") or "any").lower() == "all" else "any"
        max_matches = min(max(1, _as_int(data.get("max_matches")) or 20), SCAN_MAX_MATCHES)
        needles = [(keyword, _strip_accents(keyword)) for keyword in keywords]

        contracts = _base(workspace_id, data)
        candidates = contracts.count()
        without_text = (
            contracts.filter(extracted_text__isnull=True).count() + contracts.filter(extracted_text="").count()
        )
        readable = (
            contracts.exclude(extracted_text__isnull=True)
            .exclude(extracted_text="")
            .select_related("file_asset")
            .only("id", "titulo", "extracted_text", "file_asset__attributes", "file_asset_id")
            .order_by("-created_at")
        )

        scanned = 0
        matched_total = 0
        results = []
        for contract in readable.iterator(chunk_size=50):
            if scanned >= SCAN_MAX_DOCUMENTS:
                break
            scanned += 1
            text = contract.extracted_text or ""
            folded = _strip_accents(text)
            positions = {keyword: folded.find(needle) for keyword, needle in needles if needle}
            hits = [keyword for keyword, position in positions.items() if position != -1]
            if not hits or (mode == "all" and len(hits) < len(needles)):
                continue
            matched_total += 1
            if len(results) >= max_matches:
                continue
            excerpts = []
            for keyword in hits[:SCAN_EXCERPTS_PER_CONTRACT]:
                start = positions[keyword]
                left = max(0, start - SCAN_WINDOW // 2)
                right = min(len(text), start + len(keyword) + SCAN_WINDOW // 2)
                excerpts.append({"keyword": keyword, "text": " ".join(text[left:right].split())})
            results.append(
                {
                    "contract_id": str(contract.id),
                    "titulo": contract.titulo,
                    "file_name": _asset_name(contract),
                    "asset_id": str(contract.file_asset_id) if contract.file_asset_id else None,
                    "matched_keywords": hits,
                    "excerpts": excerpts,
                }
            )

        return Response(
            {
                "candidates": candidates,
                "scanned": scanned,
                "without_text": without_text,
                "matched": matched_total,
                "returned": len(results),
                # The scan stopped before reading every candidate.
                "truncated": scanned < candidates - without_text,
                "results": results,
            },
            status=status.HTTP_200_OK,
        )
