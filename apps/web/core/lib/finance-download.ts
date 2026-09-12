/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

/** Hands the browser a file the app already holds in memory.
 *
 * Exports go out over the app's authenticated HTTP client and come back as a
 * blob, the way the music and contract reports do. Pointing an iframe or a form
 * at the endpoint instead loses the client's auth header and CSRF token, so the
 * server answers with a redirect to the sign-in page — which is what was
 * hijacking the tab.
 */
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoking straight away can cancel the download in Safari.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Reads the name the server asked for, falling back to the caller's guess. */
export function filenameFromDisposition(disposition: unknown, fallback: string): string {
  if (typeof disposition !== "string") return fallback;
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  if (utf8) return decodeURIComponent(utf8[1]);
  const plain = /filename="?([^";]+)"?/i.exec(disposition);
  return plain ? plain[1] : fallback;
}
