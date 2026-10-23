/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import { observer } from "mobx-react";
import { AtSign } from "lucide-react";
// plane imports
import { useTranslation } from "@plane/i18n";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TIssueServiceType, TWorkItemWidgets } from "@plane/types";
// components
import { IssueDetailWidgetButton } from "@/components/issues/issue-detail-widgets/widget-button";
import { EntityPickerModal } from "@/components/references/entity-picker-modal";
import { attachReference, useEntityReferences } from "@/components/references/references-section";
// hooks
import { useIssueDetail } from "@/hooks/store/use-issue-detail";
import { useWorkspace } from "@/hooks/store/use-workspace";

export type TWorkItemAdditionalWidgetActionButtonsProps = {
  disabled: boolean;
  hideWidgets: TWorkItemWidgets[];
  issueServiceType: TIssueServiceType;
  projectId: string;
  workItemId: string;
  workspaceSlug: string;
};

/** "Referenciar": attach a contract, song, file… from anywhere in the workspace. */
export const WorkItemAdditionalWidgetActionButtons = observer(function WorkItemAdditionalWidgetActionButtons(
  props: TWorkItemAdditionalWidgetActionButtonsProps
) {
  const { disabled, hideWidgets, issueServiceType, workItemId, workspaceSlug } = props;
  const { t } = useTranslation();
  const { isWorkspaceFeatureEnabled } = useWorkspace();
  const { openWidgets, toggleOpenWidget } = useIssueDetail(issueServiceType);
  const [isOpen, setIsOpen] = useState(false);
  const enabled = isWorkspaceFeatureEnabled(workspaceSlug, "references") && !hideWidgets.includes("references");
  const { data } = useEntityReferences(workspaceSlug, "issue", workItemId, enabled);
  if (!enabled) return null;

  const attached = (data?.outgoing ?? [])
    .filter((card) => card.kinds?.includes("attachment"))
    .map((card) => `${card.entity_name}:${card.id}`);

  return (
    <>
      <button type="button" disabled={disabled} onClick={() => setIsOpen(true)}>
        <IssueDetailWidgetButton
          title={t("references.attach")}
          icon={<AtSign className="h-3.5 w-3.5 flex-shrink-0" strokeWidth={2} />}
          disabled={disabled}
        />
      </button>
      <EntityPickerModal
        workspaceSlug={workspaceSlug}
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        selectedKeys={attached}
        onPick={async (card) => {
          try {
            await attachReference(workspaceSlug, "issue", workItemId, card);
            if (!openWidgets.includes("references")) toggleOpenWidget("references");
            setToast({ type: TOAST_TYPE.SUCCESS, title: t("references.toasts.attached", { name: card.title }) });
          } catch {
            setToast({ type: TOAST_TYPE.ERROR, title: t("references.toasts.error") });
          }
        }}
      />
    </>
  );
});
