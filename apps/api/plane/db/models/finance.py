# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from django.db import models
from django.db.models import Q

from .base import BaseModel

# Money is always Decimal, never float: 0.1 + 0.2 != 0.3 in binary floating
# point, and a ledger that drifts by cents is worse than no ledger. 14 digits
# holds up to 999,999,999,999.99 in any currency.
AMOUNT_MAX_DIGITS = 14
AMOUNT_DECIMAL_PLACES = 2

# ISO 4217 code stored per row. Amounts in different currencies are never summed
# — every total is grouped by currency.
DEFAULT_CURRENCY = "MXN"


class ExpenseCategory(BaseModel):
    """A spending bucket for the workspace (Oficina, Viajes, Artistas...).

    Budgets are assigned per category and expenses are filed against one, which
    is what makes "budgeted vs spent" answerable.
    """

    workspace = models.ForeignKey("db.Workspace", on_delete=models.CASCADE, related_name="expense_categories")
    name = models.CharField(max_length=255)
    description = models.TextField(blank=True)
    color = models.CharField(max_length=255, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["workspace", "name"],
                condition=Q(deleted_at__isnull=True),
                name="unique_expense_category_name_when_not_deleted",
            )
        ]
        verbose_name = "Expense Category"
        verbose_name_plural = "Expense Categories"
        db_table = "expense_categories"
        ordering = ("name",)

    def __str__(self):
        return self.name


class Budget(BaseModel):
    """An amount allocated to a category for a period.

    The spent side is never stored here — it is aggregated from Expense on
    read. A stored counter drifts away from the ledger the first time an
    expense is edited or soft-deleted.
    """

    workspace = models.ForeignKey("db.Workspace", on_delete=models.CASCADE, related_name="budgets")
    # Always bucketed: a budget with no category can't be compared against
    # anything, since expenses are filed by category
    category = models.ForeignKey("db.ExpenseCategory", on_delete=models.CASCADE, related_name="budgets")
    # Null = the whole workspace rather than a single project
    project = models.ForeignKey(
        "db.Project", on_delete=models.CASCADE, null=True, blank=True, related_name="budgets"
    )
    period_start = models.DateField()
    period_end = models.DateField()
    amount = models.DecimalField(max_digits=AMOUNT_MAX_DIGITS, decimal_places=AMOUNT_DECIMAL_PLACES)
    currency = models.CharField(max_length=3, default=DEFAULT_CURRENCY)
    notes = models.TextField(blank=True)

    class Meta:
        constraints = [
            # One allocation per (category, project, period) — a duplicate row
            # would silently double the budget the summary reports.
            #
            # Two constraints, not one: Postgres treats NULLs as distinct, so a
            # single constraint spanning the nullable `project` would let two
            # workspace-level budgets for the same category and period both
            # through. The partial constraints cover each case explicitly.
            models.UniqueConstraint(
                fields=["workspace", "category", "project", "period_start", "period_end"],
                condition=Q(deleted_at__isnull=True, project__isnull=False),
                name="unique_project_budget_when_not_deleted",
            ),
            models.UniqueConstraint(
                fields=["workspace", "category", "period_start", "period_end"],
                condition=Q(deleted_at__isnull=True, project__isnull=True),
                name="unique_workspace_budget_when_not_deleted",
            ),
            models.CheckConstraint(
                check=Q(period_end__gte=models.F("period_start")),
                name="budget_period_end_after_start",
            ),
            models.CheckConstraint(check=Q(amount__gte=0), name="budget_amount_not_negative"),
        ]
        verbose_name = "Budget"
        verbose_name_plural = "Budgets"
        db_table = "budgets"
        ordering = ("-period_start",)
        indexes = [models.Index(fields=["workspace", "period_start", "period_end"], name="budget_ws_period_idx")]

    def __str__(self):
        return f"{self.category or 'workspace'} {self.period_start}..{self.period_end}: {self.amount}"


class BudgetScenario(BaseModel):
    """A named, annual planning workspace.

    Scenarios are intentionally separate from ledger budgets: a scenario is a
    plan that can be drafted and compared, while ``Budget`` remains an actual
    category allocation used by the expense summary.
    """

    class Status(models.TextChoices):
        DRAFT = "DRAFT", "Draft"
        ACTIVE = "ACTIVE", "Active"
        ARCHIVED = "ARCHIVED", "Archived"

    workspace = models.ForeignKey("db.Workspace", on_delete=models.CASCADE, related_name="budget_scenarios")
    name = models.CharField(max_length=255)
    description = models.TextField(blank=True)
    fiscal_year = models.PositiveSmallIntegerField()
    period_start = models.DateField()
    period_end = models.DateField()
    currency = models.CharField(max_length=3, default=DEFAULT_CURRENCY)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.DRAFT)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["workspace", "name", "fiscal_year"],
                condition=Q(deleted_at__isnull=True),
                name="unique_budget_scenario_name_year",
            ),
            models.CheckConstraint(
                check=Q(period_end__gte=models.F("period_start")),
                name="budget_scenario_period_valid",
            ),
        ]
        db_table = "budget_scenarios"
        ordering = ("-fiscal_year", "name")
        indexes = [models.Index(fields=["workspace", "fiscal_year"], name="scenario_ws_year_idx")]

    def __str__(self):
        return f"{self.name} ({self.fiscal_year})"


