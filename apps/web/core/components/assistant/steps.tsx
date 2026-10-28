/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * What the agent is doing, as it does it (after Twenty's ThinkingStepsDisplay):
 * consecutive lookups form one "Trabajando…" block, one human line per tool
 * — a verb while it runs ("Buscando contratos"), what it found once done
 * ("Leyó contratos · 4 de 312 coinciden") — open while the message runs and
 * folded to "3 pasos · 4.2 s" once the answer is in. Each line unfolds into
 * what the tool returned, with links into the app.
 *
 * Action cards (approve a change, review an import, answer a question) are
 * never folded away: a group holding one renders open, without the header.
 */

import { useEffect, useRef, useState } from "react";
import type { PropsWithChildren, ReactNode } from "react";
import { makeAssistantToolUI, useMessage } from "@assistant-ui/react";
import type { PartState } from "@assistant-ui/react";
import { AlertTriangle, Brain, Check, ChevronRight, Loader2, Wrench, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  BarChart3,
  BookText,
  FileSearch,
  FileSpreadsheet,
  FileText,
  FolderSearch,
  ListChecks,
  Layers,
  Link2,
  ListMusic,
  ScanSearch,
  ScanText,
  Search,
  SpellCheck,
  Tags,
} from "lucide-react";
import { useTranslation } from "@plane/i18n";
import type { TEntityName } from "@plane/types";
import { cn } from "@plane/utils";
import { ENTITY_ICONS, entityGroupKey, isEntityName } from "@/components/references/entity-meta";
import { DocumentReference } from "./elements/document-reference";
import { RetrievalChunks } from "./elements/retrieval-chunks";
import type { RetrievalChunk } from "./elements/retrieval-chunks";
import { field, mono, ShimmerLabel } from "./elements/surfaces";
import { AssistantLink } from "./links";

/** Lookups that fold into the steps block; anything else is a card. */
export const TRACE_TOOLS = new Set([
  "list_known_names",
  "find_contracts",
  "search_contract_text",
  "read_contract_excerpts",
  "get_contract_details",
  "summarize_contracts",
  "count_contracts",
  "scan_contracts",
  "query_music_tracks",
  "list_music_files",
  "read_import_file",
  "find_tags",
  "find_by_tag",
  "search_workspace",
  "get_references",
  "search_memory",
  "read_file",
  "read_page",
  "read_deep_review",
  "analyze_pdf_segments",
  "find_contract_templates",
  "read_contract_template",
  "query_work_items",
]);

export const formatDuration = (seconds: number) =>
  seconds < 1 ? `${Math.round(seconds * 1000)} ms` : `${seconds.toFixed(1)} s`;

/** Elapsed seconds while `isRunning`, frozen when it stops; null for
 * messages restored from history (they never ran here). */
function useDuration(isRunning: boolean): number | null {
  const startedAt = useRef<number | null>(isRunning ? Date.now() : null);
  const [elapsed, setElapsed] = useState<number | null>(null);
  useEffect(() => {
    if (isRunning) {
      startedAt.current ??= Date.now();
      const timer = setInterval(() => {
        if (startedAt.current) setElapsed((Date.now() - startedAt.current) / 1000);
      }, 200);
      return () => clearInterval(timer);
    }
    if (startedAt.current) setElapsed((Date.now() - startedAt.current) / 1000);
    return undefined;
  }, [isRunning]);
  return elapsed;
}

// ------------------------------------------------------------- the group

/** True while this message is the one being generated. */
export function useIsMessageRunning(): boolean {
  return useMessage((message) => message.status?.type === "running");
}

/** Groups the turn's thinking: reasoning and every lookup, whatever order
 * they came in, become one block. Action cards stay out of it. */
export const groupThought = (part: PartState): readonly "group-thought"[] | null =>
  part.type === "reasoning" || (part.type === "tool-call" && TRACE_TOOLS.has(part.toolName)) ? ["group-thought"] : null;

/**
 * One block per stretch of thinking, styled after assistant-ui's ToolGroup
 * and RunActivity: while the agent works the header shimmers with what it is
 * doing right now and counts steps done; once the answer starts it folds to
 * "Trabajó 4.2 s" with a check (or how many steps failed), and opens on click.
 */
export function ThinkingBlock({ indices, children }: PropsWithChildren<{ indices: readonly number[] }>) {
  const { t } = useTranslation();
  const last = indices[indices.length - 1] ?? 0;
  // A string, so the selector result compares by value between renders
  const tally = useMessage((message) => {
    let total = 0;
    let done = 0;
    let failed = 0;
    let current = "";
    for (const index of indices) {
      const part = message.content[index];
      if (part?.type !== "tool-call") continue;
      total += 1;
      const result = part.result as { error?: unknown } | undefined;
      if (part.result === undefined) current = part.toolName;
      else if (part.isError || result?.error) failed += 1;
      else done += 1;
    }
    return `${total}|${done}|${failed}|${current}`;
  });
  const [totalText, doneText, failedText, current] = tally.split("|");
  const total = Number(totalText);
  const done = Number(doneText);
  const failed = Number(failedText);
  // The answer has started once a text part follows this block.
  const answered = useMessage((message) =>
    message.content.slice(last + 1).some((part) => part.type === "text" && part.text.trim().length > 0)
  );
  const running = useIsMessageRunning();
  const working = running && !answered;
  const duration = useDuration(working);
  const [open, setOpen] = useState(working);
  useEffect(() => setOpen(working), [working]);

  const activity =
    current && TRACE_TOOLS.has(current) ? t(`assistant.steps.${current}.running`) : t("assistant.steps.working");
  let summary = t("assistant.reasoning");
  if (total > 0) {
    summary =
      duration !== null
        ? t("assistant.steps.worked", { duration: formatDuration(duration) })
        : t("assistant.steps.count", { count: total });
  }

  return (
    <div className="my-1.5 min-w-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-busy={working}
        className="flex w-full min-w-0 items-center gap-1.5 rounded-sm py-0.5 text-left text-12 text-tertiary hover:text-secondary"
      >
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 transition-transform duration-200 motion-reduce:transition-none",
            open && "rotate-90"
          )}
          aria-hidden
        />
        {working ? (
          <ShimmerLabel className="min-w-0 truncate">{activity}</ShimmerLabel>
        ) : (
          <span className="min-w-0 truncate tabular-nums">{summary}</span>
        )}
        {total > 0 && (
          <span className={cn(mono, "ms-auto flex shrink-0 items-center gap-1 tabular-nums")}>
            {working
              ? `${done + failed}/${total}`
              : failed > 0
                ? t("assistant.steps.failed_count", { count: failed })
                : t("assistant.steps.done_count", { count: total })}
            {working ? (
              <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-hidden />
            ) : failed > 0 ? (
              <X className="size-3 text-danger-primary" aria-hidden />
            ) : (
              <Check className="size-3 text-success-primary" aria-hidden />
            )}
          </span>
        )}
      </button>
      {open && (
        <div className="mt-1 ml-1.5 flex min-w-0 animate-fade-in flex-col gap-0.5 border-l border-subtle pl-3">
          {children}
        </div>
      )}
    </div>
  );
}

