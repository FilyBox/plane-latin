/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { LucideIcon } from "lucide-react";
import { Mic2, Shapes, Tag, User, Users, X } from "lucide-react";
import { useParams } from "next/navigation";
import { Link } from "react-router";
import { useTranslation } from "@plane/i18n";
import type { TSharedTag, TSharedTagKind } from "@plane/types";
import { cn } from "@plane/utils";
import { tagKindKey } from "./entity-meta";

export const TAG_KIND_ICONS: Record<TSharedTagKind, LucideIcon> = {
  ARTIST: Mic2,
  GROUP: Users,
  PERSON: User,
  TYPE: Shapes,
  CUSTOM: Tag,
};

type Props = {
  tag: TSharedTag;
  onRemove?: () => void;
  /** Link to everything carrying this tag. */
  linked?: boolean;
  className?: string;
};

/** A workspace tag next to project labels: the icon says what kind it is
 * (artist, group, type…), so the two never read as the same thing. */
export function SharedTagChip({ tag, onRemove, linked = true, className }: Props) {
  const { t } = useTranslation();
  const { workspaceSlug } = useParams();
  const Icon = TAG_KIND_ICONS[tag.kind] ?? Tag;
  const label = (
    <>
      <Icon className="size-3 shrink-0 text-secondary" aria-hidden />
      <span className="truncate">{tag.name}</span>
    </>
  );
  return (
    <span
      className={cn(
        "inline-flex h-5 max-w-full items-center gap-1 rounded-sm border border-subtle px-1.5 text-body-xs-regular text-primary",
        className
      )}
      title={`${tag.name} — ${t(tagKindKey(tag.kind))} · ${t("references.tags.workspace_tag")}`}
    >
      {linked && workspaceSlug ? (
        <Link
          to={`/${workspaceSlug}/tags/${tag.id}`}
          className="inline-flex min-w-0 items-center gap-1 hover:underline"
        >
          {label}
        </Link>
      ) : (
        label
      )}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="shrink-0 rounded-sm text-tertiary hover:text-danger-primary"
          aria-label={t("references.tags.remove", { name: tag.name })}
        >
          <X className="size-2.5" />
        </button>
      )}
    </span>
  );
}
