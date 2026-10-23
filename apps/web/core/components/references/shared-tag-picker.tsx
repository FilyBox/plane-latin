/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { Fragment, useCallback, useMemo, useState } from "react";
import { usePopper } from "react-popper";
import { Check, Plus } from "lucide-react";
import { Combobox } from "@headlessui/react";
import { useTranslation } from "@plane/i18n";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TEntityName, TSharedTag } from "@plane/types";
import { cn } from "@plane/utils";
import { TAG_KINDS, tagKindKey } from "./entity-meta";
import { SharedTagChip, TAG_KIND_ICONS } from "./shared-tag-chip";
import { createSharedTag, useEntityTags, useSharedTags } from "./use-shared-tags";

type Props = {
  workspaceSlug: string;
  entityName: TEntityName;
  entityId: string;
  disabled?: boolean;
  className?: string;
};

/** The one "Etiquetas" field of a module: workspace tags shared with every
 * other module, grouped by kind (artist, group, type…). */
export function SharedTagPicker({ workspaceSlug, entityName, entityId, disabled, className }: Props) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  // The list mounts when it opens: start in its search box.
  const focusOnOpen = useCallback((node: HTMLInputElement | null) => node?.focus(), []);
  // Fixed + flip: the list opens upward when the field sits near the bottom
  // of a panel, instead of being cut off.
  const [reference, setReference] = useState<HTMLButtonElement | null>(null);
  const [popper, setPopper] = useState<HTMLElement | null>(null);
  const { styles, attributes } = usePopper(reference, popper, {
    placement: "bottom-start",
    strategy: "fixed",
    modifiers: [{ name: "preventOverflow", options: { padding: 12 } }, { name: "flip" }],
  });
  const { data: all = [] } = useSharedTags(workspaceSlug, !disabled);
  const { data: current = [], setTags } = useEntityTags(workspaceSlug, entityName, entityId);
  const selected = current.map((tag) => tag.id);

  const save = async (ids: string[]) => {
    try {
      await setTags(ids);
    } catch {
      setToast({ type: TOAST_TYPE.ERROR, title: t("references.toasts.error") });
    }
  };

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = all.filter((tag) => !needle || tag.name.toLowerCase().includes(needle));
    return TAG_KINDS.map((kind) => ({ kind, tags: matches.filter((tag) => tag.kind === kind) })).filter(
      (group) => group.tags.length > 0
    );
  }, [all, query]);
  const exact = all.some((tag) => tag.name.toLowerCase() === query.trim().toLowerCase());

  const create = async () => {
    const name = query.trim();
    if (!name) return;
    try {
      const tag: TSharedTag = await createSharedTag(workspaceSlug, name);
      setQuery("");
      await save([...selected, tag.id]);
    } catch {
      setToast({ type: TOAST_TYPE.ERROR, title: t("references.toasts.error") });
    }
  };

  return (
    <div className={cn("flex flex-wrap items-center gap-1", className)}>
      {current.map((tag) => (
        <SharedTagChip
          key={tag.id}
          tag={tag}
          onRemove={disabled ? undefined : () => void save(selected.filter((id) => id !== tag.id))}
        />
      ))}
      {!disabled && (
        <Combobox value={selected} onChange={(ids: string[]) => void save(ids)} multiple>
          <div>
            <Combobox.Button as={Fragment}>
              <button
                ref={setReference}
                type="button"
                className="inline-flex h-5 items-center gap-1 rounded-sm px-1.5 text-body-xs-regular text-placeholder hover:bg-layer-1-hover hover:text-secondary"
              >
                <Plus className="size-3" />
                {current.length === 0 ? t("references.tags.add") : ""}
              </button>
            </Combobox.Button>
            <Combobox.Options
              ref={setPopper}
              style={styles.popper}
              {...attributes.popper}
              className="z-30 my-1 w-64 rounded-md border border-strong bg-surface-1 p-2 shadow-raised-200 focus:outline-none"
            >
              <Combobox.Input
                ref={focusOnOpen}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && query.trim() && !exact) {
                    event.preventDefault();
                    void create();
                  }
                }}
                placeholder={t("references.tags.search")}
                className="mb-1 h-7 w-full rounded-sm border border-subtle bg-surface-2 px-2 text-12 outline-none placeholder:text-placeholder"
              />
              <div className="max-h-60 overflow-y-auto">
                {groups.map(({ kind, tags }) => {
                  const Icon = TAG_KIND_ICONS[kind];
                  return (
                    <div key={kind} className="pb-1">
                      <p className="px-1 pt-1.5 pb-0.5 text-10 font-medium text-tertiary">{t(tagKindKey(kind))}</p>
                      {tags.map((tag) => (
                        <Combobox.Option
                          key={tag.id}
                          value={tag.id}
                          className={({ active }) =>
                            cn(
                              "flex cursor-pointer items-center gap-2 rounded-sm px-1 py-1 text-12 text-secondary",
                              active && "bg-layer-1"
                            )
                          }
                        >
                          {({ selected: isSelected }) => (
                            <>
                              <Icon className="size-3 shrink-0" aria-hidden />
                              <span className={cn("flex-1 truncate", isSelected && "text-primary")}>{tag.name}</span>
                              {isSelected && <Check className="size-3.5 shrink-0" />}
                            </>
                          )}
                        </Combobox.Option>
                      ))}
                    </div>
                  );
                })}
                {groups.length === 0 && !query.trim() && (
                  <p className="px-1 py-2 text-12 text-tertiary">{t("references.tags.empty")}</p>
                )}
              </div>
              {query.trim() && !exact && (
                <button
                  type="button"
                  onClick={() => void create()}
                  className="mt-1 w-full truncate rounded-sm px-1 py-1.5 text-left text-12 text-secondary hover:bg-layer-1"
                >
                  {t("references.tags.create_workspace", { name: query.trim() })}
                </button>
              )}
            </Combobox.Options>
          </div>
        </Combobox>
      )}
    </div>
  );
}
