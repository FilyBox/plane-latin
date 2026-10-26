/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * "Ligar a contrato" in the catalog's selection toolbar: pick one contract
 * and a rights type, and every selected song (all matching ones included)
 * is linked in a single request.
 */

import { useState } from "react";
import { Link2 } from "lucide-react";
import { useTranslation } from "@plane/i18n";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TContractWorkRightsType } from "@plane/types";
import { WorksContractPickerModal } from "@/components/file-library/contracts/works-contract-picker-modal";
import { refreshWorkLinks } from "@/components/file-library/contracts/works-shared";
import { contractWorksService } from "@/services/contract-works.service";
import { getApiError } from "./shared";

type Props = {
  workspaceSlug: string;
  trackIds: string[];
  disabled?: boolean;
  triggerClassName?: string;
  labelClassName?: string;
  /** After linking: the list's contract counts change */
  onDone: () => void;
};

export function MusicBulkLinkContractAction({
  workspaceSlug,
  trackIds,
  disabled,
  triggerClassName,
  labelClassName,
  onDone,
}: Props) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const count = trackIds.length;

  const link = async ([contractId]: string[], rightsType: TContractWorkRightsType | null) => {
    try {
      const result = await contractWorksService.linkTracksToContract(workspaceSlug, contractId, trackIds, rightsType);
      const name = result.contract.titulo || result.contract.file_name || t("file_library.contracts.title");
      setToast({
        type: TOAST_TYPE.SUCCESS,
        title: t("music_catalog.bulk_link.done", { count: result.linked, contract: name }),
        message:
          [
            result.already ? t("music_catalog.bulk_link.done_already", { count: result.already }) : "",
            result.skipped ? t("music_catalog.bulk_link.done_skipped", { count: result.skipped }) : "",
          ]
            .filter(Boolean)
            .join(" ") || undefined,
      });
      void refreshWorkLinks();
      onDone();
    } catch (error) {
      setToast({ type: TOAST_TYPE.ERROR, title: t("music_catalog.bulk_link.failed"), message: getApiError(error) });
      throw error;
    }
  };

  return (
    <>
      <button
        type="button"
        disabled={disabled || count === 0}
        onClick={() => setIsOpen(true)}
        className={triggerClassName}
        aria-label={t("music_catalog.bulk_link.action")}
        title={t("music_catalog.bulk_link.action")}
      >
        <Link2 className="size-3.5" />
        <span className={labelClassName}>{t("music_catalog.bulk_link.action")}</span>
      </button>
      <WorksContractPickerModal
        workspaceSlug={workspaceSlug}
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        title={t("music_catalog.bulk_link.title", { count })}
        confirmLabel={() => t("music_catalog.bulk_link.confirm", { count })}
        onConfirm={link}
      />
    </>
  );
}
