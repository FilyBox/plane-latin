# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Mexican electronic invoices (CFDI 3.3 and 4.0) read deterministically.

The XML never reaches a model: amounts, dates and the fiscal folio (UUID) come
straight from the attributes, so they are exact. The parser resolves no
entities, loads no DTD, touches no network and refuses anything with a
DOCTYPE or over 2 MB.

    CFDI                               Expense
    Total, Moneda, TipoCambio          amount, currency
    Fecha                              expense_date
    Emisor@Nombre (+ RFC)              vendor (RFC in the description)
    Serie + Folio                      reference
    Conceptos/Concepto@Descripcion     concept and description
    TimbreFiscalDigital@UUID           cfdi_uuid
    MetodoPago PUE / PPD               suggestion: paid / pending
    TipoDeComprobante E or P           warning: not an ordinary expense
"""

import re
from decimal import Decimal, InvalidOperation

from lxml import etree

MAX_BYTES = 2 * 1024 * 1024
CFDI_NAMESPACES = {
    "http://www.sat.gob.mx/cfd/3": "3.3",
    "http://www.sat.gob.mx/cfd/4": "4.0",
}
TFD = "http://www.sat.gob.mx/TimbreFiscalDigital"
UUID_RE = re.compile(r"\b([0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12})\b", re.IGNORECASE)
TYPES = {"I": "ingreso", "E": "egreso", "T": "traslado", "N": "nómina", "P": "pago"}


class NotCfdi(ValueError):
    """Not a CFDI (or not one this reader accepts)."""


def _parser():
    return etree.XMLParser(
        resolve_entities=False,
        no_network=True,
        load_dtd=False,
        dtd_validation=False,
        huge_tree=False,
        remove_comments=True,
        remove_pis=True,
    )


def parse(data: bytes) -> dict:
    """The CFDI's fields, or NotCfdi."""
    if not data or len(data) > MAX_BYTES:
        raise NotCfdi("The XML is empty or larger than 2 MB.")
    head = data[:4096].lower()
    if b"<!doctype" in head or b"<!entity" in data.lower():
        raise NotCfdi("XML with a DOCTYPE or entities is not accepted.")
    try:
        root = etree.fromstring(data, parser=_parser())
    except etree.XMLSyntaxError as error:
        raise NotCfdi(f"Invalid XML: {error}") from error
    namespace = etree.QName(root).namespace
    if etree.QName(root).localname != "Comprobante" or namespace not in CFDI_NAMESPACES:
        raise NotCfdi("The XML is not a CFDI 3.3 or 4.0.")
    ns = {"cfdi": namespace, "tfd": TFD}

    def first(path):
        found = root.find(path, ns)
        return found if found is not None else None

    issuer = first("cfdi:Emisor")
    receiver = first("cfdi:Receptor")
    stamp = root.find(".//tfd:TimbreFiscalDigital", ns)
    concepts = [
        {
            "description": (item.get("Descripcion") or "").strip(),
            "quantity": item.get("Cantidad"),
            "amount": item.get("Importe"),
        }
        for item in root.findall("cfdi:Conceptos/cfdi:Concepto", ns)
    ]
    taxes = first("cfdi:Impuestos")
    return {
        "version": CFDI_NAMESPACES[namespace],
        "uuid": (stamp.get("UUID") or "").upper() if stamp is not None else "",
        "stamped_at": stamp.get("FechaTimbrado") if stamp is not None else None,
        "type": root.get("TipoDeComprobante") or "",
        "date": (root.get("Fecha") or "")[:10],
        "series": root.get("Serie") or "",
        "folio": root.get("Folio") or "",
        "subtotal": root.get("SubTotal"),
        "discount": root.get("Descuento"),
        "total": root.get("Total"),
        "currency": (root.get("Moneda") or "MXN").upper(),
        "exchange_rate": root.get("TipoCambio"),
        "payment_method": root.get("MetodoPago") or "",
        "payment_form": root.get("FormaPago") or "",
        "issuer_name": (issuer.get("Nombre") or "").strip() if issuer is not None else "",
        "issuer_rfc": (issuer.get("Rfc") or "").upper() if issuer is not None else "",
        "receiver_name": (receiver.get("Nombre") or "").strip() if receiver is not None else "",
        "receiver_rfc": (receiver.get("Rfc") or "").upper() if receiver is not None else "",
        "taxes_transferred": taxes.get("TotalImpuestosTrasladados") if taxes is not None else None,
        "taxes_withheld": taxes.get("TotalImpuestosRetenidos") if taxes is not None else None,
        "concepts": concepts[:100],
    }


