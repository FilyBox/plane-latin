/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

/** Links between contracts and catalog works (songs and releases). */

export type TContractWorkEntityType = "music_track" | "music_release";

export type TContractWorkLinkStatus = "SUGGESTED" | "LINKED" | "DISMISSED";

export type TContractWorkLinkSource = "MANUAL" | "AI" | "ASSISTANT";

export type TContractWorkRightsType =
  | "DISTRIBUCION"
  | "EDICION"
  | "MASTER"
  | "LICENCIA"
  | "SINCRONIZACION"
  | "REPRESENTACION"
  | "OTRO";

/** What the AI read in the contract, kept for unmatched works and context */
export type TContractWorkSuggested = {
  title?: string | null;
  artists?: string | string[] | null;
  isrc?: string | null;
  upc?: string | null;
  version?: string | null;
};

export type TContractWorkEvidence = {
  quote?: string | null;
  page?: number | null;
};

export type TContractWorkEntity = {
  title: string;
  /** Artists */
  subtitle?: string | null;
  path?: string | null;
  cover_url?: string | null;
  release_date?: string | null;
  isrc?: string | null;
};

/** A link as seen from the contract */
export type TContractWorkLink = {
  id: string;
  status: TContractWorkLinkStatus;
  source: TContractWorkLinkSource;
  rights_type: TContractWorkRightsType | null;
  entity_type: TContractWorkEntityType;
  /** null: suggested work that is not in the catalog yet */
  entity_id: string | null;
  entity: TContractWorkEntity | null;
  /** The viewer can't open catalog items: no entity details are sent */
  restricted?: boolean;
  suggested: TContractWorkSuggested | null;
  evidence: TContractWorkEvidence | null;
  confidence: number | null;
  created_at: string;
};

export type TContractWorksResponse = { links: TContractWorkLink[] };

export type TContractWorkLinkItem = {
  entity_type: TContractWorkEntityType;
  entity_id: string;
  rights_type?: TContractWorkRightsType | null;
};

export type TContractWorkLinkUpdate = {
  status?: "LINKED" | "DISMISSED";
  rights_type?: TContractWorkRightsType | null;
};

export type TContractWorkCreateInCatalog = {
  title?: string;
  artists?: string;
  isrc?: string;
  release_id?: string;
};

export type TContractWorksApplyPayload = {
  link: TContractWorkLinkItem[];
  create: { title: string; artists?: string; isrc?: string; rights_type?: TContractWorkRightsType | null }[];
};

export type TContractWorksApplyResponse = { links: TContractWorkLink[]; linked?: number; created?: number };

export type TWorkContract = {
  id: string;
  titulo: string | null;
  file_name: string | null;
  estatus_contrato: string | null;
  fecha_fin_efectiva: string | null;
  days_to_expiry: number | null;
  expired?: boolean;
  path: string | null;
};

/** A link as seen from a song or release */
export type TWorkContractLink = {
  id: string;
  status: TContractWorkLinkStatus;
  source: TContractWorkLinkSource;
  rights_type: TContractWorkRightsType | null;
  contract: TWorkContract;
  evidence: TContractWorkEvidence | null;
  confidence: number | null;
  /** Songs: the link covers the song through one of its releases */
  via_release?: { id: string; title: string } | null;
};

export type TWorkContractsResponse = { links: TWorkContractLink[] };

export type TContractWorksSummary = { linked: number; suggested: number };

/** Music list filter */
export type TMusicContractFilter = "with" | "without" | "expired";
