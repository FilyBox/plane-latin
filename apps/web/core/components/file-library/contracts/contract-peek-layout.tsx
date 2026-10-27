/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Columns2, Maximize2, X } from "lucide-react";
// plane imports
import { useTranslation } from "@plane/i18n";
import { CenterPanelIcon, FullScreenPanelIcon, SidePanelIcon } from "@plane/propel/icons";
import { Tooltip } from "@plane/propel/tooltip";
import { cn } from "@plane/utils";
import { StackLayer } from "@/components/panel-stack/stack-layer";
import { usePanelLayer } from "@/components/panel-stack/use-panel-layer";

type TPeekMode = "side-peek" | "modal" | "full-screen";

const PEEK_OPTIONS: { key: TPeekMode; icon: typeof SidePanelIcon; i18nKey: string }[] = [
  { key: "side-peek", icon: SidePanelIcon, i18nKey: "common.side_peek" },
  { key: "modal", icon: CenterPanelIcon, i18nKey: "common.modal" },
  { key: "full-screen", icon: FullScreenPanelIcon, i18nKey: "common.full_screen" },
];

export type TContractPeekTab = {
  key: string;
  label: string;
  disabled?: boolean;
  document?: boolean;
};

type Props = {
  title: string;
  onClose: () => void;
  tabs: TContractPeekTab[];
  activeTab: string;
  desktopActiveTab?: string;
  onTabChange: (tab: string) => void;
  /** A function receives the control that gives the document half the whole
   * container, so the pane can seat it in its own chrome instead of having it
   * floated over the top-right corner, where it covered the PDF viewer's
   * actions menu. It gets `null` on mobile, where there is no split. */
  documentPane: React.ReactNode | ((expandControl: React.ReactNode) => React.ReactNode);
  sidePane: React.ReactNode;
  status?: React.ReactNode;
  headerActions?: React.ReactNode;
  topContent?: React.ReactNode;
  footer?: React.ReactNode;
  /** Escape leaves the panel alone (a confirmation is open on top of it). */
  suspendClose?: boolean;
};

/** Shared Plane peek shell used by analyzed and signature-workflow contracts. */
export function ContractPeekLayout({
  title,
  onClose,
  tabs,
  activeTab,
  desktopActiveTab = activeTab,
  onTabChange,
  documentPane,
  sidePane,
  status,
  headerActions,
  topContent,
  footer,
  suspendClose = false,
}: Props) {
  const { t } = useTranslation();
  const [peekMode, setPeekMode] = useState<TPeekMode>("side-peek");
  const layer = usePanelLayer(true, { variant: peekMode === "side-peek" ? "side" : "center" });
  const isTopLayer = layer.isTop;
  // Only the panel on top closes on Escape
  useEffect(() => {
    if (suspendClose || !isTopLayer) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [suspendClose, isTopLayer, onClose]);
  // Which half of the split has the whole width. Independent of `peekMode`:
  // the document and the side pane each sometimes need the full container.
  const [expanded, setExpanded] = useState<"none" | "document" | "side">("none");
  const documentTab = tabs.find((tab) => tab.document);
  const sideTabs = tabs.filter((tab) => !tab.document);

  const tabButton = (tab: TContractPeekTab, selected: boolean) => (
    <button
      key={tab.key}
      type="button"
      disabled={tab.disabled}
      onClick={() => onTabChange(tab.key)}
      className={cn(
        "rounded-t-sm border-b-2 px-3 py-1.5 text-12 font-medium disabled:opacity-40",
        selected ? "border-accent-strong text-accent-primary" : "border-transparent text-tertiary hover:text-secondary"
      )}
    >
      {tab.label}
    </button>
  );

  const renderDocumentPane = (expandControl: React.ReactNode) =>
    typeof documentPane === "function" ? documentPane(expandControl) : documentPane;

  /** Gives one pane the whole width, or hands the split back. */
  const expandButton = (pane: "document" | "side") => {
    const isExpanded = expanded === pane;
    const label = t(isExpanded ? "file_library.contracts.peek.split_view" : "file_library.contracts.peek.expand_pane");
    return (
      <Tooltip tooltipContent={label}>
        <button
          type="button"
          aria-label={label}
          aria-pressed={isExpanded}
          onClick={() => setExpanded(isExpanded ? "none" : pane)}
          className="rounded-sm p-1 text-tertiary hover:bg-layer-1-hover hover:text-primary"
        >
          {isExpanded ? <Columns2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
        </button>
      </Tooltip>
    );
  };

  const panelClassName = cn("absolute flex flex-col overflow-hidden rounded-sm border border-subtle bg-surface-1", {
    "top-0 right-0 bottom-0 w-full border-0 border-l lg:w-[80%] xl:w-[72%]": peekMode === "side-peek",
    "top-[8.33%] left-[8.33%] size-5/6 max-lg:top-0 max-lg:left-0 max-lg:size-full": peekMode === "modal",
    "inset-0 lg:m-4": peekMode === "full-screen",
  });

  const content = (
    <StackLayer
      layer={layer}
      backdrop="dim"
      onBackdropClick={onClose}
      dialog={{ label: title, modal: true }}
      className={panelClassName}
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-subtle px-3 py-2.5 sm:px-4">
        <div className="flex min-w-0 items-center gap-2">
          <div className="hidden items-center gap-0.5 rounded-md border border-subtle p-0.5 lg:flex">
            {PEEK_OPTIONS.map((option) => (
              <Tooltip key={option.key} tooltipContent={t(option.i18nKey)}>
                <button
                  type="button"
                  onClick={() => setPeekMode(option.key)}
                  className={cn(
                    "rounded-sm p-1",
                    peekMode === option.key ? "bg-layer-1 text-primary" : "text-tertiary hover:bg-layer-1-hover"
                  )}
                >
                  <option.icon className="size-3.5" />
                </button>
              </Tooltip>
            ))}
          </div>
          <span className="truncate text-14 font-medium">{title}</span>
          {status}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {headerActions}
          <button
            type="button"
            aria-label={t("close")}
            onClick={onClose}
            className="rounded-sm p-1.5 hover:bg-layer-1-hover"
          >
            <X className="size-4" />
          </button>
        </div>
      </div>

      {topContent}

      <div className="flex min-h-0 flex-1 flex-col lg:hidden">
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-subtle px-3 pt-2">
          {tabs.map((tab) => tabButton(tab, activeTab === tab.key))}
        </div>
        <div className="min-h-0 flex-1">{documentTab?.key === activeTab ? renderDocumentPane(null) : sidePane}</div>
        {documentTab?.key !== activeTab ? footer : null}
      </div>

      <div className="hidden min-h-0 flex-1 lg:flex">
        {expanded !== "side" && (
          <div
            className={cn("min-h-0 border-r border-subtle", expanded === "document" ? "w-full border-r-0" : "w-1/2")}
          >
            {renderDocumentPane(expandButton("document"))}
          </div>
        )}
        {expanded !== "document" && (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-subtle px-3 pt-2">
              {sideTabs.map((tab) => tabButton(tab, desktopActiveTab === tab.key))}
              <span className="ml-auto pb-1">{expandButton("side")}</span>
            </div>
            <div className="min-h-0 min-w-0 flex-1">{sidePane}</div>
            {footer}
          </div>
        )}
      </div>
    </StackLayer>
  );

  const portalContainer = typeof document !== "undefined" ? document.getElementById("full-screen-portal") : null;
  return portalContainer ? createPortal(content, portalContainer) : content;
}
