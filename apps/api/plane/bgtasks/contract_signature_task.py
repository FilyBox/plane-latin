# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Documenso signing work that must not run inside a web request: sending an
envelope, storing the signed PDF, and reconciling envelopes whose webhook was
lost. The logic lives in the contract workflow views; these are thin wrappers."""

from celery import shared_task

from plane.utils.exception_logger import log_exception


@shared_task
def send_signature_request(request_id):
    from plane.app.views.contract.workflow import run_signature_send

    run_signature_send(request_id)


@shared_task(bind=True, max_retries=3, default_retry_delay=60)
def complete_signature_request(self, request_id):
    from plane.app.views.contract.workflow import _complete_signature_request
    from plane.db.models import ContractSignatureRequest

    signature_request = ContractSignatureRequest.objects.filter(id=request_id).first()
    if not signature_request or signature_request.signed_asset_id or not signature_request.documenso_envelope_item_id:
        return
    try:
        _complete_signature_request(signature_request)
    except Exception as exc:
        log_exception(exc)
        # The reconcile job retries later too; status stays PENDING meanwhile.
        raise self.retry(exc=exc)


@shared_task
def reconcile_signature_requests():
    from plane.app.views.contract.workflow import reconcile_signature_requests as reconcile

    return reconcile()
