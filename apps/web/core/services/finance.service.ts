/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// plane imports
import { API_BASE_URL } from "@plane/constants";
import type {
  TBudget,
  TBudgetBonus,
  TBudgetForecast,
  TBudgetScenario,
  TBudgetScenarioEmployee,
  TBudgetScenarioVariable,
  TBudgetSummary,
  TExpense,
  TExpenseCategory,
  TExpenseFilters,
  TFinancialVariable,
} from "@plane/types";
// services
import { APIService } from "@/services/api.service";
import { exportBudgetForecast } from "@/lib/budget-export";

export class FinanceService extends APIService {
  constructor() {
    super(API_BASE_URL);
  }

  // named annual planning scenarios

  async getScenarios(workspaceSlug: string, year?: number): Promise<TBudgetScenario[]> {
    return this.get(`/api/workspaces/${workspaceSlug}/budget-scenarios/`, { params: year ? { year } : {} })
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async createScenario(workspaceSlug: string, data: Partial<TBudgetScenario>): Promise<TBudgetScenario> {
    return this.post(`/api/workspaces/${workspaceSlug}/budget-scenarios/`, data)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async getScenario(workspaceSlug: string, scenarioId: string): Promise<TBudgetScenario> {
    return this.get(`/api/workspaces/${workspaceSlug}/budget-scenarios/${scenarioId}/`)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async updateScenario(
    workspaceSlug: string,
    scenarioId: string,
    data: Partial<TBudgetScenario>
  ): Promise<TBudgetScenario> {
    return this.patch(`/api/workspaces/${workspaceSlug}/budget-scenarios/${scenarioId}/`, data)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async deleteScenario(workspaceSlug: string, scenarioId: string): Promise<void> {
    return this.delete(`/api/workspaces/${workspaceSlug}/budget-scenarios/${scenarioId}/`)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async getScenarioForecast(workspaceSlug: string, scenarioId: string): Promise<TBudgetForecast> {
    return this.get(`/api/workspaces/${workspaceSlug}/budget-scenarios/${scenarioId}/summary/`)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async overrideScenarioCell(
    workspaceSlug: string,
    scenarioId: string,
    data: { row_key: string; year: number; month: number; amount: string }
  ): Promise<void> {
    return this.put(`/api/workspaces/${workspaceSlug}/budget-scenarios/${scenarioId}/cells/`, data)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async restoreScenarioCell(
    workspaceSlug: string,
    scenarioId: string,
    data: { row_key: string; year: number; month: number }
  ): Promise<void> {
    return this.delete(`/api/workspaces/${workspaceSlug}/budget-scenarios/${scenarioId}/cells/`, data)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async exportScenario(
    workspaceSlug: string,
    scenarioId: string,
    format: "csv" | "xlsx",
    filename = "budget"
  ): Promise<void> {
    const forecast = await this.getScenarioForecast(workspaceSlug, scenarioId);
    exportBudgetForecast(forecast, filename, format);
  }

  async getScenarioEmployees(workspaceSlug: string, scenarioId: string): Promise<TBudgetScenarioEmployee[]> {
    return this.get(`/api/workspaces/${workspaceSlug}/budget-scenarios/${scenarioId}/employees/`)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async addScenarioEmployee(
    workspaceSlug: string,
    scenarioId: string,
    data: Partial<TBudgetScenarioEmployee>
  ): Promise<TBudgetScenarioEmployee> {
    return this.post(`/api/workspaces/${workspaceSlug}/budget-scenarios/${scenarioId}/employees/`, data)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async removeScenarioEmployee(workspaceSlug: string, scenarioId: string, assignmentId: string): Promise<void> {
    return this.delete(`/api/workspaces/${workspaceSlug}/budget-scenarios/${scenarioId}/employees/${assignmentId}/`)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async createBudgetBonus(
    workspaceSlug: string,
    scenarioId: string,
    assignmentId: string,
    data: Partial<TBudgetBonus>
  ): Promise<TBudgetBonus> {
    return this.post(
      `/api/workspaces/${workspaceSlug}/budget-scenarios/${scenarioId}/employees/${assignmentId}/bonuses/`,
      data
    )
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async deleteBudgetBonus(
    workspaceSlug: string,
    scenarioId: string,
    assignmentId: string,
    bonusId: string
  ): Promise<void> {
    return this.delete(
      `/api/workspaces/${workspaceSlug}/budget-scenarios/${scenarioId}/employees/${assignmentId}/bonuses/${bonusId}/`
    )
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  // reusable financial variables

  async getFinancialVariables(workspaceSlug: string, search?: string): Promise<TFinancialVariable[]> {
    return this.get(`/api/workspaces/${workspaceSlug}/financial-variables/`, {
      params: search ? { search } : {},
    })
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async createFinancialVariable(workspaceSlug: string, data: Partial<TFinancialVariable>): Promise<TFinancialVariable> {
    return this.post(`/api/workspaces/${workspaceSlug}/financial-variables/`, data)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async updateFinancialVariable(
    workspaceSlug: string,
    variableId: string,
    data: Partial<TFinancialVariable>
  ): Promise<TFinancialVariable> {
    return this.patch(`/api/workspaces/${workspaceSlug}/financial-variables/${variableId}/`, data)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async deleteFinancialVariable(workspaceSlug: string, variableId: string): Promise<void> {
    return this.delete(`/api/workspaces/${workspaceSlug}/financial-variables/${variableId}/`)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async getScenarioVariables(workspaceSlug: string, scenarioId: string): Promise<TBudgetScenarioVariable[]> {
    return this.get(`/api/workspaces/${workspaceSlug}/budget-scenarios/${scenarioId}/variables/`)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async addScenarioVariable(
    workspaceSlug: string,
    scenarioId: string,
    variable: string
  ): Promise<TBudgetScenarioVariable> {
    return this.post(`/api/workspaces/${workspaceSlug}/budget-scenarios/${scenarioId}/variables/`, { variable })
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async removeScenarioVariable(workspaceSlug: string, scenarioId: string, assignmentId: string): Promise<void> {
    return this.delete(`/api/workspaces/${workspaceSlug}/budget-scenarios/${scenarioId}/variables/${assignmentId}/`)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  // categories

  async getCategories(workspaceSlug: string): Promise<TExpenseCategory[]> {
    return this.get(`/api/workspaces/${workspaceSlug}/expense-categories/`)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async createCategory(workspaceSlug: string, data: Partial<TExpenseCategory>): Promise<TExpenseCategory> {
    return this.post(`/api/workspaces/${workspaceSlug}/expense-categories/`, data)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async updateCategory(
    workspaceSlug: string,
    categoryId: string,
    data: Partial<TExpenseCategory>
  ): Promise<TExpenseCategory> {
    return this.patch(`/api/workspaces/${workspaceSlug}/expense-categories/${categoryId}/`, data)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async deleteCategory(workspaceSlug: string, categoryId: string): Promise<void> {
    return this.delete(`/api/workspaces/${workspaceSlug}/expense-categories/${categoryId}/`)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  // budgets

  async getBudgets(workspaceSlug: string): Promise<TBudget[]> {
    return this.get(`/api/workspaces/${workspaceSlug}/budgets/`)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async createBudget(workspaceSlug: string, data: Partial<TBudget>): Promise<TBudget> {
    return this.post(`/api/workspaces/${workspaceSlug}/budgets/`, data)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async updateBudget(workspaceSlug: string, budgetId: string, data: Partial<TBudget>): Promise<TBudget> {
    return this.patch(`/api/workspaces/${workspaceSlug}/budgets/${budgetId}/`, data)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async deleteBudget(workspaceSlug: string, budgetId: string): Promise<void> {
    return this.delete(`/api/workspaces/${workspaceSlug}/budgets/${budgetId}/`)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  /** Budgeted vs spent per (category, currency) for the window */
  async getSummary(workspaceSlug: string, from: string, to: string): Promise<TBudgetSummary> {
    return this.get(`/api/workspaces/${workspaceSlug}/budgets/summary/`, { params: { from, to } })
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  // expenses

  async getExpenses(workspaceSlug: string, filters?: TExpenseFilters): Promise<TExpense[]> {
    // Multi-value filters repeat their key (?status=PAID&status=PENDING), which
    // is what Django's request.getlist() expects.
    const params = new URLSearchParams();
    (filters?.categories ?? []).forEach((id) => params.append("category", id));
    (filters?.statuses ?? []).forEach((status) => params.append("status", status));
    if (filters?.search) params.set("search", filters.search);
    if (filters?.from) params.set("from", filters.from);
    if (filters?.to) params.set("to", filters.to);
    const query = params.toString();
    return this.get(`/api/workspaces/${workspaceSlug}/expenses/${query ? `?${query}` : ""}`)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async createExpense(workspaceSlug: string, data: Partial<TExpense>): Promise<TExpense> {
    return this.post(`/api/workspaces/${workspaceSlug}/expenses/`, data)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async updateExpense(workspaceSlug: string, expenseId: string, data: Partial<TExpense>): Promise<TExpense> {
    return this.patch(`/api/workspaces/${workspaceSlug}/expenses/${expenseId}/`, data)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async deleteExpense(workspaceSlug: string, expenseId: string): Promise<void> {
    return this.delete(`/api/workspaces/${workspaceSlug}/expenses/${expenseId}/`)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  // documents — the bytes are uploaded through the file library's presigned
  // POST first; these endpoints only record which files back which expense

  async attachDocuments(workspaceSlug: string, expenseId: string, assetIds: string[]): Promise<TExpense> {
    return this.post(`/api/workspaces/${workspaceSlug}/expenses/${expenseId}/documents/`, {
      asset_ids: assetIds,
    })
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async detachDocument(workspaceSlug: string, expenseId: string, assetId: string): Promise<void> {
    return this.delete(`/api/workspaces/${workspaceSlug}/expenses/${expenseId}/documents/${assetId}/`)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  /** Presigned URL for a document, for the PDF/image viewer */
  async getDocumentViewUrl(workspaceSlug: string, expenseId: string, assetId: string): Promise<string> {
    return this.get(`/api/workspaces/${workspaceSlug}/expenses/${expenseId}/documents/${assetId}/view/`)
      .then((response) => response?.data?.url)
      .catch((error) => {
        throw error?.response?.data;
      });
  }
}

export const financeService = new FinanceService();
