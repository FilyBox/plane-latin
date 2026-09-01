/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * Contracts chat thread. Two things the previous version got wrong:
 *
 * - The agent answers in Markdown (headings, bold, tables) and this rendered
 *   it as raw text with visible `**` markers. Assistant turns now go through
 *   MarkdownTextPrimitive with GFM.
 * - Long tokens (file names, ids) and wide tables burst out of the bubble.
 *   Every level of the message column is now `min-w-0` with wrapping text, and
 *   wide blocks (pre/table) scroll inside their own container instead of
 *   stretching the thread.
 */

import type { PropsWithChildren, ReactNode } from "react";
import {
  ActionBarPrimitive,
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { motion } from "framer-motion";
import { AlertTriangle, ArrowUp, Bot, Copy, RefreshCw, Sparkles, Square, Wrench } from "lucide-react";
import remarkGfm from "remark-gfm";
// plane imports
import { useTranslation } from "@plane/i18n";

// Entrance animation used across the thread (mirrors the assistant-ui examples)
const messageMotion = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.25, ease: "easeOut" as const },
};

/**
 * GFM markdown at the repo's type scale.
 *
 * `break-words` plus the scrolling `pre`/`table` wrappers are what keep an
 * answer inside the chat column: without them a long unbroken token or a wide
 * table pushes the whole thread sideways.
 */
function MarkdownText() {
  return (
    <MarkdownTextPrimitive
      remarkPlugins={[remarkGfm]}
      className="[&_code]:font-mono min-w-0 break-words *:first:mt-0 *:last:mb-0 [&_a]:text-accent-primary [&_a]:underline [&_blockquote]:my-1.5 [&_blockquote]:border-l-2 [&_blockquote]:border-strong [&_blockquote]:pl-2 [&_code]:rounded-sm [&_code]:bg-layer-2 [&_code]:px-1 [&_code]:text-12 [&_h1]:mt-2 [&_h1]:text-14 [&_h1]:font-semibold [&_h2]:mt-2 [&_h2]:text-13 [&_h2]:font-semibold [&_h3]:mt-1.5 [&_h3]:text-13 [&_h3]:font-semibold [&_hr]:my-2 [&_hr]:border-subtle [&_li]:my-0.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1.5 [&_pre]:my-1.5 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-layer-2 [&_pre]:p-2 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:whitespace-pre [&_strong]:font-semibold [&_strong]:text-primary [&_table]:my-1.5 [&_table]:w-max [&_table]:min-w-full [&_table]:border-collapse [&_table]:text-12 [&_td]:border [&_td]:border-subtle [&_td]:px-2 [&_td]:py-1 [&_td]:align-top [&_th]:border [&_th]:border-subtle [&_th]:bg-layer-2 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_ul]:list-disc [&_ul]:pl-5 [&>div:has(>table)]:overflow-x-auto"
    />
  );
}

/**
 * Consecutive tool calls collapse into one block. Collapsed by default: the
 * agent may take a dozen steps to answer and the user wants the answer, with
 * the trail available on demand.
 */
function ToolGroup({ startIndex, endIndex, children }: PropsWithChildren<{ startIndex: number; endIndex: number }>) {
  const { t } = useTranslation();
  const count = endIndex - startIndex + 1;
  return (
    <motion.details {...messageMotion} className="my-1.5 min-w-0 rounded-md border border-subtle bg-layer-1">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-1.5 text-11 font-medium text-secondary [&::-webkit-details-marker]:hidden">
        <Wrench className="size-3 shrink-0 text-tertiary" />
        {t("file_library.contracts.chat.tools.steps", { count })}
      </summary>
      <div className="min-w-0 overflow-x-auto border-t border-subtle px-2.5 py-1">{children}</div>
    </motion.details>
  );
}

/** Unregistered tools still get a readable row */
function ToolFallback({ toolName }: { toolName: string }) {
  return (
    <p className="my-1 flex items-center gap-1.5 text-11 text-tertiary">
      <Wrench className="size-3 shrink-0" />
      <span className="break-all">{toolName}</span>
    </p>
  );
}

const PARTS_COMPONENTS = { Text: MarkdownText, ToolGroup, tools: { Fallback: ToolFallback } };

