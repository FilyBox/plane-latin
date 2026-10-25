/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * Sending a signature request. The newer API answers right away and sends in
 * the background, reporting its step in request.metadata.send; older servers
 * send synchronously and answer with the request already PENDING.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Check, Loader2 } from "lucide-react";
import { useTranslation } from "@plane/i18n";
import type {
  TContractAuthoringRecipient,
  TContractAuthoringSettings,
  TContractSendStep,
  TContractSignatureRequest,
} from "@plane/types";
import { cn } from "@plane/utils";
import { contractService } from "@/services/contract.service";
import { contractErrorMessage, isEndpointMissing } from "./template-utils";

export type TSignatureSendPhase = "idle" | "sending" | "done" | "failed" | "background";

export type TSignatureSendProgress = {
  phase: TSignatureSendPhase;
  step?: TContractSendStep;
  error?: string;
};

type TTranslate = (key: string, params?: Record<string, unknown>) => string;

const PREFIX = "file_library.contracts.workflow";
const SEND_FAILED_KEY = `${PREFIX}.authoring.send_failed`;
const POLL_MS = 1500;
const MAX_WAIT_MS = 3 * 60 * 1000;
const MAX_POLL_ERRORS = 3;

const KNOWN_STEPS: ReadonlySet<string> = new Set<TContractSendStep>([
  "queued",
  "uploading",
  "creating",
  "distributing",
  "done",
  "failed",
]);
const SENT_STATUSES: ReadonlySet<string> = new Set(["PENDING", "COMPLETED"]);
/** Not out yet; SENDING is tolerated in case the server reports it. */
const UNSENT_STATUSES: ReadonlySet<string> = new Set(["DRAFT", "READY", "PREPARING", "SENDING"]);
const SENDING_STATUSES: ReadonlySet<string> = new Set(["PREPARING", "SENDING"]);

// request helpers

/** The background send step of a request, or undefined on older data. */
export function sendStepOf(
  request?: Pick<TContractSignatureRequest, "metadata"> | null
): TContractSendStep | undefined {
  const step = request?.metadata?.send?.step;
  return typeof step === "string" && KNOWN_STEPS.has(step) ? (step as TContractSendStep) : undefined;
}

/** PREPARING because it is being sent (not because the PDF is being generated). */
export const isSendInProgress = (request: TContractSignatureRequest) =>
  SENDING_STATUSES.has(request.status) && Boolean(request.metadata?.send) && sendStepOf(request) !== "failed";

/** The last send failed and the request never went out. */
export const hasSendFailed = (request: TContractSignatureRequest) =>
  sendStepOf(request) === "failed" && UNSENT_STATUSES.has(request.status);

/** Why the send failed, from the send state, the request error or a generic line. */
export function sendErrorMessage(t: TTranslate, request: TContractSignatureRequest): string {
  const sendError = request.metadata?.send?.error;
  if (sendError?.message?.trim()) return sendError.message.trim();
  if (sendError?.code) return contractErrorMessage(t, { error: sendError.code }, SEND_FAILED_KEY);
  if (request.error?.message?.trim()) return request.error.message.trim();
  return t(SEND_FAILED_KEY);
}

/**
 * Cancels a sent request and returns a READY copy to correct and resend.
 * Older servers lack the combined endpoint: cancel, then duplicate.
 */
export async function cancelAndDuplicateRequest(
  workspaceSlug: string,
  requestId: string
): Promise<TContractSignatureRequest> {
  try {
    return await contractService.cancelAndDuplicateSignatureRequest(workspaceSlug, requestId);
  } catch (error: unknown) {
    if (!isEndpointMissing(error)) throw error;
    await contractService.cancelSignatureRequest(workspaceSlug, requestId);
    return contractService.duplicateSignatureRequest(workspaceSlug, requestId);
  }
}

// hook

/**
 * Sends a request and follows it until it is out.
 *
 * `send` resolves with the request once it is PENDING/COMPLETED, and with
 * undefined when it failed or is still going after ~3 min ("background": the
 * server keeps sending). `step` keeps the last real step, also after a failure.
 */
