/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "@plane/i18n";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TMusicImportAsset, TMusicImportPreview, TMusicImportProgress, TMusicImportResult } from "@plane/types";
import { fileLibraryService } from "@/services/file-library.service";
import { musicService } from "@/services/music.service";
import { getApiError } from "../shared";
import { columnsOf, REQUIRED_FIELD, SKIP_ROW } from "./constants";

export type TDefaultCredit = { party_id: string; role: string };

export type TImportRules = {
  strategy: "skip" | "update" | "error";
  dedupeBy: string;
  relationsMode: "merge" | "replace";
  dedupeWithinFile: boolean;
  ambiguousStrategy: "create" | "match" | "skip";
  blankCells: "keep" | "clear";
};

export type TImportDefaults = {
  credits: TDefaultCredit[];
  companyIds: string[];
  genreIds: string[];
  releaseIds: string[];
};

/** What the page is busy with — drives the status bar */
export type TImportPhase = "idle" | "uploading" | "reading" | "validating" | "importing";

export type TValueDecision = { mode: "" | "assign" | "empty" | "skip"; value: string };

/** A plan prepared by the assistant: its mapping and duplicate rules replace
 * the file's last configuration. */
export type TImportDraft = {
  mapping?: Record<string, string | string[]>;
  sheet?: string | null;
  dedupe_by?: string;
  duplicate_strategy?: "skip" | "update";
};

const DEFAULT_RULES: TImportRules = {
  strategy: "skip",
  dedupeBy: "auto",
  relationsMode: "merge",
  dedupeWithinFile: false,
  ambiguousStrategy: "create",
  blankCells: "keep",
};

const EMPTY_DEFAULTS: TImportDefaults = { credits: [], companyIds: [], genreIds: [], releaseIds: [] };

