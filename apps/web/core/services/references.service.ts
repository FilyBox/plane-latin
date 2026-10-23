/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { API_BASE_URL } from "@plane/constants";
import type {
  TEntityCard,
  TEntityName,
  TEntityReferences,
  TEntitySearchResponse,
  TReferenceSource,
  TSharedTag,
  TSharedTagEntities,
  TSharedTagFilters,
  TSharedTagKind,
  TTaggingMergeProposal,
  TTaggingOverview,
  TTaggingRun,
  TTaggingTagProposal,
} from "@plane/types";
import { APIService } from "@/services/api.service";

/** Cross-module mentions, references and shared tags. */
export class ReferencesService extends APIService {
  constructor() {
    super(API_BASE_URL);
  }

  async search(
    workspaceSlug: string,
    query: string,
    options: { types?: TEntityName[]; count?: number } = {}
  ): Promise<TEntitySearchResponse> {
    return this.get(`/api/workspaces/${workspaceSlug}/entities/search/`, {
      params: {
        q: query,
        types: options.types?.join(",") || undefined,
        count: options.count,
      },
    }).then((response) => response.data);
  }

  async resolve(workspaceSlug: string, items: { entity_name: string; id: string }[]): Promise<TEntityCard[]> {
    return this.post(`/api/workspaces/${workspaceSlug}/entities/resolve/`, { items }).then(
      (response) => response.data.results
    );
  }

  async getReferences(
    workspaceSlug: string,
    type: TEntityName | TReferenceSource,
    id: string
  ): Promise<TEntityReferences> {
    return this.get(`/api/workspaces/${workspaceSlug}/entities/${type}/${id}/references/`).then(
      (response) => response.data
    );
  }

  async attach(
    workspaceSlug: string,
    source: TReferenceSource,
    sourceId: string,
    target: { entity_name: TEntityName; id: string }
  ) {
    return this.post(`/api/workspaces/${workspaceSlug}/entities/${source}/${sourceId}/references/`, target).then(
      (response) => response.data as TEntityCard[]
    );
  }

  async detach(
    workspaceSlug: string,
    source: TReferenceSource,
    sourceId: string,
    target: { entity_name: TEntityName; id: string }
  ) {
    return this.delete(
      `/api/workspaces/${workspaceSlug}/entities/${source}/${sourceId}/references/${target.entity_name}/${target.id}/`
    );
  }

  async getTags(
    workspaceSlug: string,
    options: { search?: string; kind?: TSharedTagKind; usage?: boolean } = {}
  ): Promise<TSharedTag[]> {
    return this.get(`/api/workspaces/${workspaceSlug}/shared-tags/`, {
      params: { search: options.search || undefined, kind: options.kind, usage: options.usage ? "1" : undefined },
    }).then((response) => response.data);
  }

  async createTag(workspaceSlug: string, data: { name: string; kind?: TSharedTagKind }): Promise<TSharedTag> {
    return this.post(`/api/workspaces/${workspaceSlug}/shared-tags/`, data).then((response) => response.data);
  }

  async updateTag(
    workspaceSlug: string,
    tagId: string,
    data: { name?: string; kind?: TSharedTagKind }
  ): Promise<TSharedTag> {
    return this.patch(`/api/workspaces/${workspaceSlug}/shared-tags/${tagId}/`, data).then((response) => response.data);
  }

  async deleteTag(workspaceSlug: string, tagId: string) {
    return this.delete(`/api/workspaces/${workspaceSlug}/shared-tags/${tagId}/`);
  }

  async getEntityTags(workspaceSlug: string, type: TEntityName, id: string): Promise<TSharedTag[]> {
    return this.get(`/api/workspaces/${workspaceSlug}/entities/${type}/${id}/tags/`).then((response) => response.data);
  }

  async setEntityTags(workspaceSlug: string, type: TEntityName, id: string, tagIds: string[]): Promise<TSharedTag[]> {
    return this.put(`/api/workspaces/${workspaceSlug}/entities/${type}/${id}/tags/`, { tag_ids: tagIds }).then(
      (response) => response.data
    );
  }