function UserMessage() {
  return (
    <MessagePrimitive.Root asChild>
      <motion.div {...messageMotion} className="flex justify-end px-3 py-1.5">
        <div className="max-w-[85%] min-w-0 overflow-hidden rounded-2xl rounded-br-sm bg-accent-primary/10 px-3.5 py-2 text-13 break-words whitespace-pre-wrap">
          <MessagePrimitive.Parts />
        </div>
      </motion.div>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  const { t } = useTranslation();
  return (
    <MessagePrimitive.Root asChild>
      <motion.div {...messageMotion} className="group flex min-w-0 gap-2.5 px-3 py-1.5">
        <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-primary/10 text-accent-primary">
          <Bot className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1 text-13 leading-relaxed">
          <MessagePrimitive.Parts components={PARTS_COMPONENTS} />
          <MessagePrimitive.Error>
            <ErrorPrimitive.Root className="mt-1.5 flex items-start gap-2 rounded-md border border-danger-strong bg-danger-subtle px-3 py-2 text-12 text-danger-primary">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <ErrorPrimitive.Message className="min-w-0 break-words" />
            </ErrorPrimitive.Root>
          </MessagePrimitive.Error>
          <ActionBarPrimitive.Root
            hideWhenRunning
            autohide="not-last"
            className="mt-1 flex h-6 items-center gap-0.5 text-tertiary opacity-0 transition-opacity group-hover:opacity-100"
          >
            <ActionBarPrimitive.Copy
              className="rounded-sm p-1 hover:bg-layer-1-hover"
              title={t("file_library.contracts.chat.copy_answer")}
            >
              <Copy className="size-3" />
            </ActionBarPrimitive.Copy>
            <ActionBarPrimitive.Reload
              className="rounded-sm p-1 hover:bg-layer-1-hover"
              title={t("file_library.contracts.chat.retry_answer")}
            >
              <RefreshCw className="size-3" />
            </ActionBarPrimitive.Reload>
          </ActionBarPrimitive.Root>
        </div>
      </motion.div>
    </MessagePrimitive.Root>
  );
}

type Props = {
  emptyTitle: string;
  emptyDescription: string;
  /** Prompt chips shown on an empty thread */
  suggestions?: string[];
  /** Extra composer controls (e.g. the model picker) */
  composerAccessory?: ReactNode;
};

/** Chat thread + composer (assistant-ui primitives, Plane styling) */
export function ContractChatThread(props: Props) {
  const { emptyTitle, emptyDescription, suggestions = [], composerAccessory } = props;
  const { t } = useTranslation();

  return (
    <ThreadPrimitive.Root className="flex h-full min-h-0 min-w-0 flex-col">
      <ThreadPrimitive.Viewport className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto py-2">
        <ThreadPrimitive.Empty>
          <motion.div
            initial={{ opacity: 0, scale: 0.97 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.3, ease: "easeOut" }}
            className="flex h-full flex-col items-center justify-center gap-2 px-6 py-8 text-center text-tertiary"
          >
            <Sparkles className="size-7 text-accent-primary" />
            <p className="text-14 font-medium text-secondary">{emptyTitle}</p>
            <p className="max-w-sm text-12">{emptyDescription}</p>
            {suggestions.length > 0 && (
              <div className="mt-2 flex max-w-md flex-wrap justify-center gap-1.5">
                {suggestions.map((suggestion) => (
                  <ThreadPrimitive.Suggestion
                    key={suggestion}
                    prompt={suggestion}
                    method="replace"
                    autoSend
                    className="rounded-full border border-subtle px-2.5 py-1 text-11 text-secondary transition-colors hover:border-accent-strong hover:text-accent-primary"
                  >
                    {suggestion}
                  </ThreadPrimitive.Suggestion>
                ))}
              </div>
            )}
          </motion.div>
        </ThreadPrimitive.Empty>
        <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
        <ThreadPrimitive.If running>
          <motion.div {...messageMotion} className="flex items-center gap-2 px-4 py-2 text-12 text-tertiary">
            <span className="grid size-3.5 shrink-0 grid-cols-2 gap-px" aria-hidden>
              {[0, 150, 300, 450].map((delay) => (
                <span
                  key={delay}
                  className="animate-pulse rounded-full bg-accent-primary"
                  style={{ animationDelay: `${delay}ms`, animationDuration: "900ms" }}
                />
              ))}
            </span>
            <span className="animate-pulse">{t("file_library.contracts.chat.thinking")}</span>
          </motion.div>
        </ThreadPrimitive.If>
      </ThreadPrimitive.Viewport>

      <div className="shrink-0 border-t border-subtle p-2.5">
        <ComposerPrimitive.Root className="rounded-lg border border-subtle bg-layer-1 px-3 py-2 transition-colors focus-within:border-accent-strong">
          <div className="flex items-end gap-2">
            <ComposerPrimitive.Input
              rows={1}
              placeholder={t("file_library.contracts.chat.placeholder")}
              className="max-h-32 min-h-6 min-w-0 flex-1 resize-none bg-transparent text-13 outline-none placeholder:text-tertiary"
            />
            <ThreadPrimitive.If running={false}>
              <ComposerPrimitive.Send
                className="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent-primary text-on-color transition-transform hover:scale-105 active:scale-95 disabled:opacity-40"
                title={t("file_library.contracts.chat.send")}
              >
                <ArrowUp className="size-4" />
              </ComposerPrimitive.Send>
            </ThreadPrimitive.If>
            <ThreadPrimitive.If running>
              <ComposerPrimitive.Cancel
                className="flex size-7 shrink-0 items-center justify-center rounded-full border border-subtle text-tertiary hover:bg-layer-1-hover"
                title={t("file_library.contracts.chat.stop")}
              >
                <Square className="size-3" />
              </ComposerPrimitive.Cancel>
            </ThreadPrimitive.If>
          </div>
          {composerAccessory && (
            <div className="mt-1.5 flex min-w-0 items-center justify-between gap-2">{composerAccessory}</div>
          )}
        </ComposerPrimitive.Root>
      </div>
    </ThreadPrimitive.Root>
  );
}
