/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * Cards for the PDFs the assistant proposes to cut: split one into its
 * documents, merge several, or extract, remove or reorder pages. Nothing is
 * written until the person applies; the originals never change, the new
 * files land in a new folder and are analyzed as contracts (unless the box is
 * cleared), and every change can be undone. No page thumbnails: each part
 * shows its pages, its first line of text and why it was cut there, with a
 * link that opens the original on that page.
 */

import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { makeAssistantToolUI } from "@assistant-ui/react";
import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  Combine,
  FileStack,
  Files,
  Merge,
  Scissors,
  SquareSplitVertical,
  X,
} from "lucide-react";
import { mutate as mutateGlobal } from "swr";
import { useTranslation } from "@plane/i18n";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import { cn } from "@plane/utils";
import { assistantService } from "@/services/assistant.service";
import { CARD, FIELD, Footer, alreadyUndone, errorText, useOutcome } from "./action-cards";
import { AssistantLink } from "./links";
import { TraceLine } from "./steps";

type TDocType = "CONTRATO" | "ADENDUM" | "ANEXO" | "IDENTIFICACION" | "OTRO";

type TSegment = {
  start_page: number;
  end_page: number;
  title?: string;
  doc_type?: TDocType;
  confidence?: number;
  evidence?: string;
  notes?: string[];
  first_line?: string;
};

type TSplitProposal = {
  file_id?: string;
  file_name?: string;
  page_count?: number;
  folder_name?: string;
  view_path?: string;
  segments?: TSegment[];
  workspace_slug?: string;
  error?: string;
};

type TMergeProposal = {
  files?: { id: string; name: string; page_count: number; path: string }[];
  name?: string;
  folder_name?: string;
  workspace_slug?: string;
  error?: string;
};

type TPageOperation = "extract" | "remove" | "reorder";

type TPagesProposal = {
  file_id?: string;
  file_name?: string;
  page_count?: number;
  operation?: TPageOperation;
  pages?: string;
  name?: string;
  folder_name?: string;
  view_path?: string;
  workspace_slug?: string;
  error?: string;
};

/** One part of the split while the person edits it */
type TPart = { key: string; title: string; start_page: number; details: TSegment };

type TPdfResult = {
  folder?: { id: string; name: string };
  files?: { id: string; name: string; pages: number; contract_id?: string | null }[];
  path?: string;
};

/** Below this the card flags the cut for a second look. */
const LOW_CONFIDENCE = 0.6;
const OPERATIONS: TPageOperation[] = ["extract", "remove", "reorder"];

const baseName = (name: string) => name.replace(/\.pdf$/i, "").trim();
const rangeLabel = (start: number, end: number) => (start === end ? `${start}` : `${start}-${end}`);
/** [1, 2, 3, 7] → "1-3, 7" */
const runsLabel = (pages: number[]) => {
  const runs: [number, number][] = [];
  for (const page of pages) {
    const last = runs[runs.length - 1];
    if (last && page === last[1] + 1) last[1] = page;
    else runs.push([page, page]);
  }
  return runs.map(([start, end]) => rangeLabel(start, end)).join(", ");
};
const pageLink = (viewPath: string | undefined, page: number) => (viewPath ? `${viewPath}&page=${page}` : undefined);

/** The library re-reads its files and folders after a change here. */
const refreshLibrary = () =>
  mutateGlobal((key) => typeof key === "string" && /^(FILE_LIBRARY_(FILES|FOLDERS)_|FILE_LINEAGE_)/.test(key));

/** "1-3, 7, 9–12" → [1, 2, 3, 7, 9, 10, 11, 12]; null when a part is not a page. */
export function parsePageList(value: string): number[] | null {
  const pages: number[] = [];
  for (const part of value.split(/[,;\s]+/).filter(Boolean)) {
    const match = /^(\d+)(?:[-–—](\d+))?$/.exec(part);
    if (!match) return null;
    const start = Number(match[1]);
    const end = Number(match[2] ?? match[1]);
    const step = end >= start ? 1 : -1;
    for (let page = start; page !== end + step; page += step) {
      pages.push(page);
      if (pages.length > 1000) return null;
    }
  }
  return pages;
}

