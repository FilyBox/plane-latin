# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Contract <-> music works links: the contract panel, the song/release
panels, and the internal endpoints the Worker (analysis and assistant) calls.

Contract-side endpoints follow the contracts module (workspace admins only);
anything that picks or creates catalog items also needs music
access (module on and workspace admin), as the music endpoints do.
"""

import uuid

from django.core.exceptions import ValidationError
from django.db import transaction
from django.utils import timezone
from rest_framework import status
from rest_framework.response import Response

from plane.app.permissions import ROLE, allow_permission
from plane.db.models import Contract, ContractWorkLink, MusicRelease, MusicTrack, User, Workspace, WorkspaceFeature
from plane.utils.contract_works import (
    ENTITY_TYPES,
    RELEASE,
    RIGHTS_TYPES,
    TRACK,
    Source,
    Status,
    clean_work,
    contract_card,
    contract_links_payload,
    create_catalog_entity,
    entity_contracts_payload,
    entity_exists,
    has_music_access,
    link_entity,
    link_order,
    live_links,
    match_works,
    record_suggestions,
    work_key,
)
from plane.utils.entities import AccessContext
from plane.utils.workspace_feature import is_workspace_feature_enabled

from ..file_library.base import FileLibraryBaseView
from ..music.base import MusicBaseView
from .base import live_contracts
from .internal import InternalBaseView

MAX_ITEMS = 200


def _bad(message):
    return Response({"error": message}, status=status.HTTP_400_BAD_REQUEST)


def _no_music():
    return Response(
        {"error": "Only workspace admins with the music catalog enabled can pick or add catalog items"},
        status=status.HTTP_403_FORBIDDEN,
    )


def _rights(value):
    """(ok, value): "" and None clear the rights type."""
    if value in (None, ""):
        return True, None
    value = str(value).upper()
    return (value in RIGHTS_TYPES), value


def _contract(slug, contract_id):
    return live_contracts().defer("extracted_text").filter(id=contract_id, workspace__slug=slug).first()


def _links_for(contract, ctx, include_dismissed=False):
    links = live_links(ContractWorkLink.objects.filter(contract_id=contract.id))
    if not include_dismissed:
        links = links.exclude(status=Status.DISMISSED)
    return contract_links_payload(link_order(links), ctx)


def _payload_for(links, ctx):
    ids = [link.id for link in links]
    rows = {row["id"]: row for row in contract_links_payload(ContractWorkLink.objects.filter(id__in=ids), ctx)}
    return [rows[str(link_id)] for link_id in ids if str(link_id) in rows]


def _link_items(contract, items, source, user):
    """Validates and links [{entity_type, entity_id, rights_type?}]."""
    if not isinstance(items, list) or len(items) > MAX_ITEMS:
        return None, f"items must be a list (max {MAX_ITEMS})"
    links = []
    for item in items:
        if not isinstance(item, dict):
            return None, "each item must be an object"
        entity_type, entity_id = item.get("entity_type"), item.get("entity_id")
        ok, rights = _rights(item.get("rights_type"))
        if entity_type not in ENTITY_TYPES or not ok:
            return None, "entity_type must be music_track or music_release, rights_type one of the known types"
        if not entity_exists(contract.workspace_id, entity_type, entity_id):
            return None, f"{entity_type} {entity_id} not found"
    for item in items:
        work = clean_work(item.get("work")) if isinstance(item.get("work"), dict) else None
        links.append(
            link_entity(
                contract,
                item["entity_type"],
                str(item["entity_id"]),
                source=source,
                user=user,
                rights_type=_rights(item.get("rights_type"))[1],
                work=work,
            )
        )
    return links, None


def _create_items(contract, items, source, user):
    """[{title, artists?, isrc?, upc?, kind?, version?, release_id?, rights_type?, link_id?}]
    -> catalog items (DRAFT) + LINKED links."""
    if not isinstance(items, list) or len(items) > MAX_ITEMS:
        return None, f"create must be a list (max {MAX_ITEMS})"
    for item in items:
        if not isinstance(item, dict) or not str(item.get("title") or "").strip():
            return None, "each item to create needs a title"
        if not _rights(item.get("rights_type"))[0]:
            return None, "unknown rights_type"
        release_id = item.get("release_id")
        if release_id and not entity_exists(contract.workspace_id, RELEASE.value, release_id):
            return None, f"release {release_id} not found"
    links = []
    for item in items:
        link = None
        if item.get("link_id"):
            link = ContractWorkLink.objects.filter(
                id=item["link_id"], contract_id=contract.id, entity_id__isnull=True
            ).first()
        links.append(_create_for(contract, item, source, user, link=link))
    return links, None


def _create_for(contract, data, source, user, link=None):
    """Adds the work to the catalog and links it. `link` is the pending
    suggestion being resolved, when there is one."""
    suggested = (link.suggested if link else {}) or {}
    kind = "release" if (data.get("kind") or suggested.get("kind")) == "release" else "track"
    if link is not None and link.entity_type == RELEASE:
        kind = "release"
    work = clean_work(
        {
            "title": data.get("title") or suggested.get("title"),
            "artists": data.get("artists") if data.get("artists") is not None else suggested.get("artists"),
            "isrc": data.get("isrc") or suggested.get("isrc"),
            "upc": data.get("upc") or suggested.get("upc"),
            "version": data.get("version") or suggested.get("version"),
            "kind": kind,
        }
    )
    entity_type, entity, created = create_catalog_entity(
        contract.workspace,
        kind=kind,
        title=work["title"],
        artists=work["artists"],
        isrc=work["isrc"],
        upc=work["upc"],
        version=work["version"],
        release_id=data.get("release_id") if kind == "track" else None,
    )
    rights = _rights(data.get("rights_type"))[1]
    if link is None:
        # Resolve the matching AI suggestion if the analysis saved one
        key = work_key(work["title"], kind)
        link = (
            ContractWorkLink.objects.filter(
                contract_id=contract.id, entity_id__isnull=True, status=Status.SUGGESTED, suggested__key=key
            ).first()
            if key
            else None
        )
    existing = ContractWorkLink.objects.filter(
        contract_id=contract.id, entity_type=entity_type, entity_id=entity.id
    ).first()
    if existing is not None and link is not None and existing.id != link.id:
        # The work was already linked under that catalog item: keep one row
        link.delete(soft=False)
        link = None
    if link is None:
        return link_entity(contract, entity_type, str(entity.id), source=source, user=user, rights_type=rights, work=work)
    link.entity_type, link.entity_id = entity_type, entity.id
    link.status = Status.LINKED
    link.suggested = {**suggested, "created_in_catalog": created}
    if rights:
        link.rights_type = rights
    link.decided_by = user
    link.decided_at = timezone.now()
    link.save()
    return link


# ---------------------------------------------------------------- web: contract side


class ContractWorksEndpoint(FileLibraryBaseView):
    """GET the works of a contract; POST {items: [{entity_type, entity_id, rights_type?}]} links them."""

    model = ContractWorkLink

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def get(self, request, slug, contract_id):
        contract = _contract(slug, contract_id)
        if contract is None:
            return Response({"error": "Contract not found"}, status=status.HTTP_404_NOT_FOUND)
        ctx = AccessContext.build(slug, request.user)
        include_all = request.query_params.get("all") in ("1", "true")
        return Response({"links": _links_for(contract, ctx, include_all)}, status=status.HTTP_200_OK)

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def post(self, request, slug, contract_id):
        contract = _contract(slug, contract_id)
        if contract is None:
            return Response({"error": "Contract not found"}, status=status.HTTP_404_NOT_FOUND)
        ctx = AccessContext.build(slug, request.user)
        if not has_music_access(ctx):
            return _no_music()
        with transaction.atomic():
            links, error = _link_items(contract, request.data.get("items"), Source.MANUAL, request.user)
            if error:
                transaction.set_rollback(True)
                return _bad(error)
        return Response({"links": _payload_for(links, ctx)}, status=status.HTTP_200_OK)


class ContractWorksApplyEndpoint(FileLibraryBaseView):
    """The assistant card's apply: {link: [...], create: [...]} in one go.

    `link` items: {entity_type, entity_id, rights_type?, work?}.
    `create` items: {title, artists?, isrc?, upc?, kind?, version?, release_id?, rights_type?, link_id?}.
    """

    model = ContractWorkLink

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def post(self, request, slug, contract_id):
        contract = _contract(slug, contract_id)
        if contract is None:
            return Response({"error": "Contract not found"}, status=status.HTTP_404_NOT_FOUND)
        ctx = AccessContext.build(slug, request.user)
        if not has_music_access(ctx):
            return _no_music()
        source = Source.MANUAL if request.data.get("source") == Source.MANUAL else Source.ASSISTANT
        with transaction.atomic():
            linked, error = _link_items(contract, request.data.get("link") or [], source, request.user)
            if not error:
                created, error = _create_items(contract, request.data.get("create") or [], source, request.user)
            if error:
                transaction.set_rollback(True)
                return _bad(error)
        return Response(
            {"links": _payload_for([*linked, *created], ctx), "linked": len(linked), "created": len(created)},
            status=status.HTTP_200_OK,
        )


class ContractWorkLinkDetailEndpoint(FileLibraryBaseView):
    """PATCH {status?: LINKED|DISMISSED, rights_type?, entity_type?, entity_id?}; DELETE removes the link."""

    model = ContractWorkLink

    def _link(self, slug, link_id):
        return (
            ContractWorkLink.objects.filter(
                id=link_id, workspace__slug=slug, contract__file_asset__is_deleted=False
            )
            .select_related("contract")
            .first()
        )

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def patch(self, request, slug, link_id):
        link = self._link(slug, link_id)
        if link is None:
            return Response({"error": "Link not found"}, status=status.HTTP_404_NOT_FOUND)
        ctx = AccessContext.build(slug, request.user)
        data = request.data if isinstance(request.data, dict) else {}

        new_status = data.get("status")
        if new_status is not None and new_status not in (Status.LINKED, Status.DISMISSED):
            return _bad("status must be LINKED or DISMISSED")
        if "rights_type" in data:
            ok, rights = _rights(data.get("rights_type"))
            if not ok:
                return _bad("unknown rights_type")
            link.rights_type = rights

        # Pointing a suggestion at a catalog item picked by hand
        if data.get("entity_id"):
            if not has_music_access(ctx):
                return _no_music()
            entity_type = data.get("entity_type") or link.entity_type
            if entity_type not in ENTITY_TYPES or not entity_exists(link.workspace_id, entity_type, data["entity_id"]):
                return _bad("entity not found")
            other = (
                ContractWorkLink.objects.filter(
                    contract_id=link.contract_id, entity_type=entity_type, entity_id=data["entity_id"]
                )
                .exclude(id=link.id)
                .first()
            )
            with transaction.atomic():
                if other is not None:
                    # Already there under that item: keep that row
                    if not other.evidence and link.evidence:
                        other.evidence = link.evidence
                    if link.rights_type and not other.rights_type:
                        other.rights_type = link.rights_type
                    link.delete(soft=False)
                    link = other
                else:
                    link.entity_type, link.entity_id = entity_type, data["entity_id"]
                if new_status is None:
                    new_status = Status.LINKED

        if new_status is not None:
            if new_status == Status.LINKED and not link.entity_id:
                return _bad("This work is not in the catalog yet: add it to the catalog or pick an existing item")
            link.status = new_status
            link.decided_by = request.user
            link.decided_at = timezone.now()
        link.save()
        return Response(contract_links_payload([link], ctx)[0], status=status.HTTP_200_OK)

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def delete(self, request, slug, link_id):
        link = self._link(slug, link_id)
        if link is None:
            return Response({"error": "Link not found"}, status=status.HTTP_404_NOT_FOUND)
        ContractWorkLink.objects.filter(id=link.id).update(deleted_at=timezone.now())
        return Response(status=status.HTTP_204_NO_CONTENT)


class ContractWorkLinkCreateInCatalogEndpoint(FileLibraryBaseView):
    """POST {title?, artists?, isrc?, upc?, version?, release_id?, rights_type?}: adds a
    suggested work to the catalog as DRAFT and links it."""

    model = ContractWorkLink

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def post(self, request, slug, link_id):
        link = (
            ContractWorkLink.objects.filter(id=link_id, workspace__slug=slug, contract__file_asset__is_deleted=False)
            .select_related("contract__workspace")
            .first()
        )
        if link is None:
            return Response({"error": "Link not found"}, status=status.HTTP_404_NOT_FOUND)
        ctx = AccessContext.build(slug, request.user)
        if not has_music_access(ctx):
            return _no_music()
        if link.entity_id:
            return _bad("This work is already in the catalog")
        data = request.data if isinstance(request.data, dict) else {}
        if not str(data.get("title") or (link.suggested or {}).get("title") or "").strip():
            return _bad("title is required")
        if not _rights(data.get("rights_type"))[0]:
            return _bad("unknown rights_type")
        release_id = data.get("release_id")
        if release_id and not entity_exists(link.workspace_id, RELEASE.value, release_id):
            return _bad("release not found")
        with transaction.atomic():
            link = _create_for(link.contract, data, link.source, request.user, link=link)
        return Response(contract_links_payload([link], ctx)[0], status=status.HTTP_200_OK)


# ------------------------------------------------------------------ web: music side


class _EntityContractsEndpoint(MusicBaseView):
    model = MusicTrack
    entity_type = TRACK.value

    def _respond(self, slug, entity_id):
        model = MusicTrack if self.entity_type == TRACK.value else MusicRelease
        entity = model.objects.filter(id=entity_id, workspace__slug=slug).values_list("workspace_id", flat=True).first()
        if entity is None:
            return Response({"error": "Not found"}, status=status.HTTP_404_NOT_FOUND)
        # Contracts live in the file library; without it there is nothing to show
        if not is_workspace_feature_enabled(WorkspaceFeature.FeatureKey.FILE_LIBRARY, slug=slug):
            return Response({"links": []}, status=status.HTTP_200_OK)
        rows = entity_contracts_payload(entity, slug, self.entity_type, entity_id)
        return Response({"links": rows}, status=status.HTTP_200_OK)


class MusicTrackContractsEndpoint(_EntityContractsEndpoint):
    entity_type = TRACK.value

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def get(self, request, slug, track_id):
        return self._respond(slug, track_id)


class MusicReleaseContractsEndpoint(_EntityContractsEndpoint):
    model = MusicRelease
    entity_type = RELEASE.value

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def get(self, request, slug, release_id):
        return self._respond(slug, release_id)


MAX_BULK_TRACKS = 10000


class MusicTracksLinkContractEndpoint(MusicBaseView):
    """The catalog's "Ligar a contrato" for selected songs.

    POST {contract_id, track_ids: [...], rights_type?} -> {linked, already, skipped}.
    Set-based so "select all matching" (thousands of songs) is a few queries:
    a pending or dismissed suggestion for a song becomes LINKED (a person's
    decision), a song already linked is counted as `already` (and only gets
    the rights type when it had none), the rest are created as LINKED.
    """

    model = ContractWorkLink

    @allow_permission([ROLE.ADMIN], level="WORKSPACE")
    def post(self, request, slug):
        if not is_workspace_feature_enabled(WorkspaceFeature.FeatureKey.FILE_LIBRARY, slug=slug):
            return Response({"error": "Contracts are not enabled for this workspace"}, status=status.HTTP_403_FORBIDDEN)
        data = request.data if isinstance(request.data, dict) else {}
        track_ids = data.get("track_ids")
        if not isinstance(track_ids, list) or not track_ids or len(track_ids) > MAX_BULK_TRACKS:
            return _bad(f"track_ids must list between 1 and {MAX_BULK_TRACKS} songs")
        ok, rights = _rights(data.get("rights_type"))
        if not ok:
            return _bad("unknown rights_type")
        try:
            contract = _contract(slug, data.get("contract_id"))
        except (ValueError, ValidationError):
            contract = None
        if contract is None:
            return Response({"error": "Contract not found"}, status=status.HTTP_404_NOT_FOUND)

        clean = []
        for raw in track_ids:
            try:
                clean.append(uuid.UUID(str(raw)))
            except (TypeError, ValueError):
                continue
        found = list(
            MusicTrack.objects.filter(workspace_id=contract.workspace_id, id__in=clean).values_list("id", flat=True)
        )
        now = timezone.now()
        with transaction.atomic():
            existing = {
                link.entity_id: link
                for link in ContractWorkLink.objects.filter(
                    contract_id=contract.id, entity_type=TRACK, entity_id__in=found
                ).only("id", "entity_id", "status", "rights_type")
            }
            already = [link.id for link in existing.values() if link.status == Status.LINKED]
            upgrade = [link.id for link in existing.values() if link.status != Status.LINKED]
            if upgrade:
                ContractWorkLink.objects.filter(id__in=upgrade).update(
                    status=Status.LINKED,
                    decided_by=request.user,
                    decided_at=now,
                    updated_at=now,
                    **({"rights_type": rights} if rights else {}),
                )
            if rights and already:
                ContractWorkLink.objects.filter(id__in=already, rights_type__isnull=True).update(
                    rights_type=rights, updated_at=now
                )
            ContractWorkLink.objects.bulk_create(
                [
                    ContractWorkLink(
                        workspace_id=contract.workspace_id,
                        contract_id=contract.id,
                        entity_type=TRACK,
                        entity_id=track_id,
                        status=Status.LINKED,
                        source=Source.MANUAL,
                        rights_type=rights,
                        decided_by=request.user,
                        decided_at=now,
                        created_by=request.user,
                    )
                    for track_id in found
                    if track_id not in existing
                ],
                batch_size=500,
            )
        return Response(
            {
                "linked": len(found) - len(already),
                "already": len(already),
                "skipped": len(track_ids) - len(found),
                "contract": contract_card(contract, slug, now.date()),
            },
            status=status.HTTP_200_OK,
        )


# ------------------------------------------------------------------------ internal


class InternalContractWorksSuggestEndpoint(InternalBaseView):
    """Analysis output -> saved suggestions. Body {works: [...], source?: "AI"}."""

    def post(self, request, workspace_id, contract_id):
        contract = (
            Contract.objects.defer("extracted_text").filter(id=contract_id, workspace_id=workspace_id).first()
        )
        if contract is None:
            return Response({"error": "Contract not found"}, status=status.HTTP_404_NOT_FOUND)
        works = request.data.get("works")
        if not isinstance(works, list):
            return _bad("works must be a list")
        source = Source.ASSISTANT if request.data.get("source") == Source.ASSISTANT else Source.AI
        matches = match_works(workspace_id, works)
        counts = record_suggestions(contract, matches, source=source)
        return Response(counts, status=status.HTTP_200_OK)


def _assistant_ctx(workspace_id, user_id):
    """The asking user's access, or None when they are not an active member."""
    workspace = Workspace.objects.filter(id=workspace_id).only("slug").first()
    try:
        user = User.objects.filter(id=user_id).first() if user_id else None
    except (ValueError, ValidationError):
        user = None
    if workspace is None or user is None:
        return None
    return AccessContext.build(workspace.slug, user)


