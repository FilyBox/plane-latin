# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

from django.db import models
from django.db.models import Q

from .base import BaseModel


class MusicParty(BaseModel):
    """A person, artist, group, or organization credited in the catalog."""

    class Kind(models.TextChoices):
        ARTIST = "ARTIST", "Artist"
        GROUP = "GROUP", "Group"
        PERSON = "PERSON", "Person"
        ORGANIZATION = "ORGANIZATION", "Organization"

    workspace = models.ForeignKey("db.Workspace", on_delete=models.CASCADE, related_name="music_parties")
    kind = models.CharField(max_length=20, choices=Kind.choices, default=Kind.ARTIST)
    display_name = models.CharField(max_length=255)
    legal_name = models.CharField(max_length=255, blank=True)
    email = models.EmailField(blank=True)
    phone = models.CharField(max_length=80, blank=True)
    country = models.CharField(max_length=2, blank=True)
    website = models.URLField(blank=True)
    ipi_cae = models.CharField(max_length=32, blank=True)
    isni = models.CharField(max_length=32, blank=True)
    performing_rights_organization = models.CharField(max_length=120, blank=True)
    avatar_url = models.TextField(blank=True)
    notes = models.TextField(blank=True)
    identifiers = models.JSONField(default=dict, blank=True)
    disabled = models.BooleanField(default=False)

    class Meta:
        db_table = "music_parties"
        ordering = ("display_name",)
        indexes = [models.Index(fields=["workspace", "kind", "display_name"], name="music_party_lookup_idx")]


class MusicGenre(BaseModel):
    workspace = models.ForeignKey("db.Workspace", on_delete=models.CASCADE, related_name="music_genres")
    name = models.CharField(max_length=120)

    class Meta:
        db_table = "music_genres"
        ordering = ("name",)
        constraints = [
            models.UniqueConstraint(
                fields=["workspace", "name"],
                condition=Q(deleted_at__isnull=True),
                name="unique_music_genre_per_workspace",
            )
        ]


class MusicCompany(BaseModel):
    class Kind(models.TextChoices):
        AGGREGATOR = "AGGREGATOR", "Aggregator"
        DISTRIBUTOR = "DISTRIBUTOR", "Distributor"
        RECORD_LABEL = "RECORD_LABEL", "Record label"
        PUBLISHER = "PUBLISHER", "Publisher"
        MANAGEMENT = "MANAGEMENT", "Management"
        OTHER = "OTHER", "Other"

    workspace = models.ForeignKey("db.Workspace", on_delete=models.CASCADE, related_name="music_companies")
    kind = models.CharField(max_length=30, choices=Kind.choices)
    name = models.CharField(max_length=255)
    country = models.CharField(max_length=2, blank=True)
    email = models.EmailField(blank=True)
    website = models.URLField(blank=True)
    notes = models.TextField(blank=True)

    class Meta:
        db_table = "music_companies"
        ordering = ("name",)
        constraints = [
            models.UniqueConstraint(
                fields=["workspace", "kind", "name"],
                condition=Q(deleted_at__isnull=True),
                name="unique_music_company_per_workspace",
            )
        ]


