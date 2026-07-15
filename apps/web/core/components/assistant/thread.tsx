/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * Minimal styled Thread built on assistant-ui primitives (the repo's design
 * system instead of the shadcn starter kit).
 */

import { ArrowUp, Bot, Loader2, Square } from "lucide-react";
import { ComposerPrimitive, MessagePrimitive, ThreadPrimitive } from "@assistant-ui/react";

const SUGGESTIONS = [
  "¿Qué canciones se lanzaron este año?",
  "Canciones de un artista con sus ISRC y videos",
  "Genera un Excel de todo el catálogo",
  "¿Qué dice el contrato de X sobre regalías?",
];

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="flex gap-2.5 py-2">
      <span className="mt-1 flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-primary/10 text-accent-primary">
        <Bot className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1 text-13 leading-relaxed whitespace-pre-wrap [&>p]:mb-1.5">
        <MessagePrimitive.Parts />
      </div>
    </MessagePrimitive.Root>
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="flex justify-end py-2">
      <div className="max-w-[80%] rounded-lg bg-layer-2 px-3 py-2 text-13 whitespace-pre-wrap">
        <MessagePrimitive.Parts />
      </div>
    </MessagePrimitive.Root>
  );
}

export function AssistantThread() {
  return (
    <ThreadPrimitive.Root className="flex h-full min-h-0 flex-col">
      <ThreadPrimitive.Viewport className="min-h-0 flex-1 overflow-y-auto px-4 py-3 sm:px-8">
        <ThreadPrimitive.Empty>
          <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
            <span className="flex size-12 items-center justify-center rounded-full bg-accent-primary/10 text-accent-primary">
              <Bot className="size-6" />
            </span>
            <div>
              <p className="text-16 font-medium">Asistente del workspace</p>
              <p className="mt-1 text-13 text-tertiary">
                Pregunta por tu catálogo musical, contratos, importa archivos o pide reportes en Excel.
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
              <Loader2 className="size-3.5 animate-spin" /> Pensando…
            </p>
          </ThreadPrimitive.If>
        </div>
      </ThreadPrimitive.Viewport>

      <div className="shrink-0 border-t border-subtle p-3 sm:px-8">
        <ComposerPrimitive.Root className="mx-auto flex max-w-3xl items-end gap-2 rounded-lg border border-subtle bg-layer-1 p-2">
          <ComposerPrimitive.Input
            rows={1}
            autoFocus
            placeholder="Pregunta por canciones, contratos, importa un archivo…"
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
      </div>
    </ThreadPrimitive.Root>
  );
}
