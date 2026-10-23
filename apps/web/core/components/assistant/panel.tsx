/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * The assistant as a right-hand panel, Plane's sidebar mirrored: on desktop
 * it takes its own column and pushes the page aside (drag its left edge to
 * resize); on phones it covers the screen. Ctrl/Cmd + J toggles it anywhere.
 *
 * Once opened it stays mounted while hidden, so closing it never cuts off an
 * answer that is still streaming.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { observer } from "mobx-react";
import { useParams } from "react-router";
import { EUserPermissions, EUserPermissionsLevel } from "@plane/constants";
import { useLocalStorage } from "@plane/hooks";
import { useTranslation } from "@plane/i18n";
import { cn } from "@plane/utils";
import { useAppTheme } from "@/hooks/store/use-app-theme";
import { useWorkspace } from "@/hooks/store/use-workspace";
import { useUserPermissions } from "@/hooks/store/user";
import { AssistantChat } from "./chat";

const DEFAULT_WIDTH = 420;
const MIN_WIDTH = 340;
const MAX_WIDTH = 760;

/** The assistant exists where an AI module is on, for admins and members. */
export function useAssistantAvailable(workspaceSlug: string | undefined): boolean {
  const { isWorkspaceFeatureEnabled } = useWorkspace();
  const { allowPermissions } = useUserPermissions();
  if (!workspaceSlug) return false;
  const modules =
    isWorkspaceFeatureEnabled(workspaceSlug, "file_library") ||
    isWorkspaceFeatureEnabled(workspaceSlug, "music_catalog");
  return (
    modules &&
    allowPermissions([EUserPermissions.ADMIN, EUserPermissions.MEMBER], EUserPermissionsLevel.WORKSPACE, workspaceSlug)
  );
}

export const AssistantPanel = observer(function AssistantPanel() {
  const { t } = useTranslation();
  const { workspaceSlug } = useParams();
  const slug = workspaceSlug?.toString();
  const { isAssistantPanelOpen, toggleAssistantPanel } = useAppTheme();
  const available = useAssistantAvailable(slug);
  const { storedValue, setValue } = useLocalStorage("assistant_panel_width", DEFAULT_WIDTH);
  const [width, setWidth] = useState<number>(storedValue ?? DEFAULT_WIDTH);
  const [resizing, setResizing] = useState(false);
  const [mounted, setMounted] = useState(isAssistantPanelOpen);
  const open = available && isAssistantPanelOpen;

  const panelRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!open) return;
    setMounted(true);
    // Opening the panel means "I want to ask": put the cursor in the composer.
    const timer = setTimeout(() => panelRef.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus(), 220);
    return () => clearTimeout(timer);
  }, [open]);

  // Ctrl/Cmd + J, like the command palette's Ctrl/Cmd + K.
  useEffect(() => {
    if (!available) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === "j") {
        event.preventDefault();
        toggleAssistantPanel();
      }
      if (event.key === "Escape" && isAssistantPanelOpen && window.matchMedia("(max-width: 1023px)").matches) {
        toggleAssistantPanel(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [available, isAssistantPanelOpen, toggleAssistantPanel]);

  // Drag the left edge: the panel grows as the pointer moves left.
  const startX = useRef(0);
  const startWidth = useRef(width);
  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      startX.current = event.clientX;
      startWidth.current = width;
      setResizing(true);
      const onMove = (move: PointerEvent) => {
        const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth.current + (startX.current - move.clientX)));
        setWidth(next);
      };
      const onUp = (up: PointerEvent) => {
        const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth.current + (startX.current - up.clientX)));
        setValue(next);
        setResizing(false);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [width, setValue]
  );

  if (!available || !slug || !mounted) return null;

  return (
    <aside
      id="assistant-panel"
      // Clicking in the panel must not close the page's open peek (the user is
      // probably asking about it).
      data-prevent-outside-click
      ref={panelRef}
      aria-label={t("assistant.title")}
      aria-hidden={!open}
      style={{ "--assistant-width": `${width}px` } as React.CSSProperties}
      className={cn(
        // Phones: full screen. Tablets: a sheet over the page from the right.
        "fixed inset-y-0 right-0 z-30 flex w-full flex-col bg-surface-1",
        "sm:w-[min(var(--assistant-width),100vw)] sm:border-l sm:border-subtle sm:shadow-raised-300",
        // Desktop: its own column beside the page, pushing it aside.
        "lg:relative lg:inset-auto lg:z-auto lg:h-full lg:shrink-0 lg:overflow-hidden lg:rounded-lg lg:border lg:shadow-none",
        !resizing && "motion-reduce:transition-none lg:transition-[width,opacity,margin] lg:duration-200 lg:ease-out",
        open
          ? "lg:w-[var(--assistant-width)] lg:opacity-100"
          : "pointer-events-none invisible lg:-ml-2 lg:w-0 lg:border-0 lg:opacity-0"
      )}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t("assistant.resize")}
        title={t("assistant.resize")}
        onPointerDown={onPointerDown}
        onDoubleClick={() => {
          setWidth(DEFAULT_WIDTH);
          setValue(DEFAULT_WIDTH);
        }}
        className={cn(
          "absolute inset-y-0 left-0 z-10 hidden w-1.5 cursor-col-resize sm:block",
          "after:absolute after:inset-y-0 after:left-0 after:w-0.5 after:transition-colors hover:after:bg-accent-primary/50",
          resizing && "after:bg-accent-primary"
        )}
      />
      {/* Fixed inner width while the column animates, so text doesn't reflow. */}
      <div className="h-full min-h-0 w-full lg:w-[var(--assistant-width)]">
        <AssistantChat workspaceSlug={slug} onClose={() => toggleAssistantPanel(false)} />
      </div>
    </aside>
  );
});
