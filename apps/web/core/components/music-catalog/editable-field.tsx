/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * Click-to-edit field for the track peek panel (adapted from the Documenso
 * EditableText pattern to Plane's design system): renders as plain text until
 * clicked, then swaps to the matching editor. Enter/blur saves, Escape
 * cancels; `onSave` is async so the caller PATCHes per field.
 */

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
// plane imports
import { cn } from "@plane/utils";

type Props = {
  value: string | null;
  onSave: (value: string) => Promise<void>;
  variant?: "input" | "textarea" | "date" | "select";
  options?: { value: string; label: string }[];
  placeholder?: string;
  className?: string;
  displayClassName?: string;
  /** Formats the stored value for display (e.g. enum → label, iso → local) */
  format?: (value: string) => string;
  readonly?: boolean;
};

export function EditableField(props: Props) {
  const { value, onSave, variant = "input", options = [], placeholder = "—", className, displayClassName, format, readonly } = props;
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  const [isSaving, setIsSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    setDraft(value ?? "");
  }, [value]);

  useEffect(() => {
    if (!isEditing) return;
    (variant === "textarea" ? textareaRef : inputRef).current?.focus();
    if (variant === "input") inputRef.current?.select();
  }, [isEditing, variant]);

  const commit = async (next: string) => {
    setIsEditing(false);
    if (next === (value ?? "")) return;
    setIsSaving(true);
    try {
      await onSave(next);
    } finally {
      setIsSaving(false);
    }
  };

  const cancel = () => {
    setDraft(value ?? "");
    setIsEditing(false);
  };

  const display = value ? (format ? format(value) : value) : "";

  if (!isEditing || readonly) {
    return (
      <button
        type="button"
        disabled={readonly}
        onClick={() => setIsEditing(true)}
        className={cn(
          "group/edit flex min-h-7 w-full items-center gap-1.5 rounded-sm px-1.5 py-1 text-left text-13 transition-colors",
          !readonly && "cursor-pointer hover:bg-layer-1-hover",
          !display && "text-placeholder",
          variant === "textarea" && "items-start whitespace-pre-wrap",
          displayClassName,
          className
        )}
        title={readonly ? undefined : "Click para editar"}
      >
        <span className={cn("min-w-0 flex-1", variant !== "textarea" && "truncate")}>{display || placeholder}</span>
        {isSaving && <Loader2 className="size-3 shrink-0 animate-spin text-tertiary" />}
      </button>
    );
  }

  const editorClass = cn(
    "w-full rounded-sm border border-accent-strong bg-transparent px-1.5 py-1 text-13 outline-none",
    className
  );

  if (variant === "textarea") {
    return (
      <textarea
        ref={textareaRef}
        value={draft}
        rows={4}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => void commit(draft)}
        onKeyDown={(event) => {
          if (event.key === "Escape") cancel();
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void commit(draft);
        }}
        className={cn(editorClass, "resize-y")}
      />
    );
  }

  if (variant === "select") {
    return (
      <select
        autoFocus
        value={draft}
        onChange={(event) => void commit(event.target.value)}
        onBlur={cancel}
        onKeyDown={(event) => event.key === "Escape" && cancel()}
        className={editorClass}
      >
        <option value="">—</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }

  return (
    <input
      ref={inputRef}
      type={variant === "date" ? "date" : "text"}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => void commit(draft)}
      onKeyDown={(event) => {
        if (event.key === "Escape") cancel();
        if (event.key === "Enter") void commit(draft);
      }}
      className={editorClass}
    />
  );
}
