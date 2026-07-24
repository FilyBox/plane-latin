# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from django.urls import path

from plane.app.views.file_library.collabora import (
    CollaboraPdfEndpoint,
    CollaboraSessionEndpoint,
    WopiCheckFileInfoEndpoint,
    WopiFileContentsEndpoint,
)

# Called by the browser — normal session auth, mounted under /api/
app_urlpatterns = [
    path(
        "workspaces/<str:slug>/file-library/files/<uuid:asset_id>/collabora-session/",
        CollaboraSessionEndpoint.as_view(),
        name="collabora-session",
    ),
    path(
        "workspaces/<str:slug>/file-library/files/<uuid:asset_id>/pdf/",
        CollaboraPdfEndpoint.as_view(),
        name="collabora-pdf",
    ),
]

# Called by the Collabora server itself. The paths are fixed by the WOPI spec —
# Collabora appends "/contents" to the WOPISrc we hand it, so these must sit at
# the root, not behind /api/.
wopi_urlpatterns = [
    path(
        "wopi/files/<uuid:asset_id>",
        WopiCheckFileInfoEndpoint.as_view(),
        name="wopi-check-file-info",
    ),
    path(
        "wopi/files/<uuid:asset_id>/contents",
        WopiFileContentsEndpoint.as_view(),
        name="wopi-file-contents",
    ),
]