/** The pages of the new file, in order, or which rule the choice breaks. */
export function pagesFor(
  operation: TPageOperation,
  pages: number[],
  total: number
): { pages: number[] } | { error: "empty" | "outside" | "nothing_left" | "incomplete" } {
  if (pages.length === 0) return { error: "empty" };
  if (pages.some((page) => page < 1 || page > total)) return { error: "outside" };
  if (operation === "extract") return { pages: [...new Set(pages)].sort((a, b) => a - b) };
  if (operation === "remove") {
    const removed = new Set(pages);
    const kept = Array.from({ length: total }, (_, index) => index + 1).filter((page) => !removed.has(page));
    return kept.length ? { pages: kept } : { error: "nothing_left" };
  }
  const sorted = [...pages].sort((a, b) => a - b);
  if (sorted.length !== total || sorted.some((page, index) => page !== index + 1)) return { error: "incomplete" };
  return { pages };
}

/** Apply and undo for one card, with the outcome kept per tool call. */
function usePdfAction(slug: string, key: string) {
  const { t } = useTranslation();
  const [outcome, remember] = useOutcome(key);
  const apply = async (body: Record<string, unknown>) => {
    remember({ state: "busy" });
    try {
      const action = await assistantService.createAction(slug, body);
      remember({ state: "applied", id: action.id, result: action.result });
      void refreshLibrary();
    } catch (error) {
      remember({ state: "idle" });
      setToast({ type: TOAST_TYPE.ERROR, title: errorText(error, t("assistant.actions.failed")) });
    }
  };
  const undo = async () => {
    if (!outcome.id) return;
    remember({ ...outcome, state: "busy" });
    try {
      await assistantService.undoAction(slug, outcome.id);
      remember({ state: "undone", id: outcome.id });
      void refreshLibrary();
    } catch (error) {
      if (alreadyUndone(error)) remember({ state: "undone", id: outcome.id });
      else {
        remember({ ...outcome, state: "applied" });
        setToast({ type: TOAST_TYPE.ERROR, title: errorText(error, t("assistant.actions.failed")) });
      }
    }
  };
  const busy = outcome.state === "busy";
  const done = outcome.state !== "idle" && outcome.state !== "busy";
  return { outcome, remember, apply, undo, busy, done };
}

/** Destination folder, the analysis box, and the original-stays note. */
function Destination({
  folder,
  onFolder,
  analyze,
  onAnalyze,
  disabled,
}: {
  folder: string;
  onFolder: (value: string) => void;
  analyze: boolean;
  onAnalyze: (value: boolean) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="mt-2.5 space-y-1.5 border-t border-subtle pt-2.5">
      <label className="block">
        <span className="text-11 text-tertiary">{t("assistant.pdf.folder")}</span>
        <input
          value={folder}
          maxLength={240}
          disabled={disabled}
          onChange={(event) => onFolder(event.target.value)}
          className={cn(FIELD, "mt-0.5")}
        />
      </label>
      <label className="flex cursor-pointer items-start gap-1.5 text-12 text-secondary">
        <input
          type="checkbox"
          className="accent-accent-primary mt-0.5"
          checked={analyze}
          disabled={disabled}
          onChange={(event) => onAnalyze(event.target.checked)}
        />
        <span>
          {t("assistant.pdf.analyze")}
          <span className="block text-11 text-tertiary">{t("assistant.pdf.analyze_hint")}</span>
        </span>
      </label>
      <p className="text-11 text-tertiary">{t("assistant.pdf.original_untouched")}</p>
    </div>
  );
}

function DoneLink({ result }: { result?: Record<string, unknown> }) {
  const { t } = useTranslation();
  const path = (result as TPdfResult | undefined)?.path;
  if (!path) return null;
  return (
    <AssistantLink href={path} className="shrink-0 text-12">
      {t("assistant.pdf.open_folder")}
    </AssistantLink>
  );
}

/** What the change created, once applied: the card no longer shows the proposal. */
function CreatedFiles({ slug, result }: { slug: string; result?: Record<string, unknown> }) {
  const { t } = useTranslation();
  const files = (result as TPdfResult | undefined)?.files ?? [];
  return (
    <ul className="mt-2 space-y-0.5">
      {files.map((file) => (
        <li key={file.id} className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-12">
          <FileStack className="size-3.5 shrink-0 text-tertiary" aria-hidden />
          <AssistantLink href={`/${slug}/file-library?preview=${file.id}`} className="min-w-0 flex-1 truncate">
            {file.name}
          </AssistantLink>
          <span className="shrink-0 text-11 text-tertiary">
            {t("assistant.pdf.total_pages", { count: file.pages })}
          </span>
        </li>
      ))}
    </ul>
  );
}

