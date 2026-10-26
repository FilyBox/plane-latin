# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Credit roles in catalog spreadsheets, and spotting near-duplicate names.

Distributor exports tag every credited person with a role:
``Sergio Vazquez <MixingEngineer>, Ana <Tuba>``. ``TAG_ROLES`` turns those
tags into ``MusicCredit.Role`` values; the original tag is kept as the
credit's ``role_detail`` whenever it says more than the role itself.

``name_key`` / ``similar_names`` power the import's "this value already
exists" warning: "Virgin" typed by hand vs. "VirginAgregadora" in the catalog.
"""

import re
import unicodedata
from difflib import SequenceMatcher

# Sentinel for a role-map entry: names with that tag are not imported.
SKIP_ROLE = "__SKIP__"

# Role values (MusicCredit.Role); plain strings so this module stays free of
# model imports and is trivially testable.
PRIMARY_ARTIST = "PRIMARY_ARTIST"
FEATURED_ARTIST = "FEATURED_ARTIST"
PERFORMER = "PERFORMER"
AUTHOR = "AUTHOR"
COMPOSER = "COMPOSER"
WRITER = "WRITER"
PUBLISHER = "PUBLISHER"
PRODUCER = "PRODUCER"
AUDIO_PRODUCER = "AUDIO_PRODUCER"
RECORDING_ENGINEER = "RECORDING_ENGINEER"
MIXER = "MIXER"
MASTERING_ENGINEER = "MASTERING_ENGINEER"
LEGAL_REPRESENTATIVE = "LEGAL_REPRESENTATIVE"
LABEL_MANAGER = "LABEL_MANAGER"
EXECUTIVE_PRODUCER = "EXECUTIVE_PRODUCER"
CO_PRODUCER = "CO_PRODUCER"
VOCAL_PRODUCER = "VOCAL_PRODUCER"
ASSISTANT_PRODUCER = "ASSISTANT_PRODUCER"
A_AND_R = "A_AND_R"
MUSICAL_DIRECTOR = "MUSICAL_DIRECTOR"
ARRANGER = "ARRANGER"
ASSISTANT_ENGINEER = "ASSISTANT_ENGINEER"
SOUND_ENGINEER = "SOUND_ENGINEER"
SOUND_EDITOR = "SOUND_EDITOR"
VIDEO_PRODUCER = "VIDEO_PRODUCER"
VIDEO_DIRECTOR = "VIDEO_DIRECTOR"
OTHER = "OTHER"

# Instruments and voices: a performer credit whose detail is the instrument.
INSTRUMENT_TAGS = (
    "vocals", "leadvocals", "vocal", "voice", "voz", "backgroundvocals", "backingvocals", "harmonyvocals",
    "chorus", "choir", "coros", "rap", "rapper", "guitar", "acousticguitar", "electricguitar", "bassguitar",
    "bass", "doublebass", "keyboardbass", "electricbass", "drums", "drumprogramming", "programming",
    "percussion", "congas", "bongos", "timbales", "cajon", "tambora", "accordion", "bajoquinto", "bajosexto",
    "tololoche", "requinto", "vihuela", "guitarron", "tuba", "sousaphone", "trumpet", "trombone",
    "saxophone", "altosaxophone", "tenorsaxophone", "clarinet", "flute", "althorn", "altohorn", "horn",
    "frenchhorn", "violin", "firstviolin", "secondviolin", "viola", "cello", "harp", "piano", "keyboards",
    "keyboard", "organ", "synthesizer", "synth", "strings", "brass", "ukulele", "mandolin", "banjo",
    "harmonica", "marimba", "vibraphone", "turntables", "dj", "samples", "orchestra", "ensemble",
    "conductor", "instrumentalist", "musician", "snaredrum", "bassdrum", "drummachine", "cymbals",
    "leadguitar", "rhythmguitar", "steelguitar", "slideguitar", "classicalguitar", "twelvestringguitar",
    "electricpiano", "rhodes", "beatbox", "whistle", "trompeta", "acordeon", "bateria", "guitarra", "bajo",
    "percusion", "teclados", "saxofon", "clarinete", "trombon", "violin", "coro",
)

# Normalized tag (lowercase, letters only) -> role. "A&R" normalizes to "ar".
TAG_ROLES = {
    # Artists
    "primaryartist": PRIMARY_ARTIST, "mainartist": PRIMARY_ARTIST, "artist": PRIMARY_ARTIST,
    "featuredartist": FEATURED_ARTIST, "featuring": FEATURED_ARTIST, "featured": FEATURED_ARTIST,
    "performer": PERFORMER, "performingartist": PERFORMER,
    # Writing
    "lyricist": AUTHOR, "author": AUTHOR, "librettist": AUTHOR, "textwriter": AUTHOR, "letrista": AUTHOR,
    "composer": COMPOSER, "compositor": COMPOSER,
    "writer": WRITER, "songwriter": WRITER, "composerlyricist": WRITER, "autor": WRITER,
    "publisher": PUBLISHER, "musicpublisher": PUBLISHER, "originalpublisher": PUBLISHER,
    "subpublisher": PUBLISHER, "editor": PUBLISHER, "editora": PUBLISHER,
    # Production
    "producer": PRODUCER, "productor": PRODUCER, "musicproducer": PRODUCER, "recordproducer": PRODUCER,
    "executiveproducer": EXECUTIVE_PRODUCER, "productorejecutivo": EXECUTIVE_PRODUCER,
    "coproducer": CO_PRODUCER, "coproductor": CO_PRODUCER,
    "vocalproducer": VOCAL_PRODUCER,
    "assistantproducer": ASSISTANT_PRODUCER, "associateproducer": ASSISTANT_PRODUCER,
    "additionalproducer": ASSISTANT_PRODUCER,
    "audioproducer": AUDIO_PRODUCER,
    "ar": A_AND_R, "aandr": A_AND_R, "anr": A_AND_R, "artistsandrepertoire": A_AND_R,
    "artistandrepertoire": A_AND_R, "armanager": A_AND_R,
    "musicaldirector": MUSICAL_DIRECTOR, "musicdirector": MUSICAL_DIRECTOR, "directormusical": MUSICAL_DIRECTOR,
    "arranger": ARRANGER, "vocalarranger": ARRANGER, "stringarranger": ARRANGER, "hornarranger": ARRANGER,
    "musicarranger": ARRANGER, "orchestrator": ARRANGER, "arreglista": ARRANGER, "arreglos": ARRANGER,
    # Engineering
    "recordingengineer": RECORDING_ENGINEER, "engineer": RECORDING_ENGINEER, "recording": RECORDING_ENGINEER,
    "trackingengineer": RECORDING_ENGINEER, "vocalengineer": RECORDING_ENGINEER,
    "ingenierodegrabacion": RECORDING_ENGINEER,
    "mixingengineer": MIXER, "mixer": MIXER, "mixing": MIXER, "mixengineer": MIXER, "mezcla": MIXER,
    "masteringengineer": MASTERING_ENGINEER, "mastering": MASTERING_ENGINEER, "masterizacion": MASTERING_ENGINEER,
    "assistantengineer": ASSISTANT_ENGINEER, "assistantrecordingengineer": ASSISTANT_ENGINEER,
    "assistantmixingengineer": ASSISTANT_ENGINEER, "assistantmasteringengineer": ASSISTANT_ENGINEER,
    "assistantsoundengineer": ASSISTANT_ENGINEER, "assistantmixer": ASSISTANT_ENGINEER,
    "secondengineer": ASSISTANT_ENGINEER,
    "soundengineer": SOUND_ENGINEER, "audioengineer": SOUND_ENGINEER, "livesoundengineer": SOUND_ENGINEER,
    "soundeditor": SOUND_EDITOR, "audioeditor": SOUND_EDITOR, "editingengineer": SOUND_EDITOR,
    # Video
    "videoproducer": VIDEO_PRODUCER,
    "videodirector": VIDEO_DIRECTOR, "filmdirector": VIDEO_DIRECTOR, "director": VIDEO_DIRECTOR,
    # Business
    "legalrepresentative": LEGAL_REPRESENTATIVE, "labelmanager": LABEL_MANAGER,
    **{tag: PERFORMER for tag in INSTRUMENT_TAGS},
}

# Tags that are just another name for their role: the role says it all, so
# no detail is stored ("MixingEngineer" -> MIXER). Any other tag is kept as
# the credit's detail ("AssistantMixingEngineer", "Tuba", "Librettist").
PLAIN_TAGS = {
    "primaryartist", "mainartist", "artist", "featuredartist", "featuring", "featured", "performer",
    "lyricist", "author", "letrista", "composer", "compositor", "writer", "songwriter", "autor",
    "publisher", "musicpublisher", "editor", "editora",
    "producer", "productor", "musicproducer", "recordproducer", "executiveproducer", "productorejecutivo",
    "coproducer", "coproductor", "vocalproducer", "assistantproducer", "audioproducer",
    "ar", "aandr", "anr", "artistsandrepertoire", "artistandrepertoire",
    "musicaldirector", "musicdirector", "directormusical", "arranger", "arreglista", "arreglos",
    "recordingengineer", "engineer", "recording", "ingenierodegrabacion", "mixingengineer", "mixer", "mixing",
    "mixengineer", "mezcla", "masteringengineer", "mastering", "masterizacion", "assistantengineer",
    "soundengineer", "audioengineer", "soundeditor", "audioeditor", "videoproducer", "videodirector",
    "director", "legalrepresentative", "labelmanager",
}

# Credit fields whose cells carry tagged names with ANY role.
TAGGED_CREDIT_FIELDS = ("contributors", "performers")

# Collection societies / PROs tag publishers ("Top Music <ASCAP>"), not roles.
TAG = re.compile(r"<([^<>]*)>")
_TRAILING_TAG = re.compile(r"\s*<([^<>]*)>\s*$")
# Separators between untagged names (same as the artist splitter)
_NAME_SEPARATOR = re.compile(
    r"\s*(?:;|\||,|&|\band\b|\by\b|\bfeat(?:uring)?\.?\b|\bf\.?t\.?[,]?\b)\s*",
    re.IGNORECASE,
)
# "Latin Power Music, Inc": a company suffix after a comma is part of the name
_COMPANY_SUFFIX = re.compile(
    r"^(?:inc|llc|ltd|limited|corp|co|s\.?\s?a\.?(?:\s+de\s+c\.?\s?v\.?)?|s\.?\s?l\.?|s\.?\s?de\s+r\.?\s?l\.?.*|"
    r"gmbh|sas|srl|plc|lp|llp)\.?$",
    re.IGNORECASE,
)


def normalize_tag(tag):
    """"Mixing Engineer", "<MixingEngineer>", "mixing-engineer" -> "mixingengineer"."""
    return re.sub(r"[^a-z]", "", _plain(tag))


def _plain(value):
    return "".join(
        char for char in unicodedata.normalize("NFKD", str(value or "").lower()) if not unicodedata.combining(char)
    )


def _clean_name(name):
    return str(name or "").strip(" .,;|\t\r\n")


def split_untagged(text):
    """Names in untagged text (commas, "&", "y", "feat."…), without repeats,
    keeping company suffixes attached ("Latin Power Music, Inc")."""
    names = []
    for part in _NAME_SEPARATOR.split(str(text or "")):
        name = _clean_name(part)
        if not name:
            continue
        if names and _COMPANY_SUFFIX.match(name):
            names[-1] = f"{names[-1]}, {name}"
            continue
        if name.lower() not in (existing.lower() for existing in names):
            names.append(name)
    return names


def tagged_entries(text):
    """[(name, tag | None)] for a cell such as ``Ana <Lyricist>, Ana <Composer>,
    Luis``. Tagged entries are split at the tag boundaries only, so names
    with commas or "y" survive ("Latin Power Music, Inc <TBD>"); untagged
    stretches are split like any artist list. A name may appear several
    times with different tags."""
    text = str(text or "")
    if not TAG.search(text):
        return [(name, None) for name in split_untagged(text)]
    entries = []
    for segment in re.split(r"(?<=>)\s*[,;|]?\s*", text):
        if not segment.strip():
            continue
        match = _TRAILING_TAG.search(segment)
        if not match:
            entries.extend((name, None) for name in split_untagged(segment))
            continue
        tag = match.group(1).strip()
        # Everything since the previous tag is the name, commas included
        # ("Latin Power Music, Inc <TBD>", "Abelardo Rivera Levy, <Engineer>").
        name = _clean_name(re.sub(r"\s+", " ", segment[: match.start()]))
        if name:
            entries.append((name, tag or None))
    return entries


def default_role(tag, field="contributors"):
    """The role a tag means by default, or None when the table doesn't know it."""
    if tag is None:
        return None
    return TAG_ROLES.get(normalize_tag(tag))


