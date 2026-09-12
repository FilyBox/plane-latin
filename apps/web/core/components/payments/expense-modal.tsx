/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useRef, useState } from "react";
import { Paperclip, Repeat, Trash2 } from "lucide-react";
import useSWR from "swr";
// plane imports
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import {
  DueDatePropertyIcon,
  EstimatePropertyIcon,
  LabelPropertyIcon,
  ParentPropertyIcon,
  StatePropertyIcon,
  UserCirclePropertyIcon,
} from "@plane/propel/icons";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TExpense, TExpenseDocument, TExpenseStatus } from "@plane/types";
import { TextArea } from "@plane/ui";
// services
import { SidebarPropertyListItem } from "@/components/common/layout/sidebar/property-list-item";
import { fileLibraryService } from "@/services/file-library.service";
import { financeService } from "@/services/finance.service";
// local imports
import { AttachmentCard, DocumentAttachments } from "./document-attachments";
import { FinanceComments } from "./finance-comments";
import { PaymentsSidePanel } from "./side-panel";
import { FinanceCategorySelect, FinanceTagPicker } from "./tag-picker";
import { CURRENCIES, todayIso, getApiErrorMessage } from "./shared";

/** Plain-looking controls: inside a property row the value should read as text
 * until you reach for it, the way a work item's dropdowns do. */
const INLINE =
  "h-7.5 w-full rounded-sm border border-transparent bg-transparent px-1.5 text-body-xs-medium outline-none hover:border-subtle focus:border-accent-strong";

type Props = {
  workspaceSlug: string;
  isOpen: boolean;
  /** null = creating a new expense */
  expense: TExpense | null;
  onClose: () => void;
  onSaved: () => void;
  initialData?: Partial<TExpense>;
  importId?: string;
  onDelete?: () => void;
  commentCell?: string;
};

type FormState = {
  concept: string;
  tags: string[];
  scenario: string;
  recurrence: TExpense["recurrence"];
  recurrence_end: string;
  recurrence_paused: boolean;
  category: string;
  amount: string;
  currency: string;
  expense_date: string;
  vendor: string;
  reference: string;
  description: string;
  status: TExpenseStatus;
};

const emptyForm = (): FormState => ({
  concept: "",
  tags: [],
  scenario: "",
  recurrence: "ONE_TIME",
  recurrence_end: "",
  recurrence_paused: false,
  category: "",
  amount: "",
  currency: CURRENCIES[0],
  expense_date: todayIso(),
  vendor: "",
  reference: "",
  description: "",
  status: "PENDING",
});

const RECURRENCES = ["ONE_TIME", "DAILY", "WEEKLY", "BIWEEKLY", "MONTHLY", "QUARTERLY", "ANNUAL"] as const;

