/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import useSWR, { useSWRConfig } from "swr";
import { useTranslation } from "@plane/i18n";
import type { TMusicImportAsset } from "@plane/types";
import { Button } from "@plane/propel/button";
import { musicService } from "@/services/music.service";
import { FilePreviewModal } from "../../file-library/file-preview-modal";
import { IMPORT_STEPS, importDraftKey, type TImportStep } from "./constants";
import { ImportStatusHeader } from "./status-header";
import { ImportStepColumns } from "./step-columns";
import { ImportStepDone } from "./step-done";
import { ImportStepFile } from "./step-file";
import { ImportStepReview } from "./step-review";
import { ImportStepRules } from "./step-rules";
import { useImportFlow } from "./use-import-flow";
import type { TImportDraft } from "./use-import-flow";

type Props = { workspaceSlug: string };

/**
 * Catalog import as its own page: one step at a time at full width, with a
 * fixed status band on top (never lost to scrolling) and a fixed action bar
 * at the bottom. Every option of the former side panel is kept.
 */
export function MusicImportRoot({ workspaceSlug }: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { mutate } = useSWRConfig();
  const flow = useImportFlow(workspaceSlug);
  const [step, setStep] = useState<TImportStep>("file");
  const [isFilePreviewOpen, setIsFilePreviewOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Same keys as the catalog page: switching between both never refetches.
  const { data: options } = useSWR(`MUSIC_OPTIONS_${workspaceSlug}`, () => musicService.getOptions(workspaceSlug));
  const { data: parties = [] } = useSWR(`MUSIC_PARTIES_${workspaceSlug}`, () => musicService.getParties(workspaceSlug));
  const { data: companies = [] } = useSWR(`MUSIC_COMPANIES_${workspaceSlug}`, () =>
    musicService.getCompanies(workspaceSlug)
  );
  const { data: genres = [] } = useSWR(`MUSIC_GENRES_${workspaceSlug}`, () => musicService.getGenres(workspaceSlug));
  const { data: releases = [] } = useSWR(["MUSIC_RELEASES", workspaceSlug], () =>
    musicService.getReleases(workspaceSlug)
  );
  const { data: assetData, mutate: mutateAssets } = useSWR(`MUSIC_IMPORT_ASSETS_${workspaceSlug}_`, () =>
    musicService.getImportAssets(workspaceSlug)
  );
  const savedAssets = assetData?.results ?? [];

  const refreshResources = () => {
    void mutate(`MUSIC_PARTIES_${workspaceSlug}`);
    void mutate(`MUSIC_COMPANIES_${workspaceSlug}`);
    void mutate(`MUSIC_GENRES_${workspaceSlug}`);
    void mutate(["MUSIC_RELEASES", workspaceSlug]);
  };

  // /music/import?asset=<id>: open a stored file with its last configuration
  // (the "import again" link from the file history).
  const requestedAsset = searchParams.get("asset");
  useEffect(() => {
    if (!requestedAsset || !assetData) return;
    const asset = savedAssets.find((item) => item.id === requestedAsset);
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete("asset");
        return next;
      },
      { replace: true }
    );
    // A plan from the assistant (its mapping and duplicate rules), if any.
    let draft: TImportDraft | undefined;
    try {
      const stored = sessionStorage.getItem(importDraftKey(requestedAsset));
      if (stored) {
        draft = JSON.parse(stored) as TImportDraft;
        sessionStorage.removeItem(importDraftKey(requestedAsset));
      }
    } catch {
      draft = undefined;
    }
    if (asset) void flow.reimport(asset, draft);
    // A file the assistant just received may not be in the list yet.
    else if (draft) void flow.reimport({ id: requestedAsset, name: "", last_run: null } as TMusicImportAsset, draft);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedAsset, assetData]);

  // Leaving mid-run would orphan a validation or cut an import short.
  const isBusy = flow.phase !== "idle";
  useEffect(() => {
    if (!isBusy) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [isBusy]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [step]);

  const review = flow.review;
  const canImport =
    flow.isReviewCurrent && Boolean(review) && (review!.errors.length === 0 || flow.invalidRowStrategy === "skip");
  const importableRows = review ? review.created + review.updated + review.unchanged + review.skipped : 0;

  const reachable = (target: TImportStep) => {
    if (target === "file") return step !== "import" || Boolean(flow.applied);
    if (flow.applied) return target === "import";
    if (target === "columns" || target === "rules") return Boolean(flow.preview);
    if (target === "review") return Boolean(flow.preview) && !flow.missingTitle;
    return false;
  };
  const complete = (target: TImportStep) => {
    if (flow.applied && !flow.applied.aborted) return true;
    if (target === "file") return Boolean(flow.preview);
    if (target === "columns")
      return Boolean(flow.preview) && !flow.missingTitle && step !== "columns" && step !== "file";
    if (target === "rules") return step === "review" || step === "import";
    if (target === "review") return flow.isReviewCurrent && step === "import";
    return false;
  };

  const validate = () => {
    setStep("review");
    void flow.run(true);
  };
  const runImport = () => {
    setStep("import");
    void flow.run(false).then((result) => {
      if (!result || result.aborted) return result;
      void mutate((key) => Array.isArray(key) && key[0] === "MUSIC_TRACKS");
      void mutate(`MUSIC_OPTIONS_${workspaceSlug}`);
      void mutateAssets();
      refreshResources();
      return result;
    });
  };
  const startOver = () => {
    flow.reset();
    setStep("file");
  };

  const idle = (): { message: string; tone: "neutral" | "warning" | "success" } => {
    if (flow.applied && !flow.applied.aborted) return { message: t("music_import.status.done"), tone: "success" };
    if (!flow.preview) return { message: t("music_import.status.idle_pick_file"), tone: "neutral" };
    if (flow.missingTitle) return { message: t("music_import.status.idle_map"), tone: "warning" };
    if (step === "review" && review && !flow.isReviewCurrent)
      return { message: t("music_import.status.idle_stale"), tone: "warning" };
    if (step === "review" && review) return { message: t("music_import.status.idle_validated"), tone: "neutral" };
    if (step === "review") return { message: t("music_import.status.idle_review"), tone: "neutral" };
    if (step === "rules") return { message: t("music_import.status.idle_rules"), tone: "neutral" };
    if (step === "columns") return { message: t("music_import.status.idle_columns"), tone: "neutral" };
    return { message: t("music_import.status.idle_file_ready"), tone: "neutral" };
  };

  // Why "Import" is greyed out, said next to the button instead of left to guess.
  const blockedReason = () => {
    if (step !== "review" || isBusy || !review || !flow.isReviewCurrent || canImport) return undefined;
    return t("music_import.review.blocked_errors", { count: review.errors.length });
  };
  const { message: idleMessage, tone: idleTone } = idle();

  const stepIndex = IMPORT_STEPS.indexOf(step);
  const previousStep = stepIndex > 0 && step !== "import" ? IMPORT_STEPS[stepIndex - 1] : undefined;

  const primaryAction = () => {
    if (step === "file")
      return (
        <Button variant="primary" size="sm" disabled={!flow.preview || isBusy} onClick={() => setStep("columns")}>
          {t("music_import.actions.continue")}
        </Button>
      );
    if (step === "columns")
      return (
        <Button variant="primary" size="sm" disabled={flow.missingTitle || isBusy} onClick={() => setStep("rules")}>
          {t("music_import.actions.continue")}
        </Button>
      );
    if (step === "rules")
      return (
        <Button
          variant="primary"
          size="sm"
          disabled={isBusy || flow.preview?.database_ready === false}
          onClick={validate}
        >
          {t("music_import.actions.validate")}
        </Button>
      );
    if (step === "review") {
      // A validation saves nothing, so it can be stopped at any point.
      if (flow.phase === "validating")
        return (
          <Button variant="secondary" size="sm" onClick={flow.stop}>
            {t("music_import.actions.stop")}
          </Button>
        );
      if (!review || !flow.isReviewCurrent)
        return (
          <Button variant="primary" size="sm" disabled={isBusy} onClick={validate}>
            {t(review ? "music_import.actions.revalidate" : "music_import.actions.validate")}
          </Button>
        );
      return (
        <Button variant="primary" size="sm" disabled={!canImport || isBusy} onClick={runImport}>
          {t("music_import.actions.import_rows", { count: importableRows })}
        </Button>
      );
    }
    return null;
  };

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-surface-1">
      <ImportStatusHeader
        step={step}
        reachable={reachable}
        complete={complete}
        onStep={setStep}
        phase={flow.phase}
        progress={flow.progress}
        startedAt={flow.startedAt}
        idleMessage={idleMessage}
        idleTone={idleTone}
      />

      <div
        ref={scrollRef}
        className="vertical-scrollbar min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable_both-edges]"
      >
        <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6">
          {step === "file" && (
            <ImportStepFile flow={flow} savedAssets={savedAssets} onViewFile={() => setIsFilePreviewOpen(true)} />
          )}
          {step === "columns" && (
            <ImportStepColumns flow={flow} importFields={options?.import_fields ?? []} workspaceSlug={workspaceSlug} />
          )}
          {step === "rules" && (
            <ImportStepRules
              flow={flow}
              workspaceSlug={workspaceSlug}
              options={options}
              parties={parties}
              companies={companies}
              genres={genres}
              releases={releases}
              onResourcesChanged={refreshResources}
            />
          )}
          {step === "review" && <ImportStepReview flow={flow} onValidate={validate} />}
          {step === "import" && (
            <ImportStepDone
              flow={flow}
              workspaceSlug={workspaceSlug}
              onImportAnother={startOver}
              onBackToReview={() => setStep("review")}
            />
          )}
        </div>
      </div>

      {step !== "import" && (
        <footer className="shrink-0 border-t border-subtle bg-surface-1">
          <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
            <Button variant="tertiary" size="sm" disabled={isBusy} onClick={() => navigate(`/${workspaceSlug}/music`)}>
              {t("music_import.actions.cancel")}
            </Button>
            <div className="flex min-w-0 flex-wrap items-center justify-end gap-x-3 gap-y-2">
              {blockedReason() && <p className="text-12 text-tertiary">{blockedReason()}</p>}
              <div className="flex items-center gap-2">
                {previousStep && (
                  <Button variant="secondary" size="sm" disabled={isBusy} onClick={() => setStep(previousStep)}>
                    {t("music_import.actions.back")}
                  </Button>
                )}
                {primaryAction()}
              </div>
            </div>
          </div>
        </footer>
      )}

      <FilePreviewModal
        workspaceSlug={workspaceSlug}
        file={
          isFilePreviewOpen && flow.assetId
            ? { assetId: flow.assetId, name: flow.sourceName ?? "", contentType: flow.file?.type ?? "" }
            : null
        }
        onClose={() => setIsFilePreviewOpen(false)}
        scope="music"
      />
    </div>
  );
}
