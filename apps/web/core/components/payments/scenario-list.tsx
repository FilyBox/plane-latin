/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useMemo, useState } from "react";
import { Archive, ArrowRight, CalendarRange, Loader2, Plus, Search, Sparkles, Users, Variable } from "lucide-react";
import useSWR from "swr";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import type { TBudgetScenario } from "@plane/types";
import { cn } from "@plane/utils";
import { financeService } from "@/services/finance.service";
import { BudgetScenarioModal } from "./scenario-modal";

type Props = {
  workspaceSlug: string;
  onOpen: (scenario: TBudgetScenario) => void;
};

export function BudgetScenarioList({ workspaceSlug, onOpen }: Props) {
  const { t } = useTranslation();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [year, setYear] = useState<number | "all">("all");
  const {
    data: scenarios,
    mutate,
    isLoading,
  } = useSWR<TBudgetScenario[]>(`BUDGET_SCENARIOS_${workspaceSlug}`, () => financeService.getScenarios(workspaceSlug), {
    revalidateOnFocus: false,
  });

  const years = useMemo(
    () => [...new Set((scenarios ?? []).map((scenario) => scenario.fiscal_year))].sort((a, b) => b - a),
    [scenarios]
  );
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (scenarios ?? []).filter(
      (scenario) =>
        (year === "all" || scenario.fiscal_year === year) &&
        (!query || scenario.name.toLowerCase().includes(query) || scenario.description.toLowerCase().includes(query))
    );
  }, [scenarios, search, year]);

  return (
    <div className="h-full overflow-y-auto bg-surface-1">
      <BudgetScenarioModal
        workspaceSlug={workspaceSlug}
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        onSaved={() => void mutate()}
      />

      <div className="mx-auto max-w-[1180px] px-4 py-8 sm:px-8 sm:py-10">
        <section className="relative overflow-hidden rounded-xl border border-subtle bg-layer-1 px-5 py-6 sm:px-8">
          <div className="absolute -top-16 -right-10 size-48 rounded-full bg-accent-primary/10 blur-3xl" />
          <div className="relative flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
            <div className="max-w-2xl">
              <div className="mb-3 flex size-9 items-center justify-center rounded-md border border-subtle bg-layer-2 text-accent-primary">
                <Sparkles className="size-4" />
              </div>
              <h1 className="text-24 font-semibold tracking-tight text-primary">{t("payments.scenarios.title")}</h1>
              <p className="mt-2 text-13 leading-5 text-secondary">{t("payments.scenarios.description")}</p>
            </div>
            <Button variant="primary" size="sm" onClick={() => setIsCreateOpen(true)}>
              <Plus className="size-4" />
              {t("payments.scenarios.create")}
            </Button>
          </div>
        </section>

        <div className="mt-7 flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
          <div>
            <h2 className="text-15 font-semibold text-primary">{t("payments.scenarios.your_budgets")}</h2>
            <p className="mt-0.5 text-12 text-tertiary">
              {t("payments.scenarios.count", { count: scenarios?.length ?? 0 })}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-tertiary" />
              <input
                className="focus:border-accent-primary h-8 w-48 rounded-sm border border-subtle bg-layer-1 pr-2 pl-8 text-12 outline-none"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t("payments.scenarios.search")}
              />
            </div>
            <select
              className="h-8 rounded-sm border border-subtle bg-layer-1 px-2 text-12 outline-none"
              value={year}
              onChange={(event) => setYear(event.target.value === "all" ? "all" : Number(event.target.value))}
            >
              <option value="all">{t("payments.scenarios.all_years")}</option>
              {years.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </div>
        </div>

        {isLoading ? (
          <div className="flex justify-center py-24">
            <Loader2 className="size-5 animate-spin text-tertiary" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="mt-5 flex min-h-72 flex-col items-center justify-center rounded-xl border border-dashed border-subtle bg-layer-1 px-6 text-center">
            <div className="flex size-11 items-center justify-center rounded-lg bg-layer-2 text-secondary">
              <CalendarRange className="size-5" />
            </div>
            <h3 className="text-15 mt-4 font-medium text-primary">{t("payments.scenarios.empty_title")}</h3>
            <p className="mt-1 max-w-sm text-12 leading-5 text-tertiary">{t("payments.scenarios.empty_description")}</p>
            {(scenarios?.length ?? 0) === 0 && (
              <Button className="mt-4" variant="primary" size="sm" onClick={() => setIsCreateOpen(true)}>
                <Plus className="size-4" />
                {t("payments.scenarios.create_first")}
              </Button>
            )}
          </div>
        ) : (
          <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {filtered.map((scenario) => (
              <button
                key={scenario.id}
                type="button"
                onClick={() => onOpen(scenario)}
                className="group flex min-h-52 flex-col overflow-hidden rounded-xl border border-subtle bg-layer-1 text-left transition-all hover:border-strong hover:shadow-raised-200"
              >
                <div className="flex flex-1 flex-col p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-accent-primary/10 text-16 font-semibold text-accent-primary">
                      {scenario.fiscal_year.toString().slice(-2)}
                    </div>
                    <span
                      className={cn(
                        "rounded-full px-2 py-1 text-10 font-medium tracking-wide uppercase",
                        scenario.status === "ACTIVE" && "bg-success-primary/10 text-success-primary",
                        scenario.status === "DRAFT" && "bg-warning-primary/10 text-warning-primary",
                        scenario.status === "ARCHIVED" && "bg-layer-2 text-tertiary"
                      )}
                    >
                      {t(`payments.scenarios.status.${scenario.status.toLowerCase()}`)}
                    </span>
                  </div>
                  <h3 className="mt-4 truncate text-16 font-semibold text-primary">{scenario.name}</h3>
                  <p className="mt-1 line-clamp-2 min-h-10 text-12 leading-5 text-tertiary">
                    {scenario.description || t("payments.scenarios.no_description")}
                  </p>
                  <div className="mt-4 flex items-center gap-3 text-11 text-secondary">
                    <span className="flex items-center gap-1.5">
                      <Users className="size-3.5 text-tertiary" /> {scenario.employee_count}
                    </span>
                    <span className="flex items-center gap-1.5">
                      <Variable className="size-3.5 text-tertiary" /> {scenario.variable_count}
                    </span>
                    <span className="ml-auto font-medium">{scenario.currency}</span>
                  </div>
                </div>
                <div className="flex items-center justify-between border-t border-subtle px-5 py-3 text-11 text-tertiary">
                  <span className="flex items-center gap-1.5">
                    <Archive className="size-3" /> {scenario.period_start} / {scenario.period_end}
                  </span>
                  <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-1 group-hover:text-primary" />
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
