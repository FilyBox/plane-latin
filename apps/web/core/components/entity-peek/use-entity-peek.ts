/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback } from "react";
import type { MouseEvent } from "react";
import { useLocation, useSearchParams } from "react-router";
import { OPEN_PARAM, encodeOpen, isPeekKind, ownOpenParams, ownParam, parseOpenList, parsePeekHref } from "./routes";
import type { TPeekTarget } from "./routes";

/** Opens an entity's panel where the user is, through the URL. With no panel
 * open: the page's own parameter when it has a panel for that kind, else the
 * global `?open=`. From inside an open panel, the new one stacks on top (one
 * more `open` value); one already in the stack comes back to the top instead.
 * Opening pushes a history entry, so Back closes it. */
export function useEntityPeek() {
  const { pathname } = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const open = useCallback(
    (target: TPeekTarget) => {
      const next = new URLSearchParams(searchParams);
      const own = ownParam(pathname, target.kind);
      const opened = parseOpenList(next);
      const pagePanels = ownOpenParams(pathname, next);
      const encoded = encodeOpen(target);
      const index = opened.findIndex((item) => encodeOpen(item) === encoded);
      const setOpened = (list: TPeekTarget[]) => {
        next.delete(OPEN_PARAM);
        list.forEach((item) => next.append(OPEN_PARAM, encodeOpen(item)));
      };
      if (own && next.get(own) === target.id) setOpened([]);
      else if (index >= 0) setOpened(opened.slice(0, index + 1));
      else if (own && pagePanels.length === 0 && opened.length === 0) next.set(own, target.id);
      else setOpened([...opened, target]);
      if (next.toString() !== searchParams.toString()) setSearchParams(next);
    },
    [pathname, searchParams, setSearchParams]
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
