# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""
Collabora Online integration — WOPI host.

Collabora does not fetch documents from S3. It calls *us* over the WOPI
protocol, so this module exposes the three endpoints it expects:

    GET  /wopi/files/<asset_id>            -> CheckFileInfo  (metadata)
    GET  /wopi/files/<asset_id>/contents   -> GetFile        (bytes out)
    POST /wopi/files/<asset_id>/contents   -> PutFile        (bytes in, the save)

Plus one endpoint the browser calls to obtain the iframe URL.

Auth: Collabora is a server, not a logged-in user, so these endpoints do not
use session auth. Every call carries an `access_token` we minted ourselves —
short-lived, signed, and scoped to one asset and one user.
"""

import hashlib
import io
from datetime import datetime, timedelta, timezone
from urllib.parse import quote, urlsplit, urlunsplit
from xml.etree import ElementTree

import jwt
import requests
from django.conf import settings
from django.db.models import Q
from django.utils import timezone as django_timezone
from rest_framework import status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response

from plane.app.permissions import ROLE, allow_permission
from plane.db.models import (
    ContractSignatureRequest,
    ContractTemplateRevision,
    ContractTemplateVariant,
    FileAsset,
    User,
    WopiDocumentLock,
    Workspace,
)
from plane.settings.storage import S3Storage
from plane.utils.contract_access import can_view_contracts, is_contract_file
from plane.utils.exception_logger import log_exception

from ..base import BaseAPIView

# How long the editing session token stays valid. Collabora refreshes the
# document on its own; if a session outlives this the user re-opens the file.
TOKEN_TTL_SECONDS = 60 * 60 * 4
LOCK_TTL_SECONDS = 60 * 30

DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

# Formats Collabora can open for editing. Anything else is view-only.
EDITABLE_EXTENSIONS = {".docx", ".xlsx", ".pptx", ".odt", ".ods", ".odp"}

# Frozen contract files: versions, rendered/unsigned and signed copies.
READ_ONLY_ENTITY_TYPES = {
    FileAsset.EntityTypeContext.CONTRACT_REVISION,
    FileAsset.EntityTypeContext.CONTRACT_UNSIGNED,
    FileAsset.EntityTypeContext.CONTRACT_SIGNED,
    FileAsset.EntityTypeContext.CONTRACT_THUMBNAIL,
}
CONTRACT_DRAFT_PREFIX = "contract-draft:"


def _collabora_base() -> str:
    """Where the *browser* loads the editor from, e.g. http://localhost:9980"""
    return (getattr(settings, "COLLABORA_URL", "") or "").rstrip("/")


def _collabora_internal_base() -> str:
    """Where the *backend* reaches Collabora, e.g. http://collabora:9980.

    Not the same address as above: inside Docker the browser cannot resolve
    the `collabora` service name, and the API container cannot reach the
    editor on localhost. In production both collapse to one public domain.
    """
    return (getattr(settings, "COLLABORA_INTERNAL_URL", "") or "").rstrip("/")


def mint_access_token(
    asset_id: str, user_id: str, can_write: bool, mode: str | None = None, origin: str | None = None
) -> str:
    """Signed, short-lived, scoped to exactly one asset + one user."""
    mode = mode or ("write" if can_write else "read")
    return jwt.encode(
        {
            "asset_id": str(asset_id),
            "user_id": str(user_id),
            "can_write": mode == "write",
            "mode": mode,
            "origin": origin or "",
            "exp": datetime.now(timezone.utc) + timedelta(seconds=TOKEN_TTL_SECONDS),
        },
        settings.SECRET_KEY,
        algorithm="HS256",
    )


def token_can_write(claims: dict) -> bool:
    # Tokens minted before "mode" existed only carry can_write.
    mode = claims.get("mode")
    if mode:
        return mode == "write"
    return bool(claims.get("can_write"))


def content_modified_at(asset: FileAsset) -> str:
    """When the bytes last changed. Kept apart from updated_at so metadata
    writes (PDF cache, renames) do not look like a conflicting save."""
    return (asset.attributes or {}).get("content_modified_at") or asset.updated_at.isoformat()


def same_timestamp(left: str, right: str) -> bool:
    if left == right:
        return True
    try:
        return datetime.fromisoformat(left.replace("Z", "+00:00")) == datetime.fromisoformat(
            right.replace("Z", "+00:00")
        )
    except (TypeError, ValueError):
        return False


