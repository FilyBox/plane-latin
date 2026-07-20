import { API_BASE_URL } from "@plane/constants";
import type {
  TMusicCatalogOptions,
  TMusicBulkDeleteResult,
  TMusicCompany,
  TMusicFilters,
  TMusicGenre,
  TMusicImportResult,
  TMusicImportPreview,
  TMusicImportAsset,
  TMusicParty,
  TMusicRelease,
  TMusicTrack,
  TMusicTrackPage,
} from "@plane/types";
import { APIService } from "@/services/api.service";

export class MusicService extends APIService {
  constructor() {
    super(API_BASE_URL);
  }

  private data<T>(request: Promise<{ data: T }>): Promise<T> {
    return request.then((response) => response.data).catch((error) => Promise.reject(error?.response?.data));
  }

  getOptions(workspaceSlug: string) {
    return this.data<TMusicCatalogOptions>(this.get(`/api/workspaces/${workspaceSlug}/music/options/`));
  }

  getReleases(workspaceSlug: string, filters: TMusicFilters = {}) {
    return this.data<TMusicRelease[]>(
      this.get(`/api/workspaces/${workspaceSlug}/music/releases/`, { params: filters })
    );
  }

  saveRelease(workspaceSlug: string, release: Partial<TMusicRelease>) {
    const request = release.id
      ? this.patch(`/api/workspaces/${workspaceSlug}/music/releases/${release.id}/`, release)
      : this.post(`/api/workspaces/${workspaceSlug}/music/releases/`, release);
    return this.data<TMusicRelease>(request);
  }

  deleteRelease(workspaceSlug: string, releaseId: string) {
    return this.data<void>(this.delete(`/api/workspaces/${workspaceSlug}/music/releases/${releaseId}/`));
  }

  getTracks(workspaceSlug: string, filters: TMusicFilters = {}) {
    return this.data<TMusicTrackPage | TMusicTrack[]>(
      this.get(`/api/workspaces/${workspaceSlug}/music/tracks/`, { params: filters })
    );
  }

  /** Just the ids matching the filters — powers "select all matching" */
  getTrackIds(workspaceSlug: string, filters: TMusicFilters = {}) {
    return this.data<{ ids: string[] }>(
      this.get(`/api/workspaces/${workspaceSlug}/music/tracks/`, { params: { ...filters, ids_only: "true" } })
    );
  }

  saveTrack(workspaceSlug: string, track: Partial<TMusicTrack> & Record<string, unknown>) {
    const request = track.id
      ? this.patch(`/api/workspaces/${workspaceSlug}/music/tracks/${track.id}/`, track)
      : this.post(`/api/workspaces/${workspaceSlug}/music/tracks/`, track);
    return this.data<TMusicTrack>(request);
  }

  deleteTrack(workspaceSlug: string, trackId: string) {
    return this.data<void>(this.delete(`/api/workspaces/${workspaceSlug}/music/tracks/${trackId}/`));
  }

  deleteTracks(workspaceSlug: string, trackIds: string[]) {
    return this.data<TMusicBulkDeleteResult>(
      this.post(`/api/workspaces/${workspaceSlug}/music/tracks/bulk-delete/`, { track_ids: trackIds })
    );
  }

  getParties(workspaceSlug: string) {
    return this.data<TMusicParty[]>(this.get(`/api/workspaces/${workspaceSlug}/music/parties/`));
  }

  saveParty(workspaceSlug: string, party: Partial<TMusicParty>) {
    const request = party.id
      ? this.patch(`/api/workspaces/${workspaceSlug}/music/parties/${party.id}/`, party)
      : this.post(`/api/workspaces/${workspaceSlug}/music/parties/`, party);
    return this.data<TMusicParty>(request);
  }

  deleteParty(workspaceSlug: string, partyId: string) {
    return this.data<void>(this.delete(`/api/workspaces/${workspaceSlug}/music/parties/${partyId}/`));
  }

  getGenres(workspaceSlug: string) {
    return this.data<TMusicGenre[]>(this.get(`/api/workspaces/${workspaceSlug}/music/genres/`));
  }

  saveGenre(workspaceSlug: string, genre: Partial<TMusicGenre>) {
    const request = genre.id
      ? this.patch(`/api/workspaces/${workspaceSlug}/music/genres/${genre.id}/`, genre)
      : this.post(`/api/workspaces/${workspaceSlug}/music/genres/`, genre);
    return this.data<TMusicGenre>(request);
  }

  deleteGenre(workspaceSlug: string, genreId: string) {
    return this.data<void>(this.delete(`/api/workspaces/${workspaceSlug}/music/genres/${genreId}/`));
  }

