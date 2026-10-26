/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * Entity panels that open anywhere. A panel lives in the URL so it can be
 * shared: a module page keeps its own parameter (contracts `?peek=`, music
 * `?track=` / `?release=`, expenses `?expense=`), and any other page uses
 * `?open=<kind>:<id>`, rendered by the global host. Panels opened from
 * inside a panel stack: each adds one more `open` value.
 */

export const PEEK_KINDS = ["contract", "music_track", "music_release", "expense"] as const;
export type TPeekKind = (typeof PEEK_KINDS)[number];
export type TPeekTarget = { kind: TPeekKind; id: string };

/** The global parameter: `?open=contract:<uuid>` */
export const OPEN_PARAM = "open";

export const isPeekKind = (value: unknown): value is TPeekKind =>
  typeof value === "string" && (PEEK_KINDS as readonly string[]).includes(value);

const CONTRACT_LIST = /^\/[^/]+\/file-library\/contracts\/(analyzed|vigentes|vencidos|editoriales)\/?$/;
const CONTRACT_ANY = /^\/[^/]+\/file-library\/contracts(\/[^/]+)?\/?$/;
const MUSIC = /^\/[^/]+\/music\/?$/;
const EXPENSES = /^\/[^/]+\/expenses\/?$/;

/** The parameter a page uses for its own panel of that kind, when it has one
 * (it then highlights the row and refreshes its list itself). */
export function ownParam(pathname: string, kind: TPeekKind): string | null {
  if (kind === "contract" && CONTRACT_LIST.test(pathname)) return "peek";
  if (kind === "music_track" && MUSIC.test(pathname)) return "track";
  if (kind === "music_release" && MUSIC.test(pathname)) return "release";
  if (kind === "expense" && EXPENSES.test(pathname)) return "expense";
  return null;
}

/** The page's own panel parameters (`?peek=`, `?track=`…) that are set. */
export function ownOpenParams(pathname: string, params: URLSearchParams): { kind: TPeekKind; param: string }[] {
  return PEEK_KINDS.flatMap((kind) => {
    const param = ownParam(pathname, kind);
    return param && params.get(param) ? [{ kind, param }] : [];
  });
}

/** The `?open=` panels in the URL, bottom first, without repeats. Several
 * stack: `?peek=<contract>&open=music_track:<id>` is a song over a contract. */
export function parseOpenList(params: URLSearchParams): TPeekTarget[] {
  const seen = new Set<string>();
  return params.getAll(OPEN_PARAM).flatMap((value) => {
    const target = parseOpen(value);
    if (!target || seen.has(encodeOpen(target))) return [];
    seen.add(encodeOpen(target));
    return [target];
  });
}

/** The element in its own section, with its panel open. */
export function sectionPath(slug: string, { kind, id }: TPeekTarget): string {
  switch (kind) {
    case "contract":
      return `/${slug}/file-library/contracts/analyzed?peek=${id}`;
    case "music_track":
      return `/${slug}/music?track=${id}`;
    case "music_release":
      return `/${slug}/music?release=${id}`;
    case "expense":
      return `/${slug}/expenses?expense=${id}`;
  }
}

export const encodeOpen = ({ kind, id }: TPeekTarget) => `${kind}:${id}`;

export function parseOpen(value: string | null | undefined): TPeekTarget | null {
  if (!value) return null;
  const separator = value.indexOf(":");
  const kind = value.slice(0, separator);
  const id = value.slice(separator + 1);
  return separator > 0 && isPeekKind(kind) && id ? { kind, id } : null;
}

/** The panel a link points at, if it can open in place: a module deep link
 * (as the backend's entity paths are) or a global `?open=`. */
export function parsePeekHref(href: string): TPeekTarget | null {
  if (!href.startsWith("/")) return null;
  let url: URL;
  try {
    url = new URL(href, "http://local");
  } catch {
    return null;
  }
  const opened = parseOpen(url.searchParams.get(OPEN_PARAM));
  if (opened) return opened;
  const param = (name: string) => url.searchParams.get(name);
  if (CONTRACT_ANY.test(url.pathname) && param("peek")) return { kind: "contract", id: param("peek")! };
  if (MUSIC.test(url.pathname) && param("track")) return { kind: "music_track", id: param("track")! };
  if (MUSIC.test(url.pathname) && param("release")) return { kind: "music_release", id: param("release")! };
  if (EXPENSES.test(url.pathname) && param("expense")) return { kind: "expense", id: param("expense")! };
  return null;
}
