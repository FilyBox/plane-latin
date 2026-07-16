/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * Styled Thread built on assistant-ui primitives (the repo's design system
 * instead of the shadcn starter kit): markdown text, grouped tool calls,
 * per-message errors, attachments and an in-memory thread list.
 */

import type { PropsWithChildren, ReactNode } from "react";
import { AlertTriangle, ArrowUp, Bot, MessageSquarePlus, Paperclip, Square, Trash2, Wrench } from "lucide-react";
import {
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  ThreadListItemPrimitive,
  ThreadListPrimitive,
  ThreadPrimitive,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import remarkGfm from "remark-gfm";
// local imports
import { ComposerAttachmentsRow, MessageAttachmentsRow } from "./attachments";

const SUGGESTIONS = [
  "¿Qué canciones se lanzaron este año?",
  "Canciones de un artista con sus ISRC y videos",
  "Genera un Excel de todo el catálogo",
  "¿Qué dice el contrato de X sobre regalías?",
];

/** Pulsing dot-matrix activity indicator (replaces spinner icons) */
export function DotMatrix({ className = "size-4" }: { className?: string }) {
  return (
    <span className={`grid shrink-0 grid-cols-3 gap-px ${className}`} role="status" aria-label="Trabajando…">
      {[0, 300, 600, 450, 0, 150, 600, 150, 300].map((delay, index) => (
        <span
          key={index}
          className="animate-pulse rounded-full bg-accent-primary"
          style={{ animationDelay: `${delay}ms`, animationDuration: "900ms" }}
        />
      ))}
    </span>
  );
}

/** Assistant text rendered as GFM markdown, styled to the repo's scale */
function MarkdownText() {
  return (
    <MarkdownTextPrimitive
      remarkPlugins={[remarkGfm]}
      className="[&_a]:text-accent-primary [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-strong [&_blockquote]:pl-2 [&_code]:rounded-sm [&_code]:bg-layer-2 [&_code]:px-1 [&_code]:font-mono [&_code]:text-12 [&_h1]:text-15 [&_h1]:font-semibold [&_h2]:text-14 [&_h2]:font-semibold [&_h3]:font-semibold [&_li]:my-0.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1.5 [&_pre]:my-1.5 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-layer-2 [&_pre]:p-2 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_table]:my-1.5 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-subtle [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-subtle [&_th]:bg-layer-2 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_ul]:list-disc [&_ul]:pl-5"
    />
  );
}

/** Consecutive tool calls collapse into one "acciones" block, chain-of-thought
 * style: activity indicator while the run is live, count when settled. */
function ToolGroup({ startIndex, endIndex, children }: PropsWithChildren<{ startIndex: number; endIndex: number }>) {
  const count = endIndex - startIndex + 1;
  return (
    <details className="my-1.5 rounded-md border border-subtle bg-layer-1" open>
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-12 font-medium text-secondary [&::-webkit-details-marker]:hidden">
        <ThreadPrimitive.If running>
          <DotMatrix className="size-3.5" />
        </ThreadPrimitive.If>
        <ThreadPrimitive.If running={false}>
          <Wrench className="size-3.5 text-tertiary" />
        </ThreadPrimitive.If>
        {count === 1 ? "1 acción" : `${count} acciones`}
      </summary>
      <div className="border-t border-subtle px-3 pb-2">{children}</div>
    </details>
  );
}

/** Unregistered tools still get a readable row (name + state) */
function ToolFallback({ toolName, status }: { toolName: string; status: { type: string } }) {
  return (
    <p className="my-1 flex items-center gap-1.5 text-12 text-tertiary">
      {status.type === "running" ? <DotMatrix className="size-3" /> : <Wrench className="size-3" />}
      {toolName}
    </p>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="flex gap-2.5 py-2">
      <span className="mt-1 flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-primary/10 text-accent-primary">
        <Bot className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1 text-13 leading-relaxed">
        <MessagePrimitive.Parts
          components={{ Text: MarkdownText, ToolGroup, tools: { Fallback: ToolFallback } }}
        />
        <MessagePrimitive.Error>
          <ErrorPrimitive.Root className="mt-1.5 flex items-center gap-2 rounded-md border border-danger-strong bg-danger-subtle px-3 py-2 text-12 text-danger-primary">
            <AlertTriangle className="size-3.5 shrink-0" />
            <ErrorPrimitive.Message className="line-clamp-3" />
          </ErrorPrimitive.Root>
        </MessagePrimitive.Error>
      </div>
    </MessagePrimitive.Root>
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="flex flex-col items-end gap-1 py-2">
      <div className="flex flex-wrap justify-end gap-1.5 empty:hidden">
        <MessageAttachmentsRow />
      </div>
      <div className="max-w-[80%] rounded-lg bg-layer-2 px-3 py-2 text-13 whitespace-pre-wrap">
        <MessagePrimitive.Parts />
      </div>
    </MessagePrimitive.Root>
  );
}

/** In-memory conversation rail: new chat + switch/delete threads */
export function AssistantThreadList() {
  return (
    <ThreadListPrimitive.Root className="flex h-full w-56 shrink-0 flex-col gap-1 overflow-y-auto border-r border-subtle p-2">
      <ThreadListPrimitive.New className="flex items-center gap-1.5 rounded-md border border-subtle px-2.5 py-1.5 text-12 font-medium hover:bg-layer-1-hover">
        <MessageSquarePlus className="size-3.5" /> Nueva conversación
      </ThreadListPrimitive.New>
      <ThreadListPrimitive.Items
        components={{
          ThreadListItem: () => (
            <ThreadListItemPrimitive.Root className="group flex items-center gap-1 rounded-md px-1 text-13 hover:bg-layer-1-hover data-active:bg-layer-1-selected">
              <ThreadListItemPrimitive.Trigger className="min-w-0 flex-1 truncate px-1.5 py-1.5 text-left">
                <ThreadListItemPrimitive.Title fallback="Nueva conversación" />
              </ThreadListItemPrimitive.Trigger>
              <ThreadListItemPrimitive.Delete className="hidden shrink-0 rounded-sm p-1 text-tertiary group-hover:block hover:text-danger-primary">
                <Trash2 className="size-3" />
              </ThreadListItemPrimitive.Delete>
            </ThreadListItemPrimitive.Root>
          ),
        }}
      />
    </ThreadListPrimitive.Root>
  );
}

export function AssistantThread({ composerAccessory }: { composerAccessory?: ReactNode }) {
  return (
    <ThreadPrimitive.Root className="flex h-full min-h-0 flex-1 flex-col">
      <ThreadPrimitive.Viewport className="min-h-0 flex-1 overflow-y-auto px-4 py-3 sm:px-8">
        <ThreadPrimitive.Empty>
          <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
            <span className="flex size-12 items-center justify-center rounded-full bg-accent-primary/10 text-accent-primary">
              <Bot className="size-6" />
            </span>
            <div>
              <p className="text-16 font-medium">Asistente del workspace</p>
              <p className="mt-1 text-13 text-tertiary">
                Pregunta por tu catálogo musical, contratos, adjunta archivos para importarlos o pide reportes en Excel.
              </p>
            </div>
            <div className="flex max-w-lg flex-wrap justify-center gap-1.5">
              {SUGGESTIONS.map((suggestion) => (
                <ThreadPrimitive.Suggestion
                  key={suggestion}
                  prompt={suggestion}
                  method="replace"
                  autoSend
                  className="cursor-pointer rounded-full border border-subtle px-3 py-1.5 text-12 text-secondary hover:bg-layer-1-hover"
                >
                  {suggestion}
                </ThreadPrimitive.Suggestion>
              ))}
            </div>
          </div>
        </ThreadPrimitive.Empty>
        <div className="mx-auto max-w-3xl">
          <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
          <ThreadPrimitive.If running>
            <p className="flex items-center gap-2 py-2 text-12 text-tertiary">
              <DotMatrix className="size-3.5" /> Trabajando…
            </p>
          </ThreadPrimitive.If>
        </div>
      </ThreadPrimitive.Viewport>

      <div className="shrink-0 border-t border-subtle p-3 sm:px-8">
        {composerAccessory && <div className="mx-auto mb-1.5 flex max-w-3xl justify-end">{composerAccessory}</div>}
        <ComposerPrimitive.AttachmentDropzone className="mx-auto max-w-3xl rounded-lg data-dragging:outline-2 data-dragging:outline-dashed data-dragging:outline-accent-strong">
          <div className="mb-1.5 flex flex-wrap gap-1.5 empty:hidden">
            <ComposerAttachmentsRow />
          </div>
          <ComposerPrimitive.Root className="flex items-end gap-2 rounded-lg border border-subtle bg-layer-1 p-2">
            <ComposerPrimitive.AddAttachment
              className="flex size-8 shrink-0 items-center justify-center rounded-md text-tertiary hover:bg-layer-1-hover"
              title="Adjuntar archivo (CSV/XLSX)"
            >
              <Paperclip className="size-4" />
            </ComposerPrimitive.AddAttachment>
            <ComposerPrimitive.Input
              rows={1}
              autoFocus
              placeholder="Pregunta por canciones, contratos, o adjunta un archivo para importarlo…"
              className="max-h-40 min-h-9 w-full resize-none bg-transparent px-2 py-1.5 text-13 outline-none"
            />
            <ThreadPrimitive.If running={false}>
              <ComposerPrimitive.Send className="flex size-8 shrink-0 items-center justify-center rounded-md bg-accent-primary text-on-color hover:opacity-90 disabled:opacity-50">
                <ArrowUp className="size-4" />
              </ComposerPrimitive.Send>
            </ThreadPrimitive.If>
            <ThreadPrimitive.If running>
              <ComposerPrimitive.Cancel className="flex size-8 shrink-0 items-center justify-center rounded-md border border-subtle text-secondary hover:bg-layer-1-hover">
                <Square className="size-3.5" />
              </ComposerPrimitive.Cancel>
            </ThreadPrimitive.If>
          </ComposerPrimitive.Root>
        </ComposerPrimitive.AttachmentDropzone>
      </div>
    </ThreadPrimitive.Root>
  );
}