class FinancialVariable(BaseModel):
    """A reusable income or expense assumption owned by one entity."""

    class Kind(models.TextChoices):
        EXPENSE = "EXPENSE", "Expense"
        INCOME = "INCOME", "Income"

    class Recurrence(models.TextChoices):
        ONE_TIME = "ONE_TIME", "One time"
        DAILY = "DAILY", "Daily"
        WEEKLY = "WEEKLY", "Weekly"
        BIWEEKLY = "BIWEEKLY", "Biweekly"
        MONTHLY = "MONTHLY", "Monthly"
        QUARTERLY = "QUARTERLY", "Quarterly"
        ANNUAL = "ANNUAL", "Annual"

    workspace = models.ForeignKey("db.Workspace", on_delete=models.CASCADE, related_name="financial_variables")
    office = models.ForeignKey("db.Office", on_delete=models.CASCADE, related_name="financial_variables")
    name = models.CharField(max_length=255)
    description = models.TextField(blank=True)
    kind = models.CharField(max_length=20, choices=Kind.choices, default=Kind.EXPENSE)
    amount = models.DecimalField(max_digits=AMOUNT_MAX_DIGITS, decimal_places=AMOUNT_DECIMAL_PLACES)
    currency = models.CharField(max_length=3, default=DEFAULT_CURRENCY)
    recurrence = models.CharField(max_length=20, choices=Recurrence.choices, default=Recurrence.MONTHLY)
    effective_from = models.DateField()
    effective_to = models.DateField(null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["workspace", "office", "name"],
                condition=Q(deleted_at__isnull=True),
                name="unique_financial_variable_entity_name",
            ),
            models.CheckConstraint(check=Q(amount__gte=0), name="financial_variable_amount_positive"),
            models.CheckConstraint(
                check=Q(effective_to__isnull=True) | Q(effective_to__gte=models.F("effective_from")),
                name="financial_variable_period_valid",
            ),
        ]
        db_table = "financial_variables"
        ordering = ("office__name", "name")

    def __str__(self):
        return f"{self.office_id}: {self.name}"


class BudgetScenarioEmployee(BaseModel):
    """The salary assumption selected for one employee in a scenario."""

    workspace = models.ForeignKey("db.Workspace", on_delete=models.CASCADE, related_name="scenario_employees")
    scenario = models.ForeignKey("db.BudgetScenario", on_delete=models.CASCADE, related_name="employees")
    employee = models.ForeignKey("db.Employee", on_delete=models.CASCADE, related_name="budget_scenarios")
    salary = models.ForeignKey("db.Salary", on_delete=models.PROTECT, related_name="budget_scenarios")
    effective_from = models.DateField()
    effective_to = models.DateField(null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["scenario", "employee", "salary"],
                condition=Q(deleted_at__isnull=True),
                name="unique_scenario_employee_salary",
            ),
            models.CheckConstraint(
                check=Q(effective_to__isnull=True) | Q(effective_to__gte=models.F("effective_from")),
                name="scenario_employee_period_valid",
            ),
        ]
        db_table = "budget_scenario_employees"
        ordering = ("employee__full_name",)


class BudgetScenarioVariable(BaseModel):
    """A reusable variable included in a specific scenario."""

    workspace = models.ForeignKey("db.Workspace", on_delete=models.CASCADE, related_name="scenario_variables")
    scenario = models.ForeignKey("db.BudgetScenario", on_delete=models.CASCADE, related_name="variables")
    variable = models.ForeignKey("db.FinancialVariable", on_delete=models.CASCADE, related_name="budget_scenarios")

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["scenario", "variable"],
                condition=Q(deleted_at__isnull=True),
                name="unique_variable_per_scenario",
            )
        ]
        db_table = "budget_scenario_variables"
        ordering = ("variable__name",)


class BudgetBonus(BaseModel):
    """A recurring fixed or salary-percentage bonus in a scenario."""

    class CalculationType(models.TextChoices):
        FIXED = "FIXED", "Fixed amount"
        PERCENTAGE = "PERCENTAGE", "Salary percentage"

    class Periodicity(models.TextChoices):
        BIWEEKLY = "BIWEEKLY", "Biweekly"
        MONTHLY = "MONTHLY", "Monthly"

    workspace = models.ForeignKey("db.Workspace", on_delete=models.CASCADE, related_name="budget_bonuses")
    scenario_employee = models.ForeignKey(
        "db.BudgetScenarioEmployee", on_delete=models.CASCADE, related_name="bonuses"
    )
    name = models.CharField(max_length=255)
    calculation_type = models.CharField(max_length=20, choices=CalculationType.choices, default=CalculationType.FIXED)
    value = models.DecimalField(max_digits=AMOUNT_MAX_DIGITS, decimal_places=AMOUNT_DECIMAL_PLACES)
    periodicity = models.CharField(max_length=20, choices=Periodicity.choices, default=Periodicity.MONTHLY)
    effective_from = models.DateField()
    effective_to = models.DateField(null=True, blank=True)

    class Meta:
        constraints = [
            models.CheckConstraint(check=Q(value__gte=0), name="budget_bonus_value_positive"),
            models.CheckConstraint(
                check=Q(effective_to__isnull=True) | Q(effective_to__gte=models.F("effective_from")),
                name="budget_bonus_period_valid",
            ),
        ]
        db_table = "budget_bonuses"
        ordering = ("name",)


