/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * Expenses from receipts: the card follows each file's analysis (a CFDI XML
 * is ready at once), shows one expense per invoice (a PDF and its XML
 * together), with the extracted fields editable, the suggested budget and
 * category, and a warning when it looks already registered. Registering
 * creates them on confirm; undo removes the ones nobody edited.
 */

import { useMemo, useState } from "react";
import { makeAssistantToolUI } from "@assistant-ui/react";
import { AlertTriangle, FileCode2, Loader2, Receipt } from "lucide-react";
import useSWR from "swr";
import { useTranslation } from "@plane/i18n";
import { cn } from "@plane/utils";
import { assistantService } from "@/services/assistant.service";
import { financeService } from "@/services/finance.service";
import { CARD, FIELD, Footer, useOutcome } from "./action-cards";
import { UndoConflicts, useCardActions } from "./card-kit";
import { AssistantLink } from "./links";
import { TraceLine } from "./steps";

type TDraftData = {
  concept?: string | null;
  vendor?: string | null;
  amount?: string | null;
  currency?: string | null;
  expense_date?: string | null;
  reference?: string | null;
  description?: string | null;
  tags?: string[];
  warnings?: string[];
  cfdi_uuid?: string | null;
  suggested_status?: "PAID" | "PENDING";
  suggestions?: { scenario?: string | null; category?: string | null };
  duplicates?: {
    id: string;
    concept: string;
    amount: string;
    currency: string;
    expense_date: string;
    same_cfdi?: boolean | null;
  }[];
};

type TDraft = {
  job_ids: string[];
  files: { job_id: string; asset_id: string; name: string; xml: boolean }[];
  status: string;
  stage?: string | null;
  error?: string | null;
  matched_by?: "uuid" | "name" | "total" | null;
  data: TDraftData;
  expense_id?: string | null;
};

type TExpensesProposal = {
  job_ids?: string[];
  pending?: number;
  expenses?: TDraft[];
  missing?: string[] | null;
  notes?: string;
  workspace_slug?: string;
  error?: string;
};

type TForm = {
  include: boolean;
  concept: string;
  vendor: string;
  amount: string;
  currency: string;
  expense_date: string;
  reference: string;
  status: "PENDING" | "PAID";
  scenario: string;
  category: string;
};

const PREFIX = "assistant.expenses";

function initialForm(draft: TDraft): TForm {
  const data = draft.data ?? {};
  return {
    // A sure duplicate starts out unchecked
    include: !(data.duplicates ?? []).some((item) => item.same_cfdi),
    concept: data.concept ?? "",
    vendor: data.vendor ?? "",
    amount: data.amount ?? "",
    currency: data.currency ?? "MXN",
    expense_date: data.expense_date ?? "",
    reference: data.reference ?? "",
    // Pending by default, as in the importer: the person decides
    status: "PENDING",
    scenario: data.suggestions?.scenario ?? "",
    category: data.suggestions?.category ?? "",
  };
}

