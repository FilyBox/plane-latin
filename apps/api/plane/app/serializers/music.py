# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

from rest_framework import serializers

from plane.db.models import (
    MusicCompany,
    MusicCredit,
    MusicDistribution,
    MusicGenre,
    MusicLink,
    MusicParty,
    MusicRelease,
    MusicTrack,
)

from .base import BaseSerializer


class MusicPartySerializer(BaseSerializer):
    class Meta:
        model = MusicParty
        exclude = ["deleted_at", "created_by", "updated_by"]
        read_only_fields = ["workspace"]


class MusicGenreSerializer(BaseSerializer):
    class Meta:
        model = MusicGenre
        fields = ["id", "name", "workspace_id", "created_at", "updated_at"]
        read_only_fields = ["workspace_id", "created_at", "updated_at"]


class MusicCompanySerializer(BaseSerializer):
    class Meta:
        model = MusicCompany
        exclude = ["deleted_at", "created_by", "updated_by"]
        read_only_fields = ["workspace"]


class MusicCreditSerializer(BaseSerializer):
    party = MusicPartySerializer(read_only=True)

    class Meta:
        model = MusicCredit
        exclude = ["deleted_at", "created_by", "updated_by"]


class MusicLinkSerializer(BaseSerializer):
    class Meta:
        model = MusicLink
        exclude = ["deleted_at", "created_by", "updated_by"]


class MusicDistributionSerializer(BaseSerializer):
    company = MusicCompanySerializer(read_only=True)

    class Meta:
        model = MusicDistribution
        exclude = ["deleted_at", "created_by", "updated_by"]


class MusicReleaseSerializer(BaseSerializer):
    artist_ids = serializers.ListField(child=serializers.UUIDField(), write_only=True, required=False)
    artist_details = serializers.SerializerMethodField()
    track_count = serializers.IntegerField(read_only=True, default=0)

    def get_artist_details(self, obj):
        return [
            {"id": str(link.party_id), "name": link.party.display_name, "role": link.role}
            for link in obj.artist_links.all()
        ]

    def create(self, validated_data):
        validated_data.pop("artist_ids", None)
        return super().create(validated_data)

    def update(self, instance, validated_data):
        validated_data.pop("artist_ids", None)
        return super().update(instance, validated_data)

    class Meta:
        model = MusicRelease
        exclude = ["deleted_at", "created_by", "updated_by", "artists"]
        read_only_fields = ["workspace"]


class MusicTrackSerializer(BaseSerializer):
    NULLABLE_NUMBER_FIELDS = (
        "duration_ms",
        "tiktok_preview_start_ms",
        "tiktok_preview_end_ms",
        "aggregator_percentage",
        "distributor_percentage",
        "record_label_percentage",
        "artist_percentage",
        "writer_percentage",
    )
    releases = serializers.ListField(child=serializers.DictField(), write_only=True, required=False)
    genre_ids = serializers.ListField(child=serializers.UUIDField(), write_only=True, required=False)
    credit_entries = serializers.ListField(child=serializers.DictField(), write_only=True, required=False)
    link_entries = serializers.ListField(child=serializers.DictField(), write_only=True, required=False)
    distribution_entries = serializers.ListField(child=serializers.DictField(), write_only=True, required=False)
    video_entries = serializers.ListField(child=serializers.DictField(), write_only=True, required=False)
    credits = MusicCreditSerializer(many=True, read_only=True)
    genre_details = serializers.SerializerMethodField()
    release_details = serializers.SerializerMethodField()
    links = MusicLinkSerializer(many=True, read_only=True)
    distributions = MusicDistributionSerializer(many=True, read_only=True)
    video_details = serializers.SerializerMethodField()
    import_sources = serializers.SerializerMethodField()

    def to_internal_value(self, data):
        # HTML forms commonly represent optional numeric inputs as an empty
        # string. Treat that as an omitted value instead of rejecting the
        # complete song payload.
        if hasattr(data, "copy"):
            data = data.copy()
            for field in self.NULLABLE_NUMBER_FIELDS:
                if data.get(field) == "":
                    data[field] = None
        return super().to_internal_value(data)

    def get_video_details(self, obj):
        return [
            {
                "id": str(video.id),
                "title": video.title,
                "version": video.version,
                "status": video.status,
                "isrc": video.isrc_video or video.isrc,
                "upc": video.upc,
                "catalog": video.catalog,
                "release_date": video.release_date,
                "duration_ms": video.duration_ms,
                "cover_url": video.cover_url,
                "video_url": next((link.url for link in video.links.all() if link.kind == "MUSIC_VIDEO"), ""),
            }
            for video in obj.videos.all()
        ]

    def get_genre_details(self, obj):
        return [{"id": str(link.genre_id), "name": link.genre.name} for link in obj.genre_links.all()]

    def get_release_details(self, obj):
        return [
            {
                "id": str(link.release_id),
                "title": link.release.title,
                "release_type": link.release.release_type,
                "release_date": link.release.release_date,
                "disc_number": link.disc_number,
                "track_number": link.track_number,
            }
            for link in obj.release_links.all()
        ]

    def get_import_sources(self, obj):
        return [
            {
                "id": str(link.import_run_id),
                "asset_id": str(link.import_run.file_asset_id) if link.import_run.file_asset_id else None,
                "name": link.import_run.source_name,
                "source": link.import_run.source,
                "action": link.action,
                "row_number": link.row_number,
                "imported_at": link.import_run.created_at,
            }
            for link in obj.import_links.all()
        ]

    @staticmethod
    def _without_relations(validated_data):
        for field in (
            "releases",
            "genre_ids",
            "credit_entries",
            "link_entries",
            "distribution_entries",
            "video_entries",
        ):
            validated_data.pop(field, None)
        return validated_data

    def create(self, validated_data):
        return super().create(self._without_relations(validated_data))

    def update(self, instance, validated_data):
        return super().update(instance, self._without_relations(validated_data))

    class Meta:
        model = MusicTrack
        exclude = ["deleted_at", "created_by", "updated_by", "genres"]
        read_only_fields = ["workspace"]