def resolve_role(tag, field="contributors", role_map=None):
    """(role, detail) for one tagged name in a contributors/performers cell, or
    (SKIP_ROLE, "") when the user chose not to import that tag.

    The user's role map (normalized tag -> role) wins over the table. Unknown
    tags become OTHER (PERFORMER in a performers column) and keep the tag as
    detail; untagged names are OTHER/PERFORMER without detail (role-map key "").
    """
    key = normalize_tag(tag) if tag else ""
    fallback = PERFORMER if field == "performers" else OTHER
    table_role = TAG_ROLES.get(key) if key else None
    chosen = (role_map or {}).get(key)
    role = chosen or table_role or fallback
    if role == SKIP_ROLE:
        return SKIP_ROLE, ""
    if not tag:
        return role, ""
    # The tag adds nothing when it's a plain name for the final role.
    plain = key in PLAIN_TAGS and table_role == role
    return role, "" if plain else str(tag).strip()[:120]


def merge_details(*values, limit=120):
    """Joins details ("Tuba", "Chorus, Tuba") without repeats, ignoring case."""
    merged = []
    for value in values:
        for part in str(value or "").split(","):
            item = part.strip()
            if item and item.lower() not in (existing.lower() for existing in merged):
                merged.append(item)
    text = ", ".join(merged)
    return text if len(text) <= limit else text[: limit - 1].rstrip(", ") + "…"


