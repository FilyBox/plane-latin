/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { createContext, useCallback, useContext, useId, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { useIsPresent } from "framer-motion";
import { panelStack } from "./store";
import type { TPanelVariant } from "./store";

export type { TPanelVariant } from "./store";

/** Above the page (headers sit at 18) and the old panel range, below the
 * dialogs and dropdown menus a panel opens (30 and up), so those still show
 * over the panel that opened them. One step per layer. */
const BASE_Z_INDEX = 24;
const MAX_Z_INDEX = 29;

export type TPanelLayer = {
  /** In the stack right now (false while closing). */
  isOpen: boolean;
  /** 0 is the bottom panel. */
  depth: number;
  /** 0 is the panel on top. */
  fromTop: number;
  /** Only the top panel answers Escape, outside clicks and its backdrop. */
  isTop: boolean;
  zIndex: number;
  variant: TPanelVariant;
  /** px a docked lower panel moves left so it peeks out (desktop). */
  shiftX: number;
  /** Ref for the panel element, measured for `shiftX`. */
  panelRef: (element: HTMLElement | null) => void;
};

/** Order between panels that mount from different places: the page's own
 * panel is 0, each `?open=` panel its position in the URL plus one. Panels
 * with the same rank stack in the order they opened. */
const PanelRankContext = createContext(0);

export function PanelLayerRank({ rank, children }: { rank: number; children: ReactNode }) {
  return <PanelRankContext.Provider value={rank}>{children}</PanelRankContext.Provider>;
}

/**
 * Registers a panel in the shared stack while `open` and returns where it
 * sits. A panel kept mounted by `AnimatePresence` while it slides out leaves
 * the stack at once, so the one under it comes forward during the exit.
 */
export function usePanelLayer(open: boolean, options: { variant?: TPanelVariant } = {}): TPanelLayer {
  const { variant = "side" } = options;
  const id = useId();
  const rank = useContext(PanelRankContext);
  const isPresent = useIsPresent();
  const active = open && isPresent;
  const snapshot = useSyncExternalStore(panelStack.subscribe, panelStack.getSnapshot, panelStack.getServerSnapshot);

  const latest = useRef({ rank, variant });
  latest.current = { rank, variant };
  useLayoutEffect(() => {
    if (!active) return;
    panelStack.add(id, latest.current.rank, latest.current.variant);
    return () => panelStack.remove(id);
  }, [active, id]);
  useLayoutEffect(() => {
    if (active) panelStack.update(id, rank, variant);
  }, [active, id, rank, variant]);

  const panelRef = useCallback((element: HTMLElement | null) => panelStack.setElement(id, element), [id]);

  const index = snapshot.order.indexOf(id);
  // Keeps the last place while closing, so the exit plays at the same height
  const last = useRef({ depth: 0, zIndex: BASE_Z_INDEX });
  if (index >= 0) last.current = { depth: index, zIndex: Math.min(BASE_Z_INDEX + index, MAX_Z_INDEX) };
  const isOpen = index >= 0;
  const fromTop = isOpen ? snapshot.order.length - 1 - index : 0;
  return {
    isOpen,
    depth: last.current.depth,
    fromTop,
    isTop: isOpen && fromTop === 0,
    zIndex: last.current.zIndex,
    variant,
    shiftX: isOpen ? (snapshot.shift[id] ?? 0) : 0,
    panelRef,
  };
}
