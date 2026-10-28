/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * Where a file came from and what was made out of it: a contract split off a
 * bundled PDF links back to the bundle (and its pages there), and the bundle
 * lists every part with its contract. Merges and page selections show the
 * same way. Nothing renders for files without such links.
 */

import { CornerLeftUp, FileText, Files } from "lucide-react";
import { Link } from "react-router";
import useSWR from "swr";
import { useTranslation } from "@plane/i18n";
import { fileLibraryService } from "@/services/file-library.service";
import type { TFileLineageRow } from "@/services/file-library.service";

export const lineageKey = (assetId: string) => `FILE_LINEAGE_${assetId}`;

/** A contract opens its panel; any other file opens the viewer. */
const pathFor = (workspaceSlug: string, row: TFileLineageRow) =>
  row.contract_id
    ? `/${workspaceSlug}/file-library/contracts/analyzed?peek=${row.contract_id}`
    : `/${workspaceSlug}/file-library?preview=${row.id}`;

function Row({ workspaceSlug, row, detail }: { workspaceSlug: string; row: TFileLineageRow; detail: string }) {
  const { t } = useTranslation();
  const analyzing = row.contract_status === "PROCESSING" || row.contract_status === "PENDING";
  return (
    <li>
      <Link
        to={pathFor(workspaceSlug, row)}
        className="flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-12 hover:bg-layer-1-hover"
        title={row.contract_title || row.name}
      >
        <FileText className="size-3.5 shrink-0 text-tertiary" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-primary">{row.contract_title || row.name}</span>
        {detail && <span className="shrink-0 text-11 text-tertiary">{detail}</span>}
        {row.contract_id && (
          <span className="shrink-0 rounded-sm bg-layer-2 px-1 py-0.5 text-10 text-secondary">
            {t(analyzing ? "file_library.lineage.analyzing" : "file_library.lineage.contract")}
          </span>
        )}
      </Link>
    </li>
  );
}

export function FileLineage({ workspaceSlug, assetId }: { workspaceSlug: string; assetId: string }) {
  const { t } = useTranslation();
  const { data } = useSWR(
    assetId ? lineageKey(assetId) : null,
    () => fileLibraryService.getLineage(workspaceSlug, assetId),
    { revalidateOnFocus: false }
  );
  const parents = data?.parents ?? [];
  const children = data?.children ?? [];
  if (parents.length === 0 && children.length === 0) return null;

  // Each split, merge or page selection made its own folder: keep them apart
  const groups: { key: string; folder?: string; rows: TFileLineageRow[] }[] = [];
  for (const row of children) {
    const key = row.folder?.id ?? "none";
    const group = groups.find((item) => item.key === key);
    if (group) group.rows.push(row);
    else groups.push({ key, folder: row.folder?.name, rows: [row] });
  }
  const pages = (row: TFileLineageRow) => (row.pages ? t("file_library.lineage.pages", { pages: row.pages }) : "");
  return (
    <div className="space-y-3">
      {parents.length > 0 && (
        <div>
          <p className="flex items-center gap-1 text-11 font-medium text-tertiary">
            <CornerLeftUp className="size-3" aria-hidden />
            {t(`file_library.lineage.from.${parents[0].kind}`)}
          </p>
          <ul className="mt-1 space-y-0.5">
            {parents.map((row) => (
              <Row key={row.id} workspaceSlug={workspaceSlug} row={row} detail={pages(row)} />
            ))}
          </ul>
        </div>
      )}
      {children.length > 0 && (
        <div>
          <p className="flex items-center gap-1 text-11 font-medium text-tertiary">
            <Files className="size-3" aria-hidden />
            {t("file_library.lineage.children", { count: children.length })}
          </p>
          {groups.map((group) => (
            <div key={group.key} className="mt-1">
              {groups.length > 1 && group.folder && (
                <p className="truncate px-1.5 pt-1 text-10 text-tertiary" title={group.folder}>
                  {group.folder}
                </p>
              )}
              <ul className="space-y-0.5">
                {group.rows.map((row) => (
                  <Row
                    key={`${row.id}:${row.position}`}
                    workspaceSlug={workspaceSlug}
                    row={row}
                    detail={
                      row.kind === "MERGE"
                        ? t("file_library.lineage.merged")
                        : row.kind === "SPLIT"
                          ? t("file_library.lineage.part", { index: row.position, pages: row.pages })
                          : pages(row)
                    }
                  />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
