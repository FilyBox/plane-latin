/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useParams } from "react-router";
import { PageHead } from "@/components/core/page-title";
import { ContractTemplateDetail } from "@/components/file-library/contracts/contract-template-detail";

export default function ContractTemplateDetailPage() {
  const { workspaceSlug = "", templateId = "" } = useParams();
  return (
    <>
      <PageHead title="Detalle de plantilla" />
      <ContractTemplateDetail workspaceSlug={workspaceSlug} templateId={templateId} />
    </>
  );
}
