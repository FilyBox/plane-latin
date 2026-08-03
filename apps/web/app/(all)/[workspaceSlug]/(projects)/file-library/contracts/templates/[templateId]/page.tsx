/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useParams } from "react-router";
import { useTranslation } from "@plane/i18n";
import { PageHead } from "@/components/core/page-title";
import { ContractTemplateDetail } from "@/components/file-library/contracts/contract-template-detail";

export default function ContractTemplateDetailPage() {
  const { t } = useTranslation();
  const { workspaceSlug = "", templateId = "" } = useParams();
  return (
    <>
      <PageHead title={t("file_library.contracts.workflow.page_titles.template_detail")} />
      <ContractTemplateDetail workspaceSlug={workspaceSlug} templateId={templateId} />
    </>
  );
}
