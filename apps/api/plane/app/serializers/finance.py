# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Third party imports
from rest_framework import serializers

# Module imports
from plane.db.models import (
    Budget,
    BudgetBonus,
    BudgetScenario,
    BudgetScenarioEmployee,
    BudgetScenarioVariable,
    Expense,
    ExpenseCategory,
    FinancialVariable,
)

from .base import BaseSerializer


def normalize_currency(value):
    """Three letters, uppercase: "usd" and "USD" must never become two currencies."""
    value = (value or "").strip()
    if len(value) != 3 or not value.isalpha():
        raise serializers.ValidationError("Use a three-letter currency code")
    return value.upper()


class ExpenseCategorySerializer(BaseSerializer):
    expense_count = serializers.IntegerField(read_only=True, default=0)

    class Meta:
        model = ExpenseCategory
        fields = [
            "id",
            "name",
            "description",
            "color",
            "workspace_id",
            "expense_count",
            "created_at",
            "updated_at",
        ]
        read_only_fields = ["workspace_id", "created_at", "updated_at"]

    def validate_name(self, value):
        value = value.strip()
        if not value:
            raise serializers.ValidationError("Category name cannot be empty")
        return value


class BudgetSerializer(BaseSerializer):
    class Meta:
        model = Budget
        fields = [
            "id",
            "category",
            "project",
            "period_start",
            "period_end",
            "amount",
            "currency",
            "notes",
            "workspace_id",
            "created_at",
            "updated_at",
        ]
        read_only_fields = ["workspace_id", "created_at", "updated_at"]

    def validate(self, data):
        # The database enforces this too, but a 400 with a message beats an
        # IntegrityError surfacing as a 500.
        start = data.get("period_start", getattr(self.instance, "period_start", None))
        end = data.get("period_end", getattr(self.instance, "period_end", None))
        if start and end and end < start:
            raise serializers.ValidationError({"period_end": "The period cannot end before it starts"})
        return data

    def validate_amount(self, value):
        if value < 0:
            raise serializers.ValidationError("The budget cannot be negative")
        return value


class BudgetScenarioSerializer(BaseSerializer):
    employee_count = serializers.IntegerField(read_only=True, default=0)
    variable_count = serializers.IntegerField(read_only=True, default=0)

    class Meta:
        model = BudgetScenario
        fields = [
            "id",
            "name",
            "description",
            "fiscal_year",
            "period_start",
            "period_end",
            "currency",
            "status",
            "employee_count",
            "variable_count",
            "workspace_id",
            "created_at",
            "updated_at",
        ]
        read_only_fields = ["workspace_id", "created_at", "updated_at"]

    def validate_name(self, value):
        value = value.strip()
        if not value:
            raise serializers.ValidationError("Scenario name cannot be empty")
        return value

    def validate_currency(self, value):
        return normalize_currency(value)

    def validate(self, data):
        start = data.get("period_start", getattr(self.instance, "period_start", None))
        end = data.get("period_end", getattr(self.instance, "period_end", None))
        year = data.get("fiscal_year", getattr(self.instance, "fiscal_year", None))
        if start and end and end < start:
            raise serializers.ValidationError({"period_end": "The period cannot end before it starts"})
        if start and end and ((end.year - start.year) * 12 + end.month - start.month + 1) > 12:
            raise serializers.ValidationError({"period_end": "A budget scenario can cover at most 12 months"})
        if start and end and year and not (start.year <= year <= end.year):
            raise serializers.ValidationError({"fiscal_year": "The fiscal year must fall inside the scenario period"})
        return data


class FinancialVariableSerializer(BaseSerializer):
    office_name = serializers.CharField(source="office.name", read_only=True)

    def validate_currency(self, value):
        return normalize_currency(value)

    class Meta:
        model = FinancialVariable
        fields = [
            "id",
            "office",
            "office_name",
            "name",
            "description",
            "kind",
            "amount",
            "currency",
            "recurrence",
            "effective_from",
            "effective_to",
            "workspace_id",
            "created_at",
            "updated_at",
        ]
        read_only_fields = ["workspace_id", "created_at", "updated_at"]

    def validate_amount(self, value):
        if value < 0:
            raise serializers.ValidationError("The amount cannot be negative")
        return value

    def validate(self, data):
        start = data.get("effective_from", getattr(self.instance, "effective_from", None))
        end = data.get("effective_to", getattr(self.instance, "effective_to", None))
        if start and end and end < start:
            raise serializers.ValidationError({"effective_to": "The end date cannot be before the start date"})
        return data


