/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { FileCheck2, FileText, Files, LayoutTemplate, Sparkles } from "lucide-react";
import { useLocation, useParams } from "react-router";
import { useTranslation } from "@plane/i18n";
import { Breadcrumbs, Header } from "@plane/ui";
// components
import { BreadcrumbLink } from "@/components/common/breadcrumb-link";

export const FileLibraryHeader = observer(function FileLibraryHeader() {
  const { t } = useTranslation();
  const { workspaceSlug } = useParams();
  const { pathname } = useLocation();
  const isContracts = pathname.includes("/file-library/contracts");
  const isAnalyzedContracts = pathname.includes("/file-library/contracts/analyzed");
  const isContractTemplates = pathname.includes("/file-library/contracts/templates");
  const isContractDocuments = pathname.includes("/file-library/contracts/documents");
  const isTemplateDetail = /\/file-library\/contracts\/templates\/[^/]+/.test(pathname);

  return (
    <Header>
      <Header.LeftItem>
        <div className="flex items-center gap-2.5">
          <Breadcrumbs>
            <Breadcrumbs.Item
              component={
                <BreadcrumbLink
                  href={isContracts ? `/${workspaceSlug}/file-library` : undefined}
                  label={t("sidebar.library")}
                  icon={<Files className="h-4 w-4 text-tertiary" />}
                />
              }
            />
            {isContracts && (
              <Breadcrumbs.Item
                component={
                  <BreadcrumbLink
                    href={
                      isAnalyzedContracts || isContractTemplates || isContractDocuments
                        ? `/${workspaceSlug}/file-library/contracts/analyzed`
                        : undefined
                    }
                    label={t("file_library.contracts.title")}
                    icon={<FileText className="h-4 w-4 text-tertiary" />}
                  />
                }
              />
            )}
            {isAnalyzedContracts && (
              <Breadcrumbs.Item
                component={
                  <BreadcrumbLink label="Analizados con IA" icon={<Sparkles className="h-4 w-4 text-tertiary" />} />
                }
              />
            )}
            {isContractTemplates && (
              <Breadcrumbs.Item
                component={
                  <BreadcrumbLink
                    href={isTemplateDetail ? `/${workspaceSlug}/file-library/contracts/templates` : undefined}
                    label="Plantillas"
                    icon={<LayoutTemplate className="h-4 w-4 text-tertiary" />}
                  />
                }
              />
            )}
            {isTemplateDetail && (
              <Breadcrumbs.Item
                component={
                  <BreadcrumbLink label="Detalle de plantilla" icon={<FileText className="h-4 w-4 text-tertiary" />} />
                }
              />
            )}
            {isContractDocuments && (
              <Breadcrumbs.Item
                component={
                  <BreadcrumbLink label="Contratos creados" icon={<FileCheck2 className="h-4 w-4 text-tertiary" />} />
                }
              />
            )}
          </Breadcrumbs>
        </div>
      </Header.LeftItem>
    </Header>
  );
});
