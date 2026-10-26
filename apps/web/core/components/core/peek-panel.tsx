import { forwardRef } from "react";
import { createPortal } from "react-dom";
import { cn } from "@plane/utils";
import { StackLayer } from "@/components/panel-stack/stack-layer";
import type { TPanelLayer } from "@/components/panel-stack/use-panel-layer";

export type PeekMode = "side-peek" | "modal" | "full-screen";

/** Depth in the panel stack. A `nested` panel is the one that opened *from*
 * another: it sits narrower and inset so the panel underneath stays visible at
 * the edges, which says "you went one level in" better than a back arrow. */
export type PeekDepth = "root" | "nested";

/** The work-item peek shell, shared by work items and financial records. */
export const PeekPanel = forwardRef<
  HTMLDivElement,
  {
    mode: PeekMode;
    depth?: PeekDepth;
    embedded?: boolean;
    label?: string;
    /** Its place among the open panels (`usePanelLayer`). With it the panel
     * stacks: it slides in, recedes under a panel opened on top, and takes its
     * z-index from the stack. */
    layer?: TPanelLayer;
    children: React.ReactNode;
  }
>(function PeekPanel({ mode, depth = "root", embedded = false, label, layer, children }, ref) {
  const isNested = !embedded && depth === "nested";
  const container = typeof document !== "undefined" ? document.getElementById("full-screen-portal") : null;
  const shadow = isNested
    ? "0px 12px 32px 0px rgba(16, 24, 40, 0.20), 0px 2px 8px 0px rgba(16, 24, 40, 0.12)"
    : "0px 4px 8px 0px rgba(0, 0, 0, 0.12), 0px 6px 12px 0px rgba(16, 24, 40, 0.12), 0px 1px 16px 0px rgba(16, 24, 40, 0.12)";

  if (layer && !embedded) {
    const stacked = (
      <StackLayer
        ref={ref}
        layer={layer}
        // Root panels close on outside click and leave the page visible; one
        // opened over another panel dims what is behind it
        backdrop={isNested || layer.depth > 0 ? "dim" : "none"}
        dialog={label ? { label } : undefined}
        className={cn(
          "absolute flex flex-col overflow-hidden border border-subtle bg-surface-1 text-body-sm-regular",
          isNested
            ? "top-6 right-6 bottom-6 w-full max-w-100 rounded-lg"
            : [
                "rounded-sm",
                {
                  "top-0 right-0 bottom-0 w-full border-0 border-l md:w-[50%]": mode === "side-peek",
                  "top-[8.33%] left-[8.33%] size-5/6": mode === "modal",
                  "inset-0 m-4": mode === "full-screen",
                },
              ]
        )}
        style={{ boxShadow: shadow }}
      >
        {children}
      </StackLayer>
    );
    return container ? createPortal(stacked, container) : stacked;
  }

  const content = (
    <>
      {/* Dims whatever is behind so the stack reads as depth, not as two panels
          fighting for the same space. */}
      {isNested && <div className="absolute inset-0 z-[26] bg-backdrop/40" aria-hidden />}
      <div
        ref={ref}
        role={label ? "dialog" : undefined}
        aria-label={label}
        className={cn(
          embedded
            ? "h-full w-full"
            : "absolute flex flex-col overflow-hidden border border-subtle bg-surface-1 text-body-sm-regular transition-all duration-300",
          !embedded && !isNested && "z-[25] rounded-sm",
          isNested && "top-6 right-6 bottom-6 z-[27] w-full max-w-100 rounded-lg",
          !embedded &&
            !isNested && {
              "top-0 right-0 bottom-0 w-full border-0 border-l md:w-[50%]": mode === "side-peek",
              "top-[8.33%] left-[8.33%] size-5/6": mode === "modal",
              "absolute inset-0 m-4": mode === "full-screen",
            }
        )}
        style={{ boxShadow: shadow }}
      >
        {children}
      </div>
    </>
  );
  return !embedded && container ? createPortal(content, container) : content;
});
