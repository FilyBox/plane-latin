import { useEffect, useState } from "react";
import { observer } from "mobx-react";
import { Navigate, useSearchParams } from "react-router";
import { EUserPermissions, EUserPermissionsLevel } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { PageHead } from "@/components/core/page-title";
import { AIMappingPanel } from "@/components/references/tags/ai-mapping-panel";
import { SharedTagsRoot } from "@/components/references/tags/tags-root";
import { useUserPermissions } from "@/hooks/store/user";
import { useWorkspace } from "@/hooks/store/use-workspace";
import type { Route } from "./+types/page";

const SharedTagsPage = observer(function SharedTagsPage({ params }: Route.ComponentProps) {
  const { workspaceSlug, tagId } = params;
  const { t } = useTranslation();
  const { isWorkspaceFeatureEnabled, featureFlagsMap } = useWorkspace();
  const flagsLoaded = featureFlagsMap[workspaceSlug] !== undefined;
  // The AI mapping touches every module's tags at once: admins only.
  const { allowPermissions } = useUserPermissions();
  const isAdmin = allowPermissions([EUserPermissions.ADMIN], EUserPermissionsLevel.WORKSPACE);
  // ?mapping=1 (the assistant's "review" button) opens the AI mapping panel.
  const [searchParams] = useSearchParams();
  const openMapping = searchParams.get("mapping") === "1";
  const [aiOpen, setAiOpen] = useState(openMapping);
  useEffect(() => {
    if (openMapping) setAiOpen(true);
  }, [openMapping, searchParams]);

  if (flagsLoaded && !isWorkspaceFeatureEnabled(workspaceSlug, "references"))
    return <Navigate to={`/${workspaceSlug}`} replace />;

  return (
    <>
      <PageHead title={t("references.tags.title")} />
      <div className="relative h-full w-full overflow-hidden">
        <SharedTagsRoot
          workspaceSlug={workspaceSlug}
          tagId={tagId}
          onMapWithAI={isAdmin ? () => setAiOpen(true) : undefined}
        />
      </div>
      {isAdmin && <AIMappingPanel workspaceSlug={workspaceSlug} isOpen={aiOpen} onClose={() => setAiOpen(false)} />}
    </>
  );
});

export default SharedTagsPage;
