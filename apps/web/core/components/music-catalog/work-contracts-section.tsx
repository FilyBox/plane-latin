/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * "Contratos" for a song or release: the contracts that cover it (status,
 * end date, open in place) and the ones the AI thinks cover it, to confirm
 * or dismiss. From here the work can also be linked to contracts ("Ligar a
 * contrato"), its rights type changed, or a link removed. Renders nothing
 * until the backend has the feature.
 */

import { useEffect, useState } from "react";
import { Check, FileSignature, Link2, Loader2, Sparkles, X } from "lucide-react";
import { observer } from "mobx-react";
import { Link } from "react-router";
import useSWR from "swr";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import { Tooltip } from "@plane/propel/tooltip";
import type { TContractWorkRightsType, TWorkContractLink } from "@plane/types";
import { AlertModalCore } from "@plane/ui";
import { cn } from "@plane/utils";
import { usePeekLinkClick } from "@/components/entity-peek/use-entity-peek";
import { useCanEditContracts } from "@/components/file-library/contracts/use-can-edit";
import { formatContractDate } from "@/components/file-library/contracts/utils";
import { WorksContractPickerModal } from "@/components/file-library/contracts/works-contract-picker-modal";
import {
  ConfidenceChip,
  EvidenceTip,
  WorkRightsSelect,
  refreshWorkLinks,
  rightsLabel,
  workContractsKey,
} from "@/components/file-library/contracts/works-shared";
import { useWorkspace } from "@/hooks/store/use-workspace";
import { contractWorksService, isNotFound } from "@/services/contract-works.service";

type Props = {
  workspaceSlug: string;
  kind: "music_track" | "music_release";
  entityId: string;
  /** The song or release title, for the picker's heading */
  entityTitle?: string;
  /** The host panel's own section title */
  renderTitle?: (label: string, count: number) => React.ReactNode;
  /** A dialog of this section is open: the host must not close on Escape */
  onDialogOpenChange?: (open: boolean) => void;
  className?: string;
};

/** Expired: past its effective end date, or marked finished */
const isExpired = (link: TWorkContractLink) =>
  link.contract.expired === true ||
  (typeof link.contract.days_to_expiry === "number" && link.contract.days_to_expiry < 0) ||
  link.contract.estatus_contrato === "FINALIZADO";

export const WorkContractsSection = observer(function WorkContractsSection({
  workspaceSlug,
  kind,
  entityId,
  entityTitle,
  renderTitle,
  onDialogOpenChange,
  className,
}: Props) {
  const { t, currentLocale } = useTranslation();
  const canEdit = useCanEditContracts(workspaceSlug);
  const { isWorkspaceFeatureEnabled } = useWorkspace();
  // Contracts live in the file library: without it there is nothing to link
  const canLink = canEdit && isWorkspaceFeatureEnabled(workspaceSlug, "file_library");
  const openInPlace = usePeekLinkClick();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [unlinking, setUnlinking] = useState<TWorkContractLink | null>(null);
  const [isUnlinking, setIsUnlinking] = useState(false);

  const dialogOpen = isPickerOpen || unlinking !== null;
  useEffect(() => {
    onDialogOpenChange?.(dialogOpen);
  }, [dialogOpen, onDialogOpenChange]);
  // Closing the panel with a dialog open must not leave the host suspended
  useEffect(() => () => onDialogOpenChange?.(false), [onDialogOpenChange]);

  const { data, error, mutate } = useSWR(workContractsKey(kind, entityId), () =>
    kind === "music_track"
      ? contractWorksService.getTrackContracts(workspaceSlug, entityId)
      : contractWorksService.getReleaseContracts(workspaceSlug, entityId)
  );

  if (error && isNotFound(error)) return null;
  // Nothing to show and nothing loading: keep the panel short
  if (error || !data) return null;

  const linked = data.links.filter((link) => link.status === "LINKED");
  const suggested = data.links.filter((link) => link.status === "SUGGESTED");
  // Contracts that already cover this work directly (a release's link doesn't count)
  const linkedContractIds = linked.filter((link) => !link.via_release).map((link) => link.contract.id);
  const label = t("file_library.contracts.works.contracts_title");

  const afterChange = async () => {
    await mutate();
    void refreshWorkLinks();
  };

  const decide = async (link: TWorkContractLink, status: "LINKED" | "DISMISSED") => {
    setBusyId(link.id);
    try {
      await contractWorksService.updateLink(workspaceSlug, link.id, { status });
      await afterChange();
      if (status === "LINKED")
        setToast({ type: TOAST_TYPE.SUCCESS, title: t("file_library.contracts.works.confirmed") });
    } catch {
      setToast({ type: TOAST_TYPE.ERROR, title: t("file_library.contracts.works.action_failed") });
    } finally {
      setBusyId(null);
    }
  };

  const setRights = async (link: TWorkContractLink, rights: TContractWorkRightsType | null) => {
    // Shown at once; reverted by the refetch if the save fails
    void mutate(
      (current) =>
        current && {
          links: current.links.map((item) => (item.id === link.id ? { ...item, rights_type: rights } : item)),
        },
      { revalidate: false }
    );
    setBusyId(link.id);
    try {
      await contractWorksService.updateLink(workspaceSlug, link.id, { rights_type: rights });
      void refreshWorkLinks();
    } catch {
      setToast({ type: TOAST_TYPE.ERROR, title: t("file_library.contracts.works.action_failed") });
      void mutate();
    } finally {
      setBusyId(null);
    }
  };

  const linkContracts = async (contractIds: string[], rightsType: TContractWorkRightsType | null) => {
    const results = await Promise.allSettled(
      contractIds.map((contractId) =>
        contractWorksService.linkWorks(workspaceSlug, contractId, [
          { entity_type: kind, entity_id: entityId, rights_type: rightsType },
        ])
      )
    );
    const done = results.filter((result) => result.status === "fulfilled").length;
    await afterChange();
    if (done > 0)
      setToast({
        type: TOAST_TYPE.SUCCESS,
        title: t("file_library.contracts.works.contract_picker.linked_count", { count: done }),
      });
    if (done < contractIds.length) {
      setToast({ type: TOAST_TYPE.ERROR, title: t("file_library.contracts.works.action_failed") });
      throw new Error("link failed");
    }
  };

  const unlink = async () => {
    if (!unlinking) return;
    setIsUnlinking(true);
    try {
      await contractWorksService.deleteLink(workspaceSlug, unlinking.id);
      await afterChange();
      setToast({ type: TOAST_TYPE.SUCCESS, title: t("file_library.contracts.works.contract_unlinked") });
      setUnlinking(null);
    } catch {
      setToast({ type: TOAST_TYPE.ERROR, title: t("file_library.contracts.works.action_failed") });
    } finally {
      setIsUnlinking(false);
    }
  };

  const contractTitle = (link: TWorkContractLink) =>
    link.contract.titulo || link.contract.file_name || t("file_library.contracts.title");

  const contractLink = (link: TWorkContractLink, classes: string, children: React.ReactNode) =>
    link.contract.path ? (
      <Link
        to={link.contract.path}
        onClick={(event) => openInPlace(event, { entity_name: "contract", id: link.contract.id })}
        className={classes}
      >
        {children}
      </Link>
    ) : (
      <span className={classes}>{children}</span>
    );

  const viaRelease = (link: TWorkContractLink) =>
    link.via_release ? t("file_library.contracts.works.via_release", { title: link.via_release.title }) : "";

  const linkButton = (variant: "header" | "empty") =>
    canLink ? (
      <button
        type="button"
        onClick={() => setIsPickerOpen(true)}
        className={cn(
          "flex shrink-0 items-center gap-1 rounded-sm text-11 text-accent-primary hover:bg-layer-1-hover",
          variant === "header" ? "px-1" : "mt-1 px-1 py-0.5"
        )}
      >
        <Link2 className="size-3" />
        {t("file_library.contracts.works.link_contract")}
      </button>
    ) : null;

  const linkedRow = (link: TWorkContractLink) => {
    const expired = isExpired(link);
    const endDate = formatContractDate(link.contract.fecha_fin_efectiva, currentLocale);
    // A release's link is changed from the release, not from each song
    const editable = canEdit && !link.via_release;
    const detail = [
      editable ? "" : rightsLabel(t, link.rights_type),
      endDate ? t("file_library.contracts.works.ends", { date: endDate }) : "",
      viaRelease(link),
    ]
      .filter(Boolean)
      .join(" · ");
    return (
      <li key={link.id} className="group flex items-center gap-1.5 px-2 py-1.5">
        {contractLink(
          link,
          "flex min-w-0 flex-1 items-center gap-2.5 rounded-md hover:bg-layer-1-hover",
          <>
            <span className="grid size-7 shrink-0 place-items-center rounded-md bg-layer-1">
              <FileSignature className="size-3.5 text-secondary" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-13 text-primary">{contractTitle(link)}</span>
              {detail && <span className="block truncate text-11 text-tertiary">{detail}</span>}
            </span>
            <span
              className={cn(
                "shrink-0 rounded-sm px-1.5 py-0.5 text-10 font-medium",
                expired ? "bg-danger-subtle text-danger-primary" : "bg-success-subtle text-success-primary"
              )}
            >
              {t(expired ? "file_library.contracts.works.expired" : "file_library.contracts.works.active")}
            </span>
          </>
        )}
        {editable && (
          <>
            <WorkRightsSelect
              value={link.rights_type}
              onChange={(value) => void setRights(link, value)}
              disabled={busyId === link.id}
              className="max-w-28 shrink-0"
            />
            <Tooltip tooltipContent={t("file_library.contracts.works.unlink_contract")}>
              <button
                type="button"
                onClick={() => setUnlinking(link)}
                aria-label={t("file_library.contracts.works.unlink_contract")}
                className="shrink-0 rounded-sm p-1 text-tertiary opacity-0 group-hover:opacity-100 hover:bg-layer-1-hover hover:text-primary focus-visible:opacity-100"
              >
                <X className="size-3.5" />
              </button>
            </Tooltip>
          </>
        )}
      </li>
    );
  };

  const suggestionRow = (link: TWorkContractLink) => {
    const busy = busyId === link.id;
    return (
      <li key={link.id} className="flex items-center gap-2 px-2 py-1.5">
        <Sparkles className="size-3.5 shrink-0 text-accent-primary" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5 text-12 text-secondary">
            <span className="min-w-0 truncate">
              {t("file_library.contracts.works.ai_suggests")}{" "}
              {contractLink(link, "text-primary hover:underline", `«${contractTitle(link)}»`)}
            </span>
            <ConfidenceChip value={link.confidence} />
            <EvidenceTip evidence={link.evidence} />
          </span>
          {link.via_release && <span className="block truncate text-11 text-tertiary">{viaRelease(link)}</span>}
        </span>
        {canEdit && (
          <span className="flex shrink-0 items-center gap-1">
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => void decide(link, "LINKED")}>
              {busy ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
              {t("file_library.contracts.works.confirm")}
            </Button>
            <Button variant="tertiary" size="sm" disabled={busy} onClick={() => void decide(link, "DISMISSED")}>
              {t("file_library.contracts.works.dismiss")}
            </Button>
          </span>
        )}
      </li>
    );
  };

  return (
    <section className={className}>
      <div className="flex items-center justify-between gap-2">
        {renderTitle ? (
          renderTitle(label, linked.length)
        ) : (
          <h3 className="mb-2 text-13 font-medium text-primary">
            {label}
            <span className="font-normal ml-1.5 text-12 text-tertiary">{linked.length}</span>
          </h3>
        )}
        {(linked.length > 0 || suggested.length > 0) && linkButton("header")}
      </div>
      {linked.length === 0 && suggested.length === 0 && (
        <div className="px-1 py-1">
          <p className="text-12 text-tertiary">{t("file_library.contracts.works.no_contracts")}</p>
          {linkButton("empty")}
        </div>
      )}
      {linked.length > 0 && (
        <ul className="divide-y divide-subtle rounded-md border border-subtle">{linked.map(linkedRow)}</ul>
      )}
      {suggested.length > 0 && (
        <ul className="mt-1.5 divide-y divide-subtle rounded-md border border-dashed border-subtle">
          {suggested.map(suggestionRow)}
        </ul>
      )}
      {canLink && (
        <WorksContractPickerModal
          workspaceSlug={workspaceSlug}
          isOpen={isPickerOpen}
          onClose={() => setIsPickerOpen(false)}
          multiple
          linkedContractIds={linkedContractIds}
          title={
            entityTitle
              ? t("file_library.contracts.works.contract_picker.title_named", { title: entityTitle })
              : t("file_library.contracts.works.link_contract")
          }
          confirmLabel={(count) => t("file_library.contracts.works.contract_picker.confirm_multi", { count })}
          onConfirm={linkContracts}
        />
      )}
      <AlertModalCore
        isOpen={unlinking !== null}
        isSubmitting={isUnlinking}
        handleClose={() => !isUnlinking && setUnlinking(null)}
        handleSubmit={() => void unlink()}
        title={t("file_library.contracts.works.unlink_confirm_title", {
          title: unlinking ? contractTitle(unlinking) : "",
        })}
        content={t("file_library.contracts.works.unlink_confirm_body")}
        primaryButtonText={{
          default: t("file_library.contracts.works.unlink_contract"),
          loading: t("file_library.contracts.works.unlinking"),
        }}
        secondaryButtonText={t("cancel")}
      />
    </section>
  );
});
