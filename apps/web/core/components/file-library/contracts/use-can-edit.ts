/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { EUserWorkspaceRoles } from "@plane/types";
// hooks
import { useUserPermissions } from "@/hooks/store/user";

/**
 * Contracts (analyzed, templates, signatures) are for workspace admins only;
 * the API enforces the same. `undefined` while the role is still loading.
 * Call from an observer.
 */
export function useCanViewContracts(workspaceSlug: string): boolean | undefined {
  const { getWorkspaceRoleByWorkspaceSlug } = useUserPermissions();
  const role = workspaceSlug ? getWorkspaceRoleByWorkspaceSlug(workspaceSlug) : undefined;
  if (role === undefined) return undefined;
  return role === EUserWorkspaceRoles.ADMIN;
}

/** Whoever sees contracts may change them. Call from an observer. */
export function useCanEditContracts(workspaceSlug: string): boolean {
  return useCanViewContracts(workspaceSlug) === true;
}