class BudgetCellOverride(BaseModel):
    """A deliberate replacement for one calculated monthly scenario value.

    The generated value remains in the forecast, so removing this row restores
    the calculation instead of losing the original assumption.
    """

    workspace = models.ForeignKey("db.Workspace", on_delete=models.CASCADE, related_name="budget_cell_overrides")
    scenario = models.ForeignKey("db.BudgetScenario", on_delete=models.CASCADE, related_name="cell_overrides")
    row_key = models.CharField(max_length=255)
    year = models.PositiveSmallIntegerField()
    month = models.PositiveSmallIntegerField()
    amount = models.DecimalField(max_digits=AMOUNT_MAX_DIGITS, decimal_places=AMOUNT_DECIMAL_PLACES)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["scenario", "row_key", "year", "month"],
                condition=Q(deleted_at__isnull=True),
                name="unique_budget_cell_override",
            ),
            models.CheckConstraint(check=Q(month__gte=1) & Q(month__lte=12), name="budget_override_valid_month"),
            models.CheckConstraint(check=Q(amount__gte=0), name="budget_override_amount_positive"),
        ]
        db_table = "budget_cell_overrides"
        ordering = ("row_key", "year", "month")
        indexes = [models.Index(fields=["scenario", "year", "month"], name="budget_override_period_idx")]


class Expense(BaseModel):
    """One recorded outgoing payment — an office invoice, a supplier, a fee.

    Internal ledger only: nothing here moves real money. Supporting documents
    (invoices, receipts) hang off ExpenseDocument as library FileAssets, so they
    reuse the existing bucket upload and the PDF/image viewers instead of living
    in a parallel upload path.
    """

    class Status(models.TextChoices):
        PENDING = "PENDING", "Pendiente"
        PAID = "PAID", "Pagado"
        CANCELLED = "CANCELLED", "Cancelado"

    workspace = models.ForeignKey("db.Workspace", on_delete=models.CASCADE, related_name="expenses")
    # Deleting a category must not delete the ledger rows filed under it
    category = models.ForeignKey(
        "db.ExpenseCategory", on_delete=models.SET_NULL, null=True, blank=True, related_name="expenses"
    )
    project = models.ForeignKey(
        "db.Project", on_delete=models.SET_NULL, null=True, blank=True, related_name="expenses"
    )

    amount = models.DecimalField(max_digits=AMOUNT_MAX_DIGITS, decimal_places=AMOUNT_DECIMAL_PLACES)
    currency = models.CharField(max_length=3, default=DEFAULT_CURRENCY)
    # When the money was spent — not when the row was created
    expense_date = models.DateField()
    vendor = models.CharField(max_length=255, blank=True)
    description = models.TextField(blank=True)
    # Invoice folio / reference from the supplier
    reference = models.CharField(max_length=255, blank=True)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.PENDING)
    paid_at = models.DateField(null=True, blank=True)

    class Meta:
        constraints = [
            models.CheckConstraint(check=Q(amount__gte=0), name="expense_amount_not_negative"),
        ]
        verbose_name = "Expense"
        verbose_name_plural = "Expenses"
        db_table = "expenses"
        ordering = ("-expense_date", "-created_at")
        indexes = [
            models.Index(fields=["workspace", "expense_date"], name="expense_ws_date_idx"),
            models.Index(fields=["workspace", "status"], name="expense_ws_status_idx"),
        ]

    def __str__(self):
        return f"{self.vendor or self.reference or 'expense'}: {self.amount} {self.currency}"


class ExpenseDocument(BaseModel):
    """A supporting document attached to an expense — an invoice, a receipt.

    The file itself is an ordinary library FileAsset: it lands in the same
    bucket through the same presigned upload, and the existing PDF/image viewers
    render it unchanged. This model only records that the document backs this
    expense, which is what lets one expense carry several of them.
    """

    workspace = models.ForeignKey("db.Workspace", on_delete=models.CASCADE, related_name="expense_documents")
    expense = models.ForeignKey("db.Expense", on_delete=models.CASCADE, related_name="documents")
    asset = models.ForeignKey("db.FileAsset", on_delete=models.CASCADE, related_name="expense_documents")

    class Meta:
        constraints = [
            # Attaching the same file twice is an accident, not two documents
            models.UniqueConstraint(
                fields=["expense", "asset"],
                condition=Q(deleted_at__isnull=True),
                name="unique_expense_document_when_not_deleted",
            )
        ]
        verbose_name = "Expense Document"
        verbose_name_plural = "Expense Documents"
        db_table = "expense_documents"
        ordering = ("created_at",)

    def __str__(self):
        return f"{self.expense_id} -> {self.asset_id}"