def tag_counts(values):
    """{normalized_tag: {"tag": most common spelling, "count": mentions}} over
    cells, plus "" for untagged names."""
    counts = {}
    for value in values:
        for _name, tag in tagged_entries(value):
            key = normalize_tag(tag) if tag else ""
            entry = counts.setdefault(key, {"tag": tag or "", "count": 0, "spellings": {}})
            entry["count"] += 1
            if tag:
                entry["spellings"][tag] = entry["spellings"].get(tag, 0) + 1
    for entry in counts.values():
        spellings = entry.pop("spellings")
        if spellings:
            entry["tag"] = max(spellings.items(), key=lambda item: item[1])[0]
    return counts


# ── Near-duplicate names ────────────────────────────────────────────────────

# Words that don't tell two companies apart ("Virgin" == "Virgin Agregadora").
# Long ones are stripped even when glued to the name ("VirginAgregadora").
_GLUED_SUFFIXES = (
    "agregadora", "agregador", "aggregator", "aggregation", "distribuidora", "distribuidor", "distribution",
    "distributor", "distribucion", "records", "record", "recordings", "discos", "disquera", "musica", "music",
    "musique", "publishing", "publisher", "editorial", "ediciones", "edicionesmusicales", "entertainment",
    "entretenimiento", "producciones", "productions", "label", "group", "grupo", "studios", "studio",
    "company", "management",
)
_WORD_SUFFIXES = {
    "sa", "de", "cv", "rl", "s", "a", "c", "v", "r", "l", "inc", "llc", "ltd", "limited", "corp", "corporation",
    "co", "sl", "sas",
    "srl", "gmbh", "plc", "lp", "llp", "the", "la", "el", "los", "las",
}


