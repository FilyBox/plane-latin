/**
 * Community-compatible distribution dialog based on Documenso's
 * EnvelopeDistributeDialog.
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Loader2 } from "lucide-react";
import { useTranslation } from "@plane/i18n";
import type { TContractAuthoringSettings } from "@plane/types";
import { Button } from "@plane/propel/button";
import { EModalPosition, EModalWidth, ModalCore } from "@plane/ui";
import { ContractSendSteps, type TSignatureSendProgress } from "./contract-send-progress";

type Props = {
  settings: TContractAuthoringSettings;
  validationMessage?: string;
  isSubmitting: boolean;
  /** Background send progress (useSignatureSend). Absent = the plain form. */
  progress?: TSignatureSendProgress;
  onChange: (settings: TContractAuthoringSettings) => void;
  onClose: () => void;
  /** Sends, and retries after a failure. */
  onSubmit: () => void;
};

export function ContractDistributeDialog({
  settings,
  validationMessage,
  isSubmitting,
  progress,
  onChange,
  onClose,
  onSubmit,
}: Props) {
  const { t } = useTranslation();
  const update = (patch: Partial<TContractAuthoringSettings>) => onChange({ ...settings, ...patch });
  const byEmail = settings.distributionMethod === "EMAIL";
  const phase = progress?.phase ?? "idle";
  const isSending = phase === "sending";
  const isFinished = phase === "done" || phase === "background";
  // While sending (or after) the steps replace the form; after a failure they
  // sit above it so the message can be fixed before retrying.
  const showForm = phase === "idle" || phase === "failed";
  const busy = isSubmitting || isSending;

  return (
    <ModalCore
      isOpen
      // The backdrop does not close mid-send; the Close button still does (the send continues).
      handleClose={isSending ? () => undefined : onClose}
      position={EModalPosition.CENTER}
      width={EModalWidth.MD}
    >
      <header className="px-6 pt-6 pb-3">
        <h2 className="text-16 font-semibold">{t("file_library.contracts.workflow.distribute.title")}</h2>
        <p className="mt-1 text-13 text-tertiary">{t("file_library.contracts.workflow.distribute.description")}</p>
      </header>

      {progress && phase !== "idle" ? (
        <div className="px-6">
          <ContractSendSteps
            phase={phase}
            step={progress.step}
            error={progress.error}
            className="rounded-lg border border-subtle bg-layer-1 p-4"
          />
        </div>
      ) : null}

      {showForm ? (
        <div className={phase === "failed" ? "mt-3 px-6" : "px-6"}>
          <div className="grid grid-cols-2 rounded-md bg-layer-2 p-1">
            <button
              type="button"
              className={`rounded px-3 py-2 text-13 ${byEmail ? "shadow-sm bg-surface-1" : "text-tertiary"}`}
              onClick={() => update({ distributionMethod: "EMAIL" })}
            >
              {t("file_library.contracts.workflow.distribute.email")}
            </button>
            <button
              type="button"
              className={`rounded px-3 py-2 text-13 ${!byEmail ? "shadow-sm bg-surface-1" : "text-tertiary"}`}
              onClick={() => update({ distributionMethod: "NONE" })}
            >
              {t("file_library.contracts.workflow.distribute.no_email")}
            </button>
          </div>

          <div className="mt-2 min-h-[18rem]">
            {byEmail ? (
              <fieldset disabled={busy} className="flex flex-col gap-4 pt-2">
                <label className="space-y-1.5 text-13 font-medium">
                  {t("file_library.contracts.workflow.distribute.reply_to")}{" "}
                  <span className="font-normal text-tertiary">
                    ({t("file_library.contracts.workflow.common.optional")})
                  </span>
                  <input
                    className="focus:border-accent-primary w-full rounded-md border border-subtle bg-surface-1 px-3 py-2 text-13 outline-none"
                    type="email"
                    maxLength={254}
                    value={settings.emailReplyTo}
                    onChange={(event) => update({ emailReplyTo: event.target.value })}
                  />
                </label>
                <label className="space-y-1.5 text-13 font-medium">
                  {t("file_library.contracts.workflow.distribute.subject")}{" "}
                  <span className="font-normal text-tertiary">
                    ({t("file_library.contracts.workflow.common.optional")})
                  </span>
                  <input
                    className="focus:border-accent-primary w-full rounded-md border border-subtle bg-surface-1 px-3 py-2 text-13 outline-none"
                    maxLength={254}
                    value={settings.subject}
                    onChange={(event) => update({ subject: event.target.value })}
                  />
                </label>
                <label className="space-y-1.5 text-13 font-medium">
                  {t("file_library.contracts.workflow.distribute.message")}{" "}
                  <span className="font-normal text-tertiary">
                    ({t("file_library.contracts.workflow.common.optional")})
                  </span>
                  <textarea
                    className="focus:border-accent-primary h-16 w-full resize-none rounded-md border border-subtle bg-surface-1 px-3 py-2 text-13 outline-none"
                    maxLength={5000}
                    value={settings.message}
                    onChange={(event) => update({ message: event.target.value })}
                  />
                </label>
              </fieldset>
            ) : (
              <div className="flex min-h-[16.5rem] flex-col items-center justify-center rounded-lg border border-subtle px-7 text-center text-13 text-tertiary">
                <p>{t("file_library.contracts.workflow.distribute.no_email_notice")}</p>
                <p className="mt-2">{t("file_library.contracts.workflow.distribute.links_notice")}</p>
              </div>
            )}
          </div>

          {validationMessage ? (
            <p className="mt-2 rounded-md bg-warning-primary/10 px-3 py-2 text-11 text-warning-primary">
              {validationMessage}
            </p>
          ) : null}
        </div>
      ) : null}

      <footer className="flex justify-end gap-2 px-6 py-5">
        {isFinished ? (
          <Button variant="primary" size="sm" onClick={onClose}>
            {t("file_library.contracts.workflow.common.close")}
          </Button>
        ) : isSending ? (
          <>
            <Button variant="secondary" size="sm" onClick={onClose}>
              {t("file_library.contracts.workflow.common.close")}
            </Button>
            <Button variant="primary" size="sm" disabled>
              <Loader2 className="size-3.5 animate-spin" />
              {t("file_library.contracts.workflow.send.sending")}
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" size="sm" disabled={isSubmitting} onClick={onClose}>
              {t("file_library.contracts.workflow.common.cancel")}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={isSubmitting || Boolean(validationMessage)}
              onClick={onSubmit}
            >
              {isSubmitting ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {phase === "failed"
                ? t("file_library.contracts.workflow.common.retry")
                : t(
                    byEmail
                      ? "file_library.contracts.workflow.distribute.send"
                      : "file_library.contracts.workflow.distribute.generate_links"
                  )}
            </Button>
          </>
        )}
      </footer>
    </ModalCore>
  );
}
