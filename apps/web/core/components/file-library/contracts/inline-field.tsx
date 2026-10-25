/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * A contract field that reads as text and edits in place. At rest it shows
 * the whole value, as tall as it needs, so long AI-extracted text can be
 * read without scrolling inside a box. A click swaps it for the matching
 * editor (a growing textarea, a select or a date input) drawn with the same
 * font, size, line height, padding and border, so the swap doesn't move the
 * text. Edits go to the panel's draft; the save bar persists them.
 */

import { useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { PencilLine } from "lucide-react";
import { useTranslation } from "@plane/i18n";
import { cn } from "@plane/utils";

/** One box for both states: the only difference is the border colour. */
const BOX = "block w-full rounded-sm border px-2 py-1.5 text-left text-13 leading-5 text-primary";
const AT_REST =
  "group/field cursor-text border-transparent bg-transparent break-words whitespace-pre-wrap hover:border-subtle hover:bg-layer-1-hover focus-visible:border-accent-strong focus-visible:outline-none";
const EDITING = "border-accent-strong bg-surface-1 outline-none";
/** Native selects and date inputs size themselves: pin them to one text line (20 + 12 + 2). */
const ONE_LINE = "h-[34px]";

type Common = {
  label: string;
  /** Edited and not saved yet */
  changed?: boolean;
  /** Shows the value without the editor (guests) */
  readOnly?: boolean;
  /** Next to the label, e.g. "see in document" */
  labelExtra?: ReactNode;
};

type Props = Common &
  (
    | { kind: "text"; multiline?: boolean; value: string | null; onChange: (value: string | null) => void }
    | {
        kind: "select";
        value: string | null;
        options: { value: string; label: string }[];
        onChange: (value: string | null) => void;
      }
    | { kind: "date"; value: string | null; onChange: (value: string | null) => void }
  );

const formatDate = (value: string, locale: string) => {
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString(locale, { day: "numeric", month: "long", year: "numeric" });
};

/** Grows the textarea to its content (border included, box-sizing is border-box). */
function fit(element: HTMLTextAreaElement | null) {
  if (!element) return;
  element.style.height = "auto";
  element.style.height = `${element.scrollHeight + 2}px`;
}

export function InlineField(props: Props) {
  const { t, currentLocale } = useTranslation();
  const { label, changed, readOnly, labelExtra } = props;
  const [editing, setEditing] = useState(false);
  // What the field held when editing started, for Escape
  const before = useRef<string | null>(null);
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const picker = useRef<HTMLInputElement | HTMLSelectElement | null>(null);

  useLayoutEffect(() => {
    if (!editing) return;
    if (props.kind === "text") {
      const element = textarea.current;
      fit(element);
      element?.focus();
      // Caret at the end, the way the text was being read
      element?.setSelectionRange(element.value.length, element.value.length);
      return;
    }
    const element = picker.current;
    element?.focus();
    try {
      // Opens the native list or calendar right away (Chrome, Edge, Safari 17+)
      (element as HTMLInputElement | null)?.showPicker?.();
    } catch {
      // Not allowed or not supported: the focused control is enough
    }
    // Only when the editor opens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const start = () => {
    before.current = props.value;
    setEditing(true);
  };
  const finish = () => setEditing(false);
  const revert = () => {
    props.onChange(before.current);
    setEditing(false);
  };
  const onKey = (event: KeyboardEvent<HTMLElement>, multiline = false) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      revert();
    } else if (event.key === "Enter" && (!multiline || event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      finish();
    }
  };

  let shown = props.value ?? "";
  if (props.kind === "select") shown = props.options.find((option) => option.value === props.value)?.label ?? "";
  if (props.kind === "date" && props.value) shown = formatDate(props.value, currentLocale);

  return (
    <div className="min-w-0 space-y-0.5">
      <div className="flex items-center gap-1.5 px-2">
        <span className="text-11 font-medium text-tertiary">{label}</span>
        {changed && (
          <span className="flex items-center gap-1 text-11 text-accent-primary">
            <span className="size-1.5 rounded-full bg-accent-primary" aria-hidden />
            {t("file_library.contracts.fields.unsaved")}
          </span>
        )}
        {labelExtra ? <span className="ml-auto flex items-center gap-1">{labelExtra}</span> : null}
      </div>

      {readOnly ? (
        <p className={cn(BOX, "border-transparent break-words whitespace-pre-wrap")}>
          <span className={cn(!shown && "text-placeholder")}>{shown || "—"}</span>
        </p>
      ) : !editing ? (
        <button
          type="button"
          onClick={start}
          aria-label={`${label}: ${shown || "—"}`}
          className={cn(BOX, AT_REST, "relative pr-7", changed && "bg-accent-primary/5")}
        >
          <span className={cn(!shown && "text-placeholder")}>{shown || "—"}</span>
          <PencilLine
            className="absolute top-2 right-2 size-3.5 text-tertiary opacity-0 transition-opacity group-hover/field:opacity-100 group-focus-visible/field:opacity-100"
            aria-hidden
          />
        </button>
      ) : props.kind === "text" ? (
        <textarea
          ref={textarea}
          rows={1}
          aria-label={label}
          value={props.value ?? ""}
          onChange={(event) => {
            props.onChange(event.target.value || null);
            fit(event.target);
          }}
          onBlur={finish}
          onKeyDown={(event) => onKey(event, props.multiline)}
          className={cn(BOX, EDITING, "resize-none overflow-hidden pr-7")}
        />
      ) : props.kind === "select" ? (
        <select
          ref={(element) => {
            picker.current = element;
          }}
          aria-label={label}
          value={props.value ?? ""}
          onChange={(event) => {
            props.onChange(event.target.value || null);
            finish();
          }}
          onBlur={finish}
          onKeyDown={(event) => onKey(event)}
          className={cn(BOX, EDITING, ONE_LINE, "cursor-pointer")}
        >
          <option value="">—</option>
          {props.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          ref={(element) => {
            picker.current = element;
          }}
          type="date"
          aria-label={label}
          value={props.value ?? ""}
          onChange={(event) => props.onChange(event.target.value || null)}
          onBlur={finish}
          onKeyDown={(event) => onKey(event)}
          className={cn(BOX, EDITING, ONE_LINE)}
        />
      )}
    </div>
  );
}
