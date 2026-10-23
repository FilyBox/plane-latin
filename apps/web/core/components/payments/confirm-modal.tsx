/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { ComponentProps } from "react";
import { useTranslation } from "@plane/i18n";
import { AlertModalCore } from "@plane/ui";

/** The shared confirmation modal with its buttons in the user's language:
 * left alone it reads "Cancel" / "Delete" in English. */
export function FinanceConfirmModal(props: ComponentProps<typeof AlertModalCore>) {
  const { t } = useTranslation();
  return (
    <AlertModalCore
      primaryButtonText={{ default: t("common.delete"), loading: t("common.deleting") }}
      secondaryButtonText={t("common.cancel")}
      {...props}
    />
  );
}
