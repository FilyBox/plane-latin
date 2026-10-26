/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { API_BASE_URL } from "@plane/constants";
import type {
  TContractWorkCreateInCatalog,
  TContractWorkLink,
  TContractWorkLinkItem,
  TContractWorkLinkUpdate,
  TContractWorkRightsType,
  TContractWorksApplyPayload,
  TContractWorksApplyResponse,
  TContractWorksResponse,
  TMusicTracksLinkContractResult,
  TWorkContractsResponse,
} from "@plane/types";
import { APIService } from "@/services/api.service";

/** Rejection with the HTTP status kept, so callers can tell 404 apart */
export type TContractWorksError = { status?: number; error?: string; detail?: string };

export const isNotFound = (error: unknown) => (error as TContractWorksError | undefined)?.status === 404;

/** Contract ⇄ catalog work links (songs and releases). */
export class ContractWorksService extends APIService {
  constructor() {
    super(API_BASE_URL);
  }

  private data<T>(request: Promise<{ data: T }>): Promise<T> {
    return request
      .then((response) => response.data)
      .catch((error) =>
        Promise.reject<T>({
          status: error?.response?.status,
          ...(typeof error?.response?.data === "object" ? error.response.data : {}),
        })
      );
  }

  getContractWorks(workspaceSlug: string, contractId: string) {
    return this.data<TContractWorksResponse>(
      this.get(`/api/workspaces/${workspaceSlug}/contracts/${contractId}/works/`)
    );
  }

  linkWorks(workspaceSlug: string, contractId: string, items: TContractWorkLinkItem[]) {
    return this.data<TContractWorksResponse>(
      this.post(`/api/workspaces/${workspaceSlug}/contracts/${contractId}/works/`, { items })
    );
  }

  /** Links existing works and adds the new ones to the catalog in one go */
  applyWorks(workspaceSlug: string, contractId: string, payload: TContractWorksApplyPayload) {
    return this.data<TContractWorksApplyResponse>(
      this.post(`/api/workspaces/${workspaceSlug}/contracts/${contractId}/works/apply/`, payload)
    );
  }

  updateLink(workspaceSlug: string, linkId: string, data: TContractWorkLinkUpdate) {
    return this.data<TContractWorkLink>(
      this.patch(`/api/workspaces/${workspaceSlug}/contract-work-links/${linkId}/`, data)
    );
  }

  createInCatalog(workspaceSlug: string, linkId: string, data: TContractWorkCreateInCatalog) {
    return this.data<TContractWorkLink>(
      this.post(`/api/workspaces/${workspaceSlug}/contract-work-links/${linkId}/create-in-catalog/`, data)
    );
  }

  deleteLink(workspaceSlug: string, linkId: string) {
    return this.data<void>(this.delete(`/api/workspaces/${workspaceSlug}/contract-work-links/${linkId}/`));
  }

  getTrackContracts(workspaceSlug: string, trackId: string) {
    return this.data<TWorkContractsResponse>(
      this.get(`/api/workspaces/${workspaceSlug}/music/tracks/${trackId}/contracts/`)
    );
  }

  /** Links the songs selected in the catalog to one contract */
  linkTracksToContract(
    workspaceSlug: string,
    contractId: string,
    trackIds: string[],
    rightsType?: TContractWorkRightsType | null
  ) {
    return this.data<TMusicTracksLinkContractResult>(
      this.post(`/api/workspaces/${workspaceSlug}/music/tracks/link-contract/`, {
        contract_id: contractId,
        track_ids: trackIds,
        rights_type: rightsType ?? null,
      })
    );
  }

  getReleaseContracts(workspaceSlug: string, releaseId: string) {
    return this.data<TWorkContractsResponse>(
      this.get(`/api/workspaces/${workspaceSlug}/music/releases/${releaseId}/contracts/`)
    );
  }
}

export const contractWorksService = new ContractWorksService();
