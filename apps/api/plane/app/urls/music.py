from django.urls import path

from plane.app.views import (
    InternalMusicImportEndpoint,
    InternalMusicTracksEndpoint,
    InternalWorkspaceAssetsEndpoint,
    MusicCatalogOptionsEndpoint,
    MusicCompanyDetailEndpoint,
    MusicCompanyEndpoint,
    MusicGenreDetailEndpoint,
    MusicGenreEndpoint,
    MusicImportAssetEndpoint,
    MusicImportEndpoint,
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

urlpatterns = [
    path("workspaces/<str:slug>/music/releases/", MusicReleaseEndpoint.as_view(), name="music-releases"),
    path("workspaces/<str:slug>/music/releases/<uuid:release_id>/", MusicReleaseDetailEndpoint.as_view(), name="music-release-detail"),
    path("workspaces/<str:slug>/music/tracks/", MusicTrackEndpoint.as_view(), name="music-tracks"),
    path("workspaces/<str:slug>/music/tracks/bulk-delete/", MusicTrackBulkDeleteEndpoint.as_view(), name="music-tracks-bulk-delete"),
    path("workspaces/<str:slug>/music/tracks/<uuid:track_id>/", MusicTrackDetailEndpoint.as_view(), name="music-track-detail"),
    path("workspaces/<str:slug>/music/parties/", MusicPartyEndpoint.as_view(), name="music-parties"),
    path("workspaces/<str:slug>/music/parties/<uuid:party_id>/", MusicPartyDetailEndpoint.as_view(), name="music-party-detail"),
    path("workspaces/<str:slug>/music/genres/", MusicGenreEndpoint.as_view(), name="music-genres"),
    path("workspaces/<str:slug>/music/genres/<uuid:genre_id>/", MusicGenreDetailEndpoint.as_view(), name="music-genre-detail"),
    path("workspaces/<str:slug>/music/companies/", MusicCompanyEndpoint.as_view(), name="music-companies"),
    path("workspaces/<str:slug>/music/companies/<uuid:company_id>/", MusicCompanyDetailEndpoint.as_view(), name="music-company-detail"),
    path("workspaces/<str:slug>/music/options/", MusicCatalogOptionsEndpoint.as_view(), name="music-options"),
    path("workspaces/<str:slug>/music/import/", MusicImportEndpoint.as_view(), name="music-import"),
    path(
        "workspaces/<str:slug>/music/import-assets/",
        MusicImportAssetEndpoint.as_view(),
        name="music-import-assets",
    ),
    path("workspaces/<str:slug>/music/import/preview/", MusicImportPreviewEndpoint.as_view(), name="music-import-preview"),
    path("workspaces/<str:slug>/music/reports/", MusicReportEndpoint.as_view(), name="music-report"),
    path(
        "workspaces/<str:slug>/music/reports/releases.csv",
        MusicReportEndpoint.as_view(),
        name="music-report-legacy",
    ),
    # Internal (Worker assistant agent, shared-secret auth)
    path(
        "internal/workspaces/<uuid:workspace_id>/music/tracks/",
        InternalMusicTracksEndpoint.as_view(),
        name="internal-music-tracks",
    ),
    path(
        "internal/workspaces/<uuid:workspace_id>/music/import/",
        InternalMusicImportEndpoint.as_view(),
        name="internal-music-import",
    ),
    path(
        "internal/workspaces/<uuid:workspace_id>/assets/",
        InternalWorkspaceAssetsEndpoint.as_view(),
        name="internal-workspace-assets",
    ),
]
