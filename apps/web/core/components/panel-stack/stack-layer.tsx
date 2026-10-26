/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { forwardRef, useCallback, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import type { CSSProperties, ReactNode } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { cn } from "@plane/utils";
import type { TPanelLayer } from "./use-panel-layer";

const DESKTOP_QUERY = "(min-width: 1024px)";
const subscribeDesktop = (onChange: () => void) => {
  const query = window.matchMedia(DESKTOP_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
};
const isDesktopNow = () => window.matchMedia(DESKTOP_QUERY).matches;

const EASE = [0.32, 0.72, 0, 1] as const;
const DURATION = 0.28;

type Props = {
  layer: TPanelLayer;
  /** `dim` darkens what is behind, `clear` only catches clicks, `none` lets
   * clicks through to the page (the panel closes on outside click itself). */
  backdrop?: "dim" | "clear" | "none";
  onBackdropClick?: () => void;
  /** The panel's position and look (it is absolutely positioned in a layer
   * that covers the panel area). */
  className?: string;
  style?: CSSProperties;
  dialog?: { label?: string; labelledBy?: string; modal?: boolean };
  children: ReactNode;
};

/**
 * One panel in the stack. The top panel slides in from the right (a centred
 * one fades and grows) and slides out on close; every panel under it steps
 * back, smaller, a little darker, with rounded corners, a docked one shifted
 * left so a strip of it stays visible. Lower layers are inert: only the top
 * one takes clicks, focus and its backdrop.
 */
export const StackLayer = forwardRef<HTMLDivElement, Props>(function StackLayer(
  { layer, backdrop = "dim", onBackdropClick, className, style, dialog, children },
  forwardedRef
) {
  const reduceMotion = useReducedMotion() ?? false;
  const isDesktop = useSyncExternalStore(subscribeDesktop, isDesktopNow, () => true);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const { panelRef } = layer;
  const setPanel = useCallback(
    (element: HTMLDivElement | null) => {
      panelRef(element);
      if (typeof forwardedRef === "function") forwardedRef(element);
      else if (forwardedRef) forwardedRef.current = element;
    },
    [panelRef, forwardedRef]
  );

  const level = layer.fromTop;
  const receding = level > 0;
  const side = layer.variant === "side";
  // React 18 has no `inert` prop; set the attribute directly
  useLayoutEffect(() => {
    if (wrapperRef.current) wrapperRef.current.inert = !layer.isTop;
  }, [layer.isTop]);

  const rest =
    !receding || reduceMotion
      ? { x: 0, y: 0, scale: 1 }
      : side
        ? isDesktop
          ? { x: layer.shiftX, y: 0, scale: 1 - 0.04 * level }
          : { x: 0, y: 0, scale: 1 - 0.03 * level }
        : { x: 0, y: -12 * level, scale: 1 - 0.04 * level };
  const hidden = side ? { x: "100%" } : { opacity: 0, scale: 0.97 };
  const transition = reduceMotion ? { duration: 0 } : { duration: DURATION, ease: EASE };

  return (
    <div
      ref={wrapperRef}
      className={cn("absolute inset-0", backdrop === "none" && "pointer-events-none")}
      style={{ zIndex: layer.zIndex }}
    >
      {backdrop !== "none" && (
        <motion.div
          aria-hidden
          className={cn(
            "absolute inset-0 transition-colors duration-300",
            backdrop === "dim" ? "bg-black/20" : "bg-transparent"
          )}
          style={{ pointerEvents: layer.isTop ? "auto" : "none" }}
          initial={reduceMotion ? false : { opacity: 0 }}
          animate={{ opacity: layer.isTop ? 1 : 0 }}
          exit={{ opacity: 0 }}
          transition={transition}
          onClick={layer.isTop ? onBackdropClick : undefined}
        />
      )}
      <motion.div
        ref={setPanel}
        role={dialog ? "dialog" : undefined}
        aria-modal={dialog?.modal || undefined}
        aria-label={dialog?.label}
        aria-labelledby={dialog?.labelledBy}
        className={cn(
          "pointer-events-auto isolate transition-[top,right,bottom,left,width,height,margin,border-radius] duration-300",
          className,
          receding && !reduceMotion && "rounded-xl border border-subtle"
        )}
        style={{
          ...style,
          originX: side ? 0 : 0.5,
          originY: side ? 0.5 : 0,
          willChange: receding ? "transform" : undefined,
        }}
        initial={reduceMotion ? false : hidden}
        animate={{ ...rest, opacity: 1 }}
        exit={reduceMotion ? { opacity: 0, transition: { duration: 0 } } : hidden}
        transition={transition}
      >
        {children}
        {/* Steps a lower panel back without touching its contents */}
        <motion.div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-[60] bg-black"
          initial={false}
          animate={{ opacity: receding ? Math.min(0.06 * level, 0.18) : 0 }}
          transition={transition}
        />
      </motion.div>
    </div>
  );
});
