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

import { useCallback, useMemo } from "react";
import type { TextMessagePartProps } from "@assistant-ui/react";
import type { LucideIcon } from "lucide-react";
import { AtSign, Tag } from "lucide-react";
import { useParams } from "react-router";
import type { TEntityName } from "@plane/types";
import { ENTITY_ICONS } from "@/components/references/entity-meta";
import { referencesService } from "@/services/references.service";
import { useAssistantNavigate } from "./links";

export type TMentionType = TEntityName | "tag";
export type TMention = { type: TMentionType; id: string; label: string; subtitle?: string; icon?: LucideIcon };

const DIRECTIVE_RE = /:([a-z_]{2,20})\[([^\]\n]{1,160})\]\{name=([0-9a-fA-F-]{36})\}/g;
export const TRIGGER_RE = /(^|[\s(])@([^\s@]{0,40})$/;
export const MAX_RESULTS = 10;

/** Labels go inside [...]: keep them on one line and without brackets. */
export const cleanLabel = (label: string) =>
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

export const iconFor = (type: string): LucideIcon =>
  type === "tag" ? Tag : (ENTITY_ICONS[type as TEntityName] ?? AtSign);

// --------------------------------------------------------------- message chips

/** Opens a mentioned item in the app (its page, peek or tag view). */
export function useOpenMention() {
  const { workspaceSlug } = useParams();
  const navigate = useAssistantNavigate();
  return useCallback(
    async (type: TMentionType, id: string) => {
      if (type === "tag") return navigate(`/${workspaceSlug}/tags/${id}`);
      try {
        const [card] = await referencesService.resolve(String(workspaceSlug), [{ entity_name: type, id }]);
        if (card?.status === "ok" && card.path) navigate(card.path);
      } catch {
        // A deleted or restricted item simply doesn't open.
      }
    },
    [workspaceSlug, navigate]
  );
}

function MentionChip({ type, label, id }: { type: TMentionType; label: string; id: string }) {
  const openMention = useOpenMention();
  const Icon = iconFor(type);
  const open = () => openMention(type, id);
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

// The note an attachment adds for the agent ("[Archivo adjunto] … asset_id=…"):
// the attachment pill already shows the file, so the user never sees it.
const ATTACHMENT_NOTE_RE = /\[Archivo adjunto\][^\n]*?asset_id=[0-9a-fA-F-]{36}\.[^\n]*/g;

/** User message text with mentions shown as chips. */
export function MentionText({ text }: TextMessagePartProps) {
  const segments = useMemo(() => parseMentions(text.replace(ATTACHMENT_NOTE_RE, "").trim()), [text]);
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
