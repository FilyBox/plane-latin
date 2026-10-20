# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""The three contract views — vigentes, vencidos, editoriales — as one rule.

The list endpoint, the daily status sync and the tests all read from here, so
"expired" means the same thing everywhere.
"""

from django.db.models import Q

CONTRACT_VIEWS = ("vigentes", "vencidos", "editoriales")

# A fresh upload still being analyzed: no dates and no classification yet.
# These show in every view, so whoever uploads from one of them sees the
# contract arrive; once the analysis lands it settles into the view it belongs
# to. A contract that is already classified stays put while it is re-run.
IN_FLIGHT = Q(processing_status__in=["PENDING", "PROCESSING"], es_editorial__isnull=True)


def expired_q(today):
    """Ended by date; with no end date, by what the AI read from the text."""
    return Q(fecha_fin_efectiva__lt=today) | Q(fecha_fin_efectiva__isnull=True, estatus_contrato="FINALIZADO")


def active_q(today):
    """Everything not expired — including contracts with neither a date nor a
    status, so they are not lost between the two views.

    Spelled out rather than `~expired_q(today)`: negating a lookup on a nullable
    column is exactly where NULLs go missing.
    """
    undated_not_finished = Q(fecha_fin_efectiva__isnull=True) & (
        Q(estatus_contrato__isnull=True) | ~Q(estatus_contrato="FINALIZADO")
    )
    return Q(fecha_fin_efectiva__gte=today) | undated_not_finished


def apply_contract_view(queryset, view, today):
    """Narrows a contract queryset to one view. Unknown views pass through."""
    if view == "editoriales":
        return queryset.filter(Q(es_editorial=True) | IN_FLIGHT)
    if view not in ("vigentes", "vencidos"):
        return queryset
    # Unclassified (null) contracts read as non-editorial.
    normal = queryset.filter(Q(es_editorial=False) | Q(es_editorial__isnull=True))
    rule = expired_q(today) if view == "vencidos" else active_q(today)
    return normal.filter(rule | IN_FLIGHT)
