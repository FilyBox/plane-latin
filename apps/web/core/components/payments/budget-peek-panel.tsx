/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

type Props = {
  children: React.ReactNode;
  title: string;
  description?: string;
  onClose: () => void;
};

export function BudgetPeekPanel({ children, title, description, onClose }: Props) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !document.querySelector('[role="dialog"]')) onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const panel = (
    <aside
      className="absolute top-0 right-0 bottom-0 z-[25] flex w-full flex-col overflow-hidden border-l border-subtle bg-surface-1 shadow-raised-200 md:w-1/2"
      style={{
        boxShadow:
          "0px 4px 8px 0px rgba(0, 0, 0, 0.12), 0px 6px 12px 0px rgba(16, 24, 40, 0.12), 0px 1px 16px 0px rgba(16, 24, 40, 0.12)",
      }}
      aria-label={title}
    >
      <header className="flex shrink-0 items-start justify-between gap-4 border-b border-subtle px-5 py-4">
        <div className="min-w-0">
          <h2 className="truncate text-14 font-semibold text-primary">{title}</h2>
          {description && <p className="mt-1 text-11 text-tertiary">{description}</p>}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="flex size-8 shrink-0 items-center justify-center rounded-md text-tertiary hover:bg-layer-1-hover hover:text-primary"
          aria-label="Close"
        >
          <X className="size-4" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </aside>
  );

  const portalContainer = typeof document !== "undefined" ? document.getElementById("full-screen-portal") : null;
  return portalContainer ? createPortal(panel, portalContainer) : panel;
}
