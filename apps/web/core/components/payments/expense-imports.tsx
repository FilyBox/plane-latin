import { useRef, useState } from "react";
import { FileText, Loader2, Upload } from "lucide-react";
import useSWR from "swr";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { EmptyStateCompact } from "@plane/propel/empty-state";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import { AlertModalCore } from "@plane/ui";
import { fileLibraryService } from "@/services/file-library.service";
import { financeService, type TExpenseImport } from "@/services/finance.service";
import { ExpenseModal } from "./expense-modal";
import { PaymentsSidePanel } from "./side-panel";
import { getApiErrorMessage } from "./shared";

export function ExpenseImports({
  workspaceSlug,
  onChanged,
  scenarioId,
  onOpenExpense,
}: {
  workspaceSlug: string;
  onChanged: () => void;
  scenarioId?: string;
  onOpenExpense?: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const completed = useRef<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [review, setReview] = useState<TExpenseImport | null>(null);
  const [discard, setDiscard] = useState<TExpenseImport | null>(null);
  const [failures, setFailures] = useState<{ file: File; assetId?: string }[]>([]);
  const {
    data: jobs,
    error,
    mutate,
  } = useSWR(`EXPENSE_IMPORTS_${workspaceSlug}`, () => financeService.getExpenseImports(workspaceSlug), {
    onSuccess: (data) => {
      const signature = data
        .filter((job) => job.status === "IMPORTED")
        .map((job) => job.id)
        .sort()
        .join(",");
      if (completed.current !== null && completed.current !== signature) onChanged();
      completed.current = signature;
    },
    refreshInterval: (data) => (data?.some((job) => job.status === "QUEUED" || job.status === "RUNNING") ? 3000 : 0),
  });
  const fail = (reason: unknown) =>
    setToast({ type: TOAST_TYPE.ERROR, title: t("payments.toasts.error"), message: getApiErrorMessage(reason) });
  const upload = async (items: { file: File; assetId?: string }[]) => {
    if (busy) return;
    setBusy(true);
    const failed: typeof items = [];
    for (const item of items) {
      setProgress(item.file.name);
      // One receipt at a time: the progress line names the file being worked
      // on, and a failure has to be attributed to it.
      /* eslint-disable no-await-in-loop */
      try {
        if (!item.assetId) item.assetId = (await fileLibraryService.uploadFile(workspaceSlug, item.file)).asset_id;
        await financeService.startExpenseImports(workspaceSlug, [item.assetId], scenarioId);
      } catch (reason) {
        failed.push(item);
        fail(reason);
      }
      await mutate();
      /* eslint-enable no-await-in-loop */
    }
    setFailures(failed);
    setProgress("");
    setBusy(false);
  };
  const pick = (files: File[]) => {
    const accepted = new Set([
      "application/pdf",
      "application/xml",
      "text/xml",
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/tiff",
    ]);
    if (
      files.length > 30 ||
      files.some(
        (file) =>
          file.size > 20 * 1024 * 1024 || (!accepted.has(file.type) && !file.name.toLowerCase().endsWith(".xml"))
      )
    ) {
      setToast({ type: TOAST_TYPE.ERROR, title: t("payments.ledger.invalid_file") });
      return;
    }
    void upload(
      files.map((file) => ({ file: file.type ? file : new File([file], file.name, { type: "application/xml" }) }))
    );
  };
  const pending = jobs?.filter((job) => job.status === "QUEUED" || job.status === "RUNNING").length ?? 0;
  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        {t("payments.flow.queue")}
        {pending > 0 && <span className="rounded-sm bg-layer-2 px-1.5 text-11">{pending}</span>}
      </Button>
      <PaymentsSidePanel
        isOpen={open}
        onClose={() => setOpen(false)}
        title={t("payments.flow.queue")}
        description={t("payments.flow.queue_help")}
      >
        <div className="flex min-h-0 flex-1 flex-col overflow-auto p-4 sm:p-5">
          <ExpenseModal
            workspaceSlug={workspaceSlug}
            isOpen={review !== null}
            expense={null}
            initialData={review ? { ...review.data, scenario: scenarioId ?? null } : undefined}
            importId={review?.id}
            onClose={() => setReview(null)}
            onSaved={() => {
              void mutate();
              onChanged();
            }}
          />
          <AlertModalCore
            isOpen={discard !== null}
            handleClose={() => !busy && setDiscard(null)}
            isSubmitting={busy}
            title={t("payments.ledger.discard")}
            content={t("payments.ledger.discard_help")}
            handleSubmit={() => {
              if (!discard || busy) return;
              setBusy(true);
              void financeService
                .discardExpenseImport(workspaceSlug, discard.id)
                .then(() => {
                  setDiscard(null);
                  return mutate();
                })
                .catch(fail)
                .finally(() => setBusy(false));
            }}
          />
          <div
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              if (!busy) pick([...event.dataTransfer.files]);
            }}
            className="mb-5 rounded-lg border border-dashed border-subtle bg-layer-1 p-6 text-center"
          >
            <Upload className="mx-auto mb-3 size-6 text-tertiary" />
            <p className="mx-auto mb-4 max-w-xl text-13 text-secondary">{t("payments.ledger.upload_help")}</p>
            <input
              ref={input}
              type="file"
              multiple
              accept=".pdf,.xml,.png,.jpg,.jpeg,.webp,.tif,.tiff"
              className="hidden"
              onChange={(event) => {
                pick([...(event.target.files ?? [])]);
                event.target.value = "";
              }}
            />
            <Button variant="primary" size="sm" loading={busy} disabled={busy} onClick={() => input.current?.click()}>
              {t("payments.ledger.upload")}
            </Button>
            {progress && (
              <p role="status" className="mt-2 text-12 text-tertiary">
                {progress}
              </p>
            )}
            {!!failures.length && (
              <div className="mt-3 text-12 text-danger-primary">
                <p>{failures.map((item) => item.file.name).join(", ")}</p>
                <button type="button" disabled={busy} onClick={() => void upload(failures)}>
                  {t("payments.ledger.retry")}
                </button>
              </div>
            )}
          </div>
          {error && (
            <button type="button" onClick={() => void mutate()} className="p-4 text-13 text-danger-primary">
              {t("payments.ledger.load_error")} · {t("payments.ledger.retry")}
            </button>
          )}
          {jobs?.length === 0 && (
            <div className="flex min-h-0 flex-1 items-center justify-center">
              <EmptyStateCompact assetKey="export" title={t("payments.ledger.empty_ai")} />
            </div>
          )}
          <div className="space-y-2">
            {jobs?.map((job) => (
              <div
                key={job.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-subtle bg-layer-1 p-4"
              >
                <div className="flex min-w-0 items-center gap-3">
                  {job.status === "QUEUED" || job.status === "RUNNING" ? (
                    <Loader2 className="size-5 shrink-0 animate-spin text-tertiary" />
                  ) : (
                    <FileText className="size-5 shrink-0 text-tertiary" />
                  )}
                  <div className="min-w-0">
                    <p className="truncate text-13 font-medium">{job.name}</p>
                    <p className="mt-1 text-11 text-tertiary">
                      {t(`payments.ledger.${job.status}`)}
                      {job.stage && ` · ${job.stage}`}
                    </p>
                    {job.error && <p className="mt-1 max-w-xl text-11 text-danger-primary">{job.error}</p>}
                    {job.data.warnings?.map((warning) => (
                      <p key={warning} className="mt-1 text-11 text-tertiary">
                        {warning}
                      </p>
                    ))}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  {job.status === "READY" && (
                    <Button size="sm" variant="primary" onClick={() => setReview(job)}>
                      {t("payments.ledger.review")}
                    </Button>
                  )}
                  {(job.status === "FAILED" ||
                    job.status === "CANCELLED" ||
                    ((job.status === "QUEUED" || job.status === "RUNNING") &&
                      Date.now() - Date.parse(job.created_at) > 1800000)) && (
                    <button
                      type="button"
                      disabled={busy}
                      className="text-12 text-accent-primary"
                      onClick={() => {
                        setBusy(true);
                        void financeService
                          .retryExpenseImport(workspaceSlug, job.id)
                          .then(() => mutate())
                          .catch(fail)
                          .finally(() => setBusy(false));
                      }}
                    >
                      {t("payments.ledger.retry")}
                    </button>
                  )}
                  {job.status === "IMPORTED" && job.expense_id && (
                    <button
                      type="button"
                      className="text-12 text-secondary"
                      onClick={() => {
                        setOpen(false);
                        onOpenExpense?.(job.expense_id!);
                      }}
                    >
                      {t("payments.flow.open_expense")}
                    </button>
                  )}
                  <a
                    href={fileLibraryService.getFileDownloadUrl(workspaceSlug, job.asset_id)}
                    download={job.name}
                    className="text-12 text-secondary hover:text-primary"
                  >
                    {t("payments.actions.download")}
                  </a>
                  {(job.status === "QUEUED" || job.status === "RUNNING") && (
                    <button
                      type="button"
                      disabled={busy}
                      className="text-12 text-secondary"
                      onClick={() => {
                        setBusy(true);
                        void financeService
                          .cancelExpenseImport(workspaceSlug, job.id)
                          .then(() => mutate())
                          .catch(fail)
                          .finally(() => setBusy(false));
                      }}
                    >
                      {t("common.cancel")}
                    </button>
                  )}
                  {
                    <button
                      type="button"
                      onClick={() => setDiscard(job)}
                      className="text-12 text-tertiary hover:text-danger-primary"
                    >
                      {t("payments.ledger.discard")}
                    </button>
                  }
                </div>
              </div>
            ))}
          </div>
        </div>
      </PaymentsSidePanel>
    </>
  );
}
