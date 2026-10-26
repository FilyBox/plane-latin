/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * The pieces the song and release panels are built from, so both read the
 * same: section titles in small caps with an "Agregar" action, label/value
 * rows that edit in place, and a copy button that shows on row hover.
 */

import { useState } from "react";
import { Check, Copy, Plus, X } from "lucide-react";
// plane imports
import { cn, copyTextToClipboard } from "@plane/utils";
// local imports
import { EditableField } from "./editable-field";

/** Header icon button of the music panels */
export const PEEK_ICON_BUTTON =
  "flex size-7 items-center justify-center rounded-sm border border-subtle text-secondary hover:bg-layer-1-hover";

/** The docked music panel: right edge, full height, the song panel's width */
export const PEEK_PANEL_CLASS =
  "absolute top-0 right-0 bottom-0 flex w-full flex-col overflow-hidden rounded-sm border-l border-subtle bg-surface-1 shadow-raised-200 md:w-xl";

export function CopyButton({ value, label }: { value: string | null | undefined; label?: string }) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  return (
    <button
      type="button"
      title={`Copiar${label ? ` ${label}` : ""}`}
      onClick={() => {
        void copyTextToClipboard(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
          return undefined;
        });
      }}
      className="shrink-0 rounded-sm p-1 text-tertiary opacity-0 transition-opacity group-hover/row:opacity-100 hover:bg-layer-1-hover hover:text-primary"
    >
      {copied ? <Check className="size-3 text-success-primary" /> : <Copy className="size-3" />}
    </button>
  );
}

/** Label + editable value + copy, the panel's repeating row */
export function FieldRow(props: {
  label: string;
  value: string | null;
  copyValue?: string | null;
  onSave?: (value: string) => Promise<void>;
  variant?: "input" | "textarea" | "date" | "select";
  options?: { value: string; label: string }[];
  format?: (value: string) => string;
  mono?: boolean;
  placeholder?: string;
}) {
  const { label, value, copyValue, onSave, variant, options, format, mono, placeholder } = props;
  return (
    <div className="group/row flex items-start gap-1">
      <p className="w-32 shrink-0 pt-1.5 text-11 text-tertiary">{label}</p>
      <div className="min-w-0 flex-1">
        {onSave ? (
          <EditableField
            value={value}
            onSave={onSave}
            variant={variant}
            options={options}
            format={format}
            placeholder={placeholder}
            className={mono ? "font-mono text-12" : undefined}
          />
        ) : (
          <p className={cn("px-1.5 py-1 text-13", mono && "font-mono text-12", !value && "text-placeholder")}>
            {value || "—"}
          </p>
        )}
      </div>
      <div className="pt-1">
        <CopyButton value={copyValue ?? value} label={label} />
      </div>
    </div>
  );
}

export function SectionTitle({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-subtle pb-1">
      <h3 className="text-11 font-semibold tracking-wide text-tertiary uppercase">{children}</h3>
      {action}
    </div>
  );
}

export function AddAction({
  onClick,
  isOpen,
  labels = { add: "Agregar", cancel: "Cancelar" },
}: {
  onClick: () => void;
  isOpen: boolean;
  labels?: { add: string; cancel: string };
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1 text-11 text-accent-primary hover:underline"
    >
      {isOpen ? <X className="size-3" /> : <Plus className="size-3" />} {isOpen ? labels.cancel : labels.add}
    </button>
  );
}
