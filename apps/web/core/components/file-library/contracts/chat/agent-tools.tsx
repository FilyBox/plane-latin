/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * Live trace of what the agent is doing, modelled on assistant-ui's ChatGPT
 * example (`getToolDisplay` + `TraceLine` in their docs app).
 *
 * The shape that makes it readable: one line per tool call, always visible,
 * never behind a disclosure. Each line is a verb in the present tense while
 * the call is in flight ("Buscando contratos") and the past tense once it
 * settles ("2 contratos"), so the run reads as a narrative of work done
 * rather than a spinner. The payload stays available behind the row for when
 * someone wants to audit what was actually queried.
 */

import { useEffect, useRef, useState } from "react";
import { makeAssistantToolUI } from "@assistant-ui/react";
import { ChevronRight, FileSearch, FileText, Layers, ScanText, Tags } from "lucide-react";
// plane imports
import { useTranslation } from "@plane/i18n";
import type { TContractAgentDocument } from "@plane/types";
import { cn } from "@plane/utils";
// local imports
import { ContractDocumentList } from "./document-reference";

/** Elapsed seconds for a call, frozen the moment it stops running. */
function useToolDuration(isRunning: boolean): number | null {
  const startedAt = useRef<number | null>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);

  useEffect(() => {
    if (isRunning) {
      startedAt.current ??= Date.now();
      const timer = setInterval(() => {
        if (startedAt.current) setElapsed((Date.now() - startedAt.current) / 1000);
      }, 250);
      return () => clearInterval(timer);
    }
    if (startedAt.current) setElapsed((Date.now() - startedAt.current) / 1000);
    return undefined;
  }, [isRunning]);

  return elapsed;
}

const formatDuration = (seconds: number) =>
  seconds < 1 ? `${Math.round(seconds * 1000)}ms` : `${seconds.toFixed(1)}s`;

type TraceLineProps = {
  live: boolean;
  icon: typeof FileSearch;
  /** What is happening, as a verb phrase */
  label: string;
  /** What it is happening to */
  detail?: string;
  /** Expandable body (raw-ish payload), shown on click */
  children?: React.ReactNode;
};

/**
 * One row of the trace. Collapsed to a single line by default; the chevron
 * only appears when there is something worth unfolding.
 */
function TraceLine({ live, icon: Icon, label, detail, children }: TraceLineProps) {
  const [open, setOpen] = useState(false);
  const duration = useToolDuration(live);
  const expandable = Boolean(children);

  const row = (
    <span className="flex min-w-0 items-center gap-2 py-0.5 text-11 leading-snug">
      {live ? (
        <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-accent-primary" aria-hidden />
      ) : (
        <Icon className="size-3 shrink-0 text-tertiary" />
      )}
      <span className={cn("shrink-0 font-medium", live ? "text-secondary" : "text-tertiary")}>{label}</span>
      {detail && (
        <span className="min-w-0 flex-1 truncate text-tertiary" title={detail}>
          {detail}
        </span>
      )}
      {duration !== null && !live && (
        <span className="shrink-0 text-10 text-tertiary tabular-nums">{formatDuration(duration)}</span>
      )}
      {expandable && (
        <ChevronRight className={cn("size-3 shrink-0 text-tertiary transition-transform", open && "rotate-90")} />
      )}
    </span>
  );

  if (!expandable) return <div className="min-w-0">{row}</div>;
  return (
    <div className="min-w-0">
      <button type="button" onClick={() => setOpen((value) => !value)} className="w-full text-left hover:opacity-80">
        {row}
      </button>
      {open && <div className="mt-1 mb-1 ml-5 min-w-0 border-l border-subtle pl-2">{children}</div>}
    </div>
  );
}

