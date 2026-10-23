/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * The assistant is a side panel now. Old links to /assistant open the panel
 * and land on the workspace home.
 */

import { useEffect } from "react";
import { observer } from "mobx-react";
import { Navigate } from "react-router";
import { useAppTheme } from "@/hooks/store/use-app-theme";
import type { Route } from "./+types/page";

const AssistantPage = observer(function AssistantPage({ params }: Route.ComponentProps) {
  const { workspaceSlug } = params;
  const { toggleAssistantPanel } = useAppTheme();
  useEffect(() => toggleAssistantPanel(true), [toggleAssistantPanel]);
  return <Navigate to={`/${workspaceSlug}/`} replace />;
});

export default AssistantPage;