class BudgetBonusSerializer(BaseSerializer):
    class Meta:
        model = BudgetBonus
        fields = [
            "id",
            "scenario_employee",
            "name",
            "calculation_type",
            "value",
            "periodicity",
            "effective_from",
            "effective_to",
            "workspace_id",
            "created_at",
            "updated_at",
        ]
        read_only_fields = ["workspace_id", "scenario_employee", "created_at", "updated_at"]

    def validate_value(self, value):
        if value < 0:
            raise serializers.ValidationError("The bonus cannot be negative")
        return value

    def validate(self, data):
        start = data.get("effective_from", getattr(self.instance, "effective_from", None))
        end = data.get("effective_to", getattr(self.instance, "effective_to", None))
        if start and end and end < start:
            raise serializers.ValidationError({"effective_to": "The end date cannot be before the start date"})
        calculation = data.get("calculation_type", getattr(self.instance, "calculation_type", None))
        value = data.get("value", getattr(self.instance, "value", None))
        if calculation == "PERCENTAGE" and value is not None and value > 100:
            raise serializers.ValidationError({"value": "A percentage bonus cannot exceed 100%"})
        return data


class BudgetScenarioEmployeeSerializer(BaseSerializer):
    employee_name = serializers.CharField(source="employee.full_name", read_only=True)
    position = serializers.CharField(source="employee.position", read_only=True)
    office_id = serializers.UUIDField(source="salary.office_id", read_only=True)
    office_name = serializers.CharField(source="salary.office.name", read_only=True)
    salary_amount = serializers.DecimalField(source="salary.amount", max_digits=14, decimal_places=2, read_only=True)
    salary_currency = serializers.CharField(source="salary.currency", read_only=True)
    salary_periodicity = serializers.CharField(source="salary.periodicity", read_only=True)
    bonuses = BudgetBonusSerializer(many=True, read_only=True)

    class Meta:
        model = BudgetScenarioEmployee
        fields = [
            "id",
            "scenario",
            "employee",
            "employee_name",
            "position",
            "salary",
            "office_id",
            "office_name",
            "salary_amount",
            "salary_currency",
            "salary_periodicity",
            "effective_from",
            "effective_to",
            "bonuses",
            "workspace_id",
            "created_at",
            "updated_at",
        ]
        read_only_fields = ["workspace_id", "scenario", "created_at", "updated_at"]

    def validate(self, data):
        start = data.get("effective_from", getattr(self.instance, "effective_from", None))
        end = data.get("effective_to", getattr(self.instance, "effective_to", None))
        salary = data.get("salary", getattr(self.instance, "salary", None))
        employee = data.get("employee", getattr(self.instance, "employee", None))
        if start and end and end < start:
            raise serializers.ValidationError({"effective_to": "The end date cannot be before the start date"})
        if salary and employee and salary.employee_id != employee.id:
            raise serializers.ValidationError({"salary": "The salary does not belong to this employee"})
        return data


class BudgetScenarioVariableSerializer(BaseSerializer):
    variable_detail = FinancialVariableSerializer(source="variable", read_only=True)

    class Meta:
        model = BudgetScenarioVariable
        fields = ["id", "scenario", "variable", "variable_detail", "workspace_id", "created_at"]
        read_only_fields = ["workspace_id", "scenario", "created_at"]


