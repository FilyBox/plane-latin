/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { Fragment, useCallback, useMemo, useState } from "react";
import { usePopper } from "react-popper";
import { Combine, Plus, X } from "lucide-react";
import { Combobox } from "@headlessui/react";
import { useTranslation } from "@plane/i18n";
import type { TSharedTag, TSharedTagMode } from "@plane/types";
import { cn } from "@plane/utils";
import { TAG_KINDS, tagKindKey } from "../entity-meta";
import { TAG_KIND_ICONS } from "../shared-tag-chip";
import { useSharedTags } from "../use-shared-tags";

/** The API combines up to this many extra tags with the open one. */
export const MAX_COMBINED_TAGS = 10;

type Props = {
  workspaceSlug: string;
  tagId: string;
  /** The extra tags as the server applied them. */
  withTags: TSharedTag[];
  mode: TSharedTagMode;
  onChange: (ids: string[], mode: TSharedTagMode) => void;
};

/** "Combine with…": narrows the open tag to what also carries other tags
 * (an artist and one of their albums), or widens it to any of them. */
export function CombineTags({ workspaceSlug, tagId, withTags, mode, onChange }: Props) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const focusOnOpen = useCallback((node: HTMLInputElement | null) => node?.focus(), []);
  const [reference, setReference] = useState<HTMLButtonElement | null>(null);
  const [popper, setPopper] = useState<HTMLElement | null>(null);
  const { styles, attributes } = usePopper(reference, popper, {
    placement: "bottom-start",
    strategy: "fixed",
    modifiers: [{ name: "preventOverflow", options: { padding: 12 } }, { name: "flip" }],
  });
  const { data: all = [] } = useSharedTags(workspaceSlug);
  const ids = withTags.map((tag) => tag.id);

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const taken = new Set([tagId, ...ids]);
    const matches = all.filter((tag) => !taken.has(tag.id) && (!needle || tag.name.toLowerCase().includes(needle)));
    return TAG_KINDS.map((kind) => ({ kind, tags: matches.filter((tag) => tag.kind === kind) })).filter(
      (group) => group.tags.length > 0
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, query, tagId, ids.join(",")]);

  const add = (id: string | null) => {
    if (!id) return;
    setQuery("");
    onChange([...ids, id], mode);
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {withTags.map((tag) => {
        const Icon = TAG_KIND_ICONS[tag.kind];
        return (
          <span
            key={tag.id}
            className="inline-flex h-8 max-w-56 items-center gap-1 rounded-md border border-accent-strong bg-accent-subtle pr-1 pl-2 text-13 text-primary"
            title={t(tagKindKey(tag.kind))}
          >
            <Plus className="size-3 shrink-0 text-secondary" aria-hidden />
            <Icon className="size-3.5 shrink-0 text-secondary" aria-hidden />
            <span className="truncate">{tag.name}</span>
            <button
              type="button"
              onClick={() =>
                onChange(
                  ids.filter((id) => id !== tag.id),
                  mode
                )
              }
              aria-label={t("references.tags.combine.remove", { name: tag.name })}
              className="grid size-5 shrink-0 place-items-center rounded-sm text-tertiary hover:bg-layer-1-hover hover:text-primary"
            >
              <X className="size-3" />
            </button>
          </span>
        );
      })}

      {ids.length > 0 && (
        <div
          role="radiogroup"
          aria-label={t("references.tags.combine.mode_label")}
          className="flex h-8 items-center rounded-md border border-subtle p-0.5"
        >
          {(["all", "any"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={mode === value}
              title={t(`references.tags.combine.${value}_help`)}
              onClick={() => mode !== value && onChange(ids, value)}
              className={cn(
                "h-full rounded-sm px-2 text-12",
                mode === value ? "bg-layer-1 font-medium text-primary" : "text-tertiary hover:text-primary"
              )}
            >
              {t(`references.tags.combine.${value}`)}
            </button>
          ))}
        </div>
      )}

      {ids.length < MAX_COMBINED_TAGS && (
        <Combobox value={null} onChange={add}>
          <div>
            <Combobox.Button as={Fragment}>
              <button
                ref={setReference}
                type="button"
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-dashed border-subtle px-2 text-13 text-secondary hover:bg-layer-1-hover hover:text-primary"
              >
                <Combine className="size-3.5" aria-hidden />
                {t("references.tags.combine.button")}
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
                placeholder={t("references.tags.combine.search")}
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
                              active && "bg-layer-1 text-primary"
                            )
                          }
                        >
                          <Icon className="size-3 shrink-0" aria-hidden />
                          <span className="flex-1 truncate">{tag.name}</span>
                        </Combobox.Option>
                      ))}
                    </div>
                  );
                })}
                {groups.length === 0 && (
                  <p className="px-1 py-2 text-12 text-tertiary">
                    {query.trim() ? t("references.tags.no_matches") : t("references.tags.combine.nothing_left")}
                  </p>
                )}
              </div>
            </Combobox.Options>
          </div>
        </Combobox>
      )}
    </div>
  );
}
