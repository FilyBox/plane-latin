/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useRef, useState } from "react";
import { Gift, Paperclip, Plus, ReceiptText, Trash2 } from "lucide-react";
import useSWR from "swr";
import { useTranslation } from "@plane/i18n";
import {
  DueDatePropertyIcon,
  LabelPropertyIcon,
  ParentPropertyIcon,
  UserCirclePropertyIcon,
} from "@plane/propel/icons";
import { Button } from "@plane/propel/button";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TBudgetBonus, TBudgetForecastLine, TBudgetScenario, TExpense } from "@plane/types";
import { TextArea } from "@plane/ui";
import { cn } from "@plane/utils";
import { SidebarPropertyListItem } from "@/components/common/layout/sidebar/property-list-item";
import { financeService } from "@/services/finance.service";
import { payrollService } from "@/services/payroll.service";
import { BudgetBonusModal } from "./bonus-modal";
import { SalaryModal } from "./payroll/salary-modal";
import { PaymentsSidePanel } from "./side-panel";
import { DocumentAttachments } from "./document-attachments";
import { ExpenseModal } from "./expense-modal";
import { FinanceComments } from "./finance-comments";
import { FinanceCategorySelect, FinanceOfficeSelect } from "./tag-picker";
import { FinancialVariableModal } from "./variable-modal";
import { formatMoney } from "./shared";
import { FinanceConfirmModal } from "./confirm-modal";

type Props = {
  workspaceSlug: string;
  scenario: TBudgetScenario;
  line: TBudgetForecastLine;
  /** The month whose conversation opened the panel, "" for the row itself. */
  cell: string;
  /** "YYYY-MM" when opened from a real figure: the expenses list shows that month. */
  month?: string;
  onClose: () => void;
  onChanged: () => void;
};

