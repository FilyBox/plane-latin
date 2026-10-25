/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * Contract uploads: each file is hashed and checked against existing
 * contracts first, then uploaded at most three at a time with its own
 * progress. Failures stay in the list to retry; duplicates wait for a choice.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Copy,
  FileText,
  Loader2,
  RotateCcw,
  X,
} from "lucide-react";
// plane imports
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import { cn } from "@plane/utils";
// services
import { contractService } from "@/services/contract.service";
import { fileLibraryService } from "@/services/file-library.service";
// local imports
import { formatFileSize, sha256File } from "./utils";

const MAX_CONCURRENT = 3;

type TUploadStatus = "hashing" | "duplicate" | "queued" | "uploading" | "done" | "failed";

export type TUploadItem = {
  id: string;
  file: File;
  status: TUploadStatus;
  progress: number;
  hash: string;
  error?: string;
  /** Existing contract with the same content; null = repeated in this same batch */
  duplicateOf?: { id: string; titulo: string | null; file_name: string | null } | null;
};

const isPdf = (file: File) => file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");

let uploadSeq = 0;

export function useContractUploadQueue(workspaceSlug: string, onUploaded: () => void) {
  const { t } = useTranslation();
  const [items, setItems] = useState<TUploadItem[]>([]);
  const [rejected, setRejected] = useState<string[]>([]);
  const running = useRef(new Set<string>());
  const categoryPromise = useRef<Promise<string> | null>(null);
  // Summary toast once a batch settles
  const batchHadWork = useRef(false);

  const patch = useCallback((id: string, next: Partial<TUploadItem>) => {
    setItems((current) => current.map((item) => (item.id === id ? { ...item, ...next } : item)));
  }, []);

  const contractsCategoryId = useCallback(() => {
    if (!categoryPromise.current) {
      categoryPromise.current = fileLibraryService.getCategories(workspaceSlug).then((categories) => {
        const category = categories.find((entry) => entry.is_default);
        if (!category) throw new Error(t("file_library.contracts.upload.no_category"));
        return category.id;
      });
      categoryPromise.current.catch(() => {
        categoryPromise.current = null;
      });
    }
    return categoryPromise.current;
  }, [t, workspaceSlug]);

  const addFiles = useCallback(
    async (files: File[]) => {
      const pdfs = files.filter(isPdf);
      const others = files.filter((file) => !isPdf(file)).map((file) => file.name);
      setRejected(others);
      if (pdfs.length === 0) return;
      batchHadWork.current = true;
      const fresh: TUploadItem[] = pdfs.map((file) => ({
        id: `upload-${++uploadSeq}`,
        file,
        status: "hashing",
        progress: 0,
        hash: "",
      }));
      setItems((current) => [...current.filter((item) => item.status !== "done"), ...fresh]);

      const hashes = await Promise.all(fresh.map((item) => sha256File(item.file).catch(() => "")));
      let duplicates: Record<string, TUploadItem["duplicateOf"]> = {};
      try {
        const { results } = await contractService.checkDuplicates(
          workspaceSlug,
          fresh.map((item, index) => ({ name: item.file.name, size: item.file.size, hash: hashes[index] }))
        );
        duplicates = Object.fromEntries(
          (results ?? []).filter((result) => result.duplicate_of).map((result) => [result.name, result.duplicate_of])
        );
      } catch {
        // The check is a convenience: upload anyway if it fails
      }
      const seen = new Set<string>();
      setItems((current) => {
        current.forEach((item) => item.hash && item.status !== "failed" && seen.add(item.hash));
        return current.map((item) => {
          const index = fresh.findIndex((entry) => entry.id === item.id);
          if (index === -1) return item;
          const hash = hashes[index];
          const existing = duplicates[item.file.name];
          if (existing) return { ...item, hash, status: "duplicate", duplicateOf: existing };
          if (hash && seen.has(hash)) return { ...item, hash, status: "duplicate", duplicateOf: null };
          if (hash) seen.add(hash);
          return { ...item, hash, status: "queued" };
        });
      });
    },
    [workspaceSlug]
  );

  const upload = useCallback(
    async (item: TUploadItem) => {
      running.current.add(item.id);
      patch(item.id, { status: "uploading", progress: 0, error: undefined });
      let lastPaint = 0;
      try {
        const categoryId = await contractsCategoryId();
        const response = await fileLibraryService.uploadFile(
          workspaceSlug,
          item.file,
          (event) => {
            const now = Date.now();
            if (!event.total || now - lastPaint < 150) return;
            lastPaint = now;
            patch(item.id, { progress: Math.min(99, Math.round((event.loaded / event.total) * 100)) });
          },
          undefined,
          undefined,
          undefined,
          item.hash || undefined
        );
        await fileLibraryService.addFileCategories(workspaceSlug, response.asset_id, [categoryId]);
        patch(item.id, { status: "done", progress: 100 });
        onUploaded();
      } catch (error: unknown) {
        const message =
          (error as { error?: string; message?: string })?.error ??
          (error as { message?: string })?.message ??
          t("file_library.contracts.upload.failed_one");
        patch(item.id, { status: "failed", error: message });
      } finally {
        running.current.delete(item.id);
      }
    },
    [contractsCategoryId, onUploaded, patch, t, workspaceSlug]
  );

  // Start queued files while there is room
  useEffect(() => {
    const free = MAX_CONCURRENT - running.current.size;
    if (free <= 0) return;
    items
      .filter((item) => item.status === "queued" && !running.current.has(item.id))
      .slice(0, free)
      .forEach((item) => void upload(item));
  }, [items, upload]);

  // Summary once nothing is pending
  const busy = items.some((item) => ["hashing", "queued", "uploading"].includes(item.status));
  useEffect(() => {
    if (busy || !batchHadWork.current) return;
    if (items.some((item) => item.status === "duplicate")) return;
    batchHadWork.current = false;
    const done = items.filter((item) => item.status === "done").length;
    const failed = items.filter((item) => item.status === "failed").length;
    if (done + failed === 0) return;
    if (failed === 0) {
      setToast({ type: TOAST_TYPE.SUCCESS, title: t("file_library.contracts.upload.started", { count: done }) });
    } else {
      setToast({
        type: TOAST_TYPE.WARNING,
        title: t("file_library.contracts.upload.partial", { done, total: done + failed, failed }),
      });
    }
  }, [busy, items, t]);

  const uploadAnyway = (id: string) => {
    batchHadWork.current = true;
    patch(id, { status: "queued", duplicateOf: undefined });
  };
  const retry = (id: string) => {
    batchHadWork.current = true;
    patch(id, { status: "queued", error: undefined, progress: 0 });
  };
  const retryFailed = () => {
    batchHadWork.current = true;
    setItems((current) =>
      current.map((item) => (item.status === "failed" ? { ...item, status: "queued", error: undefined } : item))
    );
  };
  const remove = (id: string) => setItems((current) => current.filter((item) => item.id !== id));
  const clear = () => {
    setItems((current) => current.filter((item) => ["hashing", "queued", "uploading"].includes(item.status)));
    setRejected([]);
  };

  return { items, rejected, busy, addFiles, uploadAnyway, retry, retryFailed, remove, clear };
}

