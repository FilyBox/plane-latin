# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Contract lookups for questions over hundreds of documents (Worker → Django).

Locating documents by their metadata and reading them one batch at a time
works for a handful. Two questions don't fit that shape and would otherwise drag many rows
or documents through the model's context:

- "How many …?" / "how are they split by …?" → counted here (group-by), the
  model only sees the buckets.
- "Which contracts mention …?" across a whole filtered set → scanned here,
  server-side, and only the matching windows come back.

Both reuse the contracts search filters, so they understand the same terms.
Both chats (contracts and workspace assistant) call them.
"""

from collections import Counter

from django.db.models import Count
from django.db.models.functions import ExtractYear
from rest_framework import status
from rest_framework.response import Response

from plane.db.models import Contract
from plane.utils.contract_text_search import closest_cluster, fold_aligned, terms_for, window as text_window

from .internal import (
    DATE_FIELD_CHOICES,
    InternalBaseView,
    _apply_contract_filters,
    _as_int,
    _asset_name,
    _strip_accents,
    undated_count,
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
# Widest `near` accepted, and the widest cluster still shown as one excerpt
SCAN_MAX_NEAR = 2000
SCAN_CLUSTER_EXCERPT_MAX = 600


def _all(workspace_id):
    return Contract.objects.filter(workspace_id=workspace_id, file_asset__is_deleted=False)


def _base(workspace_id, data):
    return _apply_contract_filters(_all(workspace_id), data if isinstance(data, dict) else {})


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
                "without_date": undated_count(_all(workspace_id), data),
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
        terms = terms_for(keywords)
        if not terms:
            return Response({"error": "keywords is required"}, status=status.HTTP_400_BAD_REQUEST)
        # `near` (characters) asks for every term inside one stretch of text:
        # "José's INE" rather than a name on page 1 and someone's INE on page 30.
        near = _as_int(data.get("near"))
        near = min(max(near, 40), SCAN_MAX_NEAR) if near else None
        mode = "all" if near or str(data.get("match") or "any").lower() == "all" else "any"
        max_matches = min(max(1, _as_int(data.get("max_matches")) or 20), SCAN_MAX_MATCHES)

        all_contracts = _all(workspace_id)
        contracts = _apply_contract_filters(all_contracts, data)
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
            folded = fold_aligned(text)
            occurrences = [term.occurrences(folded) for term in terms]
            hits = [term.keyword for term, found in zip(terms, occurrences) if found]
            if not hits or (mode == "all" and len(hits) < len(terms)):
                continue
            cluster = closest_cluster(occurrences) if mode == "all" and len(terms) > 1 else None
            distance = cluster[1] - cluster[0] if cluster else None
            if near and (distance is None or distance > near):
                continue
            matched_total += 1
            if len(results) >= max_matches:
                continue
            if cluster and distance <= SCAN_CLUSTER_EXCERPT_MAX:
                # One excerpt showing the terms together
                excerpts = [{"keyword": " + ".join(hits), "text": text_window(text, *cluster, SCAN_WINDOW)}]
            else:
                excerpts = []
                for term, found in zip(terms, occurrences):
                    if found and len(excerpts) < SCAN_EXCERPTS_PER_CONTRACT:
                        start, end = found[0]
                        excerpt = {"keyword": term.keyword, "text": text_window(text, start, end, SCAN_WINDOW)}
                        if term.expanded:
                            excerpt["found"] = text[start:end]
                        excerpts.append(excerpt)
            row = {
                "contract_id": str(contract.id),
                "titulo": contract.titulo,
                "file_name": _asset_name(contract),
                "asset_id": str(contract.file_asset_id) if contract.file_asset_id else None,
                "matched_keywords": hits,
                "excerpts": excerpts,
            }
            if distance is not None:
                # Characters between the terms where they sit closest
                row["distance"] = distance
            results.append(row)

        return Response(
            {
                "candidates": candidates,
                "scanned": scanned,
                "without_text": without_text,
                "matched": matched_total,
                "returned": len(results),
                "without_date": undated_count(all_contracts, data),
                # Terms that also matched their other names (INE -> IFE, credencial para votar…)
                "expanded": {term.keyword: term.variants for term in terms if term.expanded},
                # The scan stopped before reading every candidate.
                "truncated": scanned < candidates - without_text,
                "results": results,
            },
            status=status.HTTP_200_OK,
        )
