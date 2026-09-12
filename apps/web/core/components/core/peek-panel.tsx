import { forwardRef } from "react";
import { createPortal } from "react-dom";
import { cn } from "@plane/utils";

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
    children: React.ReactNode;
  }
>(function PeekPanel({ mode, depth = "root", embedded = false, label, children }, ref) {
  const isNested = !embedded && depth === "nested";
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
        style={{
          boxShadow: isNested
            ? "0px 12px 32px 0px rgba(16, 24, 40, 0.20), 0px 2px 8px 0px rgba(16, 24, 40, 0.12)"
            : "0px 4px 8px 0px rgba(0, 0, 0, 0.12), 0px 6px 12px 0px rgba(16, 24, 40, 0.12), 0px 1px 16px 0px rgba(16, 24, 40, 0.12)",
        }}
      >
        {children}
      </div>
    </>
  );
  const container = typeof document !== "undefined" ? document.getElementById("full-screen-portal") : null;
  return !embedded && container ? createPortal(content, container) : content;
});