function ExpensesForm({ proposal, toolCallId }: { proposal: TExpensesProposal; toolCallId: string }) {
  const { t } = useTranslation();
  const slug = proposal.workspace_slug!;
  const [outcome, remember, meta] = useOutcome(`assistant-expenses:${toolCallId}`);
  const { apply, undo } = useCardActions(slug, outcome, remember, meta);
  const ids = (proposal.job_ids ?? []).join(",");
  const { data: live } = useSWR(
    ids ? `ASSISTANT_EXPENSE_DRAFTS_${slug}_${ids}` : null,
    () => assistantService.expenseDrafts<{ pending: number; expenses: TDraft[] }>(slug, proposal.job_ids ?? []),
    {
      fallbackData: { pending: proposal.pending ?? 0, expenses: proposal.expenses ?? [] },
      // Follow the analyses until every file is read
      refreshInterval: (latest) => ((latest?.pending ?? 0) > 0 ? 4000 : 0),
      revalidateOnFocus: false,
    }
  );
  const { data: scenarios } = useSWR(`ASSISTANT_SCENARIOS_${slug}`, () => financeService.getScenarios(slug));
  const { data: categories } = useSWR(`ASSISTANT_CATEGORIES_${slug}`, () => financeService.getCategories(slug));
  const drafts = useMemo(() => live?.expenses ?? [], [live]);
  const [forms, setForms] = useState<Record<string, TForm>>({});
  const formFor = (draft: TDraft) => forms[draft.job_ids.join(",")] ?? initialForm(draft);
  const change = (draft: TDraft, patch: Partial<TForm>) =>
    setForms((current) => ({ ...current, [draft.job_ids.join(",")]: { ...formFor(draft), ...patch } }));
  const busy = outcome.state === "busy";
  const done = outcome.state !== "idle" && outcome.state !== "busy";
  const ready = drafts.filter((draft) => draft.status === "READY" && !draft.expense_id);
  const chosen = ready.filter((draft) => formFor(draft).include);
  const invalid = chosen.some((draft) => {
    const form = formFor(draft);
    return !/^\d+(\.\d{1,2})?$/.test(form.amount.trim()) || !form.expense_date || form.currency.trim().length !== 3;
  });

  const register = () =>
    void apply({
      kind: "CREATE_EXPENSES",
      items: chosen.map((draft) => {
        const form = formFor(draft);
        return {
          job_ids: draft.job_ids,
          allow_duplicate: (draft.data.duplicates ?? []).some((item) => item.same_cfdi) || undefined,
          expense: {
            concept: form.concept.trim(),
            vendor: form.vendor.trim(),
            amount: form.amount.trim(),
            currency: form.currency.trim().toUpperCase(),
            expense_date: form.expense_date,
            reference: form.reference.trim(),
            description: draft.data.description ?? "",
            tags: draft.data.tags ?? [],
            status: form.status,
            paid_at: form.status === "PAID" ? form.expense_date : null,
            scenario: form.scenario || null,
            category: form.category || null,
          },
        };
      }),
    });

  const result = outcome.result as { path?: string; expenses?: unknown[] } | undefined;
  return (
    <div className={CARD}>
      <div className="flex items-center gap-2">
        <Receipt className="size-4 shrink-0 text-tertiary" aria-hidden />
        <p className="min-w-0 flex-1 truncate text-13 font-medium text-primary">
          {t(`${PREFIX}.title`, { count: drafts.length })}
        </p>
        {(live?.pending ?? 0) > 0 && (
          <span className="flex items-center gap-1 text-11 text-tertiary">
            <Loader2 className="size-3 animate-spin" />
            {t(`${PREFIX}.analysing`, { count: live?.pending ?? 0 })}
          </span>
        )}
      </div>
      {proposal.notes && <p className="mt-1 text-12 text-secondary">{proposal.notes}</p>}
      <div className="mt-2 max-h-[28rem] space-y-2 overflow-y-auto">
        {drafts.map((draft) => {
          const form = formFor(draft);
          const data = draft.data ?? {};
          const editable = draft.status === "READY" && !draft.expense_id && !done;
          const key = draft.job_ids.join(",");
          return (
            <div key={key} className={cn("rounded-md border border-subtle p-2", !form.include && "opacity-60")}>
              <div className="flex items-start gap-2">
                {draft.status === "READY" && !draft.expense_id ? (
                  <input
                    type="checkbox"
                    className="accent-accent-primary mt-0.5"
                    aria-label={t(`${PREFIX}.include`)}
                    checked={form.include}
                    disabled={done || busy}
                    onChange={() => change(draft, { include: !form.include })}
                  />
                ) : null}
                <div className="min-w-0 flex-1 text-11 text-tertiary">
                  {draft.files.map((file) => (
                    <span key={file.job_id} className="mr-2 inline-flex items-center gap-1">
                      {file.xml ? <FileCode2 className="size-3" /> : null}
                      <span className="max-w-48 truncate">{file.name}</span>
                    </span>
                  ))}
                  {draft.matched_by ? (
                    <span className="block text-10">{t(`${PREFIX}.paired.${draft.matched_by}`)}</span>
                  ) : null}
                </div>
              </div>
              {draft.status === "QUEUED" || draft.status === "RUNNING" || draft.status === "MIXED" ? (
                <p className="mt-1 flex items-center gap-1 text-11 text-tertiary">
                  <Loader2 className="size-3 animate-spin" />
                  {draft.stage ?? t(`${PREFIX}.waiting`)}
                </p>
              ) : draft.status === "FAILED" || draft.status === "CANCELLED" ? (
                <p className="mt-1 text-11 text-danger-primary">{draft.error ?? t(`${PREFIX}.failed`)}</p>
              ) : draft.expense_id ? (
                <AssistantLink href={`/${slug}/expenses?expense=${draft.expense_id}`} className="mt-1 block text-11">
                  {t(`${PREFIX}.already`)}
                </AssistantLink>
              ) : (
                <fieldset disabled={!editable || busy} className="mt-1.5 grid grid-cols-2 gap-1.5">
                  <input
                    value={form.concept}
                    placeholder={t(`${PREFIX}.fields.concept`)}
                    aria-label={t(`${PREFIX}.fields.concept`)}
                    onChange={(event) => change(draft, { concept: event.target.value })}
                    className={cn(FIELD, "col-span-2")}
                  />
                  <input
                    value={form.vendor}
                    placeholder={t(`${PREFIX}.fields.vendor`)}
                    aria-label={t(`${PREFIX}.fields.vendor`)}
                    onChange={(event) => change(draft, { vendor: event.target.value })}
                    className={cn(FIELD, "col-span-2")}
                  />
                  <div className="flex gap-1">
                    <input
                      value={form.amount}
                      inputMode="decimal"
                      placeholder={t(`${PREFIX}.fields.amount`)}
                      aria-label={t(`${PREFIX}.fields.amount`)}
                      onChange={(event) => change(draft, { amount: event.target.value })}
                      className={cn(FIELD, !/^\d+(\.\d{1,2})?$/.test(form.amount.trim()) && "border-danger-strong")}
                    />
                    <input
                      value={form.currency}
                      maxLength={3}
                      aria-label={t(`${PREFIX}.fields.currency`)}
                      onChange={(event) => change(draft, { currency: event.target.value })}
                      className={cn(FIELD, "w-14 uppercase")}
                    />
                  </div>
                  <input
                    type="date"
                    value={form.expense_date}
                    aria-label={t(`${PREFIX}.fields.date`)}
                    onChange={(event) => change(draft, { expense_date: event.target.value })}
                    className={cn(FIELD, !form.expense_date && "border-danger-strong")}
                  />
                  <input
                    value={form.reference}
                    placeholder={t(`${PREFIX}.fields.reference`)}
                    aria-label={t(`${PREFIX}.fields.reference`)}
                    onChange={(event) => change(draft, { reference: event.target.value })}
                    className={FIELD}
                  />
                  <select
                    value={form.status}
                    aria-label={t(`${PREFIX}.fields.status`)}
                    onChange={(event) => change(draft, { status: event.target.value as TForm["status"] })}
                    className={FIELD}
                  >
                    <option value="PENDING">
                      {t(`${PREFIX}.status.pending`)}
                      {data.suggested_status === "PENDING" ? ` · ${t(`${PREFIX}.suggested`)}` : ""}
                    </option>
                    <option value="PAID">
                      {t(`${PREFIX}.status.paid`)}
                      {data.suggested_status === "PAID" ? ` · ${t(`${PREFIX}.suggested`)}` : ""}
                    </option>
                  </select>
                  <select
                    value={form.scenario}
                    aria-label={t(`${PREFIX}.fields.budget`)}
                    onChange={(event) => change(draft, { scenario: event.target.value })}
                    className={FIELD}
                  >
                    <option value="">{t(`${PREFIX}.no_budget`)}</option>
                    {(scenarios ?? []).map((scenario) => (
                      <option key={scenario.id} value={scenario.id}>
                        {scenario.name}
                      </option>
                    ))}
                  </select>
                  <select
                    value={form.category}
                    aria-label={t(`${PREFIX}.fields.category`)}
                    onChange={(event) => change(draft, { category: event.target.value })}
                    className={FIELD}
                  >
                    <option value="">{t(`${PREFIX}.no_category`)}</option>
                    {(categories ?? []).map((category) => (
                      <option key={category.id} value={category.id}>
                        {category.name}
                      </option>
                    ))}
                  </select>
                </fieldset>
              )}
              {(data.duplicates ?? []).map((duplicate) => (
                <p key={duplicate.id} className="mt-1 flex items-start gap-1 text-11 text-warning-primary">
                  <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                  <AssistantLink href={`/${slug}/expenses?expense=${duplicate.id}`} className="text-11">
                    {t(duplicate.same_cfdi ? `${PREFIX}.duplicate_sure` : `${PREFIX}.duplicate_maybe`, {
                      concept: duplicate.concept,
                      amount: `${duplicate.amount} ${duplicate.currency}`,
                      date: duplicate.expense_date,
                    })}
                  </AssistantLink>
                </p>
              ))}
              {(data.warnings ?? []).map((warning) => (
                <p key={warning} className="mt-0.5 text-11 text-warning-primary">
                  {warning}
                </p>
              ))}
            </div>
          );
        })}
      </div>
      {(proposal.missing?.length ?? 0) > 0 && (
        <p className="mt-1 text-11 text-warning-primary">
          {t(`${PREFIX}.missing`, { count: proposal.missing!.length })}
        </p>
      )}
      <UndoConflicts outcome={outcome} label={(field) => t(`${PREFIX}.fields.${field}`)} />
      <Footer
        outcome={outcome}
        busy={busy}
        doneLabel={t(`${PREFIX}.done`, { count: result?.expenses?.length ?? chosen.length })}
        extra={
          result?.path ? (
            <AssistantLink href={result.path} className="shrink-0 text-12">
              {t(`${PREFIX}.open`)}
            </AssistantLink>
          ) : null
        }
        applyLabel={t(`${PREFIX}.apply`, { count: chosen.length })}
        disabled={chosen.length === 0 || invalid || (live?.pending ?? 0) > 0}
        onApply={register}
        onDiscard={() => remember({ state: "discarded" })}
        onUndo={() => void undo()}
      />
    </div>
  );
}

export const ExpensesCard = makeAssistantToolUI<Record<string, unknown>, TExpensesProposal>({
  toolName: "propose_expenses_from_documents",
  render: function ExpensesRender({ result, status, toolCallId }) {
    const { t } = useTranslation();
    if (status.type === "running" || !result) {
      return <TraceLine live icon={Receipt} label={t("assistant.steps.propose_expenses_from_documents.running")} />;
    }
    if (result.error || !result.job_ids || !result.workspace_slug) {
      return <p className="text-12 text-tertiary">{result.error ?? t("assistant.actions.failed")}</p>;
    }
    return <ExpensesForm proposal={result} toolCallId={toolCallId} />;
  },
});
