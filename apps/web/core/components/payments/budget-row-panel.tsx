/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useRef, useState } from "react";
import { Paperclip, Trash2 } from "lucide-react";
import useSWR from "swr";
import { useTranslation } from "@plane/i18n";
import {
  DueDatePropertyIcon,
  EstimatePropertyIcon,
  LabelPropertyIcon,
  ParentPropertyIcon,
  UserCirclePropertyIcon,
} from "@plane/propel/icons";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TBudgetForecastLine, TBudgetScenario } from "@plane/types";
import { AlertModalCore, TextArea } from "@plane/ui";
import { SidebarPropertyListItem } from "@/components/common/layout/sidebar/property-list-item";
import { financeService } from "@/services/finance.service";
import { payrollService } from "@/services/payroll.service";
import { PaymentsSidePanel } from "./side-panel";
import { DocumentAttachments } from "./document-attachments";
import { FinanceComments } from "./finance-comments";
import { FinanceCategorySelect, FinanceOfficeSelect } from "./tag-picker";
import { FinancialVariableModal } from "./variable-modal";
import { formatMoney } from "./shared";

type Props = {
  workspaceSlug: string;
  scenario: TBudgetScenario;
  line: TBudgetForecastLine;
  /** The month whose conversation opened the panel, "" for the row itself. */
  cell: string;
  onClose: () => void;
  onChanged: () => void;
};

