# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""
Opens a document in Collabora without going through the Plane UI.

Useful while the React side does not exist yet, and afterwards as a way to
tell "the WOPI host is broken" apart from "the frontend is broken".

    python manage.py collabora_test_page --seed
    python manage.py collabora_test_page --asset-id <uuid>

Writes an HTML file that posts the WOPI form to Collabora. Open it in a
browser and the editor should load the document.
"""

import io
import uuid
import zipfile

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from plane.db.models import FileAsset, User, Workspace
from plane.settings.storage import S3Storage

# The smallest file Word and Collabora both accept as a .docx: a zip holding
# the three parts the format requires.
_CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml"
ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>"""

_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1"
Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"
Target="word/document.xml"/>
</Relationships>"""

_DOCUMENT = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body><w:p><w:r><w:t>Documento de prueba de Collabora. Editame y guarda.</w:t></w:r></w:p></w:body>
</w:document>"""

DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


def build_docx() -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", _CONTENT_TYPES)
        archive.writestr("_rels/.rels", _RELS)
        archive.writestr("word/document.xml", _DOCUMENT)
    return buffer.getvalue()


PAGE = """<!doctype html>
<meta charset="utf-8">
<title>Prueba Collabora</title>
<style>
  body {{ margin: 0; font-family: system-ui, sans-serif; }}
  header {{ padding: 8px 12px; background: #111; color: #eee; font-size: 13px; }}
  iframe {{ width: 100vw; height: calc(100vh - 33px); border: 0; }}
</style>
<header>WOPISrc: {wopi_src} &nbsp;|&nbsp; asset {asset_id}</header>
<form id="f" action="{action}" method="post" target="editor">
  <input type="hidden" name="access_token" value="{token}">
</form>
<iframe name="editor"></iframe>
<script>document.getElementById("f").submit();</script>
"""


class Command(BaseCommand):
    help = "Generate a standalone page that opens a document in Collabora"

    def add_arguments(self, parser):
        parser.add_argument("--asset-id", help="Existing FileAsset to open")
        parser.add_argument("--seed", action="store_true", help="Create a throwaway .docx first")
        parser.add_argument("--out", default="/code/collabora-test.html")

    def handle(self, *args, **options):
        from plane.app.views.file_library.collabora import editor_url_for, mint_access_token
        from urllib.parse import quote

        if not settings.COLLABORA_URL:
            raise CommandError("COLLABORA_URL is empty — set it in apps/api/.env and recreate the container")

        if options["seed"]:
            asset = self._seed()
        elif options["asset_id"]:
            asset = FileAsset.objects.filter(id=options["asset_id"], deleted_at__isnull=True).first()
            if not asset:
                raise CommandError(f"No asset {options['asset_id']}")
        else:
            raise CommandError("Pass --seed or --asset-id")

        host = (settings.WOPI_HOST_URL or settings.WEB_URL).rstrip("/")
        wopi_src = f"{host}/wopi/files/{asset.id}"

        name = asset.attributes.get("name", "")
        extension = name.rsplit(".", 1)[-1].lower() if "." in name else ""
        editor_base = editor_url_for(extension)
        if not editor_base:
            raise CommandError("Collabora discovery returned no editor URL — is COLLABORA_URL reachable?")
        # The urlsrc from discovery carries the build hash and ends in "?"/"&"
        separator = "" if editor_base.endswith(("?", "&")) else "?"
        action = f"{editor_base}{separator}WOPISrc={quote(wopi_src, safe='')}"

        page = PAGE.format(
            wopi_src=wopi_src,
            asset_id=asset.id,
            action=action,
            token=mint_access_token(asset.id, asset.created_by_id, True),
        )
        with open(options["out"], "w") as handle:
            handle.write(page)

        self.stdout.write(self.style.SUCCESS(f"asset    {asset.id}"))
        self.stdout.write(self.style.SUCCESS(f"WOPISrc  {wopi_src}"))
        self.stdout.write(self.style.SUCCESS(f"page     {options['out']}"))

    def _seed(self) -> FileAsset:
        workspace = Workspace.objects.first()
        if not workspace:
            raise CommandError("No workspace in this database")
        user = User.objects.filter(is_active=True, is_bot=False).first() or User.objects.filter(is_active=True).first()

        payload = build_docx()
        key = f"{workspace.id}/{uuid.uuid4()}-prueba-collabora.docx"

        storage = S3Storage()
        if not storage.upload_file(io.BytesIO(payload), object_name=key, content_type=DOCX_MIME):
            raise CommandError("Upload to the bucket failed")

        return FileAsset.objects.create(
            attributes={"name": "prueba-collabora.docx", "type": DOCX_MIME, "size": len(payload)},
            asset=key,
            size=len(payload),
            workspace=workspace,
            created_by=user,
            entity_type=FileAsset.EntityTypeContext.WORKSPACE_FILE_LIBRARY,
            is_uploaded=True,
        )
