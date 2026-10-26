# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Credit roles in catalog spreadsheets, and spotting near-duplicate names.

Distributor exports tag every credited person with a role:
``Sergio Vazquez <MixingEngineer>, Ana <Tuba>``. A credit's role is a KEY:
one of the built-in roles below, or a role the workspace created
(``MusicCreditRole``). Roles follow the file, not the other way round: a tag
that is just another name for a role that already exists uses it
("MixingEngineer" -> MIXER); any other tag becomes a role of its own, named
after the tag ("LeadVocals" -> LEAD_VOCALS "Lead Vocals"), created when the
import is applied. Labels stay in the source's words (distributors export in
English) and are never translated, so exporting them back still matches.

``name_key`` / ``similar_names`` power the import's "this value already
exists" warning: "Virgin" typed by hand vs. "VirginAgregadora" in the catalog.
"""

import re
import unicodedata
from difflib import SequenceMatcher

# Sentinel for a role-map entry: names with that tag are not imported.
SKIP_ROLE = "__SKIP__"

# Built-in role keys (stored in MusicCredit.role); plain strings so this
# module stays free of model imports and is trivially testable.
PRIMARY_ARTIST = "PRIMARY_ARTIST"
FEATURED_ARTIST = "FEATURED_ARTIST"
PERFORMER = "PERFORMER"
AUTHOR = "AUTHOR"
LYRICIST = "LYRICIST"
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

# Categories only group roles in pickers and filters (MusicCreditRole.Category).
ARTIST_CATEGORY = "ARTIST"
WRITER_CATEGORY = "WRITER"
PUBLISHER_CATEGORY = "PUBLISHER"
PRODUCER_CATEGORY = "PRODUCER"
ENGINEER_CATEGORY = "ENGINEER"
PERFORMER_CATEGORY = "PERFORMER"
VIDEO_CATEGORY = "VIDEO"
MANAGEMENT_CATEGORY = "MANAGEMENT"
OTHER_CATEGORY = "OTHER"
CATEGORIES = (
    ARTIST_CATEGORY, WRITER_CATEGORY, PUBLISHER_CATEGORY, PRODUCER_CATEGORY, ENGINEER_CATEGORY,
    PERFORMER_CATEGORY, VIDEO_CATEGORY, MANAGEMENT_CATEGORY, OTHER_CATEGORY,
)

# key -> (label, category). Labels in English, as distributors name them.
BUILTIN_ROLES = {
    PRIMARY_ARTIST: ("Primary Artist", ARTIST_CATEGORY),
    FEATURED_ARTIST: ("Featured Artist", ARTIST_CATEGORY),
    PERFORMER: ("Performer", PERFORMER_CATEGORY),
    WRITER: ("Writer", WRITER_CATEGORY),
    AUTHOR: ("Author", WRITER_CATEGORY),
    LYRICIST: ("Lyricist", WRITER_CATEGORY),
    COMPOSER: ("Composer", WRITER_CATEGORY),
    PUBLISHER: ("Publisher", PUBLISHER_CATEGORY),
    PRODUCER: ("Producer", PRODUCER_CATEGORY),
    EXECUTIVE_PRODUCER: ("Executive Producer", PRODUCER_CATEGORY),
    CO_PRODUCER: ("Co-Producer", PRODUCER_CATEGORY),
    VOCAL_PRODUCER: ("Vocal Producer", PRODUCER_CATEGORY),
    ASSISTANT_PRODUCER: ("Assistant Producer", PRODUCER_CATEGORY),
    AUDIO_PRODUCER: ("Audio Producer", PRODUCER_CATEGORY),
    MUSICAL_DIRECTOR: ("Musical Director", PRODUCER_CATEGORY),
    ARRANGER: ("Arranger", PRODUCER_CATEGORY),
    RECORDING_ENGINEER: ("Recording Engineer", ENGINEER_CATEGORY),
    MIXER: ("Mixing Engineer", ENGINEER_CATEGORY),
    MASTERING_ENGINEER: ("Mastering Engineer", ENGINEER_CATEGORY),
    ASSISTANT_ENGINEER: ("Assistant Engineer", ENGINEER_CATEGORY),
    SOUND_ENGINEER: ("Sound Engineer", ENGINEER_CATEGORY),
    SOUND_EDITOR: ("Sound Editor", ENGINEER_CATEGORY),
    VIDEO_PRODUCER: ("Video Producer", VIDEO_CATEGORY),
    VIDEO_DIRECTOR: ("Video Director", VIDEO_CATEGORY),
    A_AND_R: ("A&R", MANAGEMENT_CATEGORY),
    LEGAL_REPRESENTATIVE: ("Legal Representative", MANAGEMENT_CATEGORY),
    LABEL_MANAGER: ("Label Manager", MANAGEMENT_CATEGORY),
    OTHER: ("Other", OTHER_CATEGORY),
}

# Other spellings of a built-in role: tags that MEAN exactly that role
# (normalized: lowercase, letters only). A role's own key and label already
# match ("MixingEngineer" == "Mixing Engineer", "AR" == "A&R"); anything more
# specific ("AssistantMixingEngineer", "VocalArranger", "FilmDirector") is a
# role of its own, never folded into a broader one.
SYNONYMS = {
    "mainartist": PRIMARY_ARTIST, "artist": PRIMARY_ARTIST, "artistaprincipal": PRIMARY_ARTIST,
    "featuring": FEATURED_ARTIST, "featured": FEATURED_ARTIST, "artistainvitado": FEATURED_ARTIST,
    "performingartist": PERFORMER, "interprete": PERFORMER,
    "songwriter": WRITER, "composerlyricist": WRITER, "autor": WRITER,
    "letrista": LYRICIST,
    "compositor": COMPOSER,
    "musicpublisher": PUBLISHER, "editora": PUBLISHER,
    "productor": PRODUCER, "musicproducer": PRODUCER, "recordproducer": PRODUCER,
    "productorejecutivo": EXECUTIVE_PRODUCER,
    "coproductor": CO_PRODUCER,
    "aandr": A_AND_R, "anr": A_AND_R, "artistsandrepertoire": A_AND_R, "artistandrepertoire": A_AND_R,
    "musicdirector": MUSICAL_DIRECTOR, "directormusical": MUSICAL_DIRECTOR,
    "musicarranger": ARRANGER, "arreglista": ARRANGER,
    "ingenierodegrabacion": RECORDING_ENGINEER,
    "mixing": MIXER, "mixengineer": MIXER, "mezcla": MIXER, "ingenierodemezcla": MIXER,
    "mastering": MASTERING_ENGINEER, "masterizacion": MASTERING_ENGINEER,
    "ingenierodemasterizacion": MASTERING_ENGINEER,
    "ingenierodesonido": SOUND_ENGINEER,
}

# Instruments and voices: roles of their own in the PERFORMER category.
INSTRUMENT_TAGS = frozenset((
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
    "percusion", "teclados", "saxofon", "clarinete", "trombon", "coro",
))

# Category of a NEW role, guessed from words in its tag (first hit wins).
_CATEGORY_HINTS = (
    (("video", "film", "cinemat", "camera"), VIDEO_CATEGORY),
    (("engineer", "mix", "master", "sound", "audio", "recording", "ingeniero", "tecnico"), ENGINEER_CATEGORY),
    (("produc", "arrang", "arregl", "director", "orchestrat", "programmer"), PRODUCER_CATEGORY),
    (("writer", "lyric", "librett", "compos", "author", "autor", "letr", "poet"), WRITER_CATEGORY),
    (("publish", "editor", "edicion"), PUBLISHER_CATEGORY),
    (("manag", "legal", "lawyer", "agent", "booking", "label"), MANAGEMENT_CATEGORY),
    (
        (
            "vocal", "voice", "voz", "sing", "guitar", "drum", "bass", "piano", "violin", "horn", "sax",
            "keyboard", "percussion", "chorus", "choir", "trumpet", "flute", "string", "organ", "synth",
        ),
        PERFORMER_CATEGORY,
    ),
    (("artist",), ARTIST_CATEGORY),
)

# Credit fields whose cells carry tagged names with ANY role.
TAGGED_CREDIT_FIELDS = ("contributors", "performers")

# A role key: what MusicCredit.role stores (built-in or workspace-defined).
ROLE_KEY = re.compile(r"^[A-Z0-9_]{1,40}$")

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


def _camel_words(token):
    """"LeadVocals" -> ["Lead", "Vocals"], "DJRemix" -> ["DJ", "Remix"]."""
    words, current = [], ""
    for index, char in enumerate(token):
        if not char.isalnum():
            if current:
                words.append(current)
                current = ""
            continue
        if current:
            previous = token[index - 1]
            following = token[index + 1] if index + 1 < len(token) else ""
            if char.isupper() and (
                previous.islower() or previous.isdigit() or (previous.isupper() and following.islower())
            ):
                words.append(current)
                current = ""
        current += char
    if current:
        words.append(current)
    return words


def humanize_tag(tag):
    """The label of a role named after a tag, in the tag's own words:
    "LeadVocals" -> "Lead Vocals", "BajoQuinto" -> "Bajo Quinto", "bass" ->
    "Bass". Tags already written with spaces or symbols ("A&R", "Composer /
    Lyricist") keep them."""
    text = " ".join(str(tag or "").split()).strip(" .,;:")
    if not text:
        return ""
    words = text.split(" ") if re.search(r"[^\w]", text) else _camel_words(text)
    label = " ".join(word[:1].upper() + word[1:] if word.islower() else word for word in words)
    return label[:120]


def humanize_key(key):
    """Readable fallback for a key without a label: "LEAD_VOCALS" -> "Lead Vocals"."""
    return " ".join(part.capitalize() for part in str(key or "").split("_") if part) or str(key or "")


def role_key(label):
    """The key for a role label: "Lead Vocals" -> "LEAD_VOCALS"."""
    key = re.sub(r"[^A-Z0-9]+", "_", _plain(label).upper()).strip("_")
    return key[:40].rstrip("_") or "ROLE"


def guess_category(tag, field="contributors"):
    """Category of a new role named after `tag`. Unknown names in a
    performers column are PERFORMER, anywhere else OTHER."""
    key = normalize_tag(tag)
    if key in INSTRUMENT_TAGS:
        return PERFORMER_CATEGORY
    for hints, category in _CATEGORY_HINTS:
        if any(hint in key for hint in hints):
            return category
    return PERFORMER_CATEGORY if field == "performers" else OTHER_CATEGORY


def _category_order(category):
    return CATEGORIES.index(category) if category in CATEGORIES else len(CATEGORIES)


class RoleCatalog:
    """The roles a workspace has (built-in + its own) and the roles one
    import would add, with the tag -> role rules.

    `custom` holds the workspace's MusicCreditRole rows as dicts (key, label,
    category, source_tags). A tag matches a role by the role's key, its label
    or a tag seen for it before (all normalized), and built-in roles by their
    SYNONYMS too. `describe` registers the new roles it proposes in
    `planned`, so a role map may send a tag to a role that another tag of
    the same file creates.
    """

    def __init__(self, custom=()):
        self.roles = {}
        self._by_tag = {}
        for key, (label, category) in BUILTIN_ROLES.items():
            self.roles[key] = {"key": key, "label": label, "category": category, "builtin": True}
            self._index(key, normalize_tag(key), normalize_tag(label))
        for tag, key in SYNONYMS.items():
            self._index(key, tag)
        for role in custom:
            key = role["key"]
            if key in self.roles:
                continue
            self.roles[key] = {
                "key": key,
                "label": role.get("label") or humanize_key(key),
                "category": role.get("category") or OTHER_CATEGORY,
                "builtin": False,
            }
            self._index(
                key,
                normalize_tag(key),
                normalize_tag(role.get("label")),
                *(normalize_tag(tag) for tag in role.get("source_tags") or ()),
            )
        # key -> {"key", "label", "category", "tags": [spellings seen]}
        self.planned = {}

    def _index(self, key, *tags):
        for tag in tags:
            if tag:
                self._by_tag.setdefault(tag, key)

    def match(self, tag):
        """The existing role a tag means, or None."""
        return self._by_tag.get(normalize_tag(tag)) if tag else None

    def exists(self, key):
        return key in self.roles

    def is_known(self, key):
        """An existing role or one this import creates."""
        return key in self.roles or key in self.planned

    def label(self, key):
        role = self.roles.get(key) or self.planned.get(key)
        return role["label"] if role else humanize_key(key)

    def category(self, key):
        role = self.roles.get(key) or self.planned.get(key)
        return role["category"] if role else OTHER_CATEGORY

    def _described(self, key, is_new=False):
        return {"key": key, "label": self.label(key), "category": self.category(key), "is_new": is_new}

    def describe(self, tag, field="contributors"):
        """{"key", "label", "category", "is_new"}: the role a tagged name
        imports as by default. Untagged names are OTHER (PERFORMER in a
        performers column)."""
        if not tag or not str(tag).strip():
            return self._described(PERFORMER if field == "performers" else OTHER)
        key = self.match(tag)
        if key:
            return self._described(key)
        label = humanize_tag(tag)
        key = role_key(label)
        if key in self.roles:
            return self._described(key)
        plan = self.planned.setdefault(
            key, {"key": key, "label": label, "category": guess_category(tag, field), "tags": []}
        )
        spelling = str(tag).strip()[:120]
        if spelling not in plan["tags"]:
            plan["tags"].append(spelling)
        return self._described(key, is_new=True)

    def resolve(self, tag, field="contributors", role_map=None):
        """(role key, detail) for one tagged name in a contributors/performers
        cell, or (SKIP_ROLE, "") when the user chose not to import that tag.

        The user's role map (normalized tag -> key) wins when it names a known
        role; sending a tag into a role other than its own keeps the tag as
        the credit's detail ("Executiveproducer" imported as PRODUCER)."""
        default = self.describe(tag, field)
        chosen = (role_map or {}).get(normalize_tag(tag) if tag else "")
        if chosen == SKIP_ROLE:
            return SKIP_ROLE, ""
        if chosen and chosen != default["key"] and self.is_known(chosen):
            return chosen, str(tag).strip()[:120] if tag else ""
        return default["key"], ""

    def options(self):
        """Every existing role for pickers: by category, built-in first."""
        return sorted(
            self.roles.values(),
            key=lambda role: (_category_order(role["category"]), not role["builtin"], role["label"].lower()),
        )


def workspace_role_catalog(workspace_id):
    """RoleCatalog with the workspace's own roles (lazy model import)."""
    from plane.db.models import MusicCreditRole

    return RoleCatalog(
        MusicCreditRole.objects.filter(workspace_id=workspace_id).values("key", "label", "category", "source_tags")
    )


# ── Exporting tagged credits ────────────────────────────────────────────────

# How distributor files spell the built-in roles ("Executiveproducer" and "AR"
# as their exports write them). Every other built-in role is its label in
# CamelCase. All of them read back as the same role (see RoleCatalog.match).
EXPORT_TAGS = {
    PRIMARY_ARTIST: "PrimaryArtist",
    FEATURED_ARTIST: "FeaturedArtist",
    LYRICIST: "Lyricist",
    COMPOSER: "Composer",
    EXECUTIVE_PRODUCER: "Executiveproducer",
    CO_PRODUCER: "CoProducer",
    VOCAL_PRODUCER: "VocalProducer",
    ASSISTANT_PRODUCER: "AssistantProducer",
    MUSICAL_DIRECTOR: "MusicalDirector",
    RECORDING_ENGINEER: "RecordingEngineer",
    MIXER: "MixingEngineer",
    MASTERING_ENGINEER: "MasteringEngineer",
    SOUND_ENGINEER: "SoundEngineer",
    SOUND_EDITOR: "SoundEditor",
    VIDEO_PRODUCER: "VideoProducer",
    A_AND_R: "AR",
}


def camel_tag(label):
    """A role label as a tag without spaces or symbols: "Bajo Quinto" ->
    "BajoQuinto", "Co-Producer" -> "CoProducer", "A&R" -> "AR"."""
    words = re.findall(r"[^\W_]+", str(label or ""))
    return "".join(word[:1].upper() + word[1:] for word in words)


def _clean_tag(tag):
    return re.sub(r"[<>]", "", str(tag or "")).strip(" .,;")


def _clean_export_name(name):
    # "<" and ">" would read as a tag when the file comes back
    return re.sub(r"\s+", " ", str(name or "").replace("<", "(").replace(">", ")")).strip()


class CreditTagger:
    """The tag each credit is exported with, in the source file's spelling.

    A workspace role uses the first tag it was imported from (source_tags),
    a built-in role its distributor spelling; a credit whose original tag was
    kept as its detail (imported into another role) exports that tag, one
    entry per tag when it holds several ("Tuba, Chorus").
    """

    def __init__(self, custom=()):
        self._tags = {}
        self._categories = {}
        for key, (label, category) in BUILTIN_ROLES.items():
            self._tags[key] = EXPORT_TAGS.get(key) or camel_tag(label)
            self._categories[key] = category
        for role in custom:
            key = role["key"]
            if key in self._tags:
                continue
            source = next((_clean_tag(tag) for tag in role.get("source_tags") or () if _clean_tag(tag)), "")
            self._tags[key] = source or camel_tag(role.get("label") or humanize_key(key))
            self._categories[key] = role.get("category") or OTHER_CATEGORY

    def category(self, key):
        return self._categories.get(key, OTHER_CATEGORY)

    def tags_for(self, key, detail=""):
        details = [_clean_tag(part) for part in str(detail or "").replace("…", "").split(",")]
        details = [tag for tag in details if tag]
        if details:
            return details
        return [self._tags.get(key) or camel_tag(humanize_key(key))]


def workspace_credit_tagger(workspace_id):
    """CreditTagger with the workspace's own roles (lazy model import)."""
    from plane.db.models import MusicCreditRole

    return CreditTagger(
        MusicCreditRole.objects.filter(workspace_id=workspace_id).values("key", "label", "category", "source_tags")
    )


def format_tagged(entries):
    """``Ana <Lyricist>, Ana <Composer>`` for [(name, tag)], one entry per
    person and tag, as distributor files write credits."""
    parts = []
    for name, tag in entries:
        name = _clean_export_name(name)
        if not name:
            continue
        parts.append(f"{name} <{tag}>" if tag else name)
    return ", ".join(parts)


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


def resolve_role(tag, field="contributors", role_map=None, catalog=None):
    """(role key, detail) for one tagged name; see RoleCatalog.resolve."""
    return (catalog or RoleCatalog()).resolve(tag, field, role_map)


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
