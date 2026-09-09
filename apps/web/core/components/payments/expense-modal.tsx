/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useRef, useState } from "react";
import { Paperclip, X } from "lucide-react";
// plane imports
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import { Tooltip } from "@plane/propel/tooltip";
import type { TExpense, TExpenseCategory, TExpenseDocument, TExpenseStatus } from "@plane/types";
import { Input } from "@plane/ui";
import { cn, convertBytesToSize, getFileExtension } from "@plane/utils";
// services
import { fileLibraryService } from "@/services/file-library.service";
import { financeService } from "@/services/finance.service";
// local imports
import { documentIcon } from "./document-kind";
import { PaymentsSidePanel } from "./side-panel";
import { CURRENCIES, todayIso, getApiErrorMessage } from "./shared";

const FIELD =
  "h-8 w-full rounded-sm border border-subtle bg-layer-1 px-2 text-13 text-primary outline-none focus:border-accent-primary";
const LABEL = "mb-1 block text-11 font-medium uppercase text-tertiary";

type Props = {
  workspaceSlug: string;
  isOpen: boolean;
  categories: TExpenseCategory[];
  /** null = creating a new expense */
  expense: TExpense | null;
  onClose: () => void;
  onSaved: () => void;
  initialData?: Partial<TExpense>;
  importId?: string;
  /** Opens the shared document viewer on an already-saved attachment. */
  onPreview?: (index: number) => void;
};

type FormState = {
  concept: string;
  tags: string;
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
  tags: "",
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

/** A titled block of fields. Grouping keeps the panel scannable: what the
 * expense *is*, how it is filed, whether it repeats, and what backs it up.
 */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-subtle px-5 py-4 last:border-b-0">
      <h4 className="mb-3 text-11 font-semibold tracking-wide text-secondary uppercase">{title}</h4>
      {children}
    </section>
  );
}

