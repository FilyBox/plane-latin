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
    documents = serializers.SerializerMethodField()

    class Meta:
        model = Expense
        fields = [
            "id",
            "category",
            "category_name",
            "project",
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
        read_only_fields = ["workspace_id", "created_at", "updated_at"]

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
