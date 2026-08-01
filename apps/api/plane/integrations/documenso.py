# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Small OSS-only Documenso API client used by the contract workflow.

This module deliberately does not use Documenso's embedded authoring routes.
Those routes are sold as an Enterprise feature. Plane owns the authoring UI
and calls the public envelope API, while Documenso remains authoritative for
distribution, recipient signing, sealing and the completion certificate.
"""

import json

import requests
from django.conf import settings


class DocumensoError(RuntimeError):
    def __init__(self, message, status_code=None, payload=None):
        super().__init__(message)
        self.status_code = status_code
        self.payload = payload


class DocumensoClient:
    def __init__(self):
        self.base_url = settings.DOCUMENSO_INTERNAL_URL.rstrip("/")
        self.api_token = settings.DOCUMENSO_API_TOKEN
        if not self.base_url or not self.api_token:
            raise DocumensoError("Documenso is not configured")

    @property
    def headers(self):
        return {"Authorization": f"Bearer {self.api_token}"}

    def _raise_for_status(self, response):
        if response.ok:
            return
        try:
            payload = response.json()
        except ValueError:
            payload = {"error": response.text[:1000]}
        message = payload.get("error") or payload.get("message") or "Documenso request failed"
        raise DocumensoError(message, status_code=response.status_code, payload=payload)

    def create_envelope(self, *, title, external_id, pdf_bytes, recipients, authoring_settings=None):
        settings = authoring_settings or {}
        meta = {
            key: settings[key]
            for key in (
                "subject",
                "message",
                "timezone",
                "dateFormat",
                "redirectUrl",
                "language",
                "distributionMethod",
                "signingOrder",
                "allowDictateNextSigner",
                "typedSignatureEnabled",
                "uploadSignatureEnabled",
                "drawSignatureEnabled",
                "emailSettings",
                "envelopeExpirationPeriod",
                "reminderSettings",
            )
            if key in settings
        }
        if settings.get("emailReplyTo"):
            meta["emailReplyTo"] = settings["emailReplyTo"]
        payload = {
            "type": "DOCUMENT",
            "title": title,
            "externalId": external_id,
            "recipients": recipients,
            "meta": meta,
        }
        response = requests.post(
            f"{self.base_url}/api/v2/envelope/create",
            headers=self.headers,
            data={"payload": json.dumps(payload)},
            files={"files": (f"{title}.pdf", pdf_bytes, "application/pdf")},
            timeout=120,
        )
        self._raise_for_status(response)
        envelope = response.json()

        # The create response is intentionally compact in recent Documenso
        # versions. Resolve the full envelope so we always capture item and
        # recipient IDs for signed download/status reconciliation.
        return self.get_envelope(envelope["id"])

    def get_envelope(self, envelope_id):
        response = requests.get(
            f"{self.base_url}/api/v2/envelope/{envelope_id}",
            headers=self.headers,
            timeout=30,
        )
        self._raise_for_status(response)
        return response.json()

    def distribute_envelope(self, envelope_id):
        response = requests.post(
            f"{self.base_url}/api/v2/envelope/distribute",
            headers={**self.headers, "Content-Type": "application/json"},
            json={"envelopeId": envelope_id},
            timeout=60,
        )
        self._raise_for_status(response)
        return response.json()

    def download_signed_item(self, envelope_item_id):
        response = requests.get(
            f"{self.base_url}/api/v2/envelope/item/{envelope_item_id}/download",
            headers=self.headers,
            params={"version": "signed"},
            timeout=120,
        )
        self._raise_for_status(response)
        return response.content
