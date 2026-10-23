/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { LucideIcon } from "lucide-react";
import { Disc3, FileSignature, FileText, Layers, Mic2, Music2, Paperclip, Receipt, Wallet } from "lucide-react";
import type { TEntityName, TSharedTagKind } from "@plane/types";

/** One icon per kind of thing, the same everywhere it appears. */
export const ENTITY_ICONS: Record<TEntityName, LucideIcon> = {
  issue: Layers,
  page: FileText,
  file: Paperclip,
  contract: FileSignature,
  music_track: Music2,
  music_release: Disc3,
  music_artist: Mic2,
  budget: Wallet,
  expense: Receipt,
};

/** Order types are listed in pickers and the tag view. */
export const ENTITY_ORDER: TEntityName[] = [
  "contract",
  "file",
  "music_track",
  "music_release",
  "music_artist",
  "issue",
  "page",
  "expense",
  "budget",
];

export const isEntityName = (value: string | null | undefined): value is TEntityName =>
  !!value && (ENTITY_ORDER as string[]).includes(value);

/** i18n keys: references.types.<name> (singular) / references.groups.<name> (plural). */
export const entityLabelKey = (name: TEntityName) => `references.types.${name}`;
export const entityGroupKey = (name: TEntityName) => `references.groups.${name}`;

export const TAG_KINDS: TSharedTagKind[] = ["ARTIST", "GROUP", "PERSON", "TYPE", "CUSTOM"];
export const tagKindKey = (kind: TSharedTagKind) => `references.tag_kinds.${kind.toLowerCase()}`;
