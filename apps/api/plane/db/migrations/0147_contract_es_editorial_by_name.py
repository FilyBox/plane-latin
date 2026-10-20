# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

import re
import unicodedata

from django.db import migrations

# Words that only an editorial (music-publishing) contract carries in its name.
# Deliberately narrow: "cesión de derechos" or a bare "edición" also show up in
# recording and service contracts, so they are left for the AI to decide.
EDITORIAL_NAME = re.compile(
    r"editorial|publishing|editora musical|edicion musical|edicion de obras?"
    r"|co[\s-]?edicion|sub[\s-]?edicion"
)


def normalize(text):
    """Lowercase without accents, so "EDICIÓN" and "edicion" match alike."""
    decomposed = unicodedata.normalize("NFKD", text or "")
    return "".join(char for char in decomposed if not unicodedata.combining(char)).lower()


def is_editorial_name(*names):
    return any(EDITORIAL_NAME.search(normalize(name)) for name in names if name)


def mark_editorial_by_name(apps, schema_editor):
    """Files contracts under Editoriales by their title or file name.

    A stopgap until the AI classification runs: contracts named "Contrato
    editorial", "… publishing …" and the like move now; everything else stays
    unclassified for the AI. Only contracts nobody has classified are touched,
    so a manual "no editorial" is never overridden.
    """
    Contract = apps.get_model("db", "Contract")
    matched = []
    candidates = Contract.objects.filter(es_editorial__isnull=True).select_related("file_asset")
    for contract in candidates.iterator():
        file_name = (contract.file_asset.attributes or {}).get("name") if contract.file_asset_id else None
        if is_editorial_name(contract.titulo, file_name):
            matched.append((contract.id, contract.titulo or file_name))

    Contract.objects.filter(id__in=[contract_id for contract_id, _ in matched]).update(es_editorial=True)
    # Shows up in the Migrator's deploy log: the record of what moved.
    print(f"\n  Contracts marked editorial by name: {len(matched)}")
    for _, name in matched[:200]:
        print(f"    - {name}")


class Migration(migrations.Migration):
    dependencies = [
        ("db", "0146_contract_es_editorial"),
    ]

    operations = [
        migrations.RunPython(mark_editorial_by_name, migrations.RunPython.noop),
    ]
