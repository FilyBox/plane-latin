# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

import logging

from celery import shared_task
from django.conf import settings
from django.core.mail import EmailMultiAlternatives, get_connection
from django.template.loader import render_to_string
from django.utils import timezone
from django.utils.html import strip_tags

from plane.license.utils.instance_value import get_email_configuration
from plane.utils.exception_logger import log_exception

logger = logging.getLogger(__name__)


@shared_task
def send_deep_review_email(review_id):
    """Emails a finished deep review to whoever launched it (same SMTP setup
    as the contract query email)."""
    from plane.db.models import AssistantDeepReview
    from plane.utils.deep_review import result_rows

    review = AssistantDeepReview.objects.select_related("user", "workspace").filter(id=review_id).first()
    if review is None or review.emailed_at is not None or not review.user.email:
        return

    try:
        (
            EMAIL_HOST,
            EMAIL_HOST_USER,
            EMAIL_HOST_PASSWORD,
            EMAIL_PORT,
            EMAIL_USE_TLS,
            EMAIL_USE_SSL,
            EMAIL_FROM,
        ) = get_email_configuration()

        origin = (settings.WEB_URL or settings.APP_BASE_URL or "").rstrip("/")
        rows = result_rows(review)
        for row in rows:
            row["url"] = f"{origin}/{review.workspace.slug}/file-library/contracts/analyzed/?peek={row['contract_id']}"
            row["artists_text"] = ", ".join(row["artists"]) if row["artists"] else ""
        context = {
            "title": review.title,
            "question": review.question,
            "summary": review.summary,
            "matches": rows,
            "read_count": review.done_count,
            "total_count": review.total_count,
            "partial": review.status == AssistantDeepReview.Status.PARTIAL,
            "spent": f"${review.spent_usd:.2f}",
            "workspace_name": review.workspace.name,
        }
        html_content = render_to_string("emails/assistant_deep_review_result.html", context)
        connection = get_connection(
            host=EMAIL_HOST,
            port=int(EMAIL_PORT),
            username=EMAIL_HOST_USER,
            password=EMAIL_HOST_PASSWORD,
            use_tls=EMAIL_USE_TLS == "1",
            use_ssl=EMAIL_USE_SSL == "1",
        )
        msg = EmailMultiAlternatives(
            subject=f"Revisión de contratos terminada: {review.title or review.workspace.name}",
            body=strip_tags(html_content),
            from_email=EMAIL_FROM,
            to=[review.user.email],
            connection=connection,
        )
        msg.attach_alternative(html_content, "text/html")
        msg.send()
        AssistantDeepReview.objects.filter(id=review.id).update(emailed_at=timezone.now())
        logger.info("Deep review email sent to %s", review.user.email)
    except Exception as e:
        log_exception(e)
