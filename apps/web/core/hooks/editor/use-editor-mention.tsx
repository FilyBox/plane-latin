/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { createElement, useCallback } from "react";
import { useParams } from "next/navigation";
// plane editor
import type { TMentionSection, TMentionSuggestion } from "@plane/editor";
import { useTranslation } from "@plane/i18n";
// plane types
import type { TSearchEntityRequestPayload, TSearchResponse, TUserSearchResponse } from "@plane/types";
// plane ui
import { Avatar } from "@plane/ui";
// helpers
import { getFileURL } from "@plane/utils";
// references
import { ENTITY_ICONS, ENTITY_ORDER } from "@/components/references/entity-meta";
import { useWorkspace } from "@/hooks/store/use-workspace";
// plane web hooks
import { useAdditionalEditorMention } from "@/hooks/use-additional-editor-mention";
import { referencesService } from "@/services/references.service";

type TArgs = {
  enableAdvancedMentions?: boolean;
  searchEntity: (payload: TSearchEntityRequestPayload) => Promise<TSearchResponse>;
};

export const useEditorMention = (args: TArgs) => {
  const { enableAdvancedMentions = false, searchEntity } = args;
  const { t } = useTranslation();
  // additional mentions
  const { editorMentionTypes, updateAdditionalSections } = useAdditionalEditorMention({
    enableAdvancedMentions,
  });
  // contracts, songs, files… from every module (behind the "references" flag)
  const { workspaceSlug } = useParams();
  const { isWorkspaceFeatureEnabled } = useWorkspace();
  const slug = workspaceSlug?.toString() ?? "";
  const referencesEnabled = !!slug && isWorkspaceFeatureEnabled(slug, "references");
  // fetch mentions handler
  const fetchMentions = useCallback(
    async (query: string): Promise<TMentionSection[]> => {
      try {
        const [res, entities] = await Promise.all([
          searchEntity({
            count: 5,
            query_type: editorMentionTypes,
            query,
          }),
          referencesEnabled
            ? referencesService.search(slug, query, { count: 4 }).catch(() => undefined)
            : Promise.resolve(undefined),
        ]);
        const suggestionSections: TMentionSection[] = [];
        if (!res) {
          throw new Error("No response found");
        }
        Object.keys(res).map((key) => {
          const responseKey = key as keyof TSearchResponse;
          const response = res[responseKey];
          if (responseKey === "user_mention" && response && response.length > 0) {
            const items: TMentionSuggestion[] = (response as TUserSearchResponse[]).map((user) => ({
              icon: (
                <Avatar
                  className="flex-shrink-0"
                  src={getFileURL(user.member__avatar_url)}
                  name={user.member__display_name}
                />
              ),
              id: user.member__id,
              entity_identifier: user.member__id,
              entity_name: "user_mention",
              title: user.member__display_name,
            }));
            suggestionSections.push({
              key: "users",
              title: "Users",
              items,
            });
          }
        });
        const { sections } = updateAdditionalSections({
          response: res,
        });
        const entitySections: TMentionSection[] = ENTITY_ORDER.filter(
          (name) => (entities?.results[name]?.length ?? 0) > 0
        ).map((name) => {
          const cards = entities?.results[name] ?? [];
          // The title leads; details (ISRC, year…) only tell same-named
          // items apart, after the title.
          const repeated = (title?: string) => cards.filter((card) => card.title === title).length > 1;
          return {
            key: `entity-${name}`,
            title: t(`references.groups.${name}`),
            items: cards.map((card) => ({
              icon: createElement(ENTITY_ICONS[name], { className: "size-3.5 shrink-0 text-secondary" }),
              id: card.id,
              entity_identifier: card.id,
              entity_name: name,
              title: repeated(card.title) && card.subtitle ? `${card.title} · ${card.subtitle}` : (card.title ?? ""),
            })),
          };
        });
        return [...suggestionSections, ...sections, ...entitySections];
      } catch (error) {
        console.error("Error in fetching mentions:", error);
        throw error;
      }
    },
    [editorMentionTypes, searchEntity, updateAdditionalSections, referencesEnabled, slug, t]
  );

  return {
    fetchMentions,
  };
};