const hasCreated = (outcome: { state: string; result?: Record<string, unknown> }) =>
  outcome.state === "applied" && Boolean((outcome.result as TPdfResult | undefined)?.files?.length);

const doneLabel = (t: (key: string, params?: Record<string, unknown>) => string, result?: Record<string, unknown>) => {
  const data = result as TPdfResult | undefined;
  return t("assistant.pdf.applied", { count: data?.files?.length ?? 0, folder: data?.folder?.name ?? "" });
};

// ------------------------------------------------------------------ split

function ConfidenceBadge({ value }: { value?: number }) {
  const { t } = useTranslation();
  if (value === undefined) return null;
  const low = value < LOW_CONFIDENCE;
  return (
    <span
      className={cn(
        "shrink-0 rounded-sm px-1.5 py-0.5 text-10 tabular-nums",
        low ? "bg-warning-subtle text-warning-primary" : "bg-layer-2 text-tertiary"
      )}
      title={t("assistant.pdf.confidence_hint")}
    >
      {low
        ? t("assistant.pdf.low_confidence", { value: Math.round(value * 100) })
        : t("assistant.pdf.confidence", { value: Math.round(value * 100) })}
    </span>
  );
}

const IconButton = ({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) => (
  <button
    type="button"
    title={label}
    aria-label={label}
    disabled={disabled}
    onClick={onClick}
    className="grid size-6 shrink-0 place-items-center rounded-sm text-tertiary hover:bg-layer-1-hover hover:text-primary disabled:pointer-events-none disabled:opacity-40"
  >
    {children}
  </button>
);

/** A page number that applies when the field is left (or on Enter), so typing
 * "12" doesn't jump the cut at "1". */
function PageInput({
  value,
  total,
  label,
  disabled,
  onCommit,
}: {
  value: number;
  total: number;
  label: string;
  disabled: boolean;
  onCommit: (page: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const page = Number(draft);
    if (Number.isInteger(page) && page >= 1 && page <= total && page !== value) onCommit(page);
    else setDraft(String(value));
  };
  return (
    <input
      inputMode="numeric"
      value={draft}
      disabled={disabled}
      aria-label={label}
      onChange={(event) => setDraft(event.target.value.replace(/\D/g, ""))}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
      }}
      className={cn(FIELD, "w-12 px-1.5 py-0.5 text-center tabular-nums")}
    />
  );
}

/**
 * The parts as cut points: part i runs from starts[i] to the page before
 * starts[i + 1]. Every edit moves a cut, so the parts always cover the PDF
 * once, without gaps or overlaps.
 */
