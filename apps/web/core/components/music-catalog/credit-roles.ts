/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { TMusicChoice } from "@plane/types";

type TTranslate = (key: string, params?: Record<string, unknown>) => string;

/** A credit role as the user reads it: translated when the role is known,
 * otherwise the backend's (English) label. */
export const creditRoleLabel = (t: TTranslate, value: string, fallback?: string) => {
  const key = `music_import.roles.${value}`;
  const translated = t(key);
  return translated && translated !== key ? translated : (fallback ?? value);
};

/** Every credit role from the catalog options, translated. */
export const creditRoleOptions = (t: TTranslate, roles: TMusicChoice[] | undefined) =>
  (roles ?? []).map(([value, label]) => ({ value, label: creditRoleLabel(t, value, label) }));
