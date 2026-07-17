/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * Workspace AI assistant: assistant-ui runtime over the Django streaming
 * proxy (which forwards to the Cloudflare Worker agent). Tool calls render
 * with dedicated UIs; mutations are applied via REST buttons, not the model.
 * Threads persist per workspace in localStorage (see thread-persistence).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import {
  AssistantRuntimeProvider,
  CompositeAttachmentAdapter,
  useRemoteThreadListRuntime,
} from "@assistant-ui/react";
import { AssistantChatTransport, useChatRuntime } from "@assistant-ui/react-ai-sdk";
// plane imports
import { API_BASE_URL } from "@plane/constants";
// local imports
import { FileLibraryAttachmentAdapter } from "./attachments";
import { AssistantContextDisplay } from "./context-display";
import { AssistantThread, AssistantThreadList } from "./thread";
import { createAssistantThreadListAdapter } from "./thread-persistence";
import {
  AskUserToolUI,
  buildProposeMusicImportToolUI,
  ExportMusicExcelToolUI,
  ListMusicFilesToolUI,
  QueryMusicTracksToolUI,
  ResolveDuplicatesToolUI,
  ResolveImportVariablesToolUI,
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

/** Tools without server-side execute: the run pauses until the user answers
 * in the dedicated card and the UI stores a result. */
const HUMAN_INPUT_TOOLS = ["ask_user", "resolve_import_variables", "resolve_duplicates"];

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
        body: () => ({ model: modelRef.current ?? undefined, locale: navigator.language }),
      }),
    [workspaceSlug]
  );
  // Attachments upload to the file library so the agent can chain the
  // asset_id straight into propose_music_import
  const adapters = useMemo(
    () => ({ attachments: new CompositeAttachmentAdapter([new FileLibraryAttachmentAdapter(workspaceSlug)]) }),
    [workspaceSlug]
  );

  // One chat runtime per thread; the remote-thread-list wrapper mounts it for
  // the active thread and restores its messages via the history adapter. The
  // wrapper reads the latest hook through a ref, so capturing transport and
  // adapters from render scope is safe.
  const useThreadChatRuntime = () =>
    useChatRuntime({
      transport,
      adapters,
      // Only a human answer may resume a paused run. Automatically resuming
      // server-executed tools creates an empty request loop after a run.
      sendAutomaticallyWhen: ({ messages }) => {
        const last = messages[messages.length - 1];
        if (!last || last.role !== "assistant") return false;
        const humanParts = last.parts.filter((part) =>
          HUMAN_INPUT_TOOLS.some(
            (name) => part.type === `tool-${name}` || (part.type === "dynamic-tool" && part.toolName === name)
          )
        );
        if (humanParts.length === 0) return false;
        return humanParts.every(
          (part) => "state" in part && (part.state === "output-available" || part.state === "output-error")
        );
      },
    });

  const threadListAdapter = useMemo(() => createAssistantThreadListAdapter(workspaceSlug), [workspaceSlug]);
  const runtime = useRemoteThreadListRuntime({ runtimeHook: useThreadChatRuntime, adapter: threadListAdapter });

  const ProposeMusicImportToolUI = useMemo(() => buildProposeMusicImportToolUI(workspaceSlug), [workspaceSlug]);

  const composerAccessory = (
    <div className="flex items-center gap-2">
      <AssistantContextDisplay model={model} />
      {(chatModels?.models?.length ?? 0) > 0 && (
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
      )}
    </div>
  );

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <QueryMusicTracksToolUI />
      <ExportMusicExcelToolUI />
      <SearchContractsToolUI />
      <ListMusicFilesToolUI />
      <ProposeMusicImportToolUI />
      <UpdateMusicTrackToolUI />
      <AskUserToolUI />
      <ResolveImportVariablesToolUI />
      <ResolveDuplicatesToolUI />
      <div className="flex h-full min-h-0">
        <div className="hidden md:flex">
          <AssistantThreadList />
        </div>
        <AssistantThread composerAccessory={composerAccessory} />
      </div>
    </AssistantRuntimeProvider>
  );
}
