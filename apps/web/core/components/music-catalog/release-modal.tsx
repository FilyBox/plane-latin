import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@plane/propel/button";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TMusicCatalogOptions, TMusicParty, TMusicRelease } from "@plane/types";
import { musicService } from "@/services/music.service";
import { BudgetPeekPanel } from "../payments/budget-peek-panel";
import { MusicResourcePickerModal } from "./resource-picker-modal";
import { getApiError, MUSIC_FIELD, MUSIC_LABEL } from "./shared";

type Props = {
  workspaceSlug: string;
  isOpen: boolean;
  release?: TMusicRelease;
  parties: TMusicParty[];
  options?: TMusicCatalogOptions;
  onClose: () => void;
  onSaved: () => void;
  onResourcesChanged: () => void;
};

const EMPTY = {
  title: "",
  version: "",
  release_type: "SINGLE",
  status: "DRAFT",
  upc: "",
  catalog_number: "",
  release_date: "",
  original_release_date: "",
  label_name: "",
  p_line: "",
  c_line: "",
  language: "",
  cover_url: "",
  notes: "",
  artist_ids: [] as string[],
};

export function MusicReleaseModal({
  workspaceSlug,
  isOpen,
  release,
  parties,
  options,
  onClose,
  onSaved,
  onResourcesChanged,
}: Props) {
  const [form, setForm] = useState(EMPTY);
  const [isSaving, setIsSaving] = useState(false);
  const [artistPickerOpen, setArtistPickerOpen] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setArtistPickerOpen(false);
    setForm(
      release
        ? {
            title: release.title,
            version: release.version,
            release_type: release.release_type,
            status: release.status,
            upc: release.upc,
            catalog_number: release.catalog_number,
            release_date: release.release_date ?? "",
            original_release_date: release.original_release_date ?? "",
            label_name: release.label_name,
            p_line: release.p_line,
            c_line: release.c_line,
            language: release.language,
            cover_url: release.cover_url,
            notes: release.notes,
            artist_ids: release.artist_details.map((item) => item.id),
          }
        : EMPTY
    );
  }, [isOpen, release]);

  const set = (field: keyof typeof EMPTY, value: string | string[]) =>
    setForm((current) => ({ ...current, [field]: value }));

  const save = async () => {
    if (!form.title.trim()) return;
    setIsSaving(true);
    try {
      await musicService.saveRelease(workspaceSlug, {
        ...form,
        id: release?.id,
        release_date: form.release_date || null,
        original_release_date: form.original_release_date || null,
      });
      setToast({ type: TOAST_TYPE.SUCCESS, title: release ? "Release updated" : "Release created" });
      onSaved();
      onClose();
    } catch (error) {
      setToast({ type: TOAST_TYPE.ERROR, title: "Could not save release", message: getApiError(error) });
    } finally {
      setIsSaving(false);
    }
  };

  if (!isOpen) return null;
  return (
    <BudgetPeekPanel
      title={release ? "Edit release" : "New release"}
      description="Group songs under a date, classification and commercial identifier."
      onClose={onClose}
    >
      <div className="vertical-scrollbar h-full overflow-y-auto bg-surface-1 p-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className={MUSIC_LABEL}>Title</label>
            <input
              className={MUSIC_FIELD}
              value={form.title}
              onChange={(e) => set("title", e.target.value)}
              autoFocus
            />
          </div>
          <div>
            <label className={MUSIC_LABEL}>Release type</label>
            <select
              className={MUSIC_FIELD}
              value={form.release_type}
              onChange={(e) => set("release_type", e.target.value)}
            >
              {options?.release_types.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={MUSIC_LABEL}>Status</label>
            <select className={MUSIC_FIELD} value={form.status} onChange={(e) => set("status", e.target.value)}>
              {options?.release_statuses.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={MUSIC_LABEL}>Release date (optional)</label>
            <input
              type="date"
              className={MUSIC_FIELD}
              value={form.release_date}
              onChange={(e) => set("release_date", e.target.value)}
            />
          </div>
          <div>
            <label className={MUSIC_LABEL}>Original release date (optional)</label>
            <input
              type="date"
              className={MUSIC_FIELD}
              value={form.original_release_date}
              onChange={(e) => set("original_release_date", e.target.value)}
            />
          </div>
          <div>
            <label className={MUSIC_LABEL}>UPC (optional)</label>
            <input className={MUSIC_FIELD} value={form.upc} onChange={(e) => set("upc", e.target.value)} />
          </div>
          <div>
            <label className={MUSIC_LABEL}>Catalog number (optional)</label>
            <input
              className={MUSIC_FIELD}
              value={form.catalog_number}
              onChange={(e) => set("catalog_number", e.target.value)}
            />
          </div>
          <div>
            <label className={MUSIC_LABEL}>Version (optional)</label>
            <input
              className={MUSIC_FIELD}
              value={form.version}
              onChange={(e) => set("version", e.target.value)}
              placeholder="Deluxe, remastered..."
            />
          </div>
          <div>
            <label className={MUSIC_LABEL}>Label (optional)</label>
            <input
              className={MUSIC_FIELD}
              value={form.label_name}
              onChange={(e) => set("label_name", e.target.value)}
            />
          </div>
          <div className="sm:col-span-2">
            <div className="flex items-center justify-between gap-3">
              <label className={MUSIC_LABEL}>Artists (optional)</label>
              <Button variant="secondary" size="sm" onClick={() => setArtistPickerOpen(true)}>
                <Plus className="mr-1 size-3.5" /> Select artists
              </Button>
            </div>
            <div className="flex min-h-12 flex-wrap gap-2 rounded-md border border-subtle p-3">
              {form.artist_ids.map((id) => (
                <span key={id} className="rounded-full border border-subtle bg-layer-2 px-3 py-1.5 text-11">
                  {parties.find((party) => party.id === id)?.display_name ?? "Unknown artist"}
                </span>
              ))}
              {!form.artist_ids.length && <span className="text-12 text-tertiary">No artists selected.</span>}
            </div>
          </div>
          <div>
            <label className={MUSIC_LABEL}>P line (optional)</label>
            <input className={MUSIC_FIELD} value={form.p_line} onChange={(e) => set("p_line", e.target.value)} />
          </div>
          <div>
            <label className={MUSIC_LABEL}>C line (optional)</label>
            <input className={MUSIC_FIELD} value={form.c_line} onChange={(e) => set("c_line", e.target.value)} />
          </div>
          <div className="sm:col-span-2">
            <label className={MUSIC_LABEL}>Cover URL (optional)</label>
            <input
              type="url"
              className={MUSIC_FIELD}
              value={form.cover_url}
              onChange={(e) => set("cover_url", e.target.value)}
            />
          </div>
          <div className="sm:col-span-2">
            <label className={MUSIC_LABEL}>Notes (optional)</label>
            <textarea
              className={`${MUSIC_FIELD} min-h-20`}
              value={form.notes}
              onChange={(e) => set("notes", e.target.value)}
            />
          </div>
        </div>
        <div className="sticky bottom-0 mt-6 flex justify-end gap-2 border-t border-subtle bg-surface-1 py-4">
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void save()}
            loading={isSaving}
            disabled={!form.title.trim()}
          >
            {release ? "Save changes" : "Create release"}
          </Button>
        </div>
      </div>
      <MusicResourcePickerModal
        workspaceSlug={workspaceSlug}
        isOpen={artistPickerOpen}
        resourceType="party"
        title="Release artists"
        items={parties.filter((party) => party.kind === "ARTIST" || party.kind === "GROUP")}
        selectedIds={form.artist_ids}
        options={options}
        defaultKind="ARTIST"
        onClose={() => setArtistPickerOpen(false)}
        onSelect={(ids) => set("artist_ids", ids)}
        onChanged={onResourcesChanged}
      />
    </BudgetPeekPanel>
  );
}