def mark_content_changed(asset: FileAsset, content: bytes) -> str:
    """Record a content write on the asset row; returns the new timestamp."""
    stamp = django_timezone.now().isoformat()
    asset.size = len(content)
    asset.attributes = {
        **(asset.attributes or {}),
        "content_modified_at": stamp,
        "content_sha256": hashlib.sha256(content).hexdigest(),
    }
    asset.save(update_fields=["size", "attributes", "updated_at"])
    return stamp


def _is_contract_asset(asset: FileAsset) -> bool:
    return str(asset.entity_type or "").startswith("CONTRACT_")


def user_friendly_name(user_id) -> str:
    user = User.objects.filter(id=user_id).only("display_name", "first_name", "last_name", "email").first()
    if not user:
        return ""
    full_name = f"{user.first_name or ''} {user.last_name or ''}".strip()
    return full_name or user.display_name or (user.email or "").split("@")[0]


def session_mode_for(asset: FileAsset, user) -> str:
    """Write mode only for editable files the user may change. Frozen contract
    files (versions, rendered, signed) always open read-only."""
    name = (asset.attributes or {}).get("name", "")
    extension = ("." + name.rsplit(".", 1)[-1].lower()) if "." in name else ""
    if extension not in EDITABLE_EXTENSIONS:
        return "read"
    if asset.entity_type in READ_ONLY_ENTITY_TYPES:
        return "read"
    if str(asset.entity_identifier or "").startswith(CONTRACT_DRAFT_PREFIX):
        # A draft is written only by the user currently holding it.
        holders = ContractTemplateVariant.objects.filter(draft_asset=asset).values_list("draft_active_by_id", flat=True)
        return "write" if user.id in list(holders) else "read"
    frozen = (
        ContractTemplateRevision.objects.filter(Q(source_asset=asset) | Q(pdf_asset=asset)).exists()
        or ContractSignatureRequest.objects.filter(
            Q(signed_asset=asset) | Q(rendered_source_asset=asset) | Q(rendered_pdf_asset=asset)
        ).exists()
    )
    return "read" if frozen else "write"


def _allowed_origins() -> set:
    values = [getattr(settings, "APP_BASE_URL", None), getattr(settings, "WEB_URL", None)]
    values += list(getattr(settings, "CORS_ALLOWED_ORIGINS", None) or [])
    return {str(value).rstrip("/") for value in values if value}


def request_origin(request) -> str | None:
    """The web app's origin, so Collabora can postMessage back to it. Only
    origins the API already trusts (CORS list, APP_BASE_URL, WEB_URL)."""
    origin = request.headers.get("Origin") or ""
    if not origin:
        referer = urlsplit(request.headers.get("Referer") or "")
        origin = f"{referer.scheme}://{referer.netloc}" if referer.scheme and referer.netloc else ""
    origin = origin.rstrip("/")
    return origin if origin and origin in _allowed_origins() else None


def post_message_origin(claims: dict) -> str:
    return claims.get("origin") or settings.APP_BASE_URL or settings.WEB_URL


def build_editor_session(asset: FileAsset, user, mode: str, origin: str | None = None):
    """-> (payload, None) or (None, (error, http_status)). Shared by the
    file-library session and contract template drafts."""
    if not _collabora_base():
        return None, ("Collabora is not configured", status.HTTP_501_NOT_IMPLEMENTED)
    name = (asset.attributes or {}).get("name", "")
    extension = ("." + name.rsplit(".", 1)[-1].lower()) if "." in name else ""
    # The editor URL (with its build hash) comes from Collabora's discovery,
    # never hardcoded — the hash changes on every release.
    editor_base = editor_url_for(extension)
    if not editor_base:
        return None, ("Collabora has no editor for this file type", status.HTTP_422_UNPROCESSABLE_ENTITY)
    # WOPISrc must be an address Collabora itself can reach. Inside Docker
    # that is the API container's hostname, not localhost.
    api_base = (getattr(settings, "WOPI_HOST_URL", "") or settings.WEB_URL).rstrip("/")
    wopi_src = f"{api_base}/wopi/files/{asset.id}"
    # discovery's urlsrc ends in "?" or "&"; the frontend appends
    # WOPISrc=<encoded> and posts access_token as a form field.
    separator = "" if editor_base.endswith(("?", "&")) else "?"
    expires = datetime.now(timezone.utc) + timedelta(seconds=TOKEN_TTL_SECONDS)
    return (
        {
            "editor_url": f"{editor_base}{separator}WOPISrc={quote(wopi_src, safe='')}",
            "wopi_src": wopi_src,
            "access_token": mint_access_token(asset.id, user.id, mode == "write", mode=mode, origin=origin),
            # WOPI form field: token expiry in ms since the epoch.
            "access_token_ttl": int(expires.timestamp() * 1000),
            "can_write": mode == "write",
            "mode": mode,
            "asset_id": str(asset.id),
        },
        None,
    )


