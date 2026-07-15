import { observer } from "mobx-react";
import { Navigate } from "react-router";
import { EUserPermissions, EUserPermissionsLevel } from "@plane/constants";
import { PageHead } from "@/components/core/page-title";
import { MusicCatalogRoot } from "@/components/music-catalog/root";
import { useUserPermissions } from "@/hooks/store/user";
import { useWorkspace } from "@/hooks/store/use-workspace";
import type { Route } from "./+types/page";

const MusicCatalogPage = observer(function MusicCatalogPage({ params }: Route.ComponentProps) {
  const { workspaceSlug } = params;
  const { isWorkspaceFeatureEnabled, featureFlagsMap } = useWorkspace();
  const { allowPermissions, workspaceInfoBySlug } = useUserPermissions();
  const flagsLoaded = featureFlagsMap[workspaceSlug] !== undefined;
  const roleLoaded = workspaceInfoBySlug(workspaceSlug) !== undefined;
  const enabled = isWorkspaceFeatureEnabled(workspaceSlug, "music_catalog");
  const isAdmin = allowPermissions([EUserPermissions.ADMIN], EUserPermissionsLevel.WORKSPACE);

  if (flagsLoaded && roleLoaded && (!enabled || !isAdmin)) return <Navigate to={`/${workspaceSlug}`} replace />;

  return (
    <>
      <PageHead title="Music catalog" />
      <div className="relative h-full w-full overflow-hidden">
        <MusicCatalogRoot workspaceSlug={workspaceSlug} />
      </div>
    </>
  );
});

export default MusicCatalogPage;
