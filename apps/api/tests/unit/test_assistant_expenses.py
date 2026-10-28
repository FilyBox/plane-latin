"""Expenses from receipts: CFDI read exactly (3.3 and 4.0), malicious XML
refused, a PDF and its XML paired into one expense, sure duplicates by the
fiscal UUID, and undo that keeps what someone edited."""

from unittest.mock import patch
from uuid import uuid4

import pytest
from rest_framework.test import APIClient

from plane.app.views.finance import imports
from plane.db.models import AssistantAction, Expense, ExpenseDocument, FileAsset, WorkspaceFeature
from plane.db.models.finance import ExpenseImport
from plane.tests.factories import UserFactory, WorkspaceFactory, WorkspaceMemberFactory
from plane.utils.cfdi import NotCfdi, parse, to_expense, uuid_in_text

UUID_40 = "6F2C3A1B-1234-4ABC-9DEF-0123456789AB"

CFDI_40 = f"""<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital"
  Version="4.0" Serie="A" Folio="1024" Fecha="2026-03-14T10:22:05" SubTotal="10000.00" Moneda="MXN"
  Total="11600.00" TipoDeComprobante="I" MetodoPago="PUE" FormaPago="03" Exportacion="01" LugarExpedicion="64000">
  <cfdi:Emisor Rfc="EST010101AAA" Nombre="ESTUDIO DE GRABACION DEL NORTE" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="DIS020202BBB" Nombre="DISQUERA EJEMPLO" UsoCFDI="G03"/>
  <cfdi:Conceptos>
    <cfdi:Concepto ClaveProdServ="80141600" Cantidad="1" Descripcion="Sesión de grabación 8 horas" Importe="8000.00"/>
    <cfdi:Concepto ClaveProdServ="80141600" Cantidad="1" Descripcion="Mezcla" Importe="2000.00"/>
  </cfdi:Conceptos>
  <cfdi:Impuestos TotalImpuestosTrasladados="1600.00"/>
  <cfdi:Complemento>
    <tfd:TimbreFiscalDigital Version="1.1" UUID="{UUID_40.lower()}" FechaTimbrado="2026-03-14T10:25:00"/>
  </cfdi:Complemento>
</cfdi:Comprobante>""".encode()

CFDI_33_CREDIT = b"""<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/3" xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital"
  Version="3.3" Folio="77" Fecha="2021-07-01T09:00:00" SubTotal="100.00" Moneda="USD" TipoCambio="20.10"
  Total="116.00" TipoDeComprobante="E" MetodoPago="PPD">
  <cfdi:Emisor Rfc="PRO030303CCC" Nombre="Proveedor SA"/>
  <cfdi:Receptor Rfc="DIS020202BBB"/>
  <cfdi:Conceptos><cfdi:Concepto Cantidad="1" Descripcion="Devolucion" Importe="100.00"/></cfdi:Conceptos>
  <cfdi:Complemento><tfd:TimbreFiscalDigital UUID="11111111-2222-3333-4444-555555555555"/></cfdi:Complemento>
</cfdi:Comprobante>"""


class TestCfdi:
    def test_40_is_read_exactly(self):
        expense = to_expense(parse(CFDI_40))
        assert expense["amount"] == "11600.00" and expense["currency"] == "MXN"
        assert expense["expense_date"] == "2026-03-14"
        assert expense["vendor"] == "ESTUDIO DE GRABACION DEL NORTE" and "EST010101AAA" in expense["description"]
        assert expense["reference"] == "A1024" and expense["cfdi_uuid"] == UUID_40
        assert expense["concept"].startswith("Sesión de grabación") and "1 concepto(s) más" in expense["concept"]
        assert expense["suggested_status"] == "PAID" and expense["warnings"] == []

    def test_33_credit_note_warns(self):
        expense = to_expense(parse(CFDI_33_CREDIT))
        assert expense["currency"] == "USD" and expense["suggested_status"] == "PENDING"
        assert any("nota de crédito" in warning for warning in expense["warnings"])
        assert parse(CFDI_33_CREDIT)["version"] == "3.3"

    @pytest.mark.parametrize(
        "data",
        [
            b'<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;">]>'
            b'<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Total="&lol2;"/>',
            b'<?xml version="1.0"?><!DOCTYPE x [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><x>&xxe;</x>',
            b"<factura><total>10</total></factura>",
            b"not xml",
            b"",
        ],
    )
    def test_anything_else_is_refused(self, data):
        with pytest.raises(NotCfdi):
            parse(data)

    def test_uuid_printed_on_a_pdf(self):
        assert uuid_in_text(f"Folio fiscal: {UUID_40.lower()} Fecha") == UUID_40


# ---------------------------------------------------------------- flow

pytestmark_db = [pytest.mark.django_db]


@pytest.fixture
def setup():
    workspace = WorkspaceFactory()
    WorkspaceFeature.objects.create(workspace=workspace, key="payments", is_enabled=True)
    admin = workspace.owner
    WorkspaceMemberFactory(workspace=workspace, member=admin, role=20)
    member = UserFactory(username=f"member-{uuid4().hex[:8]}")
    WorkspaceMemberFactory(workspace=workspace, member=member, role=15)
    return {"workspace": workspace, "admin": admin, "member": member}


def asset(setup, name, mime, content=b""):
    item = FileAsset.objects.create(
        workspace=setup["workspace"],
        asset=f"{setup['workspace'].id}/{uuid4().hex}-{name}",
        attributes={"name": name, "type": mime, "size": len(content) or 10},
        entity_type=FileAsset.EntityTypeContext.WORKSPACE_FILE_LIBRARY,
        is_uploaded=True,
    )
    STORE[item.asset.name] = content
    return item


STORE: dict = {}


