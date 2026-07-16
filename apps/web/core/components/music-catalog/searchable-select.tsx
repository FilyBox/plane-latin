/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * Combobox for unbounded catalogs (artists, releases, companies): type to
 * filter, click to pick, optional "create «query»" action when nothing
 * matches. Closes on Escape / outside click.
 */

import { useEffect, useRef, useState } from "react";
import { Check, ChevronsUpDown, Plus, Search } from "lucide-react";
// plane imports
import { cn } from "@plane/utils";

type Option = { value: string; label: string; hint?: string };

type Props = {
  options: Option[];
  value?: string | null;
  onSelect: (value: string) => void;
  /** When set, typing a non-matching name offers creating it */
  onCreate?: (name: string) => void;
  placeholder?: string;
  className?: string;
};

export function SearchableSelect({ options, value, onSelect, onCreate, placeholder = "Buscar…", className }: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const selected = options.find((option) => option.value === value);
  const normalized = query.trim().toLowerCase();
  const filtered = normalized
    ? options.filter((option) => option.label.toLowerCase().includes(normalized))
    : options;
  const exactMatch = options.some((option) => option.label.toLowerCase() === normalized);

  useEffect(() => {
    if (!isOpen) return;
    inputRef.current?.focus();
    const handlePointer = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setIsOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("keydown", handleKey, true);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("keydown", handleKey, true);
    };
  }, [isOpen]);

  const pick = (next: string) => {
    onSelect(next);
    setQuery("");
    setIsOpen(false);
  };

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        className="flex w-full items-center justify-between gap-1.5 rounded-sm border border-subtle bg-transparent px-2 py-1 text-left text-12 hover:bg-layer-1-hover"
      >
        <span className={cn("truncate", !selected && "text-placeholder")}>{selected?.label ?? placeholder}</span>
        <ChevronsUpDown className="size-3 shrink-0 text-tertiary" />
      </button>
      {isOpen && (
        <div className="absolute top-full left-0 z-10 mt-1 w-full min-w-52 rounded-md border border-subtle bg-layer-1 p-1.5 shadow-raised-200">
          <div className="relative mb-1">
            <Search className="absolute top-1/2 left-2 size-3 -translate-y-1/2 text-tertiary" />
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  if (filtered.length > 0) pick(filtered[0].value);
                  else if (onCreate && normalized) {
                    onCreate(query.trim());
                    setQuery("");
                    setIsOpen(false);
                  }
                }
              }}
              placeholder={placeholder}
              className="w-full rounded-sm border border-subtle bg-transparent py-1 pr-2 pl-6 text-12"
            />
          </div>
          <div className="max-h-44 space-y-0.5 overflow-y-auto">
            {filtered.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => pick(option.value)}
                className="flex w-full items-center justify-between gap-2 rounded-sm px-1.5 py-1 text-left text-12 hover:bg-layer-1-hover"
              >
                <span className="truncate">
                  {option.label}
                  {option.hint && <span className="ml-1 text-11 text-tertiary">{option.hint}</span>}
                </span>
                {option.value === value && <Check className="size-3 shrink-0 text-accent-primary" />}
              </button>
            ))}
            {filtered.length === 0 && !onCreate && <p className="px-1.5 py-1 text-11 text-tertiary">Sin coincidencias</p>}
            {onCreate && normalized && !exactMatch && (
              <button
                type="button"
                onClick={() => {
                  onCreate(query.trim());
                  setQuery("");
                  setIsOpen(false);
                }}
                className="flex w-full items-center gap-1.5 rounded-sm px-1.5 py-1 text-left text-12 text-accent-primary hover:bg-layer-1-hover"
              >
                <Plus className="size-3" /> Crear «{query.trim()}»
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
