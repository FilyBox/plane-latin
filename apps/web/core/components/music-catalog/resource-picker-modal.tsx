/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * Workspace-catalog picker (artists, companies, genres, releases) aligned to
 * the design system of the other music panels: quiet header, searchable list,
 * INLINE row editing (no separate form section) and inline creation.
 */

import { useEffect, useMemo, useState } from "react";
import { Check, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TMusicCatalogOptions, TMusicCompany, TMusicGenre, TMusicParty, TMusicRelease } from "@plane/types";
import { AlertModalCore } from "@plane/ui";
import { musicService } from "@/services/music.service";
import { BudgetPeekPanel } from "../payments/budget-peek-panel";
import { getApiError } from "./shared";

/** Field style WITHOUT w-full: widths are set per usage so fixed-width selects
 * and flexible inputs coexist in the same row (w-full would override them). */
const FIELD =
  "h-8 rounded-md border border-subtle bg-layer-1 px-2.5 text-12 text-primary outline-none transition-colors focus:border-accent-primary";

export type MusicResource = TMusicParty | TMusicCompany | TMusicGenre | TMusicRelease;
export type MusicResourceType = "party" | "company" | "genre" | "release";

type Props = {
  workspaceSlug: string;
  isOpen: boolean;
  resourceType: MusicResourceType;
  title: string;
  items: MusicResource[];
  selectedIds: string[];
  options?: TMusicCatalogOptions;
  multiple?: boolean;
  defaultKind?: string;
  onClose: () => void;
  onSelect: (ids: string[]) => void;
  onChanged: () => void;
};

export const musicResourceName = (item: MusicResource) =>
  "display_name" in item ? item.display_name : "title" in item ? item.title : item.name;

const resourceKind = (item: MusicResource): string =>
  "kind" in item ? item.kind : "release_type" in item ? item.release_type : "";

