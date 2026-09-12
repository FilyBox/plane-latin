"""Budget row annotations and cell conversations using Plane's comment contract."""
import re
import uuid

from django.db import transaction
from django.db.models import Count
from django.shortcuts import get_object_or_404
from django.utils.html import strip_tags
from rest_framework import serializers
from rest_framework.response import Response

from plane.app.permissions import ROLE, allow_permission
from plane.app.serializers.user import UserLiteSerializer
from plane.db.models import BudgetScenario, Expense, FileAsset, Office, Salary, Workspace
from plane.db.models.finance import BudgetRow, BudgetScenarioEmployee, BudgetScenarioVariable, FinanceComment
from plane.utils.content_validator import validate_html_content
from .base import FinanceBaseView, _scenario_forecast_data


class BudgetRowSerializer(serializers.ModelSerializer):
    tags = serializers.ListField(child=serializers.CharField(max_length=50), max_length=20, required=False)
    category_name = serializers.CharField(source="category.name", read_only=True, default="")
    documents = serializers.SerializerMethodField()

    class Meta:
        model = BudgetRow
        fields = ["id", "row_key", "title", "description", "category", "category_name", "tags", "documents"]
        read_only_fields = ["id", "row_key"]

    def get_documents(self, obj):
        return [{"id": str(asset.id), "asset_id": str(asset.id), **(asset.attributes or {})}
                for asset in obj.documents.filter(is_uploaded=True, is_deleted=False)]


class BudgetRowEndpoint(FinanceBaseView):
    def row(self, slug, scenario_id, row_key):
        scenario = get_object_or_404(BudgetScenario, id=scenario_id, workspace__slug=slug)
        if row_key not in {line["key"] for line in _scenario_forecast_data(scenario)["lines"]}:
            raise serializers.ValidationError({"row_key": "This row is no longer in the budget"})
        return scenario, BudgetRow.objects.filter(scenario=scenario, row_key=row_key).first()

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def get(self, request, slug, scenario_id, row_key):
        _, row = self.row(slug, scenario_id, row_key)
        return Response(BudgetRowSerializer(row).data if row else {
            "row_key": row_key, "title": "", "description": "", "category": None, "category_name": "", "tags": [], "documents": [],
        })

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def patch(self, request, slug, scenario_id, row_key):
        with transaction.atomic():
            scenario, row = self.row(slug, scenario_id, row_key)
            serializer = BudgetRowSerializer(row, data=request.data, partial=True)
            serializer.is_valid(raise_exception=True)
            row = serializer.save(workspace=scenario.workspace, scenario=scenario, row_key=row_key)
            if "asset_ids" in request.data:
                ids = serializers.ListField(child=serializers.UUIDField(), max_length=50).run_validation(request.data["asset_ids"])
                assets = FileAsset.objects.filter(workspace=scenario.workspace, id__in=ids, is_uploaded=True, is_deleted=False)
                if assets.count() != len(set(ids)):
                    raise serializers.ValidationError({"asset_ids": "Files must belong to this workspace"})
                row.documents.set(assets)
            if "entity" in request.data:
                self.move_to_office(scenario, row_key, request.data["entity"])
        return Response(BudgetRowSerializer(row).data)

    @staticmethod
    def move_to_office(scenario, row_key, office_id):
        """Refiles a line under another office.

        The office is not a property of the row: it belongs to the salary or the
        variable the line is computed from, and moving it there is what makes
        the change stick and show up in every other total. A salary line and its
        aguinaldo share one salary, so either key moves the same record.
        """
        # A salary or a concept is always charged somewhere, so this one moves;
        # it never empties. Only the category can be left unset.
        if not office_id:
            raise serializers.ValidationError({"entity": "A line always belongs to an office"})
        office = get_object_or_404(Office, id=serializers.UUIDField().run_validation(office_id), workspace=scenario.workspace)
        kind, _, identifier = row_key.partition(":")
        if kind in ("salary", "benefit"):
            assignment = get_object_or_404(
                BudgetScenarioEmployee.objects.select_related("salary"), id=identifier, scenario=scenario
            )
            salary = assignment.salary
            if salary.office_id == office.id:
                return
            # One running salary per employee and office is a database rule, so
            # a move onto an office they already draw from has to be refused
            # rather than left to raise an integrity error.
            clash = Salary.objects.filter(
                employee_id=salary.employee_id, office=office, effective_to__isnull=True
            ).exclude(id=salary.id)
            if salary.effective_to is None and clash.exists():
                raise serializers.ValidationError({"entity": "This person already draws a salary from that office"})
            salary.office = office
            salary.save(update_fields=["office"])
        elif kind == "variable":
            assignment = get_object_or_404(
                BudgetScenarioVariable.objects.select_related("variable"), id=identifier, scenario=scenario
            )
            variable = assignment.variable
            variable.office = office
            variable.save(update_fields=["office"])
        else:
            raise serializers.ValidationError({"entity": "This row has no office to change"})


