# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""One table as an .xlsx or .csv download (deep review and contract exports)."""

import csv
from io import BytesIO

from django.http import HttpResponse
from openpyxl import Workbook

from plane.utils.csv_utils import sanitize_csv_row

XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def spreadsheet_response(filename, headers, rows, kind="csv", sheet_title="Datos"):
    """`kind` is "xlsx" or "csv"; values are sanitized against formula injection."""
    rows = [sanitize_csv_row(row) for row in rows]
    if kind == "xlsx":
        workbook = Workbook()
        sheet = workbook.active
        sheet.title = sheet_title[:31]
        sheet.append(headers)
        for row in rows:
            sheet.append(row)
        output = BytesIO()
        workbook.save(output)
        response = HttpResponse(output.getvalue(), content_type=XLSX_MIME)
        response["Content-Disposition"] = f'attachment; filename="{filename}.xlsx"'
        return response
    response = HttpResponse(content_type="text/csv; charset=utf-8")
    response["Content-Disposition"] = f'attachment; filename="{filename}.csv"'
    # BOM so Excel opens the file as UTF-8
    response.write("﻿")
    writer = csv.writer(response)
    writer.writerow(headers)
    writer.writerows(rows)
    return response
