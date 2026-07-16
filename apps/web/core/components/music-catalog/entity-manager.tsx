import { useEffect, useState } from "react";
import { Pencil, Plus, Search, Trash2 } from "lucide-react";
import { Button } from "@plane/propel/button";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TMusicCatalogOptions, TMusicCompany, TMusicGenre, TMusicParty, TMusicRelease } from "@plane/types";
import { AlertModalCore } from "@plane/ui";
import { musicService } from "@/services/music.service";
import { BudgetPeekPanel } from "../payments/budget-peek-panel";
import { getApiError, MUSIC_FIELD, MUSIC_LABEL } from "./shared";

type Tab = "people" | "companies" | "genres" | "releases";
type Resource = TMusicParty | TMusicCompany | TMusicGenre | TMusicRelease;

type Props = {
  workspaceSlug: string;
  isOpen: boolean;
  options?: TMusicCatalogOptions;
  parties: TMusicParty[];
  companies: TMusicCompany[];
  genres: TMusicGenre[];
  releases: TMusicRelease[];
  onClose: () => void;
  onChanged: () => void;
};

export function MusicEntityManager(props: Props) {
  const { workspaceSlug, isOpen, options, parties, companies, genres, releases, onClose, onChanged } = props;
  const [tab, setTab] = useState<Tab>("people");
  const [search, setSearch] = useState("");
  const [editingId, setEditingId] = useState<string>();
  const [name, setName] = useState("");
  const [kind, setKind] = useState("ARTIST");
  const [releaseStatus, setReleaseStatus] = useState("DRAFT");
  const [legalName, setLegalName] = useState("");
  const [ipi, setIpi] = useState("");
  const [country, setCountry] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [deleting, setDeleting] = useState<Resource>();
  const [isDeleting, setIsDeleting] = useState(false);

  const reset = (nextTab = tab) => {
    setEditingId(undefined);
    setName("");
    setLegalName("");
    setIpi("");
    setCountry("");
    setReleaseStatus("DRAFT");
    setKind(
      nextTab === "people"
        ? "ARTIST"
        : nextTab === "companies"
          ? "RECORD_LABEL"
          : nextTab === "releases"
            ? "SINGLE"
            : ""
    );
  };

  useEffect(() => {
    if (isOpen) reset(tab);
  }, [isOpen, tab]);

  const selectTab = (nextTab: Tab) => {
    setTab(nextTab);
    reset(nextTab);
  };

  const resourceName = (item: Resource) =>
    "display_name" in item ? item.display_name : "title" in item ? item.title : item.name;

  const edit = (item: Resource) => {
    setEditingId(item.id);
    setName(resourceName(item));
    setKind("kind" in item ? item.kind : "release_type" in item ? item.release_type : "");
    setReleaseStatus("status" in item ? item.status : "DRAFT");
    setLegalName("legal_name" in item ? item.legal_name : "");
    setIpi("ipi_cae" in item ? item.ipi_cae : "");
    setCountry("country" in item ? item.country : "");
  };

  const save = async () => {
    if (!name.trim()) return;
    setIsSaving(true);
    try {
      if (tab === "people") {
        await musicService.saveParty(workspaceSlug, {
          id: editingId,
          display_name: name.trim(),
          kind: kind as TMusicParty["kind"],
          legal_name: legalName.trim(),
          ipi_cae: ipi.trim(),
          country: country.trim().toUpperCase(),
        });
      } else if (tab === "companies") {
        await musicService.saveCompany(workspaceSlug, {
          id: editingId,
          name: name.trim(),
          kind: kind as TMusicCompany["kind"],
          country: country.trim().toUpperCase(),
        });
      } else if (tab === "genres") {
        await musicService.saveGenre(workspaceSlug, { id: editingId, name: name.trim() });
      } else {
        await musicService.saveRelease(workspaceSlug, {
          id: editingId,
          title: name.trim(),
          release_type: kind,
          status: releaseStatus,
        });
      }
      setToast({ type: TOAST_TYPE.SUCCESS, title: editingId ? "Resource updated" : "Resource created" });
      reset();
      onChanged();
    } catch (error) {
      setToast({ type: TOAST_TYPE.ERROR, title: "Could not save resource", message: getApiError(error) });
    } finally {
      setIsSaving(false);
    }
  };

  const remove = async () => {
    if (!deleting) return;
    setIsDeleting(true);
    try {
      if (tab === "people") await musicService.deleteParty(workspaceSlug, deleting.id);
      else if (tab === "companies") await musicService.deleteCompany(workspaceSlug, deleting.id);
      else if (tab === "genres") await musicService.deleteGenre(workspaceSlug, deleting.id);
      else await musicService.deleteRelease(workspaceSlug, deleting.id);
      setDeleting(undefined);
      onChanged();
    } catch (error) {
      setToast({ type: TOAST_TYPE.ERROR, title: "This resource cannot be deleted", message: getApiError(error) });
    } finally {
      setIsDeleting(false);
    }
  };

  const deleteImpact =
    tab === "people"
      ? "If this person has credits or release history, deletion will be blocked to preserve the legal record."
      : tab === "companies"
        ? "Distribution assignments will be removed. Songs and releases will remain in the catalog."
        : tab === "genres"
          ? "This genre will be removed from every classified song. Songs will remain in the catalog."
          : "Songs will remain, but their association with this release will be removed.";

  const source: Resource[] =
    tab === "people" ? parties : tab === "companies" ? companies : tab === "genres" ? genres : releases;
  const visible = source.filter((item) => {
    return resourceName(item).toLowerCase().includes(search.toLowerCase());
  });

  if (!isOpen) return null;
  return (
    <BudgetPeekPanel
      title="Catalog resources"
      description="Create, edit or remove reusable people, releases, organizations and classifications."
      onClose={onClose}
    >
      <div className="flex h-full min-h-0 flex-col bg-surface-1">
        <div className="horizontal-scrollbar flex shrink-0 overflow-x-auto border-b border-subtle px-2 sm:px-5">
          {(["people", "releases", "companies", "genres"] as Tab[]).map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => selectTab(item)}
              className={`border-b-2 px-4 py-3 text-13 capitalize ${tab === item ? "border-accent-primary text-primary" : "border-transparent text-secondary"}`}
            >
              {item}
            </button>
          ))}
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto md:grid-cols-[minmax(280px,0.8fr)_1.2fr] md:overflow-hidden">
          <div className="border-b border-subtle p-5 md:border-r md:border-b-0">
            <div className="mb-4 flex items-center gap-2 text-13 font-semibold">
              <Plus className="size-4" /> {editingId ? "Edit resource" : "New resource"}
            </div>
            <label className={MUSIC_LABEL}>
              {tab === "people" ? "Display name" : tab === "releases" ? "Release title" : "Name"}
            </label>
            <input className={MUSIC_FIELD} value={name} onChange={(event) => setName(event.target.value)} />
            {tab !== "genres" && (
              <>
                <label className={`${MUSIC_LABEL} mt-4`}>Type</label>
                <select className={MUSIC_FIELD} value={kind} onChange={(event) => setKind(event.target.value)}>
                  {(tab === "people"
                    ? options?.party_kinds
                    : tab === "releases"
                      ? options?.release_types
                      : options?.company_kinds
                  )?.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
                {tab !== "releases" && (
                  <>
                    <label className={`${MUSIC_LABEL} mt-4`}>Country (optional)</label>
                    <input
                      className={MUSIC_FIELD}
                      maxLength={2}
                      value={country}
                      onChange={(event) => setCountry(event.target.value)}
                      placeholder="MX"
                    />
                  </>
                )}
                {tab === "releases" && (
                  <>
                    <label className={`${MUSIC_LABEL} mt-4`}>Status</label>
                    <select
                      className={MUSIC_FIELD}
                      value={releaseStatus}
                      onChange={(event) => setReleaseStatus(event.target.value)}
                    >
                      {options?.release_statuses.map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </>
                )}
              </>
            )}
            {tab === "people" && (
              <>
                <label className={`${MUSIC_LABEL} mt-4`}>Legal name (optional)</label>
                <input
                  className={MUSIC_FIELD}
                  value={legalName}
                  onChange={(event) => setLegalName(event.target.value)}
                />
                <label className={`${MUSIC_LABEL} mt-4`}>IPI / CAE (optional)</label>
                <input className={MUSIC_FIELD} value={ipi} onChange={(event) => setIpi(event.target.value)} />
              </>
            )}
            <div className="mt-5 flex gap-2">
              <Button
                variant="primary"
                size="sm"
                onClick={() => void save()}
                loading={isSaving}
                disabled={!name.trim()}
              >
                {editingId ? "Save changes" : "Create"}
              </Button>
              {editingId && (
                <Button variant="secondary" size="sm" onClick={() => reset()}>
                  Cancel
                </Button>
              )}
            </div>
          </div>
          <div className="min-h-0 overflow-y-auto p-5">
            <div className="relative mb-4">
              <Search className="absolute top-2.5 left-3 size-4 text-tertiary" />
              <input
                className={`${MUSIC_FIELD} pl-9`}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={`Search ${tab}`}
              />
            </div>
            <div className="space-y-2">
              {visible.map((item) => {
                const itemName = resourceName(item);
                return (
                  <div
                    key={item.id}
                    className="flex items-center justify-between rounded-lg border border-subtle bg-layer-1 px-4 py-3"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-13 font-medium text-primary">{itemName}</p>
                      {"kind" in item && (
                        <p className="mt-0.5 text-11 text-tertiary">{item.kind.replaceAll("_", " ")}</p>
                      )}
                    </div>
                    <div className="flex gap-1">
                      <button
                        type="button"
                        className="rounded p-2 text-secondary hover:bg-layer-2"
                        onClick={() => edit(item)}
                        aria-label={`Edit ${itemName}`}
                      >
                        <Pencil className="size-4" />
                      </button>
                      <button
                        type="button"
                        className="hover:bg-red-100 hover:text-red-600 rounded p-2 text-secondary"
                        onClick={() => setDeleting(item)}
                        aria-label={`Delete ${itemName}`}
                      >
                        <Trash2 className="size-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
              {!visible.length && (
                <div className="rounded-lg border border-dashed border-subtle py-12 text-center text-13 text-tertiary">
                  No matching resources.
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      <AlertModalCore
        isOpen={Boolean(deleting)}
        isSubmitting={isDeleting}
        handleClose={() => setDeleting(undefined)}
        handleSubmit={() => void remove()}
        title={`Delete ${deleting ? resourceName(deleting) : "resource"}?`}
        content={`${deleteImpact} This action cannot be undone.`}
      />
    </BudgetPeekPanel>
  );
}
