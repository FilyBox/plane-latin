/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// plane imports
import type { TFilterProperty, TSharedTag, TSupportedOperators } from "@plane/types";
import { COLLECTION_OPERATOR, EQUALITY_OPERATOR } from "@plane/types";
// local imports
import type { IFilterIconConfig, TCreateFilterConfig, TCreateFilterConfigParams } from "../../../rich-filters";
import { createFilterConfig, createOperatorConfigEntry, getMultiSelectConfig } from "../../../rich-filters";

/**
 * Workspace (shared) tag filter params. The option icon data is the tag kind
 * (artist, group, type…).
 */
export type TCreateSharedTagFilterParams = TCreateFilterConfigParams &
  IFilterIconConfig<TSharedTag["kind"]> & {
    sharedTags: TSharedTag[];
    /** Shown name of the filter, already translated. */
    label: string;
  };

const getSharedTagMultiSelectConfig = (
  params: TCreateSharedTagFilterParams,
  singleValueOperator: TSupportedOperators
) =>
  getMultiSelectConfig<TSharedTag, string, TSharedTag["kind"]>(
    {
      items: params.sharedTags,
      getId: (tag) => tag.id,
      getLabel: (tag) => tag.name,
      getValue: (tag) => tag.id,
      getIconData: (tag) => tag.kind,
    },
    {
      singleValueOperator,
      ...params,
    },
    {
      getOptionIcon: params.getOptionIcon,
    }
  );

/**
 * Filter by workspace tags: the tags shared by contracts, files, music and
 * work items, as opposed to a project's own labels.
 */
export const getSharedTagFilterConfig =
  <P extends TFilterProperty>(key: P): TCreateFilterConfig<P, TCreateSharedTagFilterParams> =>
  (params: TCreateSharedTagFilterParams) =>
    createFilterConfig<P>({
      id: key,
      ...params,
      icon: params.filterIcon,
      supportedOperatorConfigsMap: new Map([
        createOperatorConfigEntry(COLLECTION_OPERATOR.IN, params, (updatedParams) =>
          getSharedTagMultiSelectConfig(updatedParams, EQUALITY_OPERATOR.EXACT)
        ),
      ]),
    });
