/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * A citation card for one document and the passages quoted from it.
 * Adapted from assistant-ui's document-reference element; contracts have no
 * page numbers in their extracted text, so each passage is labelled by the
 * term it was found by instead.
 */

import { FileText } from "lucide-react";
import { cn } from "@plane/utils";
import { AssistantLink } from "../links";
import { mono, paper } from "./surfaces";

export type DocumentAnchor = { label: string; quote: string };

type Props = {
  title: string;
  meta: string;
  anchors: readonly DocumentAnchor[];
  path?: string;
  className?: string;
};

export function DocumentReference({ title, meta, anchors, path, className }: Props) {
  return (
    <div data-slot="document-reference" className={cn(paper, "flex w-full flex-col gap-2 rounded-lg p-2.5", className)}>
      <div className="flex items-center gap-2">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-layer-2 text-tertiary">
          <FileText className="size-3.5" aria-hidden />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          {path ? (
            <AssistantLink href={path} className="truncate text-12 font-medium text-primary">
              {title}
            </AssistantLink>
          ) : (
            <span className="truncate text-12 font-medium text-primary">{title}</span>
          )}
          <span className={cn(mono, "text-tertiary")}>{meta}</span>
        </div>
      </div>
      {anchors.length > 0 && (
        <div className="flex flex-col gap-1">
          {anchors.map((anchor) => (
            <div
              key={`${anchor.label}:${anchor.quote.slice(0, 40)}`}
              className="flex flex-col gap-0.5 rounded-md px-1.5 py-1"
            >
              <span className={cn(mono, "text-tertiary")}>{anchor.label}</span>
              <span className="border-s-2 border-subtle ps-2 text-11 leading-relaxed break-words text-secondary">
                {anchor.quote}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
