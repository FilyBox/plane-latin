/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { AlertTriangle, Loader2 } from "lucide-react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import useSWR from "swr";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { PageHead } from "@/components/core/page-title";
import { ContractAuthoringEditor } from "@/components/file-library/contracts/contract-authoring-editor";
import { ContractEmptyState } from "@/components/file-library/contracts/ui";
import { contractService } from "@/services/contract.service";

/**
 * The field editor is a route rather than an overlay: it survives a refresh,
 * supports browser back, and can be deep-linked to resume a draft.
 */
export default function ContractAuthoringEditorPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { workspaceSlug = "", requestId = "" } = useParams();

  const {
    data: request,
    error,
    isLoading,
    mutate,
  } = useSWR(
    workspaceSlug && requestId ? `CONTRACT_SIGNATURE_REQUEST_${workspaceSlug}_${requestId}` : null,
    () => contractService.getSignatureRequest(workspaceSlug, requestId),
    { revalidateOnFocus: false }
  );

  // Template configuration returns to the template it belongs to; everything
  // else returns to the tracking list focused on this contract.
  const returnTo = searchParams.get("returnTo");
  const leave = () =>
    navigate(returnTo ?? `/${workspaceSlug}/file-library/contracts/documents?request=${requestId}`, {
      replace: true,
    });

  return (
    <>
      <PageHead title={t("file_library.contracts.workflow.page_titles.editor")} />
      {isLoading && !request ? (
        <div className="grid h-full place-items-center">
          <Loader2 className="size-5 animate-spin text-tertiary" />
        </div>
      ) : error || !request ? (
        <ContractEmptyState
          className="h-full"
          icon={<AlertTriangle className="size-5" />}
          title={t("file_library.contracts.workflow.request_peek.not_found")}
          action={
            <Button
              variant="secondary"
              size="sm"
              onClick={() => navigate(`/${workspaceSlug}/file-library/contracts/documents`)}
            >
              {t("file_library.contracts.workflow.authoring.back_to_contracts")}
            </Button>
          }
        />
      ) : (
        <ContractAuthoringEditor
          workspaceSlug={workspaceSlug}
          signatureRequest={request}
          // `onSent` only refreshes — leaving is `onClose`, so the "no email"
          // flow can still show its signing links before the route unmounts.
          onSent={() => void mutate()}
          onClose={leave}
        />
      )}
    </>
  );
}