/** The model's reasoning as one more step of the block, unfoldable. */
export function ReasoningStep({ text }: { text: string }) {
  const { t } = useTranslation();
  const running = useIsMessageRunning();
  if (!text?.trim()) return null;
  return (
    <TraceLine
      live={false}
      icon={Brain}
      label={t("assistant.reasoning")}
      detail={running ? undefined : firstLine(text)}
      showOutcome={false}
    >
      <p className="text-11 leading-snug break-words whitespace-pre-wrap text-tertiary">{text}</p>
    </TraceLine>
  );
}

const firstLine = (text: string) => {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
};

// ------------------------------------------------------------- one line

type TraceLineProps = {
  live: boolean;
  failed?: boolean;
  icon: LucideIcon;
  label: string;
  /** The call's main argument, shown as a chip (assistant-ui ToolCall) */
  chip?: string;
  /** What it found */
  detail?: string;
  /** Check or warning once settled; off for reasoning, which has no outcome */
  showOutcome?: boolean;
  /** Seconds it took, when known from saved data rather than timed here */
  elapsed?: number | null;
  children?: ReactNode;
};

export function TraceLine({
  live,
  failed,
  icon: Icon,
  label,
  chip,
  detail,
  showOutcome = true,
  elapsed,
  children,
}: TraceLineProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const timed = useDuration(live);
  const duration = elapsed ?? timed;
  const expandable = Boolean(children) && !live;

  const row = (
    <span className="flex min-w-0 items-center gap-1.5 py-0.5 text-12 leading-snug">
      {live ? (
        <Loader2 className="size-3.5 shrink-0 animate-spin text-tertiary motion-reduce:animate-none" aria-hidden />
      ) : (
        <Icon className="size-3.5 shrink-0 text-tertiary" aria-hidden />
      )}
      {live ? (
        <ShimmerLabel className="shrink-0 text-secondary">{label}</ShimmerLabel>
      ) : (
        <span className="shrink-0 text-tertiary">
          {label}
          {failed && ` · ${t("assistant.steps.failed")}`}
        </span>
      )}
      {chip && (
        <span
          className={cn(mono, field, "min-w-0 shrink truncate rounded-sm px-1.5 py-0.5 text-secondary")}
          title={chip}
        >
          {chip}
        </span>
      )}
      {detail && (
        <span className="min-w-0 flex-1 truncate text-tertiary" title={detail}>
          {detail}
        </span>
      )}
      <span className="ms-auto flex shrink-0 items-center gap-1">
        {duration !== null && !live && (
          <span className={cn(mono, "text-placeholder tabular-nums")}>{formatDuration(duration)}</span>
        )}
        {!live &&
          showOutcome &&
          (failed ? (
            <AlertTriangle className="size-3 text-danger-primary" aria-hidden />
          ) : (
            <Check className="size-3 animate-fade-in text-success-primary" aria-hidden />
          ))}
        {expandable && (
          <ChevronRight
            className={cn("size-3 text-tertiary transition-transform duration-200", open && "rotate-90")}
            aria-hidden
          />
        )}
      </span>
    </span>
  );

  if (!expandable) return <div className="min-w-0">{row}</div>;
  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="w-full rounded-sm text-left hover:bg-layer-1-hover"
      >
        {row}
      </button>
      {open && <div className="mt-1 mb-1.5 ml-5 min-w-0 animate-fade-in">{children}</div>}
    </div>
  );
}

