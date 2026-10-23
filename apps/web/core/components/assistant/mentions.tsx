/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * @-mentions in the assistant composer: type "@", pick any tag, contract,
 * file, song, release, artist, work item, page, budget or expense.
 *
 * The composer shows a readable "@3BallMTY"; on send it becomes
 * assistant-ui's directive format (:tag[3BallMTY]{name=<id>}) so the id
 * travels in the message itself: Django resolves it with the user's
 * permissions and the transcript keeps it for later turns.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode, SyntheticEvent } from "react";
import { useAui } from "@assistant-ui/react";
import type { TextMessagePartProps } from "@assistant-ui/react";
import type { LucideIcon } from "lucide-react";
import { AtSign, Loader2, Tag } from "lucide-react";
import { useParams } from "react-router";
import useSWR from "swr";
import { useTranslation } from "@plane/i18n";
import type { TEntityName } from "@plane/types";
import { cn } from "@plane/utils";
import { ENTITY_ICONS, entityGroupKey } from "@/components/references/entity-meta";
import { TAG_KIND_ICONS } from "@/components/references/shared-tag-chip";
import { referencesService } from "@/services/references.service";
import { useAssistantNavigate } from "./links";

export type TMentionType = TEntityName | "tag";
export type TMention = { type: TMentionType; id: string; label: string; subtitle?: string; icon?: LucideIcon };

const DIRECTIVE_RE = /:([a-z_]{2,20})\[([^\]\n]{1,160})\]\{name=([0-9a-fA-F-]{36})\}/g;
const TRIGGER_RE = /(^|[\s(])@([^\s@]{0,40})$/;
const MAX_RESULTS = 10;

/** Labels go inside [...]: keep them on one line and without brackets. */
const cleanLabel = (label: string) =>
  label
    .replace(/[[\]\n\r]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);

export const serializeMention = (mention: TMention) =>
  `:${mention.type}[${cleanLabel(mention.label)}]{name=${mention.id}}`;

/** `at` is the segment's offset in the text: a stable key for rendering. */
type TSegment =
  | { kind: "text"; at: number; text: string }
  | { kind: "mention"; at: number; type: TMentionType; label: string; id: string };

export function parseMentions(text: string): TSegment[] {
  const segments: TSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(DIRECTIVE_RE)) {
    const index = match.index ?? 0;
    if (index > last) segments.push({ kind: "text", at: last, text: text.slice(last, index) });
    segments.push({ kind: "mention", at: index, type: match[1] as TMentionType, label: match[2], id: match[3] });
    last = index + match[0].length;
  }
  if (last < text.length) segments.push({ kind: "text", at: last, text: text.slice(last) });
  return segments;
}

/** "@3BallMTY" in the typed text → the directive, for every mention picked. */
export function encodeMentions(text: string, picked: Map<string, TMention>): string {
  let encoded = text;
  const labels = [...picked.keys()].sort((a, b) => b.length - a.length);
  for (const label of labels) {
    const mention = picked.get(label)!;
    encoded = encoded.split(`@${label}`).join(serializeMention(mention));
  }
  return encoded;
}

/** The readable form, for editing a sent message. */
export const decodeMentions = (text: string) =>
  parseMentions(text)
    .map((segment) => (segment.kind === "text" ? segment.text : `@${segment.label}`))
    .join("");

const iconFor = (type: string): LucideIcon => (type === "tag" ? Tag : (ENTITY_ICONS[type as TEntityName] ?? AtSign));

// --------------------------------------------------------------- message chips

