/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

/* The single iframe here hosts Collabora, a trusted first-party editor that
   requires both allow-scripts and allow-same-origin (its own docs mandate this
   combination). The rule that forbids that pairing does not apply. */
/* eslint-disable react/iframe-missing-sandbox */

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { CheckCircle2, Loader2, Save, X } from "lucide-react";
// plane imports
import { useTranslation } from "@plane/i18n";
// services
import { fileLibraryService } from "@/services/file-library.service";

type Props = {
  workspaceSlug: string;
  assetId: string | null;
  fileName: string;
  onClose: () => void;
};

/**
 * Opens a document in Collabora Online.
 *
 * WOPI is form-driven: the editor is loaded by POSTing `access_token` to the
 * editor URL, targeted at an iframe. We cannot just set iframe.src, because the
 * token must travel in the POST body — so we build a real <form> and submit it
 * once the session resolves.
 */
export function CollaboraEditorModal(props: Props) {
  const { workspaceSlug, assetId, fileName, onClose } = props;
  const { t } = useTranslation();
  const formRef = useRef<HTMLFormElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [session, setSession] = useState<{ editor_url: string; access_token: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const saveTimerRef = useRef<number | undefined>(undefined);
  const closeTimerRef = useRef<number | undefined>(undefined);

  const isOpen = assetId !== null;

  const save = useCallback(() => {
    setSaveState("saving");
    iframeRef.current?.contentWindow?.postMessage(
      JSON.stringify({
        MessageId: "Action_Save",
        SendTime: Date.now(),
        Values: { DontTerminateEdit: true, DontSaveIfUnmodified: true },
      }),
      "*"
    );
    window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => setSaveState("saved"), 900);
  }, []);

  const saveAndClose = useCallback(() => {
    save();
    // Give Collabora time to flush PutFile to the WOPI host before a caller
    // immediately snapshots the variant for PDF conversion.
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = window.setTimeout(onClose, 1100);
  }, [onClose, save]);

  // `t` is a fresh function each render; kept in a ref so the fetch effect can
  // use the latest translation without listing it as a dependency — otherwise
  // the effect would re-run every render and hammer the session endpoint.
  const tRef = useRef(t);
  tRef.current = t;

  // Fetch the session whenever a new document is opened.
  useEffect(() => {
    if (!assetId) {
      setSession(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setSession(null);
    setError(null);
    setSaveState("idle");
    (async () => {
      try {
        const data = await fileLibraryService.getCollaboraSession(workspaceSlug, assetId);
        if (!cancelled) setSession({ editor_url: data.editor_url, access_token: data.access_token });
      } catch (err: any) {
        if (!cancelled) setError(err?.error ?? tRef.current("file_library.collabora.error"));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [assetId, workspaceSlug]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      let message = event.data;
      if (typeof message === "string") {
        try {
          message = JSON.parse(message);
        } catch {
          return;
        }
      }
      if (message?.MessageId === "Action_Save_Resp") {
        window.clearTimeout(saveTimerRef.current);
        setSaveState("saved");
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  useEffect(
    () => () => {
      window.clearTimeout(saveTimerRef.current);
      window.clearTimeout(closeTimerRef.current);
    },
    []
  );

  // Submit the form once the session is in and the form is on screen. The
  // browser posts the token to Collabora, which then calls our WOPI host back.
  useEffect(() => {
    if (session && formRef.current) formRef.current.submit();
  }, [session]);

  // Lock body scroll while the full-screen editor is up.
  useEffect(() => {
    if (!isOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") saveAndClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener("keydown", onKey);
    };
  }, [isOpen, saveAndClose]);

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
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-subtle px-4 py-2.5">
            <span className="truncate text-14 font-medium">{fileName}</span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={save}
                disabled={!session || saveState === "saving"}
                className="flex min-w-24 items-center justify-center gap-1.5 rounded-sm px-2 py-1.5 text-12 hover:bg-layer-1-hover disabled:cursor-not-allowed disabled:opacity-60"
              >
                {saveState === "saving" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : saveState === "saved" ? (
                  <CheckCircle2 className="size-4 text-success-primary" />
                ) : (
                  <Save className="size-4" />
                )}
                {saveState === "saving" ? "Guardando…" : saveState === "saved" ? "Guardado" : "Guardar"}
              </button>
              <button
                type="button"
                onClick={saveAndClose}
                className="rounded-sm p-1.5 hover:bg-layer-1-hover"
                title={t("close")}
                aria-label={t("close")}
              >
                <X className="size-4" />
              </button>
            </div>
          </div>

          <div className="relative min-h-0 flex-1">
            {error ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-tertiary">
                <p className="text-14">{error}</p>
              </div>
            ) : !session ? (
              <div className="flex h-full items-center justify-center text-tertiary">
                <Loader2 className="size-6 animate-spin" />
              </div>
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
              </>
            )}
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );

  const container = typeof document !== "undefined" ? document.getElementById("full-screen-portal") : null;
  return container ? createPortal(modal, container) : modal;
}
