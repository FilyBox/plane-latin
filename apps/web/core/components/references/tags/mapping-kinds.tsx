/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * Which kinds of things an AI mapping reads, with how many of each. Used by
 * "Mapear con IA" in Tags and by the assistant's mapping card. Songs and
 * releases are offered (to admins with the catalog on) but start unchecked,
 * so a run costs what it always did unless someone opts in.
 */

import { useTranslation } from "@plane/i18n";
import type { TEntityName, TTaggingOverview } from "@plane/types";
import { cn } from "@plane/utils";
import { ENTITY_ICONS, entityGroupKey } from "../entity-meta";

const OPT_IN = new Set<TEntityName>(["music_track", "music_release"]);

/** The kinds to start with: `requested` (e.g. what the assistant was asked
 * for) when given, else the server's defaults; only kinds this person may scan. */
export function initialMappingKinds(overview: TTaggingOverview, requested?: TEntityName[]): TEntityName[] {
  const base =
    requested && requested.length > 0
      ? requested
      : (overview.defaults ?? overview.scannable.filter((name) => !OPT_IN.has(name)));
  return overview.scannable.filter((name) => base.includes(name));
}

export const countMappingItems = (overview: TTaggingOverview, kinds: TEntityName[]) =>
  kinds.reduce((sum, name) => sum + (overview.counts[name] ?? 0), 0);

type Props = {
  overview: TTaggingOverview;
  chosen: TEntityName[];
  onChange: (kinds: TEntityName[]) => void;
  /** Smaller rows, for the assistant's card. */
  compact?: boolean;
};

export function MappingKindList({ overview, chosen, onChange, compact = false }: Props) {
  const { t } = useTranslation();
  return (
    <ul className="divide-y divide-subtle rounded-md border border-subtle">
      {overview.scannable.map((name) => {
        const Icon = ENTITY_ICONS[name];
        const checked = chosen.includes(name);
        return (
          <li key={name}>
            <label
              className={cn(
                "flex cursor-pointer items-center",
                compact ? "gap-2 px-2.5 py-1.5 text-12" : "gap-3 px-3 py-2.5 text-13"
              )}
            >
              <input
                type="checkbox"
                className={cn("accent-accent-primary", compact ? "size-3.5" : "size-4")}
                checked={checked}
                onChange={() => onChange(checked ? chosen.filter((item) => item !== name) : [...chosen, name])}
              />
              <Icon className={cn(compact ? "size-3.5 text-tertiary" : "size-4 text-secondary")} aria-hidden />
              <span className="flex-1 text-primary">{t(entityGroupKey(name))}</span>
              <span className={cn("text-tertiary tabular-nums", !compact && "text-12")}>
                {overview.counts[name] ?? 0}
              </span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}
