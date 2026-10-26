# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Catalog import: tagged contributors with any role, the per-file role map,
publishers, fixed values ("constants") and the near-duplicate name check."""

import pytest

from plane.app.views.music.base import MusicImportEndpoint, MusicTrackEndpoint
from plane.app.views.music.importer import run_import
from plane.db.models import MusicCompany, MusicCredit, MusicDistribution, MusicTrack, WorkspaceFeature
from plane.utils.music_credits import (
    SKIP_ROLE,
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
        ("MixingEngineer", "contributors", ("MIXER", "")),
        ("MasteringEngineer", "contributors", ("MASTERING_ENGINEER", "")),
        ("Executiveproducer", "contributors", ("EXECUTIVE_PRODUCER", "")),
        ("AR", "contributors", ("A_AND_R", "")),
        ("A&R", "contributors", ("A_AND_R", "")),
        ("CoProducer", "contributors", ("CO_PRODUCER", "")),
        ("AssistantMixingEngineer", "contributors", ("ASSISTANT_ENGINEER", "AssistantMixingEngineer")),
        ("AssistantSoundEngineer", "contributors", ("ASSISTANT_ENGINEER", "AssistantSoundEngineer")),
        ("VocalArranger", "contributors", ("ARRANGER", "VocalArranger")),
        ("FilmDirector", "contributors", ("VIDEO_DIRECTOR", "FilmDirector")),
        ("Librettist", "contributors", ("AUTHOR", "Librettist")),
        ("Lyricist", "contributors", ("AUTHOR", "")),
        ("Composer", "contributors", ("COMPOSER", "")),
        ("Tuba", "contributors", ("PERFORMER", "Tuba")),
        ("Tuba", "performers", ("PERFORMER", "Tuba")),
        ("Theremin Wizard", "contributors", ("OTHER", "Theremin Wizard")),
        ("Theremin Wizard", "performers", ("PERFORMER", "Theremin Wizard")),
        (None, "contributors", ("OTHER", "")),
        (None, "performers", ("PERFORMER", "")),
    ],
)
def test_tag_to_role_table(tag, field, expected):
    assert resolve_role(tag, field) == expected


@pytest.mark.unit
def test_role_map_overrides_and_skip():
    assert resolve_role("Executiveproducer", "contributors", {"executiveproducer": "PRODUCER"}) == (
        "PRODUCER",
        "Executiveproducer",
    )
    assert resolve_role("Tuba", "performers", {"tuba": SKIP_ROLE}) == (SKIP_ROLE, "")
    assert resolve_role(None, "contributors", {"": "PRODUCER"}) == ("PRODUCER", "")


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
        # One credit per (person, role): both assistant tags merged
        ("Ana", "ASSISTANT_ENGINEER"): "AssistantMixingEngineer, AssistantRecordingEngineer",
        ("Luis", "EXECUTIVE_PRODUCER"): "",
        ("Zoe", "OTHER"): "Weird Thing",
        ("Pepe", "OTHER"): "",
        ("Juan", "PERFORMER"): "Tuba, Chorus",
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
    _run(workspace, rows, {"track.title": "Title", "performers": "Musicians"})
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
