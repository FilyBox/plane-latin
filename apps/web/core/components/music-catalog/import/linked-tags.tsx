/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { Tags } from "lucide-react";
import { useTranslation } from "@plane/i18n";
import type { TMusicImportResult } from "@plane/types";

const SHOWN = 6;

type Props = {
  linked: TMusicImportResult["artist_tags_linked"];
  /** Validation: what the import would tie */
  isDryRun?: boolean;
};

/** "Ligadas a tags existentes: 3BallMTY, El Bebeto…" — artists of the
 * imported songs that now show under the tag the workspace already had for
 * them. Nothing when there were none. */
export function ImportLinkedTags({ linked, isDryRun }: Props) {
  const { t } = useTranslation();
  const names = [...new Set((linked ?? []).map((entry) => entry.tag))];
  if (names.length === 0) return null;
  const rest = names.length - SHOWN;
  return (
    <div className="flex gap-2 text-12">
      <Tags className="mt-0.5 size-3.5 shrink-0 text-tertiary" aria-hidden />
      <div>
        <p className="text-primary">
          {t(isDryRun ? "music_import.linked_tags.line_dry" : "music_import.linked_tags.line", {
            names:
              names.slice(0, SHOWN).join(", ") +
              (rest > 0 ? ` ${t("music_import.linked_tags.more", { count: rest })}` : ""),
          })}
        </p>
        <p className="mt-0.5 text-11 text-tertiary">{t("music_import.linked_tags.hint")}</p>
      </div>
    </div>
  );
}
