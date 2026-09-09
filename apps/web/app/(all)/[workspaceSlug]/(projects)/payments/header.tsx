/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { useParams } from "next/navigation";
import { useSearchParams } from "react-router";
import { ReceiptText, Wallet } from "lucide-react";
import useSWR from "swr";
import { useTranslation } from "@plane/i18n";
import type { TBudgetScenario } from "@plane/types";
import { Breadcrumbs, Header } from "@plane/ui";
// components
import { BreadcrumbLink } from "@/components/common/breadcrumb-link";
// services
import { financeService } from "@/services/finance.service";

export const PaymentsHeader = observer(function PaymentsHeader() {
  const { t } = useTranslation();
  const { workspaceSlug } = useParams();
  const [searchParams] = useSearchParams();
  const slug = workspaceSlug?.toString() ?? "";
  const scenarioId = searchParams.get("budget");
  // Same SWR key the page body uses, so opening a budget costs no extra request —
  // the breadcrumb just reads the entry the route already put in the cache.
  const { data: scenario } = useSWR<TBudgetScenario>(
    scenarioId && slug ? `BUDGET_SCENARIO_${slug}_${scenarioId}` : null,
    () => financeService.getScenario(slug, scenarioId as string),
    { revalidateOnFocus: false }
  );

  return (
    <Header>
      <Header.LeftItem>
        <Breadcrumbs>
          <Breadcrumbs.Item
            component={
              <BreadcrumbLink
                label={t("payments.title")}
                // Dropping the query param is what "back to the list" means here,
                // which is why the detail view no longer needs its own back arrow.
                href={scenarioId ? `/${slug}/payments` : undefined}
                icon={<Wallet className="h-4 w-4 text-tertiary" />}
                isLast={!scenarioId}
              />
            }
          />
          {scenarioId && (
            <Breadcrumbs.Item component={<BreadcrumbLink label={scenario?.name ?? "…"} isLast />} />
          )}
        </Breadcrumbs>
        {scenario && (
          <span className="ml-1 hidden rounded-full bg-layer-2 px-2 py-0.5 text-10 font-medium text-secondary sm:inline">
            {t(`payments.scenarios.status.${scenario.status.toLowerCase()}`)}
          </span>
        )}
      </Header.LeftItem>
      <Header.RightItem>
        <BreadcrumbLink
          label={t("payments.expenses")}
          href={`/${slug}/expenses`}
          icon={<ReceiptText className="h-4 w-4 text-tertiary" />}
        />
      </Header.RightItem>
    </Header>
  );
});