class MusicRelease(BaseModel):
    class Type(models.TextChoices):
        SINGLE = "SINGLE", "Single"
        EP = "EP", "EP"
        LP = "LP", "LP"
        ALBUM = "ALBUM", "Album"
        COMPILATION = "COMPILATION", "Compilation"
        SOUNDTRACK = "SOUNDTRACK", "Soundtrack"

    class Status(models.TextChoices):
        DRAFT = "DRAFT", "Draft"
        SCHEDULED = "SCHEDULED", "Scheduled"
        RELEASED = "RELEASED", "Released"
        TAKEN_DOWN = "TAKEN_DOWN", "Taken down"

    workspace = models.ForeignKey("db.Workspace", on_delete=models.CASCADE, related_name="music_releases")
    title = models.CharField(max_length=500)
    version = models.CharField(max_length=255, blank=True)
    release_type = models.CharField(max_length=30, choices=Type.choices, default=Type.ALBUM)
    status = models.CharField(max_length=30, choices=Status.choices, default=Status.DRAFT)
    upc = models.CharField(max_length=32, blank=True, db_index=True)
    ean = models.CharField(max_length=32, blank=True)
    catalog_number = models.CharField(max_length=80, blank=True)
    original_release_date = models.DateField(null=True, blank=True)
    release_date = models.DateField(null=True, blank=True, db_index=True)
    copyright_year = models.PositiveSmallIntegerField(null=True, blank=True)
    p_line = models.CharField(max_length=500, blank=True)
    c_line = models.CharField(max_length=500, blank=True)
    label_name = models.CharField(max_length=255, blank=True)
    language = models.CharField(max_length=20, blank=True)
    cover_url = models.TextField(blank=True)
    territories = models.JSONField(default=list, blank=True)
    notes = models.TextField(blank=True)
    metadata = models.JSONField(default=dict, blank=True)
    artists = models.ManyToManyField("db.MusicParty", through="db.MusicReleaseArtist", related_name="music_releases")

    class Meta:
        db_table = "music_releases"
        ordering = ("-release_date", "title")
        indexes = [
            models.Index(fields=["workspace", "release_date"], name="music_release_date_idx"),
            models.Index(fields=["workspace", "upc"], name="music_release_upc_idx"),
        ]


class MusicTrack(BaseModel):
    class Kind(models.TextChoices):
        AUDIO = "AUDIO", "Audio"
        MUSIC_VIDEO = "MUSIC_VIDEO", "Music video"
        OTHER_VIDEO = "OTHER_VIDEO", "Other video"

    class Status(models.TextChoices):
        DRAFT = "DRAFT", "Draft"
        READY = "READY", "Ready"
        SCHEDULED = "SCHEDULED", "Scheduled"
        RELEASED = "RELEASED", "Released"
        TAKEN_DOWN = "TAKEN_DOWN", "Taken down"

    workspace = models.ForeignKey("db.Workspace", on_delete=models.CASCADE, related_name="music_tracks")
    parent_track = models.ForeignKey(
        "self",
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="videos",
        help_text="Audio recording this video belongs to.",
    )
    title = models.CharField(max_length=500)
    subtitle = models.CharField(max_length=255, blank=True)
    version = models.CharField(max_length=255, blank=True)
    kind = models.CharField(max_length=30, choices=Kind.choices, default=Kind.AUDIO)
    status = models.CharField(max_length=30, choices=Status.choices, default=Status.DRAFT)
    isrc = models.CharField(max_length=20, blank=True, db_index=True)
    isrc_video = models.CharField(max_length=20, blank=True, db_index=True)
    upc = models.CharField(max_length=32, blank=True)
    catalog = models.CharField(max_length=120, blank=True)
    duration_ms = models.PositiveIntegerField(null=True, blank=True)
    country_of_recording = models.CharField(max_length=2, blank=True)
    language = models.CharField(max_length=20, blank=True)
    recording_date = models.DateField(null=True, blank=True)
    original_release_date = models.DateField(null=True, blank=True)
    release_date = models.DateField(null=True, blank=True, db_index=True)
    explicit = models.BooleanField(default=False)
    instrumental = models.BooleanField(default=False)
    ownership = models.TextField(blank=True)
    us_publishing_obligations = models.TextField(blank=True)
    recoupment = models.TextField(blank=True)
    p_line = models.CharField(max_length=500, blank=True)
    digital_format = models.CharField(max_length=120, blank=True)
    tiktok_preview_start_ms = models.PositiveIntegerField(null=True, blank=True)
    tiktok_preview_end_ms = models.PositiveIntegerField(null=True, blank=True)
    lyrics = models.TextField(blank=True)
    audio_url = models.TextField(blank=True)
    cover_url = models.TextField(blank=True)
    aggregator_percentage = models.DecimalField(max_digits=7, decimal_places=4, null=True, blank=True)
    distributor_percentage = models.DecimalField(max_digits=7, decimal_places=4, null=True, blank=True)
    record_label_percentage = models.DecimalField(max_digits=7, decimal_places=4, null=True, blank=True)
    artist_percentage = models.DecimalField(max_digits=7, decimal_places=4, null=True, blank=True)
    writer_percentage = models.DecimalField(max_digits=7, decimal_places=4, null=True, blank=True)
    metadata = models.JSONField(default=dict, blank=True)
    releases = models.ManyToManyField("db.MusicRelease", through="db.MusicReleaseTrack", related_name="tracks")
    genres = models.ManyToManyField("db.MusicGenre", through="db.MusicTrackGenre", related_name="tracks")

    class Meta:
        db_table = "music_tracks"
        ordering = ("-release_date", "title")
        indexes = [
            models.Index(fields=["workspace", "release_date"], name="music_track_date_idx"),
            models.Index(fields=["workspace", "isrc"], name="music_track_isrc_idx"),
            models.Index(fields=["workspace", "parent_track", "kind"], name="music_video_parent_idx"),
        ]


