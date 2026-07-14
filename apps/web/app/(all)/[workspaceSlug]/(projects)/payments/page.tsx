/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { Navigate } from "react-router";
// plane imports
import { EUserPermissions, EUserPermissionsLevel } from "@plane/constants";
// components
import { PageHead } from "@/components/core/page-title";
import { PaymentsRoot } from "@/components/payments/root";
// hooks
import { useUserPermissions } from "@/hooks/store/user";
import { useWorkspace } from "@/hooks/store/use-workspace";
import type { Route } from "./+types/page";

const PaymentsPage = observer(function PaymentsPage({ params }: Route.ComponentProps) {
  const { workspaceSlug } = params;
  // store hooks
  const { isWorkspaceFeatureEnabled, featureFlagsMap } = useWorkspace();
  const { allowPermissions, workspaceInfoBySlug } = useUserPermissions();
  // derived values
  const areFlagsLoaded = featureFlagsMap[workspaceSlug] !== undefined;
  // On a direct/hard navigation (fresh page load, no warm workspace session)
  // the member role hasn't been fetched yet — without this check, `isAdmin`
  // reads as false on the first render and bounces an actual admin home
  // before `fetchUserWorkspaceInfo` resolves.
  const isRoleLoaded = workspaceInfoBySlug(workspaceSlug) !== undefined;
  const isPaymentsEnabled = isWorkspaceFeatureEnabled(workspaceSlug, "payments");
  // Money is admin-only. The API enforces this too — this just avoids rendering
  // a page whose every request would come back 403.
  const isAdmin = allowPermissions([EUserPermissions.ADMIN], EUserPermissionsLevel.WORKSPACE);

  if (areFlagsLoaded && isRoleLoaded && (!isPaymentsEnabled || !isAdmin))
    return <Navigate to={`/${workspaceSlug}`} replace />;

  return (
    <>
      <PageHead title="Payments" />
      <div className="relative h-full w-full overflow-hidden">
        <PaymentsRoot workspaceSlug={workspaceSlug} />
      </div>
    </>
  );
});

export default PaymentsPage;
