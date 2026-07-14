/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Search, X } from "lucide-react";
import { cn } from "@plane/utils";

type Props = {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  clearLabel: string;
  className?: string;
};

export function ResourceSearch({ value, onChange, placeholder, clearLabel, className }: Props) {
  return (
    <div className={cn("relative", className)}>
      <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-tertiary" />
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="focus:border-accent-primary h-8 w-full rounded-md border border-subtle bg-layer-1 pr-8 pl-8 text-11 text-primary outline-none placeholder:text-placeholder"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          className="absolute top-1/2 right-2 flex size-5 -translate-y-1/2 items-center justify-center rounded-sm text-tertiary hover:bg-layer-1-hover hover:text-primary"
          aria-label={clearLabel}
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  );
}
