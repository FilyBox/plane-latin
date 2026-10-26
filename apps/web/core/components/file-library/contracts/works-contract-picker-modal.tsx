/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * "Ligar a contrato": search the workspace's contracts (title, file, artist),
 * pick one — or several, from a song's panel — choose the rights type and
 * hand the choice back. The opposite direction of "Agregar obras".
 */

import { useEffect, useState } from "react";
import { FileSignature, Loader2, Search } from "lucide-react";
import useSWR from "swr";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import type { TContract, TContractWorkRightsType } from "@plane/types";
import { EModalPosition, EModalWidth, ModalCore } from "@plane/ui";
import { cn } from "@plane/utils";
import useDebounce from "@/hooks/use-debounce";
import { contractService } from "@/services/contract.service";
import { formatContractDate } from "./utils";
import { WorkRightsSelect } from "./works-shared";

const PAGE = 30;

type Props = {
  workspaceSlug: string;
  isOpen: boolean;
  onClose: () => void;
  /** What is being linked ("Ligar «Safaera» a contratos") */
  title: string;
  /** Several contracts at once (a song's panel) or exactly one (bulk) */
  multiple?: boolean;
  /** Contracts that already cover the work: shown ticked and locked */
  linkedContractIds?: string[];
  confirmLabel: (count: number) => string;
  onConfirm: (contractIds: string[], rightsType: TContractWorkRightsType | null) => Promise<void>;
};

/** Same rule as the backend: past its effective end, or marked finished */
const isExpired = (contract: TContract) => {
  if (contract.fecha_fin_efectiva) return contract.fecha_fin_efectiva < new Date().toISOString().slice(0, 10);
  return contract.estatus_contrato === "FINALIZADO";
};

export function WorksContractPickerModal({
  workspaceSlug,
  isOpen,
  onClose,
  title,
  multiple = false,
  linkedContractIds = [],
  confirmLabel,
  onConfirm,
}: Props) {
  const { t, currentLocale } = useTranslation();
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [rightsType, setRightsType] = useState<TContractWorkRightsType | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const debounced = useDebounce(query.trim(), 250);

  useEffect(() => {
    if (isOpen) return;
    setQuery("");
    setPicked([]);
    setRightsType(null);
  }, [isOpen]);

  const { data, error, isLoading } = useSWR(
    isOpen ? ["WORKS_CONTRACT_PICKER", workspaceSlug, debounced] : null,
    () => contractService.getContractsPage(workspaceSlug, { search: debounced || undefined }, undefined, PAGE),
    { keepPreviousData: true }
  );
  const contracts = data?.results ?? [];

  const toggle = (contractId: string) =>
    setPicked((current) => {
      if (!multiple) return current[0] === contractId ? [] : [contractId];
      return current.includes(contractId) ? current.filter((id) => id !== contractId) : [...current, contractId];
    });

  const confirm = async () => {
    if (picked.length === 0) return;
    setIsSaving(true);
    try {
      await onConfirm(picked, rightsType);
      onClose();
    } catch {
      // The caller already told the user; keep the choice for a retry
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <ModalCore
      isOpen={isOpen}
      handleClose={() => !isSaving && onClose()}
      position={EModalPosition.TOP}
      width={EModalWidth.XXL}
    >
      <div className="flex max-h-[70vh] flex-col">
        <div className="border-b border-subtle px-4 pt-3 pb-2">
          <p className="truncate text-13 font-medium text-primary">{title}</p>
        </div>
        <div className="flex items-center gap-2 border-b border-subtle px-4 py-2.5">
          <Search className="size-4 shrink-0 text-tertiary" />
          <input
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("file_library.contracts.works.contract_picker.placeholder")}
            aria-label={t("file_library.contracts.works.contract_picker.placeholder")}
            className="h-7 flex-1 bg-transparent text-14 outline-none placeholder:text-placeholder"
          />
          {isLoading && <Loader2 className="size-4 animate-spin text-tertiary" />}
        </div>
        <div className="min-h-40 flex-1 overflow-y-auto p-2">
          {error ? (
            <p className="px-2 py-10 text-center text-13 text-tertiary">
              {t("file_library.contracts.works.contract_picker.load_failed")}
            </p>
          ) : contracts.length === 0 && !isLoading ? (
            <p className="px-2 py-10 text-center text-13 text-tertiary">
              {t(
                debounced
                  ? "file_library.contracts.works.contract_picker.no_results"
                  : "file_library.contracts.works.contract_picker.empty"
              )}
            </p>
          ) : (
            <ul role={multiple ? "group" : "radiogroup"}>
              {contracts.map((contract) => {
                const linked = linkedContractIds.includes(contract.id);
                const checked = linked || picked.includes(contract.id);
                const expired = isExpired(contract);
                const endDate = formatContractDate(contract.fecha_fin_efectiva, currentLocale);
                const name = contract.titulo || contract.file_name || t("file_library.contracts.title");
                const detail = [
                  contract.titulo && contract.file_name ? contract.file_name : "",
                  endDate ? t("file_library.contracts.works.ends", { date: endDate }) : "",
                ]
                  .filter(Boolean)
                  .join(" · ");
                return (
                  <li key={contract.id}>
                    <label
                      className={cn(
                        "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left",
                        linked ? "cursor-default" : "cursor-pointer hover:bg-layer-1-hover"
                      )}
                    >
                      <input
                        type={multiple ? "checkbox" : "radio"}
                        name="works-contract-picker"
                        className="accent-accent-primary size-4 shrink-0"
                        checked={checked}
                        disabled={linked || isSaving}
                        onChange={() => toggle(contract.id)}
                      />
                      <span className="grid size-7 shrink-0 place-items-center rounded-md bg-layer-1">
                        <FileSignature className="size-3.5 text-secondary" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-13 text-primary">{name}</span>
                        {detail && <span className="block truncate text-11 text-tertiary">{detail}</span>}
                      </span>
                      {linked ? (
                        <span className="shrink-0 text-11 text-secondary">
                          {t("file_library.contracts.works.picker.linked")}
                        </span>
                      ) : (
                        <span
                          className={cn(
                            "shrink-0 rounded-sm px-1.5 py-0.5 text-10 font-medium",
                            expired ? "bg-danger-subtle text-danger-primary" : "bg-success-subtle text-success-primary"
                          )}
                        >
                          {t(expired ? "file_library.contracts.works.expired" : "file_library.contracts.works.active")}
                        </span>
                      )}
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
          {data && data.total > contracts.length && (
            <p className="px-2 pt-2 text-11 text-tertiary">
              {t("file_library.contracts.works.contract_picker.more", { count: data.total - contracts.length })}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-subtle px-4 py-3">
          <span className="text-12 text-tertiary">{t("file_library.contracts.works.rights.label")}</span>
          <WorkRightsSelect value={rightsType} onChange={setRightsType} disabled={isSaving} className="h-7 text-12" />
          <span className="ml-auto flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={onClose} disabled={isSaving}>
              {t("cancel")}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => void confirm()}
              loading={isSaving}
              disabled={picked.length === 0}
            >
              {confirmLabel(picked.length)}
            </Button>
          </span>
        </div>
      </div>
    </ModalCore>
  );
}
