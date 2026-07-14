/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useState } from "react";
import { useSearchParams } from "react-router";
import { Loader2 } from "lucide-react";
import useSWR from "swr";
import type { TBudgetScenario } from "@plane/types";
import { financeService } from "@/services/finance.service";
import { BudgetScenarioDetail } from "./scenario-detail";
import { BudgetScenarioList } from "./scenario-list";

type Props = {
  workspaceSlug: string;
};

export function PaymentsRoot({ workspaceSlug }: Props) {
  const [searchParams, setSearchParams] = useSearchParams();
  const scenarioId = searchParams.get("budget");
  const [selectedScenario, setSelectedScenario] = useState<TBudgetScenario | null>(null);
  const needsScenario = Boolean(scenarioId && selectedScenario?.id !== scenarioId);
  const { data: loadedScenario, isLoading } = useSWR<TBudgetScenario>(
    needsScenario ? `BUDGET_SCENARIO_${workspaceSlug}_${scenarioId}` : null,
    () => financeService.getScenario(workspaceSlug, scenarioId as string),
    { revalidateOnFocus: false }
  );
  const scenario = selectedScenario?.id === scenarioId ? selectedScenario : loadedScenario;

  const openScenario = (nextScenario: TBudgetScenario) => {
    setSelectedScenario(nextScenario);
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.set("budget", nextScenario.id);
      return next;
    });
  };

  const closeScenario = () => {
    setSelectedScenario(null);
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.delete("budget");
      return next;
    });
  };

  if (!scenarioId) {
    return <BudgetScenarioList workspaceSlug={workspaceSlug} onOpen={openScenario} />;
  }

  if (isLoading || !scenario) {
    return (
      <div className="flex h-full items-center justify-center bg-surface-1">
        <Loader2 className="size-5 animate-spin text-tertiary" />
      </div>
    );
  }

  return (
    <BudgetScenarioDetail
      workspaceSlug={workspaceSlug}
      scenario={scenario}
      onBack={closeScenario}
      onChanged={setSelectedScenario}
      onDeleted={closeScenario}
    />
  );
}
