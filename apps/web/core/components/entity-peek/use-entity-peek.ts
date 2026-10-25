/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback } from "react";
import type { MouseEvent } from "react";
import { useLocation, useSearchParams } from "react-router";
import { OPEN_PARAM, encodeOpen, isPeekKind, ownParam, parsePeekHref } from "./routes";
import type { TPeekTarget } from "./routes";

/** Opens an entity's panel where the user is, through the URL: the page's own
 * parameter when it has a panel for that kind, else the global `?open=`.
 * Opening pushes a history entry, so Back closes it. */
export function useEntityPeek() {
  const { pathname } = useLocation();
  const [, setSearchParams] = useSearchParams();
  const open = useCallback(
    (target: TPeekTarget) => {
      const own = ownParam(pathname, target.kind);
      setSearchParams((current) => {
        const next = new URLSearchParams(current);
        if (own) next.set(own, target.id);
        else next.set(OPEN_PARAM, encodeOpen(target));
        return next;
      });
    },
    [pathname, setSearchParams]
  );
  return { open };
}

const plainClick = (event: MouseEvent) =>
  !event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

/**
 * For links to entities: a plain click on one that has a panel opens it in
 * place and returns true; modified clicks (new tab) keep the link's normal
 * navigation. Pass the href, or the entity's kind and id when known.
 */
export function usePeekLinkClick() {
  const { open } = useEntityPeek();
  return useCallback(
    (event: MouseEvent, link: string | { entity_name: string; id: string } | undefined | null): boolean => {
      if (!link || !plainClick(event)) return false;
      const target =
        typeof link === "string"
          ? parsePeekHref(link)
          : isPeekKind(link.entity_name)
            ? { kind: link.entity_name, id: link.id }
            : null;
      if (!target) return false;
      event.preventDefault();
      event.stopPropagation();
      open(target);
      return true;
    },
    [open]
  );
}