type PanelProps = ReturnType<typeof useContractUploadQueue> & {
  onOpenContract: (contractId: string) => void;
};

/** Floating list of this session's uploads */
export function ContractUploadPanel(props: PanelProps) {
  const { items, rejected, busy, uploadAnyway, retry, retryFailed, remove, clear, onOpenContract } = props;
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(false);

  if (items.length === 0 && rejected.length === 0) return null;

  const done = items.filter((item) => item.status === "done").length;
  const failed = items.filter((item) => item.status === "failed").length;
  const waiting = items.filter((item) => item.status === "duplicate").length;
  const title = busy
    ? t("file_library.contracts.upload.uploading", { done, total: items.length })
    : failed > 0
      ? t("file_library.contracts.upload.partial", { done, total: items.length, failed })
      : waiting > 0
        ? t("file_library.contracts.upload.waiting", { count: waiting })
        : t("file_library.contracts.upload.finished", { count: done });

  return (
    <section
      aria-label={t("file_library.contracts.upload.panel_label")}
      className="fixed right-4 bottom-4 z-[26] flex max-h-[60vh] w-[22rem] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-lg border border-subtle bg-surface-1 shadow-raised-200"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-subtle px-3 py-2">
        {busy ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-accent-primary" />
        ) : failed > 0 ? (
          <AlertTriangle className="size-3.5 shrink-0 text-danger-primary" />
        ) : waiting > 0 ? (
          <Copy className="size-3.5 shrink-0 text-warning-primary" />
        ) : (
          <CheckCircle2 className="size-3.5 shrink-0 text-success-primary" />
        )}
        <p className="min-w-0 flex-1 truncate text-12 font-medium" aria-live="polite">
          {items.length > 0 ? title : t("file_library.contracts.upload.skipped_title")}
        </p>
        {failed > 0 && !busy && (
          <Button variant="tertiary" size="sm" onClick={retryFailed}>
            <RotateCcw className="size-3" />
            {t("file_library.contracts.upload.retry_failed")}
          </Button>
        )}
        <button
          type="button"
          onClick={() => setCollapsed((value) => !value)}
          aria-label={t(collapsed ? "file_library.contracts.upload.expand" : "file_library.contracts.upload.collapse")}
          aria-expanded={!collapsed}
          className="rounded-sm p-1 text-tertiary hover:bg-layer-1-hover"
        >
          {collapsed ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
        </button>
        {!busy && (
          <button
            type="button"
            onClick={clear}
            aria-label={t("close")}
            className="rounded-sm p-1 text-tertiary hover:bg-layer-1-hover"
          >
            <X className="size-3.5" />
          </button>
        )}
      </header>
      {!collapsed && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {rejected.length > 0 && (
            <p className="border-b border-subtle bg-warning-subtle px-3 py-2 text-11 text-secondary">
              {t("file_library.contracts.upload.not_pdf", { count: rejected.length })}{" "}
              <span className="text-tertiary">{rejected.join(", ")}</span>
            </p>
          )}
          <ul className="divide-y divide-subtle">
            {items.map((item) => (
              <li key={item.id} className="px-3 py-2">
                <div className="flex items-center gap-2">
                  <FileText className="size-3.5 shrink-0 text-danger-primary" />
                  <span className="min-w-0 flex-1 truncate text-12" title={item.file.name}>
                    {item.file.name}
                  </span>
                  <span className="shrink-0 text-10 text-tertiary tabular-nums">
                    {item.status === "uploading" ? `${item.progress}%` : formatFileSize(item.file.size)}
                  </span>
                  {item.status === "done" && <CheckCircle2 className="size-3.5 shrink-0 text-success-primary" />}
                  {(item.status === "failed" || item.status === "duplicate") && (
                    <button
                      type="button"
                      onClick={() => remove(item.id)}
                      aria-label={t("file_library.contracts.upload.remove")}
                      className="rounded-sm p-0.5 text-tertiary hover:bg-layer-1-hover"
                    >
                      <X className="size-3" />
                    </button>
                  )}
                </div>
                {(item.status === "uploading" || item.status === "queued" || item.status === "hashing") && (
                  <div
                    role="progressbar"
                    aria-label={item.file.name}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={item.progress}
                    className="mt-1.5 h-1 overflow-hidden rounded-full bg-layer-1"
                  >
                    <div
                      className={cn(
                        "h-full rounded-full bg-accent-primary transition-all",
                        item.status !== "uploading" && "w-0"
                      )}
                      style={item.status === "uploading" ? { width: `${item.progress}%` } : undefined}
                    />
                  </div>
                )}
                {item.status === "hashing" && (
                  <p className="mt-1 text-10 text-tertiary">{t("file_library.contracts.upload.checking")}</p>
                )}
                {item.status === "queued" && (
                  <p className="mt-1 text-10 text-tertiary">{t("file_library.contracts.upload.waiting")}</p>
                )}
                {item.status === "failed" && (
                  <div className="mt-1 flex items-center gap-2">
                    <p className="min-w-0 flex-1 truncate text-11 text-danger-primary" title={item.error}>
                      {item.error}
                    </p>
                    <button
                      type="button"
                      onClick={() => retry(item.id)}
                      className="shrink-0 text-11 font-medium text-accent-primary hover:underline"
                    >
                      {t("file_library.contracts.retry.button")}
                    </button>
                  </div>
                )}
                {item.status === "duplicate" && (
                  <div className="mt-1 rounded-sm bg-layer-1 px-2 py-1.5 text-11">
                    <p className="flex items-center gap-1 text-secondary">
                      <Copy className="size-3 shrink-0" />
                      {item.duplicateOf
                        ? t("file_library.contracts.upload.duplicate", {
                            name: item.duplicateOf.titulo || item.duplicateOf.file_name || "—",
                          })
                        : t("file_library.contracts.upload.duplicate_batch")}
                    </p>
                    <div className="mt-1 flex items-center gap-3">
                      {item.duplicateOf && (
                        <button
                          type="button"
                          onClick={() => item.duplicateOf && onOpenContract(item.duplicateOf.id)}
                          className="font-medium text-accent-primary hover:underline"
                        >
                          {t("file_library.contracts.upload.open_existing")}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => uploadAnyway(item.id)}
                        className="font-medium text-secondary hover:underline"
                      >
                        {t("file_library.contracts.upload.upload_anyway")}
                      </button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