  getCompanies(workspaceSlug: string) {
    return this.data<TMusicCompany[]>(this.get(`/api/workspaces/${workspaceSlug}/music/companies/`));
  }

  saveCompany(workspaceSlug: string, company: Partial<TMusicCompany>) {
    const request = company.id
      ? this.patch(`/api/workspaces/${workspaceSlug}/music/companies/${company.id}/`, company)
      : this.post(`/api/workspaces/${workspaceSlug}/music/companies/`, company);
    return this.data<TMusicCompany>(request);
  }

  deleteCompany(workspaceSlug: string, companyId: string) {
    return this.data<void>(this.delete(`/api/workspaces/${workspaceSlug}/music/companies/${companyId}/`));
  }

  /** `source` is a fresh browser File or the id of a stored import asset */
  previewImport(workspaceSlug: string, source: File | { assetId: string }, sheet?: string) {
    const data = new FormData();
    if (source instanceof File) data.append("file", source);
    else data.append("asset_id", source.assetId);
    if (sheet) data.append("sheet", sheet);
    return this.data<TMusicImportPreview>(
      this.post(`/api/workspaces/${workspaceSlug}/music/import/preview/`, data, {
        headers: { "Content-Type": "multipart/form-data" },
      })
    );
  }

  importSpreadsheet(
    workspaceSlug: string,
    source: File | { assetId: string },
    mapping: Record<string, string | string[]>,
    duplicateStrategy: "skip" | "update" | "error",
    dryRun: boolean,
    sheet?: string,
    defaults: Record<string, unknown> = {},
    invalidRowStrategy: "abort" | "skip" = "abort",
    rowOverrides: Record<string, Record<string, string>> = {},
    valueOverrides: Record<string, Record<string, string>> = {},
    dedupeBy: string = "auto",
    relationsMode: "merge" | "replace" = "merge"
  ) {
    const data = new FormData();
    if (source instanceof File) data.append("file", source);
    else data.append("asset_id", source.assetId);
    data.append("mapping", JSON.stringify(mapping));
    data.append("duplicate_strategy", duplicateStrategy);
    data.append("dedupe_by", dedupeBy);
    data.append("relations_mode", relationsMode);
    data.append("dry_run", String(dryRun));
    data.append("defaults", JSON.stringify(defaults));
    data.append("invalid_row_strategy", invalidRowStrategy);
    data.append("row_overrides", JSON.stringify(rowOverrides));
    data.append("value_overrides", JSON.stringify(valueOverrides));
    if (sheet) data.append("sheet", sheet);
    return this.data<TMusicImportResult>(
      this.post(`/api/workspaces/${workspaceSlug}/music/import/`, data, {
        headers: { "Content-Type": "multipart/form-data" },
      })
    );
  }

  /** Optional AI column mapping for the manual import panel */
  aiMapImport(workspaceSlug: string, source: File | { assetId: string }, sheet?: string) {
    const data = new FormData();
    if (source instanceof File) data.append("file", source);
    else data.append("asset_id", source.assetId);
    if (sheet) data.append("sheet", sheet);
    return this.data<{ mapping: Record<string, string | string[]>; model: string | null }>(
      this.post(`/api/workspaces/${workspaceSlug}/music/import/ai-map/`, data, {
        headers: { "Content-Type": "multipart/form-data" },
      })
    );
  }

  getImportAssets(workspaceSlug: string, search = "") {
    return this.data<{ results: TMusicImportAsset[] }>(
      this.get(`/api/workspaces/${workspaceSlug}/music/import-assets/`, { params: { search } })
    );
  }

  deleteImportAssets(workspaceSlug: string, assetIds: string[]) {
    return this.data<{ deleted: number; not_found: number }>(
      this.post(`/api/workspaces/${workspaceSlug}/music/import-assets/`, {
        action: "delete",
        asset_ids: assetIds,
      })
    );
  }

  async downloadReport(
    workspaceSlug: string,
    window: "upcoming" | "last_30_days" | "filtered",
    format: "csv" | "xlsx" = "csv",
    filters: TMusicFilters = {}
  ) {
    const response = await this.get(`/api/workspaces/${workspaceSlug}/music/reports/`, {
      params: { ...filters, ...(window === "filtered" ? {} : { window }), format },
      responseType: "blob",
    });
    const url = URL.createObjectURL(response.data);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `music-catalog-${window}.${format}`;
    anchor.click();
    URL.revokeObjectURL(url);
  }
}

export const musicService = new MusicService();
