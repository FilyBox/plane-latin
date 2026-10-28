/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * Everything the assistant changed after someone approved it — tags put or
 * removed, work items and pages created, tags merged — with undo on each.
 * Admins can switch to the whole workspace's history.
 */

import { useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  ArrowLeft,
  ClipboardCheck,
  FileCog,
  FilePen,
  FilePlus2,
  FileSignature,
  FileStack,
  FileText,
  Files,
  FolderCog,
  ListChecks,
  ListTodo,
  Merge,
  MessageSquare,
  Receipt,
  Scissors,
  Tag,
  Tags,
  Undo2,
} from "lucide-react";
import useSWR, { mutate as mutateGlobal } from "swr";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import { cn } from "@plane/utils";
import { assistantService } from "@/services/assistant.service";
import type { TAssistantAction } from "@/services/assistant.service";
import { taggingService } from "@/services/references.service";
import { AssistantLink } from "./links";

const ICONS: Record<TAssistantAction["kind"], LucideIcon> = {
  TAG_ITEMS: Tag,
  UNTAG_ITEMS: Tags,
  CREATE_WORK_ITEM: ListTodo,
  CREATE_PAGE: FileText,
  EDIT_PAGE: FilePen,
  MERGE_TAGS: Merge,
  SPLIT_PDF: Scissors,
  MERGE_PDF: Files,
  EDIT_PDF_PAGES: FileStack,
  CREATE_TEMPLATE_VARIANT: FilePlus2,
  EDIT_TEMPLATE_VARIANT: FileCog,
  CREATE_CONTRACT_DRAFT: FileSignature,
  EDIT_CONTRACT: FilePen,
  EDIT_WORK_ITEMS: ListChecks,
  COMMENT_WORK_ITEM: MessageSquare,
  ORGANIZE_FILES: FolderCog,
  CREATE_EXPENSES: Receipt,
  CATALOG_FIXES: ClipboardCheck,
};

const errorText = (error: unknown, fallback: string) => {
  const failure = error as { error?: string; response?: { data?: { error?: string } } };
  return failure?.response?.data?.error ?? failure?.error ?? fallback;
};

function timeAgo(iso: string, locale: string) {
  const seconds = (new Date(iso).getTime() - Date.now()) / 1000;
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [unit, size] of steps) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  }
  return format.format(0, "minute");
}

/** Where a change can be seen: the work item or page it created, or the tag. */
function linkFor(action: TAssistantAction, workspaceSlug: string): string | undefined {
  const result = action.result as { path?: string; tag?: { id?: string } };
  if (result.path) return result.path;
  if (result.tag?.id) return `/${workspaceSlug}/tags/${result.tag.id}`;
  return undefined;
}

export function ActionsView({ workspaceSlug, onBack }: { workspaceSlug: string; onBack: () => void }) {
  const { t, currentLocale } = useTranslation();
  const [scope, setScope] = useState<"mine" | "all">("mine");
  const [busy, setBusy] = useState<string | null>(null);
  const { data, mutate } = useSWR(["ASSISTANT_ACTIONS", workspaceSlug, scope], () =>
    assistantService.getActions(workspaceSlug, scope)
  );

  const undo = async (action: TAssistantAction) => {
    setBusy(action.id);
    try {
      if (action.kind === "MERGE_TAGS") await taggingService.act(workspaceSlug, action.id, "undo");
      else await assistantService.undoAction(workspaceSlug, action.id);
      await mutate();
      void mutateGlobal((key) => Array.isArray(key) && /^(SHARED_TAG|FILE_TAG|MUSIC|TAGGING)/.test(String(key[0])));
      setToast({ type: TOAST_TYPE.SUCCESS, title: t("assistant.actions.undone") });
    } catch (error) {
      setToast({ type: TOAST_TYPE.ERROR, title: errorText(error, t("assistant.actions.failed")) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-subtle px-3 py-2">
        <button
          type="button"
          onClick={onBack}
          className="rounded-md p-1 text-tertiary hover:bg-layer-1-hover hover:text-secondary"
          aria-label={t("assistant.memory.back")}
          title={t("assistant.memory.back")}
        >
          <ArrowLeft className="size-4" />
        </button>
        <p className="min-w-0 flex-1 truncate text-13 font-medium text-primary">{t("assistant.history_view.title")}</p>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
        <p className="text-12 text-tertiary">{t("assistant.history_view.intro")}</p>
        {data?.can_see_all && (
          <div role="tablist" className="flex gap-1">
            {(["mine", "all"] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={scope === value}
                onClick={() => setScope(value)}
                className={cn(
                  "rounded-md px-2.5 py-1 text-12",
                  scope === value ? "bg-layer-2 font-medium text-primary" : "text-tertiary hover:text-secondary"
                )}
              >
                {t(`assistant.history_view.scope.${value}`)}
              </button>
            ))}
          </div>
        )}
        {!data ? null : data.actions.length === 0 ? (
          <p className="py-6 text-center text-12 text-tertiary">{t("assistant.history_view.empty")}</p>
        ) : (
          <ul className="space-y-2">
            {data.actions.map((action) => {
              const Icon = ICONS[action.kind] ?? Tag;
              const undone = action.status === "UNDONE";
              const link = undone ? undefined : linkFor(action, workspaceSlug);
              return (
                <li key={action.id} className="flex items-start gap-2.5 rounded-lg border border-subtle px-3 py-2">
                  <Icon className="mt-0.5 size-4 shrink-0 text-tertiary" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p
                      className={cn(
                        "text-13 break-words",
                        undone ? "text-tertiary line-through decoration-1" : "text-primary"
                      )}
                    >
                      {link ? <AssistantLink href={link}>{action.summary}</AssistantLink> : action.summary}
                    </p>
                    <p className="mt-0.5 text-11 text-tertiary">
                      {[
                        scope === "all" && action.actor ? action.actor : "",
                        timeAgo(action.created_at, currentLocale),
                        undone ? t("assistant.actions.undone") : "",
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  </div>
                  {!undone && (
                    <Button
                      variant="secondary"
                      size="sm"
                      loading={busy === action.id}
                      onClick={() => void undo(action)}
                    >
                      <Undo2 className="size-3" />
                      {t("assistant.actions.undo")}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
