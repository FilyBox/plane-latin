/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * What each card already did, as the server recorded it. A chat asks once,
 * with every card's tool call id, when it opens; cards read their entry, so a
 * card applied in another tab (or yesterday) shows "applied" here too and
 * can't be applied twice. The browser's sessionStorage is only a cache.
 */

import { createContext, useContext, useSyncExternalStore } from "react";
import { assistantService } from "@/services/assistant.service";
import type { TAssistantAction } from "@/services/assistant.service";

export type TOutcome = {
  state: "idle" | "busy" | "applied" | "undone" | "discarded";
  id?: string;
  result?: Record<string, unknown>;
};

const known = new Map<string, TOutcome>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

export const outcomeFromAction = (action: TAssistantAction): TOutcome => ({
  state: action.status === "UNDONE" ? "undone" : "applied",
  id: action.id,
  result: action.result,
});

/** Records what the server answered for a card (after apply or undo). */
export function setServerOutcome(toolCallId: string, outcome: TOutcome) {
  if (!toolCallId) return;
  known.set(toolCallId, outcome);
  notify();
}

/** One request per chat: every card's outcome, by tool call id. */
export async function loadOutcomes(workspaceSlug: string, toolCallIds: string[]) {
  const pending = [...new Set(toolCallIds)].filter((id) => id && !known.has(id));
  for (let index = 0; index < pending.length; index += 200) {
    try {
      // eslint-disable-next-line no-await-in-loop -- chunks of 200, in order
      const outcomes = await assistantService.getOutcomes(workspaceSlug, pending.slice(index, index + 200));
      for (const [toolCallId, action] of Object.entries(outcomes)) known.set(toolCallId, outcomeFromAction(action));
    } catch {
      // Cards fall back to the browser's cache
    }
  }
  notify();
}

export function useServerOutcome(toolCallId: string): TOutcome | undefined {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => known.get(toolCallId),
    () => undefined
  );
}

/** The chat a card lives in (it exists once the first answer was saved). */
export const AssistantChatContext = createContext<{ chatId: () => string | null }>({ chatId: () => null });

export const useChatId = () => useContext(AssistantChatContext).chatId;
