/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * "Contratos" for a song or release: the contracts that cover it (status,
 * end date, open in place) and the ones the AI thinks cover it, to confirm
 * or dismiss. Renders nothing until the backend has the feature.
 */

import { useState } from "react";
import { Check, FileSignature, Loader2, Sparkles } from "lucide-react";
import { observer } from "mobx-react";
import { Link } from "react-router";
import useSWR from "swr";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TWorkContractLink } from "@plane/types";
import { cn } from "@plane/utils";
import { usePeekLinkClick } from "@/components/entity-peek/use-entity-peek";
import { useCanEditContracts } from "@/components/file-library/contracts/use-can-edit";
import { formatContractDate } from "@/components/file-library/contracts/utils";
import {
  ConfidenceChip,
  EvidenceTip,
  refreshWorkLinks,
  rightsLabel,
  workContractsKey,
} from "@/components/file-library/contracts/works-shared";
import { contractWorksService, isNotFound } from "@/services/contract-works.service";

type Props = {
  workspaceSlug: string;
  kind: "music_track" | "music_release";
  entityId: string;
  /** The host panel's own section title */
  renderTitle?: (label: string, count: number) => React.ReactNode;
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
  renderTitle,
  className,
}: Props) {
  const { t, currentLocale } = useTranslation();
  const canEdit = useCanEditContracts(workspaceSlug);
  const openInPlace = usePeekLinkClick();
  const [busyId, setBusyId] = useState<string | null>(null);

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
  const label = t("file_library.contracts.works.contracts_title");

  const decide = async (link: TWorkContractLink, status: "LINKED" | "DISMISSED") => {
    setBusyId(link.id);
    try {
      await contractWorksService.updateLink(workspaceSlug, link.id, { status });
      await mutate();
      void refreshWorkLinks();
      if (status === "LINKED")
        setToast({ type: TOAST_TYPE.SUCCESS, title: t("file_library.contracts.works.confirmed") });
    } catch {
      setToast({ type: TOAST_TYPE.ERROR, title: t("file_library.contracts.works.action_failed") });
    } finally {
      setBusyId(null);
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

  const linkedRow = (link: TWorkContractLink) => {
    const expired = isExpired(link);
    const endDate = formatContractDate(link.contract.fecha_fin_efectiva, currentLocale);
    const detail = [
      rightsLabel(t, link.rights_type),
      endDate ? t("file_library.contracts.works.ends", { date: endDate }) : "",
      viaRelease(link),
    ]
      .filter(Boolean)
      .join(" · ");
    return (
      <li key={link.id} className="px-2 py-1.5">
        {contractLink(
          link,
          "flex min-w-0 items-center gap-2.5 rounded-md hover:bg-layer-1-hover",
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
      {renderTitle ? (
        renderTitle(label, linked.length)
      ) : (
        <h3 className="mb-2 text-13 font-medium text-primary">
          {label}
          <span className="font-normal ml-1.5 text-12 text-tertiary">{linked.length}</span>
        </h3>
      )}
      {linked.length === 0 && suggested.length === 0 && (
        <p className="px-1 py-1 text-12 text-tertiary">{t("file_library.contracts.works.no_contracts")}</p>
      )}
      {linked.length > 0 && (
        <ul className="divide-y divide-subtle rounded-md border border-subtle">{linked.map(linkedRow)}</ul>
      )}
      {suggested.length > 0 && (
        <ul className="mt-1.5 divide-y divide-subtle rounded-md border border-dashed border-subtle">
          {suggested.map(suggestionRow)}
        </ul>
      )}
    </section>
  );
});
