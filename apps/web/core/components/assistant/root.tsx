/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * Workspace AI assistant: assistant-ui runtime over the Django streaming
 * proxy (which forwards to the Cloudflare Worker agent). Tool calls render
 * with dedicated UIs; mutations are applied via REST buttons, not the model.
 */

import { useMemo } from "react";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { AssistantChatTransport, useChatRuntime } from "@assistant-ui/react-ai-sdk";
// plane imports
import { API_BASE_URL } from "@plane/constants";
// local imports
import { AssistantThread } from "./thread";
import {
  buildProposeMusicImportToolUI,
  ExportMusicExcelToolUI,
  ListMusicFilesToolUI,
  QueryMusicTracksToolUI,
  SearchContractsToolUI,
  UpdateMusicTrackToolUI,
} from "./tool-uis";

type Props = {
  workspaceSlug: string;
};

export function AssistantRoot({ workspaceSlug }: Props) {
  const transport = useMemo(
    () =>
      new AssistantChatTransport({
        api: `${API_BASE_URL}/api/workspaces/${workspaceSlug}/assistant/chat/`,
        credentials: "include",
      }),
    [workspaceSlug]
  );
  const runtime = useChatRuntime({ transport });
  const ProposeMusicImportToolUI = useMemo(() => buildProposeMusicImportToolUI(workspaceSlug), [workspaceSlug]);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <QueryMusicTracksToolUI />
      <ExportMusicExcelToolUI />
      <SearchContractsToolUI />
      <ListMusicFilesToolUI />
      <ProposeMusicImportToolUI />
      <UpdateMusicTrackToolUI />
      <AssistantThread />
    </AssistantRuntimeProvider>
  );
}
