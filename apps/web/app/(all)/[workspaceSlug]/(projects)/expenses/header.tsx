/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { useParams } from "next/navigation";
import { ReceiptText, Wallet } from "lucide-react";
import { useTranslation } from "@plane/i18n";
import { Breadcrumbs, Header } from "@plane/ui";
// components
import { BreadcrumbLink } from "@/components/common/breadcrumb-link";

export const ExpensesHeader = observer(function ExpensesHeader() {
  const { t } = useTranslation();
  const { workspaceSlug } = useParams();

  return (
    <Header>
      <Header.LeftItem>
        <Breadcrumbs>
          <Breadcrumbs.Item
            component={
              <BreadcrumbLink
                label={t("payments.expenses")}
                icon={<ReceiptText className="h-4 w-4 text-tertiary" />}
                isLast
              />
            }
          />
        </Breadcrumbs>
      </Header.LeftItem>
      <Header.RightItem>
        <BreadcrumbLink
          label={t("payments.budgets")}
          href={`/${workspaceSlug?.toString() ?? ""}/payments`}
          icon={<Wallet className="h-4 w-4 text-tertiary" />}
        />
      </Header.RightItem>
    </Header>
  );
});
