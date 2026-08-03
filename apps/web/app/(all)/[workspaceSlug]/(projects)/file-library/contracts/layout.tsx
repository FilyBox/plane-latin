/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { Navigate, Outlet, useParams } from "react-router";
import { useWorkspace } from "@/hooks/store/use-workspace";

const ContractsLayout = observer(function ContractsLayout() {
  const { workspaceSlug } = useParams();
  const { isWorkspaceFeatureEnabled, featureFlagsMap } = useWorkspace();
  const areFlagsLoaded = workspaceSlug ? featureFlagsMap[workspaceSlug] !== undefined : false;
  const isFileLibraryEnabled = workspaceSlug ? isWorkspaceFeatureEnabled(workspaceSlug, "file_library") : false;

  if (workspaceSlug && areFlagsLoaded && !isFileLibraryEnabled) return <Navigate to={`/${workspaceSlug}`} replace />;
  return <Outlet />;
});

export default ContractsLayout;
