/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * The assistant's conversation, laid out for a narrow side panel: answers run
 * full width (no avatar column eating space), lookups fold into one steps
 * block, wide tables scroll inside their own box, and links open in the app.
 */

import { useMemo } from "react";
import type { ComponentProps, ReactNode } from "react";
import {
  ActionBarPrimitive,
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  TextMessagePartProvider,
  ThreadPrimitive,
  useMessagePartText,
  useSmooth,
  useThread,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { AlertTriangle, ArrowUp, Copy, Pencil, RefreshCw, Sparkles, Square } from "lucide-react";
import remarkGfm from "remark-gfm";
import { useTranslation } from "@plane/i18n";
import { cn } from "@plane/utils";
import { AttachMenu, ComposerAttachmentsRow, MessageAttachmentsRow } from "./attachments";
import { GenerationLoader } from "./elements/generation-loader";
import { AssistantLink } from "./links";
import { useComposerMentions } from "./mention-composer";
import { MentionChip, MentionText, mentionFromHref, mentionsToLinks, streamingMentionsToLinks } from "./mentions";
import { FallbackStep, groupThought, ReasoningStep, ThinkingBlock, useIsMessageRunning } from "./steps";

const textOf = (children: ReactNode): string =>
  typeof children === "string" || typeof children === "number"
    ? String(children)
    : Array.isArray(children)
      ? children.map(textOf).join("")
      : "";

const MARKDOWN_COMPONENTS = {
  // react-markdown emits a bare <table>; without its own scroll box a wide
  // table pushes the whole panel sideways.
  table: ({ node: _node, className, ...props }: ComponentProps<"table"> & { node?: unknown }) => (
    <div className="my-2 max-w-full overflow-x-auto rounded-md border border-subtle">
      <table {...props} className={cn("w-max min-w-full border-collapse text-12", className)} />
    </div>
  ),
  a: ({ node: _node, ...props }: ComponentProps<"a"> & { node?: unknown }) => {
    const mention = mentionFromHref(props.href);
    if (mention) return <MentionChip type={mention.type} id={mention.id} label={textOf(props.children)} />;
    return <AssistantLink {...props} />;
  },
};

const REMARK_PLUGINS = [remarkGfm];

/** The typing reveal runs on the raw text and mentions become links after it.
 * The primitive's own `preprocess` runs before its reveal, so each finished
 * mention rewrote text already on screen: the reveal saw a text that no
 * longer extended the shown one and restarted from empty, so the whole answer
 * blinked out and retyped (and the scroll jumped) once per mention. */
function MarkdownText() {
  const { text, status } = useSmooth(useMessagePartText(), true);
  const running = status.type === "running";
  const shown = useMemo(() => (running ? streamingMentionsToLinks(text) : mentionsToLinks(text)), [text, running]);
  return (
    <TextMessagePartProvider text={shown} isRunning={running}>
      <MarkdownTextPrimitive
        smooth={false}
        remarkPlugins={REMARK_PLUGINS}
        components={MARKDOWN_COMPONENTS}
        className="min-w-0 text-13 leading-relaxed break-words text-primary *:first:mt-0 *:last:mb-0 [&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-strong [&_blockquote]:pl-2 [&_blockquote]:text-secondary [&_code]:rounded-sm [&_code]:bg-layer-2 [&_code]:px-1 [&_code]:text-12 [&_h1]:mt-3 [&_h1]:text-14 [&_h1]:font-semibold [&_h2]:mt-3 [&_h2]:text-13 [&_h2]:font-semibold [&_h3]:mt-2 [&_h3]:text-13 [&_h3]:font-medium [&_hr]:my-3 [&_hr]:border-subtle [&_li]:my-0.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_pre]:my-2 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-layer-2 [&_pre]:p-2 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_strong]:font-semibold [&_td]:border-t [&_td]:border-subtle [&_td]:px-2 [&_td]:py-1 [&_td]:align-top [&_th]:bg-layer-2 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-medium [&_th]:whitespace-nowrap [&_ul]:list-disc [&_ul]:pl-5"
      />
    </TextMessagePartProvider>
  );
}

/** Reasoning and lookups that sit next to each other form one "thinking"
 * block; the answer text and cards (export, import, edits) stay outside it. */
function AssistantParts() {
  return (
    <MessagePrimitive.GroupedParts groupBy={groupThought} indicator="never">
      {({ part, children }) => {
        switch (part.type) {
          case "group-thought":
            return <ThinkingBlock indices={part.indices}>{children}</ThinkingBlock>;
          case "text":
            return <MarkdownText />;
          case "reasoning":
            return <ReasoningStep text={part.text} />;
          case "tool-call":
            return (
              part.toolUI ?? (
                <FallbackStep
                  toolName={part.toolName}
                  status={part.status}
                  argsText={part.argsText}
                  result={part.result}
                />
              )
            );
          default:
            return null;
        }
      }}
    </MessagePrimitive.GroupedParts>
  );
}

const ICON_BUTTON = "rounded-md p-1 text-tertiary hover:bg-layer-1-hover hover:text-secondary";

function UserMessage() {
  const { t } = useTranslation();
  return (
    <MessagePrimitive.Root className="group flex flex-col items-end gap-1 px-4 py-1.5">
      <MessageAttachmentsRow />
      <div className="relative max-w-[88%] min-w-0">
        {/* Beside the bubble, never above or below it: showing it on hover
            must not move a single line of the conversation. */}
        <ActionBarPrimitive.Root
          hideWhenRunning
          autohide="never"
          className="absolute top-1/2 right-full mr-1 flex -translate-y-1/2 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100"
        >
          <ActionBarPrimitive.Edit className={ICON_BUTTON} title={t("assistant.edit")} aria-label={t("assistant.edit")}>
            <Pencil className="size-3" />
          </ActionBarPrimitive.Edit>
        </ActionBarPrimitive.Root>
        <div className="min-w-0 rounded-xl rounded-br-sm bg-accent-primary/10 px-3 py-2 text-13 break-words whitespace-pre-wrap text-primary">
          <MessagePrimitive.Parts components={USER_PARTS} />
        </div>
      </div>
    </MessagePrimitive.Root>
  );
}

const USER_PARTS = { Text: MentionText };

// Shared by each textarea and the chips layer drawn over it (same box metrics).
const COMPOSER_INPUT =
  "block max-h-40 min-h-10 w-full resize-none bg-transparent px-3 pt-2.5 text-13 leading-5 outline-none placeholder:text-placeholder";
const EDIT_INPUT = "block max-h-40 w-full resize-none bg-transparent text-13 leading-5 outline-none";

function EditComposer() {
  const { t } = useTranslation();
  const mentions = useComposerMentions({ decodeOnMount: true, inputClassName: EDIT_INPUT });
  return (
    <ComposerPrimitive.Root
      onSubmit={mentions.beforeSend}
      className="relative mx-4 my-2 rounded-lg border border-accent-strong bg-layer-1 p-2"
    >
      {mentions.popover}
      <div className="relative">
        <ComposerPrimitive.Input ref={mentions.inputRef} {...mentions.inputProps} />
        {mentions.overlay}
      </div>
      <div className="mt-1.5 flex justify-end gap-1.5">
        <ComposerPrimitive.Cancel className="rounded-md px-2 py-1 text-12 text-tertiary hover:bg-layer-1-hover">
          {t("cancel")}
        </ComposerPrimitive.Cancel>
        <ComposerPrimitive.Send
          onClick={mentions.beforeSend}
          className="rounded-md bg-accent-primary px-2 py-1 text-12 text-on-color"
        >
          {t("assistant.composer.send")}
        </ComposerPrimitive.Send>
      </div>
    </ComposerPrimitive.Root>
  );
}

function AssistantMessage() {
  const { t } = useTranslation();
  const running = useIsMessageRunning();
  return (
    <MessagePrimitive.Root className="group min-w-0 px-4 pt-1.5">
      <AssistantParts />
      <MessagePrimitive.Error>
        <ErrorPrimitive.Root className="mt-2 flex items-start gap-2 rounded-md border border-danger-strong bg-danger-subtle px-3 py-2 text-12 text-danger-primary">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <ErrorPrimitive.Message className="min-w-0 break-words" />
        </ErrorPrimitive.Root>
      </MessagePrimitive.Error>
      {/* Always laid out (as in Twenty's message footer); hover only changes
          its opacity, so the actions never push the conversation around. */}
      <ActionBarPrimitive.Root
        autohide="never"
        className={cn(
          "flex h-7 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100",
          running && "invisible"
        )}
      >
        <ActionBarPrimitive.Copy className={ICON_BUTTON} title={t("assistant.copy")} aria-label={t("assistant.copy")}>
          <Copy className="size-3" />
        </ActionBarPrimitive.Copy>
        <ActionBarPrimitive.Reload
          className={ICON_BUTTON}
          title={t("assistant.retry")}
          aria-label={t("assistant.retry")}
        >
          <RefreshCw className="size-3" />
        </ActionBarPrimitive.Reload>
      </ActionBarPrimitive.Root>
    </MessagePrimitive.Root>
  );
}

/** "Pensando…" only until the first part arrives: after that, the steps
 * block is the status. */
function Waiting() {
  const { t } = useTranslation();
  const waiting = useThread((thread) => {
    if (!thread.isRunning) return false;
    const last = thread.messages.at(-1);
    return last?.role !== "assistant" || last.content.length === 0;
  });
  if (!waiting) return null;
  return <GenerationLoader label={t("assistant.thinking")} className="px-4 py-2" />;
}

type Props = {
  suggestions: string[];
  /** Chips for what the assistant knows the user is looking at */
  contextBar?: ReactNode;
  /** Model picker and similar controls, bottom-left of the composer */
  composerAccessory?: ReactNode;
  /** Small status beside the send button (the balance ring) */
  composerTrailing?: ReactNode;
  allowAttachments: boolean;
};

export function AssistantThread({
  suggestions,
  contextBar,
  composerAccessory,
  composerTrailing,
  allowAttachments,
}: Props) {
  const { t } = useTranslation();
  const mentions = useComposerMentions({ inputClassName: COMPOSER_INPUT, listenForAsk: true });
  return (
    <ThreadPrimitive.Root className="flex h-full min-h-0 min-w-0 flex-col">
      <ThreadPrimitive.Viewport className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto py-2">
        <ThreadPrimitive.Empty>
          <div className="flex h-full flex-col justify-end px-4 pb-4">
            <Sparkles className="size-6 text-accent-primary" aria-hidden />
            <p className="mt-3 text-16 font-semibold text-primary">{t("assistant.empty.title")}</p>
            <p className="mt-1 text-13 text-tertiary">{t("assistant.empty.description")}</p>
            {suggestions.length > 0 && (
              <div className="mt-4 flex flex-col items-start gap-1.5">
                {suggestions.map((suggestion) => (
                  <ThreadPrimitive.Suggestion
                    key={suggestion}
                    prompt={suggestion}
                    method="replace"
                    autoSend
                    className="max-w-full truncate rounded-md border border-subtle px-2.5 py-1.5 text-left text-12 text-secondary hover:border-accent-strong hover:text-primary"
                  >
                    {suggestion}
                  </ThreadPrimitive.Suggestion>
                ))}
              </div>
            )}
          </div>
        </ThreadPrimitive.Empty>
        <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage, EditComposer }} />
        <Waiting />
      </ThreadPrimitive.Viewport>

      {/* Drop files anywhere on the composer to attach them. */}
      <ComposerPrimitive.AttachmentDropzone disabled={!allowAttachments} className="group/drop shrink-0 px-3 pt-1 pb-3">
        <ComposerPrimitive.Root
          onSubmit={mentions.beforeSend}
          className="relative rounded-xl border border-subtle bg-layer-1 transition-colors group-data-[dragging=true]/drop:border-dashed group-data-[dragging=true]/drop:border-accent-strong group-data-[dragging=true]/drop:bg-accent-primary/5 focus-within:border-accent-strong"
        >
          {mentions.popover}
          {contextBar}
          <ComposerAttachmentsRow />
          <div className="relative">
            <ComposerPrimitive.Input
              ref={mentions.inputRef}
              {...mentions.inputProps}
              rows={1}
              placeholder={t("assistant.composer.placeholder")}
              aria-label={t("assistant.composer.placeholder")}
            />
            {mentions.overlay}
          </div>
          <div className="flex items-center gap-1 px-2 pb-2">
            <AttachMenu
              allowUpload={allowAttachments}
              onPickFromWorkspace={() => mentions.startMention("file")}
              className={ICON_BUTTON}
            />
            <div className="min-w-0 flex-1">{composerAccessory}</div>
            {composerTrailing}
            <ThreadPrimitive.If running={false}>
              <ComposerPrimitive.Send
                onClick={mentions.beforeSend}
                className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-accent-primary text-on-color disabled:opacity-40"
                title={t("assistant.composer.send")}
                aria-label={t("assistant.composer.send")}
              >
                <ArrowUp className="size-4" />
              </ComposerPrimitive.Send>
            </ThreadPrimitive.If>
            <ThreadPrimitive.If running>
              <ComposerPrimitive.Cancel
                className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-subtle text-secondary hover:bg-layer-1-hover"
                title={t("assistant.composer.stop")}
                aria-label={t("assistant.composer.stop")}
              >
                <Square className="size-3 fill-current" />
              </ComposerPrimitive.Cancel>
            </ThreadPrimitive.If>
          </div>
        </ComposerPrimitive.Root>
      </ComposerPrimitive.AttachmentDropzone>
    </ThreadPrimitive.Root>
  );
}
