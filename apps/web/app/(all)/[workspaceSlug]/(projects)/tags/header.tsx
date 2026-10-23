import { observer } from "mobx-react";
import { Tags } from "lucide-react";
import { useParams } from "react-router";
import { useTranslation } from "@plane/i18n";
import { Breadcrumbs, Header } from "@plane/ui";
import { BreadcrumbLink } from "@/components/common/breadcrumb-link";
import { useSharedTags } from "@/components/references/use-shared-tags";

export const SharedTagsHeader = observer(function SharedTagsHeader() {
  const { t } = useTranslation();
  const { workspaceSlug, tagId } = useParams();
  // The open tag's name (the list is already cached by the page).
  const { data: tags } = useSharedTags(workspaceSlug, Boolean(tagId));
  const current = tags?.find((tag) => tag.id === tagId);

  return (
    <Header>
      <Header.LeftItem>
        <Breadcrumbs>
          <Breadcrumbs.Item
            component={
              <BreadcrumbLink
                href={tagId ? `/${workspaceSlug}/tags` : undefined}
                label={t("references.tags.title")}
                icon={<Tags className="size-4 text-tertiary" />}
              />
            }
          />
          {current && <Breadcrumbs.Item component={<BreadcrumbLink label={current.name} isLast />} isLast />}
        </Breadcrumbs>
      </Header.LeftItem>
    </Header>
  );
});