def editor_url_for(extension: str) -> str | None:
    """Ask Collabora which editor URL handles this file type.

    The path carries a build hash (…/browser/<hash>/cool.html) that changes
    with every Collabora release, so it must be read from /hosting/discovery
    rather than hardcoded.

    We fetch discovery over the *internal* address (the API container cannot
    reach the browser-facing localhost port), so Collabora fills urlsrc with
    that internal host. We keep the path — hash and all — but swap the origin
    back to the browser-facing base, which is the address the user's browser
    actually loads.
    """
    internal = _collabora_internal_base() or _collabora_base()
    public = _collabora_base() or internal
    if not internal:
        return None
    try:
        xml = requests.get(f"{internal}/hosting/discovery", timeout=10).content
        root = ElementTree.fromstring(xml)
    except (requests.RequestException, ElementTree.ParseError) as e:
        log_exception(e)
        return None

    # Match by extension first, then fall back to the writer default.
    fallback = None
    for action in root.iter("action"):
        urlsrc = action.get("urlsrc")
        if not urlsrc:
            continue
        if action.get("ext") == extension.lstrip("."):
            return _rehost(urlsrc, public)
        if fallback is None and action.get("default") == "true":
            fallback = urlsrc
    return _rehost(fallback, public) if fallback else None


def _rehost(url: str, base: str) -> str:
    """Replace the scheme+host of `url` with those of `base`, keeping the path
    and query (which is where the build hash lives)."""
    target = urlsplit(base)
    parts = urlsplit(url)
    return urlunsplit((target.scheme, target.netloc, parts.path, parts.query, parts.fragment))


def read_access_token(token: str, asset_id: str) -> dict | None:
    """Returns the claims, or None if the token is invalid, expired, or for
    a *different* asset — that last check is what stops a valid token for one
    document from being replayed against another."""
    try:
        claims = jwt.decode(token, settings.SECRET_KEY, algorithms=["HS256"])
    except jwt.PyJWTError:
        return None
    if claims.get("asset_id") != str(asset_id):
        return None
    return claims


class WopiBaseView(BaseAPIView):
    """Shared plumbing. Collabora authenticates with the access_token query
    parameter, never with a session cookie."""

    permission_classes = [AllowAny]
    authentication_classes = []

    def resolve(self, request, asset_id):
        """-> (asset, claims) or (None, None) when the caller isn't allowed."""
        token = request.GET.get("access_token", "")
        claims = read_access_token(token, asset_id)
        if not claims:
            return None, None
        asset = FileAsset.objects.filter(id=asset_id, is_uploaded=True, deleted_at__isnull=True).first()
        if not asset:
            return None, None
        return asset, claims


