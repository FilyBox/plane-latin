/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useParams } from "react-router";
import { useTranslation } from "@plane/i18n";
import { PageHead } from "@/components/core/page-title";
import { ContractsRoot } from "@/components/file-library/contracts/root";

export default function AnalyzedContractsPage() {
  const { t } = useTranslation();
  const { workspaceSlug = "" } = useParams();
  return (
    <>
      <PageHead title={t("file_library.contracts.workflow.page_titles.analyzed")} />
      <ContractsRoot workspaceSlug={workspaceSlug} />
    </>
  );
}
