/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * "Corregir tipo de lanzamientos": releases imported before the type was
 * inferred all ended up as "Album" (the default). This lists the ones whose
 * title or number of songs says otherwise — same rule as the import — with a
 * checkbox each, and applies the checked ones in one request.
 */

import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TMusicCatalogOptions, TMusicReleaseInferTypesResult } from "@plane/types";
import { Checkbox, EModalPosition, EModalWidth, ModalCore } from "@plane/ui";
import { musicService } from "@/services/music.service";
import { getApiError } from "./shared";

const COUNT_KEYS = [
  ["SINGLE", "music_import.inferred.single"],
  ["EP", "music_import.inferred.ep"],
  ["ALBUM", "music_import.inferred.album"],
] as const;

type Props = {
  workspaceSlug: string;
  isOpen: boolean;
  options?: TMusicCatalogOptions;
  onClose: () => void;
  /** After applying: refresh releases and songs */
  onDone: () => void;
};

export function MusicReleaseTypesModal({ workspaceSlug, isOpen, options, onClose, onDone }: Props) {
  const { t } = useTranslation();
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
  const [isApplying, setIsApplying] = useState(false);
  const [data, setData] = useState<TMusicReleaseInferTypesResult>();
  const [error, setError] = useState(false);
  const isLoading = isOpen && !data && !error;

  // A fresh preview every time it opens: the catalog may have changed since
  useEffect(() => {
    if (!isOpen) {
      setData(undefined);
      setError(false);
      setUnchecked(new Set());
      return;
    }
    let active = true;
    musicService
      .inferReleaseTypes(workspaceSlug, { dry_run: true })
      .then((result) => {
        if (active) setData(result);
        return undefined;
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [isOpen, workspaceSlug]);

  const changes = useMemo(() => data?.changes ?? [], [data]);
  const checked = changes.filter((change) => !unchecked.has(change.id));
  const typeLabel = (value: string) =>
    options?.release_types.find(([key]) => key === value)?.[1] ?? value.charAt(0) + value.slice(1).toLowerCase();
  // Counts follow the checkboxes: what will actually change
  const counts = COUNT_KEYS.map(([type, key]) => [key, checked.filter((change) => change.to === type).length] as const)
    .filter(([, count]) => count > 0)
    .map(([key, count]) => t(key, { count }));

  const toggle = (id: string) =>
    setUnchecked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allChecked = changes.length > 0 && checked.length === changes.length;

  const apply = async () => {
    setIsApplying(true);
    try {
      const result = await musicService.inferReleaseTypes(workspaceSlug, {
        dry_run: false,
        release_ids: checked.map((change) => change.id),
      });
      setToast({ type: TOAST_TYPE.SUCCESS, title: t("music_catalog.release_types.done", { count: result.updated }) });
      onDone();
      onClose();
    } catch (applyError) {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: t("music_catalog.release_types.failed"),
        message: getApiError(applyError),
      });
    } finally {
      setIsApplying(false);
    }
  };

  return (
    <ModalCore
      isOpen={isOpen}
      handleClose={() => !isApplying && onClose()}
      position={EModalPosition.TOP}
      width={EModalWidth.XXL}
    >
      <div className="flex max-h-[80vh] flex-col">
        <div className="shrink-0 border-b border-subtle px-4 py-3">
          <h3 className="text-14 font-medium text-primary">{t("music_catalog.release_types.title")}</h3>
          <p className="mt-0.5 text-12 text-tertiary">{t("music_catalog.release_types.subtitle")}</p>
        </div>

        <div className="vertical-scrollbar min-h-40 flex-1 overflow-y-auto p-4">
          {isLoading && (
            <p className="flex items-center justify-center gap-2 py-10 text-12 text-tertiary">
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
              {t("music_catalog.release_types.loading")}
            </p>
          )}
          {error && !isLoading && (
            <p className="py-10 text-center text-12 text-danger-primary">
              {t("music_catalog.release_types.load_failed")}
            </p>
          )}
          {data && changes.length === 0 && (
            <p className="py-10 text-center text-12 text-tertiary">{t("music_catalog.release_types.empty")}</p>
          )}
          {changes.length > 0 && (
            <>
              <div className="mb-2 flex items-center gap-2 border-b border-subtle pb-2">
                <Checkbox
                  id="music-release-types-all"
                  checked={allChecked}
                  indeterminate={checked.length > 0 && !allChecked}
                  onChange={() => setUnchecked(allChecked ? new Set(changes.map((change) => change.id)) : new Set())}
                />
                <label htmlFor="music-release-types-all" className="cursor-pointer text-12 font-medium text-primary">
                  {t("music_catalog.release_types.select_all")}
                </label>
                {counts.length > 0 && <span className="ml-auto text-12 text-secondary">{counts.join(" · ")}</span>}
              </div>
              <ul className="space-y-0.5">
                {changes.map((change) => {
                  const id = `music-release-type-${change.id}`;
                  return (
                    <li
                      key={change.id}
                      className="flex min-w-0 items-center gap-2 rounded-sm px-1 py-1 hover:bg-layer-1-hover"
                    >
                      <Checkbox id={id} checked={!unchecked.has(change.id)} onChange={() => toggle(change.id)} />
                      <label htmlFor={id} className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-12">
                        <span className="min-w-0 truncate text-primary" title={change.title}>
                          {change.title}
                        </span>
                        <span className="shrink-0 text-tertiary">
                          · {t("music_catalog.release_types.tracks", { count: change.tracks })}
                        </span>
                        <span className="ml-auto flex shrink-0 items-center gap-1 text-secondary">
                          {typeLabel(change.from)}
                          <ArrowRight className="size-3 text-tertiary" aria-hidden />
                          <span className="font-medium text-primary">{typeLabel(change.to)}</span>
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-subtle px-4 py-3">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={isApplying}>
            {t("cancel")}
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={isApplying}
            disabled={checked.length === 0}
            onClick={() => void apply()}
          >
            {t("music_catalog.release_types.apply", { count: checked.length })}
          </Button>
        </div>
      </div>
    </ModalCore>
  );
}
