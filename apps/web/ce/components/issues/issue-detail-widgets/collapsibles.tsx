/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useRef } from "react";
import { observer } from "mobx-react";
// plane imports
import { useTranslation } from "@plane/i18n";
import type { TIssueServiceType, TWorkItemWidgets } from "@plane/types";
import { Collapsible, CollapsibleButton } from "@plane/ui";
// hooks
import { ReferencesContent, useEntityReferences } from "@/components/references/references-section";
import { useIssueDetail } from "@/hooks/store/use-issue-detail";
import { useWorkspace } from "@/hooks/store/use-workspace";

export type TWorkItemAdditionalWidgetCollapsiblesProps = {
  disabled: boolean;
  hideWidgets: TWorkItemWidgets[];
  issueServiceType: TIssueServiceType;
  projectId: string;
  workItemId: string;
  workspaceSlug: string;
};

/** "Referencias": contracts, songs, files… this work item mentions or has
 * attached, and the work items and pages that mention it. */
export const WorkItemAdditionalWidgetCollapsibles = observer(function WorkItemAdditionalWidgetCollapsibles(
  props: TWorkItemAdditionalWidgetCollapsiblesProps
) {
  const { disabled, hideWidgets, issueServiceType, workItemId, workspaceSlug } = props;
  const { t } = useTranslation();
  const { isWorkspaceFeatureEnabled } = useWorkspace();
  const {
    openWidgets,
    toggleOpenWidget,
    issue: { getIssueById },
  } = useIssueDetail(issueServiceType);
  const enabled = isWorkspaceFeatureEnabled(workspaceSlug, "references") && !hideWidgets.includes("references");
  const { data, mutate } = useEntityReferences(workspaceSlug, "issue", workItemId, enabled);

  // Mentions are read from the saved description in the background, a moment
  // after each save: look again shortly after the description changes.
  const issue = getIssueById(workItemId);
  const saved = `${issue?.updated_at ?? ""}|${issue?.description_html?.length ?? 0}`;
  const lastSaved = useRef(saved);
  useEffect(() => {
    if (!enabled || lastSaved.current === saved) return;
    lastSaved.current = saved;
    const timers = [2000, 6000].map((delay) => setTimeout(() => void mutate(), delay));
    return () => timers.forEach(clearTimeout);
  }, [saved, enabled, mutate]);
  const count = (data?.outgoing.length ?? 0) + (data?.backlinks.length ?? 0);
  if (!enabled || count === 0) return null;

  const isOpen = openWidgets.includes("references");
  return (
    <Collapsible
      isOpen={isOpen}
      onToggle={() => toggleOpenWidget("references")}
      title={
        <CollapsibleButton
          isOpen={isOpen}
          title={t("references.section.title")}
          indicatorElement={
            <span className="flex items-center justify-center">
              <p className="text-14 !leading-3 text-tertiary">{count}</p>
            </span>
          }
        />
      }
      buttonClassName="w-full"
    >
      <ReferencesContent workspaceSlug={workspaceSlug} source="issue" sourceId={workItemId} disabled={disabled} />
    </Collapsible>
  );
});
