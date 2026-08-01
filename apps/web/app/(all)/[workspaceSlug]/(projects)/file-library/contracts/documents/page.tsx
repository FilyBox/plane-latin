/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useParams } from "react-router";
import { PageHead } from "@/components/core/page-title";
import { ContractDocuments } from "@/components/file-library/contracts/contract-documents";

export default function ContractDocumentsPage() {
  const { workspaceSlug = "" } = useParams();
  return (
    <>
      <PageHead title="Contratos creados" />
      <ContractDocuments workspaceSlug={workspaceSlug} />
    </>
  );
}