class MusicReleaseArtist(BaseModel):
    class Role(models.TextChoices):
        PRIMARY = "PRIMARY", "Primary"
        FEATURED = "FEATURED", "Featured"

    workspace = models.ForeignKey("db.Workspace", on_delete=models.CASCADE, related_name="music_release_artists")
    release = models.ForeignKey("db.MusicRelease", on_delete=models.CASCADE, related_name="artist_links")
    party = models.ForeignKey("db.MusicParty", on_delete=models.CASCADE, related_name="release_links")
    role = models.CharField(max_length=20, choices=Role.choices, default=Role.PRIMARY)

    class Meta:
        db_table = "music_release_artists"
        constraints = [models.UniqueConstraint(fields=["release", "party", "role"], name="unique_music_release_artist")]


class MusicReleaseTrack(BaseModel):
    workspace = models.ForeignKey("db.Workspace", on_delete=models.CASCADE, related_name="music_release_tracks")
    release = models.ForeignKey("db.MusicRelease", on_delete=models.CASCADE, related_name="track_links")
    track = models.ForeignKey("db.MusicTrack", on_delete=models.CASCADE, related_name="release_links")
    disc_number = models.PositiveSmallIntegerField(default=1)
    track_number = models.PositiveSmallIntegerField(default=1)

    class Meta:
        db_table = "music_release_tracks"
        ordering = ("disc_number", "track_number")
        constraints = [models.UniqueConstraint(fields=["release", "track"], name="unique_music_release_track")]


class MusicTrackGenre(BaseModel):
    workspace = models.ForeignKey("db.Workspace", on_delete=models.CASCADE, related_name="music_track_genres")
    track = models.ForeignKey("db.MusicTrack", on_delete=models.CASCADE, related_name="genre_links")
    genre = models.ForeignKey("db.MusicGenre", on_delete=models.CASCADE, related_name="track_links")

    class Meta:
        db_table = "music_track_genres"
        constraints = [models.UniqueConstraint(fields=["track", "genre"], name="unique_music_track_genre")]


