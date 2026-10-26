/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * Card for `propose_work_links`: the works the assistant found in a contract,
 * split into catalog matches (tick to link) and works not in the catalog
 * (tick to add them as draft songs and link). Nothing is written until the
 * user applies, with their own session, through the combined endpoint.
 */

import { useState } from "react";
import { makeAssistantToolUI } from "@assistant-ui/react";
import { Check, Music2, X } from "lucide-react";
import { useParams } from "react-router";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TContractWorkEntityType, TContractWorkRightsType } from "@plane/types";
import { cn } from "@plane/utils";
import {
  ConfidenceChip,
  EvidenceTip,
  WorkRightsSelect,
  artistsText,
  refreshWorkLinks,
} from "@/components/file-library/contracts/works-shared";
import { contractWorksService, isNotFound } from "@/services/contract-works.service";
import { CARD, errorText, useOutcome } from "./action-cards";
import { AssistantLink } from "./links";
import { TraceLine } from "./steps";

type TWork = {
  title?: string;
  artists?: string | string[];
  isrc?: string;
  rights_type?: TContractWorkRightsType | null;
  evidence?: string | { quote?: string; page?: number | null } | null;
};

type TMatched = {
  work?: TWork;
  entity_type?: TContractWorkEntityType;
  entity_id: string;
  title?: string;
  artists?: string | string[];
  path?: string;
  confidence?: number | null;
  /** The contract already has a link to this item (the worker sends `link_status`) */
  existing_status?: TLinkStatus;
  link_status?: TLinkStatus;
};

type TLinkStatus = "SUGGESTED" | "LINKED" | "DISMISSED" | null;

const statusOf = (item: TMatched) => item.existing_status ?? item.link_status ?? null;

type TProposal = {
  contract?: {
    id?: string;
    contract_id?: string;
    titulo?: string | null;
    title?: string | null;
    file_name?: string | null;
    path?: string;
  };
  contract_id?: string;
  matched?: TMatched[];
  unmatched?: { index?: number; work: TWork }[];
  workspace_slug?: string;
  error?: string;
};

type TRow = { checked: boolean; rights: TContractWorkRightsType | null };

const updateRow = (setter: React.Dispatch<React.SetStateAction<TRow[]>>, index: number, patch: Partial<TRow>) =>
  setter((rows) => rows.map((row, position) => (position === index ? { ...row, ...patch } : row)));

const evidenceOf = (work: TWork | undefined) =>
  typeof work?.evidence === "string" ? { quote: work.evidence } : (work?.evidence ?? null);