def _amount(value) -> str | None:
    try:
        return format(Decimal(str(value)).quantize(Decimal("0.01")), "f")
    except (InvalidOperation, TypeError, ValueError):
        return None


def to_expense(cfdi: dict) -> dict:
    """The import draft for an expense (same keys the receipt analysis fills),
    plus cfdi_uuid, the payment suggestion and the CFDI summary."""
    warnings = []
    kind = cfdi.get("type")
    if kind == "E":
        warnings.append("Es una nota de crédito (CFDI de egreso): no es un gasto normal.")
    elif kind == "P":
        warnings.append("Es un complemento de pago: registra el pago de otra factura, no un gasto nuevo.")
    elif kind in ("T", "N"):
        warnings.append(f"Es un CFDI de {TYPES[kind]}: revisa si corresponde a un gasto.")
    if not cfdi.get("uuid"):
        warnings.append("El XML no trae el timbre fiscal (UUID): puede no ser una factura válida.")
    currency = cfdi.get("currency") or "MXN"
    if currency == "XXX":
        currency = "MXN"
    if cfdi.get("exchange_rate") and currency != "MXN":
        warnings.append(f"Moneda {currency} con tipo de cambio {cfdi['exchange_rate']}.")
    concepts = [item["description"] for item in cfdi.get("concepts") or [] if item.get("description")]
    concept = concepts[0][:255] if concepts else ""
    if len(concepts) > 1:
        concept = f"{concepts[0][:200]} y {len(concepts) - 1} concepto(s) más"[:255]
    lines = [
        f"Emisor: {cfdi.get('issuer_name') or '—'} (RFC {cfdi.get('issuer_rfc') or '—'})",
        f"CFDI {cfdi.get('version')} · UUID {cfdi.get('uuid') or '—'}",
    ]
    if cfdi.get("subtotal"):
        lines.append(f"Subtotal {cfdi['subtotal']} · Impuestos trasladados {cfdi.get('taxes_transferred') or '0'}")
    if cfdi.get("taxes_withheld"):
        lines.append(f"Impuestos retenidos {cfdi['taxes_withheld']}")
    lines.extend(f"- {item}" for item in concepts[:20])
    reference = "".join(part for part in (cfdi.get("series"), cfdi.get("folio")) if part) or cfdi.get("uuid", "")
    return {
        "concept": concept,
        "vendor": (cfdi.get("issuer_name") or cfdi.get("issuer_rfc") or "")[:255],
        "amount": _amount(cfdi.get("total")),
        "currency": currency,
        "expense_date": cfdi.get("date") or None,
        "reference": reference[:255],
        "description": "\n".join(lines)[:5000],
        "tags": [],
        "warnings": warnings,
        "cfdi_uuid": cfdi.get("uuid") or "",
        "rfc": cfdi.get("issuer_rfc") or "",
        # PUE: paid in one go; PPD: paid later. The person decides (pending by default)
        "suggested_status": "PAID" if cfdi.get("payment_method") == "PUE" else "PENDING",
        "cfdi": {
            "version": cfdi.get("version"),
            "type": kind,
            "payment_method": cfdi.get("payment_method") or None,
            "receiver_rfc": cfdi.get("receiver_rfc") or None,
        },
    }


def uuid_in_text(text: str) -> str:
    """A fiscal folio printed on a PDF ("Folio fiscal: 1234…")."""
    match = UUID_RE.search(str(text or ""))
    return match.group(1).upper() if match else ""
