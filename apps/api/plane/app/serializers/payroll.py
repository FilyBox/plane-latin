# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Third party imports
from rest_framework import serializers

# Module imports
from plane.db.models import Adjustment, Employee, Office, PayrollPayment, Salary

from .base import BaseSerializer


class OfficeSerializer(BaseSerializer):
    employee_count = serializers.IntegerField(read_only=True, default=0)
    salary_count = serializers.IntegerField(read_only=True, default=0)
    payment_count = serializers.IntegerField(read_only=True, default=0)
    variable_count = serializers.IntegerField(read_only=True, default=0)

    class Meta:
        model = Office
        fields = [
            "id", "name", "aguinaldo_days", "workspace_id", "employee_count",
            "salary_count", "payment_count", "variable_count", "created_at", "updated_at",
        ]
        read_only_fields = ["workspace_id", "created_at", "updated_at"]

    def validate_name(self, value):
        value = value.strip()
        if not value:
            raise serializers.ValidationError("Office name cannot be empty")
        return value


class SalarySerializer(BaseSerializer):
    office_name = serializers.CharField(source="office.name", read_only=True)
    is_current = serializers.BooleanField(read_only=True)
    scenario_count = serializers.IntegerField(read_only=True, default=0)
    scenario_names = serializers.SerializerMethodField()

    class Meta:
        model = Salary
        fields = [
            "id",
            "employee",
            "office",
            "office_name",
            "amount",
            "currency",
            "periodicity",
            "effective_from",
            "effective_to",
            "is_current",
            "scenario_count",
            "scenario_names",
            "workspace_id",
            "created_at",
        ]
        read_only_fields = ["workspace_id", "employee", "created_at"]

    def validate_amount(self, value):
        if value < 0:
            raise serializers.ValidationError("The salary cannot be negative")
        return value

    def validate(self, data):
        start = data.get("effective_from", getattr(self.instance, "effective_from", None))
        end = data.get("effective_to", getattr(self.instance, "effective_to", None))
        if start and end and end < start:
            raise serializers.ValidationError({"effective_to": "Cannot be before the salary start date"})
        return data

    def get_scenario_names(self, obj):
        return sorted({assignment.scenario.name for assignment in obj.budget_scenarios.all()})


class AdjustmentSerializer(BaseSerializer):
    office_name = serializers.CharField(source="office.name", read_only=True, default=None)

    class Meta:
        model = Adjustment
        fields = [
            "id",
            "employee",
            "office",
            "office_name",
            "kind",
            "amount",
            "currency",
            "effective_date",
            "description",
            "workspace_id",
            "created_at",
        ]
        read_only_fields = ["workspace_id", "employee", "created_at"]

    def validate_amount(self, value):
        # Debts are negative in *meaning*, never in sign — the kind carries the
        # direction, so a negative amount here is always a mistake
        if value < 0:
            raise serializers.ValidationError("Enter a positive amount; the kind decides the direction")
        return value


class EmployeeSerializer(BaseSerializer):
    is_active = serializers.BooleanField(read_only=True)
    salary_count = serializers.IntegerField(read_only=True, default=0)
    adjustment_count = serializers.IntegerField(read_only=True, default=0)
    payment_count = serializers.IntegerField(read_only=True, default=0)
    scenario_count = serializers.IntegerField(read_only=True, default=0)
    scenario_names = serializers.SerializerMethodField()
    # Only the salaries in force — the full history is its own endpoint
    current_salaries = serializers.SerializerMethodField()

    class Meta:
        model = Employee
        fields = [
            "id",
            "full_name",
            "email",
            "national_id",
            "position",
            "hire_date",
            "termination_date",
            "is_active",
            "notes",
            "current_salaries",
            "salary_count",
            "adjustment_count",
            "payment_count",
            "scenario_count",
            "scenario_names",
            "workspace_id",
            "created_at",
            "updated_at",
        ]
        read_only_fields = ["workspace_id", "created_at", "updated_at"]

    def get_current_salaries(self, obj):
        return [
            {
                "id": str(salary.id),
                "office_id": str(salary.office_id),
                "office_name": salary.office.name,
                "amount": str(salary.amount),
                "currency": salary.currency,
                "periodicity": salary.periodicity,
                "effective_from": salary.effective_from,
            }
            for salary in obj.salaries.all()
            if salary.effective_to is None
        ]

    def get_scenario_names(self, obj):
        return sorted({assignment.scenario.name for assignment in obj.budget_scenarios.all()})

    def validate(self, data):
        hire = data.get("hire_date", getattr(self.instance, "hire_date", None))
        termination = data.get("termination_date", getattr(self.instance, "termination_date", None))
        if hire and termination and termination < hire:
            raise serializers.ValidationError({"termination_date": "Cannot be before the hire date"})
        return data


class PayrollPaymentSerializer(BaseSerializer):
    employee_name = serializers.CharField(source="employee.full_name", read_only=True)
    office_name = serializers.CharField(source="office.name", read_only=True)

    class Meta:
        model = PayrollPayment
        fields = [
            "id",
            "employee",
            "employee_name",
            "office",
            "office_name",
            "concept",
            "amount",
            "currency",
            "period_start",
            "period_end",
            "scheduled_date",
            "status",
            "paid_at",
            "notes",
            "workspace_id",
            "created_at",
        ]
        read_only_fields = ["workspace_id", "created_at"]

    def validate(self, data):
        start = data.get("period_start", getattr(self.instance, "period_start", None))
        end = data.get("period_end", getattr(self.instance, "period_end", None))
        if start and end and end < start:
            raise serializers.ValidationError({"period_end": "The period cannot end before it starts"})
        return data

    def validate_amount(self, value):
        if value < 0:
            raise serializers.ValidationError("The amount cannot be negative")
        return value
