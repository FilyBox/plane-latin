/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import { AlertCircle, CheckCircle2, History, ListMusic, Loader2, RotateCcw } from "lucide-react";
import { Link } from "react-router";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { AlertModalCore } from "@plane/ui";
import { ImportInferredTypes } from "./inferred-types";
import { ImportLinkedTags } from "./linked-tags";
import { ImportLiveCounts } from "./live-counts";
import type { TImportFlow } from "./use-import-flow";

type Props = {
  flow: TImportFlow;
  workspaceSlug: string;
  onImportAnother: () => void;
  onBackToReview: () => void;
};

export function ImportStepDone({ flow, workspaceSlug, onImportAnother, onBackToReview }: Props) {
  const { t } = useTranslation();
  const { applied, phase, assetId } = flow;
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [fileDecided, setFileDecided] = useState(false);

  if (phase === "importing" || !applied) {
    return (
      <div className="flex min-h-64 flex-col items-center justify-center text-center">
        <Loader2 className="size-5 animate-spin text-accent-primary" aria-hidden />
        <p className="mt-3 text-13 text-secondary">{t("music_import.done.running")}</p>
        <ImportLiveCounts progress={flow.progress} />
      </div>
    );
  }

  if (applied.aborted) {
    return (
      <div className="max-w-2xl space-y-4">
        <div className="flex gap-2.5 rounded-md border border-danger-subtle bg-danger-subtle px-3 py-3 text-13">
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-danger-primary" aria-hidden />
          <p className="text-primary">{t("music_import.done.aborted")}</p>
        </div>
        <Button variant="secondary" size="sm" onClick={onBackToReview}>
          {t("music_import.actions.back")}
        </Button>
      </div>
    );
  }

  const hasErrors = applied.errors.length > 0;
  // Only what happened: a wall of zeros buries the numbers that matter.
  const counts = (
    [
      ["music_import.done.count_created", applied.created],
      ["music_import.done.count_updated", applied.updated],
      ["music_import.done.count_unchanged", applied.unchanged],
      ["music_import.done.count_skipped", applied.skipped],
      ["music_import.done.count_omitted", applied.omitted],
      ["music_import.done.count_empty", applied.empty],
      ["music_import.done.count_error", applied.errors.length],
    ] as const
  ).filter(([, value]) => value > 0);

  return (
    <div className="max-w-3xl space-y-8">
      <header className="flex gap-3">
        <CheckCircle2 className="mt-0.5 size-6 shrink-0 text-success-primary" aria-hidden />
        <div>
          <h2 className="text-18 font-semibold text-primary">
            {t(hasErrors ? "music_import.done.title_with_errors" : "music_import.done.title")}
          </h2>
          <p className="mt-1 text-13 text-secondary">
            {t("music_import.done.description", {
              rows: applied.total - applied.empty,
              file: flow.sourceName ?? "",
            })}
          </p>
        </div>
      </header>

      {counts.length > 0 && (
        <dl className="flex flex-wrap gap-x-10 gap-y-4 rounded-lg border border-subtle px-5 py-4">
          {counts.map(([label, value]) => (
            <div key={label} className="flex flex-col-reverse">
              <dt className="text-11 text-secondary">{t(label)}</dt>
              <dd className="text-18 font-semibold text-primary tabular-nums">{value.toLocaleString()}</dd>
            </div>
          ))}
        </dl>
      )}

      {(applied.new_roles ?? []).length > 0 && (
        <p className="text-12 text-secondary">
          {t("music_import.done.new_roles", { count: applied.new_roles?.length ?? 0 })}:{" "}
          <span className="text-primary">{applied.new_roles?.map((role) => role.label).join(", ")}</span>
        </p>
      )}

      <ImportInferredTypes inferred={applied.release_types_inferred} />
      <ImportLinkedTags linked={applied.artist_tags_linked} />

      <section className="space-y-3">
        <p className="text-13 text-secondary">{t("music_import.done.provenance")}</p>
        <div className="flex flex-wrap gap-2">
          {applied.import_run_id && (
            <Link to={`/${workspaceSlug}/music?import_run=${applied.import_run_id}`}>
              <Button variant="primary" size="sm">
                <ListMusic className="size-3.5" />
                {t("music_import.actions.view_imported")}
              </Button>
            </Link>
          )}
          <Link to={`/${workspaceSlug}/music?import_files=1`}>
            <Button variant="secondary" size="sm">
              <History className="size-3.5" />
              {t("music_import.actions.file_history")}
            </Button>
          </Link>
          <Button variant="secondary" size="sm" onClick={onImportAnother}>
            <RotateCcw className="size-3.5" />
            {t("music_import.actions.import_another")}
          </Button>
        </div>
      </section>

      {assetId && !fileDecided && (
        <section className="rounded-lg border border-subtle px-4 py-3">
          <h3 className="text-13 font-medium text-primary">{t("music_import.done.keep_or_delete")}</h3>
          <p className="mt-0.5 text-12 text-secondary">{t("music_import.done.keep_or_delete_hint")}</p>
          <div className="mt-3 flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => setFileDecided(true)}>
              {t("music_import.actions.keep_file")}
            </Button>
            <Button variant="tertiary" size="sm" onClick={() => setIsDeleteOpen(true)}>
              {t("music_import.actions.delete_file")}
            </Button>
          </div>
        </section>
      )}

      <AlertModalCore
        isOpen={isDeleteOpen}
        isSubmitting={isDeleting}
        handleClose={() => setIsDeleteOpen(false)}
        handleSubmit={async () => {
          setIsDeleting(true);
          const deleted = await flow.deleteSourceFile();
          setIsDeleting(false);
          if (deleted) {
            setIsDeleteOpen(false);
            setFileDecided(true);
          }
        }}
        title={t("music_import.done.delete_title")}
        content={t("music_import.done.delete_content")}
        primaryButtonText={{ default: t("common.delete"), loading: t("common.deleting") }}
        secondaryButtonText={t("common.cancel")}
      />
    </div>
  );
}
