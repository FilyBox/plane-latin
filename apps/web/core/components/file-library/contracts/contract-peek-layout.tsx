/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
// plane imports
import { useTranslation } from "@plane/i18n";
import { CenterPanelIcon, FullScreenPanelIcon, SidePanelIcon } from "@plane/propel/icons";
import { Tooltip } from "@plane/propel/tooltip";
import { cn } from "@plane/utils";

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
  documentPane: React.ReactNode;
  sidePane: React.ReactNode;
  status?: React.ReactNode;
  headerActions?: React.ReactNode;
  topContent?: React.ReactNode;
  footer?: React.ReactNode;
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
}: Props) {
  const { t } = useTranslation();
  const [peekMode, setPeekMode] = useState<TPeekMode>("side-peek");
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

  const panelClassName = cn(
    "absolute z-[25] flex flex-col overflow-hidden rounded-sm border border-subtle bg-surface-1 transition-all duration-300",
    {
      "top-0 right-0 bottom-0 w-full border-0 border-l lg:w-[80%] xl:w-[72%]": peekMode === "side-peek",
      "top-[8.33%] left-[8.33%] size-5/6 max-lg:top-0 max-lg:left-0 max-lg:size-full": peekMode === "modal",
      "inset-0 lg:m-4": peekMode === "full-screen",
    }
  );

  const content = (
    <div className="absolute inset-0 z-[24]">
      <button type="button" className="absolute inset-0 bg-black/20" onClick={onClose} aria-label={t("close")} />
      <div
        className={panelClassName}
        style={{
          boxShadow:
            "0px 4px 8px 0px rgba(0, 0, 0, 0.12), 0px 6px 12px 0px rgba(16, 24, 40, 0.12), 0px 1px 16px 0px rgba(16, 24, 40, 0.12)",
        }}
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
          <div className="min-h-0 flex-1">{documentTab?.key === activeTab ? documentPane : sidePane}</div>
          {documentTab?.key !== activeTab ? footer : null}
        </div>

        <div className="hidden min-h-0 flex-1 lg:flex">
          <div className="min-h-0 w-1/2 border-r border-subtle">{documentPane}</div>
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-subtle px-3 pt-2">
              {sideTabs.map((tab) => tabButton(tab, desktopActiveTab === tab.key))}
            </div>
            <div className="min-h-0 flex-1">{sidePane}</div>
            {footer}
          </div>
        </div>
      </div>
    </div>
  );

  const portalContainer = typeof document !== "undefined" ? document.getElementById("full-screen-portal") : null;
  return portalContainer ? createPortal(content, portalContainer) : content;
}
