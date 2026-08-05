/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import { AlertTriangle, FileCheck2, Trash2 } from "lucide-react";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import type { TContractSignatureRequest } from "@plane/types";
import { EModalPosition, EModalWidth, ModalCore } from "@plane/ui";
import { ContractCheckbox } from "./ui";

type DeleteOptions = { deleteFiles: boolean; deleteAnalysis: boolean };

type Props = {
  requests: TContractSignatureRequest[];
  isSubmitting: boolean;
  onClose: () => void;
  onConfirm: (options: DeleteOptions) => Promise<void>;
};

const PREVIEW_LIMIT = 6;

export function ContractDeleteDialog({ requests, isSubmitting, onClose, onConfirm }: Props) {
  const { t } = useTranslation();
  const [deleteFiles, setDeleteFiles] = useState(false);
  const [deleteAnalysis, setDeleteAnalysis] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  const hasCompleted = requests.some((request) => request.status === "COMPLETED");
  const hasSignedFiles = requests.some((request) => Boolean(request.signed_asset_id));
  const hasAnalysis = requests.some((request) => Boolean(request.analysis_contract_id));
  const hasActiveEnvelope = requests.some(
    (request) => Boolean(request.documenso_envelope_id) && request.status === "PENDING"
  );

  const toggleFiles = (checked: boolean) => {
    setDeleteFiles(checked);
    if (checked && hasAnalysis) setDeleteAnalysis(true);
  };

  const toggleAnalysis = (checked: boolean) => {
    if (!checked && deleteFiles && hasAnalysis) return;
    setDeleteAnalysis(checked);
  };

  return (
    <ModalCore
      isOpen={requests.length > 0}
      handleClose={() => {
        if (!isSubmitting) onClose();
      }}
      position={EModalPosition.CENTER}
      width={EModalWidth.XL}
    >
      <div className="space-y-4 p-5">
        <div className="flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-danger-subtle text-danger-primary">
            <Trash2 className="size-4" />
          </span>
          <div>
            <h3 className="text-16 font-semibold text-primary">
              {t("file_library.contracts.workflow.documents.delete_title", { count: requests.length })}
            </h3>
            <p className="mt-1 text-12 text-tertiary">
              {t("file_library.contracts.workflow.documents.delete_description")}
            </p>
          </div>
        </div>

        <div className="max-h-36 space-y-0.5 overflow-y-auto rounded-md border border-subtle p-1.5">
          {requests.slice(0, PREVIEW_LIMIT).map((request) => (
            <div key={request.id} className="flex items-center gap-2 rounded px-2 py-1.5 text-12 text-secondary">
              <FileCheck2 className="size-3.5 shrink-0 text-tertiary" />
              <span className="min-w-0 flex-1 truncate">{request.title}</span>
              <span className="shrink-0 text-10 text-tertiary">
                {t(`file_library.contracts.workflow.request_status.${request.status.toLowerCase()}`)}
              </span>
            </div>
          ))}
          {requests.length > PREVIEW_LIMIT ? (
            <p className="px-2 py-1 text-11 text-tertiary">
              {t("file_library.contracts.workflow.documents.delete_more", {
                count: requests.length - PREVIEW_LIMIT,
              })}
            </p>
          ) : null}
        </div>

        <div className="space-y-3 rounded-md border border-subtle bg-layer-1 p-3">
          <p className="text-12 font-medium text-primary">
            {t("file_library.contracts.workflow.documents.delete_data_title")}
          </p>
          <p className="text-11 text-tertiary">
            {t("file_library.contracts.workflow.documents.delete_working_files_notice")}
          </p>
          <ContractCheckbox
            checked={deleteFiles}
            disabled={!hasSignedFiles}
            onChange={toggleFiles}
            label={
              <span>
                <span className="block text-12 font-medium text-primary">
                  {t("file_library.contracts.workflow.documents.delete_files")}
                </span>
                <span className="block text-11 text-tertiary">
                  {t(
                    hasSignedFiles
                      ? "file_library.contracts.workflow.documents.delete_files_description"
                      : "file_library.contracts.workflow.documents.delete_files_unavailable"
                  )}
                </span>
              </span>
            }
          />
          <ContractCheckbox
            checked={deleteAnalysis}
            disabled={!hasAnalysis || (deleteFiles && hasAnalysis)}
            onChange={toggleAnalysis}
            label={
              <span>
                <span className="block text-12 font-medium text-primary">
                  {t("file_library.contracts.workflow.documents.delete_analysis")}
                </span>
                <span className="block text-11 text-tertiary">
                  {t(
                    hasAnalysis
                      ? "file_library.contracts.workflow.documents.delete_analysis_description"
                      : "file_library.contracts.workflow.documents.delete_analysis_unavailable"
                  )}
                </span>
              </span>
            }
          />
        </div>

        {hasActiveEnvelope ? (
          <div className="flex items-start gap-2 rounded-md border border-warning-subtle bg-warning-subtle p-3 text-11 text-warning-primary">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            {t("file_library.contracts.workflow.documents.delete_active_warning")}
          </div>
        ) : null}

        {hasCompleted ? (
          <ContractCheckbox
            checked={acknowledged}
            onChange={setAcknowledged}
            label={t("file_library.contracts.workflow.documents.delete_completed_confirmation")}
          />
        ) : null}

        <div className="flex justify-end gap-2 border-t border-subtle pt-4">
          <Button variant="secondary" size="lg" disabled={isSubmitting} onClick={onClose}>
            {t("file_library.contracts.workflow.common.cancel")}
          </Button>
          <Button
            variant="error-fill"
            size="lg"
            loading={isSubmitting}
            disabled={isSubmitting || (hasCompleted && !acknowledged)}
            onClick={() => void onConfirm({ deleteFiles, deleteAnalysis })}
          >
            {t("file_library.contracts.workflow.documents.delete_confirm", { count: requests.length })}
          </Button>
        </div>
      </div>
    </ModalCore>
  );
}
