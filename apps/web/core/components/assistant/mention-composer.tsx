/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * The composer side of @-mentions: the picker (with its own search box and
 * a tab per kind of item), the chips drawn over the typed text, and the swap
 * from "@label" to the directive right before a message is sent.
 *
 * The chips live in a layer laid exactly over the textarea (same font,
 * padding and wrapping) while the textarea's own text turns transparent: the
 * caret and selection stay native, and "@3BallMTY" shows as a chip that opens
 * the item. Backspace right after a chip removes it whole.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FocusEvent, KeyboardEvent, ReactNode, SyntheticEvent } from "react";
import { useAui, useAuiState } from "@assistant-ui/react";
import { Loader2, Search } from "lucide-react";
import { useParams } from "react-router";
import useSWR from "swr";
import { useTranslation } from "@plane/i18n";
import type { TEntityName, TSharedTagKind } from "@plane/types";
import { cn } from "@plane/utils";
import { entityGroupKey } from "@/components/references/entity-meta";
import { TAG_KIND_ICONS } from "@/components/references/shared-tag-chip";
import { referencesService } from "@/services/references.service";
import { subscribeToAsk } from "./ask";
import type { TMention, TMentionType } from "./mentions";
import {
  MAX_RESULTS,
  TRIGGER_RE,
  cleanLabel,
  decodeMentions,
  encodeMentions,
  iconFor,
  parseMentions,
  useOpenMention,
} from "./mentions";

const MENTION_TYPES: TMentionType[] = [
  "tag",
  "contract",
  "file",
  "music_track",
  "music_release",
  "music_artist",
  "issue",
  "page",
  "budget",
  "expense",
];
type TTypeFilter = TMentionType | "all";
type TTrigger = { query: string; start: number; end: number };

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

const tagRow = (tag: { id: string; name: string; kind: TSharedTagKind }): TMention => ({
  type: "tag",
  id: tag.id,
  label: tag.name,
  icon: TAG_KIND_ICONS[tag.kind],
});