function MentionChip({ type, label, id }: { type: TMentionType; label: string; id: string }) {
  const { workspaceSlug } = useParams();
  const navigate = useAssistantNavigate();
  const Icon = iconFor(type);
  const open = async () => {
    if (type === "tag") return navigate(`/${workspaceSlug}/tags/${id}`);
    try {
      const [card] = await referencesService.resolve(String(workspaceSlug), [{ entity_name: type, id }]);
      if (card?.status === "ok" && card.path) navigate(card.path);
    } catch {
      // A deleted or restricted item simply doesn't open.
    }
  };
  return (
    <button
      type="button"
      onClick={() => void open()}
      className="mx-0.5 inline-flex max-w-full items-center gap-1 rounded-sm bg-accent-primary/15 px-1 align-baseline text-accent-primary hover:bg-accent-primary/25"
    >
      <Icon className="size-3 shrink-0" aria-hidden />
      <span className="truncate">{label}</span>
    </button>
  );
}

/** User message text with mentions shown as chips. */
export function MentionText({ text }: TextMessagePartProps) {
  const segments = useMemo(() => parseMentions(text), [text]);
  return (
    <>
      {segments.map((segment) =>
        segment.kind === "text" ? (
          <span key={segment.at}>{segment.text}</span>
        ) : (
          <MentionChip key={segment.at} type={segment.type} label={segment.label} id={segment.id} />
        )
      )}
    </>
  );
}

// ------------------------------------------------------------------ composer

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

async function searchMentions(workspaceSlug: string, query: string): Promise<TMention[]> {
  const [tags, entities] = await Promise.all([
    referencesService.getTags(workspaceSlug, { search: query || undefined, usage: true }).catch(() => []),
    query ? referencesService.search(workspaceSlug, query, { count: 3 }).catch(() => null) : Promise.resolve(null),
  ]);
  const tagRows: TMention[] = [...tags]
    .sort((a, b) => (b.usage ?? 0) - (a.usage ?? 0))
    .slice(0, query ? 4 : 6)
    .map((tag) => ({ type: "tag", id: tag.id, label: tag.name, icon: TAG_KIND_ICONS[tag.kind] }));
  const entityRows: TMention[] = Object.entries(entities?.results ?? {}).flatMap(([name, cards]) =>
    (cards ?? [])
      .filter((card) => card.status === "ok" && card.title)
      .map((card) => ({ type: name as TEntityName, id: card.id, label: card.title!, subtitle: card.subtitle }))
  );
  return [...tagRows, ...entityRows].slice(0, MAX_RESULTS);
}

type TTrigger = { query: string; start: number; end: number };

/**
 * Everything the composer needs for mentions: input handlers, the popover
 * and `beforeSend`, which swaps "@label" for the directive right before the
 * message leaves.
 */
