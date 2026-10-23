/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useMemo, useState } from "react";
import { Check, Loader2, Search } from "lucide-react";
import useSWR from "swr";
import { useTranslation } from "@plane/i18n";
import type { TEntityCard, TEntityName } from "@plane/types";
import { EModalPosition, EModalWidth, ModalCore } from "@plane/ui";
import { cn } from "@plane/utils";
import useDebounce from "@/hooks/use-debounce";
import { referencesService } from "@/services/references.service";
import { ENTITY_ICONS, ENTITY_ORDER, entityGroupKey } from "./entity-meta";

type Props = {
  workspaceSlug: string;
  isOpen: boolean;
  onClose: () => void;
  /** Already attached: shown as such and not offered again. */
  selectedKeys?: string[];
  /** Types not to offer (e.g. the item itself). */
  exclude?: TEntityName[];
  onPick: (card: TEntityCard) => Promise<void> | void;
};

/** Search the whole workspace — contracts, songs, files, work items… — and
 * pick one to attach. Only types the viewer may open are offered. */
export function EntityPickerModal({ workspaceSlug, isOpen, onClose, selectedKeys = [], exclude = [], onPick }: Props) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [type, setType] = useState<TEntityName | "all">("all");
  const [busy, setBusy] = useState<string | null>(null);
  const debounced = useDebounce(query.trim(), 250);

  useEffect(() => {
    if (!isOpen) {
      setQuery("");
      setType("all");
    }
  }, [isOpen]);

  const { data, isLoading } = useSWR(
    isOpen ? ["ENTITY_PICKER", workspaceSlug, debounced, type] : null,
    () =>
      referencesService.search(workspaceSlug, debounced, {
        types: type === "all" ? undefined : [type],
        count: type === "all" ? 5 : 25,
      }),
    { keepPreviousData: true }
  );

  const types = useMemo(
    () => ENTITY_ORDER.filter((name) => (data?.types ?? []).includes(name) && !exclude.includes(name)),
    [data?.types, exclude]
  );
  const groups = useMemo(
    () =>
      types
        .filter((name) => type === "all" || name === type)
        .map((name) => ({ name, items: data?.results[name] ?? [] }))
        .filter((group) => group.items.length > 0),
    [data, type, types]
  );

  const pick = async (card: TEntityCard) => {
    const key = `${card.entity_name}:${card.id}`;
    if (selectedKeys.includes(key)) return;
    setBusy(key);
    try {
      await onPick(card);
    } finally {
      setBusy(null);
    }
  };

  return (
    <ModalCore isOpen={isOpen} handleClose={onClose} position={EModalPosition.TOP} width={EModalWidth.XXL}>
      <div className="flex max-h-[70vh] flex-col">
        <div className="flex items-center gap-2 border-b border-subtle px-4 py-3">
          <Search className="size-4 shrink-0 text-tertiary" />
          <input
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("references.picker.placeholder")}
            aria-label={t("references.picker.placeholder")}
            className="h-7 flex-1 bg-transparent text-14 outline-none placeholder:text-placeholder"
          />
          {isLoading && <Loader2 className="size-4 animate-spin text-tertiary" />}
        </div>
        <div className="flex gap-1 overflow-x-auto border-b border-subtle px-3 py-2" role="tablist">
          {(["all", ...types] as const).map((name) => (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={type === name}
              onClick={() => setType(name)}
              className={cn(
                "shrink-0 rounded-md px-2 py-1 text-12",
                type === name ? "bg-layer-1 font-medium text-primary" : "text-tertiary hover:text-primary"
              )}
            >
              {name === "all" ? t("references.picker.all") : t(entityGroupKey(name))}
            </button>
          ))}
        </div>
        <div className="min-h-40 flex-1 overflow-y-auto p-2">
          {groups.length === 0 && !isLoading ? (
            <p className="px-2 py-10 text-center text-13 text-tertiary">
              {t(debounced ? "references.picker.no_results" : "references.picker.start")}
            </p>
          ) : (
            groups.map((group) => {
              const Icon = ENTITY_ICONS[group.name];
              return (
                <section key={group.name} className="mb-2">
                  {type === "all" && (
                    <h3 className="px-2 pt-2 pb-1 text-11 font-medium text-tertiary">
                      {t(entityGroupKey(group.name))}
                    </h3>
                  )}
                  <ul>
                    {group.items.map((card) => {
                      const key = `${card.entity_name}:${card.id}`;
                      const chosen = selectedKeys.includes(key);
                      return (
                        <li key={key}>
                          <button
                            type="button"
                            disabled={chosen || busy !== null}
                            onClick={() => void pick(card)}
                            className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-layer-1-hover disabled:cursor-default disabled:hover:bg-transparent"
                          >
                            <span className="grid size-7 shrink-0 place-items-center rounded-md bg-layer-1">
                              <Icon className="size-3.5 text-secondary" />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-13 text-primary">{card.title || "—"}</span>
                              {card.subtitle && (
                                <span className="block truncate text-11 text-tertiary">{card.subtitle}</span>
                              )}
                            </span>
                            {busy === key ? (
                              <Loader2 className="size-3.5 animate-spin text-tertiary" />
                            ) : chosen ? (
                              <span className="flex items-center gap-1 text-11 text-secondary">
                                <Check className="size-3" />
                                {t("references.picker.attached")}
                              </span>
                            ) : null}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })
          )}
        </div>
      </div>
    </ModalCore>
  );
}
