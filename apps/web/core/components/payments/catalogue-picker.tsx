/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, MoreHorizontal, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import useSWR from "swr";
import { useTranslation } from "@plane/i18n";
import { Menu } from "@plane/propel/menu";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import { AlertModalCore } from "@plane/ui";
import { cn } from "@plane/utils";
import { financeService } from "@/services/finance.service";
import { payrollService } from "@/services/payroll.service";

export type CatalogueItem = { id: string; name: string };

export type CatalogueSource = {
  items: CatalogueItem[];
  busy: boolean;
  create: (name: string) => Promise<CatalogueItem | null>;
  rename: (item: CatalogueItem, name: string) => Promise<boolean>;
  remove: (item: CatalogueItem) => Promise<boolean>;
  /** Copy for the confirmation the delete goes through. */
  deleteTitleKey: string;
  deleteBodyKey: string;
  emptyKey: string;
};

function useCatalogue(
  key: string,
  fetcher: () => Promise<CatalogueItem[]>,
  writes: {
    create: (name: string) => Promise<CatalogueItem>;
    rename: (item: CatalogueItem, name: string) => Promise<unknown>;
    remove: (item: CatalogueItem) => Promise<unknown>;
  },
  copy: { deleteTitleKey: string; deleteBodyKey: string; emptyKey: string }
): CatalogueSource {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const { data: items = [], mutate } = useSWR(key, fetcher);

  const run = async <T,>(operation: () => Promise<T>): Promise<T | null> => {
    if (busy) return null;
    setBusy(true);
    try {
      const result = await operation();
      await mutate();
      return result;
    } catch {
      setToast({ type: TOAST_TYPE.ERROR, title: t("payments.toasts.error") });
      return null;
    } finally {
      setBusy(false);
    }
  };

  return {
    items,
    busy,
    create: (name) => run(() => writes.create(name)),
    rename: async (item, name) => (await run(() => writes.rename(item, name))) !== null,
    remove: async (item) => (await run(() => writes.remove(item))) !== null,
    ...copy,
  };
}

/** The expense categories, shared by budget rows and the ledger. */
export function useCategorySource(workspaceSlug: string): CatalogueSource {
  return useCatalogue(
    `PAYMENT_CATEGORIES_${workspaceSlug}`,
    () => financeService.getCategories(workspaceSlug),
    {
      create: (name) => financeService.createCategory(workspaceSlug, { name }),
      rename: (item, name) => financeService.updateCategory(workspaceSlug, item.id, { name }),
      remove: (item) => financeService.deleteCategory(workspaceSlug, item.id),
    },
    {
      deleteTitleKey: "payments.delete_category_title",
      deleteBodyKey: "payments.delete_category_description",
      emptyKey: "payments.empty.categories",
    }
  );
}

/** The offices a salary or a concept is charged to. */
export function useOfficeSource(workspaceSlug: string): CatalogueSource {
  return useCatalogue(
    `PAYROLL_OFFICES_${workspaceSlug}`,
    () => payrollService.getOffices(workspaceSlug),
    {
      create: (name) => payrollService.createOffice(workspaceSlug, { name }),
      rename: (item, name) => payrollService.updateOffice(workspaceSlug, item.id, { name }),
      remove: (item) => payrollService.deleteOffice(workspaceSlug, item.id),
    },
    {
      deleteTitleKey: "payroll.offices.delete_title",
      deleteBodyKey: "payroll.offices.delete_description",
      emptyKey: "payroll.offices.empty",
    }
  );
}

type Props = {
  source: CatalogueSource;
  /** Ids currently on the record. */
  selected: string[];
  /** Offers "no category" once something is set. */
  allowClear?: boolean;
  onPick: (item: CatalogueItem) => void;
  onClear?: () => void;
  onRenamed?: (item: CatalogueItem, name: string) => void;
  onRemoved?: (item: CatalogueItem) => void;
  onClose: () => void;
  className?: string;
};

