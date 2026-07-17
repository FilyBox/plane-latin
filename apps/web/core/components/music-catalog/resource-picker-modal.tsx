import { useEffect, useMemo, useState } from "react";
import { Check, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { Button } from "@plane/propel/button";
import { useTranslation } from "@plane/i18n";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TMusicCatalogOptions, TMusicCompany, TMusicGenre, TMusicParty, TMusicRelease } from "@plane/types";
import { AlertModalCore } from "@plane/ui";
import { musicService } from "@/services/music.service";
import { BudgetPeekPanel } from "../payments/budget-peek-panel";
import { getApiError, MUSIC_FIELD, MUSIC_LABEL } from "./shared";

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
  const [editing, setEditing] = useState<MusicResource>();
  const [deleting, setDeleting] = useState<{ item: MusicResource; resourceType: MusicResourceType }>();
  const [name, setName] = useState("");
  const [kind, setKind] = useState(defaultKind ?? "");
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const initialSelectionKey = selectedIds.join("|");

  useEffect(() => {
    if (!isOpen) return;
    setSearch("");
    setSelection(initialSelectionKey ? initialSelectionKey.split("|") : []);
    setEditing(undefined);
    setName("");
    setKind(defaultKind ?? "");
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

  const resetEditor = () => {
    setEditing(undefined);
    setName("");
    setKind(defaultKind ?? choices?.[0]?.[0] ?? "");
  };

  const beginEdit = (item: MusicResource) => {
    setEditing(item);
    setName(musicResourceName(item));
    setKind("kind" in item ? item.kind : "release_type" in item ? item.release_type : "");
  };

  const saveResource = async () => {
    if (!name.trim()) return;
    setIsSaving(true);
    try {
      let saved: MusicResource;
      if (resourceType === "party")
        saved = await musicService.saveParty(workspaceSlug, {
          id: editing?.id,
          display_name: name.trim(),
          kind: (kind || "ARTIST") as TMusicParty["kind"],
        });
      else if (resourceType === "company")
        saved = await musicService.saveCompany(workspaceSlug, {
          id: editing?.id,
          name: name.trim(),
          kind: (kind || "OTHER") as TMusicCompany["kind"],
        });
      else if (resourceType === "release")
        saved = await musicService.saveRelease(workspaceSlug, {
          id: editing?.id,
          title: name.trim(),
          release_type: kind || "SINGLE",
          status: "DRAFT",
        });
      else saved = await musicService.saveGenre(workspaceSlug, { id: editing?.id, name: name.trim() });

      if (!editing) setSelection((current) => (multiple ? [...new Set([...current, saved.id])] : [saved.id]));
      setToast({
        type: TOAST_TYPE.SUCCESS,
        title: editing ? t("music_resources.resource_updated") : t("music_resources.resource_created_selected"),
      });
      resetEditor();
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
      if (deleting.resourceType === "party") await musicService.deleteParty(workspaceSlug, deleting.item.id);
      else if (deleting.resourceType === "company") await musicService.deleteCompany(workspaceSlug, deleting.item.id);
      else if (deleting.resourceType === "release") await musicService.deleteRelease(workspaceSlug, deleting.item.id);
      else await musicService.deleteGenre(workspaceSlug, deleting.item.id);
      setSelection((current) => current.filter((id) => id !== deleting.item.id));
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
      <BudgetPeekPanel
        title={title}
        description={t("music_resources.catalog_help")}
        onClose={() => !deleting && onClose()}
      >
        <div className="flex h-full min-h-0 flex-col bg-surface-1">
          <div className="shrink-0 bg-gradient-to-br from-[#173a31] via-[#102c26] to-[#111827] px-5 py-4 text-white">
            <p className="text-13 font-semibold">{t("music_resources.workspace_catalog")}</p>
            <p className="mt-1 text-11 text-white/65">{t("music_resources.catalog_help")}</p>
          </div>

          <div className="vertical-scrollbar min-h-0 flex-1 overflow-y-auto">
            <section className="flex min-h-0 flex-col border-b border-subtle px-5 py-5">
              <div className="relative mb-3">
                <Search className="absolute top-2.5 left-3 size-4 text-tertiary" />
                <input
                  className={`${MUSIC_FIELD} pl-9`}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={t("music_resources.search")}
                />
              </div>
              <div className="vertical-scrollbar min-h-48 flex-1 space-y-1 overflow-y-auto">
                {visible.map((item) => {
                  const selected = selection.includes(item.id);
                  const itemName = musicResourceName(item);
                  return (
                    <div
                      key={item.id}
                      className={`group flex items-center gap-2 rounded-md border px-3 py-2 ${selected ? "border-accent-primary bg-accent-primary/5" : "border-transparent hover:bg-layer-2"}`}
                    >
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center gap-3 text-left"
                        onClick={() => toggle(item.id)}
                      >
                        <span
                          className={`flex size-5 shrink-0 items-center justify-center rounded border ${selected ? "border-accent-primary bg-accent-primary text-on-color" : "border-strong"}`}
                        >
                          {selected && <Check className="size-3.5" />}
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-12 font-medium">{itemName}</span>
                          {("kind" in item || "release_type" in item) && (
                            <span className="block text-10 text-tertiary">
                              {("kind" in item ? item.kind : item.release_type).replaceAll("_", " ")}
                            </span>
                          )}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="rounded p-1.5 text-secondary hover:bg-layer-1"
                        onClick={() => beginEdit(item)}
                        aria-label={t("music_resources.edit_item", { name: itemName })}
                      >
                        <Pencil className="size-3.5" />
                      </button>
                      <button
                        type="button"
                        className="rounded p-1.5 text-secondary hover:bg-danger-subtle hover:text-danger-primary"
                        onClick={() => setDeleting({ item, resourceType })}
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
            </section>

            <section className="border-b border-subtle bg-layer-1 px-5 py-5">
              <h4 className="flex items-center gap-2 text-12 font-semibold">
                <Plus className="size-4" />{" "}
                {editing ? t("music_resources.edit_resource") : t("music_resources.create_new")}
              </h4>
              <label htmlFor="music-resource-name" className={`${MUSIC_LABEL} mt-4`}>
                {t("music_resources.name")}
              </label>
              <input
                id="music-resource-name"
                className={MUSIC_FIELD}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
              {choices && (
                <>
                  <label htmlFor="music-resource-kind" className={`${MUSIC_LABEL} mt-4`}>
                    {t("music_resources.type")}
                  </label>
                  <select
                    id="music-resource-kind"
                    className={MUSIC_FIELD}
                    value={kind || choices[0]?.[0]}
                    onChange={(event) => setKind(event.target.value)}
                  >
                    {choices.map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </>
              )}
              <div className="mt-4 flex gap-2">
                <Button
                  variant="primary"
                  size="sm"
                  loading={isSaving}
                  disabled={!name.trim()}
                  onClick={() => void saveResource()}
                >
                  {editing ? t("music_resources.save") : t("music_resources.create_select")}
                </Button>
                {editing && (
                  <Button variant="secondary" size="sm" onClick={resetEditor}>
                    {t("music_resources.cancel")}
                  </Button>
                )}
              </div>
            </section>
          </div>

          <div className="flex items-center justify-between border-t border-subtle bg-layer-1 px-4 py-3">
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
        title={t("music_resources.delete_title", {
          name: deleting ? musicResourceName(deleting.item) : "",
        })}
        content={t("music_resources.delete_picker_content")}
      />
    </>
  );
}
