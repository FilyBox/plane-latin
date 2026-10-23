/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import useSWR from "swr";
import type { TEntityCard, TEntityName } from "@plane/types";
import { referencesService } from "@/services/references.service";

type Pending = {
  entity_name: TEntityName;
  id: string;
  resolve: (card: TEntityCard) => void;
  reject: (error: unknown) => void;
};

// Mentions render one chip at a time; collecting the requests made in the same
// tick turns a description with twenty mentions into a single call.
const queues = new Map<string, Pending[]>();

function flush(workspaceSlug: string) {
  const batch = queues.get(workspaceSlug) ?? [];
  queues.delete(workspaceSlug);
  if (batch.length === 0) return;
  const items = batch.map(({ entity_name, id }) => ({ entity_name, id }));
  referencesService
    .resolve(workspaceSlug, items)
    .then((cards) => {
      const byKey = new Map(cards.map((card) => [`${card.entity_name}:${card.id}`, card]));
      batch.forEach((item) =>
        item.resolve(byKey.get(`${item.entity_name}:${item.id}`) ?? { ...item, status: "missing" })
      );
      return undefined;
    })
    .catch((error) => batch.forEach((item) => item.reject(error)));
}

export function resolveEntityCard(workspaceSlug: string, entity_name: TEntityName, id: string): Promise<TEntityCard> {
  return new Promise((resolve, reject) => {
    const queue = queues.get(workspaceSlug);
    if (queue) queue.push({ entity_name, id, resolve, reject });
    else {
      queues.set(workspaceSlug, [{ entity_name, id, resolve, reject }]);
      setTimeout(() => flush(workspaceSlug), 20);
    }
  });
}

export const entityCardKey = (workspaceSlug: string, entity_name: string, id: string) => [
  "ENTITY_CARD",
  workspaceSlug,
  entity_name,
  id,
];

export function useEntityCard(workspaceSlug: string | undefined, entity_name: TEntityName, id: string | undefined) {
  return useSWR(
    workspaceSlug && id ? entityCardKey(workspaceSlug, entity_name, id) : null,
    () => resolveEntityCard(workspaceSlug!, entity_name, id!),
    { revalidateOnFocus: false, dedupingInterval: 60_000 }
  );
}
