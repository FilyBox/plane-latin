/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "@plane/i18n";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type {
  TMusicImportAiSuggestion,
  TMusicImportAsset,
  TMusicImportConstants,
  TMusicImportPreview,
  TMusicImportProgress,
  TMusicImportResult,
} from "@plane/types";
import { fileLibraryService } from "@/services/file-library.service";
import { musicService } from "@/services/music.service";
import { getApiError } from "../shared";
import type { TAiDiffItem, TFieldSource } from "./ai-diff";
import { diffAiSuggestions, isCheckedByDefault } from "./ai-diff";
import { columnsOf, REQUIRED_FIELD, SKIP_ROW } from "./constants";

export type TDefaultCredit = { party_id: string; role: string };

export type TImportRules = {
  strategy: "skip" | "update" | "error";
  dedupeBy: string;
  relationsMode: "merge" | "replace";
  dedupeWithinFile: boolean;
  ambiguousStrategy: "create" | "match" | "skip";
  blankCells: "keep" | "clear";
  /** Save columns no field took as each song's extra data */
  keepUnmapped: boolean;
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
  keepUnmapped: false,
};

const EMPTY_DEFAULTS: TImportDefaults = { credits: [], companyIds: [], genreIds: [], releaseIds: [] };

/** A field's value and source before the last AI application (for undo) */
export type TAiPrevious = { columns: string[]; source?: TFieldSource };

/** What the AI proposed; reviewed against the current mapping before use */
export type TAiProposal = { suggestions: Record<string, TMusicImportAiSuggestion>; model: string | null };

const sourcesFor = (mapping: Record<string, string | string[]>, source: TFieldSource) =>
  Object.fromEntries(
    Object.entries(mapping)
      .filter(([, value]) => columnsOf(value).length > 0)
      .map(([field]) => [field, source])
  ) as Record<string, TFieldSource>;

