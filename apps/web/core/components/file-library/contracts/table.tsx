/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { KeyboardEvent, ReactNode } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, FileText, GitCompareArrows } from "lucide-react";
// plane imports
import { useTranslation } from "@plane/i18n";
import { Tooltip } from "@plane/propel/tooltip";
import type { TContract, TContractFilters, TContractJob } from "@plane/types";
import { cn } from "@plane/utils";
// local imports
import { CONTRACT_STATUS_OPTIONS, CONTRACT_TYPE_OPTIONS } from "./constants";
import { ContractSelectionCheckbox } from "./list-controls";
import { ProcessingBadge } from "./processing-badge";
import { formatContractDate } from "./utils";

type TOrder = NonNullable<TContractFilters["order"]>;

type Props = {
  contracts: TContract[];
  /** contract_id -> latest active job (live progress from polling) */
  activeJobsByContract: Record<string, TContractJob>;
  selectedContractId: string | null;
  onSelect: (contract: TContract) => void;
  selectedIds: string[];
  onToggleSelect: (contractId: string) => void;
  onToggleSelectAll: () => void;
  order: TOrder;
  onOrderChange: (order: TOrder) => void;
  /** Hides the selection checkboxes (read-only users) */
  selectable: boolean;
  /** Rendered instead of the rows when there are none */
  emptyState: ReactNode;
  /** "Load more" row, below the rows */
  footer?: ReactNode;
};

const statusLabelKey = (value: string | null) =>
  CONTRACT_STATUS_OPTIONS.find((o) => o.value === value)?.i18nKey ?? null;
const typeLabelKey = (value: string | null) => CONTRACT_TYPE_OPTIONS.find((o) => o.value === value)?.i18nKey ?? null;

const titleOf = (contract: TContract) => contract.titulo ?? contract.file_name ?? "—";

const isAnalyzed = (contract: TContract) => contract.processing_status === "COMPLETED";

/** Days to the effective end; the server sends it, older servers don't. */
const daysToExpiry = (contract: TContract): number | null => {
  if (typeof contract.days_to_expiry === "number") return contract.days_to_expiry;
  if (!contract.fecha_fin_efectiva) return null;
  const end = new Date(`${contract.fecha_fin_efectiva}T00:00:00`).getTime();
  if (Number.isNaN(end)) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((end - today.getTime()) / 86_400_000);
};

function StatusPill({ contract }: { contract: TContract }) {
  const { t } = useTranslation();
  // Until the analysis lands, the status is unknown rather than "not specified"
  if (!isAnalyzed(contract)) return <span className="text-placeholder">—</span>;
  const statusKey = statusLabelKey(contract.estatus_contrato);
  if (!statusKey) return <span className="text-placeholder">—</span>;
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-11 font-medium whitespace-nowrap",
        contract.estatus_contrato === "VIGENTE"
          ? "bg-success-subtle text-success-primary"
          : contract.estatus_contrato === "FINALIZADO"
            ? "bg-layer-1 text-tertiary"
            : "bg-layer-1 text-secondary"
      )}
    >
      {t(statusKey)}
    </span>
  );
}

export function ExpiryLabel({ contract, className }: { contract: TContract; className?: string }) {
  const { t } = useTranslation();
  const days = daysToExpiry(contract);
  if (days === null) return <span className={cn("text-placeholder", className)}>—</span>;
  if (days < 0)
    return (
      <span className={cn("font-medium text-danger-primary", className)}>
        {t("file_library.contracts.expiry.expired")}
      </span>
    );
  return (
    <span className={cn("tabular-nums", days <= 30 ? "font-medium text-warning-primary" : "text-secondary", className)}>
      {days === 0
        ? t("file_library.contracts.expiry.today")
        : t("file_library.contracts.expiry.in_days", { count: days })}
    </span>
  );
}

/** Processing state and review marker, shown only when there is something to say */
function RowFlags({ contract, activeJob }: { contract: TContract; activeJob?: TContractJob }) {
  const { t } = useTranslation();
  const showProcessing = !!activeJob || !isAnalyzed(contract);
  if (!showProcessing && !contract.has_proposal) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5">
      {showProcessing && <ProcessingBadge contract={contract} activeJob={activeJob} />}
      {contract.has_proposal && (
        <Tooltip tooltipContent={t("file_library.contracts.proposal.marker_hint")}>
          <span className="inline-flex items-center gap-1 rounded-full bg-accent-primary/10 px-2 py-0.5 text-11 font-medium text-accent-primary">
            <GitCompareArrows className="size-3" />
            {t("file_library.contracts.proposal.marker")}
          </span>
        </Tooltip>
      )}
    </div>
  );
}

