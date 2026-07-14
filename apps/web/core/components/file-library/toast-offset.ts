/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * Nudges the global toast viewport up while a persistent bottom-anchored
 * panel (downloads panel, selection action bar) is visible, so an ephemeral
 * toast doesn't render on top of it. Reservations are keyed and take the
 * largest active value, so independent panels don't clobber each other.
 */

const reservations = new Map<string, number>();

const apply = () => {
  const max = reservations.size > 0 ? Math.max(...reservations.values()) : 0;
  if (max > 0) document.documentElement.style.setProperty("--toast-viewport-bottom", `${0.75 + max}rem`);
  else document.documentElement.style.removeProperty("--toast-viewport-bottom");
};

/** Reserves `rem` of extra clearance above the toast viewport's default offset. */
export function reserveToastClearance(key: string, rem: number) {
  reservations.set(key, rem);
  apply();
}

export function releaseToastClearance(key: string) {
  reservations.delete(key);
  apply();
}
