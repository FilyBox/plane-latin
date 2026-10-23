/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { Sparkles } from "lucide-react";
import { useParams } from "react-router";
import { useTranslation } from "@plane/i18n";
import { Tooltip } from "@plane/propel/tooltip";
import { cn } from "@plane/utils";
import { useAppTheme } from "@/hooks/store/use-app-theme";
import { useAssistantAvailable } from "./panel";

/** Top-bar button for the assistant panel (also Ctrl/Cmd + J). */
export const AssistantToggleButton = observer(function AssistantToggleButton() {
  const { t } = useTranslation();
  const { workspaceSlug } = useParams();
  const { isAssistantPanelOpen, toggleAssistantPanel } = useAppTheme();
  if (!useAssistantAvailable(workspaceSlug?.toString())) return null;
  return (
    <Tooltip tooltipContent={`${t("assistant.title")} · ${t("assistant.shortcut")}`} position="bottom">
      <button
        type="button"
        onClick={() => toggleAssistantPanel()}
        aria-pressed={isAssistantPanelOpen}
        aria-label={isAssistantPanelOpen ? t("assistant.close") : t("assistant.open")}
        className={cn(
          "flex size-8 items-center justify-center rounded-md text-secondary hover:bg-layer-1-hover",
          isAssistantPanelOpen && "bg-layer-1 text-accent-primary"
        )}
      >
        <Sparkles className="size-4.5" />
      </button>
    </Tooltip>
  );
});