function WorkLinksForm({ proposal, toolCallId, slug }: { proposal: TProposal; toolCallId: string; slug: string }) {
  const { t } = useTranslation();
  const [outcome, remember] = useOutcome(`assistant-work-links:${toolCallId}`);
  const matched = proposal.matched ?? [];
  const unmatched = (proposal.unmatched ?? []).filter((item) => item.work?.title);
  const contractId = proposal.contract?.id ?? proposal.contract?.contract_id ?? proposal.contract_id ?? "";
  const contractTitle =
    proposal.contract?.titulo ||
    proposal.contract?.title ||
    proposal.contract?.file_name ||
    t("file_library.contracts.title");
  const contractPath = proposal.contract?.path ?? `/${slug}/file-library/contracts/analyzed?peek=${contractId}`;

  const [matchedRows, setMatchedRows] = useState<TRow[]>(() =>
    // Linked ones are locked; ones the user dismissed before start unticked
    matched.map((item) => ({ checked: !statusOf(item), rights: item.work?.rights_type ?? null }))
  );
  const [unmatchedRows, setUnmatchedRows] = useState<TRow[]>(() =>
    unmatched.map((item) => ({ checked: true, rights: item.work?.rights_type ?? null }))
  );
  const busy = outcome.state === "busy";
  const done = outcome.state !== "idle" && outcome.state !== "busy";
  const chosenLinks = matchedRows.filter((row) => row.checked).length;
  const chosenCreates = unmatchedRows.filter((row) => row.checked).length;

  const apply = async () => {
    remember({ state: "busy" });
    try {
      const response = await contractWorksService.applyWorks(slug, contractId, {
        link: matched
          .map((item, index) => ({ item, row: matchedRows[index] }))
          .filter(({ row }) => row?.checked)
          .map(({ item, row }) => ({
            entity_type: item.entity_type ?? "music_track",
            entity_id: item.entity_id,
            rights_type: row.rights,
          })),
        create: unmatched
          .map((item, index) => ({ item, row: unmatchedRows[index] }))
          .filter(({ row }) => row?.checked)
          .map(({ item, row }) => ({
            title: item.work.title ?? "",
            artists: artistsText(item.work.artists) || undefined,
            isrc: item.work.isrc || undefined,
            rights_type: row.rights,
          })),
      });
      remember({
        state: "applied",
        result: { linked: response.linked ?? chosenLinks, created: response.created ?? chosenCreates },
      });
      void refreshWorkLinks();
    } catch (error) {
      remember({ state: "idle" });
      setToast({
        type: TOAST_TYPE.ERROR,
        title: isNotFound(error)
          ? t("assistant.work_links.unavailable")
          : errorText(error, t("assistant.actions.failed")),
      });
    }
  };

  const checkbox = (row: TRow, onChange: () => void, locked = false) => (
    <input
      type="checkbox"
      className="accent-accent-primary"
      checked={row.checked}
      disabled={done || busy || locked}
      onChange={onChange}
    />
  );

  const linkedCount = Number(outcome.result?.linked ?? 0);
  const createdCount = Number(outcome.result?.created ?? 0);
  return (
    <div className={CARD}>
      <div className="flex items-center gap-2">
        <Music2 className="size-4 shrink-0 text-tertiary" aria-hidden />
        <p className="min-w-0 flex-1 truncate text-13 font-medium text-primary">
          {t("assistant.work_links.title", { contract: contractTitle })}
        </p>
      </div>
      {matched.length > 0 && (
        <div className="mt-2">
          <p className="text-11 text-tertiary">{t("assistant.work_links.matched", { count: matched.length })}</p>
          <ul className="mt-1 max-h-56 space-y-0.5 overflow-y-auto">
            {matched.map((item, index) => {
              const row = matchedRows[index];
              if (!row) return null;
              const alreadyLinked = statusOf(item) === "LINKED";
              const dismissedBefore = statusOf(item) === "DISMISSED";
              return (
                <li
                  key={`${item.entity_type}:${item.entity_id}`}
                  className="flex items-center gap-2 px-1.5 py-1 text-12"
                >
                  {checkbox(row, () => updateRow(setMatchedRows, index, { checked: !row.checked }), alreadyLinked)}
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-1.5">
                      {item.path ? (
                        <AssistantLink
                          href={item.path}
                          className={cn("truncate", !row.checked && "text-tertiary line-through")}
                        >
                          {item.title ?? item.work?.title ?? item.entity_id}
                        </AssistantLink>
                      ) : (
                        <span className={cn("truncate", row.checked ? "text-primary" : "text-tertiary line-through")}>
                          {item.title ?? item.work?.title ?? item.entity_id}
                        </span>
                      )}
                      <ConfidenceChip value={item.confidence} />
                      <EvidenceTip evidence={evidenceOf(item.work)} />
                    </span>
                    {(alreadyLinked || dismissedBefore || artistsText(item.artists ?? item.work?.artists)) && (
                      <span className="block truncate text-11 text-tertiary">
                        {[
                          alreadyLinked ? t("assistant.work_links.already_linked") : "",
                          dismissedBefore ? t("assistant.work_links.dismissed_before") : "",
                          artistsText(item.artists ?? item.work?.artists),
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    )}
                  </span>
                  <WorkRightsSelect
                    value={row.rights}
                    onChange={(rights) => updateRow(setMatchedRows, index, { rights })}
                    disabled={done || busy || !row.checked}
                    className="max-w-28 shrink-0"
                  />
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {unmatched.length > 0 && (
        <div className="mt-2">
          <p className="text-11 text-tertiary">{t("assistant.work_links.unmatched", { count: unmatched.length })}</p>
          <ul className="mt-1 max-h-56 space-y-0.5 overflow-y-auto">
            {unmatched.map((item, index) => {
              const row = unmatchedRows[index];
              if (!row) return null;
              return (
                <li
                  key={`${item.index ?? ""}:${item.work.title}:${item.work.isrc ?? ""}`}
                  className="flex items-center gap-2 px-1.5 py-1 text-12"
                >
                  <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                    {checkbox(row, () => updateRow(setUnmatchedRows, index, { checked: !row.checked }))}
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className={cn("truncate", row.checked ? "text-primary" : "text-tertiary line-through")}>
                          {item.work.title}
                        </span>
                        <EvidenceTip evidence={evidenceOf(item.work)} />
                      </span>
                      <span className="block truncate text-11 text-tertiary">
                        {[t("assistant.work_links.add_to_catalog"), artistsText(item.work.artists), item.work.isrc]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </span>
                  </label>
                  <WorkRightsSelect
                    value={row.rights}
                    onChange={(rights) => updateRow(setUnmatchedRows, index, { rights })}
                    disabled={done || busy || !row.checked}
                    className="max-w-28 shrink-0"
                  />
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {outcome.state === "applied" ? (
        <p className="mt-2.5 flex min-w-0 items-center gap-1.5 text-12 text-success-primary">
          <Check className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">
            {t("assistant.work_links.applied", { linked: linkedCount, created: createdCount })}
          </span>
          <AssistantLink href={contractPath} className="shrink-0 text-12">
            {t("assistant.actions.open")}
          </AssistantLink>
        </p>
      ) : outcome.state === "discarded" ? (
        <p className="mt-2.5 flex items-center gap-1.5 text-12 text-tertiary">
          <X className="size-3.5" />
          {t("assistant.actions.discarded")}
        </p>
      ) : (
        <div className="mt-2.5 flex justify-end gap-1.5">
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => remember({ state: "discarded" })}>
            {t("assistant.actions.discard")}
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={busy}
            disabled={chosenLinks + chosenCreates === 0}
            onClick={() => void apply()}
          >
            {t("assistant.work_links.apply", { count: chosenLinks + chosenCreates })}
          </Button>
        </div>
      )}
    </div>
  );
}

export const WorkLinksCard = makeAssistantToolUI<Record<string, unknown>, TProposal>({
  toolName: "propose_work_links",
  render: function WorkLinksRender({ result, status, toolCallId }) {
    const { t } = useTranslation();
    const { workspaceSlug } = useParams();
    if (status.type === "running" || !result) {
      return <TraceLine live icon={Music2} label={t("assistant.steps.propose_work_links.running")} />;
    }
    const slug = result.workspace_slug ?? (workspaceSlug ? String(workspaceSlug) : "");
    const contractId = result.contract?.id ?? result.contract?.contract_id ?? result.contract_id;
    if (result.error || !slug || !contractId) {
      return <p className="text-12 text-tertiary">{result.error ?? t("assistant.actions.failed")}</p>;
    }
    if (!result.matched?.length && !result.unmatched?.length) {
      return <p className="text-12 text-tertiary">{t("assistant.work_links.none")}</p>;
    }
    return <WorkLinksForm proposal={result} toolCallId={toolCallId} slug={slug} />;
  },
});