export function ExpenseModal(props: Props) {
  const { workspaceSlug, isOpen, expense, onClose, onSaved, initialData, importId, onDelete, commentCell = "" } = props;
  const { t } = useTranslation();
  const { data: scenarios = [] } = useSWR(`BUDGET_SCENARIOS_${workspaceSlug}`, () =>
    financeService.getScenarios(workspaceSlug)
  );
  const [form, setForm] = useState<FormState>(emptyForm());
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Documents already attached to the expense (edit mode)
  const [documents, setDocuments] = useState<TExpenseDocument[]>([]);
  // Files picked but not uploaded yet. A new expense has no id to attach them
  // to, so they wait here until the expense exists. Each carries its own id:
  // two files can share a name, and the list must still track them apart.
  const [queued, setQueued] = useState<{ id: string; file: File }[]>([]);
  const savedId = useRef<string | null>(null);
  const uploadedAssets = useRef<Map<string, string>>(new Map());
  const queueInputRef = useRef<HTMLInputElement>(null);
  // Set by "save and add another" so the submit handler knows to reopen empty
  const keepOpen = useRef(false);
  /** What the server last acknowledged, so a blur can tell an edited field from
   * an untouched one — the form state itself has already moved by then. */
  const persisted = useRef<FormState | null>(null);

  /** A saved expense behaves like a work item: every field writes straight
   * through. A new one has nothing to write to yet, so it keeps a footer. */
  const isEditing = Boolean(expense);

  useEffect(() => {
    if (!isOpen) return;
    savedId.current = expense?.id ?? null;
    uploadedAssets.current.clear();
    setQueued([]);
    setDocuments(expense?.documents ?? []);
    const loaded: FormState = expense
      ? {
          concept: expense.concept || expense.vendor || expense.description,
          tags: expense.tags ?? [],
          scenario: expense.scenario ?? "",
          recurrence: expense.recurrence,
          recurrence_end: expense.recurrence_end ?? "",
          recurrence_paused: expense.recurrence_paused,
          category: expense.category ?? "",
          amount: expense.amount,
          currency: expense.currency,
          expense_date: expense.expense_date,
          vendor: expense.vendor,
          reference: expense.reference,
          description: expense.description,
          status: expense.status,
        }
      : {
          ...emptyForm(),
          ...initialData,
          amount: initialData ? (initialData.amount ?? "") : "",
          currency: initialData ? (initialData.currency ?? "") : CURRENCIES[0],
          expense_date: initialData ? (initialData.expense_date ?? "") : todayIso(),
          tags: initialData?.tags ?? [],
          scenario: initialData?.scenario ?? "",
          recurrence_end: initialData?.recurrence_end ?? "",
          category: initialData?.category ?? "",
        };
    persisted.current = loaded;
    setForm(loaded);
    // Re-seeding on every field of `initialData` would wipe what the user is
    // typing; the panel only reloads when it opens on a different record.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, expense, initialData?.scenario, importId]);

  const payloadFrom = (state: FormState) => ({
    ...state,
    scenario: state.scenario || null,
    recurrence_end: state.recurrence_end || null,
    // The API takes null, not "", for the optional relation
    category: state.category || null,
    // Recording something as paid without a date leaves the ledger unable to
    // say when it was settled
    paid_at: state.status === "PAID" ? expense?.paid_at || state.expense_date : null,
  });

  const persist = (next: FormState) => {
    if (!isEditing || !savedId.current) return;
    persisted.current = next;
    void financeService
      .updateExpense(workspaceSlug, savedId.current, payloadFrom(next))
      .then(onSaved)
      .catch((error) =>
        setToast({
          type: TOAST_TYPE.ERROR,
          title: t("payments.toasts.error"),
          message: getApiErrorMessage(error),
        })
      );
  };

  /** Discrete fields — a select, a date, a checkbox — write the moment they
   * change. On a new expense nothing is written until the footer saves. */
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((previous) => {
      const next = { ...previous, [key]: value };
      if (previous[key] !== value) persist(next);
      return next;
    });

  /** Typed fields write when they lose focus, and only if they actually moved. */
  const commit = (key: keyof FormState) =>
    setForm((current) => {
      if (persisted.current && current[key] !== persisted.current[key]) persist(current);
      return current;
    });

  const addFiles = (files: File[]) => {
    const picked = files.map((file) => ({ id: crypto.randomUUID(), file }));
    if (picked.length > 0) setQueued((current) => [...current, ...picked]);
  };

  /** Replaces the attachment set of a saved expense. */
  const syncDocuments = async (assetIds: string[]) => {
    if (!expense) return;
    const removed = documents.filter((document) => !assetIds.includes(document.asset_id));
    const added = assetIds.filter((id) => !documents.some((document) => document.asset_id === id));
    try {
      // The server takes one detach per call.
      for (const document of removed)
        // eslint-disable-next-line no-await-in-loop
        await financeService.detachDocument(workspaceSlug, expense.id, document.asset_id);
      if (added.length) await financeService.attachDocuments(workspaceSlug, expense.id, added);
      setDocuments((current) => current.filter((document) => assetIds.includes(document.asset_id)));
      onSaved();
    } catch {
      setToast({ type: TOAST_TYPE.ERROR, title: t("payments.toasts.error") });
    }
  };

  const isIncomplete = !form.concept.trim() || !form.amount.trim() || !form.expense_date || !form.currency;

  const handleSubmit = async () => {
    if (isSubmitting || isIncomplete || Number(form.amount) < 0) return;
    setIsSubmitting(true);
    try {
      const payload = payloadFrom(form);
      const saved = savedId.current
        ? await financeService.updateExpense(workspaceSlug, savedId.current, payload)
        : importId
          ? await financeService.confirmExpenseImport(workspaceSlug, importId, payload)
          : await financeService.createExpense(workspaceSlug, payload);
      savedId.current = saved.id;
      onSaved();
      if (queued.length > 0) {
        for (const item of queued) {
          if (!uploadedAssets.current.has(item.id)) {
            // Sequential so a retry after a partial failure skips what already
            // went up instead of uploading it twice.
            // eslint-disable-next-line no-await-in-loop
            const upload = await fileLibraryService.uploadFile(workspaceSlug, item.file);
            uploadedAssets.current.set(item.id, upload.asset_id);
          }
        }
        await financeService.attachDocuments(workspaceSlug, saved.id, [...uploadedAssets.current.values()]);
      }

      setToast({
        type: TOAST_TYPE.SUCCESS,
        title: t(expense ? "payments.toasts.updated" : "payments.toasts.created"),
      });
      onSaved();
      if (keepOpen.current) {
        // Same panel, blank form — the fast path when filing a stack of receipts
        keepOpen.current = false;
        savedId.current = null;
        uploadedAssets.current.clear();
        setQueued([]);
        setDocuments([]);
        setForm((current) => ({ ...emptyForm(), currency: current.currency, expense_date: current.expense_date }));
      } else onClose();
    } catch (error: unknown) {
      keepOpen.current = false;
      setToast({
        type: TOAST_TYPE.ERROR,
        title: t("payments.toasts.error"),
        message: savedId.current ? t("payments.ledger.saving_files") : getApiErrorMessage(error),
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <PaymentsSidePanel
      isOpen={isOpen}
      onClose={() => !isSubmitting && onClose()}
      title={t(expense ? "payments.edit_expense" : "payments.new_expense")}
      headerActions={
        onDelete && (
          <button
            type="button"
            onClick={onDelete}
            aria-label={t("payments.actions.delete")}
            className="rounded-sm p-1 text-tertiary hover:bg-layer-1-hover hover:text-danger-primary"
          >
            <Trash2 className="size-4" />
          </button>
        )
      }
    >
      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          void handleSubmit();
        }}
      >
        <fieldset disabled={isSubmitting} className="min-h-0 flex-1 space-y-6 overflow-y-auto px-6 pb-8">
          {/* What it is, before how it is filed — the record names itself first,
              exactly as a work item opens. */}
          <div className="space-y-2">
            <TextArea
              aria-label={t("payments.sheet.concept")}
              value={form.concept}
              required
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              maxLength={255}
              placeholder={t("payments.ledger.concept_placeholder")}
              onChange={(event) => setForm((previous) => ({ ...previous, concept: event.target.value }))}
              onBlur={() => commit("concept")}
              className="block w-full resize-none overflow-hidden rounded-sm border-none bg-transparent px-0 py-0 text-20 font-medium ring-0 outline-none"
            />
            <TextArea
              aria-label={t("payments.fields.description")}
              value={form.description}
              placeholder={t("payments.fields.description")}
              onChange={(event) => setForm((previous) => ({ ...previous, description: event.target.value }))}
              onBlur={() => commit("description")}
              className="block w-full resize-none rounded-sm border-none bg-transparent px-0 text-13 ring-0 outline-none"
            />
          </div>

          <div className="space-y-2 border-t border-subtle pt-5">
            <SidebarPropertyListItem icon={EstimatePropertyIcon} label={t("payments.fields.amount")}>
              <div className="flex w-full items-center gap-1">
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  required
                  aria-label={t("payments.fields.amount")}
                  value={form.amount}
                  placeholder="0.00"
                  onChange={(event) => setForm((previous) => ({ ...previous, amount: event.target.value }))}
                  onBlur={() => commit("amount")}
                  className={`${INLINE} font-mono grow text-right`}
                />
                <select
                  aria-label={t("payments.fields.currency")}
                  required
                  value={form.currency}
                  onChange={(event) => set("currency", event.target.value)}
                  className={`${INLINE} w-20 shrink-0`}
                >
                  <option value="">—</option>
                  {[...new Set([...CURRENCIES, form.currency].filter(Boolean))].map((currency) => (
                    <option key={currency} value={currency}>
                      {currency}
                    </option>
                  ))}
                </select>
              </div>
            </SidebarPropertyListItem>

            <SidebarPropertyListItem icon={StatePropertyIcon} label={t("payments.fields.status")}>
              <select
                aria-label={t("payments.fields.status")}
                value={form.status}
                onChange={(event) => set("status", event.target.value as TExpenseStatus)}
                className={INLINE}
              >
                <option value="PENDING">{t("payments.status.pending")}</option>
                <option value="PAID">{t("payments.status.paid")}</option>
                <option value="CANCELLED">{t("payments.status.cancelled")}</option>
              </select>
            </SidebarPropertyListItem>

            <SidebarPropertyListItem icon={DueDatePropertyIcon} label={t("payments.fields.date")}>
              <input
                type="date"
                required
                aria-label={t("payments.fields.date")}
                value={form.expense_date}
                onChange={(event) => set("expense_date", event.target.value)}
                className={INLINE}
              />
            </SidebarPropertyListItem>

            <SidebarPropertyListItem icon={LabelPropertyIcon} label={t("payments.fields.category")}>
              <FinanceCategorySelect
                workspaceSlug={workspaceSlug}
                value={form.category}
                onChange={(category) => set("category", category)}
              />
            </SidebarPropertyListItem>

            <SidebarPropertyListItem icon={LabelPropertyIcon} label={t("payments.ledger.tags")}>
              <FinanceTagPicker
                workspaceSlug={workspaceSlug}
                value={form.tags}
                onChange={(tags) => set("tags", tags)}
              />
            </SidebarPropertyListItem>

            <SidebarPropertyListItem icon={UserCirclePropertyIcon} label={t("payments.fields.vendor")}>
              <input
                aria-label={t("payments.fields.vendor")}
                value={form.vendor}
                onChange={(event) => setForm((previous) => ({ ...previous, vendor: event.target.value }))}
                onBlur={() => commit("vendor")}
                className={INLINE}
              />
            </SidebarPropertyListItem>

            <SidebarPropertyListItem icon={ParentPropertyIcon} label={t("payments.fields.reference")}>
              <input
                aria-label={t("payments.fields.reference")}
                value={form.reference}
                onChange={(event) => setForm((previous) => ({ ...previous, reference: event.target.value }))}
                onBlur={() => commit("reference")}
                className={INLINE}
              />
            </SidebarPropertyListItem>

            {/* Linking to a budget records the expense against the plan; it
                never adds to it. */}
            <SidebarPropertyListItem
              icon={ParentPropertyIcon}
              label={t("payments.flow.budget")}
              childrenClassName="flex-col items-stretch"
            >
              <select
                aria-label={t("payments.flow.budget")}
                value={form.scenario}
                onChange={(event) => set("scenario", event.target.value)}
                className={INLINE}
              >
                <option value="">{t("payments.flow.no_budget")}</option>
                {scenarios.map((scenario) => (
                  <option key={scenario.id} value={scenario.id}>
                    {scenario.name}
                  </option>
                ))}
              </select>
              <p className="px-1.5 text-11 text-tertiary">{t("payments.flow.actual_help")}</p>
            </SidebarPropertyListItem>
          </div>

          <section className="border-t border-subtle pt-5">
            <h3 className="mb-3 flex items-center gap-1.5 text-body-sm-medium">
              <Repeat className="size-4 text-tertiary" />
              {t("payments.ledger.recurrence")}
            </h3>
            {expense?.series ? (
              <p className="rounded-md bg-layer-1 p-3 text-12 text-tertiary">{t("payments.ledger.series_help")}</p>
            ) : (
              <div className="space-y-2">
                <SidebarPropertyListItem icon={Repeat} label={t("payments.ledger.recurrence")}>
                  <select
                    aria-label={t("payments.ledger.recurrence")}
                    value={form.recurrence}
                    onChange={(event) => set("recurrence", event.target.value as TExpense["recurrence"])}
                    className={INLINE}
                  >
                    {RECURRENCES.map((key) => (
                      <option key={key} value={key}>
                        {t(`payments.variables.recurrence.${key.toLowerCase()}`)}
                      </option>
                    ))}
                  </select>
                </SidebarPropertyListItem>
                {form.recurrence !== "ONE_TIME" && (
                  <>
                    <SidebarPropertyListItem icon={DueDatePropertyIcon} label={t("payments.ledger.until")}>
                      <input
                        type="date"
                        aria-label={t("payments.ledger.until")}
                        min={form.expense_date}
                        value={form.recurrence_end}
                        onChange={(event) => set("recurrence_end", event.target.value)}
                        className={INLINE}
                      />
                    </SidebarPropertyListItem>
                    <label className="flex items-center gap-2 px-1.5 text-12 text-secondary">
                      <input
                        type="checkbox"
                        className="accent-accent-primary size-3.5"
                        checked={form.recurrence_paused}
                        onChange={(event) => set("recurrence_paused", event.target.checked)}
                      />
                      {t("payments.ledger.pause")}
                    </label>
                    <p className="px-1.5 text-11 text-tertiary">{t("payments.ledger.recurrence_help")}</p>
                  </>
                )}
              </div>
            )}
          </section>

          <section className="border-t border-subtle pt-5">
            <h3 className="mb-3 flex items-center gap-1.5 text-body-sm-medium">
              <Paperclip className="size-4 text-tertiary" />
              {t("payments.fields.documents")}
            </h3>
            {expense ? (
              <DocumentAttachments
                workspaceSlug={workspaceSlug}
                documents={documents}
                disabled={isSubmitting}
                onChange={syncDocuments}
              />
            ) : (
              /* Nothing to attach to yet: the files wait here and go up with
                 the expense the moment it is saved. */
              <div className="space-y-2">
                {queued.map((item) => (
                  <AttachmentCard
                    key={item.id}
                    name={item.file.name}
                    size={item.file.size}
                    isPending
                    pendingLabel={t("payments.ledger.pending_upload")}
                    onRemove={() => setQueued((current) => current.filter((queuedItem) => queuedItem.id !== item.id))}
                    removeLabel={t("payments.actions.cancel")}
                  />
                ))}
                <input
                  ref={queueInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(event) => {
                    addFiles(Array.from(event.target.files ?? []));
                    event.target.value = "";
                  }}
                />
                <button
                  type="button"
                  onClick={() => queueInputRef.current?.click()}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault();
                    addFiles([...event.dataTransfer.files]);
                  }}
                  className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-subtle py-3 text-12 text-tertiary hover:border-accent-strong hover:text-accent-primary"
                >
                  <Paperclip className="size-3.5" />
                  {t("payments.fields.add_files")}
                </button>
              </div>
            )}
          </section>

          {expense && (
            <section className="border-t border-subtle pt-5">
              <div className="mb-3 flex items-center gap-2">
                <h3 className="text-body-sm-medium">{t("common.comments")}</h3>
                {commentCell && (
                  <span className="rounded-sm bg-layer-1 px-1.5 py-0.5 text-body-xs-regular text-secondary">
                    {commentCell}
                  </span>
                )}
              </div>
              <FinanceComments
                key={`${expense.id}-${commentCell}`}
                workspaceSlug={workspaceSlug}
                target={{ expense: expense.id, cell: commentCell }}
              />
            </section>
          )}
        </fieldset>

        {/* A saved expense writes through on every field, so it needs no footer.
            A new one does. */}
        {!isEditing && (
          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-subtle bg-surface-1 px-6 py-3">
            <Button type="button" variant="secondary" size="sm" disabled={isSubmitting} onClick={onClose}>
              {t("payments.actions.cancel")}
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={isSubmitting || isIncomplete}
              onClick={() => {
                keepOpen.current = true;
                void handleSubmit();
              }}
            >
              {t("payments.ledger.save_and_new")}
            </Button>
            <Button
              variant="primary"
              size="sm"
              type="submit"
              loading={isSubmitting}
              disabled={isSubmitting || isIncomplete}
            >
              {t("payments.actions.save")}
            </Button>
          </div>
        )}
      </form>
    </PaymentsSidePanel>
  );
}
