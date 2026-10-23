/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useMemo, useState } from "react";
import { usePopper } from "react-popper";
import { Loader2, Tags } from "lucide-react";
import { Popover } from "@headlessui/react";
import { useTranslation } from "@plane/i18n";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TEntityName, TSharedTag } from "@plane/types";
import { cn } from "@plane/utils";
import { mutate as mutateGlobal } from "swr";
import { referencesService } from "@/services/references.service";
import { TAG_KINDS, tagKindKey } from "./entity-meta";
import { TAG_KIND_ICONS } from "./shared-tag-chip";
import { createSharedTag, useSharedTags } from "./use-shared-tags";

type Props = {
  workspaceSlug: string;
  entityName: TEntityName;
  /** The selected items. */
  ids: string[];
  /** How the selection is named in the result toast ("canciones"…). */
  itemsLabel: string;
  disabled?: boolean;
  /** Classes for the trigger, so it matches the host's action bar. */
  triggerClassName?: string;
  /** Classes for the trigger's text (e.g. hidden until hover on small bars). */
  labelClassName?: string;
};

/** "Etiquetar": put one workspace tag on (or take it off) every selected item
 * — the same tags contracts, files and work items use. */
export function BulkTagMenu({
  workspaceSlug,
  entityName,
  ids,
  itemsLabel,
  disabled,
  triggerClassName,
  labelClassName,
}: Props) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"add" | "remove">("add");
  const [busyTag, setBusyTag] = useState<string | null>(null);
  const focusOnOpen = useCallback((node: HTMLInputElement | null) => node?.focus(), []);
  // Action bars sit at the bottom of the screen: open upward, flip if needed.
  const [reference, setReference] = useState<HTMLButtonElement | null>(null);
  const [popper, setPopper] = useState<HTMLElement | null>(null);
  const { styles, attributes } = usePopper(reference, popper, {
    placement: "top-start",
    strategy: "fixed",
    modifiers: [
      { name: "preventOverflow", options: { padding: 12 } },
      { name: "flip" },
      { name: "offset", options: { offset: [0, 6] } },
    ],
  });
  const { data: all = [] } = useSharedTags(workspaceSlug, !disabled);

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = all.filter((tag) => !needle || tag.name.toLowerCase().includes(needle));
    return TAG_KINDS.map((kind) => ({ kind, tags: matches.filter((tag) => tag.kind === kind) })).filter(
      (group) => group.tags.length > 0
    );
  }, [all, query]);
  const exact = all.some((tag) => tag.name.toLowerCase() === query.trim().toLowerCase());

  const apply = async (tag: TSharedTag, close: () => void) => {
    setBusyTag(tag.id);
    try {
      const result = await referencesService.applyTag(workspaceSlug, tag.id, entityName, ids, mode);
      // Every view that shows tags (panels, the tag view, counts) refreshes.
      void mutateGlobal(
        (key) => Array.isArray(key) && ["ENTITY_TAGS", "SHARED_TAG"].some((prefix) => String(key[0]).startsWith(prefix))
      );
      setToast({
        type: TOAST_TYPE.SUCCESS,
        title: t(mode === "add" ? "references.bulk.added" : "references.bulk.removed", {
          name: tag.name,
          count: result.changed,
          items: itemsLabel,
        }),
        message:
          result.changed < result.matched
            ? t("references.bulk.already", { count: result.matched - result.changed })
            : undefined,
      });
      setQuery("");
      close();
    } catch {
      setToast({ type: TOAST_TYPE.ERROR, title: t("references.toasts.error") });
    } finally {
      setBusyTag(null);
    }
  };

  const createAndApply = async (close: () => void) => {
    const name = query.trim();
    if (!name) return;
    try {
      const tag = await createSharedTag(workspaceSlug, name);
      await apply(tag, close);
    } catch {
      setToast({ type: TOAST_TYPE.ERROR, title: t("references.toasts.error") });
    }
  };

  return (
    <Popover className="shrink-0">
      {({ close }) => (
        <>
          <Popover.Button
            ref={setReference}
            disabled={disabled || ids.length === 0}
            aria-label={t("references.bulk.trigger")}
            title={t("references.bulk.trigger")}
            className={cn(triggerClassName, (disabled || ids.length === 0) && "pointer-events-none opacity-50")}
          >
            <Tags className="size-3.5 shrink-0" />
            <span className={labelClassName}>{t("references.bulk.trigger")}</span>
          </Popover.Button>
          <Popover.Panel
            ref={setPopper}
            style={styles.popper}
            {...attributes.popper}
            className="z-40 w-72 rounded-md border border-strong bg-surface-1 p-2 shadow-raised-200 focus:outline-none"
          >
            <div className="mb-2 grid grid-cols-2 gap-1 rounded-md bg-layer-1 p-0.5" role="radiogroup">
              {(["add", "remove"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={mode === value}
                  onClick={() => setMode(value)}
                  className={cn(
                    "rounded-sm py-1 text-12",
                    mode === value ? "bg-surface-1 font-medium text-primary shadow-raised-100" : "text-tertiary"
                  )}
                >
                  {t(value === "add" ? "references.bulk.add_mode" : "references.bulk.remove_mode")}
                </button>
              ))}
            </div>
            <input
              ref={focusOnOpen}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && mode === "add" && query.trim() && !exact) {
                  event.preventDefault();
                  void createAndApply(close);
                }
              }}
              placeholder={t("references.tags.search")}
              aria-label={t("references.tags.search")}
              className="mb-1 h-7 w-full rounded-sm border border-subtle bg-surface-2 px-2 text-12 outline-none placeholder:text-placeholder"
            />
            <div className="max-h-64 overflow-y-auto">
              {groups.map(({ kind, tags }) => {
                const Icon = TAG_KIND_ICONS[kind];
                return (
                  <div key={kind} className="pb-1">
                    <p className="px-1 pt-1.5 pb-0.5 text-10 font-medium text-tertiary">{t(tagKindKey(kind))}</p>
                    {tags.map((tag) => (
                      <button
                        key={tag.id}
                        type="button"
                        disabled={busyTag !== null}
                        onClick={() => void apply(tag, close)}
                        className="flex w-full items-center gap-2 rounded-sm px-1 py-1 text-left text-12 text-secondary hover:bg-layer-1 disabled:opacity-60"
                      >
                        <Icon className="size-3 shrink-0" aria-hidden />
                        <span className="flex-1 truncate">{tag.name}</span>
                        {busyTag === tag.id && <Loader2 className="size-3 animate-spin" aria-hidden />}
                      </button>
                    ))}
                  </div>
                );
              })}
              {groups.length === 0 && !query.trim() && (
                <p className="px-1 py-2 text-12 text-tertiary">{t("references.tags.empty")}</p>
              )}
            </div>
            {mode === "add" && query.trim() && !exact && (
              <button
                type="button"
                disabled={busyTag !== null}
                onClick={() => void createAndApply(close)}
                className="mt-1 w-full truncate rounded-sm px-1 py-1.5 text-left text-12 text-secondary hover:bg-layer-1"
              >
                {t("references.bulk.create_and_add", { name: query.trim(), count: ids.length })}
              </button>
            )}
            <p className="mt-1 border-t border-subtle px-1 pt-1.5 text-11 text-tertiary">
              {t(mode === "add" ? "references.bulk.hint_add" : "references.bulk.hint_remove", {
                count: ids.length,
                items: itemsLabel,
              })}
            </p>
          </Popover.Panel>
        </>
      )}
    </Popover>
  );
}
