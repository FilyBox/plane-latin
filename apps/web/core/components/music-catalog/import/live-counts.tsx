/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useTranslation } from "@plane/i18n";
import type { TMusicImportProgress } from "@plane/types";

type TCountKey = keyof Omit<TMusicImportProgress, "processed" | "total">;

const LIVE_COUNTS: [TCountKey, string][] = [
  ["created", "music_import.review.outcome_created"],
  ["updated", "music_import.review.outcome_updated"],
  ["unchanged", "music_import.review.outcome_unchanged"],
  ["skipped", "music_import.review.outcome_skipped"],
  ["errors", "music_import.review.outcome_error"],
];

/** Running totals while rows stream in, so a long run shows what it is
 * producing — not only how far along it is. */
export function ImportLiveCounts({ progress }: { progress?: TMusicImportProgress }) {
  const { t } = useTranslation();
  if (!progress || progress.processed === 0) return null;
  return (
    <dl className="mt-5 flex flex-wrap justify-center gap-x-6 gap-y-2">
      {LIVE_COUNTS.map(([key, label]) => (
        <div key={key} className="flex min-w-16 flex-col-reverse">
          <dt className="text-11 text-tertiary">{t(label)}</dt>
          <dd className="text-15 font-semibold text-primary tabular-nums">{progress[key].toLocaleString()}</dd>
        </div>
      ))}
    </dl>
  );
}
