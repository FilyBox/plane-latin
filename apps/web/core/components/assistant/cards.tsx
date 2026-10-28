/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * Cards for the moments the user acts: download, review an import, approve a
 * change, answer a question. The agent never writes; a card applies through
 * the user's own session after they approve (Twenty's approval cards).
 */

import { useMemo, useState } from "react";
import { makeAssistantToolUI } from "@assistant-ui/react";
import {
  ArrowRight,
  Check,
  Download,
  FileSpreadsheet,
  Loader2,
  MessageCircleQuestion,
  PencilLine,
  X,
} from "lucide-react";
import { useParams } from "react-router";
import { mutate as mutateGlobal } from "swr";
import { EUserPermissions, EUserPermissionsLevel } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import type { TContractAgentDocument, TMusicFilters } from "@plane/types";
import { cn } from "@plane/utils";
import {
  ContractDocumentContext,
  ContractDocumentList,
} from "@/components/file-library/contracts/chat/document-reference";
import { importDraftKey } from "@/components/music-catalog/import/constants";
import { useUserPermissions } from "@/hooks/store/user";
import { musicService } from "@/services/music.service";
import { Footer, useOutcome } from "./action-cards";
import { UndoConflicts, useCardActions } from "./card-kit";
import { AssistantLink, useAssistantNavigate } from "./links";
import { TraceLine } from "./steps";

const CARD = "min-w-0 rounded-lg border border-subtle bg-layer-1 p-3";

// ---------------------------------------------------------------- export

export const ExportMusicExcelCard = makeAssistantToolUI<
  Record<string, unknown>,
  { count?: number; params?: Record<string, string>; workspace_slug?: string; error?: string }
>({
  toolName: "export_music_excel",
  render: function ExportRender({ result, status }) {
    const { t } = useTranslation();
    const [busy, setBusy] = useState(false);
    if (status.type === "running" || !result) {
      return <TraceLine live icon={FileSpreadsheet} label={t("assistant.steps.export_music_excel.running")} />;
    }
    if (result.error || !result.workspace_slug) return null;
    const download = async () => {
      setBusy(true);
      try {
        await musicService.downloadReport(
          result.workspace_slug!,
          "filtered",
          "xlsx",
          (result.params ?? {}) as TMusicFilters
        );
      } finally {
        setBusy(false);
      }
    };
    return (
      <div className={cn(CARD, "flex items-center gap-3")}>
        <FileSpreadsheet className="size-5 shrink-0 text-success-primary" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-13 font-medium text-primary">{t("assistant.export.title")}</p>
          <p className="text-12 text-tertiary">{t("assistant.export.body", { count: result.count ?? 0 })}</p>
        </div>
        <Button variant="secondary" size="sm" loading={busy} onClick={() => void download()}>
          <Download className="size-3.5" />
          {t("assistant.export.download")}
        </Button>
      </div>
    );
  },
});

// ---------------------------------------------------------------- import

type TImportPlan = {
  asset_id: string;
  sheet?: string | null;
  mapping: Record<string, string | string[]>;
  dedupe_by: string;
  duplicate_strategy: "skip" | "update";
  reason?: string;
  summary: Record<string, number>;
  first_errors?: { row?: number; message?: string }[];
  workspace_slug: string;
  error?: string;
};

const SUMMARY_ORDER = ["created", "updated", "unchanged", "skipped", "errors", "possible_duplicates"] as const;