function SplitForm({ proposal, toolCallId }: { proposal: TSplitProposal; toolCallId: string }) {
  const { t } = useTranslation();
  const slug = proposal.workspace_slug!;
  const total = proposal.page_count ?? 0;
  const base = baseName(proposal.file_name ?? "");
  const { outcome, remember, apply, undo, busy, done } = usePdfAction(slug, `assistant-pdf-split:${toolCallId}`);
  const initial = proposal.segments ?? [];
  // Details (title, evidence…) ride with the part, not with its pages
  const [parts, setParts] = useState<TPart[]>(() =>
    initial.map((segment, index) => ({
      key: `s${index}`,
      title: segment.title ?? "",
      start_page: segment.start_page,
      details: segment,
    }))
  );
  const [folder, setFolder] = useState(proposal.folder_name ?? `Separados de ${base}`);
  const [analyze, setAnalyze] = useState(true);

  const ranges = parts.map((part, index) => ({
    part,
    start: part.start_page,
    end: index + 1 < parts.length ? parts[index + 1].start_page - 1 : total,
  }));
  const setTitle = (index: number, title: string) =>
    setParts((current) => {
      const next = [...current];
      next[index] = { ...next[index], title };
      return next;
    });
  const setStart = (index: number, page: number) =>
    setParts((current) => {
      if (index === 0) return current;
      const low = current[index - 1].start_page + 1;
      const high = index + 1 < current.length ? current[index + 1].start_page - 1 : total;
      const next = [...current];
      next[index] = { ...next[index], start_page: Math.min(high, Math.max(low, page)) };
      return next;
    });
  const mergeNext = (index: number) => setParts((current) => current.filter((_, position) => position !== index + 1));
  const splitHalf = (index: number) =>
    setParts((current) => {
      const start = current[index].start_page;
      const end = index + 1 < current.length ? current[index + 1].start_page - 1 : total;
      if (end <= start) return current;
      const middle = start + Math.ceil((end - start + 1) / 2);
      const next = [...current];
      next.splice(index + 1, 0, {
        key: `n${Date.now()}`,
        title: "",
        start_page: middle,
        details: { start_page: middle, end_page: end },
      });
      return next;
    });
  const fileName = (title: string, start: number, end: number) =>
    `${(title.trim() || base).replace(/[\\/]+/g, "-")} (p. ${rangeLabel(start, end)}).pdf`;

  const submit = () =>
    apply({
      kind: "SPLIT_PDF",
      file_id: proposal.file_id,
      segments: ranges.map(({ part, start, end }) => ({
        start_page: start,
        end_page: end,
        name: fileName(part.title, start, end),
      })),
      folder_name: folder,
      analyze,
    });

  return (
    <div className={CARD}>
      <div className="flex items-center gap-2">
        <Scissors className="size-4 shrink-0 text-tertiary" aria-hidden />
        <p className="min-w-0 flex-1 truncate text-13 font-medium text-primary">
          {t("assistant.pdf.split_title", { name: proposal.file_name ?? "" })}
        </p>
        <span className="shrink-0 text-11 text-tertiary">{t("assistant.pdf.total_pages", { count: total })}</span>
      </div>
      {hasCreated(outcome) ? (
        <CreatedFiles slug={slug} result={outcome.result} />
      ) : (
        <>
          <ol className="mt-2 max-h-[28rem] space-y-1.5 overflow-y-auto">
            {ranges.map(({ part, start, end }, index) => (
              <li key={part.key} className="rounded-md border border-subtle px-2 py-1.5">
                <div className="flex items-center gap-1.5 text-12">
                  <span className="w-5 shrink-0 text-11 text-tertiary tabular-nums">{index + 1}.</span>
                  <PageInput
                    value={start}
                    total={total}
                    disabled={done || busy || index === 0}
                    label={t("assistant.pdf.start_page")}
                    onCommit={(page) => setStart(index, page)}
                  />
                  <span className="text-tertiary">–</span>
                  <PageInput
                    value={end}
                    total={total}
                    disabled={done || busy || index === ranges.length - 1}
                    label={t("assistant.pdf.end_page")}
                    onCommit={(page) => setStart(index + 1, page + 1)}
                  />
                  {part.details.doc_type && (
                    <span className="shrink-0 rounded-sm bg-layer-2 px-1.5 py-0.5 text-10 text-secondary">
                      {t(`assistant.pdf.doc_types.${part.details.doc_type}`)}
                    </span>
                  )}
                  <ConfidenceBadge value={index === 0 ? undefined : part.details.confidence} />
                  <span className="ms-auto flex shrink-0 items-center gap-1">
                    <AssistantLink href={pageLink(proposal.view_path, start)} className="text-11">
                      {t("assistant.pdf.view")}
                    </AssistantLink>
                  </span>
                </div>
                <input
                  value={part.title}
                  maxLength={180}
                  disabled={done || busy}
                  placeholder={t("assistant.pdf.title_placeholder")}
                  aria-label={t("assistant.pdf.title_placeholder")}
                  onChange={(event) => setTitle(index, event.target.value)}
                  className={cn(FIELD, "mt-1")}
                />
                <p className="mt-0.5 truncate text-10 text-tertiary" title={fileName(part.title, start, end)}>
                  {fileName(part.title, start, end)}
                </p>
                {part.details.first_line &&
                  part.details.first_line.toLowerCase() !== part.title.trim().toLowerCase() && (
                    <p className="mt-1 truncate text-11 text-secondary italic" title={part.details.first_line}>
                      “{part.details.first_line}”
                    </p>
                  )}
                {part.details.evidence && (
                  <p className="mt-0.5 line-clamp-2 text-11 text-tertiary">
                    {t("assistant.pdf.evidence")}: {part.details.evidence}
                  </p>
                )}
                {part.details.notes?.map((note) => (
                  <p key={note} className="mt-0.5 text-11 text-tertiary">
                    · {note}
                  </p>
                ))}
                {!done && (
                  <div className="mt-1 flex items-center gap-0.5">
                    <IconButton
                      label={t("assistant.pdf.move_cut_earlier")}
                      disabled={busy || index === 0 || start - 1 <= ranges[index - 1].start}
                      onClick={() => setStart(index, start - 1)}
                    >
                      <ChevronLeft className="size-3.5" />
                    </IconButton>
                    <IconButton
                      label={t("assistant.pdf.move_cut_later")}
                      disabled={busy || index === 0 || start + 1 > end}
                      onClick={() => setStart(index, start + 1)}
                    >
                      <ChevronRight className="size-3.5" />
                    </IconButton>
                    <IconButton
                      label={t("assistant.pdf.merge_next")}
                      disabled={busy || index === ranges.length - 1 || ranges.length <= 2}
                      onClick={() => mergeNext(index)}
                    >
                      <Combine className="size-3.5" />
                    </IconButton>
                    <IconButton
                      label={t("assistant.pdf.split_half")}
                      disabled={busy || end <= start || ranges.length >= 50}
                      onClick={() => splitHalf(index)}
                    >
                      <SquareSplitVertical className="size-3.5" />
                    </IconButton>
                  </div>
                )}
              </li>
            ))}
          </ol>
          <Destination
            folder={folder}
            onFolder={setFolder}
            analyze={analyze}
            onAnalyze={setAnalyze}
            disabled={done || busy}
          />
        </>
      )}
      <Footer
        outcome={outcome}
        busy={busy}
        doneLabel={doneLabel(t, outcome.result)}
        extra={<DoneLink result={outcome.result} />}
        applyLabel={t("assistant.pdf.apply_split", { count: ranges.length })}
        disabled={ranges.length < 2 || !folder.trim()}
        onApply={() => void submit()}
        onDiscard={() => remember({ state: "discarded" })}
        onUndo={() => void undo()}
      />
    </div>
  );
}

