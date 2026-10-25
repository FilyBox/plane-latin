/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * "Ask AI" from anywhere: a contract, a file, a song, a tag or a selection.
 * Opens the assistant panel with those items already in the composer as
 * @-mentions, ready for the user to type the question.
 */

import { useCallback } from "react";
import { Sparkles } from "lucide-react";
import { useParams } from "react-router";
import { useTranslation } from "@plane/i18n";
import { Tooltip } from "@plane/propel/tooltip";
import { cn } from "@plane/utils";
import { useAppTheme } from "@/hooks/store/use-app-theme";
import type { TMention } from "./mentions";
import { useAssistantAvailable } from "./panel";

export type TAskRequest = { mentions: TMention[]; text?: string };

// The composer may not be mounted yet (first time the panel opens): the last
// request waits here until it subscribes.
let pending: TAskRequest | null = null;
const listeners = new Set<(request: TAskRequest) => void>();

export function subscribeToAsk(listener: (request: TAskRequest) => void): () => void {
  listeners.add(listener);
  if (pending) {
    const request = pending;
    pending = null;
    listener(request);
  }
  return () => listeners.delete(listener);
}

export function useAskAssistant() {
  const { toggleAssistantPanel } = useAppTheme();
  return useCallback(
    (request: TAskRequest) => {
      toggleAssistantPanel(true);
      if (listeners.size === 0) {
        pending = request;
        return;
      }
      for (const listener of listeners) listener(request);
    },
    [toggleAssistantPanel]
  );
}

type Props = {
  mentions: TMention[];
  /** Icon only (tight headers) or icon + label */
  compact?: boolean;
  className?: string;
  /** Runs first, e.g. to close a modal covering the panel. */
  onAsk?: () => void;
  /** Icon size, to match the header's other buttons */
  iconClassName?: string;
};

export function AskAssistantButton({ mentions, compact = false, className, onAsk, iconClassName }: Props) {
  const { t } = useTranslation();
  const { workspaceSlug } = useParams();
  const available = useAssistantAvailable(workspaceSlug?.toString());
  const ask = useAskAssistant();
  if (!available || mentions.length === 0) return null;
  const label = t("assistant.ask_ai");
  const button = (
    <button
      type="button"
      onClick={() => {
        onAsk?.();
        ask({ mentions });
      }}
      aria-label={label}
      className={cn(
        "flex shrink-0 items-center gap-1.5 rounded-md text-12 text-secondary hover:bg-layer-1-hover hover:text-accent-primary",
        compact ? "p-1.5" : "border border-subtle px-2 py-1",
        className
      )}
    >
      <Sparkles className={cn("size-3.5 shrink-0", iconClassName)} />
      {!compact && <span className="whitespace-nowrap">{label}</span>}
    </button>
  );
  // Icon only: the same tooltip as the buttons beside it (the label is visible otherwise)
  return compact ? <Tooltip tooltipContent={label}>{button}</Tooltip> : button;
}