export const PlanMusicImportCard = makeAssistantToolUI<Record<string, unknown>, TImportPlan>({
  toolName: "plan_music_import",
  render: function PlanRender({ result, status }) {
    const { t } = useTranslation();
    const navigate = useAssistantNavigate();
    const { allowPermissions } = useUserPermissions();
    const isAdmin = allowPermissions([EUserPermissions.ADMIN], EUserPermissionsLevel.WORKSPACE);
    if (status.type === "running" || !result) {
      return <TraceLine live icon={FileSpreadsheet} label={t("assistant.steps.plan_music_import.running")} />;
    }
    if (result.error || !result.summary) return null;

    const mapping = Object.entries(result.mapping ?? {});
    const review = () => {
      // The importer opens the file with its last run's rules; this plan
      // replaces them so the user starts from what the assistant decided.
      try {
        sessionStorage.setItem(
          importDraftKey(result.asset_id),
          JSON.stringify({
            mapping: result.mapping,
            sheet: result.sheet,
            dedupe_by: result.dedupe_by,
            duplicate_strategy: result.duplicate_strategy,
          })
        );
      } catch {
        // Without storage the importer still opens the file with its heuristics.
      }
      navigate(`/${result.workspace_slug}/music/import?asset=${result.asset_id}`);
    };

    return (
      <div className={CARD}>
        <div className="flex items-center gap-2">
          <FileSpreadsheet className="size-4 shrink-0 text-tertiary" aria-hidden />
          <p className="min-w-0 flex-1 truncate text-13 font-medium text-primary">{t("assistant.import_plan.title")}</p>
          <span className="shrink-0 text-12 text-tertiary">
            {t("assistant.import_plan.rows", { count: result.summary.total ?? 0 })}
          </span>
        </div>
        <dl className="mt-2.5 grid grid-cols-3 gap-1.5">
          {SUMMARY_ORDER.filter((key) => (result.summary[key] ?? 0) > 0 || key === "created").map((key) => (
            <div key={key} className="rounded-md bg-layer-2 px-2 py-1.5">
              <dt className="truncate text-11 text-tertiary">{t(`assistant.import_plan.${key}`)}</dt>
              <dd
                className={cn(
                  "text-14 font-semibold tabular-nums",
                  key === "errors" ? "text-danger-primary" : "text-primary"
                )}
              >
                {result.summary[key] ?? 0}
              </dd>
            </div>
          ))}
        </dl>
        {mapping.length > 0 && (
          <div className="mt-2.5">
            <p className="text-11 text-tertiary">{t("assistant.import_plan.mapping")}</p>
            <div className="mt-1 flex flex-wrap gap-1">
              {mapping.slice(0, 6).map(([field, column]) => (
                <span
                  key={field}
                  className="inline-flex max-w-full items-center gap-1 rounded-sm border border-subtle px-1.5 py-0.5 text-11"
                >
                  <span className="truncate text-secondary">{Array.isArray(column) ? column.join(" + ") : column}</span>
                  <ArrowRight className="size-2.5 shrink-0 text-tertiary" aria-hidden />
                  <span className="truncate text-tertiary">{field.replace(/^track\./, "")}</span>
                </span>
              ))}
              {mapping.length > 6 && (
                <span className="px-1 text-11 text-tertiary">
                  {t("assistant.import_plan.more", { count: mapping.length - 6 })}
                </span>
              )}
            </div>
          </div>
        )}
        {(result.first_errors?.length ?? 0) > 0 && (
          <div className="mt-2.5">
            <p className="text-11 text-tertiary">{t("assistant.import_plan.first_errors")}</p>
            <ul className="mt-1 space-y-0.5">
              {result.first_errors!.map((error) => (
                <li
                  key={`${error.row ?? ""}:${error.message ?? ""}`}
                  className="truncate text-11 text-secondary"
                  title={error.message}
                >
                  {error.row ? `${t("assistant.import_plan.row", { row: error.row })} · ` : ""}
                  {error.message}
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="mt-2.5 text-11 text-tertiary">
          {isAdmin ? t("assistant.import_plan.note") : t("assistant.import_plan.admin_only")}
        </p>
        {isAdmin && (
          <Button variant="primary" size="sm" className="mt-2 w-full" onClick={review}>
            {t("assistant.import_plan.review")}
            <ArrowRight className="size-3.5" />
          </Button>
        )}
      </div>
    );
  },
});

// ---------------------------------------------------------------- update

type TUpdateResult = {
  track_id?: string;
  title?: string;
  artists?: string;
  path?: string;
  before?: Record<string, unknown>;
  changes?: Record<string, string>;
  workspace_slug?: string;
  error?: string;
  matches?: { id: string; title: string; isrc?: string; artists?: string }[];
};

const CHANGE_FIELDS = [
  "release_date",
  "original_release_date",
  "isrc",
  "video_url",
  "video_release_date",
  "video_isrc",
] as const;

/** A song change the user asked for: a CATALOG_FIXES action, undoable. */
function UpdateTrackForm({ result, toolCallId }: { result: TUpdateResult; toolCallId: string }) {
  const { t } = useTranslation();
  const slug = result.workspace_slug!;
  const [outcome, remember, meta] = useOutcome(`assistant-update-track:${toolCallId}`);
  const { apply, undo } = useCardActions(slug, outcome, remember, meta);
  // Cards applied before changes had undo kept only this marker
  const [legacy] = useState(() => {
    try {
      return sessionStorage.getItem(`assistant-update:${toolCallId}`);
    } catch {
      return null;
    }
  });
  const changes = result.changes ?? {};
  const before = result.before ?? {};
  const busy = outcome.state === "busy";

  const run = async () => {
    const fields: Record<string, string> = {};
    for (const key of ["release_date", "original_release_date", "isrc"] as const) {
      if (changes[key]) fields[key] = changes[key];
    }
    const action = await apply({
      kind: "CATALOG_FIXES",
      items: [
        {
          entity: "music_track",
          id: result.track_id,
          changes: fields,
          add_video: changes.video_url
            ? { video_url: changes.video_url, release_date: changes.video_release_date, isrc: changes.video_isrc }
            : undefined,
          source: t("assistant.update.source_user"),
          source_type: "user",
        },
      ],
    });
    if (action)
      void mutateGlobal((key) => typeof key === "string" && key.startsWith("MUSIC_"), undefined, { revalidate: true });
  };

  return (
    <div className={CARD}>
      <div className="flex items-center gap-2">
        <PencilLine className="size-4 shrink-0 text-tertiary" aria-hidden />
        <p className="min-w-0 flex-1 truncate text-13 font-medium text-primary">{t("assistant.update.title")}</p>
      </div>
      <p className="mt-1 truncate text-12">
        {result.path ? <AssistantLink href={result.path}>{result.title}</AssistantLink> : result.title}
        {result.artists && <span className="text-tertiary"> · {result.artists}</span>}
      </p>
      <table className="mt-2 w-full text-12">
        <thead>
          <tr className="text-left text-11 text-tertiary">
            <th className="font-normal py-1 pr-2">{t("assistant.update.field")}</th>
            <th className="font-normal py-1 pr-2">{t("assistant.update.before")}</th>
            <th className="font-normal py-1">{t("assistant.update.after")}</th>
          </tr>
        </thead>
        <tbody>
          {CHANGE_FIELDS.filter((key) => changes[key]).map((key) => (
            <tr key={key} className="border-t border-subtle align-top">
              <td className="py-1 pr-2 whitespace-nowrap text-tertiary">{t(`assistant.update.fields.${key}`)}</td>
              <td className="py-1 pr-2 break-all text-tertiary line-through decoration-1">
                {key.startsWith("video") ? "—" : String(before[key] ?? "—")}
              </td>
              <td className="py-1 break-all text-primary">{changes[key]}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {changes.video_url && <p className="mt-1.5 text-11 text-tertiary">{t("assistant.update.video_added")}</p>}
      <UndoConflicts outcome={outcome} label={(field) => t(`assistant.update.fields.${field}`)} />
      {legacy === "applied" || legacy === "discarded" ? (
        <p className="mt-2.5 flex items-center gap-1.5 text-12 text-tertiary">
          {legacy === "applied" ? <Check className="size-3.5" /> : <X className="size-3.5" />}
          {t(legacy === "applied" ? "assistant.update.applied" : "assistant.update.discarded")}
        </p>
      ) : (
        <Footer
          outcome={outcome}
          busy={busy}
          doneLabel={t("assistant.update.applied")}
          applyLabel={t("assistant.update.approve")}
          onApply={() => void run()}
          onDiscard={() => remember({ state: "discarded" })}
          onUndo={() => void undo()}
        />
      )}
    </div>
  );
}

export const UpdateMusicTrackCard = makeAssistantToolUI<Record<string, unknown>, TUpdateResult>({
  toolName: "update_music_track",
  render: function UpdateRender({ result, status, toolCallId }) {
    const { t } = useTranslation();
    const { workspaceSlug } = useParams();
    if (status.type === "running" || !result) {
      return <TraceLine live icon={PencilLine} label={t("assistant.steps.update_music_track.running")} />;
    }
    if (result.matches && result.matches.length > 0) {
      return (
        <div className={CARD}>
          <p className="text-12 font-medium text-primary">{t("assistant.update.multiple")}</p>
          <ul className="mt-1.5 space-y-0.5">
            {result.matches.map((match) => (
              <li key={match.id} className="text-12">
                <AssistantLink href={`/${workspaceSlug}/music?track=${match.id}`}>{match.title}</AssistantLink>
                <span className="text-tertiary"> {[match.artists, match.isrc].filter(Boolean).join(" · ")}</span>
              </li>
            ))}
          </ul>
        </div>
      );
    }
    if (result.error || !result.track_id || !result.workspace_slug) {
      return <p className="text-12 text-tertiary">{result.error ?? t("assistant.update.not_found")}</p>;
    }
    return <UpdateTrackForm result={result} toolCallId={toolCallId} />;
  },
});

// ------------------------------------------------------------------- ask

export const AskUserCard = makeAssistantToolUI<
  { question?: string; options?: string[]; context?: string },
  { answer?: string }
>({
  toolName: "ask_user",
  render: function AskRender({ args, result, addResult, status }) {
    const { t } = useTranslation();
    const [other, setOther] = useState("");
    const answered = result?.answer;
    const answer = (value: string) => {
      if (!value.trim()) return;
      addResult({ answer: value.trim() });
    };
    return (
      <div className={CARD}>
        <p className="flex items-start gap-2 text-13 text-primary">
          <MessageCircleQuestion className="mt-0.5 size-4 shrink-0 text-accent-primary" aria-hidden />
          <span className="min-w-0 break-words">{args?.question}</span>
        </p>
        {args?.context && <p className="mt-1 ml-6 text-12 text-tertiary">{args.context}</p>}
        {answered ? (
          <p className="mt-2 ml-6 text-12 text-secondary">{t("assistant.ask.answered", { answer: answered })}</p>
        ) : status.type === "running" ? (
          <Loader2 className="mt-2 ml-6 size-3.5 animate-spin text-tertiary" />
        ) : (
          <div className="mt-2 ml-6 space-y-2">
            {(args?.options?.length ?? 0) > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {args!.options!.map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => answer(option)}
                    className="rounded-md border border-subtle px-2.5 py-1 text-12 text-secondary hover:border-accent-strong hover:text-accent-primary"
                  >
                    {option}
                  </button>
                ))}
              </div>
            )}
            <form
              className="flex gap-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                answer(other);
              }}
            >
              <input
                value={other}
                onChange={(event) => setOther(event.target.value)}
                placeholder={t("assistant.ask.other")}
                aria-label={t("assistant.ask.other")}
                className="h-7 min-w-0 flex-1 rounded-md border border-subtle bg-transparent px-2 text-12 outline-none focus:border-accent-strong"
              />
              <Button type="submit" variant="secondary" size="sm" disabled={!other.trim()}>
                {t("assistant.ask.send")}
              </Button>
            </form>
          </div>
        )}
      </div>
    );
  },
});

// --------------------------------------------------------------- documents

export const ShowDocumentsCard = makeAssistantToolUI<
  Record<string, unknown>,
  { note?: string | null; documents?: TContractAgentDocument[] }
>({
  toolName: "show_documents",
  render: function DocumentsRender({ result, status }) {
    const { t } = useTranslation();
    const { workspaceSlug } = useParams();
    const navigate = useAssistantNavigate();
    const documentContext = useMemo(
      () => ({
        workspaceSlug: String(workspaceSlug),
        onOpenContract: (contractId: string) =>
          navigate(`/${workspaceSlug}/file-library/contracts/analyzed?peek=${contractId}`),
      }),
      [workspaceSlug, navigate]
    );
    if (status.type === "running" || !result) {
      return <TraceLine live icon={FileSpreadsheet} label={t("assistant.steps.show_documents.running")} />;
    }
    return (
      <ContractDocumentContext.Provider value={documentContext}>
        <ContractDocumentList documents={result.documents ?? []} note={result.note} />
      </ContractDocumentContext.Provider>
    );
  },
});
