/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Coordinates bottom clearance for the global toast viewport. Reservations
 * are keyed so independent persistent controls do not overwrite each other.
 */

const reservations = new Map<string, number>();

const applyToastClearance = () => {
  const max = reservations.size > 0 ? Math.max(...reservations.values()) : 0;
  if (max > 0) document.documentElement.style.setProperty("--toast-viewport-bottom", `${0.75 + max}rem`);
  else document.documentElement.style.removeProperty("--toast-viewport-bottom");
};

export function reserveToastClearance(key: string, rem: number) {
  reservations.set(key, rem);
  applyToastClearance();
}

export function releaseToastClearance(key: string) {
  reservations.delete(key);
  applyToastClearance();
}
