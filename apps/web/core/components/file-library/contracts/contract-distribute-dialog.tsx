/**
 * Community-compatible distribution dialog based on Documenso's
 * EnvelopeDistributeDialog.
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Loader2 } from "lucide-react";
import type { TContractAuthoringSettings } from "@plane/types";
import { Button } from "@plane/propel/button";
import { EModalPosition, EModalWidth, ModalCore } from "@plane/ui";

type Props = {
  settings: TContractAuthoringSettings;
  validationMessage?: string;
  isSubmitting: boolean;
  onChange: (settings: TContractAuthoringSettings) => void;
  onClose: () => void;
  onSubmit: () => void;
};

export function ContractDistributeDialog({
  settings,
  validationMessage,
  isSubmitting,
  onChange,
  onClose,
  onSubmit,
}: Props) {
  const update = (patch: Partial<TContractAuthoringSettings>) => onChange({ ...settings, ...patch });
  const byEmail = settings.distributionMethod === "EMAIL";

  return (
    <ModalCore isOpen handleClose={onClose} position={EModalPosition.CENTER} width={EModalWidth.MD}>
      <header className="px-6 pt-6 pb-3">
        <h2 className="text-16 font-semibold">Enviar documento</h2>
        <p className="mt-1 text-12 text-tertiary">Los destinatarios podrán firmar el documento una vez enviado.</p>
      </header>

      <div className="px-6">
        <div className="grid grid-cols-2 rounded-md bg-layer-2 p-1">
          <button
            type="button"
            className={`rounded px-3 py-2 text-12 ${byEmail ? "shadow-sm bg-surface-1" : "text-tertiary"}`}
            onClick={() => update({ distributionMethod: "EMAIL" })}
          >
            Correo
          </button>
          <button
            type="button"
            className={`rounded px-3 py-2 text-12 ${!byEmail ? "shadow-sm bg-surface-1" : "text-tertiary"}`}
            onClick={() => update({ distributionMethod: "NONE" })}
          >
            Sin correo
          </button>
        </div>

        <div className="mt-2 min-h-[18rem]">
          {byEmail ? (
            <fieldset disabled={isSubmitting} className="flex flex-col gap-4 pt-2">
              <label className="space-y-1.5 text-11 font-medium">
                Responder a <span className="font-normal text-tertiary">(Opcional)</span>
                <input
                  className="focus:border-accent-primary w-full rounded-md border border-subtle bg-surface-1 px-3 py-2 text-12 outline-none"
                  type="email"
                  maxLength={254}
                  value={settings.emailReplyTo}
                  onChange={(event) => update({ emailReplyTo: event.target.value })}
                />
              </label>
              <label className="space-y-1.5 text-11 font-medium">
                Asunto <span className="font-normal text-tertiary">(Opcional)</span>
                <input
                  className="focus:border-accent-primary w-full rounded-md border border-subtle bg-surface-1 px-3 py-2 text-12 outline-none"
                  maxLength={254}
                  value={settings.subject}
                  onChange={(event) => update({ subject: event.target.value })}
                />
              </label>
              <label className="space-y-1.5 text-11 font-medium">
                Mensaje <span className="font-normal text-tertiary">(Opcional)</span>
                <textarea
                  className="focus:border-accent-primary h-16 w-full resize-none rounded-md border border-subtle bg-surface-1 px-3 py-2 text-12 outline-none"
                  maxLength={5000}
                  value={settings.message}
                  onChange={(event) => update({ message: event.target.value })}
                />
              </label>
            </fieldset>
          ) : (
            <div className="flex min-h-[16.5rem] flex-col items-center justify-center rounded-lg border border-subtle px-7 text-center text-12 text-tertiary">
              <p>No enviaremos ninguna notificación a los destinatarios.</p>
              <p className="mt-2">
                Generaremos enlaces de firma individuales para que puedas enviarlos por el medio que prefieras.
              </p>
            </div>
          )}
        </div>

        {validationMessage ? (
          <p className="mt-2 rounded-md bg-warning-primary/10 px-3 py-2 text-10 text-warning-primary">
            {validationMessage}
          </p>
        ) : null}
      </div>

      <footer className="flex justify-end gap-2 px-6 py-5">
        <Button variant="secondary" size="sm" disabled={isSubmitting} onClick={onClose}>
          Cancelar
        </Button>
        <Button variant="primary" size="sm" disabled={isSubmitting || Boolean(validationMessage)} onClick={onSubmit}>
          {isSubmitting ? <Loader2 className="size-3.5 animate-spin" /> : null}
          {byEmail ? "Enviar" : "Generar enlaces"}
        </Button>
      </footer>
    </ModalCore>
  );
}