export function useImportFlow(workspaceSlug: string) {
  const { t, currentLocale } = useTranslation();
  const [file, setFile] = useState<File>();
  const [assetId, setAssetId] = useState<string>();
  const [assetName, setAssetName] = useState<string>();
  const [preview, setPreview] = useState<TMusicImportPreview>();
  const [mapping, setMapping] = useState<Record<string, string | string[]>>({});
  const [rules, setRules] = useState<TImportRules>(DEFAULT_RULES);
  const [defaults, setDefaults] = useState<TImportDefaults>(EMPTY_DEFAULTS);
  const [valueOverrides, setValueOverrides] = useState<Record<string, Record<string, string>>>({});
  // A fixed value per field for the whole file; fills blank cells when the
  // field also has a column.
  const [constants, setConstants] = useState<TMusicImportConstants>({});
  // What each tag of a contributors/performers column imports as (only the
  // user's changes; the backend's table covers the rest).
  const [roleMap, setRoleMap] = useState<Record<string, string>>({});
  const [rowOverrides, setRowOverrides] = useState<Record<string, Record<string, string>>>({});
  const [invalidRowStrategy, setInvalidRowStrategy] = useState<"abort" | "skip">("abort");
  const [review, setReview] = useState<TMusicImportResult>();
  const [reviewKey, setReviewKey] = useState<string>();
  const [applied, setApplied] = useState<TMusicImportResult>();
  const [phase, setPhase] = useState<TImportPhase>("idle");
  const [progress, setProgress] = useState<TMusicImportProgress>();
  const [startedAt, setStartedAt] = useState<number>();
  const [isAiMapping, setIsAiMapping] = useState(false);
  const [aiStartedAt, setAiStartedAt] = useState<number>();
  // Where each mapped field came from (auto / manual / ai)
  const [fieldSources, setFieldSources] = useState<Record<string, TFieldSource>>({});
  // The AI's last proposal under review, the user's checkbox changes, and
  // the values the last applied proposal replaced (undo)
  const [aiProposal, setAiProposal] = useState<TAiProposal>();
  const [aiChecked, setAiChecked] = useState<Record<string, boolean>>({});
  const [aiHistory, setAiHistory] = useState<Record<string, TAiPrevious>>();
  const aiAbortRef = useRef<AbortController | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Latest values for callbacks that finish later (the AI request)
  const latest = useRef({
    mapping,
    fieldSources,
    constants: {} as TMusicImportConstants,
    aiHistory: undefined as Record<string, TAiPrevious> | undefined,
  });
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
  latest.current = { mapping, fieldSources, constants, aiHistory };
  const missingTitle = columnsOf(mapping[REQUIRED_FIELD]).length === 0 && !constants[REQUIRED_FIELD];

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
        constants,
        roleMap,
        sheet: preview?.selected_sheet,
      }),
    [mapping, rules, defaults, valueOverrides, rowOverrides, constants, roleMap, preview?.selected_sheet]
  );
  const isReviewCurrent = Boolean(review) && reviewKey === configKey;

  const clearAi = useCallback(() => {
    aiAbortRef.current?.abort();
    setAiProposal(undefined);
    setAiChecked({});
    setAiHistory(undefined);
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    clearAi();
    setFieldSources({});
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
    setConstants({});
    setRoleMap({});
    setInvalidRowStrategy("abort");
    setReview(undefined);
    setReviewKey(undefined);
    setApplied(undefined);
    setPhase("idle");
    setProgress(undefined);
  }, [clearAi, discardUnusedUpload]);

  const inspect = useCallback(
    async (target: File | { assetId: string }, sheet?: string) => {
      setPhase("reading");
      try {
        const next = await musicService.previewImport(workspaceSlug, target, sheet);
        setPreview(next);
        setMapping(next.mapping);
        setFieldSources(sourcesFor(next.mapping, "auto"));
        clearAi();
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
    [clearAi, t, workspaceSlug]
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
      if (mappingToUse && Object.keys(mappingToUse).length > 0) {
        setMapping(mappingToUse);
        // A restored run counts as the system's choice, not the user's
        setFieldSources(sourcesFor(mappingToUse, "auto"));
      }
      const dedupeBy = draft?.dedupe_by ?? ruleSet.dedupe_by;
      setRules({
        strategy: draft?.duplicate_strategy ?? "update",
        dedupeBy: dedupeBy && dedupeBy !== "none" ? dedupeBy : "auto",
        relationsMode: ruleSet.relations_mode ?? "merge",
        dedupeWithinFile: ruleSet.dedupe_within_file ?? false,
        ambiguousStrategy: ruleSet.ambiguous_strategy ?? "create",
        blankCells: ruleSet.blank_cells ?? "keep",
        keepUnmapped: ruleSet.keep_unmapped ?? false,
      });
      setValueOverrides(ruleSet.value_overrides ?? {});
      setRowOverrides(ruleSet.row_overrides ?? {});
      setConstants(ruleSet.constants ?? {});
      setRoleMap(ruleSet.role_map ?? {});
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

  /** The user's own pick: the field becomes "manual", which the AI only
   * touches with a flagged, unchecked suggestion. */
  const setFieldColumns = useCallback((field: string, columns: string[], multi: boolean) => {
    setMapping((current) => {
      const next = { ...current };
      if (columns.length === 0) delete next[field];
      else next[field] = multi ? columns : columns[0];
      return next;
    });
    setFieldSources((current) => {
      const next = { ...current };
      if (columns.length === 0) delete next[field];
      else next[field] = "manual";
      return next;
    });
  }, []);

  /** Writes fields with their sources in one go (AI apply / undo). */
  const writeFields = useCallback(
    (entries: { field: string; columns: string[]; source?: TFieldSource }[]) => {
      const multi = new Set(preview?.multi_fields ?? []);
      setMapping((current) => {
        const next = { ...current };
        for (const entry of entries) {
          if (entry.columns.length === 0) delete next[entry.field];
          else next[entry.field] = multi.has(entry.field) ? entry.columns : entry.columns[0];
        }
        return next;
      });
      setFieldSources((current) => {
        const next = { ...current };
        for (const entry of entries) {
          if (entry.columns.length === 0 || !entry.source) delete next[entry.field];
          else next[entry.field] = entry.source;
        }
        return next;
      });
    },
    [preview?.multi_fields]
  );

  /** Sets (or clears, with an empty value) a field's fixed value. */
  const setConstant = useCallback((field: string, value: string | string[] | undefined) => {
    setConstants((current) => {
      const next = { ...current };
      const empty = value === undefined || (Array.isArray(value) ? value.length === 0 : !value.trim());
      if (empty) delete next[field];
      else next[field] = value;
      return next;
    });
  }, []);

  /** What a tag imports as; undefined goes back to the suggested role. */
  const setTagRole = useCallback((tag: string, role: string | undefined) => {
    setRoleMap((current) => {
      const next = { ...current };
      if (role === undefined) delete next[tag];
      else next[tag] = role;
      return next;
    });
  }, []);

  const multiFieldSet = useMemo(() => new Set(preview?.multi_fields ?? []), [preview?.multi_fields]);
  const columnsWithData = useMemo(
    () => (preview?.headers ?? []).filter((header) => (preview?.column_samples?.[header]?.non_empty ?? 1) > 0),
    [preview?.column_samples, preview?.headers]
  );
  /** The proposal against the CURRENT mapping: edits made meanwhile count. */
  const aiDiff = useMemo(
    () =>
      aiProposal
        ? diffAiSuggestions(aiProposal.suggestions, mapping, fieldSources, multiFieldSet, columnsWithData)
        : undefined,
    [aiProposal, columnsWithData, fieldSources, mapping, multiFieldSet]
  );
  const isAiItemChecked = useCallback(
    (item: TAiDiffItem) => aiChecked[item.field] ?? isCheckedByDefault(item),
    [aiChecked]
  );

  /** Asks the AI for a proposal. Nothing changes until the user applies it;
   * returns how many fields it would fill and change. */
  const aiMap = useCallback(async () => {
    if (!source) return undefined;
    aiAbortRef.current?.abort();
    const controller = new AbortController();
    aiAbortRef.current = controller;
    setIsAiMapping(true);
    setAiStartedAt(Date.now());
    setAiProposal(undefined);
    setAiChecked({});
    const { mapping: currentMapping, fieldSources: sources, constants: currentConstants } = latest.current;
    try {
      const result = await musicService.aiMapImport(
        workspaceSlug,
        source,
        {
          sheet: preview?.selected_sheet ?? undefined,
          currentMapping,
          lockedFields: Object.keys(sources).filter((field) => sources[field] === "manual"),
          constants: currentConstants,
          locale: currentLocale,
        },
        controller.signal
      );
      // An older server only sends `mapping`: no confidence, no reason
      const suggestions =
        result.suggestions ??
        Object.fromEntries(
          Object.entries(result.mapping).map(([field, value]) => [
            field,
            { columns: columnsOf(value), confidence: null, reason: "", replace: false, locked: false },
          ])
        );
      setAiProposal({ suggestions, model: result.model });
      const diff = diffAiSuggestions(
        suggestions,
        latest.current.mapping,
        latest.current.fieldSources,
        multiFieldSet,
        columnsWithData
      );
      return {
        fields: diff.items.filter((item) => item.kind === "new").length,
        changes: diff.items.filter((item) => item.kind === "change").length,
      };
    } catch (error) {
      if (controller.signal.aborted) return undefined;
      setToast({ type: TOAST_TYPE.ERROR, title: t("music_import.columns.ai_failed"), message: getApiError(error) });
      return undefined;
    } finally {
      if (aiAbortRef.current === controller) {
        setIsAiMapping(false);
        aiAbortRef.current = null;
      }
    }
  }, [columnsWithData, currentLocale, multiFieldSet, preview?.selected_sheet, source, t, workspaceSlug]);

  const cancelAiMap = useCallback(() => aiAbortRef.current?.abort(), []);

  const toggleAiItem = useCallback(
    (item: TAiDiffItem, checked: boolean) => setAiChecked((current) => ({ ...current, [item.field]: checked })),
    []
  );

  /** Applies the checked suggestions; remembers what they replaced. Returns
   * how many fields changed. */
  const applyAiProposal = useCallback(() => {
    if (!aiDiff) return 0;
    const chosen = aiDiff.items.filter(isAiItemChecked);
    const previous: Record<string, TAiPrevious> = {};
    for (const item of chosen) previous[item.field] = { columns: item.before, source: fieldSources[item.field] };
    writeFields(chosen.map((item) => ({ field: item.field, columns: item.after, source: "ai" as const })));
    setAiHistory(chosen.length ? previous : undefined);
    setAiProposal(undefined);
    setAiChecked({});
    return chosen.length;
  }, [aiDiff, fieldSources, isAiItemChecked, writeFields]);

  const discardAiProposal = useCallback(() => {
    setAiProposal(undefined);
    setAiChecked({});
  }, []);

  /** Restores one field to what it had before the AI. */
  const revertAiField = useCallback(
    (field: string) => {
      const previous = aiHistory?.[field];
      if (!previous) return;
      writeFields([{ field, columns: previous.columns, source: previous.source }]);
      setAiHistory((current) => {
        if (!current) return current;
        const next = { ...current };
        delete next[field];
        return Object.keys(next).length ? next : undefined;
      });
    },
    [aiHistory, writeFields]
  );

  /** Reverts the whole last AI application (also from a toast rendered
   * before it, hence the ref). */
  const undoAiProposal = useCallback(() => {
    const history = latest.current.aiHistory;
    if (!history) return;
    writeFields(
      Object.entries(history).map(([field, previous]) => ({
        field,
        columns: previous.columns,
        source: previous.source,
      }))
    );
    setAiHistory(undefined);
  }, [writeFields]);

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
            keepUnmapped: rules.keepUnmapped,
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
            constants,
            roleMap,
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
      constants,
      roleMap,
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
    constants,
    setConstant,
    fieldSources,
    aiMap,
    cancelAiMap,
    isAiMapping,
    aiStartedAt,
    aiProposal,
    aiDiff,
    isAiItemChecked,
    toggleAiItem,
    applyAiProposal,
    discardAiProposal,
    aiHistory,
    revertAiField,
    undoAiProposal,
    // rules
    rules,
    setRules,
    defaults,
    setDefaults,
    roleMap,
    setTagRole,
    setRoleMap,
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