/** Small key/value list used inside an expanded row. */
function TraceDetails({ rows }: { rows: [string, string][] }) {
  if (rows.length === 0) return null;
  return (
    <dl className="space-y-0.5 text-10 text-tertiary">
      {rows.map(([key, value]) => (
        <div key={key} className="flex min-w-0 gap-1.5">
          <dt className="shrink-0 font-medium">{key}</dt>
          <dd className="min-w-0 break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

const asText = (value: unknown): string =>
  Array.isArray(value) ? value.filter(Boolean).join(", ") : value === undefined || value === null ? "" : String(value);

/** Turns a filter object into "artista: X · año: 2017" for the detail slot. */
function describeFilters(args: Record<string, unknown> | undefined, t: (key: string) => string): string {
  if (!args) return "";
  const parts: string[] = [];
  for (const key of ["names", "artist", "person", "group", "title", "file_name", "tags", "estatus", "tipo"]) {
    const value = asText(args[key]);
    if (value) parts.push(value);
  }
  const period = [args.year, args.month, args.date_from, args.date_to].filter(Boolean).map(String).join("/");
  if (period) parts.push(period);
  return parts.join(" · ") || t("file_library.contracts.chat.tools.all_contracts");
}

type TSearchResult = {
  total: number;
  returned: number;
  has_more: boolean;
  results: { contract_id: string; titulo?: string | null; file_name?: string | null }[];
};

export const FindContractsToolUI = makeAssistantToolUI<Record<string, unknown>, TSearchResult>({
  toolName: "find_contracts",
  render: function FindContractsRender({ args, result, status }) {
    const { t } = useTranslation();
    const live = status.type === "running";
    const filters = describeFilters(args, t);
    return (
      <TraceLine
        live={live}
        icon={FileSearch}
        label={
          live ? t("file_library.contracts.chat.tools.searching") : t("file_library.contracts.chat.tools.searched")
        }
        detail={
          live || !result
            ? filters
            : `${filters} → ${t("file_library.contracts.chat.tools.found", { count: result.total })}`
        }
      >
        {result && (
          <TraceDetails
            rows={(result.results ?? [])
              .slice(0, 8)
              .map((row) => ["·", `${row.titulo || row.file_name || row.contract_id.slice(0, 8)}`])}
          />
        )}
      </TraceLine>
    );
  },
});

export const SearchContractTextToolUI = makeAssistantToolUI<{ query?: string }, { fragments?: unknown[] }>({
  toolName: "search_contract_text",
  render: function SearchTextRender({ args, result, status }) {
    const { t } = useTranslation();
    const live = status.type === "running";
    return (
      <TraceLine
        live={live}
        icon={ScanText}
        label={live ? t("file_library.contracts.chat.tools.reading") : t("file_library.contracts.chat.tools.read")}
        detail={
          live || !result
            ? args?.query
            : `${args?.query ?? ""} → ${t("file_library.contracts.chat.tools.fragments", {
                count: result.fragments?.length ?? 0,
              })}`
        }
      />
    );
  },
});

export const ReadExcerptsToolUI = makeAssistantToolUI<
  { keywords?: string[]; contract_ids?: string[] },
  { results?: { contrato?: string; matched_keywords?: string[]; excerpts?: { text: string }[] }[] }
>({
  toolName: "read_contract_excerpts",
  render: function ReadExcerptsRender({ args, result, status }) {
    const { t } = useTranslation();
    const live = status.type === "running";
    const keywords = (args?.keywords ?? []).join(", ");
    const matches = result?.results?.filter((row) => (row.matched_keywords?.length ?? 0) > 0) ?? [];
    return (
      <TraceLine
        live={live}
        icon={ScanText}
        label={
          live ? t("file_library.contracts.chat.tools.looking_for") : t("file_library.contracts.chat.tools.looked_for")
        }
        detail={
          live || !result
            ? keywords
            : `${keywords} → ${t("file_library.contracts.chat.tools.excerpts_found", { count: matches.length })}`
        }
      >
        {matches.length > 0 && (
          <TraceDetails
            rows={matches
              .slice(0, 6)
              .map((row) => [row.contrato || "·", (row.matched_keywords ?? []).join(", ")] as [string, string])}
          />
        )}
      </TraceLine>
    );
  },
});

export const KnownNamesToolUI = makeAssistantToolUI<
  { filter?: string },
  { artistas?: string[]; grupos?: string[]; involucrados?: string[] }
>({
  toolName: "list_known_names",
  render: function KnownNamesRender({ args, result, status }) {
    const { t } = useTranslation();
    const live = status.type === "running";
    const names = [...(result?.grupos ?? []), ...(result?.artistas ?? [])];
    return (
      <TraceLine
        live={live}
        icon={Tags}
        label={
          live
            ? t("file_library.contracts.chat.tools.resolving_names")
            : t("file_library.contracts.chat.tools.resolved_names")
        }
        detail={
          live || !result
            ? args?.filter
            : names.slice(0, 5).join(", ") || t("file_library.contracts.chat.tools.no_names")
        }
      />
    );
  },
});

export const ContractDetailsToolUI = makeAssistantToolUI<{ contract_ids?: string[] }, { results?: unknown[] }>({
  toolName: "get_contract_details",
  render: function DetailsRender({ args, result, status }) {
    const { t } = useTranslation();
    const live = status.type === "running";
    const count = result?.results?.length ?? args?.contract_ids?.length ?? 0;
    return (
      <TraceLine
        live={live}
        icon={Layers}
        label={
          live
            ? t("file_library.contracts.chat.tools.opening_records")
            : t("file_library.contracts.chat.tools.opened_records")
        }
        detail={t("file_library.contracts.chat.tools.records", { count })}
      />
    );
  },
});

/**
 * Fan-out summariser. Each document was analysed in its own model call, so
 * these lines exist without any of that text having entered the chat context.
 */
export const SummarizeContractsToolUI = makeAssistantToolUI<
  { contract_ids?: string[]; question?: string },
  { question?: string; summaries?: { contract_id: string; contrato: string; summary: string }[] }
>({
  toolName: "summarize_contracts",
  render: function SummarizeRender({ args, result, status }) {
    const { t } = useTranslation();
    const live = status.type === "running";
    const summaries = result?.summaries ?? [];
    return (
      <TraceLine
        live={live}
        icon={Layers}
        label={
          live ? t("file_library.contracts.chat.tools.summarizing") : t("file_library.contracts.chat.tools.summarized")
        }
        detail={
          live
            ? t("file_library.contracts.chat.tools.records", { count: args?.contract_ids?.length ?? 0 })
            : t("file_library.contracts.chat.tools.records", { count: summaries.length })
        }
      >
        {summaries.length > 0 && (
          <ul className="space-y-1">
            {summaries.map((summary) => (
              <li key={summary.contract_id}>
                <p className="truncate text-10 font-medium text-secondary" title={summary.contrato}>
                  {summary.contrato}
                </p>
                <p className="text-10 leading-snug break-words text-tertiary">{summary.summary}</p>
              </li>
            ))}
          </ul>
        )}
      </TraceLine>
    );
  },
});

export const ShowDocumentsToolUI = makeAssistantToolUI<
  Record<string, unknown>,
  { note?: string | null; documents?: TContractAgentDocument[] }
>({
  toolName: "show_documents",
  render: function ShowDocumentsRender({ result, status }) {
    const { t } = useTranslation();
    if (status.type === "running" || !result) {
      return <TraceLine live icon={FileText} label={t("file_library.contracts.chat.tools.preparing_documents")} />;
    }
    return <ContractDocumentList documents={result.documents ?? []} note={result.note} />;
  },
});

/** Every agent tool UI, mounted once by the chat panel */
export function ContractAgentToolUIs() {
  return (
    <>
      <KnownNamesToolUI />
      <FindContractsToolUI />
      <SearchContractTextToolUI />
      <ReadExcerptsToolUI />
      <ContractDetailsToolUI />
      <SummarizeContractsToolUI />
      <ShowDocumentsToolUI />
    </>
  );
}
