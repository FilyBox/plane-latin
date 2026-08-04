/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * Shared form and layout primitives for the contracts workflow.
 *
 * Everything here is built on Plane's design system so the contracts surfaces
 * read as native product UI: `text-13` for body copy, `text-11` for metadata,
 * semantic surface/layer backgrounds, and propel/ui controls instead of raw
 * `<input>`/`<select>` elements.
 */

import type { ReactNode } from "react";
import { Check, ChevronDown } from "lucide-react";
// plane imports
import { Badge } from "@plane/propel/badge";
import type { TBadgeVariant } from "@plane/propel/badge";
import { Input } from "@plane/propel/input";
import { CustomSelect } from "@plane/ui";
import { cn } from "@plane/utils";

/* -------------------------------------------------------------------------- */
/*                                   Layout                                   */
/* -------------------------------------------------------------------------- */

/**
 * A titled card. Sits on `layer-1` because contracts pages are already a
 * surface — nesting `surface-1` inside `surface-1` breaks the hierarchy.
 */
export function ContractSection({
  title,
  description,
  icon,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title?: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cn("overflow-hidden rounded-lg border border-subtle bg-layer-1", className)}>
      {title || actions ? (
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-subtle px-4 py-3">
          <div className="flex min-w-0 items-start gap-2.5">
            {icon ? <span className="mt-0.5 shrink-0 text-accent-primary">{icon}</span> : null}
            <div className="min-w-0">
              <h2 className="truncate text-14 font-semibold text-primary">{title}</h2>
              {description ? <p className="mt-0.5 text-11 text-tertiary">{description}</p> : null}
            </div>
          </div>
          {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      <div className={cn(bodyClassName)}>{children}</div>
    </section>
  );
}

/** Page-level heading used by every contracts route. */
export function ContractPageHeader({
  title,
  description,
  actions,
  breadcrumb,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  breadcrumb?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        {breadcrumb}
        <h1 className="truncate text-20 font-semibold text-primary">{title}</h1>
        {description ? <p className="mt-1 text-13 text-secondary">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/* -------------------------------------------------------------------------- */
/*                                    Form                                    */
/* -------------------------------------------------------------------------- */

/**
 * Label + control + inline error/hint. Errors render under the control so a
 * form can surface every problem at once instead of one footer message.
 */
export function ContractField({
  label,
  hint,
  error,
  optional,
  optionalLabel,
  htmlFor,
  children,
  className,
}: {
  label?: ReactNode;
  hint?: ReactNode;
  error?: string;
  optional?: boolean;
  optionalLabel?: string;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      {label ? (
        <label htmlFor={htmlFor} className="mb-1.5 block text-11 font-medium text-secondary">
          {label}
          {optional ? <span className="font-normal ml-1 text-tertiary">({optionalLabel})</span> : null}
        </label>
      ) : null}
      {children}
      {error ? (
        <p className="mt-1.5 text-11 text-danger-primary">{error}</p>
      ) : hint ? (
        <p className="mt-1.5 text-11 text-tertiary">{hint}</p>
      ) : null}
    </div>
  );
}

export function ContractInput({
  hasError,
  className,
  ...rest
}: React.InputHTMLAttributes<HTMLInputElement> & { hasError?: boolean }) {
  return <Input {...rest} hasError={hasError} className={cn("w-full", className)} />;
}

export function ContractTextarea({
  hasError,
  className,
  ...rest
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { hasError?: boolean }) {
  return (
    <textarea
      {...rest}
      aria-invalid={hasError || undefined}
      className={cn(
        "placeholder-tertiary block w-full rounded-md border-[0.5px] border-subtle-1 bg-layer-2 px-3 py-2 text-13 text-primary focus:outline-none",
        hasError && "border-danger-strong",
        className
      )}
    />
  );
}

export type TContractSelectOption<T extends string> = {
  value: T;
  label: string;
  /** Optional supporting line rendered under the label inside the dropdown. */
  description?: string;
};

/**
 * Plane-native replacement for the raw `<select>` elements the module used.
 * Keeps a plain value/onChange signature so call sites stay simple.
 */
export function ContractSelect<T extends string>({
  value,
  options,
  onChange,
  placeholder,
  disabled,
  hasError,
  className,
  buttonClassName,
  ariaLabel,
}: {
  value: T;
  options: TContractSelectOption<T>[];
  onChange: (value: T) => void;
  placeholder?: string;
  disabled?: boolean;
  hasError?: boolean;
  className?: string;
  buttonClassName?: string;
  ariaLabel?: string;
}) {
  const selected = options.find((option) => option.value === value);
  return (
    <CustomSelect
      value={value}
      onChange={onChange}
      disabled={disabled}
      className={cn("w-full", className)}
      buttonClassName={cn(
        "w-full justify-between rounded-md border-[0.5px] border-subtle-1 bg-layer-2 px-3 py-2 text-13",
        hasError && "border-danger-strong",
        buttonClassName
      )}
      noChevron
      label={
        <span className="flex w-full min-w-0 items-center justify-between gap-2" aria-label={ariaLabel}>
          <span className={cn("truncate", !selected && "text-placeholder")}>{selected?.label ?? placeholder}</span>
          <ChevronDown className="size-3.5 shrink-0 text-tertiary" aria-hidden />
        </span>
      }
      optionsClassName="min-w-56"
    >
      {options.map((option) => (
        <CustomSelect.Option key={option.value} value={option.value}>
          <span className="min-w-0">
            <span className="block truncate text-13 text-primary">{option.label}</span>
            {option.description ? <span className="block text-11 text-tertiary">{option.description}</span> : null}
          </span>
        </CustomSelect.Option>
      ))}
    </CustomSelect>
  );
}

/** Square checkbox matching the one the contracts table already uses. */
export function ContractCheckbox({
  checked,
  onChange,
  label,
  disabled,
  className,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-center gap-2 text-13 text-secondary has-disabled:cursor-not-allowed has-disabled:opacity-50",
        className
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="peer sr-only"
      />
      <span
        aria-hidden
        className={cn(
          "grid size-4 shrink-0 place-items-center rounded-sm border transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-accent-strong",
          checked ? "border-accent-strong bg-accent-primary text-on-color" : "border-strong"
        )}
      >
        {checked ? <Check className="size-3" /> : null}
      </span>
      {label}
    </label>
  );
}

/* -------------------------------------------------------------------------- */
/*                                   Status                                   */
/* -------------------------------------------------------------------------- */

/** Maps a signature-request status onto a propel badge variant. */
export const REQUEST_STATUS_VARIANT: Record<string, TBadgeVariant> = {
  DRAFT: "neutral",
  PREPARING: "brand",
  READY: "brand",
  PENDING: "warning",
  COMPLETED: "success",
  REJECTED: "danger",
  CANCELLED: "neutral",
  ERROR: "danger",
};

export function RequestStatusBadge({
  status,
  label,
  icon,
}: {
  status: string;
  label: string;
  icon?: React.ReactElement;
}) {
  return (
    <Badge variant={REQUEST_STATUS_VARIANT[status] ?? "neutral"} size="base" prependIcon={icon}>
      {label}
    </Badge>
  );
}

/* -------------------------------------------------------------------------- */
/*                                Empty states                                */
/* -------------------------------------------------------------------------- */

export function ContractEmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center px-6 py-14 text-center", className)}>
      <span className="grid size-11 place-items-center rounded-full bg-layer-2 text-tertiary">{icon}</span>
      <h3 className="mt-3 text-14 font-semibold text-primary">{title}</h3>
      {description ? <p className="mt-1 max-w-sm text-13 text-tertiary">{description}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

/** Centered spinner used while a contracts panel loads. */
export function ContractLoading({ className }: { className?: string }) {
  return (
    <div className={cn("grid min-h-48 place-items-center", className)}>
      <span className="border-t-accent-primary size-5 animate-spin rounded-full border-2 border-subtle" />
    </div>
  );
}