export function BudgetRowPanel({ workspaceSlug, scenario, line, cell, month = "", onClose, onChanged }: Props) {
  const { t } = useTranslation();
  const [title, setTitle] = useState(line.label);
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState(line.category_id ?? "");
  const [selectedCell, setSelectedCell] = useState(cell);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [editSource, setEditSource] = useState(false);
  const [expenseMonth, setExpenseMonth] = useState(month);
  const [openExpense, setOpenExpense] = useState<TExpense | null>(null);
  const [newExpense, setNewExpense] = useState(false);
  const [editSalary, setEditSalary] = useState(false);
  const [addingBonus, setAddingBonus] = useState(false);
  const [deleteBonus, setDeleteBonus] = useState<TBudgetBonus | null>(null);
  const loaded = useRef(false);
  const [kind, id] = line.key.split(":");

  const { data, mutate } = useSWR(["BUDGET_ROW", workspaceSlug, scenario.id, line.key], () =>
    financeService.getBudgetRow(workspaceSlug, scenario.id, line.key)
  );
  const { data: assignments = [], mutate: mutateAssignments } = useSWR(
    kind !== "variable" ? ["ROW_EMPLOYEES", workspaceSlug, scenario.id] : null,
    () => financeService.getScenarioEmployees(workspaceSlug, scenario.id)
  );
  const { data: variables = [] } = useSWR(
    kind === "variable" ? ["ROW_VARIABLES", workspaceSlug, scenario.id] : null,
    () => financeService.getScenarioVariables(workspaceSlug, scenario.id)
  );
  const { data: offices = [] } = useSWR(editSource || editSalary ? ["PAYROLL_OFFICES_LIST", workspaceSlug] : null, () =>
    payrollService.getOffices(workspaceSlug)
  );
  // The expenses filed against this line: the real money behind its figures.
  const monthRange = (() => {
    if (!expenseMonth) return {};
    const [year, monthNumber] = expenseMonth.split("-").map(Number);
    const last = new Date(year, monthNumber, 0).getDate();
    return { from: `${expenseMonth}-01`, to: `${expenseMonth}-${String(last).padStart(2, "0")}` };
  })();
  const { data: spent, mutate: mutateSpent } = useSWR(
    ["LINE_EXPENSES", workspaceSlug, scenario.id, line.key, expenseMonth],
    () =>
      financeService.getExpensePage(workspaceSlug, {
        scenario: scenario.id,
        budget_line: line.key,
        ...monthRange,
        limit: 100,
      })
  );
  // With a month picked, the figures read that month; otherwise the whole line.
  const [pickedYear, pickedMonth] = expenseMonth ? expenseMonth.split("-").map(Number) : [0, 0];
  const inPicked = (item: { year: number; month: number }) => item.year === pickedYear && item.month === pickedMonth;
  const plannedFigure = expenseMonth ? (line.months.find(inPicked)?.amount ?? "0") : line.total;
  const actualFigure = expenseMonth ? (line.actual?.find(inPicked)?.amount ?? "0") : (line.actual_total ?? "0");
  const difference = (Number(plannedFigure) - Number(actualFigure)).toFixed(2);
  const monthLabel = expenseMonth
    ? new Intl.DateTimeFormat("es-MX", { month: "long", year: "numeric" }).format(new Date(pickedYear, pickedMonth - 1))
    : "";
  const assignment = assignments.find((item) => item.id === id || item.bonuses.some((bonus) => bonus.id === id));
  const variable = variables.find((item) => item.id === id)?.variable_detail;
  // The salary record behind a payroll line, fetched only when it is edited.
  const { data: salaries = [] } = useSWR(
    editSalary && assignment ? ["ROW_SALARIES", workspaceSlug, assignment.employee] : null,
    () => payrollService.getSalaries(workspaceSlug, assignment?.employee ?? "")
  );
  const salary = salaries.find((item) => item.id === assignment?.salary) ?? null;
  const canEditSource = Boolean(variable) || (Boolean(assignment) && kind !== "bonus");
  // A new expense from a month's figures is dated in that month.
  const today = new Date().toISOString().slice(0, 10);
  const newExpenseDate = !expenseMonth || today.startsWith(expenseMonth) ? today : `${expenseMonth}-01`;
  const refreshPayroll = () => {
    void mutateAssignments();
    onChanged();
  };

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
            aria-label={t("payments.composer.remove_title")}
            title={t("payments.composer.remove_title")}
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
              <span className="flex h-7.5 min-w-0 items-center gap-3 text-body-xs-medium">
                <span className="truncate">{source}</span>
                {canEditSource && (
                  <button
                    type="button"
                    onClick={() => (variable ? setEditSource(true) : setEditSalary(true))}
                    className="shrink-0 text-accent-primary hover:underline"
                  >
                    {t("payments.flow.edit_source")}
                  </button>
                )}
              </span>
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
          </div>

          {/* The line read the way the sheet reads it: planned, real, and what is left. */}
          <dl className="grid grid-cols-3 gap-px overflow-hidden rounded-md border border-subtle bg-layer-3">
            {(
              [
                ["payments.flow.planned", plannedFigure, ""],
                ["payments.flow.actual", actualFigure, ""],
                [
                  "payments.flow.difference",
                  difference,
                  Number(difference) < 0 ? "text-danger-primary" : "text-primary",
                ],
              ] as const
            ).map(([label, value, tone]) => (
              <div key={label} className="flex flex-col-reverse bg-surface-1 px-3 py-2">
                <dt className="text-11 text-tertiary">{t(label)}</dt>
                <dd className={cn("font-mono text-13 font-medium tabular-nums", tone)}>
                  {formatMoney(value, line.currency)}
                </dd>
              </div>
            ))}
          </dl>

          {kind === "salary" && assignment && (
            <section className="border-t border-subtle pt-5">
              <div className="mb-3 flex items-center gap-2">
                <h3 className="flex items-center gap-1.5 text-body-sm-medium">
                  <Gift className="size-4 text-tertiary" />
                  {t("payments.flow.bonuses")}
                </h3>
                <Button variant="secondary" size="base" className="ml-auto" onClick={() => setAddingBonus(true)}>
                  <Plus className="size-3" /> {t("payments.bonuses.add")}
                </Button>
              </div>
              {assignment.bonuses.length === 0 ? (
                <p className="text-12 text-tertiary">{t("payments.flow.no_bonuses")}</p>
              ) : (
                <ul className="divide-y divide-subtle rounded-md border border-subtle">
                  {assignment.bonuses.map((bonus) => (
                    <li key={bonus.id} className="flex items-center gap-3 px-3 py-2">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-13">{bonus.name}</span>
                        <span className="block truncate text-11 text-tertiary">
                          {bonus.effective_from}
                          {bonus.effective_to ? ` → ${bonus.effective_to}` : ""}
                        </span>
                      </span>
                      <span className="shrink-0 text-12 tabular-nums">
                        {bonus.calculation_type === "PERCENTAGE"
                          ? `${bonus.value}%`
                          : formatMoney(bonus.value, assignment.salary_currency)}
                      </span>
                      <button
                        type="button"
                        onClick={() => setDeleteBonus(bonus)}
                        className="rounded-sm p-1 text-tertiary hover:text-danger-primary"
                        aria-label={t("payments.bonuses.delete_title")}
                        title={t("payments.bonuses.delete_title")}
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          <section className="border-t border-subtle pt-5">
            <div className="mb-3 flex items-center gap-2">
              <h3 className="flex items-center gap-1.5 text-body-sm-medium">
                <ReceiptText className="size-4 text-tertiary" />
                {t("payments.flow.line_expenses")}
              </h3>
              {expenseMonth && (
                <button
                  type="button"
                  onClick={() => setExpenseMonth("")}
                  className="rounded-sm bg-layer-1 px-1.5 py-0.5 text-body-xs-regular text-secondary hover:text-primary"
                  title={t("payments.flow.all_months")}
                >
                  {monthLabel} ×
                </button>
              )}
              <Button variant="secondary" size="base" className="ml-auto" onClick={() => setNewExpense(true)}>
                <Plus className="size-3" /> {t("payments.flow.record_expense")}
              </Button>
            </div>
            {!spent ? (
              <p className="text-12 text-tertiary">{t("payments.ledger.loading")}</p>
            ) : spent.results.length === 0 ? (
              <p className="text-12 text-tertiary">{t("payments.flow.no_line_expenses")}</p>
            ) : (
              <ul className="divide-y divide-subtle rounded-md border border-subtle">
                {spent.results.map((expense) => (
                  <li key={expense.id}>
                    <button
                      type="button"
                      onClick={() => setOpenExpense(expense)}
                      className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-layer-1-hover"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-13">{expense.concept || expense.vendor}</span>
                        <span className="block truncate text-11 text-tertiary">
                          {expense.expense_date} · {t(`payments.status.${expense.status.toLowerCase()}`)}
                        </span>
                      </span>
                      <span className="font-mono shrink-0 text-12 tabular-nums">
                        {formatMoney(expense.amount, expense.currency)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

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

      <FinanceConfirmModal
        isOpen={deleting}
        handleClose={() => setDeleting(false)}
        handleSubmit={() => void remove()}
        isSubmitting={busy}
        title={t("payments.composer.remove_title")}
        primaryButtonText={{ default: t("payments.variables.remove"), loading: t("payments.ledger.loading") }}
        content={t(
          kind === "salary" || kind === "benefit" ? "payments.flow.remove_employee" : "payments.flow.remove_row"
        )}
      />
      <ExpenseModal
        workspaceSlug={workspaceSlug}
        isOpen={openExpense !== null || newExpense}
        expense={openExpense}
        initialData={
          newExpense
            ? {
                scenario: scenario.id,
                budget_line: line.key,
                currency: line.currency,
                expense_date: newExpenseDate,
              }
            : undefined
        }
        onClose={() => {
          setOpenExpense(null);
          setNewExpense(false);
        }}
        onSaved={() => {
          void mutateSpent();
          onChanged();
        }}
      />
      {assignment && (
        <SalaryModal
          nested
          workspaceSlug={workspaceSlug}
          employeeId={assignment.employee}
          salary={salary}
          offices={offices}
          isOpen={editSalary && salary !== null}
          onClose={() => setEditSalary(false)}
          onSaved={() => {
            setEditSalary(false);
            refreshPayroll();
          }}
        />
      )}
      <BudgetBonusModal
        nested
        workspaceSlug={workspaceSlug}
        scenario={scenario}
        assignment={assignment ?? null}
        isOpen={addingBonus}
        onClose={() => setAddingBonus(false)}
        onSaved={refreshPayroll}
      />
      <FinanceConfirmModal
        isOpen={deleteBonus !== null}
        handleClose={() => setDeleteBonus(null)}
        isSubmitting={busy}
        title={t("payments.bonuses.delete_title")}
        content={deleteBonus ? t("payments.bonuses.delete_description", { name: deleteBonus.name }) : ""}
        handleSubmit={() =>
          void run(async () => {
            if (!assignment || !deleteBonus) return;
            await financeService.deleteBudgetBonus(workspaceSlug, scenario.id, assignment.id, deleteBonus.id);
            setDeleteBonus(null);
            await mutateAssignments();
          })
        }
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
