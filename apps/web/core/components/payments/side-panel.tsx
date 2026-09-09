/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { Fragment } from "react";
import { Dialog, Transition } from "@headlessui/react";
import { X } from "lucide-react";
import { cn } from "@plane/utils";

type Props = {
  isOpen: boolean;
  title: string;
  description?: string;
  /** Rendered at the top-right of the header, next to the close button. */
  headerActions?: React.ReactNode;
  onClose: () => void;
  /** Panel width on desktop. Defaults to a comfortable form width. */
  width?: "md" | "lg" | "xl";
  children: React.ReactNode;
};

const WIDTHS = {
  md: "sm:max-w-md",
  lg: "sm:max-w-lg",
  xl: "sm:max-w-2xl",
} as const;

/**
 * A dialog that docks to the right edge on desktop and rises as a sheet on
 * mobile — the shape Plane uses for anything you fill in while still looking at
 * the table behind it. Built on the same Headless UI primitives as `ModalCore`,
 * with `ModalCore`'s own transition, so it opens exactly like every other dialog
 * in the app; only the placement differs.
 *
 * Children own the whole body: pass a flex column (typically a `<form>`) so the
 * content scrolls and the actions stay pinned at the bottom.
 */
export function PaymentsSidePanel(props: Props) {
  const { isOpen, title, description, headerActions, onClose, width = "xl", children } = props;

  return (
    <Transition.Root show={isOpen} as={Fragment}>
      <Dialog as="div" className="relative z-30" onClose={onClose}>
        <Transition.Child
          as={Fragment}
          enter="ease-out duration-300"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="ease-in duration-200"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <div className="fixed inset-0 bg-backdrop transition-opacity" />
        </Transition.Child>

        <div className="fixed inset-0 z-30 flex items-end justify-center sm:items-stretch sm:justify-end">
          <Transition.Child
            as={Fragment}
            enter="ease-out duration-300"
            enterFrom="opacity-0 translate-y-4 sm:translate-y-0 sm:scale-95"
            enterTo="opacity-100 translate-y-0 sm:scale-100"
            leave="ease-in duration-200"
            leaveFrom="opacity-100 translate-y-0 sm:scale-100"
            leaveTo="opacity-0 translate-y-4 sm:translate-y-0 sm:scale-95"
          >
            <Dialog.Panel
              className={cn(
                "flex max-h-[92vh] w-full transform flex-col overflow-hidden rounded-t-xl bg-surface-1 shadow-raised-200 transition-all",
                "sm:h-full sm:max-h-none sm:rounded-none sm:border-l sm:border-subtle",
                WIDTHS[width]
              )}
            >
              <header className="flex shrink-0 items-start justify-between gap-4 border-b border-subtle px-5 py-4">
                <div className="min-w-0">
                  <Dialog.Title className="truncate text-15 font-semibold text-primary">{title}</Dialog.Title>
                  {description && <p className="mt-1 text-12 text-tertiary">{description}</p>}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {headerActions}
                  <button
                    type="button"
                    onClick={onClose}
                    aria-label="Close"
                    className="flex size-7 items-center justify-center rounded-md text-tertiary hover:bg-layer-1-hover hover:text-primary"
                  >
                    <X className="size-4" />
                  </button>
                </div>
              </header>
              {children}
            </Dialog.Panel>
          </Transition.Child>
        </div>
      </Dialog>
    </Transition.Root>
  );
}
