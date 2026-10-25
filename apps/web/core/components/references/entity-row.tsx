/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { ReactNode } from "react";
import { Lock } from "lucide-react";
import { Link } from "react-router";
import { useTranslation } from "@plane/i18n";
import type { TEntityCard } from "@plane/types";
import { cn } from "@plane/utils";
import { usePeekLinkClick } from "@/components/entity-peek/use-entity-peek";
import { ENTITY_ICONS, entityLabelKey } from "./entity-meta";

type Props = {
  card: TEntityCard;
  /** Extra line under the title (e.g. "en un comentario"). */
  note?: string;
  actions?: ReactNode;
  showType?: boolean;
  className?: string;
};

/** One referenced or tagged thing in a list: icon, name, where it is from. */
export function EntityRow({ card, note, actions, showType = true, className }: Props) {
  const { t } = useTranslation();
  // Contracts, songs, releases and expenses open their panel here
  const openInPlace = usePeekLinkClick();
  const Icon = card.status === "restricted" ? Lock : ENTITY_ICONS[card.entity_name];
  const restricted = card.status !== "ok";
  const title = restricted
    ? t(card.status === "restricted" ? "references.restricted" : "references.missing")
    : card.title || "—";
  const detail = [showType ? t(entityLabelKey(card.entity_name)) : "", restricted ? "" : card.subtitle, note]
    .filter(Boolean)
    .join(" · ");

  const body = (
    <>
      <span className="grid size-7 shrink-0 place-items-center rounded-md bg-layer-1">
        <Icon className="size-3.5 text-secondary" />
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate text-13", restricted ? "text-tertiary" : "text-primary")}>{title}</span>
        {detail && <span className="block truncate text-11 text-tertiary">{detail}</span>}
      </span>
    </>
  );

  return (
    <div className={cn("group flex items-center gap-2.5 px-2 py-1.5", className)}>
      {restricted || !card.path ? (
        <span className="flex min-w-0 flex-1 items-center gap-2.5">{body}</span>
      ) : (
        <Link
          to={card.path}
          onClick={(event) => openInPlace(event, card)}
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md hover:bg-layer-1-hover"
        >
          {body}
        </Link>
      )}
      {actions}
    </div>
  );
}
