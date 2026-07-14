/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export type SalaryAvailabilityReason =
  | "SALARY_STARTS_AFTER_BUDGET"
  | "SALARY_ENDED_BEFORE_BUDGET"
  | "EMPLOYEE_STARTS_AFTER_BUDGET"
  | "EMPLOYEE_ENDED_BEFORE_BUDGET";

type SalaryAvailabilityInput = {
  budgetStart: string;
  budgetEnd: string;
  salaryStart: string;
  salaryEnd?: string | null;
  employeeStart: string;
  employeeEnd?: string | null;
};

export type SalaryAvailability =
  | { isEligible: true; reason: null; conflictingDate: null }
  | { isEligible: false; reason: SalaryAvailabilityReason; conflictingDate: string };

/** An empty salary end means the salary remains valid indefinitely. */
export const getSalaryBudgetAvailability = (input: SalaryAvailabilityInput): SalaryAvailability => {
  if (input.salaryStart > input.budgetEnd)
    return { isEligible: false, reason: "SALARY_STARTS_AFTER_BUDGET", conflictingDate: input.salaryStart };
  if (input.salaryEnd && input.salaryEnd < input.budgetStart)
    return { isEligible: false, reason: "SALARY_ENDED_BEFORE_BUDGET", conflictingDate: input.salaryEnd };
  if (input.employeeStart > input.budgetEnd)
    return { isEligible: false, reason: "EMPLOYEE_STARTS_AFTER_BUDGET", conflictingDate: input.employeeStart };
  if (input.employeeEnd && input.employeeEnd < input.budgetStart)
    return { isEligible: false, reason: "EMPLOYEE_ENDED_BEFORE_BUDGET", conflictingDate: input.employeeEnd };
  return { isEligible: true, reason: null, conflictingDate: null };
};