/** Clickable rows inside an unfolded line. */
export function ResultRows({
  rows,
  more,
}: {
  rows: { key: string; title: string; detail?: string; path?: string; entity?: string }[];
  more?: ReactNode;
}) {
  if (rows.length === 0) return null;
  return (
    <ul className="space-y-0.5">
      {rows.map((row) => {
        const Icon = row.entity && isEntityName(row.entity) ? ENTITY_ICONS[row.entity] : null;
        const body = (
          <>
            {Icon && <Icon className="size-3 shrink-0 text-tertiary" aria-hidden />}
            <span className="min-w-0 truncate text-secondary">{row.title}</span>
            {row.detail && <span className="min-w-0 truncate text-tertiary">{row.detail}</span>}
          </>
        );
        return (
          <li key={row.key} className="text-11">
            {row.path ? (
              <AssistantLink
                href={row.path}
                className="flex min-w-0 items-center gap-1.5 text-secondary hover:no-underline hover:[&>span:first-of-type]:underline"
              >
                {body}
              </AssistantLink>
            ) : (
              <span className="flex min-w-0 items-center gap-1.5">{body}</span>
            )}
          </li>
        );
      })}
      {more && <li className="text-11 text-tertiary">{more}</li>}
    </ul>
  );
}

// ------------------------------------------------------------ tool lines

type TResult = Record<string, unknown> & { error?: string };
type TArgs = Record<string, unknown>;

const text = (value: unknown) =>
  Array.isArray(value) ? value.filter(Boolean).join(", ") : value === undefined || value === null ? "" : String(value);

/** "3BallMTY · 2024 · VIGENTE" from whatever filters the call used. */
function describeArgs(args: TArgs | undefined, keys: string[]): string {
  if (!args) return "";
  return keys
    .map((key) => text(args[key]))
    .filter(Boolean)
    .join(" · ");
}

type TTraceSpec = {
  icon: LucideIcon;
  /** Filters/terms shown while it runs (and before the result) */
  input?: (args: TArgs | undefined) => string;
  /** What it found */
  output?: (result: TResult, t: (key: string, params?: Record<string, unknown>) => string) => string;
  body?: (result: TResult, t: (key: string, params?: Record<string, unknown>) => string) => ReactNode;
};

