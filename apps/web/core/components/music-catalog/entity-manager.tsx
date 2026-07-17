import { useEffect, useState } from "react";
import { Building2, Check, Disc3, Pencil, Plus, Search, Tags, Trash2, Users } from "lucide-react";
import { Button } from "@plane/propel/button";
import { useTranslation } from "@plane/i18n";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TMusicCatalogOptions, TMusicCompany, TMusicGenre, TMusicParty, TMusicRelease } from "@plane/types";
import { AlertModalCore } from "@plane/ui";
import { musicService } from "@/services/music.service";
import { BudgetPeekPanel } from "../payments/budget-peek-panel";
import { getApiError, MUSIC_FIELD } from "./shared";

type Tab = "people" | "companies" | "genres" | "releases";
type Resource = TMusicParty | TMusicCompany | TMusicGenre | TMusicRelease;

const resourceName = (item: Resource) =>
  "display_name" in item ? item.display_name : "title" in item ? item.title : item.name;

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

function ResourceInlineEditor(props: {
  tab: Tab;
  name: string;
  kind: string;
  country: string;
  legalName: string;
  ipi: string;
  releaseStatus: string;
  options?: TMusicCatalogOptions;
  saving: boolean;
  onName: (value: string) => void;
  onKind: (value: string) => void;
  onCountry: (value: string) => void;
  onLegalName: (value: string) => void;
  onIpi: (value: string) => void;
  onReleaseStatus: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const { tab, name, kind, country, legalName, ipi, releaseStatus, options, saving } = props;
  const kinds =
    tab === "people" ? options?.party_kinds : tab === "companies" ? options?.company_kinds : options?.release_types;
  return (
    <div className="grid w-full gap-2 sm:grid-cols-2">
      <input
        value={name}
        onChange={(e) => props.onName(e.target.value)}
        placeholder={tab === "releases" ? t("music_resources.releases") : t("music_resources.name")}
        className={`${MUSIC_FIELD} sm:col-span-2`}
      />
      {tab !== "genres" && (
        <select value={kind} onChange={(e) => props.onKind(e.target.value)} className={MUSIC_FIELD}>
          {kinds?.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      )}
      {tab !== "genres" && tab !== "releases" && (
        <input
          value={country}
          onChange={(e) => props.onCountry(e.target.value)}
          placeholder={t("music_resources.country_optional")}
          className={MUSIC_FIELD}
        />
      )}
      {tab === "releases" && (
        <select value={releaseStatus} onChange={(e) => props.onReleaseStatus(e.target.value)} className={MUSIC_FIELD}>
          {options?.release_statuses.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      )}
      {tab === "people" && (
        <>
          <input
            value={legalName}
            onChange={(e) => props.onLegalName(e.target.value)}
            placeholder={t("music_resources.legal_name_optional")}
            className={MUSIC_FIELD}
          />
          <input
            value={ipi}
            onChange={(e) => props.onIpi(e.target.value)}
            placeholder={t("music_resources.ipi_optional")}
            className={MUSIC_FIELD}
          />
        </>
      )}
      <div className="flex justify-end gap-2 sm:col-span-2">
        <Button variant="secondary" size="sm" onClick={props.onCancel}>
          {t("music_resources.cancel")}
        </Button>
        <Button variant="primary" size="sm" loading={saving} disabled={!name.trim()} onClick={props.onSave}>
          {t("music_resources.save")}
        </Button>
      </div>
    </div>
  );
}

export function MusicEntityManager(props: Props) {
  const { t } = useTranslation();
  const { workspaceSlug, isOpen, options, parties, companies, genres, releases, onClose, onChanged } = props;
  const [tab, setTab] = useState<Tab>("people");
  const [search, setSearch] = useState("");
  const [editingId, setEditingId] = useState<string>();
  const [isCreating, setIsCreating] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState("ARTIST");
  const [releaseStatus, setReleaseStatus] = useState("DRAFT");
  const [legalName, setLegalName] = useState("");
  const [ipi, setIpi] = useState("");
  const [country, setCountry] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [deleting, setDeleting] = useState<Resource>();
  const [isDeleting, setIsDeleting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  const reset = (nextTab = tab) => {
    setEditingId(undefined);
    setIsCreating(false);
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
    setSelectedIds([]);
    reset(nextTab);
  };

  const beginCreate = () => {
    reset();
    setIsCreating(true);
  };

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

  const removeSelected = async () => {
    setIsDeleting(true);
    try {
      await Promise.all(
        selectedIds.map((id) => {
          if (tab === "people") return musicService.deleteParty(workspaceSlug, id);
          if (tab === "companies") return musicService.deleteCompany(workspaceSlug, id);
          if (tab === "genres") return musicService.deleteGenre(workspaceSlug, id);
          return musicService.deleteRelease(workspaceSlug, id);
        })
      );
      setSelectedIds([]);
      setBulkDeleteOpen(false);
      onChanged();
    } catch (error) {
      setToast({ type: TOAST_TYPE.ERROR, title: "Some resources could not be deleted", message: getApiError(error) });
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
  const tabMeta: Record<Tab, { label: string; description: string; icon: typeof Users }> = {
    people: {
      label: t("music_resources.people"),
      description: t("music_resources.people_description"),
      icon: Users,
    },
    releases: {
      label: t("music_resources.releases"),
      description: t("music_resources.releases_description"),
      icon: Disc3,
    },
    companies: {
      label: t("music_resources.companies"),
      description: t("music_resources.companies_description"),
      icon: Building2,
    },
    genres: {
      label: t("music_resources.genres"),
      description: t("music_resources.genres_description"),
      icon: Tags,
    },
  };

  if (!isOpen) return null;
  return (
    <BudgetPeekPanel
      title={t("music_resources.title")}
      description={t("music_resources.description")}
      onClose={onClose}
    >
      <div className="flex h-full min-h-0 flex-col bg-surface-1">
        <div className="horizontal-scrollbar flex shrink-0 overflow-x-auto border-b border-subtle px-2 sm:px-5">
          {(["people", "releases", "companies", "genres"] as Tab[]).map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => selectTab(item)}
              className={`border-b-2 px-4 py-3 text-13 ${tab === item ? "border-accent-primary bg-accent-primary/5 font-medium text-primary" : "border-transparent text-secondary hover:bg-layer-1-hover"}`}
            >
              {tabMeta[item].label}
            </button>
          ))}
        </div>
        <div className="vertical-scrollbar min-h-0 flex-1 overflow-y-auto">
          <section className="px-5 py-5">
            <div className="mb-4 flex items-center justify-between">
              <p className="text-13 font-semibold">{t("music_resources.workspace_catalog")}</p>
              <div className="flex items-center gap-2">
                <Button variant="primary" size="sm" onClick={beginCreate}>
                  <Plus className="size-3.5" /> {t("music_resources.add")} {tabMeta[tab].label.slice(0, -1)}
                </Button>
                {selectedIds.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setBulkDeleteOpen(true)}
                    className="text-11 text-danger-primary hover:underline"
                  >
                    {t("music_resources.delete_selected", { count: selectedIds.length })}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() =>
                    setSelectedIds(selectedIds.length === visible.length ? [] : visible.map((item) => item.id))
                  }
                  className="text-11 text-accent-primary hover:underline"
                >
                  {selectedIds.length === visible.length && visible.length
                    ? t("music_resources.clear_all")
                    : t("music_resources.select_all")}
                </button>
                <span className="text-11 text-tertiary">{t("music_resources.records", { count: visible.length })}</span>
              </div>
            </div>
            <div className="relative mb-4">
              <Search className="absolute top-2.5 left-3 size-4 text-tertiary" />
              <input
                className={`${MUSIC_FIELD} pl-9`}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t("music_resources.search")}
              />
            </div>
            <div className="space-y-2">
              {isCreating && (
                <div className="border-accent-primary rounded-xl border bg-accent-primary/5 p-3">
                  <ResourceInlineEditor
                    tab={tab}
                    name={name}
                    kind={kind}
                    country={country}
                    legalName={legalName}
                    ipi={ipi}
                    releaseStatus={releaseStatus}
                    options={options}
                    saving={isSaving}
                    onName={setName}
                    onKind={setKind}
                    onCountry={setCountry}
                    onLegalName={setLegalName}
                    onIpi={setIpi}
                    onReleaseStatus={setReleaseStatus}
                    onSave={() => void save()}
                    onCancel={() => reset()}
                  />
                </div>
              )}
              {visible.map((item) => {
                const itemName = resourceName(item);
                const isEditing = editingId === item.id;
                return (
                  <div
                    key={item.id}
                    className={`group flex items-center justify-between rounded-xl border px-4 py-3 transition-colors ${selectedIds.includes(item.id) ? "border-accent-primary bg-accent-primary/5" : "border-subtle bg-layer-1 hover:border-strong hover:bg-layer-1-hover"}`}
                  >
                    {isEditing ? (
                      <ResourceInlineEditor
                        tab={tab}
                        name={name}
                        kind={kind}
                        country={country}
                        legalName={legalName}
                        ipi={ipi}
                        releaseStatus={releaseStatus}
                        options={options}
                        saving={isSaving}
                        onName={setName}
                        onKind={setKind}
                        onCountry={setCountry}
                        onLegalName={setLegalName}
                        onIpi={setIpi}
                        onReleaseStatus={setReleaseStatus}
                        onSave={() => void save()}
                        onCancel={() => reset()}
                      />
                    ) : (
                      <>
                        <div className="flex min-w-0 items-center gap-3">
                          <button
                            type="button"
                            onClick={() =>
                              setSelectedIds((current) =>
                                current.includes(item.id)
                                  ? current.filter((id) => id !== item.id)
                                  : [...current, item.id]
                              )
                            }
                            className={`grid size-5 shrink-0 place-items-center rounded border ${selectedIds.includes(item.id) ? "border-accent-primary bg-accent-primary text-on-color" : "border-strong"}`}
                            aria-label={`Select ${itemName}`}
                          >
                            {selectedIds.includes(item.id) && <Check className="size-3" />}
                          </button>
                          <div className="min-w-0">
                            <p className="truncate text-13 font-medium text-primary">{itemName}</p>
                            {"kind" in item && (
                              <p className="mt-0.5 text-11 text-tertiary">{item.kind.replaceAll("_", " ")}</p>
                            )}
                          </div>
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
                      </>
                    )}
                  </div>
                );
              })}
              {!visible.length && (
                <div className="rounded-lg border border-dashed border-subtle py-12 text-center text-13 text-tertiary">
                  No matching resources.
                </div>
              )}
            </div>
          </section>
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
      <AlertModalCore
        isOpen={bulkDeleteOpen}
        isSubmitting={isDeleting}
        handleClose={() => setBulkDeleteOpen(false)}
        handleSubmit={() => void removeSelected()}
        title={`Delete ${selectedIds.length} resources?`}
        content={t("music_resources.delete_confirm")}
      />
    </BudgetPeekPanel>
  );
}