/**
 * The work item label menu, over any catalogue: type to narrow, arrows to move,
 * Enter to take the highlighted one — and if nothing matches what you typed,
 * Enter creates it and assigns it in the same keystroke. Each entry carries its
 * own edit and delete behind an ellipsis, so the list is managed where it is
 * used rather than on a settings screen.
 */
export function CataloguePanel(props: Props) {
  const { source, selected, allowClear, onPick, onClear, onRenamed, onRemoved, onClose, className } = props;
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [renaming, setRenaming] = useState<CatalogueItem | null>(null);
  const [deleting, setDeleting] = useState<CatalogueItem | null>(null);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const normalized = query.trim().toLocaleLowerCase();
  const matches = useMemo(
    () =>
      normalized ? source.items.filter((item) => item.name.toLocaleLowerCase().includes(normalized)) : source.items,
    [source.items, normalized]
  );
  const exact = source.items.find((item) => item.name.toLocaleLowerCase() === normalized);
  const canCreate = Boolean(normalized) && !exact;
  const canClear = Boolean(allowClear && onClear && selected.length > 0 && !normalized);

  /** What Enter and the arrows walk over: clear, then matches, then create. */
  const rows: ({ kind: "clear" } | { kind: "item"; item: CatalogueItem } | { kind: "create" })[] = [
    ...(canClear ? [{ kind: "clear" as const }] : []),
    ...matches.map((item) => ({ kind: "item" as const, item })),
    ...(canCreate ? [{ kind: "create" as const }] : []),
  ];

  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => setHighlight(0), [normalized]);
  useEffect(() => {
    listRef.current?.querySelector('[data-highlighted="true"]')?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  const activate = async (row: (typeof rows)[number] | undefined) => {
    if (!row) return;
    if (row.kind === "clear") {
      onClear?.();
      return;
    }
    if (row.kind === "item") {
      onPick(row.item);
      setQuery("");
      return;
    }
    const created = await source.create(query.trim());
    if (created) {
      onPick(created);
      setQuery("");
    }
  };

  const applyRename = async (item: CatalogueItem) => {
    const name = draft.trim();
    if (!name || name === item.name) {
      setRenaming(null);
      return;
    }
    if (await source.rename(item, name)) {
      onRenamed?.(item, name);
      setRenaming(null);
    }
  };

  return (
    <div className={cn("w-64 rounded-md border border-subtle bg-layer-1 p-1.5 shadow-raised-200", className)}>
      <div className="relative mb-1">
        <Search className="absolute top-1/2 left-2 size-3 -translate-y-1/2 text-tertiary" />
        <input
          ref={inputRef}
          value={query}
          maxLength={50}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              if (renaming) setRenaming(null);
              else onClose();
              return;
            }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              if (rows.length === 0) return;
              const step = event.key === "ArrowDown" ? 1 : -1;
              setHighlight((current) => (current + step + rows.length) % rows.length);
              return;
            }
            if (event.key !== "Enter") return;
            event.preventDefault();
            event.stopPropagation();
            void activate(rows[highlight]);
          }}
          placeholder={t("payments.fields.category")}
          className="w-full rounded-sm border border-subtle bg-transparent py-1 pr-2 pl-6 text-12 outline-none focus:border-accent-strong"
        />
      </div>

      <div ref={listRef} className="max-h-52 space-y-0.5 overflow-y-auto">
        {rows.map((row, index) => {
          const highlighted = index === highlight;
          if (row.kind === "clear")
            return (
              <button
                key="clear"
                type="button"
                data-highlighted={highlighted}
                onMouseEnter={() => setHighlight(index)}
                onClick={() => onClear?.()}
                className={cn(
                  "flex w-full items-center gap-2 rounded-sm px-1.5 py-1 text-left text-12 text-tertiary",
                  highlighted && "bg-layer-1-hover"
                )}
              >
                <X className="size-3" />
                {t("payments.ledger.uncategorized")}
              </button>
            );

          if (row.kind === "create")
            return (
              <button
                key="create"
                type="button"
                data-highlighted={highlighted}
                disabled={source.busy}
                onMouseEnter={() => setHighlight(index)}
                onClick={() => void activate(row)}
                className={cn(
                  "flex w-full items-center gap-1.5 rounded-sm px-1.5 py-1 text-left text-12 text-accent-primary",
                  highlighted && "bg-layer-1-hover"
                )}
              >
                <Plus className="size-3" />
                {t("payments.ledger.create_tag")} «{query.trim()}»
              </button>
            );

          const item = row.item;
          if (renaming?.id === item.id)
            return (
              <input
                key={item.id}
                // eslint-disable-next-line jsx-a11y/no-autofocus
                autoFocus
                value={draft}
                maxLength={50}
                onChange={(event) => setDraft(event.target.value)}
                onBlur={() => void applyRename(item)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void applyRename(item);
                  }
                  if (event.key === "Escape") {
                    event.stopPropagation();
                    setRenaming(null);
                  }
                }}
                className="w-full rounded-sm border border-accent-strong bg-transparent px-1.5 py-1 text-12 outline-none"
              />
            );

          return (
            <div
              key={item.id}
              data-highlighted={highlighted}
              onMouseEnter={() => setHighlight(index)}
              className={cn("group flex items-center gap-1 rounded-sm", highlighted && "bg-layer-1-hover")}
            >
              <button
                type="button"
                onClick={() => onPick(item)}
                className="flex min-w-0 flex-1 items-center justify-between gap-2 px-1.5 py-1 text-left text-12"
              >
                <span className="truncate">{item.name}</span>
                {selected.includes(item.id) && <Check className="size-3 shrink-0 text-accent-primary" />}
              </button>
              <span className="shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                <Menu
                  customButton={
                    <span className="flex size-6 items-center justify-center rounded-sm text-tertiary hover:bg-layer-2 hover:text-primary">
                      <MoreHorizontal className="size-3.5" />
                    </span>
                  }
                  optionsClassName="w-40"
                  ariaLabel={`${t("payments.ledger.more_actions")} ${item.name}`}
                >
                  <Menu.MenuItem
                    disabled={source.busy}
                    onClick={() => {
                      setDraft(item.name);
                      setRenaming(item);
                    }}
                  >
                    <span className="flex items-center gap-2 text-12">
                      <Pencil className="size-3.5" />
                      {t("payments.actions.edit")}
                    </span>
                  </Menu.MenuItem>
                  <Menu.MenuItem disabled={source.busy} onClick={() => setDeleting(item)}>
                    <span className="flex items-center gap-2 text-12 text-danger-primary">
                      <Trash2 className="size-3.5" />
                      {t("payments.actions.delete")}
                    </span>
                  </Menu.MenuItem>
                </Menu>
              </span>
            </div>
          );
        })}

        {rows.length === 0 && <p className="px-1.5 py-1 text-11 text-tertiary">{t(source.emptyKey)}</p>}
      </div>

      <AlertModalCore
        isOpen={deleting !== null}
        handleClose={() => !source.busy && setDeleting(null)}
        isSubmitting={source.busy}
        title={t(source.deleteTitleKey)}
        content={t(source.deleteBodyKey)}
        handleSubmit={() => {
          if (!deleting) return;
          void source.remove(deleting).then((done) => {
            if (done) {
              onRemoved?.(deleting);
              setDeleting(null);
            }
            return done;
          });
        }}
      />
    </div>
  );
}

/** Closes a picker when the pointer lands outside it. The options menu and the
 * delete dialog live in portals, so clicks on those do not count as outside. */
export function useCatalogueOutsideClose(isOpen: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!isOpen) return;
    const handler = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest("[data-main-menu]") || target.closest('[role="dialog"]')) return;
      if (ref.current && !ref.current.contains(target)) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [isOpen, onClose]);
  return ref;
}