export function useImportFlow(workspaceSlug: string) {
  const { t } = useTranslation();
  const [file, setFile] = useState<File>();
  const [assetId, setAssetId] = useState<string>();
  const [assetName, setAssetName] = useState<string>();
  const [preview, setPreview] = useState<TMusicImportPreview>();
  const [mapping, setMapping] = useState<Record<string, string | string[]>>({});
  const [rules, setRules] = useState<TImportRules>(DEFAULT_RULES);
  const [defaults, setDefaults] = useState<TImportDefaults>(EMPTY_DEFAULTS);
  const [valueOverrides, setValueOverrides] = useState<Record<string, Record<string, string>>>({});
  const [rowOverrides, setRowOverrides] = useState<Record<string, Record<string, string>>>({});
  const [invalidRowStrategy, setInvalidRowStrategy] = useState<"abort" | "skip">("abort");
  const [review, setReview] = useState<TMusicImportResult>();
  const [reviewKey, setReviewKey] = useState<string>();
  const [applied, setApplied] = useState<TMusicImportResult>();
  const [phase, setPhase] = useState<TImportPhase>("idle");
  const [progress, setProgress] = useState<TMusicImportProgress>();
  const [startedAt, setStartedAt] = useState<number>();
  const [isAiMapping, setIsAiMapping] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  // A file this page stored that no import has used yet. Picking another file
  // or leaving the page discards it, so abandoned attempts don't pile up as
  // "never imported" copies in the file history.
  const unusedUploadRef = useRef<string | undefined>(undefined);

  // The stored copy once there is one (the file never travels again, and the
  // import run links to that same copy); the browser File only until then.
  const source = useMemo<File | { assetId: string } | undefined>(() => (assetId ? { assetId } : file), [assetId, file]);

  const discardUnusedUpload = useCallback(() => {
    const unused = unusedUploadRef.current;
    unusedUploadRef.current = undefined;
    if (unused) void musicService.deleteImportAssets(workspaceSlug, [unused]).catch(() => undefined);
  }, [workspaceSlug]);

  useEffect(() => discardUnusedUpload, [discardUnusedUpload]);
  const sourceName = file?.name ?? assetName;
  const missingTitle = columnsOf(mapping[REQUIRED_FIELD]).length === 0;

  /** Everything a review depends on. When it drifts the review is stale and
   * importing asks for another check first. */
  const configKey = useMemo(
    () =>
      JSON.stringify({
        mapping,
        rules,
        defaults,
        valueOverrides,
        rowOverrides,
        sheet: preview?.selected_sheet,
      }),
    [mapping, rules, defaults, valueOverrides, rowOverrides, preview?.selected_sheet]
  );
  const isReviewCurrent = Boolean(review) && reviewKey === configKey;

  const reset = useCallback(() => {
    abortRef.current?.abort();
    discardUnusedUpload();
    setFile(undefined);
    setAssetId(undefined);
    setAssetName(undefined);
    setPreview(undefined);
    setMapping({});
    setRules(DEFAULT_RULES);
    setDefaults(EMPTY_DEFAULTS);
    setValueOverrides({});
    setRowOverrides({});
    setInvalidRowStrategy("abort");
    setReview(undefined);
    setReviewKey(undefined);
    setApplied(undefined);
    setPhase("idle");
    setProgress(undefined);
  }, [discardUnusedUpload]);

  const inspect = useCallback(
    async (target: File | { assetId: string }, sheet?: string) => {
      setPhase("reading");
      try {
        const next = await musicService.previewImport(workspaceSlug, target, sheet);
        setPreview(next);
        setMapping(next.mapping);
        setReview(undefined);
        setReviewKey(undefined);
        return next;
      } catch (error) {
        setToast({ type: TOAST_TYPE.ERROR, title: t("music_import.file.read_failed"), message: getApiError(error) });
        return undefined;
      } finally {
        setPhase("idle");
      }
    },
    [t, workspaceSlug]
  );

  /** A new file: stored first (so it can be re-imported and every song can
   * point back to it), then read. A failed upload says so and stops — it
   * never leaves the page looking like it moved on. */
  const chooseFile = useCallback(
    async (selected: File) => {
      reset();
      setFile(selected);
      setPhase("uploading");
      try {
        const uploaded = await fileLibraryService.uploadFile(workspaceSlug, selected, undefined, undefined, "music", {
          music_asset_kind: "IMPORT_SOURCE",
          upload_source: "manual",
        });
        setAssetId(uploaded.asset_id);
        unusedUploadRef.current = uploaded.asset_id;
      } catch (error) {
        setFile(undefined);
        setPhase("idle");
        setToast({ type: TOAST_TYPE.ERROR, title: t("music_import.file.upload_failed"), message: getApiError(error) });
        return false;
      }
      return Boolean(await inspect(selected));
    },
    [inspect, reset, t, workspaceSlug]
  );

  /** A stored file, restoring its last import's configuration. Duplicates
   * default to "update": re-importing is usually about bringing changes in.
   * An assistant `draft` takes precedence over that configuration. */
  const reimport = useCallback(
    async (asset: TMusicImportAsset, draft?: TImportDraft) => {
      reset();
      setAssetId(asset.id);
      setAssetName(asset.name);
      const ruleSet = asset.last_run?.rules ?? {};
      const next = await inspect({ assetId: asset.id }, draft?.sheet ?? asset.last_run?.sheet ?? undefined);
      if (!next) return false;
      const mappingToUse = draft?.mapping ?? ruleSet.mapping;
      if (mappingToUse && Object.keys(mappingToUse).length > 0) setMapping(mappingToUse);
      const dedupeBy = draft?.dedupe_by ?? ruleSet.dedupe_by;
      setRules({
        strategy: draft?.duplicate_strategy ?? "update",
        dedupeBy: dedupeBy && dedupeBy !== "none" ? dedupeBy : "auto",
        relationsMode: ruleSet.relations_mode ?? "merge",
        dedupeWithinFile: ruleSet.dedupe_within_file ?? false,
        ambiguousStrategy: ruleSet.ambiguous_strategy ?? "create",
        blankCells: ruleSet.blank_cells ?? "keep",
      });
      setValueOverrides(ruleSet.value_overrides ?? {});
      setRowOverrides(ruleSet.row_overrides ?? {});
      setInvalidRowStrategy(ruleSet.invalid_row_strategy ?? "abort");
      const saved = ruleSet.defaults ?? {};
      setDefaults({
        credits: saved.credit_entries ?? [],
        companyIds: (saved.distribution_entries ?? []).map((entry) => entry.company_id),
        genreIds: saved.genre_ids ?? [],
        releaseIds: (saved.releases ?? []).map((entry) => entry.id),
      });
      return true;
    },
    [inspect, reset]
  );

  const changeSheet = useCallback(
    (sheet: string) => {
      if (source) void inspect(source, sheet);
    },
    [inspect, source]
  );

  const setFieldColumns = useCallback((field: string, columns: string[], multi: boolean) => {
    setMapping((current) => {
      const next = { ...current };
      if (columns.length === 0) delete next[field];
      else next[field] = multi ? columns : columns[0];
      return next;
    });
  }, []);

  const aiMap = useCallback(async () => {
    if (!source) return;
    setIsAiMapping(true);
    try {
      const { mapping: suggested } = await musicService.aiMapImport(
        workspaceSlug,
        source,
        preview?.selected_sheet ?? undefined
      );
      const count = Object.keys(suggested).length;
      if (count === 0) {
        setToast({ type: TOAST_TYPE.WARNING, title: t("music_import.columns.ai_empty") });
        return;
      }
      setMapping((current) => ({ ...current, ...suggested }));
      setToast({ type: TOAST_TYPE.SUCCESS, title: t("music_import.columns.ai_applied", { count }) });
    } catch (error) {
      setToast({ type: TOAST_TYPE.ERROR, title: t("music_import.columns.ai_failed"), message: getApiError(error) });
    } finally {
      setIsAiMapping(false);
    }
  }, [preview?.selected_sheet, source, t, workspaceSlug]);

  /** One decision per unparseable value → the overrides the backend applies
   * (keyed lowercase, so every casing of the value shares the decision). */
  const decideValues = useCallback((field: string, tokens: string[], decision: TValueDecision) => {
    setValueOverrides((current) => {
      const nextField = { ...current[field] };
      for (const token of tokens) {
        const key = token.toLowerCase();
        if (decision.mode === "empty") nextField[key] = "";
        else if (decision.mode === "skip") nextField[key] = SKIP_ROW;
        else if (decision.mode === "assign" && decision.value.trim()) nextField[key] = decision.value.trim();
        else delete nextField[key];
      }
      const next = { ...current, [field]: nextField };
      if (Object.keys(nextField).length === 0) delete next[field];
      return next;
    });
  }, []);

  const fixRow = useCallback((row: number, field: string, value: string) => {
    setRowOverrides((current) => ({ ...current, [String(row)]: { ...current[String(row)], [field]: value } }));
  }, []);

  /** Runs a validation (dryRun) or the import, streaming progress into the
   * status bar. Returns the result, or undefined when it failed. */
  const run = useCallback(
    async (dryRun: boolean) => {
      if (!source || missingTitle) return undefined;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const keyAtStart = configKey;
      // From the moment an import is launched the stored file is never
      // discarded automatically: if the connection drops after the server
      // saved everything, the page can't tell — the file must stay linked.
      if (!dryRun) unusedUploadRef.current = undefined;
      setPhase(dryRun ? "validating" : "importing");
      setProgress({
        processed: 0,
        total: preview?.total_rows ?? 0,
        created: 0,
        updated: 0,
        unchanged: 0,
        skipped: 0,
        errors: 0,
      });
      setStartedAt(Date.now());
      try {
        const result = await musicService.streamImport(
          workspaceSlug,
          {
            source,
            mapping,
            duplicateStrategy: rules.strategy,
            dedupeBy: rules.dedupeBy,
            relationsMode: rules.relationsMode,
            dedupeWithinFile: rules.dedupeWithinFile,
            ambiguousStrategy: rules.ambiguousStrategy,
            blankCells: rules.blankCells,
            dryRun,
            sheet: preview?.selected_sheet ?? undefined,
            defaults: {
              credit_entries: defaults.credits,
              distribution_entries: defaults.companyIds.map((company_id) => ({ company_id })),
              genre_ids: defaults.genreIds,
              releases: defaults.releaseIds.map((id) => ({ id })),
            },
            invalidRowStrategy,
            rowOverrides,
            valueOverrides,
          },
          setProgress,
          controller.signal
        );
        if (dryRun) {
          setReview(result);
          setReviewKey(keyAtStart);
        } else {
          setApplied(result);
        }
        return result;
      } catch (error) {
        if (controller.signal.aborted) return undefined;
        setToast({
          type: TOAST_TYPE.ERROR,
          title: t(dryRun ? "music_import.review.failed" : "music_import.done.failed"),
          message: getApiError(error),
        });
        return undefined;
      } finally {
        if (abortRef.current === controller) {
          setPhase("idle");
          abortRef.current = null;
        }
      }
    },
    [
      configKey,
      defaults,
      invalidRowStrategy,
      mapping,
      missingTitle,
      preview,
      rowOverrides,
      rules,
      source,
      t,
      valueOverrides,
      workspaceSlug,
    ]
  );

  /** Stops whatever is streaming (used for validations, which save nothing). */
  const stop = useCallback(() => abortRef.current?.abort(), []);

  const deleteSourceFile = useCallback(async () => {
    if (!assetId) return false;
    try {
      await musicService.deleteImportAssets(workspaceSlug, [assetId]);
      setAssetId(undefined);
      setToast({ type: TOAST_TYPE.SUCCESS, title: t("music_import.done.deleted") });
      return true;
    } catch (error) {
      setToast({ type: TOAST_TYPE.ERROR, title: t("music_import.done.delete_failed"), message: getApiError(error) });
      return false;
    }
  }, [assetId, t, workspaceSlug]);

  return {
    // source
    file,
    assetId,
    source,
    sourceName,
    preview,
    chooseFile,
    reimport,
    changeSheet,
    reset,
    // columns
    mapping,
    missingTitle,
    setFieldColumns,
    aiMap,
    isAiMapping,
    // rules
    rules,
    setRules,
    defaults,
    setDefaults,
    // review
    review,
    isReviewCurrent,
    valueOverrides,
    decideValues,
    rowOverrides,
    fixRow,
    invalidRowStrategy,
    setInvalidRowStrategy,
    // running
    phase,
    progress,
    startedAt,
    run,
    stop,
    applied,
    deleteSourceFile,
  };
}

export type TImportFlow = ReturnType<typeof useImportFlow>;