function traceTool(toolName: string, spec: TTraceSpec) {
  const ToolUI = makeAssistantToolUI<TArgs, TResult>({
    toolName,
    render: function TraceRender({ args, result, status }) {
      const { t } = useTranslation();
      const live = status.type === "running";
      const failed = status.type === "incomplete" || Boolean(result?.error);
      const label = t(`assistant.steps.${toolName}.${live ? "running" : "done"}`);
      const input = spec.input?.(args) ?? "";
      const output = !live && result && !result.error ? spec.output?.(result, t) : undefined;
      return (
        <TraceLine live={live} failed={failed} icon={spec.icon} label={label} chip={input || undefined} detail={output}>
          {!live && result && !result.error ? spec.body?.(result, t) : undefined}
        </TraceLine>
      );
    },
  });
  return { name: toolName, ToolUI };
}

const CONTRACT_FILTER_KEYS = ["names", "artist", "person", "group", "title", "year", "estatus", "tipo", "tags"];
type TContractRow = { contract_id: string; titulo?: string | null; file_name?: string | null };
const contractPath = (slug: string, contractId: string) =>
  `/${slug}/file-library/contracts/analyzed?peek=${contractId}`;
type TFragment = { contract_id: string; contract?: string; similarity?: number; text?: string };
type TExcerpt = { keyword: string; text: string };
type TExcerptRow = { contract_id: string; contrato?: string; excerpts?: TExcerpt[] };
type TScanRow = TContractRow & { matched_keywords?: string[]; excerpts?: TExcerpt[] };
const contractRows = (rows: TContractRow[] | undefined, slug: string) =>
  (rows ?? []).slice(0, 10).map((row) => ({
    key: row.contract_id,
    title: row.titulo || row.file_name || row.contract_id.slice(0, 8),
    path: `/${slug}/file-library/contracts/analyzed?peek=${row.contract_id}`,
    entity: "contract",
  }));