export const PdfSplitCard = makeAssistantToolUI<Record<string, unknown>, TSplitProposal>({
  toolName: "propose_pdf_split",
  render: function PdfSplitRender({ result, status, toolCallId }) {
    const { t } = useTranslation();
    if (status.type === "running" || !result) {
      return <TraceLine live icon={Scissors} label={t("assistant.steps.propose_pdf_split.running")} />;
    }
    if (result.error || !result.workspace_slug || !result.segments?.length || !result.file_id) {
      return <p className="text-12 text-tertiary">{result.error ?? t("assistant.actions.failed")}</p>;
    }
    return <SplitForm proposal={result} toolCallId={toolCallId} />;
  },
});

// ------------------------------------------------------------------ merge

function MergeForm({ proposal, toolCallId }: { proposal: TMergeProposal; toolCallId: string }) {
  const { t } = useTranslation();
  const slug = proposal.workspace_slug!;
  const { outcome, remember, apply, undo, busy, done } = usePdfAction(slug, `assistant-pdf-merge:${toolCallId}`);
  const [files, setFiles] = useState(proposal.files ?? []);
  const [name, setName] = useState(proposal.name ?? "");
  const [folder, setFolder] = useState(proposal.folder_name ?? `Unidos – ${proposal.name ?? ""}`);
  const [analyze, setAnalyze] = useState(true);
  const totalPages = files.reduce((sum, file) => sum + file.page_count, 0);
  const move = (index: number, offset: number) =>
    setFiles((current) => {
      const next = [...current];
      const [file] = next.splice(index, 1);
      next.splice(index + offset, 0, file);
      return next;
    });

  return (
    <div className={CARD}>
      <div className="flex items-center gap-2">
        <Merge className="size-4 shrink-0 text-tertiary" aria-hidden />
        <p className="min-w-0 flex-1 truncate text-13 font-medium text-primary">
          {t("assistant.pdf.merge_title", { count: files.length })}
        </p>
        <span className="shrink-0 text-11 text-tertiary">{t("assistant.pdf.total_pages", { count: totalPages })}</span>
      </div>
      {hasCreated(outcome) ? (
        <CreatedFiles slug={slug} result={outcome.result} />
      ) : (
        <>
          <ol className="mt-2 space-y-0.5">
            {files.map((file, index) => (
              <li key={file.id} className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-12">
                <span className="w-5 shrink-0 text-11 text-tertiary tabular-nums">{index + 1}.</span>
                <AssistantLink href={file.path} className="min-w-0 flex-1 truncate text-primary">
                  {file.name}
                </AssistantLink>
                <span className="shrink-0 text-11 text-tertiary">
                  {t("assistant.pdf.total_pages", { count: file.page_count })}
                </span>
                {!done && (
                  <>
                    <IconButton
                      label={t("assistant.pdf.move_up")}
                      disabled={busy || index === 0}
                      onClick={() => move(index, -1)}
                    >
                      <ArrowUp className="size-3.5" />
                    </IconButton>
                    <IconButton
                      label={t("assistant.pdf.move_down")}
                      disabled={busy || index === files.length - 1}
                      onClick={() => move(index, 1)}
                    >
                      <ArrowDown className="size-3.5" />
                    </IconButton>
                    <IconButton
                      label={t("assistant.pdf.remove")}
                      disabled={busy || files.length <= 2}
                      onClick={() => setFiles((current) => current.filter((item) => item.id !== file.id))}
                    >
                      <X className="size-3.5" />
                    </IconButton>
                  </>
                )}
              </li>
            ))}
          </ol>
          <label className="mt-2 block">
            <span className="text-11 text-tertiary">{t("assistant.pdf.result_name")}</span>
            <input
              value={name}
              maxLength={180}
              disabled={done || busy}
              onChange={(event) => setName(event.target.value)}
              className={cn(FIELD, "mt-0.5")}
            />
          </label>
          <Destination
            folder={folder}
            onFolder={setFolder}
            analyze={analyze}
            onAnalyze={setAnalyze}
            disabled={done || busy}
          />
        </>
      )}
      <Footer
        outcome={outcome}
        busy={busy}
        doneLabel={doneLabel(t, outcome.result)}
        extra={<DoneLink result={outcome.result} />}
        applyLabel={t("assistant.pdf.apply_merge")}
        disabled={files.length < 2 || !name.trim() || !folder.trim()}
        onApply={() =>
          void apply({
            kind: "MERGE_PDF",
            file_ids: files.map((file) => file.id),
            name: `${baseName(name)}.pdf`,
            folder_name: folder,
            analyze,
          })
        }
        onDiscard={() => remember({ state: "discarded" })}
        onUndo={() => void undo()}
      />
    </div>
  );
}

