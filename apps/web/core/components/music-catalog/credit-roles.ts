/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { TMusicCatalogOptions, TMusicCreditRole } from "@plane/types";

type TTranslate = (key: string, params?: Record<string, unknown>) => string;

/** Picker groups, in display order. Only the group names are translated:
 * role names are shown as stored (as the files name them, usually English). */
export const ROLE_CATEGORIES = [
  "ARTIST",
  "WRITER",
  "PUBLISHER",
  "PRODUCER",
  "ENGINEER",
  "PERFORMER",
  "VIDEO",
  "MANAGEMENT",
  "OTHER",
] as const;

/** Every credit role of the workspace (built-in + its own). */
export const creditRolesOf = (options?: TMusicCatalogOptions): TMusicCreditRole[] =>
  options?.credit_role_details ??
  (options?.credit_roles ?? []).map(([key, label]) => ({ key, label, category: "OTHER", builtin: true }));

/** "LEAD_VOCALS" → "Lead Vocals", for a key no role describes. */
export const humanizeRoleKey = (key: string) =>
  key
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0) + part.slice(1).toLowerCase())
    .join(" ");

/** A role's name as stored. */
export const creditRoleLabel = (roles: TMusicCreditRole[], key: string, fallback?: string | null) =>
  roles.find((role) => role.key === key)?.label ?? fallback ?? humanizeRoleKey(key);

export const roleCategoryLabel = (t: TTranslate, category: string) => {
  const key = `music_import.role_categories.${category}`;
  const translated = t(key);
  return translated && translated !== key ? translated : category;
};

const categoryOf = (role: TMusicCreditRole) =>
  (ROLE_CATEGORIES as readonly string[]).includes(role.category) ? role.category : "OTHER";

/** Roles grouped by category (for <optgroup>s), built-in first in each. */
export const groupCreditRoles = (roles: TMusicCreditRole[]) =>
  ROLE_CATEGORIES.map((category) => ({
    category,
    roles: roles.filter((role) => categoryOf(role) === category),
  })).filter((group) => group.roles.length > 0);

/** Options for a searchable picker: by category, the category as hint. */
export const creditRoleOptions = (t: TTranslate, roles: TMusicCreditRole[]) =>
  groupCreditRoles(roles).flatMap((group) =>
    group.roles.map((role) => ({ value: role.key, label: role.label, hint: roleCategoryLabel(t, group.category) }))
  );
