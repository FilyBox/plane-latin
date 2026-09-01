/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * Tool UIs for the contracts agent. Each tool the Worker exposes gets a row
 * that says what the agent is doing and what it found, so the run reads as
 * work being done rather than a spinner — and `show_documents` renders the
 * clickable citation cards.
 */

import { makeAssistantToolUI } from "@assistant-ui/react";
import { CalendarSearch, FileSearch, Layers, ScanText, Tags } from "lucide-react";
// plane imports
import { useTranslation } from "@plane/i18n";
import type { TContractAgentDocument } from "@plane/types";
// local imports
import { ContractDocumentList } from "./document-reference";

const ROW = "my-1 flex items-start gap-2 text-11 leading-snug text-tertiary";

/** Small pulsing indicator while a tool is in flight */
function Working() {
  return (
    <span className="mt-0.5 grid size-3 shrink-0 grid-cols-2 gap-px" aria-hidden>
      {[0, 150, 300, 450].map((delay) => (
        <span
          key={delay}
          className="animate-pulse rounded-full bg-accent-primary"
          style={{ animationDelay: `${delay}ms`, animationDuration: "900ms" }}
        />
      ))}
    </span>
  );
}

function ToolRow({ icon: Icon, running, children }: { icon: typeof FileSearch; running: boolean; children: string }) {
  return (
    <p className={ROW}>
      {running ? <Working /> : <Icon className="mt-0.5 size-3 shrink-0" />}
      <span className="min-w-0 break-words">{children}</span>
    </p>
  );
}

type TSearchResult = {
  total: number;
  returned: number;
  has_more: boolean;
  results: { contract_id: string; titulo?: string | null; file_name?: string | null }[];
};

export const FindContractsToolUI = makeAssistantToolUI<Record<string, unknown>, TSearchResult>({
  toolName: "find_contracts",
  render: function FindContractsRender({ args, result }) {
    const { t } = useTranslation();
    const terms = Array.isArray(args?.names) ? (args.names as string[]).join(", ") : "";
    if (!result) {
      return (
        <ToolRow icon={FileSearch} running>
          {t("file_library.contracts.chat.tools.searching", { terms: terms || "…" })}
        </ToolRow>
      );
    }
    return (
      <ToolRow icon={FileSearch} running={false}>
        {t("file_library.contracts.chat.tools.found", {
          count: result.total,
          shown: result.returned,
        })}
      </ToolRow>
    );
  },
});

export const SearchContractTextToolUI = makeAssistantToolUI<{ query?: string }, { fragments: unknown[] }>({
  toolName: "search_contract_text",
  render: function SearchTextRender({ args, result }) {
    const { t } = useTranslation();
    if (!result) {
      return (
        <ToolRow icon={ScanText} running>
          {t("file_library.contracts.chat.tools.reading", { query: args?.query ?? "" })}
        </ToolRow>
      );
    }
    return (
      <ToolRow icon={ScanText} running={false}>
        {t("file_library.contracts.chat.tools.fragments", { count: result.fragments?.length ?? 0 })}
      </ToolRow>
    );
  },
});

export const ReadExcerptsToolUI = makeAssistantToolUI<
  { keywords?: string[] },
  { results: { matched_keywords: string[] }[] }
>({
  toolName: "read_contract_excerpts",
  render: function ReadExcerptsRender({ args, result }) {
    const { t } = useTranslation();
    const keywords = (args?.keywords ?? []).join(", ");
    if (!result) {
      return (
        <ToolRow icon={ScanText} running>
          {t("file_library.contracts.chat.tools.looking_for", { keywords })}
        </ToolRow>
      );
    }
    const matches = result.results?.filter((row) => row.matched_keywords?.length > 0).length ?? 0;
    return (
      <ToolRow icon={ScanText} running={false}>
        {t("file_library.contracts.chat.tools.excerpts_found", { count: matches })}
      </ToolRow>
    );
  },
});

export const KnownNamesToolUI = makeAssistantToolUI<{ filter?: string }, { artistas?: string[]; grupos?: string[] }>({
  toolName: "list_known_names",
  render: function KnownNamesRender({ result }) {
    const { t } = useTranslation();
    if (!result) {
      return (
        <ToolRow icon={Tags} running>
          {t("file_library.contracts.chat.tools.resolving_names")}
        </ToolRow>
      );
    }
    const names = [...(result.grupos ?? []), ...(result.artistas ?? [])].slice(0, 4);
    return (
      <ToolRow icon={Tags} running={false}>
        {names.length > 0
          ? t("file_library.contracts.chat.tools.names_matched", { names: names.join(", ") })
          : t("file_library.contracts.chat.tools.no_names")}
      </ToolRow>
    );
  },
});

export const ContractDetailsToolUI = makeAssistantToolUI<{ contract_ids?: string[] }, { results: unknown[] }>({
  toolName: "get_contract_details",
  render: function DetailsRender({ args, result }) {
    const { t } = useTranslation();
    const count = args?.contract_ids?.length ?? 0;
    return (
      <ToolRow icon={Layers} running={!result}>
        {t("file_library.contracts.chat.tools.details", { count })}
      </ToolRow>
    );
  },
});

/**
 * Fan-out summariser. Each document was analysed in its own model call, so the
 * card shows one line per document without any of that text having entered the
 * chat's own context.
 */
export const SummarizeContractsToolUI = makeAssistantToolUI<
  { contract_ids?: string[]; question?: string },
  { question: string; summaries: { contract_id: string; contrato: string; summary: string }[] }
>({
  toolName: "summarize_contracts",
  render: function SummarizeRender({ args, result }) {
    const { t } = useTranslation();
    if (!result) {
      return (
        <ToolRow icon={Layers} running>
          {t("file_library.contracts.chat.tools.summarizing", { count: args?.contract_ids?.length ?? 0 })}
        </ToolRow>
      );
    }
    return (
      <div className="my-1.5 overflow-hidden rounded-md border border-subtle bg-layer-1">
        <p className="border-b border-subtle px-2.5 py-1.5 text-11 font-medium text-secondary">
          {t("file_library.contracts.chat.tools.summaries_of", { count: result.summaries.length })}
        </p>
        <ul className="divide-y divide-subtle">
          {result.summaries.map((summary) => (
            <li key={summary.contract_id} className="px-2.5 py-1.5">
              <p className="truncate text-11 font-medium text-primary" title={summary.contrato}>
                {summary.contrato}
              </p>
              <p className="text-11 leading-snug break-words text-tertiary">{summary.summary}</p>
            </li>
          ))}
        </ul>
      </div>
    );
  },
});

export const ShowDocumentsToolUI = makeAssistantToolUI<
  Record<string, unknown>,
  { note: string | null; documents: TContractAgentDocument[] }
>({
  toolName: "show_documents",
  render: function ShowDocumentsRender({ result }) {
    const { t } = useTranslation();
    if (!result) {
      return (
        <ToolRow icon={CalendarSearch} running>
          {t("file_library.contracts.chat.tools.preparing_documents")}
        </ToolRow>
      );
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
