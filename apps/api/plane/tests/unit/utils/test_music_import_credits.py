# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Catalog import: tagged contributors with any role, the per-file role map,
publishers, fixed values ("constants") and the near-duplicate name check."""

import pytest

from plane.app.views.music.base import MusicImportEndpoint, MusicTrackEndpoint
from plane.app.views.music.importer import run_import
from plane.app.views.music.base import _infer_mapping
from plane.db.models import (
    MusicCompany,
    MusicCredit,
    MusicCreditRole,
    MusicDistribution,
    MusicRelease,
    MusicTrack,
    WorkspaceFeature,
)
from plane.utils.music_credits import (
    SKIP_ROLE,
    RoleCatalog,
    merge_details,
    name_key,
    resolve_role,
    similar_names,
    split_untagged,
    tag_counts,
    tagged_entries,
)


def _run(workspace, rows, mapping, **options):
    options.setdefault("strategy", "update")
    result = None
    for event in run_import(MusicImportEndpoint(), workspace, rows, 1, mapping, **options):
        if event[0] == "result":
            result = event[1]
    return result


def _credits(track):
    return {
        (credit.party.display_name, credit.role): credit.role_detail
        for credit in MusicCredit.objects.filter(track=track).select_related("party")
    }


# ── Pure helpers ──────────────────────────────────────────────────────────────


@pytest.mark.unit
@pytest.mark.parametrize(
    "tag,field,expected",
    [
        # Another name for an existing role: that role, no detail
        ("MixingEngineer", "contributors", ("MIXER", "")),
        ("MasteringEngineer", "contributors", ("MASTERING_ENGINEER", "")),
        ("Executiveproducer", "contributors", ("EXECUTIVE_PRODUCER", "")),
        ("AR", "contributors", ("A_AND_R", "")),
        ("A&R", "contributors", ("A_AND_R", "")),
        ("CoProducer", "contributors", ("CO_PRODUCER", "")),
        ("Lyricist", "contributors", ("LYRICIST", "")),
        ("Composer", "contributors", ("COMPOSER", "")),
        # Anything more specific is a role of its own, named after the tag
        ("AssistantMixingEngineer", "contributors", ("ASSISTANT_MIXING_ENGINEER", "")),
        ("VocalArranger", "contributors", ("VOCAL_ARRANGER", "")),
        ("FilmDirector", "contributors", ("FILM_DIRECTOR", "")),
        ("Librettist", "contributors", ("LIBRETTIST", "")),
        ("Tuba", "performers", ("TUBA", "")),
        ("Theremin Wizard", "contributors", ("THEREMIN_WIZARD", "")),
        # Untagged names
        (None, "contributors", ("OTHER", "")),
        (None, "performers", ("PERFORMER", "")),
    ],
)
def test_tag_to_role_defaults(tag, field, expected):
    assert resolve_role(tag, field) == expected


@pytest.mark.unit
@pytest.mark.parametrize(
    "tag,field,key,label,category,is_new",
    [
        ("Vocals", "performers", "VOCALS", "Vocals", "PERFORMER", True),
        ("LeadVocals", "performers", "LEAD_VOCALS", "Lead Vocals", "PERFORMER", True),
        ("BajoQuinto", "performers", "BAJO_QUINTO", "Bajo Quinto", "PERFORMER", True),
        ("Drums", "contributors", "DRUMS", "Drums", "PERFORMER", True),
        ("AssistantMixingEngineer", "contributors", "ASSISTANT_MIXING_ENGINEER", "Assistant Mixing Engineer",
         "ENGINEER", True),
        ("FilmDirector", "contributors", "FILM_DIRECTOR", "Film Director", "VIDEO", True),
        ("Librettist", "contributors", "LIBRETTIST", "Librettist", "WRITER", True),
        ("Theremin Wizard", "performers", "THEREMIN_WIZARD", "Theremin Wizard", "PERFORMER", True),
        ("MixingEngineer", "contributors", "MIXER", "Mixing Engineer", "ENGINEER", False),
        ("AR", "contributors", "A_AND_R", "A&R", "MANAGEMENT", False),
    ],
)
def test_role_catalog_describes_tags_in_their_own_words(tag, field, key, label, category, is_new):
    assert RoleCatalog().describe(tag, field) == {"key": key, "label": label, "category": category, "is_new": is_new}


@pytest.mark.unit
def test_role_catalog_matches_workspace_roles_by_label_and_source_tags():
    catalog = RoleCatalog([{"key": "VOZ_PRINCIPAL", "label": "Voz principal", "category": "PERFORMER",
                            "source_tags": ["LeadVocals"]}])
    assert catalog.describe("Lead Vocals", "performers")["key"] == "VOZ_PRINCIPAL"
    assert catalog.describe("Voz Principal")["key"] == "VOZ_PRINCIPAL"
    assert catalog.label("VOZ_PRINCIPAL") == "Voz principal"
    # Unknown keys still read well
    assert catalog.label("SOME_OLD_KEY") == "Some Old Key"


@pytest.mark.unit
def test_role_map_overrides_and_skip():
    assert resolve_role("Executiveproducer", "contributors", {"executiveproducer": "PRODUCER"}) == (
        "PRODUCER",
        "Executiveproducer",
    )
    assert resolve_role("Tuba", "performers", {"tuba": SKIP_ROLE}) == (SKIP_ROLE, "")
    assert resolve_role(None, "contributors", {"": "PRODUCER"}) == ("PRODUCER", "")
    # A key nobody knows falls back to the tag's own role
    assert resolve_role("Tuba", "performers", {"tuba": "NOT_A_ROLE"}) == ("TUBA", "")
    # …but a role another tag of the same file creates is fine
    catalog = RoleCatalog()
    catalog.describe("Vocals", "performers")
    assert catalog.resolve("LeadVocals", "performers", {"leadvocals": "VOCALS"}) == ("VOCALS", "LeadVocals")


@pytest.mark.unit
def test_tagged_entries_split_only_at_tags():
    assert tagged_entries('Sergio "Keko" Vazquez <MixingEngineer>, Sergio "Keko" Vazquez <MasteringEngineer>') == [
        ('Sergio "Keko" Vazquez', "MixingEngineer"),
        ('Sergio "Keko" Vazquez', "MasteringEngineer"),
    ]
    assert tagged_entries("Latin Power Music, Inc <TBD>, Hermanos Vargas y Ríos <ASCAP>") == [
        ("Latin Power Music, Inc", "TBD"),
        ("Hermanos Vargas y Ríos", "ASCAP"),
    ]
    assert tagged_entries("Abelardo Rivera Levy, <RecordingEngineer>") == [
        ("Abelardo Rivera Levy", "RecordingEngineer")
    ]
    assert tagged_entries("Ana, Luis") == [("Ana", None), ("Luis", None)]
    assert split_untagged("Latin Power Music, Inc.") == ["Latin Power Music, Inc"]


@pytest.mark.unit
def test_merge_details_and_tag_counts():
    assert merge_details("Tuba", "Chorus, tuba", "") == "Tuba, Chorus"
    counts = tag_counts(["Ana <Tuba>, Luis <Tuba>", "Ana <Chorus>, Pepe"])
    assert counts["tuba"]["count"] == 2 and counts["tuba"]["tag"] == "Tuba"
    assert counts[""]["count"] == 1


@pytest.mark.unit
def test_similar_names_normalizer():
    assert name_key("VirginAgregadora") == "virgin"
    assert name_key("Virgin Agregadora S.A. de C.V.") == "virgin"
    assert name_key("Música Récords") == "musica"
    matches = [name for _score, name, _ in similar_names("Virgin", ["VirginAgregadora", "Universal", "virgin"])]
    # An exact match (ignoring case) is not "similar"; the glued suffix one is.
    assert matches == ["VirginAgregadora"]
    assert similar_names("Sony", ["Universal Music"]) == []


# ── Import behaviour ─────────────────────────────────────────────────────────


@pytest.mark.django_db
def test_contributors_any_role_with_details_merged(workspace):
    rows = [
        {
            "Title": "Cómo estás tú",
            "Credits": (
                'Keko <MixingEngineer>, Keko <MasteringEngineer>, Ana <AssistantMixingEngineer>, '
                "Ana <AssistantRecordingEngineer>, Luis <Executiveproducer>, Zoe <Weird Thing>, Pepe"
            ),
            "Musicians": "Juan <Tuba>, Juan <Chorus>, Juan <Tuba>",
        }
    ]
    result = _run(workspace, rows, {"track.title": "Title", "contributors": "Credits", "performers": "Musicians"})
    assert result["errors"] == []
    track = MusicTrack.objects.get(workspace=workspace, title="Cómo estás tú")
    assert _credits(track) == {
        ("Keko", "MIXER"): "",
        ("Keko", "MASTERING_ENGINEER"): "",
        # Each specific tag is its own role, kept in the file's words
        ("Ana", "ASSISTANT_MIXING_ENGINEER"): "",
        ("Ana", "ASSISTANT_RECORDING_ENGINEER"): "",
        ("Luis", "EXECUTIVE_PRODUCER"): "",
        ("Zoe", "WEIRD_THING"): "",
        ("Pepe", "OTHER"): "",
        # The same person and tag twice is one credit
        ("Juan", "TUBA"): "",
        ("Juan", "CHORUS"): "",
    }
    roles = {role.key: (role.label, role.category) for role in MusicCreditRole.objects.filter(workspace=workspace)}
    assert roles == {
        "ASSISTANT_MIXING_ENGINEER": ("Assistant Mixing Engineer", "ENGINEER"),
        "ASSISTANT_RECORDING_ENGINEER": ("Assistant Recording Engineer", "ENGINEER"),
        "WEIRD_THING": ("Weird Thing", "OTHER"),
        "TUBA": ("Tuba", "PERFORMER"),
        "CHORUS": ("Chorus", "PERFORMER"),
    }


@pytest.mark.django_db
def test_specific_field_and_contributors_on_same_column_do_not_duplicate(workspace):
    rows = [{"Title": "Mi fantasía", "Credits": "Keko <MixingEngineer>, Keko <MasteringEngineer>"}]
    mapping = {"track.title": "Title", "contributors": "Credits", "mastering_engineers": "Credits", "mixers": "Credits"}
    result = _run(workspace, rows, mapping)
    assert result["errors"] == []
    track = MusicTrack.objects.get(workspace=workspace, title="Mi fantasía")
    assert MusicCredit.objects.filter(track=track).count() == 2
    # Re-importing the same file adds nothing and merges no new detail
    _run(workspace, rows, mapping)
    assert MusicCredit.objects.filter(track=track).count() == 2


@pytest.mark.django_db
def test_role_map_overrides_and_skips_tags(workspace):
    rows = [{"Title": "Uno", "Credits": "Luis <Executiveproducer>, Ana <AR>, Zoe <VideoProducer>"}]
    _run(
        workspace,
        rows,
        {"track.title": "Title", "contributors": "Credits"},
        role_map={"executiveproducer": "PRODUCER", "ar": SKIP_ROLE},
    )
    track = MusicTrack.objects.get(workspace=workspace, title="Uno")
    assert _credits(track) == {("Luis", "PRODUCER"): "Executiveproducer", ("Zoe", "VIDEO_PRODUCER"): ""}


@pytest.mark.django_db
def test_publishers_become_publisher_companies(workspace):
    rows = [{"Title": "Dos", "Pubs": "Latin Power Music, Inc <TBD>, Alma Musical <SACM>"}]
    _run(workspace, rows, {"track.title": "Title", "publishers": "Pubs"})
    track = MusicTrack.objects.get(workspace=workspace, title="Dos")
    companies = {
        (link.company.name, link.company.kind, link.company.notes)
        for link in MusicDistribution.objects.filter(track=track).select_related("company")
    }
    assert companies == {
        ("Latin Power Music, Inc", "PUBLISHER", ""),
        ("Alma Musical", "PUBLISHER", "PRO: SACM"),
    }


@pytest.mark.django_db
def test_constants_without_column_blank_cell_and_filled_cell(workspace):
    MusicCompany.objects.create(workspace=workspace, kind=MusicCompany.Kind.AGGREGATOR, name="VirginAgregadora")
    rows = [
        {"Title": "Con idioma", "Lang": "en"},
        {"Title": "Sin idioma", "Lang": ""},
        # Filler line: only the fixed values would say anything about it
        {"Title": "", "Lang": ""},
    ]
    result = _run(
        workspace,
        rows,
        {"track.title": "Title", "track.language": "Lang"},
        constants={
            "track.language": "es",
            "aggregator": "VirginAgregadora",
            "genres": ["Regional Mexicano", "Banda y Norteño"],
            "track.status": "RELEASED",
        },
    )
    assert result["errors"] == [] and result["empty"] == 1 and result["created"] == 2
    with_lang = MusicTrack.objects.get(workspace=workspace, title="Con idioma")
    without_lang = MusicTrack.objects.get(workspace=workspace, title="Sin idioma")
    assert with_lang.language == "en"  # a filled cell wins over the fixed value
    assert without_lang.language == "es"  # a blank cell takes it
    assert with_lang.status == "RELEASED"
    # Picked existing company reused (no twin), genres kept whole (not split on "y")
    assert MusicCompany.objects.filter(workspace=workspace, kind="AGGREGATOR").count() == 1
    assert set(with_lang.genre_links.values_list("genre__name", flat=True)) == {"Regional Mexicano", "Banda y Norteño"}
    assert with_lang.distributions.get().company.name == "VirginAgregadora"


@pytest.mark.django_db
def test_old_payloads_without_new_options_still_import(workspace):
    rows = [{"Title": "Tres", "Writers": "Ana <Lyricist>, Ana <Composer>, Luis <Composer>"}]
    result = _run(workspace, rows, {"track.title": "Title", "writers": "Writers", "authors": "Writers"})
    assert result["errors"] == []
    track = MusicTrack.objects.get(workspace=workspace, title="Tres")
    assert set(_credits(track)) == {("Ana", "WRITER"), ("Luis", "WRITER"), ("Ana", "AUTHOR")}


@pytest.mark.django_db
def test_role_detail_survives_track_panel_round_trip(workspace):
    rows = [{"Title": "Cuatro", "Musicians": "Juan <Tuba>"}]
    # Sent into a broader role: the tag is kept as the detail
    _run(workspace, rows, {"track.title": "Title", "performers": "Musicians"}, role_map={"tuba": "PERFORMER"})
    track = MusicTrack.objects.get(workspace=workspace, title="Cuatro")
    credit = track.credits.get()
    # A client that doesn't know role_detail keeps it…
    MusicTrackEndpoint._sync_relations(
        track, workspace, {"credit_entries": [{"party_id": credit.party_id, "role": "PERFORMER"}]}
    )
    assert track.credits.get().role_detail == "Tuba"
    # …and one that sends it changes it
    MusicTrackEndpoint._sync_relations(
        track,
        workspace,
        {"credit_entries": [{"party_id": credit.party_id, "role": "PERFORMER", "role_detail": "Tololoche"}]},
    )
    assert track.credits.get().role_detail == "Tololoche"


@pytest.mark.django_db
def test_field_values_endpoint_suggests_existing_and_similar(session_client, workspace):
    WorkspaceFeature.objects.create(workspace=workspace, key=WorkspaceFeature.FeatureKey.MUSIC_CATALOG, is_enabled=True)
    MusicCompany.objects.create(workspace=workspace, kind=MusicCompany.Kind.AGGREGATOR, name="VirginAgregadora")
    MusicCompany.objects.create(workspace=workspace, kind=MusicCompany.Kind.RECORD_LABEL, name="Virgin Records")
    url = f"/api/workspaces/{workspace.slug}/music/import/field-values/"
    response = session_client.get(url, {"field": "aggregator", "q": "Virgin"})
    assert response.status_code == 200
    data = response.json()
    assert data["kind"] == "company"
    # Only aggregators: the record label of the same name is another kind
    assert [entry["value"] for entry in data["values"]] == ["VirginAgregadora"]
    assert [entry["value"] for entry in data["similar"]] == ["VirginAgregadora"]
    assert data["exact"] is None
    choices = session_client.get(url, {"field": "track.status"}).json()
    assert choices["kind"] == "choice" and ["RELEASED", "Released"] in choices["choices"]
    assert session_client.get(url, {"field": "nope"}).status_code == 400


# ── Roles follow the file ───────────────────────────────────────────────────


@pytest.mark.django_db
def test_new_roles_are_created_only_when_applying(workspace):
    rows = [{"Title": "Cinco", "Musicians": "Ana <Vocals>, Luis <Drums>", "Credits": "Keko <MixingEngineer>"}]
    mapping = {"track.title": "Title", "performers": "Musicians", "contributors": "Credits"}
    checked = _run(workspace, rows, mapping, dry_run=True)
    assert not MusicCreditRole.objects.filter(workspace=workspace).exists()
    assert {(role["key"], role["label"], role["category"], role["count"]) for role in checked["new_roles"]} == {
        ("VOCALS", "Vocals", "PERFORMER", 1),
        ("DRUMS", "Drums", "PERFORMER", 1),
    }
    assert checked["role_labels"]["MIXER"] == "Mixing Engineer"
    assert checked["role_labels"]["VOCALS"] == "Vocals"

    # (run_import leaves rolling back to its caller; start clean)
    MusicCredit.all_objects.filter(workspace=workspace).delete()
    MusicTrack.all_objects.filter(workspace=workspace).delete()
    _run(workspace, rows, mapping)
    vocals = MusicCreditRole.objects.get(workspace=workspace, key="VOCALS")
    assert (vocals.label, vocals.category, vocals.source_tags) == ("Vocals", "PERFORMER", ["Vocals"])
    track = MusicTrack.objects.get(workspace=workspace, title="Cinco")
    assert set(_credits(track)) == {("Ana", "VOCALS"), ("Luis", "DRUMS"), ("Keko", "MIXER")}
    # A second file reuses the role instead of creating another
    _run(workspace, [{"Title": "Seis", "Musicians": "Eva <vocals>"}], mapping)
    assert MusicCreditRole.objects.filter(workspace=workspace, key="VOCALS").count() == 1
    assert set(_credits(MusicTrack.objects.get(workspace=workspace, title="Seis"))) == {("Eva", "VOCALS")}


@pytest.mark.django_db
def test_role_map_to_custom_and_new_roles_and_skip(workspace):
    MusicCreditRole.objects.create(workspace=workspace, key="VOZ", label="Voz", category="PERFORMER")
    rows = [{"Title": "Siete", "Musicians": "Ana <LeadVocals>, Luis <Vocals>, Eva <Tuba>, Pepe <Guitar>"}]
    _run(
        workspace,
        rows,
        {"track.title": "Title", "performers": "Musicians"},
        # a workspace role, a role this file creates, skip, and an old built-in key
        role_map={"leadvocals": "VOZ", "tuba": "VOCALS", "guitar": SKIP_ROLE, "vocals": "PERFORMER"},
    )
    track = MusicTrack.objects.get(workspace=workspace, title="Siete")
    assert _credits(track) == {
        ("Ana", "VOZ"): "LeadVocals",
        ("Eva", "VOCALS"): "Tuba",
        ("Luis", "PERFORMER"): "Vocals",
    }
    # VOCALS is used (by Eva) so it exists now; LEAD_VOCALS and GUITAR are not
    assert set(MusicCreditRole.objects.filter(workspace=workspace).values_list("key", flat=True)) == {"VOZ", "VOCALS"}


@pytest.mark.django_db
def test_track_panel_accepts_workspace_roles_and_rejects_unknown_ones(workspace):
    from rest_framework.exceptions import ValidationError

    MusicCreditRole.objects.create(workspace=workspace, key="BAJO_QUINTO", label="Bajo Quinto", category="PERFORMER")
    _run(workspace, [{"Title": "Ocho", "Artist": "Ana"}], {"track.title": "Title", "artists": "Artist"})
    track = MusicTrack.objects.get(workspace=workspace, title="Ocho")
    party_id = track.credits.get().party_id
    MusicTrackEndpoint._sync_relations(
        track, workspace, {"credit_entries": [{"party_id": party_id, "role": "BAJO_QUINTO"}]}
    )
    assert track.credits.get().role == "BAJO_QUINTO"
    with pytest.raises(ValidationError):
        MusicTrackEndpoint._sync_relations(
            track, workspace, {"credit_entries": [{"party_id": party_id, "role": "NOT_A_ROLE"}]}
        )
    # Nothing was removed by the rejected request
    assert track.credits.get().role == "BAJO_QUINTO"


@pytest.mark.django_db
def test_credit_roles_endpoint_and_labels_in_track_payload(session_client, workspace):
    WorkspaceFeature.objects.create(workspace=workspace, key=WorkspaceFeature.FeatureKey.MUSIC_CATALOG, is_enabled=True)
    url = f"/api/workspaces/{workspace.slug}/music/credit-roles/"
    created = session_client.post(url, {"label": "Bajo Quinto"}, format="json")
    assert created.status_code == 201
    assert created.json() == {
        "key": "BAJO_QUINTO",
        "label": "Bajo Quinto",
        "category": "PERFORMER",
        "builtin": False,
        "created": True,
    }
    # Another spelling of an existing role is that role
    again = session_client.post(url, {"label": "mixing engineer"}, format="json")
    assert again.status_code == 200 and again.json()["key"] == "MIXER"
    listed = session_client.get(url).json()
    assert {"key": "BAJO_QUINTO", "label": "Bajo Quinto", "category": "PERFORMER", "builtin": False} in listed
    options = session_client.get(f"/api/workspaces/{workspace.slug}/music/options/").json()
    assert ["MIXER", "Mixing Engineer"] in options["credit_roles"]
    assert ["BAJO_QUINTO", "Bajo Quinto"] in options["credit_roles"]

    _run(
        workspace,
        [{"Title": "Nueve", "Musicians": "Ana <BajoQuinto>"}],
        {"track.title": "Title", "performers": "Musicians"},
    )
    track = MusicTrack.objects.get(workspace=workspace, title="Nueve")
    payload = session_client.get(f"/api/workspaces/{workspace.slug}/music/tracks/{track.id}/").json()
    credit = payload["credits"][0]
    assert (credit["role"], credit["role_label"], credit["role_category"]) == (
        "BAJO_QUINTO",
        "Bajo Quinto",
        "PERFORMER",
    )


# ── Distributor columns ─────────────────────────────────────────────────────

SAMPLE_HEADERS = [
    "Product Id", "Product Title", "Product Version", "Product Display Artist", "Label", "Release Date", "UPC",
    "Submission Status", "Primary Metadata Language", "Track Id", "Track Volume", "Track Number", "Track Name",
    "Track Display Artist", "Isrc", "Audio Language", "Track C Line", "Track P Line", "Product C Line",
    "Product P Line", "Sample Start Time", "Product Price Tier", "Vevo Channel",
]


def _sample_row(**overrides):
    row = {
        "Product Id": "692db4a3866b3d0bb2a6fd7e",
        "Product Title": "De Fiesta Vol. 2",
        "Product Version": "En Vivo",
        "Product Display Artist": "NEW NORTE MX, Los HH",
        "Label": "Top Music",
        "Release Date": "2025-12-04",
        "UPC": "198704887383",
        "Submission Status": "Released",
        "Primary Metadata Language": "Spanish (Latin America)",
        "Track Id": "692db693f0402d7af64e0fa8",
        "Track Volume": "1",
        "Track Number": "3",
        "Track Name": "Cómo estás tú",
        "Track Display Artist": "NEW NORTE MX",
        "Isrc": "MXA3Y2400131",
        "Audio Language": "Spanish (Latin America)",
        "Track C Line": "© 2025 Top Music",
        "Track P Line": "℗ 2025 Top Music",
        "Product C Line": "© 2025 TM",
        "Product P Line": "℗ 2025 TM",
        "Sample Start Time": "00:00:47",
        "Product Price Tier": "$3.50 - S5",
        "Vevo Channel": "",
    }
    row.update(overrides)
    return row


@pytest.mark.unit
def test_distributor_columns_map_to_their_fields():
    from plane.app.views.music.base import IMPORT_FIELDS

    mapping = _infer_mapping(SAMPLE_HEADERS, IMPORT_FIELDS)
    assert mapping["release.track_number"] == "Track Number"
    assert mapping["release.disc_number"] == "Track Volume"
    assert mapping["release.artists"] == "Product Display Artist"
    assert mapping["release.version"] == "Product Version"
    assert mapping["release.language"] == "Primary Metadata Language"
    assert mapping["release.status"] == mapping["track.status"] == "Submission Status"
    assert mapping["release.external_id"] == "Product Id"
    assert mapping["track.external_id"] == "Track Id"
    assert mapping["track.p_line"] == "Track P Line" and mapping["release.p_line"] == "Product P Line"
    assert mapping["track.c_line"] == "Track C Line" and mapping["release.c_line"] == "Product C Line"
    assert mapping["track.tiktok_preview_start_ms"] == "Sample Start Time"
    assert mapping["track.language"] == "Audio Language"
    assert mapping["artists"] == "Track Display Artist"


@pytest.mark.django_db
def test_distributor_columns_import(workspace):
    from plane.app.views.music.base import IMPORT_FIELDS

    mapping = _infer_mapping(SAMPLE_HEADERS, IMPORT_FIELDS)
    result = _run(workspace, [_sample_row()], mapping, constants={"track.language": "es"})
    assert result["errors"] == [], result["errors"]
    track = MusicTrack.objects.get(workspace=workspace, isrc="MXA3Y2400131")
    # Long language names fit now; a filled cell wins over the fixed value
    assert track.language == "Spanish (Latin America)"
    assert (track.p_line, track.c_line) == ("℗ 2025 Top Music", "© 2025 Top Music")
    assert track.tiktok_preview_start_ms == 47000
    assert track.status == "RELEASED"
    assert track.metadata["external_ids"] == {"track_id": "692db693f0402d7af64e0fa8"}
    release = MusicRelease.objects.get(workspace=workspace, upc="198704887383")
    assert (release.version, release.language, release.status) == ("En Vivo", "Spanish (Latin America)", "RELEASED")
    assert release.metadata["external_ids"] == {"product_id": "692db4a3866b3d0bb2a6fd7e"}
    link = release.track_links.get(track=track)
    assert (link.disc_number, link.track_number) == (1, 3)
    # The release's own artists, not the song's
    assert set(release.artist_links.values_list("party__display_name", flat=True)) == {"NEW NORTE MX", "Los HH"}
    # Nothing extra unless asked
    assert "extra" not in track.metadata

    # Re-importing with another position updates it and counts as a change
    again = _run(workspace, [_sample_row(**{"Track Number": "4"})], mapping)
    assert again["updated"] == 1
    assert release.track_links.get(track=track).track_number == 4
    same = _run(workspace, [_sample_row(**{"Track Number": "4"})], mapping)
    assert same["unchanged"] == 1


@pytest.mark.django_db
def test_keep_unmapped_columns_as_extra_data_and_dedupe_by_external_id(workspace):
    from plane.app.views.music.base import IMPORT_FIELDS

    mapping = _infer_mapping(SAMPLE_HEADERS, IMPORT_FIELDS)
    _run(workspace, [_sample_row()], mapping, keep_unmapped=True)
    track = MusicTrack.objects.get(workspace=workspace, isrc="MXA3Y2400131")
    # Unmapped, non-empty columns only
    assert track.metadata["extra"] == {"Product Price Tier": "$3.50 - S5"}
    # Same distributor id, different ISRC and title: the same song
    result = _run(
        workspace,
        [_sample_row(**{"Isrc": "MXA3Y2400999", "Track Name": "Otro título"})],
        mapping,
        dedupe_by="external_id",
    )
    assert result["updated"] == 1 and result["created"] == 0
    assert MusicTrack.objects.filter(workspace=workspace).count() == 1


# ── AI column mapping ───────────────────────────────────────────────────────


@pytest.mark.unit
def test_every_import_field_has_a_description_for_the_ai():
    from plane.app.views.music.base import FIELD_DESCRIPTIONS, IMPORT_FIELDS

    assert set(IMPORT_FIELDS) <= set(FIELD_DESCRIPTIONS)


def _ai_map(session_client, workspace, mocker, worker_response, **form):
    import json

    from django.core.files.uploadedfile import SimpleUploadedFile

    WorkspaceFeature.objects.get_or_create(
        workspace=workspace, key=WorkspaceFeature.FeatureKey.MUSIC_CATALOG, defaults={"is_enabled": True}
    )
    worker = mocker.patch("plane.utils.worker_client.ai_map_music_columns", return_value=worker_response)
    csv_file = SimpleUploadedFile(
        "songs.csv", "Track Name,Isrc,Writers,Composers\nUno,USRC17607839,Ana,Luis\n".encode(), content_type="text/csv"
    )
    payload = {"file": csv_file, **{key: json.dumps(value) for key, value in form.items()}, "locale": "en"}
    response = session_client.post(
        f"/api/workspaces/{workspace.slug}/music/import/ai-map/", payload, format="multipart"
    )
    return response, worker


@pytest.mark.django_db
def test_ai_map_sends_current_mapping_and_validates_suggestions(session_client, workspace, mocker):
    response, worker = _ai_map(
        session_client,
        workspace,
        mocker,
        {
            "mapping": {},
            "suggestions": {
                "track.title": {"columns": ["Isrc"], "confidence": 0.4, "reason": "Looks wrong", "replace": False},
                "track.isrc": {"columns": ["Isrc", "Writers"], "confidence": 7, "reason": "ISRC codes"},
                "writers": {"columns": ["Writers", "Composers", "Ghost"], "confidence": 0.9, "replace": True},
                "nope": {"columns": ["Isrc"]},
                "genres": {"columns": ["Ghost"]},
            },
            "model": "test-model",
        },
        current_mapping={
            "track.title": "Track Name",
            "writers": ["Writers"],
            "bogus": "Track Name",
            "artists": "Ghost",
        },
        locked_fields=["track.title", "bogus"],
        constants={"track.language": "es"},
    )
    assert response.status_code == 200
    kwargs = worker.call_args.kwargs
    # Only real fields and headers reach the Worker
    assert kwargs["current_mapping"] == {"track.title": "Track Name", "writers": ["Writers"]}
    assert kwargs["locked_fields"] == ["track.title"]
    assert kwargs["constants"] == {"track.language": "es"}
    assert kwargs["locale"] == "en"
    assert kwargs["field_descriptions"]["contributors"]
    data = response.json()
    assert data["suggestions"] == {
        "track.title": {
            "columns": ["Isrc"], "confidence": 0.4, "reason": "Looks wrong", "replace": False, "locked": True,
        },
        "track.isrc": {
            "columns": ["Isrc"], "confidence": 1.0, "reason": "ISRC codes", "replace": False, "locked": False,
        },
        "writers": {
            "columns": ["Writers", "Composers"], "confidence": 0.9, "reason": "", "replace": True, "locked": False,
        },
    }
    # The old response shape is still there
    assert data["mapping"] == {"track.title": "Isrc", "track.isrc": "Isrc", "writers": ["Writers", "Composers"]}
    assert data["model"] == "test-model"


@pytest.mark.django_db
def test_ai_map_tolerates_an_older_worker(session_client, workspace, mocker):
    response, _worker = _ai_map(
        session_client, workspace, mocker, {"mapping": {"track.isrc": "Isrc", "writers": ["Writers", "Composers"]}}
    )
    assert response.status_code == 200
    assert response.json()["suggestions"] == {
        "track.isrc": {"columns": ["Isrc"], "confidence": None, "reason": "", "replace": False, "locked": False},
        "writers": {
            "columns": ["Writers", "Composers"], "confidence": None, "reason": "", "replace": False, "locked": False,
        },
    }
