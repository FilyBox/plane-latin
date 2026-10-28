/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { Navigate, Outlet, useParams } from "react-router";
import { useCanViewContracts } from "@/components/file-library/contracts/use-can-edit";
import { useWorkspace } from "@/hooks/store/use-workspace";

const ContractsLayout = observer(function ContractsLayout() {
  const { workspaceSlug } = useParams();
  const { isWorkspaceFeatureEnabled, featureFlagsMap } = useWorkspace();
  const areFlagsLoaded = workspaceSlug ? featureFlagsMap[workspaceSlug] !== undefined : false;
  const isFileLibraryEnabled = workspaceSlug ? isWorkspaceFeatureEnabled(workspaceSlug, "file_library") : false;

  // Contracts are admin-only: members land back in the file library
  const canViewContracts = useCanViewContracts(workspaceSlug ?? "");

  if (workspaceSlug && areFlagsLoaded && !isFileLibraryEnabled) return <Navigate to={`/${workspaceSlug}`} replace />;
  if (workspaceSlug && canViewContracts === false) return <Navigate to={`/${workspaceSlug}/file-library`} replace />;
  if (canViewContracts === undefined) return null;
  return <Outlet />;
});

export default ContractsLayout;