class FinanceCommentSerializer(serializers.ModelSerializer):
    actor_detail = UserLiteSerializer(source="actor", read_only=True)
    comment_reactions = serializers.JSONField(source="reactions", read_only=True)
    comment_stripped = serializers.SerializerMethodField()

    class Meta:
        model = FinanceComment
        fields = ["id", "workspace", "actor", "actor_detail", "parent", "cell", "row_key", "scenario", "expense",
                  "comment_html", "comment_stripped", "comment_reactions", "created_at", "updated_at", "created_by", "updated_by"]
        read_only_fields = ["workspace", "actor", "parent", "cell", "row_key", "scenario", "expense", "created_by", "updated_by"]

    def get_comment_stripped(self, obj):
        return strip_tags(obj.comment_html)

    def validate_comment_html(self, value):
        if len(value) > 100000:
            raise serializers.ValidationError("Comment is too long")
        valid, _, sanitized = validate_html_content(value)
        if not valid:
            raise serializers.ValidationError("HTML content is not valid")
        return sanitized if sanitized is not None else value


def comment_scope(slug, params):
    scenario_id = serializers.UUIDField(required=False, allow_null=True).run_validation(params.get("scenario"))
    expense_id = serializers.UUIDField(required=False, allow_null=True).run_validation(params.get("expense"))
    if bool(scenario_id) == bool(expense_id):
        raise serializers.ValidationError("Choose a budget or an expense")
    entity = get_object_or_404(BudgetScenario if scenario_id else Expense, id=scenario_id or expense_id, workspace__slug=slug)
    scope = {"workspace_id": entity.workspace_id, "scenario_id": scenario_id, "expense_id": expense_id}
    return scope


class FinanceCommentEndpoint(FinanceBaseView):
    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def get(self, request, slug):
        scope = comment_scope(slug, request.query_params)
        comments = FinanceComment.objects.filter(**scope).select_related("actor")
        if request.query_params.get("counts"):
            return Response(list(comments.values("row_key", "cell").annotate(count=Count("id"))))
        comments = comments.filter(row_key=request.query_params.get("row_key", ""), cell=request.query_params.get("cell", ""))
        return Response(FinanceCommentSerializer(comments, many=True).data)

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def post(self, request, slug):
        scope = comment_scope(slug, request.data)
        row_key = serializers.CharField(max_length=255, allow_blank=True).run_validation(request.data.get("row_key", ""))
        cell = serializers.CharField(max_length=50, allow_blank=True).run_validation(request.data.get("cell", ""))
        parent = None
        if request.data.get("parent"):
            parent = get_object_or_404(FinanceComment, id=serializers.UUIDField().run_validation(request.data["parent"]), **scope, row_key=row_key, cell=cell)
        serializer = FinanceCommentSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        serializer.save(**scope, actor=request.user, created_by=request.user, row_key=row_key, cell=cell, parent=parent)
        return Response(serializer.data, status=201)


