from celery import shared_task
from plane.utils.expense_recurrence import materialize_expenses


@shared_task
def generate_recurring_expenses():
    materialize_expenses()
