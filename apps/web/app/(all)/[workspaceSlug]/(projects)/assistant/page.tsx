import { observer } from "mobx-react";
import { Navigate } from "react-router";
import { PageHead } from "@/components/core/page-title";
import { AssistantRoot } from "@/components/assistant/root";
import { useWorkspace } from "@/hooks/store/use-workspace";
import type { Route } from "./+types/page";

const AssistantPage = observer(function AssistantPage({ params }: Route.ComponentProps) {
  const { workspaceSlug } = params;
  const { isWorkspaceFeatureEnabled, featureFlagsMap } = useWorkspace();
  const flagsLoaded = featureFlagsMap[workspaceSlug] !== undefined;
  // The assistant spans the AI modules: available when either flag is on
  const enabled =
    isWorkspaceFeatureEnabled(workspaceSlug, "file_library") ||
    isWorkspaceFeatureEnabled(workspaceSlug, "music_catalog");

  if (flagsLoaded && !enabled) return <Navigate to={`/${workspaceSlug}`} replace />;

  return (
    <>
      <PageHead title="Asistente" />
      <div className="relative h-full w-full overflow-hidden">
        <AssistantRoot workspaceSlug={workspaceSlug} />
      </div>
    </>
  );
});

export default AssistantPage;