export const PdfMergeCard = makeAssistantToolUI<Record<string, unknown>, TMergeProposal>({
  toolName: "propose_pdf_merge",
  render: function PdfMergeRender({ result, status, toolCallId }) {
    const { t } = useTranslation();
    if (status.type === "running" || !result) {
      return <TraceLine live icon={Files} label={t("assistant.steps.propose_pdf_merge.running")} />;
    }
    if (result.error || !result.workspace_slug || (result.files?.length ?? 0) < 2) {
      return <p className="text-12 text-tertiary">{result.error ?? t("assistant.actions.failed")}</p>;
    }
    return <MergeForm proposal={result} toolCallId={toolCallId} />;
  },
});

// ------------------------------------------------------------------ pages

function PagesForm({ proposal, toolCallId }: { proposal: TPagesProposal; toolCallId: string }) {
  const { t } = useTranslation();
  const slug = proposal.workspace_slug!;
  const total = proposal.page_count ?? 0;
  const { outcome, remember, apply, undo, busy, done } = usePdfAction(slug, `assistant-pdf-pages:${toolCallId}`);
  const [operation, setOperation] = useState<TPageOperation>(proposal.operation ?? "extract");
  const [pages, setPages] = useState(proposal.pages ?? "");
  // null = the name follows the pages until the person types one
  const [customName, setCustomName] = useState<string | null>(null);
  const [folder, setFolder] = useState(proposal.folder_name ?? "");
  const [analyze, setAnalyze] = useState(true);
  const preview = useMemo(() => {
    const parsed = parsePageList(pages);
    return parsed ? pagesFor(operation, parsed, total) : ({ error: "unreadable" } as const);
  }, [pages, operation, total]);
  const changed = pages !== (proposal.pages ?? "") || operation !== (proposal.operation ?? "extract");
  const automaticName =
    changed && !("error" in preview)
      ? `${baseName(proposal.file_name ?? "")} (páginas ${
          operation === "reorder" ? preview.pages.join(", ") : runsLabel(preview.pages)
        })`
      : (proposal.name ?? "");
  const name = customName ?? automaticName;

  return (
    <div className={CARD}>
      <div className="flex items-center gap-2">
        <FileStack className="size-4 shrink-0 text-tertiary" aria-hidden />
        <p className="min-w-0 flex-1 truncate text-13 font-medium text-primary">
          {t("assistant.pdf.pages_title", { name: proposal.file_name ?? "" })}
        </p>
        <AssistantLink href={proposal.view_path} className="shrink-0 text-11">
          {t("assistant.pdf.view")}
        </AssistantLink>
      </div>
      {hasCreated(outcome) ? (
        <CreatedFiles slug={slug} result={outcome.result} />
      ) : (
        <>
          <div className="mt-2 grid grid-cols-[auto_1fr] gap-1.5">
            <select
              value={operation}
              disabled={done || busy}
              onChange={(event) => setOperation(event.target.value as TPageOperation)}
              aria-label={t("assistant.pdf.operation_label")}
              className={cn(FIELD, "w-auto")}
            >
              {OPERATIONS.map((value) => (
                <option key={value} value={value}>
                  {t(`assistant.pdf.operations.${value}`)}
                </option>
              ))}
            </select>
            <input
              value={pages}
              disabled={done || busy}
              onChange={(event) => setPages(event.target.value)}
              placeholder={t("assistant.pdf.pages_placeholder")}
              aria-label={t("assistant.pdf.pages_placeholder")}
              className={cn(FIELD, "tabular-nums")}
            />
          </div>
          <p className={cn("mt-1 text-11", "error" in preview ? "text-danger-primary" : "text-tertiary")}>
            {"error" in preview
              ? t(`assistant.pdf.page_errors.${preview.error}`, { total })
              : t("assistant.pdf.result_preview", {
                  count: preview.pages.length,
                  pages: preview.pages.slice(0, 60).join(", ") + (preview.pages.length > 60 ? "…" : ""),
                })}
          </p>
          <label className="mt-2 block">
            <span className="text-11 text-tertiary">{t("assistant.pdf.result_name")}</span>
            <input
              value={name}
              maxLength={180}
              disabled={done || busy}
              onChange={(event) => setCustomName(event.target.value)}
              className={cn(FIELD, "mt-0.5")}
            />
          </label>
          <Destination
            folder={folder}
            onFolder={setFolder}
            analyze={analyze}
            onAnalyze={setAnalyze}
            disabled={done || busy}
          />
        </>
      )}
      <Footer
        outcome={outcome}
        busy={busy}
        doneLabel={doneLabel(t, outcome.result)}
        extra={<DoneLink result={outcome.result} />}
        applyLabel={t("assistant.pdf.apply_pages")}
        disabled={"error" in preview || !name.trim() || !folder.trim()}
        onApply={() =>
          void apply({
            kind: "EDIT_PDF_PAGES",
            file_id: proposal.file_id,
            operation,
            pages: "error" in preview ? [] : (parsePageList(pages) ?? []),
            name: `${baseName(name)}.pdf`,
            folder_name: folder,
            analyze,
          })
        }
        onDiscard={() => remember({ state: "discarded" })}
        onUndo={() => void undo()}
      />
    </div>
  );
}

export const PdfPagesCard = makeAssistantToolUI<Record<string, unknown>, TPagesProposal>({
  toolName: "propose_pdf_pages",
  render: function PdfPagesRender({ result, status, toolCallId }) {
    const { t } = useTranslation();
    if (status.type === "running" || !result) {
      return <TraceLine live icon={FileStack} label={t("assistant.steps.propose_pdf_pages.running")} />;
    }
    if (result.error || !result.workspace_slug || !result.file_id) {
      return <p className="text-12 text-tertiary">{result.error ?? t("assistant.actions.failed")}</p>;
    }
    return <PagesForm proposal={result} toolCallId={toolCallId} />;
  },
});
