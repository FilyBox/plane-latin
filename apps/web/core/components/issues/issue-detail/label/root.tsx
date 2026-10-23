/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useMemo } from "react";
import { observer } from "mobx-react";
import { useTranslation } from "@plane/i18n";
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
import type { IIssueLabel, TIssue, TIssueServiceType } from "@plane/types";
import { EIssueServiceType } from "@plane/types";
// components
// hooks
import { useIssueDetail } from "@/hooks/store/use-issue-detail";
import { useLabel } from "@/hooks/store/use-label";
import { useProjectInbox } from "@/hooks/store/use-project-inbox";
// ui
// types
import { SharedTagChip } from "@/components/references/shared-tag-chip";
import { createSharedTag, useEntityTags, useSharedTags } from "@/components/references/use-shared-tags";
import { useWorkspace } from "@/hooks/store/use-workspace";
import { LabelList, IssueLabelSelectRoot } from "./";
// TODO: Fix this import statement, as core should not import from ee

export type TIssueLabel = {
  workspaceSlug: string;
  projectId: string;
  issueId: string;
  disabled: boolean;
  isInboxIssue?: boolean;
  onLabelUpdate?: (labelIds: string[]) => void;
  issueServiceType?: TIssueServiceType;
};

export type TLabelOperations = {
  updateIssue: (workspaceSlug: string, projectId: string, issueId: string, data: Partial<TIssue>) => Promise<void>;
  createLabel: (workspaceSlug: string, projectId: string, data: Partial<IIssueLabel>) => Promise<any>;
};

export const IssueLabel = observer(function IssueLabel(props: TIssueLabel) {
  const {
    workspaceSlug,
    projectId,
    issueId,
    disabled = false,
    isInboxIssue = false,
    onLabelUpdate,
    issueServiceType = EIssueServiceType.ISSUES,
  } = props;
  const { t } = useTranslation();
  // hooks
  const { updateIssue } = useIssueDetail(issueServiceType);
  const { createLabel } = useLabel();
  const {
    issue: { getIssueById },
  } = useIssueDetail(issueServiceType);
  const { getIssueInboxByIssueId } = useProjectInbox();

  const issue = isInboxIssue ? getIssueInboxByIssueId(issueId)?.issue : getIssueById(issueId);
  // Workspace tags sit beside project labels in the same field, saved on
  // their own: project labels stay exactly as Plane stores them.
  const { isWorkspaceFeatureEnabled } = useWorkspace();
  const sharedEnabled = !onLabelUpdate && isWorkspaceFeatureEnabled(workspaceSlug, "references");
  const { data: workspaceTags = [] } = useSharedTags(workspaceSlug, sharedEnabled && !disabled);
  const { data: issueTags = [], setTags } = useEntityTags(workspaceSlug, "issue", issueId, sharedEnabled);
  const saveTags = async (tagIds: string[]) => {
    try {
      await setTags(tagIds);
    } catch {
      setToast({
        title: t("toast.error"),
        type: TOAST_TYPE.ERROR,
        message: t("entity.update.failed", { entity: t("issue.label", { count: 1 }) }),
      });
    }
  };

  const labelOperations: TLabelOperations = useMemo(
    () => ({
      updateIssue: async (slug: string, project: string, itemId: string, data: Partial<TIssue>) => {
        try {
          if (onLabelUpdate) onLabelUpdate(data.label_ids || []);
          else await updateIssue(slug, project, itemId, data);
        } catch (_error) {
          setToast({
            title: t("toast.error"),
            type: TOAST_TYPE.ERROR,
            message: t("entity.update.failed", { entity: t("issue.label", { count: 1 }) }),
          });
        }
      },
      createLabel: async (slug: string, project: string, data: Partial<IIssueLabel>) => {
        try {
          const labelResponse = await createLabel(slug, project, data);
          if (!isInboxIssue)
            setToast({
              title: t("toast.success"),
              type: TOAST_TYPE.SUCCESS,
              message: t("label.create.success"),
            });
          return labelResponse;
        } catch (error) {
          let errMessage = t("label.create.failed");
          if (error && (error as any).error === "Label with the same name already exists in the project")
            errMessage = t("label.create.already_exists");

          setToast({
            title: t("toast.error"),
            type: TOAST_TYPE.ERROR,
            message: errMessage,
          });
          throw error;
        }
      },
    }),
    [updateIssue, createLabel, onLabelUpdate, isInboxIssue, t]
  );

  return (
    <div className="relative flex min-h-7.5 w-full flex-wrap items-center gap-1 px-2">
      <LabelList
        workspaceSlug={workspaceSlug}
        projectId={projectId}
        issueId={issueId}
        values={issue?.label_ids || []}
        labelOperations={labelOperations}
        disabled={disabled}
      />
      {issueTags.map((tag) => (
        <SharedTagChip
          key={tag.id}
          tag={tag}
          onRemove={
            disabled
              ? undefined
              : () => void saveTags(issueTags.filter((item) => item.id !== tag.id).map((item) => item.id))
          }
        />
      ))}

      {!disabled && (
        <IssueLabelSelectRoot
          workspaceSlug={workspaceSlug}
          projectId={projectId}
          issueId={issueId}
          values={issue?.label_ids || []}
          labelOperations={labelOperations}
          shared={
            sharedEnabled
              ? {
                  tags: workspaceTags,
                  values: issueTags.map((tag) => tag.id),
                  onChange: (tagIds) => void saveTags(tagIds),
                  onCreate: (name) => createSharedTag(workspaceSlug, name),
                }
              : undefined
          }
        />
      )}
    </div>
  );
});