class WopiCheckFileInfoEndpoint(WopiBaseView):
    """Collabora asks this first: what is this file, and may I edit it?"""

    def get(self, request, asset_id):
        asset, claims = self.resolve(request, asset_id)
        if not asset:
            return Response({"error": "Unauthorized"}, status=status.HTTP_401_UNAUTHORIZED)

        modified = content_modified_at(asset)
        can_write = token_can_write(claims)
        return Response(
            {
                "BaseFileName": asset.attributes.get("name", "document.docx"),
                "Size": int(asset.size or 0),
                "OwnerId": str(asset.created_by_id),
                "UserId": claims["user_id"],
                "UserFriendlyName": user_friendly_name(claims["user_id"]),
                "UserCanWrite": can_write,
                "ReadOnly": not can_write,
                "UserCanNotWriteRelative": True,
                # The version string must change whenever the bytes change, or
                # Collabora will serve a stale copy from its own cache.
                "Version": modified,
                "LastModifiedTime": modified,
                "PostMessageOrigin": post_message_origin(claims),
                "SupportsLocks": True,
                "SupportsGetLock": True,
                "SupportsUpdate": True,
            }
        )

    def post(self, request, asset_id):
        asset, claims = self.resolve(request, asset_id)
        if not asset:
            return Response({"error": "Unauthorized"}, status=status.HTTP_401_UNAUTHORIZED)
        if not token_can_write(claims):
            return Response({"error": "Read only"}, status=status.HTTP_403_FORBIDDEN)

        override = request.headers.get("X-WOPI-Override", "").upper()
        supplied_lock = request.headers.get("X-WOPI-Lock", "")
        now = django_timezone.now()
        existing = WopiDocumentLock.objects.filter(asset=asset).first()
        if existing and existing.expires_at <= now:
            existing.delete(soft=False)
            existing = None

        conflict_headers = {"X-WOPI-Lock": existing.lock_id if existing else ""}
        if override == "GET_LOCK":
            return Response(status=status.HTTP_200_OK, headers=conflict_headers)
        if override == "LOCK":
            if not supplied_lock:
                return Response({"error": "Missing lock"}, status=status.HTTP_400_BAD_REQUEST)
            if existing and existing.lock_id != supplied_lock:
                return Response(
                    {"error": "Lock mismatch"},
                    status=status.HTTP_409_CONFLICT,
                    headers=conflict_headers,
                )
            WopiDocumentLock.objects.update_or_create(
                asset=asset,
                defaults={
                    "lock_id": supplied_lock,
                    "owner_user_id": claims["user_id"],
                    "expires_at": now + timedelta(seconds=LOCK_TTL_SECONDS),
                },
            )
            return Response(status=status.HTTP_200_OK)
        if override == "REFRESH_LOCK":
            if not existing or existing.lock_id != supplied_lock:
                return Response(
                    {"error": "Lock mismatch"},
                    status=status.HTTP_409_CONFLICT,
                    headers=conflict_headers,
                )
            existing.expires_at = now + timedelta(seconds=LOCK_TTL_SECONDS)
            existing.save(update_fields=["expires_at", "updated_at"])
            return Response(status=status.HTTP_200_OK)
        if override == "UNLOCK":
            if not existing or existing.lock_id != supplied_lock:
                return Response(
                    {"error": "Lock mismatch"},
                    status=status.HTTP_409_CONFLICT,
                    headers=conflict_headers,
                )
            existing.delete(soft=False)
            return Response(status=status.HTTP_200_OK)
        return Response({"error": "Unsupported WOPI operation"}, status=status.HTTP_501_NOT_IMPLEMENTED)


class WopiFileContentsEndpoint(WopiBaseView):
    """GET streams the document out; POST is the save."""

    def get(self, request, asset_id):
        asset, _ = self.resolve(request, asset_id)
        if not asset:
            return Response({"error": "Unauthorized"}, status=status.HTTP_401_UNAUTHORIZED)

        storage = S3Storage.for_asset(asset, request=request)
        try:
            obj = storage.s3_client.get_object(
                Bucket=storage.aws_storage_bucket_name,
                Key=asset.asset.name,
            )
        except Exception as e:
            log_exception(e)
            return Response({"error": "Unable to read file"}, status=status.HTTP_502_BAD_GATEWAY)

        from django.http import HttpResponse

        return HttpResponse(obj["Body"].read(), content_type="application/octet-stream")

    def post(self, request, asset_id):
        asset, claims = self.resolve(request, asset_id)
        if not asset:
            return Response({"error": "Unauthorized"}, status=status.HTTP_401_UNAUTHORIZED)
        if not token_can_write(claims):
            # A read token can never save, whatever asset it names.
            return Response({"error": "Read only"}, status=status.HTTP_401_UNAUTHORIZED)

        existing_lock = WopiDocumentLock.objects.filter(
            asset=asset,
            expires_at__gt=django_timezone.now(),
        ).first()
        supplied_lock = request.headers.get("X-WOPI-Lock", "")
        if existing_lock and existing_lock.lock_id != supplied_lock:
            return Response(
                {"error": "Lock mismatch"},
                status=status.HTTP_409_CONFLICT,
                headers={"X-WOPI-Lock": existing_lock.lock_id},
            )

        # A late save from an older session must not overwrite newer bytes.
        supplied_timestamp = request.headers.get("X-COOL-WOPI-Timestamp", "")
        if supplied_timestamp and not same_timestamp(supplied_timestamp, content_modified_at(asset)):
            return Response({"COOLStatusCode": 1010}, status=status.HTTP_409_CONFLICT)

        body = request.body
        if not body:
            # Collabora occasionally probes with an empty body; treat as no-op
            # rather than truncating a real document to zero bytes.
            return Response({"status": "ok", "LastModifiedTime": content_modified_at(asset)})

        storage = S3Storage.for_asset(asset, request=request)
        uploaded = storage.upload_file(
            file_obj=io.BytesIO(body),
            object_name=asset.asset.name,
            content_type=asset.attributes.get("type", DOCX_MIME),
        )
        if not uploaded:
            # A non-200 makes Collabora keep the edits in the browser and retry,
            # which is exactly what we want — nothing is lost.
            return Response({"error": "Upload failed"}, status=status.HTTP_502_BAD_GATEWAY)

        modified = mark_content_changed(asset, body)

        if _is_contract_asset(asset):
            # Contract files get their PDFs from the content-hash cache.
            ContractTemplateVariant.objects.filter(draft_asset=asset).update(draft_updated_at=django_timezone.now())
        else:
            # The .docx is now saved and authoritative. The PDF is a derived copy,
            # regenerated from it — queued so a slow conversion never makes
            # Collabora time out and retry this save.
            from plane.bgtasks.collabora_task import regenerate_pdf

            regenerate_pdf.delay(str(asset.id))

        return Response({"status": "ok", "LastModifiedTime": modified})