  async getTagsFor(workspaceSlug: string, type: TEntityName, ids: string[]): Promise<Record<string, TSharedTag[]>> {
    return this.post(`/api/workspaces/${workspaceSlug}/entities/tags/`, { entity_name: type, ids }).then(
      (response) => response.data
    );
  }

  /** Puts one tag on (or takes it off) many items of one kind. */
  async applyTag(
    workspaceSlug: string,
    tagId: string,
    entityName: TEntityName,
    ids: string[],
    action: "add" | "remove" = "add"
  ): Promise<{ changed: number; matched: number; skipped: number }> {
    return this.post(`/api/workspaces/${workspaceSlug}/shared-tags/${tagId}/apply/`, {
      entity_name: entityName,
      ids,
      action,
    }).then((response) => response.data);
  }

  async getTagEntities(
    workspaceSlug: string,
    tagId: string,
    options: { types?: TEntityName[]; offset?: number; limit?: number } & TSharedTagFilters = {}
  ): Promise<TSharedTagEntities> {
    const { types, ...rest } = options;
    return this.get(`/api/workspaces/${workspaceSlug}/shared-tags/${tagId}/entities/`, {
      params: { ...rest, types: types?.join(",") || undefined },
    }).then((response) => response.data);
  }

  async exportTag(
    workspaceSlug: string,
    tagId: string,
    types?: TEntityName[],
    filters: TSharedTagFilters = {}
  ): Promise<{ export_id: string }> {
    return this.post(`/api/workspaces/${workspaceSlug}/shared-tags/${tagId}/export/`, {
      types: types ?? [],
      ...filters,
    }).then((response) => response.data);
  }

  async getTagExport(
    workspaceSlug: string,
    tagId: string,
    exportId: string
  ): Promise<{ status: string; url: string | null; reason: string | null }> {
    return this.get(`/api/workspaces/${workspaceSlug}/shared-tags/${tagId}/export/`, {
      params: { export_id: exportId },
    }).then((response) => response.data);
  }
}

export const referencesService = new ReferencesService();

/** AI mapping runs (admin only). */
export class TaggingService extends APIService {
  constructor() {
    super(API_BASE_URL);
  }

  async overview(workspaceSlug: string): Promise<TTaggingOverview> {
    return this.get(`/api/workspaces/${workspaceSlug}/tagging-runs/`).then((response) => response.data);
  }

  async start(workspaceSlug: string, types: TEntityName[]): Promise<TTaggingRun> {
    return this.post(`/api/workspaces/${workspaceSlug}/tagging-runs/`, { types }).then((response) => response.data);
  }

  async getRun(workspaceSlug: string, runId: string): Promise<TTaggingRun> {
    return this.get(`/api/workspaces/${workspaceSlug}/tagging-runs/${runId}/`).then((response) => response.data);
  }

  async apply(
    workspaceSlug: string,
    runId: string,
    approved: { tags: TTaggingTagProposal[]; merges: TTaggingMergeProposal[] }
  ): Promise<TTaggingRun> {
    return this.post(`/api/workspaces/${workspaceSlug}/tagging-runs/${runId}/`, { action: "apply", approved }).then(
      (response) => response.data
    );
  }

  /** Folds variant tags into one; recorded as an applied run, so `act(…, "undo")` reverts it. */
  async merge(workspaceSlug: string, keepId: string, variantIds: string[]): Promise<TTaggingRun> {
    return this.post(`/api/workspaces/${workspaceSlug}/shared-tags/merge/`, {
      keep_id: keepId,
      variant_ids: variantIds,
    }).then((response) => response.data);
  }

  async act(workspaceSlug: string, runId: string, action: "undo" | "discard"): Promise<TTaggingRun> {
    return this.post(`/api/workspaces/${workspaceSlug}/tagging-runs/${runId}/`, { action }).then(
      (response) => response.data
    );
  }
}

export const taggingService = new TaggingService();
