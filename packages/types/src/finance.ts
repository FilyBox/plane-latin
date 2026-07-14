/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

/** Money crosses the wire as a decimal *string* ("2500.50"), never a number.
 * Parsing it into a JS number loses cents on large ledgers, so keep it a string
 * until the moment it is formatted for display.
 */
export type TMoney = string;

export type TExpenseStatus = "PENDING" | "PAID" | "CANCELLED";

export type TExpenseCategory = {
  id: string;
  name: string;
  description: string;
  color: string;
  workspace_id: string;
  expense_count: number;
  created_at: string;
  updated_at: string;
};

export type TBudget = {
  id: string;
  category: string;
  project: string | null;
  period_start: string;
  period_end: string;
  amount: TMoney;
  currency: string;
  notes: string;
  workspace_id: string;
  created_at: string;
  updated_at: string;
};

export type TBudgetScenarioStatus = "DRAFT" | "ACTIVE" | "ARCHIVED";
export type TFinancialVariableKind = "EXPENSE" | "INCOME";
export type TFinancialRecurrence = "ONE_TIME" | "DAILY" | "WEEKLY" | "BIWEEKLY" | "MONTHLY" | "QUARTERLY" | "ANNUAL";

export type TBudgetScenario = {
  id: string;
  name: string;
  description: string;
  fiscal_year: number;
  period_start: string;
  period_end: string;
  currency: string;
  status: TBudgetScenarioStatus;
  employee_count: number;
  variable_count: number;
  workspace_id: string;
  created_at: string;
  updated_at: string;
};

export type TFinancialVariable = {
  id: string;
  office: string;
  office_name: string;
  name: string;
  description: string;
  kind: TFinancialVariableKind;
  amount: TMoney;
  currency: string;
  recurrence: TFinancialRecurrence;
  effective_from: string;
  effective_to: string | null;
  workspace_id: string;
  created_at: string;
  updated_at: string;
};

export type TBudgetBonus = {
  id: string;
  scenario_employee: string;
  name: string;
  calculation_type: "FIXED" | "PERCENTAGE";
  value: TMoney;
  periodicity: "BIWEEKLY" | "MONTHLY";
  effective_from: string;
  effective_to: string | null;
  workspace_id: string;
  created_at: string;
  updated_at: string;
};

export type TBudgetScenarioEmployee = {
  id: string;
  scenario: string;
  employee: string;
  employee_name: string;
  position: string;
  salary: string;
  office_id: string;
  office_name: string;
  salary_amount: TMoney;
  salary_currency: string;
  salary_periodicity: "MONTHLY" | "BIWEEKLY" | "WEEKLY" | "DAILY";
  effective_from: string;
  effective_to: string | null;
  bonuses: TBudgetBonus[];
  workspace_id: string;
  created_at: string;
  updated_at: string;
};

export type TBudgetScenarioVariable = {
  id: string;
  scenario: string;
  variable: string;
  variable_detail: TFinancialVariable;
  workspace_id: string;
  created_at: string;
};

export type TBudgetForecastMonth = {
  year: number;
  month: number;
  salary: TMoney;
  benefits: TMoney;
  bonuses: TMoney;
  expenses: TMoney;
  income: TMoney;
  total: TMoney;
};

export type TBudgetForecastRow = {
  currency: string;
  months: TBudgetForecastMonth[];
  annual: Omit<TBudgetForecastMonth, "year" | "month">;
};

export type TBudgetForecastCell = {
  year: number;
  month: number;
  automatic: TMoney;
  amount: TMoney;
  is_overridden: boolean;
};

export type TBudgetForecastLine = {
  key: string;
  label: string;
  category: "SALARY" | "BENEFIT" | "BONUS" | "VARIABLE" | "EXPENSE";
  entity_name: string;
  currency: string;
  kind: "EXPENSE" | "INCOME";
  months: TBudgetForecastCell[];
  total: TMoney;
};

export type TBudgetForecast = {
  year: number;
  months: { year: number; month: number }[];
  results: TBudgetForecastRow[];
  lines: TBudgetForecastLine[];
};

/** A supporting document (invoice, receipt) attached to an expense. The bytes
 * live in the same bucket as the file library, so the existing PDF/image
 * viewers render it as-is.
 */
export type TExpenseDocument = {
  id: string;
  asset_id: string;
  name: string;
  type: string;
  size: number;
};

export type TExpense = {
  id: string;
  category: string | null;
  category_name: string | null;
  project: string | null;
  documents: TExpenseDocument[];
  amount: TMoney;
  currency: string;
  expense_date: string;
  vendor: string;
  description: string;
  reference: string;
  status: TExpenseStatus;
  paid_at: string | null;
  workspace_id: string;
  created_at: string;
  updated_at: string;
};

/** One row of the budgeted-vs-spent summary. Rows are per (category, currency):
 * amounts in different currencies are never added together.
 */
export type TBudgetSummaryRow = {
  category_id: string | null;
  category_name: string | null;
  currency: string;
  budgeted: TMoney;
  spent: TMoney;
  pending: TMoney;
  remaining: TMoney;
};

export type TBudgetSummary = {
  from: string;
  to: string;
  results: TBudgetSummaryRow[];
};

export type TExpenseFilters = {
  categories?: string[];
  statuses?: TExpenseStatus[];
  search?: string;
  from?: string;
  to?: string;
};
