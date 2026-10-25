/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

/* The single iframe here hosts Collabora, a trusted first-party editor that
   requires both allow-scripts and allow-same-origin (its own docs mandate this
   combination). The rule that forbids that pairing does not apply. */
/* eslint-disable react/iframe-missing-sandbox */

import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, Braces, Check, Loader2, X } from "lucide-react";
// plane imports
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import type { TContractCollaboraSession } from "@plane/types";
import { cn } from "@plane/utils";
// services
import { fileLibraryService } from "@/services/file-library.service";
// local imports
import { ContractVariablesPanel } from "./contracts/contract-variables-panel";

/** What the editor knew when it closed. */
export type TCollaboraCloseState = {
  /** The document changed during this session (unknown = true when Collabora never reported). */
  modified: boolean;
  /** The last change was confirmed saved by Collabora. */
  saved: boolean;
};

type Props = {
  workspaceSlug: string;
  /** Opens a file-library asset (fetches its own session). */
  assetId: string | null;
  fileName: string;
  onClose: (state: TCollaboraCloseState) => void;
  /** A ready session (e.g. a template draft); takes precedence over `assetId`. */
  session?: TContractCollaboraSession | null;
  /** Second header line, e.g. the variant being edited. */
  subtitle?: string;
  /** Replaces the static placeholder reference in the side panel. */
  variablesPanel?: ReactNode;
  /** Collabora `ui_defaults`, e.g. "UIMode=compact;TextSidebar=false". Ignored by servers that don't know it. */
  uiDefaults?: string;
  /** Called after Collabora confirms a save. */
  onSaved?: () => void;
  /** @deprecated Kept for callers; the header no longer shows a draft hint. */
  deferredCommit?: boolean;
};

type SaveState = "loading" | "saved" | "dirty" | "saving" | "error";

/** No reply from Collabora after this long: messages aren't wired, fall back to timers. */
const READY_TIMEOUT_MS = 20000;
/** Idle time after a change before asking Collabora to save. */
const AUTOSAVE_DELAY_MS = 4000;
/** How long closing waits for the save confirmation. */
const CLOSE_SAVE_TIMEOUT_MS = 12000;
/** Legacy wait when Collabora never reports its state. */
const BLIND_CLOSE_DELAY_MS = 1500;

/**
 * Opens a document in Collabora Online.
 *
 * WOPI is form-driven: the editor is loaded by POSTing `access_token` to the
 * editor URL, targeted at an iframe. We cannot just set iframe.src, because the
 * token must travel in the POST body — so we build a real <form> and submit it
 * once the session resolves. Collabora then reports its state through
 * postMessage (loading, modified, save results), which drives the status line
 * and lets closing wait for a confirmed save.
 */
