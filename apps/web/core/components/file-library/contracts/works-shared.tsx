/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * Pieces shared by the contract's "Obras incluidas" section, the song and
 * release "Contratos" sections and the assistant's link card.
 */

import { Quote } from "lucide-react";
import { mutate as mutateGlobal } from "swr";
import { useTranslation } from "@plane/i18n";
import { Tooltip } from "@plane/propel/tooltip";
import type { TContractWorkEvidence, TContractWorkRightsType, TContractWorkSuggested } from "@plane/types";
import { cn } from "@plane/utils";
import { WORK_RIGHTS_OPTIONS } from "./constants";

/** SWR keys: ["CONTRACT_WORKS", contractId] and ["WORK_CONTRACTS", kind, id] */
export const contractWorksKey = (contractId: string) => ["CONTRACT_WORKS", contractId];
export const workContractsKey = (kind: string, id: string) => ["WORK_CONTRACTS", kind, id];

/** A change on either side shows on the other */
export const refreshWorkLinks = () =>
  mutateGlobal((key) => Array.isArray(key) && (key[0] === "CONTRACT_WORKS" || key[0] === "WORK_CONTRACTS"));

export const artistsText = (artists: TContractWorkSuggested["artists"] | undefined): string =>
  Array.isArray(artists) ? artists.filter(Boolean).join(", ") : (artists ?? "");

const shortQuote = (quote: string, max = 240) => {
  const text = quote.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

export const SMALL_SELECT =
  "h-6 rounded-sm border border-subtle bg-transparent px-1 text-11 text-secondary outline-none hover:bg-layer-1-hover focus:border-accent-strong disabled:opacity-60";

/** Rights type picker; empty = not specified */
export function WorkRightsSelect({
  value,
  onChange,
  disabled,
  className,
}: {
  value: TContractWorkRightsType | null | undefined;
  onChange: (value: TContractWorkRightsType | null) => void;
  disabled?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <select
      value={value ?? ""}
      disabled={disabled}
      onChange={(event) => onChange((event.target.value || null) as TContractWorkRightsType | null)}
      aria-label={t("file_library.contracts.works.rights.label")}
      title={t("file_library.contracts.works.rights.label")}
      className={cn(SMALL_SELECT, className)}
    >
      <option value="">{t("file_library.contracts.works.rights.none")}</option>
      {WORK_RIGHTS_OPTIONS.map((option) => (
        <option key={option.value} value={option.value}>
          {t(option.i18nKey)}
        </option>
      ))}
    </select>
  );
}

export const rightsLabel = (t: (key: string) => string, value: TContractWorkRightsType | null | undefined) => {
  const option = WORK_RIGHTS_OPTIONS.find((item) => item.value === value);
  return option ? t(option.i18nKey) : "";
};

/** "87 %" chip for an AI suggestion */
export function ConfidenceChip({ value }: { value: number | null | undefined }) {
  const { t } = useTranslation();
  if (typeof value !== "number") return null;
  const percent = Math.round(value * 100);
  return (
    <Tooltip tooltipContent={t("file_library.contracts.works.confidence_hint")}>
      <span
        className={cn(
          "shrink-0 rounded-sm px-1 text-10 tabular-nums",
          percent >= 90 ? "bg-success-subtle text-success-primary" : "bg-layer-1 text-tertiary"
        )}
      >
        {percent}%
      </span>
    </Tooltip>
  );
}

/** Quote icon whose tooltip shows where the AI read it; a click can jump there */
export function EvidenceTip({
  evidence,
  onClick,
}: {
  evidence: TContractWorkEvidence | null | undefined;
  onClick?: () => void;
}) {
  const { t } = useTranslation();
  if (!evidence || (!evidence.quote && !evidence.page)) return null;
  const tip = (
    <span className="block max-w-72 text-11">
      {evidence.page ? (
        <span className="block font-medium">{t("file_library.contracts.evidence.page", { page: evidence.page })}</span>
      ) : null}
      {evidence.quote ? <span className="block italic">“{shortQuote(evidence.quote)}”</span> : null}
    </span>
  );
  const icon = <Quote className="size-3" aria-hidden />;
  return (
    <Tooltip tooltipContent={tip}>
      {onClick ? (
        <button
          type="button"
          onClick={onClick}
          aria-label={t("file_library.contracts.evidence.see")}
          className="grid size-5 shrink-0 place-items-center rounded-sm text-tertiary hover:bg-layer-1-hover hover:text-accent-primary"
        >
          {icon}
        </button>
      ) : (
        <span className="grid size-5 shrink-0 place-items-center text-tertiary" tabIndex={0}>
          {icon}
        </span>
      )}
    </Tooltip>
  );
}