export function BudgetRowPanel({ workspaceSlug, scenario, line, cell, onClose, onChanged }: Props) {
  const { t } = useTranslation();
  const [title, setTitle] = useState(line.label);
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState(line.category_id ?? "");
  const [selectedCell, setSelectedCell] = useState(cell);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [editSource, setEditSource] = useState(false);
  const loaded = useRef(false);
  const [kind, id] = line.key.split(":");

  const { data, mutate } = useSWR(["BUDGET_ROW", workspaceSlug, scenario.id, line.key], () =>
    financeService.getBudgetRow(workspaceSlug, scenario.id, line.key)
  );
  const { data: assignments = [] } = useSWR(
    kind !== "variable" ? ["ROW_EMPLOYEES", workspaceSlug, scenario.id] : null,
    () => financeService.getScenarioEmployees(workspaceSlug, scenario.id)
  );
  const { data: variables = [] } = useSWR(
    kind === "variable" ? ["ROW_VARIABLES", workspaceSlug, scenario.id] : null,
    () => financeService.getScenarioVariables(workspaceSlug, scenario.id)
  );
  const { data: offices = [] } = useSWR(editSource ? ["PAYROLL_OFFICES_LIST", workspaceSlug] : null, () =>
    payrollService.getOffices(workspaceSlug)
  );
  const assignment = assignments.find((item) => item.id === id || item.bonuses.some((bonus) => bonus.id === id));
  const variable = variables.find((item) => item.id === id)?.variable_detail;

  useEffect(() => {
    if (!data || loaded.current) return;
    loaded.current = true;
    setTitle(data.title || line.label);
    setDescription(data.description);
    setCategory(data.category ?? line.category_id ?? "");
  }, [data, line.label, line.category_id]);
  useEffect(() => setSelectedCell(cell), [cell]);

  const run = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await operation();
      onChanged();
    } catch {
      setToast({ type: TOAST_TYPE.ERROR, title: t("payments.toasts.error") });
    } finally {
      setBusy(false);
    }
  };

  /** Every field saves on blur, the way a work item does — there is no Save
   * button to hunt for and no draft to lose by closing the panel. */
  const persist = (patch: { title?: string; description?: string; category?: string | null; entity?: string }) =>
    run(async () => {
      const saved = await financeService.updateBudgetRow(workspaceSlug, scenario.id, line.key, {
        title,
        description,
        category: category || null,
        ...patch,
      });
      await mutate(saved, false);
    });

  const remove = () =>
    run(async () => {
      if (kind === "variable") await financeService.removeScenarioVariable(workspaceSlug, scenario.id, id);
      else if (kind === "bonus" && assignment)
        await financeService.deleteBudgetBonus(workspaceSlug, scenario.id, assignment.id, id);
      else await financeService.removeScenarioEmployee(workspaceSlug, scenario.id, id);
      onClose();
    });

  const saveDocuments = (assetIds: string[]) =>
    run(async () => {
      const saved = await financeService.updateBudgetRow(workspaceSlug, scenario.id, line.key, {
        asset_ids: assetIds,
      });
      await mutate(saved, false);
    });

  const source = assignment
    ? `${assignment.employee_name} · ${formatMoney(assignment.salary_amount, assignment.salary_currency)}`
    : variable
      ? `${variable.name} · ${formatMoney(variable.amount, variable.currency)}`
      : line.entity_name;

  return (
    <>
      <PaymentsSidePanel
        isOpen
        title={line.label}
        onClose={onClose}
        headerActions={
          <button
            type="button"
            onClick={() => setDeleting(true)}
            aria-label={t("payments.actions.delete")}
            className="rounded-sm p-1 text-tertiary hover:bg-layer-1-hover hover:text-danger-primary"
          >
            <Trash2 className="size-4" />
          </button>
        }
      >
        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-6 pb-8">
          {/* Title and description first, borderless, exactly as a work item
              opens — the record names itself before it describes itself. */}
          <div className="space-y-2">
            <TextArea
              aria-label={t("payments.sheet.concept")}
              value={title}
              maxLength={255}
              onChange={(event) => setTitle(event.target.value)}
              onBlur={() => title !== (data?.title || line.label) && void persist({ title })}
              className="block w-full resize-none overflow-hidden rounded-sm border-none bg-transparent px-0 py-0 text-20 font-medium ring-0 outline-none"
            />
            <TextArea
              aria-label={t("payments.fields.description")}
              value={description}
              placeholder={t("payments.fields.description")}
              onChange={(event) => setDescription(event.target.value)}
              onBlur={() => description !== data?.description && void persist({ description })}
              className="block w-full resize-none rounded-sm border-none bg-transparent px-0 text-13 ring-0 outline-none"
            />
          </div>

          <div className="space-y-2 border-t border-subtle pt-5">
            <SidebarPropertyListItem icon={ParentPropertyIcon} label={t("payments.flow.source")}>
              {variable ? (
                <button
                  type="button"
                  onClick={() => setEditSource(true)}
                  className="h-7.5 text-body-xs-medium text-secondary hover:text-primary"
                >
                  {source}
                </button>
              ) : (
                <span className="flex h-7.5 items-center text-body-xs-medium">{source}</span>
              )}
            </SidebarPropertyListItem>

            <SidebarPropertyListItem icon={UserCirclePropertyIcon} label={t("payroll.fields.office")}>
              <FinanceOfficeSelect
                workspaceSlug={workspaceSlug}
                value={line.entity_id || ""}
                onChange={(next) => void persist({ entity: next })}
              />
            </SidebarPropertyListItem>

            <SidebarPropertyListItem icon={LabelPropertyIcon} label={t("payments.fields.category")}>
              <FinanceCategorySelect
                workspaceSlug={workspaceSlug}
                value={category}
                onChange={(next) => {
                  setCategory(next);
                  void persist({ category: next || null });
                }}
              />
            </SidebarPropertyListItem>

            {(assignment || variable) && (
              <SidebarPropertyListItem icon={DueDatePropertyIcon} label={t("payments.flow.period")}>
                <span className="flex h-7.5 items-center text-body-xs-medium">
                  {assignment
                    ? `${assignment.effective_from} → ${assignment.effective_to || scenario.period_end}`
                    : `${variable!.effective_from} → ${variable!.effective_to || scenario.period_end}`}
                </span>
              </SidebarPropertyListItem>
            )}

            <SidebarPropertyListItem icon={EstimatePropertyIcon} label={t("payments.sheet.total")}>
              <span className="font-mono flex h-7.5 items-center text-body-xs-medium">
                {formatMoney(line.total, line.currency)}
              </span>
            </SidebarPropertyListItem>
          </div>

          <section className="border-t border-subtle pt-5">
            <h3 className="mb-3 flex items-center gap-1.5 text-body-sm-medium">
              <Paperclip className="size-4 text-tertiary" />
              {t("payments.fields.documents")}
            </h3>
            <DocumentAttachments
              workspaceSlug={workspaceSlug}
              documents={data?.documents ?? []}
              disabled={busy || !data}
              onChange={saveDocuments}
            />
          </section>

          <section className="border-t border-subtle pt-5">
            <div className="mb-3 flex items-center gap-2">
              <h3 className="text-body-sm-medium">{t("common.comments")}</h3>
              {selectedCell && (
                <button
                  type="button"
                  onClick={() => setSelectedCell("")}
                  className="rounded-sm bg-layer-1 px-1.5 py-0.5 text-body-xs-regular text-secondary hover:text-primary"
                  title={t("payments.flow.comments_for")}
                >
                  {selectedCell} ×
                </button>
              )}
            </div>
            <FinanceComments
              key={`${line.key}-${selectedCell}`}
              workspaceSlug={workspaceSlug}
              target={{ scenario: scenario.id, row_key: line.key, cell: selectedCell }}
            />
          </section>
        </div>
      </PaymentsSidePanel>

      <AlertModalCore
        isOpen={deleting}
        handleClose={() => setDeleting(false)}
        handleSubmit={() => void remove()}
        isSubmitting={busy}
        title={t("payments.actions.delete")}
        content={t(
          kind === "salary" || kind === "benefit" ? "payments.flow.remove_employee" : "payments.flow.remove_row"
        )}
      />
      <FinancialVariableModal
        nested
        workspaceSlug={workspaceSlug}
        offices={offices}
        variable={variable}
        isOpen={editSource}
        onClose={() => setEditSource(false)}
        onSaved={() => {
          setEditSource(false);
          onChanged();
        }}
      />
    </>
  );
}
