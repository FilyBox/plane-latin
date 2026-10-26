import { API_BASE_URL } from "@plane/constants";
import type {
  TMusicCatalogOptions,
  TMusicBulkChange,
  TMusicBulkDeleteResult,
  TMusicBulkUpdateResult,
  TMusicCompany,
  TMusicCreditRole,
  TMusicExportDescription,
  TMusicFilters,
  TMusicGenre,
  TMusicImportAiMap,
  TMusicImportConstants,
  TMusicImportFieldValues,
  TMusicImportResult,
  TMusicImportPreview,
  TMusicImportProgress,
  TMusicImportAsset,
  TMusicParty,
  TMusicRelease,
  TMusicReleaseGroupAlbum,
  TMusicReleaseGroupResult,
  TMusicReleaseInferTypesResult,
  TMusicTrack,
  TMusicTrackPage,
} from "@plane/types";
import { APIService } from "@/services/api.service";

export type TMusicImportRequest = {
  /** A fresh browser File, or a stored import asset (never re-uploaded) */
  source: File | { assetId: string };
  mapping: Record<string, string | string[]>;
  duplicateStrategy: "skip" | "update" | "error";
  dedupeBy: string;
  relationsMode: "merge" | "replace";
  dedupeWithinFile: boolean;
  ambiguousStrategy: "create" | "match" | "skip";
  blankCells: "keep" | "clear";
  dryRun: boolean;
  sheet?: string;
  defaults: Record<string, unknown>;
  invalidRowStrategy: "abort" | "skip";
  rowOverrides: Record<string, Record<string, string>>;
  valueOverrides: Record<string, Record<string, string>>;
  /** Fixed value per field for the whole file */
  constants: TMusicImportConstants;
  /** Normalized tag → role key | "__SKIP__" for contributors/performers columns */
  roleMap: Record<string, string>;
  /** Save unmapped columns as each song's extra data */
  keepUnmapped?: boolean;
};

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

  /** Creates a credit role (or returns the existing one with that name) */
  createCreditRole(workspaceSlug: string, label: string, category?: string) {
    return this.data<TMusicCreditRole & { created: boolean }>(
      this.post(`/api/workspaces/${workspaceSlug}/music/credit-roles/`, { label, category })
    );
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

  /** "Editar en lote": every change applied to every song, all or nothing */
  bulkUpdateTracks(workspaceSlug: string, trackIds: string[], changes: TMusicBulkChange[]) {
    return this.data<TMusicBulkUpdateResult>(
      this.post(`/api/workspaces/${workspaceSlug}/music/tracks/bulk-update/`, { track_ids: trackIds, changes })
    );
  }

  /** Releases still on the default type (Album) get one from their title or
   * number of songs: a dry run lists the changes, otherwise they are applied
   * (to `releaseIds` only, when given). */
  inferReleaseTypes(workspaceSlug: string, payload: { dry_run: boolean; release_ids?: string[] }) {
    return this.data<TMusicReleaseInferTypesResult>(
      this.post(`/api/workspaces/${workspaceSlug}/music/releases/infer-types/`, payload)
    );
  }

  /** Groups songs into albums and merges duplicate releases, all or nothing;
   * a dry run reports what would change and writes nothing. */
  groupReleases(workspaceSlug: string, albums: TMusicReleaseGroupAlbum[], dryRun = false) {
    return this.data<TMusicReleaseGroupResult>(
      this.post(`/api/workspaces/${workspaceSlug}/music/releases/group/`, { albums, dry_run: dryRun })
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

  /**
   * Validates (dryRun) or applies an import, reporting progress as the server
   * works through the rows. The response is a server-sent event stream: one
   * "progress" event per tick, then a single "result" — or "error".
   */
  async streamImport(
    workspaceSlug: string,
    request: TMusicImportRequest,
    onProgress: (progress: TMusicImportProgress) => void,
    signal?: AbortSignal
  ): Promise<TMusicImportResult> {
    const data = new FormData();
    if (request.source instanceof File) data.append("file", request.source);
    else data.append("asset_id", request.source.assetId);
    data.append("mapping", JSON.stringify(request.mapping));
    data.append("duplicate_strategy", request.duplicateStrategy);
    data.append("dedupe_by", request.dedupeBy);
    data.append("relations_mode", request.relationsMode);
    data.append("dedupe_within_file", String(request.dedupeWithinFile));
    data.append("ambiguous_strategy", request.ambiguousStrategy);
    data.append("blank_cells", request.blankCells);
    data.append("dry_run", String(request.dryRun));
    data.append("defaults", JSON.stringify(request.defaults));
    data.append("invalid_row_strategy", request.invalidRowStrategy);
    data.append("row_overrides", JSON.stringify(request.rowOverrides));
    data.append("value_overrides", JSON.stringify(request.valueOverrides));
    data.append("constants", JSON.stringify(request.constants));
    data.append("role_map", JSON.stringify(request.roleMap));
    data.append("keep_unmapped", String(Boolean(request.keepUnmapped)));
    data.append("stream", "true");
    if (request.sheet) data.append("sheet", request.sheet);

    const response = await fetch(`${API_BASE_URL}/api/workspaces/${workspaceSlug}/music/import/`, {
      method: "POST",
      body: data,
      credentials: "include",
      signal,
    });
    // Request-level problems (unreadable file, missing title mapping) come
    // back as plain JSON before any streaming starts.
    if (!response.ok || !response.body) {
      throw await response.json().catch(() => ({ error: response.statusText }));
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let result: TMusicImportResult | undefined;
    for (;;) {
      // A ReadableStream must be consumed in order.
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        const event = /^event: (.+)$/m.exec(block)?.[1];
        const payload = /^data: (.+)$/m.exec(block)?.[1];
        if (!event || !payload) continue;
        const parsed = JSON.parse(payload);
        if (event === "progress") onProgress(parsed as TMusicImportProgress);
        else if (event === "result") result = parsed as TMusicImportResult;
        else if (event === "error") throw parsed;
      }
    }
    if (!result) throw { error: "The import ended without a result" };
    return result;
  }

  /** Optional AI column mapping for the manual import panel */
  /** AI mapping proposal. The current mapping, the fields set by hand
   * (locked) and the fixed values let the AI fill gaps instead of redoing
   * the user's work; nothing is applied server side. */
  aiMapImport(
    workspaceSlug: string,
    source: File | { assetId: string },
    context: {
      sheet?: string;
      currentMapping?: Record<string, string | string[]>;
      lockedFields?: string[];
      constants?: TMusicImportConstants;
      locale?: string;
    } = {},
    signal?: AbortSignal
  ) {
    const data = new FormData();
    if (source instanceof File) data.append("file", source);
    else data.append("asset_id", source.assetId);
    if (context.sheet) data.append("sheet", context.sheet);
    data.append("current_mapping", JSON.stringify(context.currentMapping ?? {}));
    data.append("locked_fields", JSON.stringify(context.lockedFields ?? []));
    data.append("constants", JSON.stringify(context.constants ?? {}));
    if (context.locale) data.append("locale", context.locale);
    return this.data<TMusicImportAiMap>(
      this.post(`/api/workspaces/${workspaceSlug}/music/import/ai-map/`, data, {
        headers: { "Content-Type": "multipart/form-data" },
        signal,
      })
    );
  }

  /** Existing values of an import field (+ look-alikes of `q`) for its fixed value */
  getImportFieldValues(workspaceSlug: string, field: string, q = "", signal?: AbortSignal) {
    return this.data<TMusicImportFieldValues>(
      this.get(`/api/workspaces/${workspaceSlug}/music/import/field-values/`, { params: { field, q }, signal })
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

  /** The columns the export panel offers (registry kept by the API). */
  async getExportColumns(workspaceSlug: string): Promise<TMusicExportDescription> {
    return this.get(`/api/workspaces/${workspaceSlug}/music/reports/`, { params: { describe: "1" } }).then(
      (response) => response?.data
    );
  }

  /** Downloads the catalog with the chosen columns ("all" or column keys). */
  async exportCatalog(
    workspaceSlug: string,
    options: { format: "csv" | "xlsx"; columns: string[] | "all"; filters: TMusicFilters; fileName: string }
  ) {
    const columns = options.columns === "all" ? "all" : options.columns.join(",");
    const response = await this.get(`/api/workspaces/${workspaceSlug}/music/reports/`, {
      params: { ...options.filters, columns, format: options.format },
      responseType: "blob",
    });
    const url = URL.createObjectURL(response.data);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${options.fileName}.${options.format}`;
    anchor.click();
    URL.revokeObjectURL(url);
  }
}

export const musicService = new MusicService();