def name_key(value):
    """Comparable form of a name: lowercase, no accents/punctuation/spaces,
    without company boilerplate. Never empty for a non-empty name."""
    words = re.findall(r"[a-z0-9]+", _plain(value))
    compact_all = "".join(words)
    while words and words[-1] in _WORD_SUFFIXES:
        words.pop()
    while words and words[0] in ("the", "la", "el", "los", "las"):
        words.pop(0)
    compact = "".join(words)
    changed = True
    while changed:
        changed = False
        for suffix in _GLUED_SUFFIXES:
            if compact.endswith(suffix) and len(compact) - len(suffix) >= 3:
                compact = compact[: -len(suffix)]
                changed = True
    return compact or compact_all


def similarity(a, b):
    """0..1 — how likely two names are the same thing."""
    key_a, key_b = name_key(a), name_key(b)
    if not key_a or not key_b:
        return 0.0
    if key_a == key_b:
        return 1.0
    shorter, longer = sorted((key_a, key_b), key=len)
    if len(shorter) >= 4 and longer.startswith(shorter):
        return 0.9
    if len(shorter) >= 5 and shorter in longer:
        return 0.85
    return SequenceMatcher(None, key_a, key_b).ratio()


def similar_names(query, candidates, threshold=0.8, limit=5):
    """Candidates that look like the same thing as `query`, best first —
    except an exact (case-insensitive) match, which is not a "similar" one.
    `candidates` are strings or (name, payload) pairs."""
    query = str(query or "").strip()
    if not query:
        return []
    scored = []
    for candidate in candidates:
        name, payload = candidate if isinstance(candidate, tuple) else (candidate, None)
        if str(name).strip().lower() == query.lower():
            continue
        score = similarity(query, name)
        if score >= threshold:
            scored.append((score, name, payload))
    scored.sort(key=lambda item: (-item[0], str(item[1]).lower()))
    return scored[:limit]
