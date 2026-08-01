/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useParams } from "react-router";
import { PageHead } from "@/components/core/page-title";
import { ContractWorkflow } from "@/components/file-library/contracts/workflow";

export default function ContractTemplatesPage() {
  const { workspaceSlug = "" } = useParams();
  return (
    <>
      <PageHead title="Plantillas de contratos" />
      <ContractWorkflow workspaceSlug={workspaceSlug} />
    </>
  );
}
