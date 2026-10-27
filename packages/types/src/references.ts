/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

/** Everything that can be mentioned, attached, tagged or exported from
 * anywhere in the workspace (mirrors plane.utils.entities.REGISTRY). */
export type TEntityName =
  | "issue"
  | "page"
  | "file"
  | "contract"
  | "music_track"
  | "music_release"
  | "music_artist"
  | "budget"
  | "expense";

/** What can hold mentions and attachments. */
export type TReferenceSource = "issue" | "issue_comment" | "page";

export type TEntityReferenceKind = "mention" | "attachment";

/** A resolved entity. "restricted": it exists but this viewer can't open it,
 * so no name is sent. "missing": deleted or never existed. */
export type TEntityCard = {
  entity_name: TEntityName;
  id: string;
  status: "ok" | "restricted" | "missing";
  title?: string;
  subtitle?: string;
  path?: string;
  meta?: Record<string, unknown>;
  kinds?: TEntityReferenceKind[];
  in_comment?: boolean;
  /** The item's own shared tags (tag view). */
  tags?: TSharedTag[];
  /** The date the tag view filters it by: release date, expense date… */
  date?: string | null;
};

export type TEntitySearchResponse = {
  types: TEntityName[];
  results: Partial<Record<TEntityName, TEntityCard[]>>;
};

export type TEntityReferences = {
  outgoing: TEntityCard[];
  backlinks: TEntityCard[];
};

export type TSharedTagKind = "ARTIST" | "GROUP" | "PERSON" | "TYPE" | "CUSTOM";

export type TSharedTag = {
  id: string;
  name: string;
  color: string;
  kind: TSharedTagKind;
  party_id: string | null;
  usage?: number;
};

/** How extra tags combine with the main one: things carrying all of them, or any. */
export type TSharedTagMode = "all" | "any";

export type TSharedTagEntities = {
  tag: TSharedTag;
  /** Tags combined with `tag` (the ones that exist in the workspace). */
  with_tags?: TSharedTag[];
  mode?: TSharedTagMode;
  groups: Partial<Record<TEntityName, { count: number; items: TEntityCard[] }>>;
  mentioned_in: TEntityCard[];
  /** Years with something under the tag, newest first (first page only). */
  years?: number[];
};

/** Narrowing within a tag: search text and a date range (YYYY-MM-DD). */
export type TSharedTagFilters = {
  q?: string;
  date_from?: string;
  date_to?: string;
};

/** Browsing several tags at once: extra tag ids and how they combine. */
export type TSharedTagCombination = {
  with?: string[];
  mode?: TSharedTagMode;
};

export type TTaggingRunStatus = "QUEUED" | "RUNNING" | "REVIEW" | "COMPLETED" | "FAILED" | "CANCELLED" | "UNDONE";

export type TTaggingProposalItem = {
  entity_name: TEntityName;
  id: string;
  title: string;
  confidence: number;
  reason: string;
};

export type TTaggingTagProposal = {
  name: string;
  kind: TSharedTagKind;
  items: TTaggingProposalItem[];
};

export type TTaggingMergeProposal = {
  keep: string;
  variants: string[];
  reason: string;
  /** Kind and how many items each name is on, kept tag first */
  details?: { name: string; kind: TSharedTagKind; usage: number }[];
  /** When applying: the name the kept tag ends up with, if a person edited it */
  name?: string;
};

export type TTaggingRun = {
  id: string;
  status: TTaggingRunStatus;
  /** auto: started by new uploads; ids: the items it read; source "assistant":
   * a merge confirmed from the assistant's card. */
  scope: {
    types?: TEntityName[];
    /** Kinds asked for but left out: songs and releases need the music
     * catalog module and a workspace admin. */
    skipped?: TEntityName[];
    ids?: string[];
    auto?: boolean;
    source?: "assistant";
    merge?: { keep: string; variants: string[] };
    /** "merge": a "Combinar con IA" run, which only proposes joining tags */
    mode?: "merge";
  };
  progress: Record<string, number | string>;
  error: string;
  provider: string;
  created_at: string;
  finished_at: string | null;
  counts: { tags: number; merges: number; applied_links: number; applied_merges?: number };
  proposals?: { tags: TTaggingTagProposal[]; merges: TTaggingMergeProposal[] };
};

export type TTaggingOverview = {
  runs: TTaggingRun[];
  scannable: TEntityName[];
  /** Kinds checked when starting a run; songs and releases are opt-in. */
  defaults?: TEntityName[];
  counts: Partial<Record<TEntityName, number>>;
};