type TSortColumn = { asc: TOrder; desc: TOrder };
const SORTS: Record<string, TSortColumn> = {
  titulo: { asc: "titulo", desc: "-titulo" },
  fecha_inicio: { asc: "fecha_inicio", desc: "-fecha_inicio" },
  fecha_fin: { asc: "fecha_fin", desc: "-fecha_fin" },
  fecha_fin_efectiva: { asc: "fin_efectiva", desc: "-fin_efectiva" },
};

export function ContractsTable(props: Props) {
  const {
    contracts,
    activeJobsByContract,
    selectedContractId,
    onSelect,
    selectedIds,
    onToggleSelect,
    onToggleSelectAll,
    order,
    onOrderChange,
    selectable,
    emptyState,
    footer,
  } = props;
  const { t, currentLocale } = useTranslation();

  if (contracts.length === 0) return <>{emptyState}</>;

  const allSelected = contracts.length > 0 && selectedIds.length === contracts.length;
  const date = (value: string | null) =>
    value ? formatContractDate(value, currentLocale) : <span className="text-placeholder">—</span>;

  /** Header that sorts: ascending, then descending, then back to newest first */
  const sortHeader = (column: keyof typeof SORTS, label: string, sortKey?: string) => {
    const sort = SORTS[column];
    const direction = order === sort.asc ? "ascending" : order === sort.desc ? "descending" : "none";
    const next: TOrder = direction === "none" ? sort.asc : direction === "ascending" ? sort.desc : "-created_at";
    const Icon = direction === "ascending" ? ArrowUp : direction === "descending" ? ArrowDown : ArrowUpDown;
    return (
      <th key={sortKey ?? column} className="px-3 py-2" aria-sort={direction}>
        <button
          type="button"
          onClick={() => onOrderChange(next)}
          className={cn(
            "-mx-1 inline-flex items-center gap-1 rounded-sm px-1 py-0.5 whitespace-nowrap hover:bg-layer-1-hover hover:text-secondary",
            direction !== "none" && "text-primary"
          )}
        >
          {label}
          <Icon className={cn("size-3", direction === "none" && "opacity-40")} aria-hidden />
        </button>
      </th>
    );
  };

  const onRowKey = (event: KeyboardEvent<HTMLElement>, contract: TContract) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect(contract);
    }
  };

  return (
    <div className="h-full overflow-auto">
      {/* desktop table */}
      <table className="hidden w-full min-w-[960px] border-collapse text-left md:table">
        <thead className="sticky top-0 z-[1] bg-surface-1">
          <tr className="border-b border-subtle text-11 font-medium text-tertiary">
            {selectable && (
              <th className="w-10 px-4 py-2">
                <ContractSelectionCheckbox
                  checked={allSelected}
                  onChange={onToggleSelectAll}
                  label={t("file_library.contracts.list.select_all")}
                />
              </th>
            )}
            {sortHeader("titulo", t("file_library.contracts.fields.titulo"))}
            <th className="px-3 py-2">{t("file_library.contracts.fields.artistas")}</th>
            <th className="px-3 py-2">{t("file_library.contracts.fields.tipo_contrato")}</th>
            <th className="px-3 py-2">{t("file_library.contracts.list.status")}</th>
            {sortHeader("fecha_inicio", t("file_library.contracts.list.start"))}
            {sortHeader("fecha_fin", t("file_library.contracts.list.end"))}
            {sortHeader("fecha_fin_efectiva", t("file_library.contracts.list.effective_end"))}
            {sortHeader("fecha_fin_efectiva", t("file_library.contracts.list.expires_in"), "expires_in")}
          </tr>
        </thead>
        <tbody>
          {contracts.map((contract) => {
            const typeKey = typeLabelKey(contract.tipo_contrato);
            const analyzed = isAnalyzed(contract);
            const isOpen = selectedContractId === contract.id;
            return (
              <tr
                key={contract.id}
                tabIndex={0}
                aria-current={isOpen || undefined}
                onClick={() => onSelect(contract)}
                onKeyDown={(event) => onRowKey(event, contract)}
                className={cn(
                  "cursor-pointer border-b border-subtle text-13 outline-none hover:bg-layer-1-hover focus-visible:bg-layer-1-hover focus-visible:ring-1 focus-visible:ring-accent-strong focus-visible:ring-inset",
                  isOpen ? "bg-layer-1" : ""
                )}
              >
                {selectable && (
                  <td className="px-4 py-2.5">
                    <ContractSelectionCheckbox
                      checked={selectedIds.includes(contract.id)}
                      onChange={() => onToggleSelect(contract.id)}
                      label={titleOf(contract)}
                    />
                  </td>
                )}
                <td className="max-w-72 px-2 py-2.5">
                  <div className="flex items-start gap-2">
                    <FileText className="mt-0.5 size-4 shrink-0 text-danger-primary" />
                    <div className="min-w-0">
                      <p className="truncate font-medium">{titleOf(contract)}</p>
                      {contract.titulo && contract.file_name && (
                        <p className="truncate text-11 text-tertiary">{contract.file_name}</p>
                      )}
                      <RowFlags contract={contract} activeJob={activeJobsByContract[contract.id]} />
                    </div>
                  </div>
                </td>
                <td className="max-w-48 truncate px-3 py-2.5">
                  {contract.artistas ?? <span className="text-placeholder">—</span>}
                </td>
                <td className="px-3 py-2.5 whitespace-nowrap">
                  {analyzed && typeKey ? t(typeKey) : <span className="text-placeholder">—</span>}
                </td>
                <td className="px-3 py-2.5 whitespace-nowrap">
                  <StatusPill contract={contract} />
                </td>
                <td className="px-3 py-2.5 whitespace-nowrap tabular-nums">{date(contract.fecha_inicio)}</td>
                <td className="px-3 py-2.5 whitespace-nowrap tabular-nums">{date(contract.fecha_fin)}</td>
                <td className="px-3 py-2.5 whitespace-nowrap tabular-nums">{date(contract.fecha_fin_efectiva)}</td>
                <td className="px-3 py-2.5 text-12 whitespace-nowrap">
                  <ExpiryLabel contract={contract} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* mobile cards: a stretched button opens the contract; the checkbox sits above it */}
      <ul className="space-y-2 p-3 md:hidden">
        {contracts.map((contract) => {
          const typeKey = typeLabelKey(contract.tipo_contrato);
          const analyzed = isAnalyzed(contract);
          return (
            <li
              key={contract.id}
              className={cn(
                "relative rounded-lg border border-subtle p-3 focus-within:ring-1 focus-within:ring-accent-strong",
                selectedContractId === contract.id ? "border-accent-strong" : ""
              )}
            >
              <button
                type="button"
                onClick={() => onSelect(contract)}
                aria-label={titleOf(contract)}
                className="absolute inset-0 rounded-lg outline-none"
              />
              <div className="pointer-events-none relative flex items-start gap-2.5">
                {selectable && (
                  <span className="pointer-events-auto">
                    <ContractSelectionCheckbox
                      checked={selectedIds.includes(contract.id)}
                      onChange={() => onToggleSelect(contract.id)}
                      label={titleOf(contract)}
                    />
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <FileText className="size-4 shrink-0 text-danger-primary" />
                    <p className="truncate text-13 font-medium">{titleOf(contract)}</p>
                  </div>
                  {contract.artistas && <p className="mt-1 truncate text-11 text-tertiary">{contract.artistas}</p>}
                  {analyzed && (
                    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-11">
                      <StatusPill contract={contract} />
                      {typeKey && (
                        <span className="rounded-full bg-layer-1 px-2 py-0.5 text-tertiary">{t(typeKey)}</span>
                      )}
                      {contract.fecha_fin_efectiva && (
                        <span className="rounded-full bg-layer-1 px-2 py-0.5 text-tertiary tabular-nums">
                          {formatContractDate(contract.fecha_fin_efectiva, currentLocale)} ·{" "}
                          <ExpiryLabel contract={contract} className="text-11" />
                        </span>
                      )}
                    </div>
                  )}
                  <RowFlags contract={contract} activeJob={activeJobsByContract[contract.id]} />
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      {footer}
    </div>
  );
}
