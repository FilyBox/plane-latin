from .internal import (
    InternalMusicImportEndpoint,
    InternalMusicTracksEndpoint,
    InternalWorkspaceAssetsEndpoint,
)

from .base import (
    MusicCatalogOptionsEndpoint,
    MusicCompanyDetailEndpoint,
    MusicCreditRoleEndpoint,
    MusicCompanyEndpoint,
    MusicGenreDetailEndpoint,
    MusicGenreEndpoint,
    MusicImportAssetEndpoint,
    MusicImportEndpoint,
    MusicImportAIMapEndpoint,
    MusicImportFieldValuesEndpoint,
    MusicImportPreviewEndpoint,
    MusicPartyDetailEndpoint,
    MusicPartyEndpoint,
    MusicReleaseDetailEndpoint,
    MusicReleaseEndpoint,
    MusicReportEndpoint,
    MusicTrackBulkDeleteEndpoint,
    MusicTrackDetailEndpoint,
    MusicTrackEndpoint,
)
from .bulk import MusicTrackBulkUpdateEndpoint
from .grouping import InternalMusicAlbumGroupingMatchEndpoint, MusicReleaseGroupEndpoint
from .release_types import MusicReleaseInferTypesEndpoint

__all__ = [
    "InternalMusicAlbumGroupingMatchEndpoint",
    "InternalMusicImportEndpoint",
    "InternalMusicTracksEndpoint",
    "InternalWorkspaceAssetsEndpoint",
    "MusicCatalogOptionsEndpoint",
    "MusicCompanyDetailEndpoint",
    "MusicCreditRoleEndpoint",
    "MusicCompanyEndpoint",
    "MusicGenreDetailEndpoint",
    "MusicGenreEndpoint",
    "MusicImportAssetEndpoint",
    "MusicImportEndpoint",
    "MusicImportAIMapEndpoint",
    "MusicImportFieldValuesEndpoint",
    "MusicImportPreviewEndpoint",
    "MusicPartyDetailEndpoint",
    "MusicPartyEndpoint",
    "MusicReleaseDetailEndpoint",
    "MusicReleaseEndpoint",
    "MusicReleaseGroupEndpoint",
    "MusicReleaseInferTypesEndpoint",
    "MusicReportEndpoint",
    "MusicTrackBulkDeleteEndpoint",
    "MusicTrackBulkUpdateEndpoint",
    "MusicTrackDetailEndpoint",
    "MusicTrackEndpoint",
]
