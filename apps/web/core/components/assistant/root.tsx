/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * Workspace AI assistant: assistant-ui runtime over the Django streaming
 * proxy (which forwards to the Cloudflare Worker agent). Tool calls render
 * with dedicated UIs; mutations are applied via REST buttons, not the model.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { AssistantRuntimeProvider, CompositeAttachmentAdapter } from "@assistant-ui/react";
import { AssistantChatTransport, useChatRuntime } from "@assistant-ui/react-ai-sdk";
// plane imports
import { API_BASE_URL } from "@plane/constants";
// local imports
import { FileLibraryAttachmentAdapter } from "./attachments";
import { AssistantThread, AssistantThreadList } from "./thread";
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

type TChatModels = {
  models: { id: string; provider: "deepseek" | "gemini" }[];
  default_model: string;
};

export function AssistantRoot({ workspaceSlug }: Props) {
  // Selected model rides each request through the transport's dynamic body;
  // the ref keeps the transport identity stable across selections.
  const [model, setModel] = useState<string | null>(null);
  const modelRef = useRef<string | null>(null);
  modelRef.current = model;

  const { data: chatModels } = useSWR<TChatModels>(
    `ASSISTANT_MODELS_${workspaceSlug}`,
    () =>
      fetch(`${API_BASE_URL}/api/workspaces/${workspaceSlug}/assistant/models/`, { credentials: "include" }).then(
        (response) => response.json()
      ),
    { revalidateOnFocus: false }
  );

  // Empty selection = let the worker pick its ASSISTANT_AI_PROVIDER default
  useEffect(() => {
    if (model === null && chatModels?.default_model) setModel(chatModels.default_model);
  }, [chatModels, model]);

  const transport = useMemo(
    () =>
      new AssistantChatTransport({
        api: `${API_BASE_URL}/api/workspaces/${workspaceSlug}/assistant/chat/`,
        credentials: "include",
        body: () => ({ model: modelRef.current ?? undefined }),
      }),
    [workspaceSlug]
  );
  // Attachments upload to the file library so the agent can chain the
  // asset_id straight into propose_music_import
  const adapters = useMemo(
    () => ({ attachments: new CompositeAttachmentAdapter([new FileLibraryAttachmentAdapter(workspaceSlug)]) }),
    [workspaceSlug]
  );
  const runtime = useChatRuntime({ transport, adapters });
  const ProposeMusicImportToolUI = useMemo(() => buildProposeMusicImportToolUI(workspaceSlug), [workspaceSlug]);

  const modelSelector = (chatModels?.models?.length ?? 0) > 0 && (
    <select
      value={model ?? ""}
      onChange={(event) => setModel(event.target.value)}
      className="rounded-sm border border-subtle bg-transparent px-1.5 py-1 text-11 text-tertiary"
      title="Modelo de IA"
    >
      {chatModels?.models.map((option) => (
        <option key={option.id} value={option.id}>
          {option.id} ({option.provider})
        </option>
      ))}
    </select>
  );

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <QueryMusicTracksToolUI />
      <ExportMusicExcelToolUI />
      <SearchContractsToolUI />
      <ListMusicFilesToolUI />
      <ProposeMusicImportToolUI />
      <UpdateMusicTrackToolUI />
      <div className="flex h-full min-h-0">
        <div className="hidden md:flex">
          <AssistantThreadList />
        </div>
        <AssistantThread composerAccessory={modelSelector || undefined} />
      </div>
    </AssistantRuntimeProvider>
  );
}