def internal(setup, body):
    from django.test import override_settings

    with override_settings(PLANE_INTERNAL_API_SECRET="secret"):
        return (
            APIClient()
            .post(
                f"/api/internal/workspaces/{setup['workspace'].id}/assistant/expenses/from-documents/",
                {"user_id": str(setup["admin"].id), **body},
                format="json",
                HTTP_X_PLANE_INTERNAL_KEY="secret",
            )
            .json()
        )


def client_for(user):
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def finish_pdf(job, uuid=UUID_40):
    """What the receipt analysis reports for the PDF of the invoice."""
    job = ExpenseImport.objects.get(id=job)
    job.status = "READY"
    job.data = {"amount": "11600.00", "currency": "MXN", "expense_date": "2026-03-14", "cfdi_uuid": uuid}
    job.save()


@pytest.mark.django_db
@patch.object(imports, "dispatch_import")
@patch.object(imports, "read_asset_bytes", side_effect=lambda item: STORE[item.asset.name])
class TestExpenses:
    def test_pdf_and_xml_make_one_expense_and_undo(self, read, dispatch, setup):
        xml = asset(setup, "factura-1024.xml", "application/xml", CFDI_40)
        pdf = asset(setup, "factura-1024.pdf", "application/pdf")
        started = internal(setup, {"asset_ids": [str(xml.id), str(pdf.id)]})
        assert dispatch.call_count == 1  # only the PDF goes to the analysis
        assert started["pending"] == 1
        finish_pdf(ExpenseImport.objects.get(asset=pdf).id)

        slug = setup["workspace"].slug
        client = client_for(setup["admin"])
        drafts = client.get(
            f"/api/workspaces/{slug}/assistant/expense-drafts/", {"job_ids": ",".join(started["job_ids"])}
        ).json()
        assert drafts["pending"] == 0 and len(drafts["expenses"]) == 1
        row = drafts["expenses"][0]
        assert row["matched_by"] == "uuid" and len(row["files"]) == 2 and row["files"][0]["xml"] is True
        data = row["data"]
        body = {
            "kind": "CREATE_EXPENSES",
            "items": [
                {
                    "job_ids": row["job_ids"],
                    "expense": {
                        key: data[key]
                        for key in ("concept", "vendor", "amount", "currency", "expense_date", "reference", "description")
                    },
                }
            ],
        }
        response = client.post(f"/api/workspaces/{slug}/assistant/actions/", body, format="json")
        assert response.status_code == 201, response.content
        expense = Expense.objects.get()
        assert expense.cfdi_uuid == UUID_40 and str(expense.amount) == "11600.00"
        assert ExpenseDocument.objects.filter(expense=expense).count() == 2
        assert set(ExpenseImport.objects.values_list("status", flat=True)) == {"IMPORTED"}

        # The same invoice again is a sure duplicate
        again = client.post(f"/api/workspaces/{slug}/assistant/actions/", body, format="json")
        assert again.status_code == 400

        undone = client.post(f"/api/workspaces/{slug}/assistant/actions/{response.json()['id']}/undo/", format="json")
        assert undone.status_code == 200, undone.content
        assert not Expense.objects.exists()
        assert set(ExpenseImport.objects.values_list("status", flat=True)) == {"READY"}

    def test_undo_keeps_an_edited_expense(self, read, dispatch, setup):
        xml = asset(setup, "f.xml", "text/xml", CFDI_40)
        started = internal(setup, {"asset_ids": [str(xml.id)]})
        assert started["pending"] == 0 and dispatch.call_count == 0
        slug = setup["workspace"].slug
        client = client_for(setup["admin"])
        body = {
            "kind": "CREATE_EXPENSES",
            "items": [
                {
                    "job_ids": started["job_ids"],
                    "expense": {"concept": "Grabación", "amount": "11600.00", "currency": "MXN", "expense_date": "2026-03-14"},
                }
            ],
        }
        action = client.post(f"/api/workspaces/{slug}/assistant/actions/", body, format="json").json()
        Expense.objects.update(concept="Grabación sencillo")
        undone = client.post(f"/api/workspaces/{slug}/assistant/actions/{action['id']}/undo/", format="json").json()
        assert Expense.objects.filter(concept="Grabación sencillo").exists()
        assert undone["result"]["undo_conflicts"][0]["field"] == "concept"

    def test_a_duplicate_in_the_ledger_is_flagged(self, read, dispatch, setup):
        Expense.objects.create(
            workspace=setup["workspace"], amount="11600.00", expense_date="2026-03-14", cfdi_uuid=UUID_40, concept="Ya"
        )
        xml = asset(setup, "f.xml", "application/xml", CFDI_40)
        started = internal(setup, {"asset_ids": [str(xml.id)]})
        duplicates = started["expenses"][0]["data"]["duplicates"]
        assert duplicates[0]["same_cfdi"] is True

    def test_members_cannot(self, read, dispatch, setup):
        response = client_for(setup["member"]).post(
            f"/api/workspaces/{setup['workspace'].slug}/assistant/actions/",
            {"kind": "CREATE_EXPENSES", "items": [{"job_ids": [str(uuid4())], "expense": {}}]},
            format="json",
        )
        assert response.status_code == 400 and not AssistantAction.objects.exists()

    def test_heic_and_tiff_are_accepted(self, read, dispatch, setup):
        photo = asset(setup, "ticket.heic", "image/heic")
        scan = asset(setup, "ticket.tiff", "image/tiff")
        unnamed = asset(setup, "IMG_0042.HEIC", "application/octet-stream")
        assert imports.unsupported_assets([photo, scan, unnamed]) == []
        assert imports.media_type(unnamed) == "image/heic"
        assert imports.unsupported_assets([asset(setup, "x.zip", "application/zip")])
