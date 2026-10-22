/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useState } from "react";
import useSWR from "swr";
import { useTranslation } from "@plane/i18n";
import type { TOffice } from "@plane/types";
import { cn } from "@plane/utils";
import { payrollService } from "@/services/payroll.service";
import { AguinaldoTab } from "./aguinaldo-tab";
import { AnnualCostTab } from "./annual-cost-tab";
import { PayrollPaymentsTab } from "./payments-tab";

type View = "payments" | "aguinaldo" | "annual";

/**
 * The payroll reports next to the budget they feed: payments given and coming
 * up, the aguinaldo owed for a year and — only for whoever was granted it —
 * the annual cost of the workforce. The API is the real gate for the last one;
 * the tab simply doesn't appear for anyone it would answer 404 to.
 */
export function PayrollSection({ workspaceSlug, defaultYear }: { workspaceSlug: string; defaultYear: number }) {
  const { t } = useTranslation();
  const [view, setView] = useState<View>("payments");
  const [year, setYear] = useState(defaultYear);
  const { data: offices = [] } = useSWR<TOffice[]>(`PAYROLL_OFFICES_${workspaceSlug}`, () =>
    payrollService.getOffices(workspaceSlug)
  );
  const { data: access } = useSWR(`PAYROLL_ACCESS_${workspaceSlug}`, () => payrollService.getAccess(workspaceSlug));
  const views: { key: View; label: string }[] = [
    { key: "payments", label: t("payroll.payments.title") },
    { key: "aguinaldo", label: t("payroll.aguinaldo.title") },
    ...(access?.can_view_annual_cost ? [{ key: "annual" as const, label: t("payroll.annual_cost.title") }] : []),
  ];
  const years = Array.from({ length: 5 }, (_, index) => defaultYear + 1 - index);

  return (
    <div className="mx-auto max-w-[1180px] space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" aria-label={t("payroll.title")} className="flex h-8 rounded-sm border border-subtle p-0.5">
          {views.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={view === key}
              onClick={() => setView(key)}
              className={cn(
                "rounded-xs px-2.5 text-12",
                view === key ? "bg-layer-2 font-medium text-primary" : "text-secondary hover:text-primary"
              )}
            >
              {label}
            </button>
          ))}
        </div>
        {view !== "payments" && (
          <label className="flex items-center gap-2 text-12 text-secondary">
            {t("payroll.year")}
            <select
              value={year}
              onChange={(event) => setYear(Number(event.target.value))}
              className="h-8 rounded-sm border border-subtle bg-layer-1 px-2 text-12 outline-none focus:border-accent-strong"
            >
              {years.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {view === "payments" && <PayrollPaymentsTab workspaceSlug={workspaceSlug} offices={offices} />}
      {view === "aguinaldo" && <AguinaldoTab workspaceSlug={workspaceSlug} year={year} />}
      {view === "annual" && access?.can_view_annual_cost && <AnnualCostTab workspaceSlug={workspaceSlug} year={year} />}
    </div>
  );
}
