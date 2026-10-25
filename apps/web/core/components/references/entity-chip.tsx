/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { Lock } from "lucide-react";
import { useParams } from "next/navigation";
import { Link } from "react-router";
import { useTranslation } from "@plane/i18n";
import { Popover } from "@plane/propel/popover";
import type { TEntityCard, TEntityName } from "@plane/types";
import { cn } from "@plane/utils";
import { usePeekLinkClick } from "@/components/entity-peek/use-entity-peek";
import { ENTITY_ICONS, entityLabelKey } from "./entity-meta";
import { useEntityCard } from "./use-entity-card";

type Props = { entity_name: TEntityName; id: string };

/** A mentioned contract, song, file… inside editor text. It shows what the
 * viewer may see: the name and a link, or only that something is there. */
export function EntityMentionChip({ entity_name, id }: Props) {
  const { t } = useTranslation();
  const { workspaceSlug } = useParams();
  const { data: card } = useEntityCard(workspaceSlug?.toString(), entity_name, id);
  // Contracts, songs, releases and expenses open their panel here
  const openInPlace = usePeekLinkClick();
  const Icon = ENTITY_ICONS[entity_name];

  if (!card) {
    return (
      <span className="not-prose inline-flex items-center gap-1 rounded-sm bg-layer-1 px-1 py-0.5 align-baseline text-tertiary">
        <Icon className="size-3 shrink-0" />…
      </span>
    );
  }
  if (card.status !== "ok") {
    return (
      <span
        className={cn(
          "not-prose inline-flex items-center gap-1 rounded-sm bg-layer-1 px-1 py-0.5 align-baseline text-tertiary",
          card.status === "missing" && "line-through"
        )}
        title={t(card.status === "restricted" ? "references.restricted_help" : "references.missing_help")}
      >
        {card.status === "restricted" ? <Lock className="size-3 shrink-0" /> : <Icon className="size-3 shrink-0" />}
        {t(card.status === "restricted" ? "references.restricted" : "references.missing")}
      </span>
    );
  }
  return (
    <span className="not-prose inline align-baseline">
      <Popover delay={150} openOnHover>
        <Popover.Button>
          <Link
            to={card.path ?? "#"}
            onClick={(event) => openInPlace(event, { entity_name, id })}
            className="inline-flex items-center gap-1 rounded-sm bg-layer-1 px-1 py-0.5 text-primary no-underline hover:bg-layer-1-hover"
          >
            <Icon className="size-3 shrink-0 text-secondary" />
            {card.title}
          </Link>
        </Popover.Button>
        <Popover.Panel side="bottom" align="start">
          <EntityPreview card={card} />
        </Popover.Panel>
      </Popover>
    </span>
  );
}

export function EntityPreview({ card }: { card: TEntityCard }) {
  const { t } = useTranslation();
  const Icon = ENTITY_ICONS[card.entity_name];
  const image = (card.meta?.cover_url || card.meta?.avatar_url) as string | undefined;
  return (
    <div className="flex w-64 gap-3 rounded-lg border-[0.5px] border-strong bg-surface-1 p-3 shadow-raised-200">
      {image ? (
        <img src={image} alt="" className="size-10 shrink-0 rounded-md object-cover" />
      ) : (
        <span className="grid size-10 shrink-0 place-items-center rounded-md bg-layer-1">
          <Icon className="size-4 text-secondary" />
        </span>
      )}
      <div className="min-w-0">
        <p className="text-11 text-tertiary">{t(entityLabelKey(card.entity_name))}</p>
        <p className="truncate text-13 font-medium text-primary">{card.title}</p>
        {card.subtitle && <p className="truncate text-11 text-secondary">{card.subtitle}</p>}
      </div>
    </div>
  );
}