export function CollaboraEditorModal(props: Props) {
  const {
    workspaceSlug,
    assetId,
    fileName,
    onClose,
    session: providedSession,
    subtitle,
    variablesPanel,
    uiDefaults,
    onSaved,
  } = props;
  const { t } = useTranslation();
  const formRef = useRef<HTMLFormElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [fetchedSession, setFetchedSession] = useState<TContractCollaboraSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showVariables, setShowVariables] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("loading");
  const [lastSavedAt, setLastSavedAt] = useState<number>();
  const [isClosing, setIsClosing] = useState(false);
  const [closeTimedOut, setCloseTimedOut] = useState(false);
  const [, setNow] = useState(0);
  // Refs mirror state the message handler and timers read without re-subscribing.
  const modifiedRef = useRef(false);
  const everModifiedRef = useRef(false);
  const savePendingRef = useRef(false);
  const messagingRef = useRef(false);
  const closingRef = useRef(false);
  const autosaveTimerRef = useRef<number | undefined>(undefined);
  const closeTimerRef = useRef<number | undefined>(undefined);
  const readyTimerRef = useRef<number | undefined>(undefined);

  const session = providedSession ?? fetchedSession;
  const isOpen = Boolean(providedSession) || assetId !== null;

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  const post = useCallback((messageId: string, values?: Record<string, unknown>) => {
    iframeRef.current?.contentWindow?.postMessage(
      JSON.stringify({ MessageId: messageId, SendTime: Date.now(), ...(values ? { Values: values } : {}) }),
      "*"
    );
  }, []);

  const requestSave = useCallback(() => {
    window.clearTimeout(autosaveTimerRef.current);
    savePendingRef.current = true;
    setSaveState("saving");
    post("Action_Save", { DontTerminateEdit: true, DontSaveIfUnmodified: true, Notify: true });
  }, [post]);

  const finishClose = useCallback(() => {
    window.clearTimeout(closeTimerRef.current);
    window.clearTimeout(autosaveTimerRef.current);
    closingRef.current = false;
    setIsClosing(false);
    setCloseTimedOut(false);
    onCloseRef.current({
      modified: messagingRef.current ? everModifiedRef.current : true,
      saved: messagingRef.current ? !modifiedRef.current && !savePendingRef.current : false,
    });
  }, []);

  /** Close once the last change is saved; never on a fixed guess when Collabora can tell us. */
  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    if (!session || error) {
      finishClose();
      return;
    }
    if (!messagingRef.current) {
      // Collabora never reported its state: save and give it a moment, as before.
      closingRef.current = true;
      setIsClosing(true);
      post("Action_Save", { DontTerminateEdit: true, DontSaveIfUnmodified: true });
      closeTimerRef.current = window.setTimeout(finishClose, BLIND_CLOSE_DELAY_MS);
      return;
    }
    if (!modifiedRef.current && !savePendingRef.current) {
      finishClose();
      return;
    }
    closingRef.current = true;
    setIsClosing(true);
    setCloseTimedOut(false);
    if (modifiedRef.current && !savePendingRef.current) requestSave();
    closeTimerRef.current = window.setTimeout(() => setCloseTimedOut(true), CLOSE_SAVE_TIMEOUT_MS);
  }, [error, finishClose, post, requestSave, session]);

  const keepEditing = () => {
    window.clearTimeout(closeTimerRef.current);
    closingRef.current = false;
    setIsClosing(false);
    setCloseTimedOut(false);
  };

  // `t` is a fresh function each render; kept in a ref so the fetch effect can
  // use the latest translation without listing it as a dependency.
  const tRef = useRef(t);
  tRef.current = t;

  // Fetch a session for plain file-library assets.
  useEffect(() => {
    if (providedSession || !assetId) {
      setFetchedSession(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setFetchedSession(null);
    setError(null);
    (async () => {
      try {
        const data = await fileLibraryService.getCollaboraSession(workspaceSlug, assetId);
        if (!cancelled) setFetchedSession({ editor_url: data.editor_url, access_token: data.access_token });
      } catch (err: unknown) {
        const message = (err as { error?: string } | undefined)?.error;
        if (!cancelled) setError(message ?? tRef.current("file_library.collabora.error"));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [assetId, providedSession, workspaceSlug]);

  // Fresh state for every opened document.
  useEffect(() => {
    if (!isOpen) return;
    modifiedRef.current = false;
    everModifiedRef.current = false;
    savePendingRef.current = false;
    messagingRef.current = false;
    closingRef.current = false;
    setSaveState("loading");
    setLastSavedAt(undefined);
    setIsClosing(false);
    setCloseTimedOut(false);
  }, [isOpen, session?.access_token]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) return;
      let message = event.data;
      if (typeof message === "string") {
        try {
          message = JSON.parse(message);
        } catch {
          return;
        }
      }
      const id: string | undefined = message?.MessageId;
      const values = message?.Values ?? {};
      if (!id) return;
      messagingRef.current = true;
      window.clearTimeout(readyTimerRef.current);

      if (id === "App_LoadingStatus") {
        // Collabora spells it "Postmessage"; until it gets this exact id it ignores every message we send
        if (values.Status === "Frame_Ready") post("Host_PostmessageReady");
        if (values.Status === "Document_Loaded") setSaveState((current) => (current === "loading" ? "saved" : current));
        if (values.Status === "Failed") setError(tRef.current("file_library.collabora.error"));
        return;
      }
      if (id === "Doc_ModifiedStatus") {
        const modified = Boolean(values.Modified);
        modifiedRef.current = modified;
        if (modified) {
          everModifiedRef.current = true;
          if (!savePendingRef.current) setSaveState("dirty");
          window.clearTimeout(autosaveTimerRef.current);
          autosaveTimerRef.current = window.setTimeout(requestSave, AUTOSAVE_DELAY_MS);
        } else {
          // "Not modified" right after a save means it landed, even when
          // Collabora skips the Action_Save_Resp (e.g. an autosave it ran itself).
          const wasSaving = savePendingRef.current;
          savePendingRef.current = false;
          setSaveState("saved");
          setLastSavedAt(Date.now());
          if (wasSaving) onSavedRef.current?.();
          if (closingRef.current) finishClose();
        }
        return;
      }
      if (id === "Action_Save_Resp") {
        savePendingRef.current = false;
        const success = values.success !== false;
        if (success) {
          modifiedRef.current = false;
          setSaveState("saved");
          setLastSavedAt(Date.now());
          onSavedRef.current?.();
          if (closingRef.current) finishClose();
        } else {
          setSaveState("error");
          if (closingRef.current) setCloseTimedOut(true);
        }
        return;
      }
      if (id === "UI_Close" || id === "close") requestClose();
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [finishClose, post, requestClose, requestSave]);

  useEffect(
    () => () => {
      window.clearTimeout(autosaveTimerRef.current);
      window.clearTimeout(closeTimerRef.current);
      window.clearTimeout(readyTimerRef.current);
    },
    []
  );

  // Submit the form once the session is in and the form is on screen. The
  // browser posts the token to Collabora, which then calls our WOPI host back.
  useEffect(() => {
    if (!session || !formRef.current) return;
    formRef.current.submit();
    // If Collabora never talks to us, stop showing the skeleton after a while.
    window.clearTimeout(readyTimerRef.current);
    readyTimerRef.current = window.setTimeout(() => {
      if (!messagingRef.current) setSaveState((current) => (current === "loading" ? "saved" : current));
    }, READY_TIMEOUT_MS);
  }, [session]);

  // "Guardado hace 5 s" needs a clock.
  useEffect(() => {
    if (!isOpen || saveState !== "saved" || !lastSavedAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(timer);
  }, [isOpen, lastSavedAt, saveState]);

  // Lock body scroll while the full-screen editor is up.
  useEffect(() => {
    if (!isOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") requestClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener("keydown", onKey);
    };
  }, [isOpen, requestClose]);

  const statusLabel = (() => {
    if (isClosing && !closeTimedOut) return t("file_library.contracts.workflow.word_editor.saving_before_close");
    switch (saveState) {
      case "loading":
        return t("file_library.contracts.workflow.word_editor.loading");
      case "dirty":
        return t("file_library.contracts.workflow.word_editor.unsaved");
      case "saving":
        return t("file_library.contracts.workflow.word_editor.saving");
      case "error":
        return t("file_library.contracts.workflow.word_editor.save_failed");
      default: {
        if (!lastSavedAt) return t("file_library.contracts.workflow.word_editor.no_changes");
        const seconds = Math.max(1, Math.round((Date.now() - lastSavedAt) / 1000));
        return seconds < 60
          ? t("file_library.contracts.workflow.word_editor.saved_seconds", { count: seconds })
          : t("file_library.contracts.workflow.word_editor.saved_minutes", { count: Math.round(seconds / 60) });
      }
    }
  })();

  const modal = (
    <AnimatePresence initial={false}>
      {isOpen ? (
        <motion.div
          className="shadow-2xl fixed inset-0 z-[60] flex flex-col bg-surface-1"
          initial={{ opacity: 0, y: 18, scale: 0.992 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 14, scale: 0.994 }}
          transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
        >
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-subtle px-4 py-2">
            <div className="flex min-w-0 items-center gap-3">
              <div className="min-w-0">
                <p className="truncate text-14 font-medium text-primary">{fileName}</p>
                {subtitle ? <p className="truncate text-11 text-tertiary">{subtitle}</p> : null}
              </div>
              {session && !error ? (
                <span
                  role="status"
                  aria-live="polite"
                  className={cn(
                    "flex shrink-0 items-center gap-1.5 rounded-full bg-layer-1 px-2.5 py-1 text-11",
                    saveState === "error" ? "text-danger-primary" : "text-tertiary"
                  )}
                >
                  {saveState === "loading" || saveState === "saving" || (isClosing && !closeTimedOut) ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : saveState === "dirty" ? (
                    <span className="size-1.5 rounded-full bg-warning-primary" />
                  ) : saveState === "error" ? (
                    <AlertTriangle className="size-3" />
                  ) : (
                    <Check className="size-3 text-success-primary" />
                  )}
                  {statusLabel}
                </span>
              ) : null}
            </div>
            <div className="flex items-center gap-1">
              {/* The reserved placeholders are invisible from inside Word, so
                  the reference travels with the editor. */}
              <button
                type="button"
                onClick={() => setShowVariables((value) => !value)}
                aria-pressed={showVariables}
                className={cn(
                  "flex items-center gap-1.5 rounded-sm px-2 py-1.5 text-12 hover:bg-layer-1-hover",
                  showVariables ? "bg-layer-1 text-accent-primary" : "text-secondary"
                )}
              >
                <Braces className="size-4" />
                {t("file_library.contracts.workflow.variables.title")}
              </button>
              <button
                type="button"
                onClick={requestClose}
                disabled={isClosing && !closeTimedOut}
                className="rounded-sm p-1.5 hover:bg-layer-1-hover disabled:opacity-50"
                title={t("close")}
                aria-label={t("close")}
              >
                {isClosing && !closeTimedOut ? <Loader2 className="size-4 animate-spin" /> : <X className="size-4" />}
              </button>
            </div>
          </div>

          {closeTimedOut ? (
            <div
              role="alert"
              className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-subtle bg-warning-primary/10 px-4 py-2"
            >
              <p className="flex items-center gap-2 text-12 text-warning-primary">
                <AlertTriangle className="size-3.5 shrink-0" />
                {t("file_library.contracts.workflow.word_editor.close_unconfirmed")}
              </p>
              <div className="flex gap-2">
                <Button variant="secondary" size="sm" onClick={keepEditing}>
                  {t("file_library.contracts.workflow.word_editor.keep_editing")}
                </Button>
                <Button variant="secondary" size="sm" onClick={requestSave}>
                  {t("file_library.contracts.workflow.word_editor.retry_save")}
                </Button>
                <Button variant="primary" size="sm" onClick={finishClose}>
                  {t("file_library.contracts.workflow.word_editor.close_anyway")}
                </Button>
              </div>
            </div>
          ) : null}

          <div className="flex min-h-0 flex-1">
            <div className="relative min-h-0 flex-1">
              {error ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 text-tertiary">
                  <p className="text-14">{error}</p>
                </div>
              ) : !session ? (
                <EditorSkeleton label={t("file_library.contracts.workflow.word_editor.opening")} />
              ) : (
                <>
                  {/* Hidden form: submitting it loads the editor into the iframe */}
                  <form
                    ref={formRef}
                    action={session.editor_url}
                    method="post"
                    target="collabora-frame"
                    className="hidden"
                  >
                    <input type="hidden" name="access_token" value={session.access_token} />
                    {uiDefaults ? <input type="hidden" name="ui_defaults" value={uiDefaults} /> : null}
                  </form>
                  {/* Collabora runs its own scripts and posts forms back to the WOPI
                      host, so it needs scripts + same-origin + forms; downloads and
                      popups cover export and print. */}
                  <iframe
                    ref={iframeRef}
                    name="collabora-frame"
                    title={fileName}
                    className="size-full border-0"
                    allow="clipboard-read; clipboard-write; fullscreen"
                    sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-modals allow-popups-to-escape-sandbox"
                  />
                  {saveState === "loading" ? (
                    <div className="absolute inset-0">
                      <EditorSkeleton label={t("file_library.contracts.workflow.word_editor.loading")} />
                    </div>
                  ) : null}
                </>
              )}
            </div>
            {showVariables && (
              <div className="hidden w-80 shrink-0 border-l border-subtle md:block">
                {variablesPanel ?? <ContractVariablesPanel />}
              </div>
            )}
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );

  const container = typeof document !== "undefined" ? document.getElementById("full-screen-portal") : null;
  return container ? createPortal(modal, container) : modal;
}

/** A page-shaped placeholder so the ~10 s Collabora start isn't a blank screen. */
function EditorSkeleton({ label }: { label: string }) {
  return (
    <div className="flex size-full flex-col bg-layer-1">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-subtle bg-surface-1 px-4">
        {Array.from({ length: 9 }, (_, index) => (
          <span key={index} className="h-4 w-8 animate-pulse rounded bg-layer-2" />
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden p-6">
        <div className="shadow-sm mx-auto h-full max-w-3xl rounded-sm bg-surface-1 p-12">
          <div className="space-y-3">
            {["a92", "b80", "c96", "d70", "e88", "f60", "g94", "h76", "i84", "j50"].map((line) => (
              <span
                key={line}
                className="block h-3 animate-pulse rounded bg-layer-2"
                style={{ width: `${line.slice(1)}%` }}
              />
            ))}
          </div>
          <p className="mt-10 flex items-center justify-center gap-2 text-13 text-tertiary">
            <Loader2 className="size-4 animate-spin" />
            {label}
          </p>
        </div>
      </div>
    </div>
  );
}
