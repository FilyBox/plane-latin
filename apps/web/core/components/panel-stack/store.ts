/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * The open panels (contract, song, release, expense, work item…), bottom
 * first. Panels mount from unrelated places (a page, the global entity host,
 * a panel's own children) and portal as siblings, so the stack lives outside
 * React: one list for the whole app, which nothing has to provide.
 */

/** How a panel sits: docked to the right edge, or centred (modal / full screen). */
export type TPanelVariant = "side" | "center";

export type TPanelStackSnapshot = {
  /** Layer ids, bottom first. */
  order: readonly string[];
  /** Horizontal offset (px, ≤ 0) that lets a docked panel peek out to the left
   * of the ones above it. */
  shift: Readonly<Record<string, number>>;
};

type TEntry = { id: string; rank: number; seq: number; variant: TPanelVariant };

/** Strip of a docked panel left visible beyond the left edge of the panel
 * above it, however their widths compare. */
const PEEK_STRIP = 56;
/** Least a docked panel steps left when it is already wider than the one above. */
const MIN_STEP = 24;
/** Space kept between a shifted panel and the left edge of the panel area. */
const GUTTER = 8;
/** Below this much showing, a strip reads as a glitch: just step back instead. */
const MIN_VISIBLE = 24;

const EMPTY: TPanelStackSnapshot = { order: [], shift: {} };

class PanelStackStore {
  private entries = new Map<string, TEntry>();
  private elements = new Map<string, HTMLElement>();
  private listeners = new Set<() => void>();
  private snapshot: TPanelStackSnapshot = EMPTY;
  private seq = 0;
  private resizeObserver: ResizeObserver | null = null;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.snapshot;

  getServerSnapshot = () => EMPTY;

  add(id: string, rank: number, variant: TPanelVariant) {
    this.entries.set(id, { id, rank, seq: ++this.seq, variant });
    if (this.entries.size === 1) window.addEventListener("resize", this.recompute);
    this.recompute();
  }

  update(id: string, rank: number, variant: TPanelVariant) {
    const entry = this.entries.get(id);
    if (!entry || (entry.rank === rank && entry.variant === variant)) return;
    this.entries.set(id, { ...entry, rank, variant });
    this.recompute();
  }

  remove(id: string) {
    if (!this.entries.delete(id)) return;
    if (this.entries.size === 0) window.removeEventListener("resize", this.recompute);
    this.recompute();
  }

  /** The panel element, measured to work out how far the panels under it move. */
  setElement(id: string, element: HTMLElement | null) {
    const previous = this.elements.get(id);
    if (previous === element) return;
    if (previous) this.resizeObserver?.unobserve(previous);
    if (element) {
      this.elements.set(id, element);
      if (!this.resizeObserver && typeof ResizeObserver !== "undefined")
        this.resizeObserver = new ResizeObserver(() => this.recompute());
      this.resizeObserver?.observe(element);
    } else this.elements.delete(id);
    if (this.entries.has(id)) this.recompute();
  }

  /** Untransformed left edge in viewport px (the panel's offset inside its
   * never-transformed layer wrapper) and the left edge of that wrapper. */
  private measure(id: string): { left: number; areaLeft: number } | null {
    const element = this.elements.get(id);
    const parent = element?.offsetParent;
    if (!element || !(parent instanceof HTMLElement)) return null;
    const areaLeft = parent.getBoundingClientRect().left;
    return { left: areaLeft + element.offsetLeft, areaLeft };
  }

  private recompute = () => {
    const sorted = [...this.entries.values()].sort((a, b) => a.rank - b.rank || a.seq - b.seq);
    const order = sorted.map((entry) => entry.id);

    // From the top down, each docked panel moves left until a strip of it
    // shows beyond the left edge of the panel above, whatever their widths. A
    // panel under a centred or full-width one has nowhere to peek: it only
    // steps back (scale and dim) and so does everything under it.
    const shift: Record<string, number> = {};
    let edge: number | null = null;
    for (let index = sorted.length - 1; index >= 0; index--) {
      const entry = sorted[index];
      const box = this.measure(entry.id);
      const isTop = index === sorted.length - 1;
      if (!box) {
        edge = null;
        continue;
      }
      if (isTop) {
        edge = entry.variant === "side" ? box.left : null;
      } else if (entry.variant !== "side" || edge === null) {
        edge = null;
      } else {
        // Never past the left edge of the panel area
        const target = Math.max(box.areaLeft + GUTTER, Math.min(box.left - MIN_STEP, edge - PEEK_STRIP));
        if (edge - target < MIN_VISIBLE) {
          // The panel above (nearly) fills the area: no room for a strip
          edge = null;
          continue;
        }
        shift[entry.id] = Math.round(target - box.left);
        edge = target;
      }
    }

    const previous = this.snapshot;
    const sameOrder = previous.order.length === order.length && previous.order.every((id, i) => id === order[i]);
    const shiftKeys = Object.keys(shift);
    const sameShift =
      shiftKeys.length === Object.keys(previous.shift).length &&
      shiftKeys.every((key) => previous.shift[key] === shift[key]);
    if (sameOrder && sameShift) return;
    this.snapshot = { order, shift };
    this.listeners.forEach((listener) => listener());
  };
}

export const panelStack = new PanelStackStore();