class ExpenseSerializer(BaseSerializer):
    # Denormalized for the table so it doesn't need a second round-trip
    category_name = serializers.CharField(source="category.name", read_only=True, default=None)
    # The budget line, by the key the forecast gives it ("salary:<id>", …). Blank
    # or null unassigns it; omitting it leaves the current line alone.
    budget_line = serializers.CharField(required=False, allow_blank=True, allow_null=True, write_only=True)
    documents = serializers.SerializerMethodField()
    tags = serializers.ListField(child=serializers.CharField(max_length=50), max_length=20, required=False)

    class Meta:
        model = Expense
        fields = [
            "id",
            "concept",
            "tags",
            "recurrence",
            "recurrence_end",
            "recurrence_paused",
            "series",
            "category",
            "category_name",
            "project",
            "scenario",
            "budget_line",
            "documents",
            "amount",
            "currency",
            "expense_date",
            "vendor",
            "description",
            "reference",
            "status",
            "paid_at",
            "workspace_id",
            "created_at",
            "updated_at",
        ]
        read_only_fields = ["workspace_id", "created_at", "updated_at", "series"]

    def validate(self, data):
        workspace_id = self.context.get("workspace_id") or getattr(self.instance, "workspace_id", None)
        for field in ("category", "project", "scenario"):
            related = data.get(field)
            if related and related.workspace_id != workspace_id:
                raise serializers.ValidationError({field: "Must belong to this workspace"})
        start = data.get("expense_date", getattr(self.instance, "expense_date", None))
        end = data.get("recurrence_end", getattr(self.instance, "recurrence_end", None))
        if start and end and end < start:
            raise serializers.ValidationError({"recurrence_end": "Must be on or after the first expense"})
        self._resolve_budget_line(data)
        if self.instance and self.instance.series_id and data.get("recurrence", "ONE_TIME") != "ONE_TIME":
            raise serializers.ValidationError({"recurrence": "Edit the original expense to change the series"})
        if self.instance and "recurrence" in data and data["recurrence"] != self.instance.recurrence:
            if Expense.all_objects.filter(series=self.instance).exists():
                raise serializers.ValidationError({"recurrence": "Pause this series and create a new one to change its frequency"})
        if self.instance and self.instance.recurrence != "ONE_TIME" and start != self.instance.expense_date:
            raise serializers.ValidationError({"expense_date": "The first date of a series cannot be changed"})
        if "tags" in data:
            data["tags"] = list(dict.fromkeys(tag.strip() for tag in data["tags"] if tag.strip()))
        # Resuming a paused series starts again from today: the dates that fell
        # inside the pause are not created as a pile of pending expenses.
        if self.instance and self.instance.recurrence_paused and data.get("recurrence_paused") is False:
            from plane.utils.expense_recurrence import _today_in

            data["recurrence_resume_from"] = _today_in(getattr(self.instance.workspace, "timezone", "UTC"))
        currency = data.get("currency")
        if currency and (len(currency) != 3 or not currency.isalpha()):
            raise serializers.ValidationError({"currency": "Use a three-letter currency code"})
        if currency:
            data["currency"] = currency.upper()
        return data

    def _resolve_budget_line(self, data):
        """Turns `budget_line` into the BudgetRow it names, and keeps the pair
        consistent: a line always belongs to the expense's budget and shares its
        currency, and moving the expense to another budget drops a line that
        isn't part of it."""
        from plane.utils.budget_lines import budget_row_for, line_source

        scenario = data["scenario"] if "scenario" in data else getattr(self.instance, "scenario", None)
        if "budget_line" not in data:
            current = getattr(self.instance, "budget_row", None)
            if current is not None and (scenario is None or current.scenario_id != scenario.id):
                data["budget_row"] = None
            return
        key = data.pop("budget_line")
        if not key:
            data["budget_row"] = None
            return
        if scenario is None:
            raise serializers.ValidationError({"budget_line": "Choose the budget before its line"})
        source = line_source(scenario, key)
        if source is None:
            raise serializers.ValidationError({"budget_line": "This line is not part of the budget"})
        currency = (data.get("currency") or getattr(self.instance, "currency", "") or "").upper()
        if currency and source[1] and currency != source[1].upper():
            raise serializers.ValidationError(
                {"budget_line": f"This line is planned in {source[1]}; the expense is in {currency}"}
            )
        data["budget_row"] = budget_row_for(scenario, key)

    def to_representation(self, instance):
        from plane.utils.budget_lines import line_label

        data = super().to_representation(instance)
        row = getattr(instance, "budget_row", None)
        data["budget_line"] = row.row_key if row else None
        data["budget_line_label"] = line_label(row, self.context.setdefault("line_labels", {})) if row else None
        return data

    def get_documents(self, obj):
        """Enough for the row's chips and the preview modal (which needs the
        content type to pick a viewer) without a second request.
        """
        return [
            {
                "id": str(document.id),
                "asset_id": str(document.asset_id),
                "name": (document.asset.attributes or {}).get("name"),
                "type": (document.asset.attributes or {}).get("type"),
                "size": (document.asset.attributes or {}).get("size"),
            }
            for document in obj.documents.all()
            if document.asset_id
        ]

    def validate_amount(self, value):
        if value < 0:
            raise serializers.ValidationError("The amount cannot be negative")
        return value
