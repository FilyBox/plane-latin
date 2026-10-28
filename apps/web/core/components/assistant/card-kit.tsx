/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * What every edit card shares: apply and undo against the actions endpoint
 * (recording the outcome on the server), and the list of fields undo left
 * as they were because someone changed them since.
 */

import { AlertTriangle } from "lucide-react";
import { useTranslation } from "@plane/i18n";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import { assistantService } from "@/services/assistant.service";
import type { TAssistantAction } from "@/services/assistant.service";
import { alreadyUndone, errorText } from "./action-cards";
import { outcomeFromAction } from "./outcome-store";
import type { TOutcome } from "./outcome-store";

type TMeta = { tool_call_id: string; chat_id?: string };

export function useCardActions(
  slug: string,
  outcome: TOutcome,
  remember: (next: TOutcome) => void,
  meta: TMeta,
  failure?: (error: unknown) => string | undefined
) {
  const { t } = useTranslation();
  const apply = async (body: Record<string, unknown>): Promise<TAssistantAction | undefined> => {
    remember({ state: "busy" });
    try {
      const action = await assistantService.createAction(slug, { ...meta, ...body });
      remember(outcomeFromAction(action));
      return action;
    } catch (error) {
      remember({ state: "idle" });
      setToast({
        type: TOAST_TYPE.ERROR,
        title: failure?.(error) ?? errorText(error, t("assistant.actions.failed")),
      });
      return undefined;
    }
  };
  const undo = async () => {
    if (!outcome.id) return;
    remember({ ...outcome, state: "busy" });
    try {
      const action = await assistantService.undoAction(slug, outcome.id);
      remember(outcomeFromAction(action));
    } catch (error) {
      if (alreadyUndone(error)) remember({ state: "undone", id: outcome.id });
      else {
        remember({ ...outcome, state: "applied" });
        setToast({ type: TOAST_TYPE.ERROR, title: errorText(error, t("assistant.actions.failed")) });
      }
    }
  };
  return { apply, undo };
}

type TConflict = { field: string; titulo?: string; key?: string; name?: string; current?: unknown };

/** After undo: what stayed because someone changed it after the assistant. */
export function UndoConflicts({ outcome, label }: { outcome: TOutcome; label?: (field: string) => string }) {
  const { t } = useTranslation();
  const conflicts = (outcome.result?.undo_conflicts as TConflict[] | undefined) ?? [];
  if (outcome.state !== "undone" || conflicts.length === 0) return null;
  return (
    <div className="mt-1.5 rounded-md bg-warning-subtle px-2 py-1.5 text-11 text-warning-primary">
      <p className="flex items-center gap-1 font-medium">
        <AlertTriangle className="size-3" />
        {t("assistant.actions.undo_conflicts", { count: conflicts.length })}
      </p>
      <ul className="mt-0.5 space-y-0.5">
        {conflicts.slice(0, 20).map((conflict) => (
          <li key={`${conflict.titulo ?? conflict.key ?? conflict.name ?? ""}:${conflict.field}`}>
            {[conflict.titulo ?? conflict.key ?? conflict.name, label ? label(conflict.field) : conflict.field]
              .filter(Boolean)
              .join(" · ")}
          </li>
        ))}
      </ul>
    </div>
  );
}