export function MusicResourcePickerModal({
  workspaceSlug,
  isOpen,
  resourceType,
  title,
  items,
  selectedIds,
  options,
  multiple = true,
  defaultKind,
  onClose,
  onSelect,
  onChanged,
}: Props) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const [selection, setSelection] = useState<string[]>([]);
  // Inline row editing: id of the row being edited + its draft values
  const [editingId, setEditingId] = useState<string>();
  const [draftName, setDraftName] = useState("");
  const [draftKind, setDraftKind] = useState("");
  // Inline creation (toolbar row)
  const [createName, setCreateName] = useState("");
  const [createKind, setCreateKind] = useState(defaultKind ?? "");
  const [deleting, setDeleting] = useState<MusicResource>();
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const initialSelectionKey = selectedIds.join("|");

  useEffect(() => {
    if (!isOpen) return;
    setSearch("");
    setSelection(initialSelectionKey ? initialSelectionKey.split("|") : []);
    setEditingId(undefined);
    setCreateName("");
    setCreateKind(defaultKind ?? "");
  }, [defaultKind, initialSelectionKey, isOpen]);

  const visible = useMemo(
    () => items.filter((item) => musicResourceName(item).toLowerCase().includes(search.trim().toLowerCase())),
    [items, search]
  );
  const choices =
    resourceType === "party"
      ? options?.party_kinds
      : resourceType === "company"
        ? options?.company_kinds
        : resourceType === "release"
          ? options?.release_types
          : undefined;

  const persist = async (nameValue: string, kindValue: string, id?: string): Promise<MusicResource> => {
    if (resourceType === "party")
      return musicService.saveParty(workspaceSlug, {
        id,
        display_name: nameValue,
        kind: (kindValue || "ARTIST") as TMusicParty["kind"],
      });
    if (resourceType === "company")
      return musicService.saveCompany(workspaceSlug, {
        id,
        name: nameValue,
        kind: (kindValue || "OTHER") as TMusicCompany["kind"],
      });
    if (resourceType === "release")
      return musicService.saveRelease(workspaceSlug, {
        id,
        title: nameValue,
        release_type: kindValue || "SINGLE",
        ...(id ? {} : { status: "DRAFT" }),
      });
    return musicService.saveGenre(workspaceSlug, { id, name: nameValue });
  };

  const createResource = async () => {
    if (!createName.trim()) return;
    setIsSaving(true);
    try {
      const saved = await persist(createName.trim(), createKind);
      setSelection((current) => (multiple ? [...new Set([...current, saved.id])] : [saved.id]));
      setCreateName("");
      setToast({ type: TOAST_TYPE.SUCCESS, title: t("music_resources.resource_created_selected") });
      onChanged();
    } catch (error) {
      setToast({ type: TOAST_TYPE.ERROR, title: t("music_resources.save_failed"), message: getApiError(error) });
    } finally {
      setIsSaving(false);
    }
  };

  const beginEdit = (item: MusicResource) => {
    setEditingId(item.id);
    setDraftName(musicResourceName(item));
    setDraftKind(resourceKind(item));
  };

  const saveEdit = async () => {
    if (!editingId || !draftName.trim()) return;
    setIsSaving(true);
    try {
      await persist(draftName.trim(), draftKind, editingId);
      setEditingId(undefined);
      setToast({ type: TOAST_TYPE.SUCCESS, title: t("music_resources.resource_updated") });
      onChanged();
    } catch (error) {
      setToast({ type: TOAST_TYPE.ERROR, title: t("music_resources.save_failed"), message: getApiError(error) });
    } finally {
      setIsSaving(false);
    }
  };

  const deleteResource = async () => {
    if (!deleting) return;
    setIsDeleting(true);
    try {
      if (resourceType === "party") await musicService.deleteParty(workspaceSlug, deleting.id);
      else if (resourceType === "company") await musicService.deleteCompany(workspaceSlug, deleting.id);
      else if (resourceType === "release") await musicService.deleteRelease(workspaceSlug, deleting.id);
      else await musicService.deleteGenre(workspaceSlug, deleting.id);
      setSelection((current) => current.filter((id) => id !== deleting.id));
      setDeleting(undefined);
      onChanged();
    } catch (error) {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: t("music_resources.cannot_delete"),
        message: getApiError(error, t("music_resources.still_referenced")),
      });
    } finally {
      setIsDeleting(false);
    }
  };

  const toggle = (id: string) =>
    setSelection((current) =>
      multiple ? (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]) : [id]
    );

  if (!isOpen) return null;

  return (
    <>
      <BudgetPeekPanel title={title} description={t("music_resources.catalog_help")} onClose={() => !deleting && onClose()}>
        <div className="flex h-full min-h-0 flex-col bg-surface-1">
          {/* search + inline create, one quiet toolbar */}
          <div className="shrink-0 space-y-2 border-b border-subtle px-4 py-3">
            <div className="relative">
              <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-tertiary" />
              <input
                className={`${FIELD} w-full pl-8`}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t("music_resources.search")}
              />
            </div>
            <div className="flex items-center gap-2">
              <input
                className={`${FIELD} min-w-0 flex-1`}
                value={createName}
                onChange={(event) => setCreateName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && createName.trim()) void createResource();
                }}
                placeholder={t("music_resources.create_new")}
              />
              {choices && (
                <select
                  className={`${FIELD} w-36 shrink-0`}
                  value={createKind || choices[0]?.[0]}
                  onChange={(event) => setCreateKind(event.target.value)}
                >
                  {choices.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              )}
              <Button
                variant="secondary"
                size="sm"
                loading={isSaving && !editingId}
                disabled={!createName.trim()}
                onClick={() => void createResource()}
              >
                <Plus className="size-3.5" /> {t("music_resources.create_select")}
              </Button>
            </div>
          </div>

          <div className="vertical-scrollbar min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 py-2">
            {visible.map((item) => {
              const selected = selection.includes(item.id);
              const itemName = musicResourceName(item);
              const kind = resourceKind(item);
              if (editingId === item.id) {
                // Inline edit: the row itself becomes the editor
                return (
                  <div key={item.id} className="flex items-center gap-2 rounded-md border border-accent-strong bg-layer-1 px-2 py-1.5">
                    <input
                      className={`${FIELD} min-w-0 flex-1`}
                      value={draftName}
                      autoFocus
                      onChange={(event) => setDraftName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void saveEdit();
                        if (event.key === "Escape") setEditingId(undefined);
                      }}
                    />
                    {choices && (
                      <select
                        className={`${FIELD} w-36 shrink-0`}
                        value={draftKind || choices[0]?.[0]}
                        onChange={(event) => setDraftKind(event.target.value)}
                      >
                        {choices.map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    )}
                    <button
                      type="button"
                      className="rounded-sm p-1.5 text-success-primary hover:bg-layer-1-hover disabled:opacity-50"
                      disabled={isSaving || !draftName.trim()}
                      onClick={() => void saveEdit()}
                      aria-label={t("music_resources.save")}
                    >
                      <Check className="size-4" />
                    </button>
                    <button
                      type="button"
                      className="rounded-sm p-1.5 text-tertiary hover:bg-layer-1-hover"
                      onClick={() => setEditingId(undefined)}
                      aria-label={t("music_resources.cancel")}
                    >
                      <X className="size-4" />
                    </button>
                  </div>
                );
              }
              return (
                <div
                  key={item.id}
                  className={`group flex items-center gap-2 rounded-md px-2 py-1.5 ${selected ? "bg-layer-1-selected" : "hover:bg-layer-1-hover"}`}
                >
                  <button type="button" className="flex min-w-0 flex-1 items-center gap-2.5 text-left" onClick={() => toggle(item.id)}>
                    {/* radio look when only ONE can be chosen, checkbox when several */}
                    <input
                      type={multiple ? "checkbox" : "radio"}
                      readOnly
                      checked={selected}
                      className="pointer-events-none shrink-0"
                    />
                    <span className="min-w-0 flex-1 truncate text-13">{itemName}</span>
                    {kind && (
                      <span className="shrink-0 rounded-full border border-subtle bg-layer-2 px-2 py-0.5 text-10 text-tertiary">
                        {kind.replaceAll("_", " ")}
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    className="rounded-sm p-1.5 text-tertiary opacity-0 group-hover:opacity-100 hover:bg-layer-2 hover:text-primary"
                    onClick={() => beginEdit(item)}
                    aria-label={t("music_resources.edit_item", { name: itemName })}
                  >
                    <Pencil className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    className="rounded-sm p-1.5 text-tertiary opacity-0 group-hover:opacity-100 hover:bg-danger-subtle hover:text-danger-primary"
                    onClick={() => setDeleting(item)}
                    aria-label={t("music_resources.delete_item", { name: itemName })}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              );
            })}
            {!visible.length && (
              <p className="py-10 text-center text-12 text-tertiary">{t("music_resources.no_matching")}</p>
            )}
          </div>

          <div className="flex shrink-0 items-center justify-between border-t border-subtle px-4 py-3">
            <span className="text-11 text-secondary">{t("music_resources.selected", { count: selection.length })}</span>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={onClose}>
                {t("music_resources.cancel")}
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  onSelect(selection);
                  onClose();
                }}
              >
                {t("music_resources.apply_selection")}
              </Button>
            </div>
          </div>
        </div>
      </BudgetPeekPanel>
      <AlertModalCore
        isOpen={Boolean(deleting)}
        isSubmitting={isDeleting}
        handleClose={() => setDeleting(undefined)}
        handleSubmit={() => void deleteResource()}
        title={t("music_resources.delete_title", { name: deleting ? musicResourceName(deleting) : "" })}
        content={t("music_resources.delete_picker_content")}
      />
    </>
  );
}
