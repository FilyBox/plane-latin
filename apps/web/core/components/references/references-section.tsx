/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { ReactNode } from "react";
import { X } from "lucide-react";
import useSWR, { mutate as mutateGlobal } from "swr";
import { useTranslation } from "@plane/i18n";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TEntityCard, TEntityName, TReferenceSource } from "@plane/types";
import { useWorkspace } from "@/hooks/store/use-workspace";
import { referencesService } from "@/services/references.service";
import { EntityRow } from "./entity-row";

export const referencesKey = (workspaceSlug: string, type: string, id: string) => [
  "ENTITY_REFERENCES",
  workspaceSlug,
  type,
  id,
];

export function useEntityReferences(
  workspaceSlug: string,
  type: TEntityName | TReferenceSource,
  id: string,
  enabled = true
) {
  return useSWR(enabled ? referencesKey(workspaceSlug, type, id) : null, () =>
    referencesService.getReferences(workspaceSlug, type, id)
  );
}

export async function attachReference(
  workspaceSlug: string,
  source: TReferenceSource,
  sourceId: string,
  target: TEntityCard
) {
  await referencesService.attach(workspaceSlug, source, sourceId, { entity_name: target.entity_name, id: target.id });
  await Promise.all([
    mutateGlobal(referencesKey(workspaceSlug, source, sourceId)),
    mutateGlobal(referencesKey(workspaceSlug, target.entity_name, target.id)),
  ]);
}

type Props = {
  workspaceSlug: string;
  source: TReferenceSource;
  sourceId: string;
  disabled?: boolean;
};

/** What a work item or page points to (mentions and attachments), and where
 * it is itself mentioned. */
export function ReferencesContent({ workspaceSlug, source, sourceId, disabled }: Props) {
  const { t } = useTranslation();
  const { data } = useEntityReferences(workspaceSlug, source, sourceId);
  const outgoing = data?.outgoing ?? [];
  const backlinks = data?.backlinks ?? [];

  const detach = async (card: TEntityCard) => {
    try {
      await referencesService.detach(workspaceSlug, source, sourceId, { entity_name: card.entity_name, id: card.id });
      await Promise.all([
        mutateGlobal(referencesKey(workspaceSlug, source, sourceId)),
        mutateGlobal(referencesKey(workspaceSlug, card.entity_name, card.id)),
      ]);
    } catch {
      setToast({ type: TOAST_TYPE.ERROR, title: t("references.toasts.error") });
    }
  };

  const kindNote = (card: TEntityCard) => (card.kinds ?? []).map((kind) => t(`references.kind.${kind}`)).join(" · ");

  return (
    <div className="space-y-4 py-2">
      {outgoing.length > 0 && (
        <section>
          <h4 className="px-2 pb-1 text-11 font-medium text-tertiary">{t("references.section.outgoing")}</h4>
          <ul className="divide-y divide-subtle rounded-md border border-subtle">
            {outgoing.map((card) => (
              <li key={`${card.entity_name}:${card.id}`}>
                <EntityRow
                  card={card}
                  note={kindNote(card)}
                  actions={
                    !disabled &&
                    card.kinds?.includes("attachment") && (
                      <button
                        type="button"
                        onClick={() => void detach(card)}
                        className="rounded-sm p-1 text-tertiary opacity-0 group-hover:opacity-100 hover:bg-layer-1-hover hover:text-primary focus-visible:opacity-100"
                        aria-label={t("references.detach")}
                        title={t("references.detach")}
                      >
                        <X className="size-3.5" />
                      </button>
                    )
                  }
                />
              </li>
            ))}
          </ul>
        </section>
      )}
      {backlinks.length > 0 && (
        <section>
          <h4 className="px-2 pb-1 text-11 font-medium text-tertiary">{t("references.section.backlinks")}</h4>
          <ul className="divide-y divide-subtle rounded-md border border-subtle">
            {backlinks.map((card) => (
              <li key={`${card.entity_name}:${card.id}`}>
                <EntityRow card={card} note={card.in_comment ? t("references.in_comment") : undefined} />
              </li>
            ))}
          </ul>
        </section>
      )}
      {outgoing.length === 0 && backlinks.length === 0 && (
        <p className="px-2 py-3 text-13 text-tertiary">{t("references.section.empty")}</p>
      )}
    </div>
  );
}

/** "Referenciado en" for a contract, song, file, expense… — the work items and
 * pages that mention or attach it. Renders nothing when there are none. */
export function EntityBacklinks({
  workspaceSlug,
  entityName,
  entityId,
  className,
  renderTitle,
}: {
  workspaceSlug: string;
  entityName: TEntityName;
  entityId: string;
  className?: string;
  /** Use the host panel's own section title style. */
  renderTitle?: (label: string, count: number) => ReactNode;
}) {
  const { t } = useTranslation();
  const { isWorkspaceFeatureEnabled } = useWorkspace();
  const enabled = isWorkspaceFeatureEnabled(workspaceSlug, "references");
  const { data } = useEntityReferences(workspaceSlug, entityName, entityId, enabled);
  const backlinks = data?.backlinks ?? [];
  if (!enabled || backlinks.length === 0) return null;
  return (
    <section className={className}>
      {renderTitle ? (
        renderTitle(t("references.section.backlinks"), backlinks.length)
      ) : (
        <h3 className="mb-2 text-13 font-medium text-primary">
          {t("references.section.backlinks")}
          <span className="font-normal ml-1.5 text-12 text-tertiary">{backlinks.length}</span>
        </h3>
      )}
      <ul className="divide-y divide-subtle rounded-md border border-subtle">
        {backlinks.map((card) => (
          <li key={`${card.entity_name}:${card.id}`}>
            <EntityRow card={card} note={card.in_comment ? t("references.in_comment") : undefined} />
          </li>
        ))}
      </ul>
    </section>
  );
}
