import { observer } from "mobx-react";
import { Disc3, FileUp } from "lucide-react";
import { useLocation, useParams } from "react-router";
import { useTranslation } from "@plane/i18n";
import { Breadcrumbs, Header } from "@plane/ui";
import { BreadcrumbLink } from "@/components/common/breadcrumb-link";

export const MusicCatalogHeader = observer(function MusicCatalogHeader() {
  const { t } = useTranslation();
  const { workspaceSlug } = useParams();
  const { pathname } = useLocation();
  const isImport = pathname.includes("/music/import");

  return (
    <Header>
      <Header.LeftItem>
        <Breadcrumbs>
          <Breadcrumbs.Item
            component={
              <BreadcrumbLink
                href={isImport ? `/${workspaceSlug}/music` : undefined}
                label={t("music_import.catalog")}
                icon={<Disc3 className="size-4 text-tertiary" />}
              />
            }
          />
          {isImport && (
            <Breadcrumbs.Item
              component={
                <BreadcrumbLink
                  label={t("music_import.breadcrumb")}
                  icon={<FileUp className="size-4 text-tertiary" />}
                />
              }
            />
          )}
        </Breadcrumbs>
      </Header.LeftItem>
    </Header>
  );
});