export function useComposerMentions({ decodeOnMount = false }: { decodeOnMount?: boolean } = {}) {
  const { t } = useTranslation();
  const { workspaceSlug } = useParams();
  const slug = String(workspaceSlug ?? "");
  const aui = useAui();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const picked = useRef(new Map<string, TMention>());
  const [trigger, setTrigger] = useState<TTrigger | null>(null);
  const [highlight, setHighlight] = useState(0);
  const query = useDebounced(trigger?.query ?? null, 180);
  const { data: results, isLoading } = useSWR(
    slug && query !== null ? ["ASSISTANT_MENTIONS", slug, query] : null,
    () => searchMentions(slug, query ?? ""),
    { keepPreviousData: true }
  );
  const items = useMemo(() => (trigger ? (results ?? []) : []), [trigger, results]);

  // Editing a sent message: show "@label" instead of the directive, and
  // remember each mention so sending again keeps its id.
  useEffect(() => {
    if (!decodeOnMount) return;
    const composer = aui.composer();
    const text = composer.getState().text;
    const mentions = parseMentions(text).filter((segment) => segment.kind === "mention");
    if (mentions.length === 0) return;
    for (const mention of mentions) {
      picked.current.set(mention.label, { type: mention.type, id: mention.id, label: mention.label });
    }
    composer.setText(decodeMentions(text));
  }, [aui, decodeOnMount]);

  const detect = useCallback((element: HTMLTextAreaElement) => {
    const caret = element.selectionStart ?? element.value.length;
    const match = TRIGGER_RE.exec(element.value.slice(0, caret));
    if (!match) return setTrigger(null);
    setTrigger((current) => {
      const next = { query: match[2], start: caret - match[2].length - 1, end: caret };
      if (current?.query !== next.query) setHighlight(0);
      return next;
    });
  }, []);

  const select = useCallback(
    (mention: TMention) => {
      const element = inputRef.current;
      if (!element || !trigger) return;
      const label = cleanLabel(mention.label);
      const text = element.value;
      const inserted = `@${label} `;
      const next = text.slice(0, trigger.start) + inserted + text.slice(trigger.end);
      picked.current.set(label, mention);
      aui.composer().setText(next);
      setTrigger(null);
      const caret = trigger.start + inserted.length;
      requestAnimationFrame(() => {
        element.focus();
        element.setSelectionRange(caret, caret);
      });
    },
    [aui, trigger]
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (!trigger) return;
      if (event.key === "Escape") {
        event.preventDefault();
        setTrigger(null);
        return;
      }
      if (items.length === 0) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setHighlight((index) => (index + step + items.length) % items.length);
      } else if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
        // Picking a mention must not send the message.
        event.preventDefault();
        select(items[Math.min(highlight, items.length - 1)]);
      }
    },
    [trigger, items, highlight, select]
  );

  const onCaretChange = useCallback(
    (event: SyntheticEvent<HTMLTextAreaElement>) => detect(event.currentTarget),
    [detect]
  );

  const beforeSend = useCallback(() => {
    const composer = aui.composer();
    const text = composer.getState().text;
    const encoded = encodeMentions(text, picked.current);
    if (encoded !== text) composer.setText(encoded);
    picked.current = new Map();
    setTrigger(null);
  }, [aui]);

  let popover: ReactNode = null;
  if (trigger) {
    popover = (
      <div
        role="listbox"
        aria-label={t("assistant.mentions.title")}
        className="absolute right-0 bottom-full left-0 z-20 mb-1.5 max-h-72 overflow-y-auto rounded-lg border border-subtle bg-surface-1 py-1 shadow-raised-200"
      >
        <p className="flex items-center gap-1.5 px-3 pt-1 pb-1.5 text-11 text-tertiary">
          {isLoading && <Loader2 className="size-3 animate-spin" aria-hidden />}
          {trigger.query ? t("assistant.mentions.searching", { query: trigger.query }) : t("assistant.mentions.hint")}
        </p>
        {items.length === 0 && !isLoading ? (
          <p className="px-3 pb-2 text-12 text-tertiary">{t("assistant.mentions.empty")}</p>
        ) : (
          items.map((item, index) => {
            const Icon = item.icon ?? iconFor(item.type);
            const group = item.type === "tag" ? t("references.tags.title") : t(entityGroupKey(item.type));
            return (
              <button
                key={`${item.type}:${item.id}`}
                type="button"
                role="option"
                aria-selected={index === highlight}
                // Keep the textarea focused while picking with the mouse.
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setHighlight(index)}
                onClick={() => select(item)}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-1.5 text-left",
                  index === highlight ? "bg-layer-1-hover" : "hover:bg-layer-1-hover"
                )}
              >
                <Icon className="size-3.5 shrink-0 text-tertiary" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-13 text-primary">{item.label}</span>
                  {item.subtitle && <span className="block truncate text-11 text-tertiary">{item.subtitle}</span>}
                </span>
                <span className="shrink-0 text-11 text-tertiary">{group}</span>
              </button>
            );
          })
        )}
      </div>
    );
  }

  return {
    inputRef,
    popover,
    beforeSend,
    inputProps: {
      onKeyDown,
      onSelect: onCaretChange,
      onClick: onCaretChange,
      onChange: onCaretChange,
      onBlur: () => setTrigger(null),
    },
  };
}
