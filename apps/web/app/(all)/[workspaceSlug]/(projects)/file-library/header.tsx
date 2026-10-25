/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import {
  BookOpen,
  CalendarCheck2,
  CalendarX2,
  FileCheck2,
  FileText,
  Files,
  LayoutTemplate,
  Settings2,
  Sparkles,
} from "lucide-react";
import { useLocation, useParams, useSearchParams } from "react-router";
import { useTranslation } from "@plane/i18n";
import { Breadcrumbs, Header } from "@plane/ui";
// components
import { BreadcrumbLink } from "@/components/common/breadcrumb-link";

/** The sidebar subsets of the analyzed list, each a leaf under "Contratos". */
const CONTRACT_VIEW_CRUMBS = [
  { segment: "vigentes", icon: CalendarCheck2 },
  { segment: "vencidos", icon: CalendarX2 },
  { segment: "editoriales", icon: BookOpen },
] as const;

export const FileLibraryHeader = observer(function FileLibraryHeader() {
  const { t } = useTranslation();
  const { workspaceSlug } = useParams();
  const { pathname } = useLocation();
  const [searchParams] = useSearchParams();
  const isContracts = pathname.includes("/file-library/contracts");
  const isAnalyzedContracts = pathname.includes("/file-library/contracts/analyzed");
  // Configuring a template's fields reuses the request editor route, but belongs under Plantillas.
  const isTemplateFieldEditor =
    pathname.includes("/file-library/contracts/documents/") && searchParams.get("mode") === "template";
  const isContractTemplates = pathname.includes("/file-library/contracts/templates") || isTemplateFieldEditor;
  const isContractDocuments = pathname.includes("/file-library/contracts/documents") && !isTemplateFieldEditor;
  const templateReturnTo = isTemplateFieldEditor ? searchParams.get("returnTo") : null;
  const isTemplateDetail = /\/file-library\/contracts\/templates\/[^/]+/.test(pathname);
  const contractView = CONTRACT_VIEW_CRUMBS.find(({ segment }) =>
    pathname.includes(`/file-library/contracts/${segment}`)
  );

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
                      isAnalyzedContracts || isContractTemplates || isContractDocuments || contractView
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
                  <BreadcrumbLink
                    label={t("file_library.contracts.workflow.navigation.ai_analysis")}
                    icon={<Sparkles className="h-4 w-4 text-tertiary" />}
                  />
                }
              />
            )}
            {contractView && (
              <Breadcrumbs.Item
                component={
                  <BreadcrumbLink
                    label={t(`file_library.contracts.workflow.navigation.${contractView.segment}`)}
                    icon={<contractView.icon className="h-4 w-4 text-tertiary" />}
                  />
                }
              />
            )}
            {isContractTemplates && (
              <Breadcrumbs.Item
                component={
                  <BreadcrumbLink
                    href={
                      isTemplateDetail || isTemplateFieldEditor
                        ? `/${workspaceSlug}/file-library/contracts/templates`
                        : undefined
                    }
                    label={t("file_library.contracts.workflow.navigation.templates")}
                    icon={<LayoutTemplate className="h-4 w-4 text-tertiary" />}
                  />
                }
              />
            )}
            {isTemplateDetail && (
              <Breadcrumbs.Item
                component={
                  <BreadcrumbLink
                    label={t("file_library.contracts.workflow.navigation.template_detail")}
                    icon={<FileText className="h-4 w-4 text-tertiary" />}
                  />
                }
              />
            )}
            {isTemplateFieldEditor && (
              <Breadcrumbs.Item
                component={
                  <BreadcrumbLink
                    href={templateReturnTo?.startsWith("/") ? templateReturnTo : undefined}
                    label={t("file_library.contracts.workflow.navigation.template_detail")}
                    icon={<FileText className="h-4 w-4 text-tertiary" />}
                  />
                }
              />
            )}
            {isTemplateFieldEditor && (
              <Breadcrumbs.Item
                component={
                  <BreadcrumbLink
                    label={t("file_library.contracts.workflow.template_config.page_title")}
                    icon={<Settings2 className="h-4 w-4 text-tertiary" />}
                  />
                }
              />
            )}
            {isContractDocuments && (
              <Breadcrumbs.Item
                component={
                  <BreadcrumbLink
                    label={t("file_library.contracts.workflow.navigation.created")}
                    icon={<FileCheck2 className="h-4 w-4 text-tertiary" />}
                  />
                }
              />
            )}
          </Breadcrumbs>
        </div>
      </Header.LeftItem>
    </Header>
  );
});