/** The tool lines need the workspace for links; built once per workspace. */
export function buildTraceToolUIs(slug: string) {
  return [
    traceTool("list_known_names", {
      icon: SpellCheck,
      input: (args) => text(args?.filter),
      output: (result) =>
        [...((result.grupos as string[]) ?? []), ...((result.artistas as string[]) ?? [])].slice(0, 4).join(", "),
    }),
    traceTool("find_contracts", {
      icon: FileSearch,
      input: (args) => describeArgs(args, CONTRACT_FILTER_KEYS),
      output: (result, t) => t("assistant.steps.results", { count: Number(result.total ?? 0) }),
      body: (result, t) => (
        <ResultRows
          rows={contractRows(result.results as TContractRow[], slug)}
          more={
            Number(result.total ?? 0) > 10
              ? t("assistant.steps.of_total", { shown: 10, total: Number(result.total) })
              : undefined
          }
        />
      ),
    }),
    traceTool("search_contract_text", {
      icon: ScanText,
      input: (args) => text(args?.query),
      output: (result, t) => t("assistant.steps.fragments", { count: ((result.fragments as unknown[]) ?? []).length }),
      body: (result) => (
        <RetrievalChunks
          chunks={((result.fragments as TFragment[]) ?? []).slice(0, 6).map(
            (fragment, index): RetrievalChunk => ({
              id: `${fragment.contract_id}-${index}`,
              source: fragment.contract || fragment.contract_id.slice(0, 8),
              score: typeof fragment.similarity === "number" ? fragment.similarity : undefined,
              text: fragment.text ?? "",
              path: contractPath(slug, fragment.contract_id),
            })
          )}
        />
      ),
    }),
    traceTool("read_contract_excerpts", {
      icon: BookText,
      input: (args) => text(args?.keywords),
      output: (result, t) =>
        t("assistant.steps.documents", {
          count: ((result.results as { matched_keywords?: string[] }[]) ?? []).filter(
            (row) => (row.matched_keywords?.length ?? 0) > 0
          ).length,
        }),
      body: (result, t) => (
        <div className="flex flex-col gap-1.5">
          {((result.results as TExcerptRow[]) ?? [])
            .filter((row) => (row.excerpts?.length ?? 0) > 0)
            .slice(0, 5)
            .map((row) => (
              <DocumentReference
                key={row.contract_id}
                title={row.contrato || row.contract_id.slice(0, 8)}
                meta={t("assistant.steps.cited", { count: row.excerpts?.length ?? 0 })}
                path={contractPath(slug, row.contract_id)}
                anchors={(row.excerpts ?? []).slice(0, 3).map((excerpt) => ({
                  label: excerpt.keyword,
                  quote: excerpt.text,
                }))}
              />
            ))}
        </div>
      ),
    }),
    traceTool("find_contract_works", {
      icon: ListMusic,
      input: (args) => text(args?.question),
      // Saved links first; a re-read also lists the works found in the text
      output: (result, t) =>
        t("assistant.steps.find_contract_works.summary", {
          works: ((result.works as unknown[]) ?? []).length,
          links: ((result.links as unknown[]) ?? []).length,
        }),
    }),
    traceTool("get_track_contracts", {
      icon: FileSearch,
      output: (result, t) => t("assistant.steps.results", { count: ((result.links as unknown[]) ?? []).length }),
      body: (result) => (
        <ResultRows
          rows={(
            (result.links as {
              id: string;
              contract?: { id: string; titulo?: string | null; file_name?: string | null };
            }[]) ?? []
          )
            .filter((link) => link.contract)
            .slice(0, 10)
            .map((link) => ({
              key: link.id,
              title: link.contract!.titulo || link.contract!.file_name || link.contract!.id.slice(0, 8),
              path: contractPath(slug, link.contract!.id),
              entity: "contract",
            }))}
        />
      ),
    }),
    traceTool("get_contract_details", {
      icon: Layers,
      output: (result, t) => t("assistant.steps.documents", { count: ((result.results as unknown[]) ?? []).length }),
      body: (result) => <ResultRows rows={contractRows(result.results as TContractRow[], slug)} />,
    }),
    traceTool("summarize_contracts", {
      icon: Layers,
      output: (result, t) => t("assistant.steps.documents", { count: ((result.summaries as unknown[]) ?? []).length }),
      body: (result, t) => (
        <div className="flex flex-col gap-1.5">
          {((result.summaries as { contract_id: string; contrato?: string; summary: string }[]) ?? [])
            .slice(0, 8)
            .map((summary) => (
              <DocumentReference
                key={summary.contract_id}
                title={summary.contrato || summary.contract_id.slice(0, 8)}
                meta={t("assistant.steps.summary_label")}
                path={contractPath(slug, summary.contract_id)}
                anchors={[{ label: String(result.question ?? ""), quote: summary.summary }]}
              />
            ))}
        </div>
      ),
    }),
    traceTool("count_contracts", {
      icon: BarChart3,
      input: (args) => [text(args?.group_by), describeArgs(args, CONTRACT_FILTER_KEYS)].filter(Boolean).join(" · "),
      output: (result, t) =>
        t("assistant.steps.groups", {
          count: ((result.buckets as unknown[]) ?? []).length,
          total: Number(result.total ?? 0),
        }),
      body: (result) => <Buckets buckets={(result.buckets as { value: unknown; count: number }[]) ?? []} />,
    }),
    traceTool("scan_contracts", {
      icon: ScanText,
      input: (args) => [text(args?.keywords), describeArgs(args, CONTRACT_FILTER_KEYS)].filter(Boolean).join(" · "),
      output: (result, t) =>
        t("assistant.steps.scan", { matched: Number(result.matched ?? 0), scanned: Number(result.scanned ?? 0) }),
      body: (result) => (
        <RetrievalChunks
          chunks={((result.results as TScanRow[]) ?? []).slice(0, 8).map(
            (row): RetrievalChunk => ({
              id: row.contract_id,
              source: row.titulo || row.file_name || row.contract_id.slice(0, 8),
              locator: (row.matched_keywords ?? []).join(" + "),
              text: (row.excerpts ?? []).map((excerpt) => excerpt.text).join(" … "),
              path: contractPath(slug, row.contract_id),
            })
          )}
        />
      ),
    }),
    traceTool("query_music_tracks", {
      icon: ListMusic,
      input: (args) => describeArgs(args, ["artist_name", "search", "year", "isrc", "status"]),
      output: (result, t) => t("assistant.steps.results", { count: Number(result.total ?? 0) }),
      body: (result, t) => (
        <ResultRows
          rows={((result.results as { id: string; title: string; artists?: string; path?: string }[]) ?? [])
            .slice(0, 10)
            .map((row) => ({
              key: row.id,
              title: row.title,
              detail: row.artists,
              path: row.path,
              entity: "music_track",
            }))}
          more={
            Number(result.total ?? 0) > 10
              ? t("assistant.steps.of_total", { shown: 10, total: Number(result.total) })
              : undefined
          }
        />
      ),
    }),
    traceTool("list_music_files", {
      icon: FolderSearch,
      input: (args) => text(args?.search),
      output: (result, t) => t("assistant.steps.results", { count: ((result.results as unknown[]) ?? []).length }),
    }),
    traceTool("read_import_file", {
      icon: FileSpreadsheet,
      input: () => "",
      output: (result, t) =>
        `${text(result.file_name)} · ${t("assistant.steps.file", {
          rows: Number(result.total_rows ?? 0),
          columns: ((result.columns as unknown[]) ?? []).length,
        })}`,
    }),
    traceTool("find_tags", {
      icon: Tags,
      input: (args) => text(args?.query),
      output: (result, t) => t("assistant.steps.tags", { count: ((result.results as unknown[]) ?? []).length }),
      body: (result) => (
        <ResultRows
          rows={((result.results as { id: string; name: string; usage?: number }[]) ?? []).slice(0, 8).map((tag) => ({
            key: tag.id,
            title: tag.name,
            detail: tag.usage ? String(tag.usage) : undefined,
            path: `/${slug}/tags/${tag.id}`,
          }))}
        />
      ),
    }),
    traceTool("find_by_tag", {
      icon: Tags,
      input: (args) => describeArgs(args, ["tag", "query", "date_from", "date_to"]),
      output: (result, t) => {
        const groups = (result.groups as Record<string, { count: number }>) ?? {};
        return t("assistant.steps.results", {
          count: Object.values(groups).reduce((sum, group) => sum + (group.count ?? 0), 0),
        });
      },
      body: (result, t) => <TaggedGroups result={result} t={t} />,
    }),
    traceTool("search_workspace", {
      icon: Search,
      input: (args) => text(args?.query),
      output: (result, t) => {
        const groups = (result.results as Record<string, unknown[]>) ?? {};
        return t("assistant.steps.results", {
          count: Object.values(groups).reduce((sum, rows) => sum + rows.length, 0),
        });
      },
      body: (result) => (
        <ResultRows
          rows={Object.entries((result.results as Record<string, TCard[]>) ?? {}).flatMap(([name, cards]) =>
            cards.slice(0, 4).map((card) => cardRow(card, name))
          )}
        />
      ),
    }),
    traceTool("get_references", {
      icon: Link2,
      output: (result, t) =>
        t("assistant.steps.references", {
          refs: ((result.references as unknown[]) ?? []).length,
          backlinks: ((result.referenced_by as unknown[]) ?? []).length,
        }),
      body: (result) => (
        <ResultRows
          rows={[...((result.references as TCard[]) ?? []), ...((result.referenced_by as TCard[]) ?? [])]
            .slice(0, 10)
            .map((card) => cardRow(card, card.entity_name))}
        />
      ),
    }),
    traceTool("read_file", {
      icon: FileText,
      input: (args) => text(args?.question),
      output: (result, t) =>
        t("assistant.steps.file_read", {
          name: String(result.name ?? ""),
          pages: Number(result.pages ?? 0),
        }),
    }),
    traceTool("read_page", {
      icon: FileText,
      output: (result) => String(result.name ?? ""),
    }),
    traceTool("find_contract_templates", {
      icon: FileText,
      input: (args) => text(args?.query),
      output: (result, t) => t("assistant.steps.results", { count: ((result.templates as unknown[]) ?? []).length }),
    }),
    traceTool("read_contract_template", {
      icon: FileText,
      output: (result) => {
        const base = (result.base as { template_name?: string; variant_name?: string }) ?? {};
        return [base.template_name, base.variant_name].filter(Boolean).join(" · ");
      },
    }),
    traceTool("query_work_items", {
      icon: ListChecks,
      input: (args) => text(args?.project ?? args?.assignee ?? args?.text),
      output: (result, t) => t("assistant.steps.results", { count: Number(result.total ?? 0) }),
    }),
    traceTool("analyze_pdf_segments", {
      icon: ScanText,
      input: (args) => text(args?.instructions),
      output: (result, t) =>
        t("assistant.steps.pdf_segments", {
          name: String(result.name ?? ""),
          documents: ((result.segments as unknown[]) ?? []).length,
          pages: Number(result.page_count ?? 0),
        }),
      body: (result) => (
        <ResultRows
          rows={(
            (result.segments as { start_page: number; end_page: number; title?: string; doc_type?: string }[]) ?? []
          ).map((segment) => ({
            key: String(segment.start_page),
            title: `${segment.start_page}–${segment.end_page} · ${segment.title || segment.doc_type || ""}`,
          }))}
        />
      ),
    }),
    traceTool("read_deep_review", {
      icon: ScanSearch,
      output: (result, t) =>
        t("assistant.steps.deep_review_rows", { count: ((result.results as unknown[]) ?? []).length }),
    }),
    traceTool("search_memory", {
      icon: Brain,
      input: (args) => text(args?.query),
      output: (result, t) => t("assistant.steps.memories", { count: ((result.results as unknown[]) ?? []).length }),
      body: (result) => (
        <ResultRows
          rows={((result.results as { id: string; content: string; kind: string }[]) ?? []).map((memory) => ({
            key: memory.id,
            title: memory.content,
          }))}
        />
      ),
    }),
  ];
}