async function searchMentions(workspaceSlug: string, query: string, type: TTypeFilter): Promise<TMention[]> {
  const tags = (limit: number) =>
    referencesService
      .getTags(workspaceSlug, { search: query || undefined, usage: true })
      .then((rows) =>
        [...rows]
          .sort((a, b) => (b.usage ?? 0) - (a.usage ?? 0))
          .slice(0, limit)
          .map(tagRow)
      )
      .catch((): TMention[] => []);
  const entities = (types: TEntityName[] | undefined, count: number): Promise<TMention[]> =>
    query
      ? referencesService
          .search(workspaceSlug, query, { types, count })
          .then((response) =>
            Object.entries(response.results ?? {}).flatMap(([name, cards]) =>
              (cards ?? [])
                .filter((card) => card.status === "ok" && card.title)
                .map((card) => ({
                  type: name as TEntityName,
                  id: card.id,
                  label: card.title!,
                  subtitle: card.subtitle,
                }))
            )
          )
          .catch((): TMention[] => [])
      : Promise.resolve([]);
  // One kind: show many of it. Everything: a few of each.
  if (type === "tag") return tags(25);
  if (type !== "all") return entities([type], 20);
  const [tagRows, entityRows] = await Promise.all([tags(query ? 4 : 6), entities(undefined, 3)]);
  return [...tagRows, ...entityRows].slice(0, MAX_RESULTS + 2);
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function useComposerMentions({
  decodeOnMount = false,
  listenForAsk = false,
  inputClassName,
}: {
  decodeOnMount?: boolean;
  /** The main composer receives "Ask AI" requests from the rest of the app. */
  listenForAsk?: boolean;
  inputClassName: string;
}) {
  const { t } = useTranslation();
  const { workspaceSlug } = useParams();
  const slug = String(workspaceSlug ?? "");
  const aui = useAui();
  const text = useAuiState((state) => state.composer.text);
  const openMention = useOpenMention();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [picked, setPicked] = useState(() => new Map<string, TMention>());
  const pickedRef = useRef(picked);
  pickedRef.current = picked;
  const [trigger, setTrigger] = useState<TTrigger | null>(null);
  const [filter, setFilter] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<TTypeFilter>("all");
  const [highlight, setHighlight] = useState(0);
  // Where the caret goes once the composer re-renders with the new text.
  const pendingCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    const element = inputRef.current;
    if (pendingCaret.current === null || !element) return;
    element.focus();
    element.setSelectionRange(pendingCaret.current, pendingCaret.current);
    pendingCaret.current = null;
  }, [text]);

  const query = trigger ? (filter ?? trigger.query) : null;
  const debounced = useDebounced(query, 180);
  const { data: results, isLoading } = useSWR(
    slug && debounced !== null ? ["ASSISTANT_MENTIONS", slug, debounced, typeFilter] : null,
    () => searchMentions(slug, debounced ?? "", typeFilter),
    { keepPreviousData: true }
  );
  const items = useMemo(() => (trigger ? (results ?? []) : []), [trigger, results]);

  // Editing a sent message: show "@label" instead of the directive, and
  // remember each mention so sending again keeps its id.
  useEffect(() => {
    if (!decodeOnMount) return;
    const composer = aui.composer();
    const current = composer.getState().text;
    const next = new Map<string, TMention>();
    for (const segment of parseMentions(current)) {
      if (segment.kind === "mention") {
        next.set(segment.label, { type: segment.type, id: segment.id, label: segment.label });
      }
    }
    if (next.size === 0) return;
    setPicked(next);
    composer.setText(decodeMentions(current));
  }, [aui, decodeOnMount]);

  // "Ask AI" from a contract, file, song, tag or selection: the items land in
  // the composer as mentions, the caret after them.
  useEffect(() => {
    if (!listenForAsk) return;
    return subscribeToAsk(({ mentions, text: extra }) => {
      const current = aui.composer().getState().text.trimEnd();
      const tokens = mentions.map((mention) => `@${cleanLabel(mention.label)}`).join(" ");
      const next = `${current ? `${current} ` : ""}${tokens} ${extra ?? ""}`;
      setPicked((map) => {
        const updated = new Map(map);
        for (const mention of mentions) updated.set(cleanLabel(mention.label), mention);
        return updated;
      });
      pendingCaret.current = next.length;
      aui.composer().setText(next);
    });
  }, [aui, listenForAsk]);

  const close = useCallback(() => {
    setTrigger(null);
    setFilter(null);
    setTypeFilter("all");
  }, []);

  const detect = useCallback((element: HTMLTextAreaElement) => {
    const caret = element.selectionStart ?? element.value.length;
    const match = TRIGGER_RE.exec(element.value.slice(0, caret));
    if (!match) {
      setTrigger(null);
      return;
    }
    setTrigger((current) => {
      const next = { query: match[2], start: caret - match[2].length - 1, end: caret };
      if (current?.query !== next.query) {
        setHighlight(0);
        setFilter(null);
      }
      return next;
    });
  }, []);

  const select = useCallback(
    (mention: TMention) => {
      const element = inputRef.current;
      if (!element || !trigger) return;
      const label = cleanLabel(mention.label);
      const current = aui.composer().getState().text;
      const inserted = `@${label} `;
      const next = current.slice(0, trigger.start) + inserted + current.slice(trigger.end);
      setPicked((map) => new Map(map).set(label, mention));
      aui.composer().setText(next);
      close();
      pendingCaret.current = trigger.start + inserted.length;
    },
    [aui, trigger, close]
  );

  /** Picker keys, shared by the textarea and the picker's own search box. */
  const handlePickerKey = useCallback(
    (event: KeyboardEvent<HTMLElement>): boolean => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        inputRef.current?.focus();
        return true;
      }
      if (items.length === 0) return false;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setHighlight((index) => (index + step + items.length) % items.length);
        return true;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        // Picking a mention must not send the message.
        event.preventDefault();
        select(items[Math.min(highlight, items.length - 1)]);
        return true;
      }
      return false;
    },
    [items, highlight, select, close]
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (trigger) {
        if (event.key === "Tab" && items.length > 0) {
          event.preventDefault();
          select(items[Math.min(highlight, items.length - 1)]);
          return;
        }
        if (handlePickerKey(event)) return;
      }
      // Backspace right after a chip removes the whole mention.
      if (event.key !== "Backspace") return;
      const element = event.currentTarget;
      const caret = element.selectionStart ?? 0;
      if (caret !== element.selectionEnd) return;
      const before = element.value.slice(0, caret);
      for (const label of pickedRef.current.keys()) {
        const token = `@${label}`;
        let end = -1;
        if (before.endsWith(token)) end = caret;
        else if (before.endsWith(`${token} `)) end = caret - 1;
        if (end < 0) continue;
        event.preventDefault();
        const start = end - token.length;
        pendingCaret.current = start;
        aui.composer().setText(element.value.slice(0, start) + element.value.slice(caret));
        return;
      }
    },
    [trigger, items, highlight, select, handlePickerKey, aui]
  );

  const onCaretChange = useCallback(
    (event: SyntheticEvent<HTMLTextAreaElement>) => detect(event.currentTarget),
    [detect]
  );

  const keepOpenFor = useCallback(
    (target: EventTarget | null) =>
      target instanceof Node && Boolean(popoverRef.current?.contains(target) || inputRef.current === target),
    []
  );

  /** Opens the picker from a button (e.g. "pick from the workspace"): types
   * an "@" at the caret and pre-selects a kind of item. */
  const startMention = useCallback(
    (type: TTypeFilter = "all") => {
      const element = inputRef.current;
      const current = aui.composer().getState().text;
      const caret = element?.selectionStart ?? current.length;
      const needsSpace = caret > 0 && !/\s$/.test(current.slice(0, caret));
      const inserted = `${needsSpace ? " " : ""}@`;
      const next = current.slice(0, caret) + inserted + current.slice(caret);
      const at = caret + inserted.length;
      pendingCaret.current = at;
      aui.composer().setText(next);
      setTrigger({ query: "", start: at - 1, end: at });
      setFilter(null);
      setTypeFilter(type);
      setHighlight(0);
    },
    [aui]
  );

  const beforeSend = useCallback(() => {
    const composer = aui.composer();
    const current = composer.getState().text;
    const encoded = encodeMentions(current, pickedRef.current);
    if (encoded !== current) composer.setText(encoded);
    setPicked(new Map());
    close();
  }, [aui, close]);

  // Chips over the typed text, for the mentions still present in it.
  const labels = useMemo(
    () => [...picked.keys()].filter((label) => text.includes(`@${label}`)).sort((a, b) => b.length - a.length),
    [picked, text]
  );
  const hasChips = labels.length > 0;

  let overlay: ReactNode = null;
  if (hasChips) {
    const pattern = new RegExp(`(${labels.map((label) => escapeRegExp(`@${label}`)).join("|")})`, "g");
    let offset = 0;
    const parts = text.split(pattern).map((part) => {
      const at = offset;
      offset += part.length;
      return { at, part, mention: part.startsWith("@") ? picked.get(part.slice(1)) : undefined };
    });
    overlay = (
      <div
        ref={overlayRef}
        aria-hidden
        className={cn(
          inputClassName,
          "pointer-events-none absolute inset-0 overflow-hidden break-words whitespace-pre-wrap text-primary"
        )}
      >
        {parts.map(({ at, part, mention }) =>
          mention ? (
            <button
              key={at}
              type="button"
              tabIndex={-1}
              title={t("assistant.mentions.chip_hint")}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => void openMention(mention.type, mention.id)}
              // Padding offset by an equal negative margin: the chip keeps the
              // exact width of the text under it, or the caret would drift.
              className="pointer-events-auto -mx-[2px] cursor-pointer rounded-sm bg-accent-primary/15 px-[2px] text-accent-primary hover:bg-accent-primary/25"
            >
              {part}
            </button>
          ) : (
            <span key={at}>{part}</span>
          )
        )}
        {/* Keeps a trailing newline's height, as the textarea does. */}
        {"​"}
      </div>
    );
  }

  let popover: ReactNode = null;
  if (trigger) {
    let emptyText = t("assistant.mentions.empty");
    if (isLoading) emptyText = t("assistant.mentions.loading");
    else if (!query && typeFilter !== "all" && typeFilter !== "tag") emptyText = t("assistant.mentions.type_to_search");
    popover = (
      <div
        ref={popoverRef}
        className="absolute right-0 bottom-full left-0 z-20 mb-1.5 overflow-hidden rounded-lg border border-subtle bg-surface-1 shadow-raised-200"
      >
        <div className="flex items-center gap-2 border-b border-subtle px-3 py-2">
          {isLoading ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin text-tertiary" aria-hidden />
          ) : (
            <Search className="size-3.5 shrink-0 text-tertiary" aria-hidden />
          )}
          <input
            value={query ?? ""}
            onChange={(event) => {
              setFilter(event.target.value);
              setHighlight(0);
            }}
            onKeyDown={(event) => {
              handlePickerKey(event);
            }}
            onBlur={(event) => {
              if (!keepOpenFor(event.relatedTarget)) close();
            }}
            placeholder={t("assistant.mentions.filter_placeholder")}
            aria-label={t("assistant.mentions.filter_placeholder")}
            className="min-w-0 flex-1 bg-transparent text-13 text-primary outline-none placeholder:text-placeholder"
          />
        </div>
        <div className="flex gap-1 overflow-x-auto border-b border-subtle px-2 py-1.5 [scrollbar-width:none]">
          {(["all", ...MENTION_TYPES] as TTypeFilter[]).map((value) => {
            let label = t("assistant.mentions.all");
            if (value === "tag") label = t("references.tags.title");
            else if (value !== "all") label = t(entityGroupKey(value));
            return (
              <button
                key={value}
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  setTypeFilter(value);
                  setHighlight(0);
                }}
                className={cn(
                  "shrink-0 rounded-md px-2 py-0.5 text-11 whitespace-nowrap",
                  typeFilter === value ? "bg-layer-2 font-medium text-primary" : "text-tertiary hover:text-secondary"
                )}
              >
                {label}
              </button>
            );
          })}
        </div>
        <div role="listbox" aria-label={t("assistant.mentions.title")} className="max-h-60 overflow-y-auto py-1">
          {items.length === 0 ? (
            <p className="px-3 py-2 text-12 text-tertiary">{emptyText}</p>
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
                  // Keep focus where it is while picking with the mouse.
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
                  {typeFilter === "all" && <span className="shrink-0 text-11 text-tertiary">{group}</span>}
                </button>
              );
            })
          )}
        </div>
      </div>
    );
  }

  return {
    inputRef,
    popover,
    overlay,
    beforeSend,
    startMention,
    inputProps: {
      className: cn(
        inputClassName,
        // The chips layer draws the text; the textarea keeps caret and selection.
        hasChips && "text-transparent [caret-color:var(--text-color-primary)]",
        "[scrollbar-width:none]"
      ),
      onKeyDown,
      onSelect: onCaretChange,
      onClick: onCaretChange,
      onChange: onCaretChange,
      onScroll: (event: SyntheticEvent<HTMLTextAreaElement>) => {
        if (overlayRef.current) overlayRef.current.scrollTop = event.currentTarget.scrollTop;
      },
      onBlur: (event: FocusEvent<HTMLTextAreaElement>) => {
        if (!keepOpenFor(event.relatedTarget)) close();
      },
    },
  };
}
