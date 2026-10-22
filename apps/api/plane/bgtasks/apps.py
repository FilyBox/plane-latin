# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from django.apps import AppConfig


class BgtasksConfig(AppConfig):
    name = "plane.bgtasks"

    def ready(self):
        # Mention references follow saved editor HTML (see reference_task).
        from plane.bgtasks.reference_task import connect_signals

        connect_signals()