def _can_read_contracts(ctx):
    return ctx is not None and WorkspaceFeature.FeatureKey.FILE_LIBRARY in ctx.features


def _not_available():
    return Response({"error": "Not available"}, status=status.HTTP_403_FORBIDDEN)


class InternalAssistantContractWorksEndpoint(InternalBaseView):
    """GET ?user_id=: the contract's current links and pending suggestions."""

    def get(self, request, workspace_id, contract_id):
        ctx = _assistant_ctx(workspace_id, request.query_params.get("user_id"))
        if not _can_read_contracts(ctx):
            return _not_available()
        contract = live_contracts().defer("extracted_text").filter(id=contract_id, workspace_id=workspace_id).first()
        if contract is None:
            return Response({"error": "Contract not found"}, status=status.HTTP_404_NOT_FOUND)
        return Response(
            {
                "contract": {
                    "id": str(contract.id),
                    "titulo": contract.titulo,
                    "file_name": (contract.file_asset.attributes or {}).get("name"),
                    "path": f"/{ctx.slug}/file-library/contracts/analyzed?peek={contract.id}",
                },
                "links": _links_for(contract, ctx),
                "music_access": has_music_access(ctx),
            },
            status=status.HTTP_200_OK,
        )


class InternalAssistantContractWorksMatchEndpoint(InternalBaseView):
    """POST {user_id, contract_id, works}: catalog candidates for a
    confirmation card. Writes nothing."""

    def post(self, request, workspace_id):
        data = request.data if isinstance(request.data, dict) else {}
        ctx = _assistant_ctx(workspace_id, data.get("user_id"))
        if not _can_read_contracts(ctx) or not has_music_access(ctx):
            return _not_available()
        try:
            contract = (
                live_contracts()
                .defer("extracted_text")
                .filter(id=data.get("contract_id"), workspace_id=workspace_id)
                .first()
            )
        except (ValueError, ValidationError):
            contract = None
        if contract is None:
            return Response({"error": "Contract not found"}, status=status.HTTP_404_NOT_FOUND)
        works = data.get("works")
        if not isinstance(works, list):
            return _bad("works must be a list")

        from plane.utils.entities import REGISTRY

        results = match_works(workspace_id, works)
        existing = {
            (link.entity_type, str(link.entity_id)): link.status
            for link in ContractWorkLink.objects.filter(contract_id=contract.id, entity_id__isnull=False)
        }
        tracks = {
            str(track.id): track
            for track in MusicTrack.objects.filter(
                id__in=[row["entity_id"] for row in results if row["matched"] and row["entity_type"] == TRACK.value]
            )
        }
        releases = {
            str(release.id): release
            for release in MusicRelease.objects.filter(
                id__in=[row["entity_id"] for row in results if row["matched"] and row["entity_type"] == RELEASE.value]
            )
        }
        matched, unmatched = [], []
        for row in results:
            if not row["matched"]:
                unmatched.append({"index": row["index"], "work": row["work"]})
                continue
            is_track = row["entity_type"] == TRACK.value
            entity = (tracks if is_track else releases).get(row["entity_id"])
            definition = REGISTRY["music_track" if is_track else "music_release"]
            matched.append(
                {
                    "index": row["index"],
                    "work": row["work"],
                    "entity_type": row["entity_type"],
                    "entity_id": row["entity_id"],
                    "title": row["title"],
                    "artists": row["artists"],
                    "path": definition.describe(entity, ctx)["path"] if entity else None,
                    "cover_url": (entity.cover_url or None) if entity else None,
                    "confidence": row["confidence"],
                    "match_type": row["match_type"],
                    # Status of a link the contract already has to this item
                    "existing_status": existing.get((row["entity_type"], row["entity_id"])),
                }
            )
        return Response(
            {
                "contract": {
                    "id": str(contract.id),
                    "titulo": contract.titulo,
                    "file_name": (contract.file_asset.attributes or {}).get("name"),
                    "path": f"/{ctx.slug}/file-library/contracts/analyzed?peek={contract.id}",
                },
                "matched": matched,
                "unmatched": unmatched,
            },
            status=status.HTTP_200_OK,
        )


class InternalAssistantTrackContractsEndpoint(InternalBaseView):
    """GET ?user_id=: contracts covering a song (incl. via its releases)."""

    def get(self, request, workspace_id, track_id):
        ctx = _assistant_ctx(workspace_id, request.query_params.get("user_id"))
        if not _can_read_contracts(ctx) or not has_music_access(ctx):
            return _not_available()
        track = MusicTrack.objects.filter(id=track_id, workspace_id=workspace_id).only("id", "title").first()
        if track is None:
            return Response({"error": "Track not found"}, status=status.HTTP_404_NOT_FOUND)
        rows = entity_contracts_payload(workspace_id, ctx.slug, TRACK.value, track.id)
        return Response({"track": {"id": str(track.id), "title": track.title}, "links": rows}, status=status.HTTP_200_OK)