class MusicCredit(BaseModel):
    class Role(models.TextChoices):
        PRIMARY_ARTIST = "PRIMARY_ARTIST", "Primary artist"
        FEATURED_ARTIST = "FEATURED_ARTIST", "Featured artist"
        PERFORMER = "PERFORMER", "Performer"
        AUTHOR = "AUTHOR", "Author"
        COMPOSER = "COMPOSER", "Composer"
        WRITER = "WRITER", "Writer"
        PUBLISHER = "PUBLISHER", "Publisher"
        PRODUCER = "PRODUCER", "Producer"
        AUDIO_PRODUCER = "AUDIO_PRODUCER", "Audio producer"
        RECORDING_ENGINEER = "RECORDING_ENGINEER", "Recording engineer"
        MIXER = "MIXER", "Mixer"
        MASTERING_ENGINEER = "MASTERING_ENGINEER", "Mastering engineer"
        LEGAL_REPRESENTATIVE = "LEGAL_REPRESENTATIVE", "Legal representative"
        LABEL_MANAGER = "LABEL_MANAGER", "Label manager"

    workspace = models.ForeignKey("db.Workspace", on_delete=models.CASCADE, related_name="music_credits")
    track = models.ForeignKey("db.MusicTrack", on_delete=models.CASCADE, related_name="credits")
    party = models.ForeignKey("db.MusicParty", on_delete=models.CASCADE, related_name="track_credits")
    role = models.CharField(max_length=40, choices=Role.choices)
    percentage = models.DecimalField(max_digits=7, decimal_places=4, null=True, blank=True)
    publishing_share = models.DecimalField(max_digits=7, decimal_places=4, null=True, blank=True)
    territory = models.CharField(max_length=120, blank=True)
    notes = models.TextField(blank=True)

    class Meta:
        db_table = "music_credits"
        ordering = ("role", "party__display_name")
        constraints = [models.UniqueConstraint(fields=["track", "party", "role"], name="unique_music_track_credit")]


class MusicDistribution(BaseModel):
    workspace = models.ForeignKey("db.Workspace", on_delete=models.CASCADE, related_name="music_distributions")
    track = models.ForeignKey("db.MusicTrack", on_delete=models.CASCADE, null=True, blank=True, related_name="distributions")
    release = models.ForeignKey("db.MusicRelease", on_delete=models.CASCADE, null=True, blank=True, related_name="distributions")
    company = models.ForeignKey("db.MusicCompany", on_delete=models.CASCADE, related_name="distributions")
    percentage = models.DecimalField(max_digits=7, decimal_places=4, null=True, blank=True)
    territory = models.CharField(max_length=120, blank=True)
    valid_from = models.DateField(null=True, blank=True)
    valid_to = models.DateField(null=True, blank=True)

    class Meta:
        db_table = "music_distributions"
        constraints = [
            models.CheckConstraint(
                check=(Q(track__isnull=False, release__isnull=True) | Q(track__isnull=True, release__isnull=False)),
                name="music_distribution_single_owner",
            )
        ]


class MusicLink(BaseModel):
    class Kind(models.TextChoices):
        STREAMING = "STREAMING", "Streaming"
        MUSIC_VIDEO = "MUSIC_VIDEO", "Music video"
        SOCIAL = "SOCIAL", "Social"
        STORE = "STORE", "Store"
        OTHER = "OTHER", "Other"

    workspace = models.ForeignKey("db.Workspace", on_delete=models.CASCADE, related_name="music_links")
    track = models.ForeignKey("db.MusicTrack", on_delete=models.CASCADE, null=True, blank=True, related_name="links")
    release = models.ForeignKey("db.MusicRelease", on_delete=models.CASCADE, null=True, blank=True, related_name="links")
    kind = models.CharField(max_length=30, choices=Kind.choices, default=Kind.STREAMING)
    platform = models.CharField(max_length=120, blank=True)
    name = models.CharField(max_length=255)
    url = models.URLField(max_length=1000)
    isrc = models.CharField(max_length=20, blank=True)
    published_at = models.DateTimeField(null=True, blank=True)
    lyrics = models.TextField(blank=True)

    class Meta:
        db_table = "music_links"
        constraints = [
            models.CheckConstraint(
                check=(Q(track__isnull=False, release__isnull=True) | Q(track__isnull=True, release__isnull=False)),
                name="music_link_single_owner",
            )
        ]