type TCard = { entity_name: string; id: string; title?: string; subtitle?: string; path?: string };
const cardRow = (card: TCard, name: string) => ({
  key: `${name}:${card.id}`,
  title: card.title ?? card.id,
  detail: card.subtitle,
  path: card.path,
  entity: name,
});

function TaggedGroups({ result, t }: { result: TResult; t: (key: string) => string }) {
  const groups = (result.groups as Record<string, { count: number; items: TCard[] }>) ?? {};
  const link = typeof result.link === "string" ? result.link : undefined;
  return (
    <div className="space-y-1.5">
      {Object.entries(groups).map(([name, group]) => (
        <div key={name}>
          <p className="text-11 font-medium text-tertiary">
            {isEntityName(name) ? t(entityGroupKey(name as TEntityName)) : name} · {group.count}
          </p>
          <ResultRows rows={group.items.slice(0, 5).map((card) => cardRow(card, name))} />
        </div>
      ))}
      {link && (
        <AssistantLink href={link} className="text-11">
          {(result.tag as { name?: string })?.name ?? link}
        </AssistantLink>
      )}
    </div>
  );
}

/** Group counts as small horizontal bars. */
function Buckets({ buckets }: { buckets: { value: unknown; count: number }[] }) {
  const max = Math.max(1, ...buckets.map((bucket) => bucket.count));
  return (
    <ul className="space-y-0.5">
      {buckets.slice(0, 12).map((bucket) => (
        <li key={String(bucket.value)} className="grid grid-cols-[minmax(0,8rem)_1fr_auto] items-center gap-2 text-11">
          <span className="truncate text-secondary">
            {bucket.value === null || bucket.value === "" ? "—" : String(bucket.value)}
          </span>
          <span className="h-1.5 rounded-full bg-layer-3">
            <span
              className="block h-full rounded-full bg-accent-primary/60"
              style={{ width: `${(bucket.count / max) * 100}%` }}
            />
          </span>
          <span className="text-tertiary tabular-nums">{bucket.count}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Tools without a dedicated line still read as a step (assistant-ui's
 * ToolFallback): the tool's name as the chip, unfolding to the raw request
 * and result.
 */
export function FallbackStep({
  toolName,
  status,
  argsText,
  result,
}: {
  toolName: string;
  status: { type: string };
  argsText?: string;
  result?: unknown;
}) {
  const { t } = useTranslation();
  const live = status.type === "running";
  const resultText = result === undefined ? "" : typeof result === "string" ? result : JSON.stringify(result, null, 2);
  return (
    <TraceLine
      live={live}
      failed={status.type === "incomplete"}
      icon={Wrench}
      label={t(`assistant.steps.fallback.${live ? "running" : "done"}`)}
      chip={toolName.replace(/_/g, " ")}
    >
      {argsText || resultText ? (
        <div className={cn(field, "overflow-hidden rounded-md text-11")}>
          {argsText && (
            <div className="px-2.5 pt-2 pb-1.5">
              <p className={cn(mono, "mb-0.5 text-tertiary")}>{t("assistant.steps.request")}</p>
              <pre className="font-mono max-h-40 overflow-auto break-words whitespace-pre-wrap text-tertiary">
                {argsText}
              </pre>
            </div>
          )}
          {argsText && resultText && <div className="mx-2.5 h-px bg-layer-3" />}
          {resultText && (
            <div className="px-2.5 pt-1.5 pb-2">
              <p className={cn(mono, "mb-0.5 text-tertiary")}>{t("assistant.steps.result")}</p>
              <pre className="font-mono max-h-40 overflow-auto break-words whitespace-pre-wrap text-secondary">
                {resultText.slice(0, 4000)}
              </pre>
            </div>
          )}
        </div>
      ) : undefined}
    </TraceLine>
  );
}
