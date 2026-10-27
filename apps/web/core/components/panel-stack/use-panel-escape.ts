/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useRef } from "react";

/**
 * Overlays that own Escape while they are open: menus, dropdown lists,
 * popovers, modals and the editor's full-screen image. A disclosure that is
 * merely expanded (the sidebar's "Contratos" section) is not one of them.
 */
const OPEN_OVERLAY = [
  '[role="menu"]',
  '[role="listbox"]',
  '[id^="headlessui-popover-panel"]',
  '[id^="headlessui-dialog"]',
  '[role="alertdialog"]',
  '[role="dialog"][data-open]',
  ".editor-image-full-screen-modal",
].join(", ");

/** A menu, list, popover or modal is open somewhere on the page. */
export const hasOpenOverlay = () => typeof document !== "undefined" && !!document.querySelector(OPEN_OVERLAY);

type Options = {
  /** The panel is the top one of the stack (`usePanelLayer(...).isTop`) */
  isTop: boolean;
  /** The panel is open; false leaves Escape alone */
  enabled?: boolean;
  /** Something of the panel's own is open on top of it (a confirm, a picker) */
  blocked?: boolean;
};

/**
 * Escape closes the side panel on top, the same way in every panel:
 * - an open menu, list, popover or modal takes it first;
 * - a field being typed in gives up focus first (a second Escape closes);
 *   rich text keeps it;
 * - a panel under another one, or with its own dialog open, ignores it.
 */
export function usePanelEscape(onClose: () => void, { isTop, enabled = true, blocked = false }: Options) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!enabled || !isTop || blocked) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || hasOpenOverlay()) return;
      // The element the key was pressed in, even if pressing it removed it
      // (an inline editor that cancels on Escape)
      const target = event.target instanceof HTMLElement ? event.target : document.activeElement;
      if (target instanceof HTMLElement) {
        if (target.closest('[contenteditable="true"]')) return;
        if (target.closest("input, textarea, select")) {
          target.blur();
          return;
        }
      }
      closeRef.current();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [enabled, isTop, blocked]);
}
