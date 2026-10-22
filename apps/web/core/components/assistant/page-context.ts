/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * What the user is looking at, sent with every message so "esta canción" or
 * "estos contratos" mean something. Read from the URL (deep links already
 * name the open item) plus whatever a page publishes as its selection.
 * Django resolves names as the user; the client only sends ids.
 */

import { useMemo, useSyncExternalStore } from "react";
import { useLocation } from "react-router";
import type { TEntityName } from "@plane/types";

export type TContextItem = { entity_name: TEntityName; id: string };

export type TAssistantPageContext = {
  /** Section of the app, e.g. "music", "contracts" */
  page: string;
  items: TContextItem[];
  /** Work item open by key (YO-1) — resolved server-side */
  issue_key?: string;
  /** Shared tag view */
  tag_id?: string;
};

// ---------------------------------------------------------------- selection

type TSelection = { entity_name: TEntityName; ids: string[] } | null;
let selection: TSelection = null;
const listeners = new Set<() => void>();

/** Pages publish their current multi-selection (cleared with `null`). */
export function setAssistantSelection(next: TSelection) {
  selection = next && next.ids.length > 0 ? { entity_name: next.entity_name, ids: next.ids.slice(0, 30) } : null;
  listeners.forEach((listener) => listener());
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

// ------------------------------------------------------------------- hook

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value: string | null): value is string => Boolean(value && UUID.test(value));

export function useAssistantPageContext(): TAssistantPageContext {
  const { pathname, search } = useLocation();
  const selected = useSyncExternalStore(subscribe, () => selection);

  return useMemo(() => {
    const segments = pathname.split("/").filter(Boolean);
    const section = segments[1] ?? "home";
    const params = new URLSearchParams(search);
    const items: TContextItem[] = [];
    const context: TAssistantPageContext = { page: section, items };
    const add = (entity_name: TEntityName, id: string | null) => {
      if (isUuid(id)) items.push({ entity_name, id });
    };

    if (section === "browse" && segments[2]) context.issue_key = segments[2];
    if (section === "tags" && isUuid(segments[2] ?? null)) context.tag_id = segments[2];
    if (section === "projects" && segments[3] === "pages") add("page", segments[4] ?? null);
    if (section === "music") {
      add("music_track", params.get("track"));
      add("music_release", params.get("release"));
      add("music_artist", params.get("artist"));
    }
    if (section === "file-library") {
      if (segments[2] === "contracts") {
        context.page = "contracts";
        add("contract", params.get("peek"));
      } else {
        add("file", params.get("preview"));
      }
    }
    if (section === "payments") add("budget", params.get("budget"));
    if (section === "expenses") add("expense", params.get("expense"));

    if (selected) {
      for (const id of selected.ids) {
        if (!items.some((item) => item.id === id)) items.push({ entity_name: selected.entity_name, id });
      }
    }
    return context;
  }, [pathname, search, selected]);
}
