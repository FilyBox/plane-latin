/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import { observer } from "mobx-react";

// plane internal packages
import { WEB_BASE_URL } from "@plane/constants";
import { NewTabIcon } from "@plane/propel/icons";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import { Tooltip } from "@plane/propel/tooltip";
import { ToggleSwitch } from "@plane/ui";
import { getFileURL } from "@plane/utils";
// hooks
import { useWorkspace } from "@/hooks/store";

type TWorkspaceListItemProps = {
  workspaceId: string;
};

export const WorkspaceListItem = observer(function WorkspaceListItem({ workspaceId }: TWorkspaceListItemProps) {
  // states
  const [updatingFeature, setUpdatingFeature] = useState<"file_library" | "payments" | null>(null);
  // store hooks
  const { getWorkspaceById, updateWorkspaceFeature } = useWorkspace();
  // derived values
  const workspace = getWorkspaceById(workspaceId);

  const handleFeatureToggle = async (
    key: "file_library" | "payments",
    currentValue: boolean | undefined,
    label: string
  ) => {
    if (!workspace || updatingFeature) return;
    const nextValue = !currentValue;
    setUpdatingFeature(key);
    try {
      await updateWorkspaceFeature(workspace.id, key, nextValue);
      setToast({
        type: TOAST_TYPE.SUCCESS,
        title: "Success",
        message: `${label} ${nextValue ? "enabled" : "disabled"} for ${workspace.name}`,
      });
    } catch {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: "Error",
        message: `Failed to update the ${label.toLowerCase()} feature`,
      });
    } finally {
      setUpdatingFeature(null);
    }
  };

  if (!workspace) return null;
  return (
    <a
      key={workspaceId}
      href={`${WEB_BASE_URL}/${encodeURIComponent(workspace.slug)}`}
      target="_blank"
      className="group flex items-center justify-between gap-2.5 truncate rounded-lg border border-subtle bg-layer-1 p-3 hover:border-subtle-1 hover:bg-layer-1-hover hover:shadow-raised-100"
      rel="noreferrer"
    >
      <div className="flex items-start gap-4">
        <span
          className={`relative mt-1 flex h-8 w-8 flex-shrink-0 items-center justify-center p-2 text-11 uppercase ${
            !workspace?.logo_url && "rounded-lg bg-accent-primary text-on-color"
          }`}
        >
          {workspace?.logo_url && workspace.logo_url !== "" ? (
            <img
              src={getFileURL(workspace.logo_url)}
              className="absolute top-0 left-0 h-full w-full rounded-sm object-cover"
              alt="Workspace Logo"
            />
          ) : (
            (workspace?.name?.[0] ?? "...")
          )}
        </span>
        <div className="flex flex-col items-start gap-1">
          <div className="flex w-full flex-wrap items-center gap-2.5">
            <h3 className={`text-14 font-medium capitalize`}>{workspace.name}</h3>/
            <Tooltip tooltipContent="The unique URL of your workspace">
              <h4 className="text-13 text-tertiary">[{workspace.slug}]</h4>
            </Tooltip>
          </div>
          {workspace.owner.email && (
            <div className="flex items-center gap-1 text-11">
              <h3 className="font-medium text-secondary">Owned by:</h3>
              <h4 className="text-tertiary">{workspace.owner.email}</h4>
            </div>
          )}
          <div className="flex items-center gap-2.5 text-11">
            {workspace.total_projects !== null && (
              <span className="flex items-center gap-1">
                <h3 className="font-medium text-secondary">Total projects:</h3>
                <h4 className="text-tertiary">{workspace.total_projects}</h4>
              </span>
            )}
            {workspace.total_members !== null && (
              <>
                •
                <span className="flex items-center gap-1">
                  <h3 className="font-medium text-secondary">Total members:</h3>
                  <h4 className="text-tertiary">{workspace.total_members}</h4>
                </span>
              </>
            )}
          </div>
        </div>
      </div>
      <div className="flex flex-shrink-0 items-center gap-4">
        {/* Not interactive itself — only shields the nested ToggleSwitches (already
            keyboard-accessible) from the parent anchor's click-to-navigate. Must use
            React's onClick (not a native addEventListener): React 17+ delegates all
            event handling from a single listener at the app root, relying on native
            bubbling to reach it. A native stopPropagation() on an intermediate node
            would swallow the event before React's root ever sees it, breaking every
            handler inside — including the switches themselves. */}
        {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events */}
        <div
          className="flex items-center gap-4"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          <Tooltip tooltipContent="Enable the file library + contracts module for this workspace">
            <div className={`flex items-center gap-2 ${updatingFeature === "file_library" ? "opacity-70" : ""}`}>
              <span className="text-11 font-medium text-secondary">File library</span>
              <ToggleSwitch
                value={Boolean(workspace.is_file_library_enabled)}
                onChange={() =>
                  handleFeatureToggle("file_library", workspace.is_file_library_enabled, "File library")
                }
                size="sm"
                disabled={updatingFeature !== null}
              />
            </div>
          </Tooltip>
          <Tooltip tooltipContent="Enable the payments (budgets + payroll) module for this workspace">
            <div className={`flex items-center gap-2 ${updatingFeature === "payments" ? "opacity-70" : ""}`}>
              <span className="text-11 font-medium text-secondary">Payments</span>
              <ToggleSwitch
                value={Boolean(workspace.is_payments_enabled)}
                onChange={() => handleFeatureToggle("payments", workspace.is_payments_enabled, "Payments")}
                size="sm"
                disabled={updatingFeature !== null}
              />
            </div>
          </Tooltip>
        </div>
        <NewTabIcon width={14} height={16} className="text-placeholder group-hover:text-secondary" />
      </div>
    </a>
  );
});
