/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback } from "react";
import useSWR, { mutate as mutateGlobal } from "swr";
import type { TEntityName, TSharedTag, TSharedTagKind } from "@plane/types";
import { referencesService } from "@/services/references.service";

export const sharedTagsKey = (workspaceSlug: string) => ["SHARED_TAGS", workspaceSlug];
export const entityTagsKey = (workspaceSlug: string, type: string, id: string) => [
  "ENTITY_TAGS",
  workspaceSlug,
  type,
  id,
];

/** Every shared tag in the workspace, for pickers. */
export function useSharedTags(workspaceSlug: string | undefined, enabled = true) {
  return useSWR(enabled && workspaceSlug ? sharedTagsKey(workspaceSlug) : null, () =>
    referencesService.getTags(workspaceSlug!)
  );
}

/** One entity's shared tags, with a setter that keeps every view in step. */
export function useEntityTags(
  workspaceSlug: string | undefined,
  type: TEntityName,
  id: string | undefined,
  enabled = true
) {
  const key = enabled && workspaceSlug && id ? entityTagsKey(workspaceSlug, type, id) : null;
  const swr = useSWR(key, () => referencesService.getEntityTags(workspaceSlug!, type, id!));
  const setTags = useCallback(
    async (tagIds: string[]) => {
      if (!workspaceSlug || !id) return;
      const saved = await referencesService.setEntityTags(workspaceSlug, type, id, tagIds);
      await swr.mutate(saved, false);
      // Tag views and bulk lists read the same links.
      void mutateGlobal(
        (value) => Array.isArray(value) && (value[0] === "SHARED_TAG_ENTITIES" || value[0] === "ENTITY_TAGS_BULK")
      );
      return saved;
    },
    [workspaceSlug, type, id, swr]
  );
  return { ...swr, setTags };
}

export async function createSharedTag(
  workspaceSlug: string,
  name: string,
  kind: TSharedTagKind = "CUSTOM"
): Promise<TSharedTag> {
  const tag = await referencesService.createTag(workspaceSlug, { name, kind });
  await mutateGlobal(sharedTagsKey(workspaceSlug));
  return tag;
}
