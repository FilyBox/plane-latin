/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { CataloguePanel, useCatalogueOutsideClose, useCategorySource, useOfficeSource } from "./catalogue-picker";

type Props = {
  workspaceSlug: string;
  kind: "category" | "office";
  /** Where the cell sits on screen, from `getBoundingClientRect`. */
  anchor: DOMRect;
  selected: string;
  onApply: (id: string) => void | Promise<void>;
  onClose: () => void;
};

const PANEL_WIDTH = 256;
const PANEL_MAX_HEIGHT = 320;

/**
 * The catalogue menu floated over a grid cell. RevoGrid draws its cells through
 * templates rather than React, so the picker cannot live inside one; it is
 * portalled to the body and pinned to the rectangle the grid reported.
 */
export function CellCataloguePicker({ workspaceSlug, kind, anchor, selected, onApply, onClose }: Props) {
  const category = useCategorySource(workspaceSlug);
  const office = useOfficeSource(workspaceSlug);
  const source = kind === "category" ? category : office;
  const ref = useCatalogueOutsideClose(true, onClose);
  const [position, setPosition] = useState({ top: anchor.bottom + 4, left: anchor.left });

  // Keep the panel on screen: flip above the cell when the space below runs
  // out, and pull it left of the viewport edge.
  useLayoutEffect(() => {
    const fitsBelow = anchor.bottom + PANEL_MAX_HEIGHT < window.innerHeight;
    setPosition({
      top: fitsBelow ? anchor.bottom + 4 : Math.max(8, anchor.top - PANEL_MAX_HEIGHT - 4),
      left: Math.min(anchor.left, window.innerWidth - PANEL_WIDTH - 8),
    });
  }, [anchor]);

  const panel = (
    <div ref={ref} className="fixed z-28" style={{ top: position.top, left: position.left }}>
      <CataloguePanel
        source={source}
        selected={selected ? [selected] : []}
        allowClear={kind === "category" && Boolean(selected)}
        onPick={(item) => void onApply(item.id)}
        onClear={() => void onApply("")}
        onRemoved={(item) => item.id === selected && void onApply("")}
        onClose={onClose}
      />
    </div>
  );

  return typeof document === "undefined" ? panel : createPortal(panel, document.body);
}
