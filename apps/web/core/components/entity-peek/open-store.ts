/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * The `?open=` panels, kept in step with the address bar without going
 * through the router. A router navigation re-renders every route and every
 * component reading its params — on a work-item list with its peek open that
 * took seconds — so opening or closing a panel rewrites the URL with the
 * History API instead, and only the panel host re-renders. Back and Forward
 * still close and reopen panels, and links with `?open=` still work.
 */

import { useSyncExternalStore } from "react";
import { OPEN_PARAM, encodeOpen, parseOpenList } from "./routes";
import type { TPeekTarget } from "./routes";

const EMPTY: TPeekTarget[] = [];
const listeners = new Set<() => void>();
const readUrl = () => (typeof window === "undefined" ? "" : window.location.search);

let search = readUrl();
let opened: TPeekTarget[] = parseOpenList(new URLSearchParams(search));

function update(nextSearch: string) {
  if (nextSearch === search) return;
  search = nextSearch;
  const list = parseOpenList(new URLSearchParams(search));
  // Same list, same array: subscribers only re-render when panels change
  if (list.map(encodeOpen).join() !== opened.map(encodeOpen).join()) opened = list;
  listeners.forEach((listener) => listener());
}

const onPopState = () => update(readUrl());

function subscribe(listener: () => void) {
  if (listeners.size === 0) window.addEventListener("popstate", onPopState);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("popstate", onPopState);
  };
}

/** The panels open now, bottom first. */
export const useOpenPanels = () =>
  useSyncExternalStore(
    subscribe,
    () => opened,
    () => EMPTY
  );

/** The router moved the URL (it owns every other parameter): read it again. */
export const syncOpenPanels = () => update(readUrl());

/** The address bar's parameters now, including panels the router doesn't know about. */
export const currentParams = () => new URLSearchParams(readUrl());

/** Writes the open panels into the URL. "push" adds a history entry, so Back
 * closes what was just opened. */
export function writeOpenPanels(list: TPeekTarget[], mode: "push" | "replace") {
  const params = currentParams();
  params.delete(OPEN_PARAM);
  list.forEach((item) => params.append(OPEN_PARAM, encodeOpen(item)));
  const query = params.toString();
  const url = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
  // The router's own entry shape, so its Back/Forward handling stays happy
  const state = (window.history.state ?? {}) as { idx?: number };
  if (mode === "push")
    window.history.pushState(
      { ...state, idx: (state.idx ?? 0) + 1, key: Math.random().toString(36).slice(2, 10) },
      "",
      url
    );
  else window.history.replaceState(state, "", url);
  update(readUrl());
}