export function ExpenseModal(props: Props) {
  const { workspaceSlug, isOpen, categories, expense, onClose, onSaved, initialData, importId, onPreview } = props;
  const { t } = useTranslation();
  const [form, setForm] = useState<FormState>(emptyForm());
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Documents already attached to the expense (edit mode)
  const [documents, setDocuments] = useState<TExpenseDocument[]>([]);
  // Files picked but not uploaded yet. A new expense has no id to attach them
  // to, so they wait here until the expense exists. Each carries its own id:
  // two files can share a name, and the list must still track them apart.
  const [queued, setQueued] = useState<{ id: string; file: File }[]>([]);
  const [isDropping, setIsDropping] = useState(false);
  const savedId = useRef<string | null>(null);
  const uploadedAssets = useRef<Map<string, string>>(new Map());
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Set by "save and add another" so the submit handler knows to reopen empty
  const keepOpen = useRef(false);

  useEffect(() => {
    if (!isOpen) return;
    savedId.current = expense?.id ?? null;
    uploadedAssets.current.clear();
    setQueued([]);
    setDocuments(expense?.documents ?? []);
    setForm(
      expense
        ? {
            concept: expense.concept || expense.vendor || expense.description,
            tags: (expense.tags ?? []).join(", "),
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
            tags: (initialData?.tags ?? []).join(", "),
            recurrence_end: initialData?.recurrence_end ?? "",
            category: initialData?.category ?? "",
          }
    );
  }, [isOpen, expense, initialData]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((previous) => ({ ...previous, [key]: value }));

  const addFiles = (files: File[]) => {
    const picked = files.map((file) => ({ id: crypto.randomUUID(), file }));
    if (picked.length > 0) setQueued((current) => [...current, ...picked]);
  };

  const handlePick = (event: React.ChangeEvent<HTMLInputElement>) => {
    addFiles(Array.from(event.target.files ?? []));
    // Reset so re-picking the same file still fires onChange
    event.target.value = "";
  };

  /** Detaches a document that is already saved. The file itself stays in the
   * library — it may be wanted on its own or linked from elsewhere.
   */
  const handleDetach = async (document: TExpenseDocument) => {
    if (!expense) return;
    setDocuments((current) => current.filter((item) => item.asset_id !== document.asset_id));
    try {
      await financeService.detachDocument(workspaceSlug, expense.id, document.asset_id);
      onSaved();
    } catch {
      // Put it back — the server still has it
      setDocuments((current) => [...current, document]);
      setToast({ type: TOAST_TYPE.ERROR, title: t("payments.toasts.error") });
    }
  };

  const isIncomplete = !form.concept.trim() || !form.amount.trim() || !form.expense_date || !form.currency;

  const handleSubmit = async () => {
    if (isSubmitting || isIncomplete || Number(form.amount) < 0) return;
    setIsSubmitting(true);
    try {
      const payload = {
        ...form,
        tags: form.tags
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
        recurrence_end: form.recurrence_end || null,
        // The API takes null, not "", for the optional relation
        category: form.category || null,
        // Recording something as paid without a date leaves the ledger unable to
        // say when it was settled
        paid_at: form.status === "PAID" ? expense?.paid_at || form.expense_date : null,
      };
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
      description={t(importId ? "payments.ledger.review_help" : "payments.ledger.form_help")}
    >
      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          void handleSubmit();
        }}
      >
        <fieldset disabled={isSubmitting} className="min-h-0 flex-1 overflow-y-auto">
          <Section title={t("payments.ledger.section_details")}>
            <div className="grid grid-cols-2 gap-3">
              <label className="col-span-2">
                <span className={LABEL}>{t("payments.sheet.concept")}</span>
                <Input
                  value={form.concept}
                  required
                  autoFocus
                  maxLength={255}
                  onChange={(event) => set("concept", event.target.value)}
                  placeholder={t("payments.ledger.concept_placeholder")}
                  className="w-full"
                />
              </label>
              <div>
                <label className={LABEL} htmlFor="expense-amount">
                  {t("payments.fields.amount")}
                </label>
                <Input
                  id="expense-amount"
                  type="number"
                  step="0.01"
                  min="0"
                  required
                  value={form.amount}
                  onChange={(event) => set("amount", event.target.value)}
                  placeholder="0.00"
                  className="w-full"
                />
              </div>
              <div>
                <label className={LABEL} htmlFor="expense-currency">
                  {t("payments.fields.currency")}
                </label>
                <select
                  id="expense-currency"
                  required
                  className={FIELD}
                  value={form.currency}
                  onChange={(event) => set("currency", event.target.value)}
                >
                  <option value="">—</option>
                  {[...new Set([...CURRENCIES, form.currency].filter(Boolean))].map((currency) => (
                    <option key={currency} value={currency}>
                      {currency}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className={LABEL} htmlFor="expense-date">
                  {t("payments.fields.date")}
                </label>
                <input
                  id="expense-date"
                  type="date"
                  required
                  className={FIELD}
                  value={form.expense_date}
                  onChange={(event) => set("expense_date", event.target.value)}
                />
              </div>
              <div>
                <label className={LABEL} htmlFor="expense-status">
                  {t("payments.fields.status")}
                </label>
                <select
                  id="expense-status"
                  className={FIELD}
                  value={form.status}
                  onChange={(event) => set("status", event.target.value as TExpenseStatus)}
                >
                  <option value="PENDING">{t("payments.status.pending")}</option>
                  <option value="PAID">{t("payments.status.paid")}</option>
                  <option value="CANCELLED">{t("payments.status.cancelled")}</option>
                </select>
              </div>
            </div>
          </Section>

          <Section title={t("payments.ledger.section_classification")}>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={LABEL} htmlFor="expense-category">
                  {t("payments.fields.category")}
                </label>
                <select
                  id="expense-category"
                  className={FIELD}
                  value={form.category}
                  onChange={(event) => set("category", event.target.value)}
                >
                  <option value="">—</option>
                  {categories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
                </select>
              </div>
              <label>
                <span className={LABEL}>{t("payments.fields.vendor")}</span>
                <Input value={form.vendor} onChange={(event) => set("vendor", event.target.value)} className="w-full" />
              </label>
              <label>
                <span className={LABEL}>{t("payments.fields.reference")}</span>
                <Input
                  value={form.reference}
                  onChange={(event) => set("reference", event.target.value)}
                  className="w-full"
                />
              </label>
              <label>
                <span className={LABEL}>{t("payments.ledger.tags")}</span>
                <Input
                  value={form.tags}
                  onChange={(event) => set("tags", event.target.value)}
                  placeholder="Oficina, Viajes"
                  className="w-full"
                />
              </label>
              <label className="col-span-2">
                <span className={LABEL}>{t("payments.fields.description")}</span>
                <textarea
                  className={`${FIELD} h-auto py-1.5`}
                  rows={2}
                  value={form.description}
                  onChange={(event) => set("description", event.target.value)}
                />
              </label>
            </div>
          </Section>

          <Section title={t("payments.ledger.recurrence")}>
            {expense?.series ? (
              <p className="rounded-md bg-layer-2 p-3 text-12 text-tertiary">{t("payments.ledger.series_help")}</p>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <label>
                    <span className={LABEL}>{t("payments.ledger.recurrence")}</span>
                    <select
                      className={FIELD}
                      value={form.recurrence}
                      onChange={(event) => set("recurrence", event.target.value as TExpense["recurrence"])}
                    >
                      {["ONE_TIME", "DAILY", "WEEKLY", "BIWEEKLY", "MONTHLY", "QUARTERLY", "ANNUAL"].map((key) => (
                        <option key={key} value={key}>
                          {t(`payments.variables.recurrence.${key.toLowerCase()}`)}
                        </option>
                      ))}
                    </select>
                  </label>
                  {form.recurrence !== "ONE_TIME" && (
                    <label>
                      <span className={LABEL}>{t("payments.ledger.until")}</span>
                      <input
                        type="date"
                        min={form.expense_date}
                        value={form.recurrence_end}
                        onChange={(event) => set("recurrence_end", event.target.value)}
                        className={FIELD}
                      />
                      {!form.recurrence_end && (
                        <span className="mt-1 block text-11 text-tertiary">{t("payments.ledger.no_end")}</span>
                      )}
                    </label>
                  )}
                </div>
                {form.recurrence !== "ONE_TIME" && (
                  <>
                    <p className="mt-3 text-12 text-tertiary">{t("payments.ledger.recurrence_help")}</p>
                    <label className="mt-3 flex items-center gap-2 text-12 text-secondary">
                      <input
                        type="checkbox"
                        className="accent-accent-primary size-3.5"
                        checked={form.recurrence_paused}
                        onChange={(event) => set("recurrence_paused", event.target.checked)}
                      />
                      {t("payments.ledger.pause")}
                    </label>
                  </>
                )}
              </>
            )}
          </Section>

          {/* Supporting documents — several per expense */}
          <Section title={t("payments.fields.documents")}>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="application/pdf,application/xml,text/xml,image/png,image/jpeg,image/webp,image/tiff,.xml"
              className="hidden"
              onChange={handlePick}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(event) => {
                event.preventDefault();
                setIsDropping(true);
              }}
              onDragLeave={() => setIsDropping(false)}
              onDrop={(event) => {
                event.preventDefault();
                setIsDropping(false);
                addFiles([...event.dataTransfer.files]);
              }}
              className={cn(
                "flex w-full flex-col items-center gap-1 rounded-md border border-dashed py-4 text-12 text-tertiary",
                isDropping
                  ? "border-accent-primary bg-accent-primary/5 text-accent-primary"
                  : "border-subtle hover:border-accent-primary hover:text-accent-primary"
              )}
            >
              <Paperclip className="size-4" />
              {t("payments.fields.add_files")}
              <span className="text-11 text-tertiary">{t("payments.ledger.drop_files")}</span>
            </button>

            {(documents.length > 0 || queued.length > 0) && (
              <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                {documents.map((document, position) => (
                  <li key={document.asset_id}>
                    <AttachmentCard
                      name={document.name}
                      size={document.size}
                      onOpen={onPreview ? () => onPreview(position) : undefined}
                      onRemove={() => void handleDetach(document)}
                      removeLabel={t("payments.actions.delete")}
                    />
                  </li>
                ))}
                {/* Queued files are not uploaded until the expense is saved */}
                {queued.map((item) => (
                  <li key={item.id}>
                    <AttachmentCard
                      name={item.file.name}
                      size={item.file.size}
                      isPending
                      pendingLabel={t("payments.ledger.pending_upload")}
                      onRemove={() => setQueued((current) => current.filter((queuedItem) => queuedItem.id !== item.id))}
                      removeLabel={t("payments.actions.cancel")}
                    />
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </fieldset>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-subtle bg-surface-1 px-5 py-3">
          <Button type="button" variant="secondary" size="sm" disabled={isSubmitting} onClick={onClose}>
            {t("payments.actions.cancel")}
          </Button>
          {!expense && (
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
          )}
          <Button variant="primary" size="sm" type="submit" loading={isSubmitting} disabled={isSubmitting || isIncomplete}>
            {t("payments.actions.save")}
          </Button>
        </div>
      </form>
    </PaymentsSidePanel>
  );
}

/** The attachment card work items use: type icon, name, extension and size,
 * with an X to take it back off. Clicking it opens the document viewer.
 */
function AttachmentCard({
  name,
  size,
  isPending = false,
  pendingLabel,
  onOpen,
  onRemove,
  removeLabel,
}: {
  name: string;
  size: number;
  isPending?: boolean;
  pendingLabel?: string;
  onOpen?: () => void;
  onRemove: () => void;
  removeLabel: string;
}) {
  const extension = getFileExtension(name);

  return (
    <div
      className={cn(
        "flex h-[60px] items-center justify-between gap-2 rounded-md border-2 border-subtle bg-surface-1 px-3 py-2 text-13",
        isPending && "border-dashed"
      )}
    >
      <button
        type="button"
        disabled={!onOpen}
        onClick={onOpen}
        className="flex min-w-0 items-center gap-3 text-left disabled:cursor-default"
      >
        <span className="size-7 shrink-0">{documentIcon(name)}</span>
        <span className="flex min-w-0 flex-col gap-1">
          <Tooltip tooltipContent={name}>
            <span className="truncate text-13 text-primary">{name}</span>
          </Tooltip>
          <span className="flex items-center gap-3 text-11 text-secondary">
            <span>{extension.toUpperCase()}</span>
            <span>{convertBytesToSize(size)}</span>
            {isPending && pendingLabel && <span className="text-tertiary">{pendingLabel}</span>}
          </span>
        </span>
      </button>
      <button
        type="button"
        onClick={onRemove}
        aria-label={removeLabel}
        title={removeLabel}
        className="shrink-0 text-secondary hover:text-danger-primary"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
