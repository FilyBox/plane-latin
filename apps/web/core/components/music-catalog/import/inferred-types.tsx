/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { Disc3 } from "lucide-react";
import { useTranslation } from "@plane/i18n";
import type { TMusicImportResult } from "@plane/types";

const TYPES = [
  ["SINGLE", "music_import.inferred.single"],
  ["EP", "music_import.inferred.ep"],
  ["ALBUM", "music_import.inferred.album"],
] as const;

type Props = {
  inferred: TMusicImportResult["release_types_inferred"];
  /** Validation: what the import would infer */
  isDryRun?: boolean;
};

/** "Tipo de lanzamiento inferido: 12 singles, 3 EP, 5 álbumes" — for new
 * releases the file gave no type. Nothing when there were none. */
export function ImportInferredTypes({ inferred, isDryRun }: Props) {
  const { t } = useTranslation();
  const parts = TYPES.filter(([type]) => (inferred?.[type] ?? 0) > 0).map(([type, key]) =>
    t(key, { count: inferred?.[type] ?? 0 })
  );
  if (parts.length === 0) return null;
  return (
    <div className="flex gap-2 text-12">
      <Disc3 className="mt-0.5 size-3.5 shrink-0 text-tertiary" aria-hidden />
      <div>
        <p className="text-primary">
          {t(isDryRun ? "music_import.inferred.line_dry" : "music_import.inferred.line", {
            summary: parts.join(", "),
          })}
        </p>
        <p className="mt-0.5 text-11 text-tertiary">{t("music_import.inferred.hint")}</p>
      </div>
    </div>
  );
}
