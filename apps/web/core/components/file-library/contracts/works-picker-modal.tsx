/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * "Agregar obras": search songs and releases, tick several, choose the
 * rights type and link them to the contract in one request.
 */

import { useEffect, useMemo, useState } from "react";
import { Loader2, Search } from "lucide-react";
import useSWR from "swr";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import type { TContractWorkEntityType, TContractWorkRightsType, TEntityCard } from "@plane/types";
import { EModalPosition, EModalWidth, ModalCore } from "@plane/ui";
import { cn } from "@plane/utils";
import { ENTITY_ICONS, entityGroupKey } from "@/components/references/entity-meta";
import useDebounce from "@/hooks/use-debounce";
import { referencesService } from "@/services/references.service";
import { WorkRightsSelect } from "./works-shared";

const WORK_TYPES: TContractWorkEntityType[] = ["music_track", "music_release"];

type Props = {
  workspaceSlug: string;
  isOpen: boolean;
  onClose: () => void;
  /** "music_track:<id>" of works already linked */
  linkedKeys: string[];
  onConfirm: (
    items: { entity_type: TContractWorkEntityType; entity_id: string }[],
    rightsType: TContractWorkRightsType | null
  ) => Promise<void>;
};

const keyOf = (card: { entity_name: string; id: string }) => `${card.entity_name}:${card.id}`;

export function ContractWorksPickerModal({ workspaceSlug, isOpen, onClose, linkedKeys, onConfirm }: Props) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [type, setType] = useState<TContractWorkEntityType | "all">("all");
  const [picked, setPicked] = useState<Map<string, TEntityCard>>(new Map());
  const [rightsType, setRightsType] = useState<TContractWorkRightsType | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const debounced = useDebounce(query.trim(), 250);

  useEffect(() => {
    if (isOpen) return;
    setQuery("");
    setType("all");
    setPicked(new Map());
    setRightsType(null);
  }, [isOpen]);

  const { data, isLoading } = useSWR(
    isOpen ? ["CONTRACT_WORKS_PICKER", workspaceSlug, debounced, type] : null,
    () =>
      referencesService.search(workspaceSlug, debounced, {
        types: type === "all" ? WORK_TYPES : [type],
        count: type === "all" ? 10 : 25,
      }),
    { keepPreviousData: true }
  );

  const groups = useMemo(
    () =>
      WORK_TYPES.filter((name) => type === "all" || name === type)
        .map((name) => ({ name, items: data?.results[name] ?? [] }))
        .filter((group) => group.items.length > 0),
    [data, type]
  );

  const toggle = (card: TEntityCard) =>
    setPicked((current) => {
      const next = new Map(current);
      if (next.has(keyOf(card))) next.delete(keyOf(card));
      else next.set(keyOf(card), card);
      return next;
    });

  const confirm = async () => {
    if (picked.size === 0) return;
    setIsSaving(true);
    try {
      await onConfirm(
        [...picked.values()].map((card) => ({
          entity_type: card.entity_name as TContractWorkEntityType,
          entity_id: card.id,
        })),
        rightsType
      );
      onClose();
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <ModalCore
      isOpen={isOpen}
      handleClose={() => !isSaving && onClose()}
      position={EModalPosition.TOP}
      width={EModalWidth.XXL}
    >
      <div className="flex max-h-[70vh] flex-col">
        <div className="flex items-center gap-2 border-b border-subtle px-4 py-3">
          <Search className="size-4 shrink-0 text-tertiary" />
          <input
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("file_library.contracts.works.picker.placeholder")}
            aria-label={t("file_library.contracts.works.picker.placeholder")}
            className="h-7 flex-1 bg-transparent text-14 outline-none placeholder:text-placeholder"
          />
          {isLoading && <Loader2 className="size-4 animate-spin text-tertiary" />}
        </div>
        <div className="flex gap-1 overflow-x-auto border-b border-subtle px-3 py-2" role="tablist">
          {(["all", ...WORK_TYPES] as const).map((name) => (
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
                      const key = keyOf(card);
                      const linked = linkedKeys.includes(key);
                      const checked = linked || picked.has(key);
                      return (
                        <li key={key}>
                          <label
                            className={cn(
                              "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left",
                              linked ? "cursor-default" : "cursor-pointer hover:bg-layer-1-hover"
                            )}
                          >
                            <input
                              type="checkbox"
                              className="accent-accent-primary size-4 shrink-0"
                              checked={checked}
                              disabled={linked || isSaving}
                              onChange={() => toggle(card)}
                            />
                            <span className="grid size-7 shrink-0 place-items-center rounded-md bg-layer-1">
                              <Icon className="size-3.5 text-secondary" />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-13 text-primary">{card.title || "—"}</span>
                              {card.subtitle && (
                                <span className="block truncate text-11 text-tertiary">{card.subtitle}</span>
                              )}
                            </span>
                            {linked && (
                              <span className="shrink-0 text-11 text-secondary">
                                {t("file_library.contracts.works.picker.linked")}
                              </span>
                            )}
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-subtle px-4 py-3">
          <span className="text-12 text-tertiary">{t("file_library.contracts.works.rights.label")}</span>
          <WorkRightsSelect value={rightsType} onChange={setRightsType} disabled={isSaving} className="h-7 text-12" />
          <span className="ml-auto flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={onClose} disabled={isSaving}>
              {t("cancel")}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => void confirm()}
              loading={isSaving}
              disabled={picked.size === 0}
            >
              {t("file_library.contracts.works.picker.confirm", { count: picked.size })}
            </Button>
          </span>
        </div>
      </div>
    </ModalCore>
  );
}