export function useSignatureSend(workspaceSlug: string, requestId: string) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<TSignatureSendPhase>("idle");
  const [step, setStep] = useState<TContractSendStep>();
  const [error, setError] = useState<string>();
  // Each send gets a run number; reset/unmount bump it so stale loops stop.
  const runRef = useRef(0);
  const busyRef = useRef(false);
  const cancelWaitRef = useRef<() => void>();

  useEffect(
    () => () => {
      runRef.current += 1;
      cancelWaitRef.current?.();
    },
    []
  );

  /** Resolves true after the delay, or false if the run was stopped first. */
  const wait = (ms: number) =>
    new Promise<boolean>((resolve) => {
      const timer = window.setTimeout(() => {
        cancelWaitRef.current = undefined;
        resolve(true);
      }, ms);
      cancelWaitRef.current = () => {
        window.clearTimeout(timer);
        cancelWaitRef.current = undefined;
        resolve(false);
      };
    });

  const reset = useCallback(() => {
    runRef.current += 1;
    busyRef.current = false;
    cancelWaitRef.current?.();
    setPhase("idle");
    setStep(undefined);
    setError(undefined);
  }, []);

  const send = async (
    recipients: TContractAuthoringRecipient[],
    settings?: TContractAuthoringSettings
  ): Promise<TContractSignatureRequest | undefined> => {
    if (busyRef.current) return undefined;
    busyRef.current = true;
    const run = ++runRef.current;
    const isCurrent = () => runRef.current === run;
    setPhase("sending");
    setStep("queued");
    setError(undefined);

    const finish = (next: TSignatureSendPhase, message?: string) => {
      if (!isCurrent()) return;
      busyRef.current = false;
      setPhase(next);
      setError(message);
    };
    const track = (request: TContractSignatureRequest) => {
      const current = sendStepOf(request);
      if (current && current !== "failed" && isCurrent()) setStep(current);
    };

    const deadline = Date.now() + MAX_WAIT_MS;

    /** Checks one snapshot of the request, then waits and reads it again. */
    const follow = async (
      request: TContractSignatureRequest,
      pollErrors: number
    ): Promise<TContractSignatureRequest | undefined> => {
      if (!isCurrent()) return undefined;
      const current = sendStepOf(request);
      if (SENT_STATUSES.has(request.status) || current === "done") {
        setStep("done");
        finish("done");
        return request;
      }
      track(request);
      if (request.status === "ERROR" || current === "failed" || !UNSENT_STATUSES.has(request.status)) {
        finish("failed", sendErrorMessage(t, request));
        return undefined;
      }
      if (Date.now() >= deadline || pollErrors >= MAX_POLL_ERRORS) {
        finish("background", t(`${PREFIX}.send.background`));
        return undefined;
      }
      if (!(await wait(POLL_MS))) return undefined;
      let next: TContractSignatureRequest;
      try {
        next = await contractService.getSignatureRequest(workspaceSlug, requestId);
      } catch {
        // A failed status read does not mean the send failed; check again.
        return follow(request, pollErrors + 1);
      }
      return follow(next, 0);
    };

    let sent: TContractSignatureRequest;
    try {
      sent = await contractService.sendSignatureRequest(workspaceSlug, requestId, recipients, settings);
    } catch (sendError: unknown) {
      finish("failed", contractErrorMessage(t, sendError, SEND_FAILED_KEY));
      return undefined;
    }
    // The POST answer is checked first: older servers answer already PENDING.
    return follow(sent, 0);
  };

  return { send, phase, step, error, reset };
}

// steps

const VISIBLE_STEPS = [
  { step: "uploading", labelKey: `${PREFIX}.send.step_uploading` },
  { step: "creating", labelKey: `${PREFIX}.send.step_creating` },
  { step: "distributing", labelKey: `${PREFIX}.send.step_distributing` },
] as const;

/** Index of the active step; queued or unknown counts as the first one. */
const activeIndexOf = (step?: TContractSendStep) => {
  if (step === "done") return VISIBLE_STEPS.length;
  const index = VISIBLE_STEPS.findIndex((item) => item.step === step);
  return index === -1 ? 0 : index;
};

/** Label of the current step for compact places (list rows). */
export const sendStepLabelKey = (step?: TContractSendStep) =>
  VISIBLE_STEPS[Math.min(activeIndexOf(step), VISIBLE_STEPS.length - 1)].labelKey;

type TStepState = "pending" | "active" | "done" | "failed";

export function ContractSendSteps({ step, phase, error, className }: TSignatureSendProgress & { className?: string }) {
  const { t } = useTranslation();
  const activeIndex = phase === "done" ? VISIBLE_STEPS.length : activeIndexOf(step);
  // When the server only says "failed" we do not know which step broke.
  const knowsFailedStep = step !== undefined && step !== "failed" && step !== "queued";

  const stateOf = (index: number): TStepState => {
    if (index < activeIndex) return "done";
    if (index > activeIndex) return "pending";
    if (phase === "failed") return knowsFailedStep ? "failed" : "pending";
    return phase === "idle" ? "pending" : "active";
  };

  const message =
    phase === "failed"
      ? (error ?? t(SEND_FAILED_KEY))
      : phase === "background"
        ? (error ?? t(`${PREFIX}.send.background`))
        : phase === "done"
          ? t(`${PREFIX}.send.done`)
          : phase === "sending"
            ? t(`${PREFIX}.send.close_hint`)
            : undefined;

  return (
    <div className={cn("space-y-3", className)} aria-live="polite">
      <ol className="space-y-2" aria-label={t(`${PREFIX}.send.progress_label`)}>
        {VISIBLE_STEPS.map((item, index) => {
          const state = stateOf(index);
          return (
            <li key={item.step} className="flex items-center gap-2.5 text-13">
              <span className="grid size-5 shrink-0 place-items-center" aria-hidden>
                {state === "done" ? (
                  <Check className="size-4 text-success-primary" />
                ) : state === "active" ? (
                  <Loader2 className="size-4 animate-spin text-accent-primary" />
                ) : state === "failed" ? (
                  <AlertCircle className="size-4 text-danger-primary" />
                ) : (
                  <span className="size-3 rounded-full border border-strong" />
                )}
              </span>
              <span
                className={cn(
                  state === "pending" ? "text-tertiary" : "text-primary",
                  state === "active" && "font-medium",
                  state === "failed" && "text-danger-primary"
                )}
              >
                {t(item.labelKey)}
              </span>
            </li>
          );
        })}
      </ol>
      {message ? (
        <p
          className={cn(
            "text-12",
            phase === "failed" ? "text-danger-primary" : phase === "done" ? "text-success-primary" : "text-tertiary"
          )}
        >
          {message}
        </p>
      ) : null}
    </div>
  );
}
