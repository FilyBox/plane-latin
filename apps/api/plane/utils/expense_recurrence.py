"""Calendar-anchored occurrences. January 31 continues on February 28, then March 31."""
from datetime import timedelta
from dateutil.relativedelta import relativedelta


def expense_dates(start, recurrence, end):
    yield start
    if recurrence == "ONE_TIME":
        return
    days = {"DAILY": 1, "WEEKLY": 7, "BIWEEKLY": 14}
    months = {"MONTHLY": 1, "QUARTERLY": 3, "ANNUAL": 12}
    index = 1
    while True:
        occurrence = (start + timedelta(days=days[recurrence] * index)
                      if recurrence in days else start + relativedelta(months=months[recurrence] * index))
        if occurrence > end:
            return
        yield occurrence
        index += 1


def materialize_expenses(workspace_id=None):
    from django.db import transaction
    from django.utils import timezone
    from plane.db.models import Expense

    today = timezone.localdate()
    roots = Expense.objects.filter(series__isnull=True, recurrence_paused=False).exclude(
        recurrence="ONE_TIME"
    ).exclude(status="CANCELLED")
    if workspace_id:
        roots = roots.filter(workspace_id=workspace_id)
    for root_id in roots.values_list("id", flat=True):
        with transaction.atomic():
            root = Expense.objects.select_for_update().filter(id=root_id, recurrence_paused=False).first()
            if root is None or root.status == "CANCELLED":
                continue
            end = min(today, root.recurrence_end or today)
            for occurrence in expense_dates(root.expense_date, root.recurrence, end):
                if occurrence <= root.expense_date or occurrence > end:
                    continue
                # Include tombstones: deleting a generated occurrence must not recreate it.
                Expense.all_objects.get_or_create(
                    series=root, expense_date=occurrence,
                    defaults={
                        "workspace_id": root.workspace_id, "category_id": root.category_id,
                        "project_id": root.project_id, "concept": root.concept,
                        "amount": root.amount, "currency": root.currency, "vendor": root.vendor,
                        "description": root.description, "tags": root.tags, "status": "PENDING",
                    },
                )