class CollaboraSessionEndpoint(BaseAPIView):
    """Called by the browser. Returns everything the iframe needs."""

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def get(self, request, slug, asset_id):
        if not _collabora_base():
            return Response(
                {"error": "Collabora is not configured"},
                status=status.HTTP_501_NOT_IMPLEMENTED,
            )

        workspace = Workspace.objects.get(slug=slug)
        asset = FileAsset.objects.filter(
            id=asset_id,
            workspace=workspace,
            is_uploaded=True,
            deleted_at__isnull=True,
        ).first()
        if not asset or (is_contract_file(asset) and not can_view_contracts(request.user, slug=slug)):
            return Response({"error": "File not found"}, status=status.HTTP_404_NOT_FOUND)

        payload, error = build_editor_session(
            asset, request.user, session_mode_for(asset, request.user), origin=request_origin(request)
        )
        if error:
            return Response({"error": error[0]}, status=error[1])
        return Response(payload)


class CollaboraPdfEndpoint(BaseAPIView):
    """Link to the derived PDF, for anyone who only needs to read it."""

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def get(self, request, slug, asset_id):
        asset = FileAsset.objects.filter(
            id=asset_id,
            workspace__slug=slug,
            deleted_at__isnull=True,
        ).first()
        if not asset or (is_contract_file(asset) and not can_view_contracts(request.user, slug=slug)):
            return Response({"error": "File not found"}, status=status.HTTP_404_NOT_FOUND)

        pdf_key = asset.attributes.get("pdf_key")
        if not pdf_key:
            # Either the document was never saved through the editor, or the
            # last conversion failed and is waiting on the next save.
            return Response({"error": "No PDF yet"}, status=status.HTTP_404_NOT_FOUND)

        storage = S3Storage.for_asset(asset, request=request)
        name = asset.attributes.get("name", "document")
        return Response(
            {
                "url": storage.generate_presigned_url(
                    object_name=pdf_key,
                    filename=f"{name.rsplit('.', 1)[0]}.pdf",
                ),
                # Lets the UI warn when the PDF predates the last edit
                "generated_at": asset.attributes.get("pdf_generated_at"),
            }
        )


def convert_to_pdf(document_bytes: bytes, filename: str) -> bytes | None:
    """Ask Collabora to render a PDF. Unlike OnlyOffice this is synchronous —
    the converted bytes come straight back in the response body."""
    base = _collabora_internal_base()
    if not base:
        return None
    try:
        response = requests.post(
            f"{base}/cool/convert-to/pdf",
            files={"data": (filename, document_bytes)},
            timeout=120,
        )
        response.raise_for_status()
        return response.content
    except requests.RequestException as e:
        log_exception(e)
        return None