class FinanceCommentDetailEndpoint(FinanceBaseView):
    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def patch(self, request, slug, comment_id):
        with transaction.atomic():
            comment = get_object_or_404(FinanceComment.objects.select_for_update(), id=comment_id, workspace__slug=slug)
            if "reaction" in request.data:
                emoji = str(request.data["reaction"])
                if not re.fullmatch(r"[0-9]+(?:-[0-9]+){0,15}", emoji) or any(int(point) > 0x10FFFF for point in emoji.split("-")):
                    raise serializers.ValidationError("Invalid emoji")
                actor = str(request.user.id)
                existing = [r for r in comment.reactions if r["actor"] == actor and r["reaction"] == emoji]
                comment.reactions = [r for r in comment.reactions if r not in existing]
                if request.data.get("active", True):
                    comment.reactions.append({"id": str(uuid.uuid4()), "actor": actor, "reaction": emoji,
                                              "actor_detail": UserLiteSerializer(request.user).data})
                comment.save(update_fields=["reactions"])
            else:
                if comment.actor_id != request.user.id:
                    return Response(status=403)
                serializer = FinanceCommentSerializer(comment, data=request.data, partial=True)
                serializer.is_valid(raise_exception=True)
                serializer.save(updated_by=request.user)
        return Response(FinanceCommentSerializer(comment).data)

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def delete(self, request, slug, comment_id):
        comment = get_object_or_404(FinanceComment, id=comment_id, workspace__slug=slug)
        # Keep replies visible when their parent's text is removed.
        comment.comment_html = "<p>—</p>"
        comment.reactions = []
        comment.save(update_fields=["comment_html", "reactions"])
        return Response(status=204)


class ExpenseExportEndpoint(FinanceBaseView):
    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def post(self, request, slug):
        import csv
        import json
        from decimal import Decimal
        from io import BytesIO, StringIO
        from django.http import HttpResponse
        from openpyxl import Workbook
        from plane.utils.csv_utils import sanitize_csv_row

        try:
            ids = serializers.ListField(child=serializers.UUIDField()).run_validation(json.loads(request.data.get("ids", "[]")))
        except (ValueError, TypeError):
            raise serializers.ValidationError("Invalid expense selection")
        expenses = {str(row.id): row for row in Expense.objects.filter(workspace__slug=slug, id__in=ids).select_related("category", "scenario").prefetch_related("documents__asset")}
        rows = [["Concepto", "Fecha", "Proveedor", "Descripción", "Categoría", "Etiquetas", "Presupuesto", "Estado", "Adjuntos", "Moneda", "Importe"]]
        totals = {}
        for pk in ids:
            row = expenses.get(str(pk))
            if not row:
                continue
            rows.append([row.concept, row.expense_date.isoformat(), row.vendor, row.description, row.category.name if row.category else "", "; ".join(row.tags), row.scenario.name if row.scenario else "", row.status, "; ".join((doc.asset.attributes or {}).get("name", "") for doc in row.documents.all()), row.currency, row.amount])
            if row.status != "CANCELLED":
                totals[row.currency] = totals.get(row.currency, Decimal(0)) + row.amount
        for currency, amount in totals.items():
            rows.append(["Total", "", "", "", "", "", "", "", "", currency, amount])
        fmt = request.data.get("export_format", "csv")
        if fmt == "xlsx":
            workbook = Workbook()
            sheet = workbook.active
            sheet.title = "Gastos"
            for row in rows:
                sheet.append(sanitize_csv_row(row))
            sheet.freeze_panes = "B2"
            sheet.auto_filter.ref = sheet.dimensions
            for cell in sheet["K"][1:]:
                cell.number_format = '#,##0.00'
            output = BytesIO()
            workbook.save(output)
            response = HttpResponse(output.getvalue(), content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        elif fmt == "csv":
            output = StringIO()
            writer = csv.writer(output)
            writer.writerows(sanitize_csv_row(row) for row in rows)
            response = HttpResponse("\ufeff" + output.getvalue(), content_type="text/csv; charset=utf-8")
        else:
            raise serializers.ValidationError("Unsupported export format")
        response["Content-Disposition"] = f'attachment; filename="gastos.{fmt}"'
        return response
