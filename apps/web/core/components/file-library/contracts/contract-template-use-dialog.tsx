/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Braces,
  Check,
  CheckCircle2,
  Copy,
  Eye,
  FileClock,
  FilePenLine,
  Loader2,
  Save,
  Users,
  X,
} from "lucide-react";
import useSWR from "swr";
import { Button } from "@plane/propel/button";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TContractAuthoringRecipient, TContractSignatureRequest, TContractTemplateVariant } from "@plane/types";
import { EModalPosition, EModalWidth, ModalCore } from "@plane/ui";
import { contractService } from "@/services/contract.service";
import { FilePreviewModal, type TPreviewFile } from "../file-preview-modal";

type Props = {
  workspaceSlug: string;
  templateName: string;
  variant: TContractTemplateVariant;
  onEditWord: () => void;
  onClose: () => void;
  onPrepared: (request: TContractSignatureRequest) => void;
  initialRevisionId?: string;
};

type PreparedRecipient = Partial<TContractAuthoringRecipient> & { clientKey: string };

const INPUT_CLASS =
  "mt-1.5 h-9 w-full rounded-md border border-subtle bg-surface-1 px-3 text-11 text-primary outline-none focus:border-accent-primary disabled:cursor-not-allowed disabled:bg-layer-1 disabled:text-tertiary";

const roleLabel: Record<TContractAuthoringRecipient["role"], string> = {
  SIGNER: "Debe firmar",
  APPROVER: "Debe aprobar",
  ASSISTANT: "Asistente",
  VIEWER: "Solo visualiza",
  CC: "Recibe una copia",
};

const suggestedVariables = [
  "{{NombreFirmante1}}",
  "{{CorreoFirmante1}}",
  "{{FirmaFirmante1}}",
  "{{InicialesFirmante1}}",
  "{{FechaFirmaFirmante1}}",
  "{{TextoFirmante1}}",
  "{{NumeroFirmante1}}",
  "{{CasillaFirmante1}}",
  "{{ListaFirmante1}}",
  "{{CualquierDato}}",
];

export function ContractTemplateUseDialog({
  workspaceSlug,
  templateName,
  variant,
  onEditWord,
  onClose,
  onPrepared,
  initialRevisionId,
}: Props) {
  const [selectedSource, setSelectedSource] = useState(initialRevisionId ?? "CURRENT");
  const [title, setTitle] = useState(templateName);
  const [variableValues, setVariableValues] = useState<Record<string, string>>({});
  const [omittedVariableKeys, setOmittedVariableKeys] = useState<string[]>([]);
  const [recipients, setRecipients] = useState<PreparedRecipient[]>([]);
  const [copiedToken, setCopiedToken] = useState<string>();
  const [isPreparing, setIsPreparing] = useState(false);
  const [isSavingVersion, setIsSavingVersion] = useState(false);
  const [previewFile, setPreviewFile] = useState<TPreviewFile | null>(null);
  const revisionId = selectedSource === "CURRENT" ? undefined : selectedSource;
  const {
    data,
    isLoading,
    mutate: mutateSchema,
  } = useSWR(
    `CONTRACT_TEMPLATE_SCHEMA_${workspaceSlug}_${variant.id}_${selectedSource}`,
    () => contractService.getTemplateSchema(workspaceSlug, variant.id, revisionId),
    { revalidateOnFocus: false }
  );

  const selectedRevision = data?.revisions.find((revision) => revision.id === revisionId);
  const recipientBlueprint = selectedRevision?.recipient_blueprint?.length
    ? selectedRevision.recipient_blueprint
    : variant.recipient_blueprint;
  const recipientCount = useMemo(() => {
    const semanticCount = data?.schema.recipients.length
      ? Math.max(...data.schema.recipients.map((recipient) => recipient.index)) + 1
      : 0;
    return Math.max(semanticCount, recipientBlueprint.length);
  }, [data?.schema.recipients, recipientBlueprint.length]);

  const detectedTokens = useMemo(() => {
    if (!data) return [];
    const tokens = [
      ...data.schema.variables.map((variable) => `{{${variable.key}}}`),
      ...data.schema.signing_fields.map((field) => `{{${field.key}}}`),
    ];
    data.schema.recipients.forEach((recipient) => {
      if (recipient.requires_name) tokens.push(`{{NombreFirmante${recipient.index + 1}}}`);
      if (recipient.requires_email) tokens.push(`{{CorreoFirmante${recipient.index + 1}}}`);
    });
    return [...new Set(tokens)];
  }, [data]);

  useEffect(() => {
    setRecipients((current) =>
      Array.from({ length: recipientCount }, (_, index) => {
        const previous = current[index] ?? {};
        const blueprint = recipientBlueprint[index];
        return {
          ...previous,
          clientKey:
            previous.clientKey ??
            (typeof crypto !== "undefined" && "randomUUID" in crypto
              ? crypto.randomUUID()
              : `recipient-${Date.now()}-${Math.random()}`),
          placeholderLabel: blueprint?.placeholderLabel ?? `Firmante ${index + 1}`,
          role: previous.role ?? blueprint?.role ?? "SIGNER",
          signingOrder: index + 1,
          actionAuth: previous.actionAuth ?? blueprint?.actionAuth ?? [],
        };
      })
    );
  }, [recipientBlueprint, recipientCount]);

  useEffect(() => {
    const availableKeys = new Set(data?.schema.variables.map((variable) => variable.key) ?? []);
    setOmittedVariableKeys((current) => current.filter((key) => availableKeys.has(key)));
  }, [data?.schema.variables]);

  const validationMessage = useMemo(() => {
    if (!title.trim()) return "Escribe un título para el contrato.";
    for (const variable of data?.schema.variables ?? []) {
      if (!omittedVariableKeys.includes(variable.key) && variable.required && !variableValues[variable.key]?.trim())
        return `Completa ${variable.label} o desactiva la opción Aplicar.`;
    }
    for (let index = 0; index < recipientCount; index++) {
      const recipient = recipients[index];
      const label = recipient?.placeholderLabel ?? `Firmante ${index + 1}`;
      if (!recipient?.name?.trim()) return `Completa el nombre de ${label}.`;
      if (!recipient.email?.includes("@")) return `Completa un correo válido para ${label}.`;
    }
    return undefined;
  }, [data?.schema.variables, omittedVariableKeys, recipientCount, recipients, title, variableValues]);

  const copyVariable = async (token: string) => {
    await navigator.clipboard.writeText(token);
    setCopiedToken(token);
    window.setTimeout(() => setCopiedToken((current) => (current === token ? undefined : current)), 1600);
  };

  const saveCurrentVersion = async () => {
    setIsSavingVersion(true);
    try {
      const revision = await contractService.saveTemplateRevision(workspaceSlug, variant.id);
      await mutateSchema();
      setSelectedSource(revision.id);
      setToast({ type: TOAST_TYPE.SUCCESS, title: `Versión ${revision.revision} guardada` });
    } catch (error: any) {
      setToast({ type: TOAST_TYPE.ERROR, title: error?.error ?? "No se pudo guardar la versión" });
    } finally {
      setIsSavingVersion(false);
    }
  };

  const prepare = async () => {
    if (validationMessage) return;
    setIsPreparing(true);
    try {
      const request = await contractService.prepareSignatureRequest(workspaceSlug, {
        variant_id: variant.id,
        revision_id: revisionId,
        title: title.trim(),
        variable_values: variableValues,
        omitted_variable_keys: omittedVariableKeys,
        recipients,
      });
      onPrepared(request);
    } catch (error: any) {
      setToast({ type: TOAST_TYPE.ERROR, title: error?.error ?? "No se pudo preparar el contrato" });
    } finally {
      setIsPreparing(false);
    }
  };

  return (
    <>
      <ModalCore
        isOpen
        handleClose={onClose}
        position={EModalPosition.CENTER}
        width={EModalWidth.XXXXL}
        className="flex max-h-[92vh] flex-col overflow-hidden"
      >
        <header className="flex items-start justify-between border-b border-subtle px-5 py-4 sm:px-6">
          <div>
            <h2 className="text-15 font-semibold text-primary">Usar {templateName}</h2>
            <p className="mt-1 text-11 text-tertiary">
              Selecciona la versión, decide qué variables aplicar y revisa los campos.
            </p>
          </div>
          <button
            type="button"
            className="grid size-8 place-items-center rounded-md hover:bg-layer-1-hover"
            onClick={onClose}
          >
            <X className="size-4" />
          </button>
        </header>

        <div className="flex items-center gap-2 border-b border-subtle bg-layer-1 px-5 py-2.5 text-10 text-tertiary sm:px-6">
          <span className="font-medium text-primary">1. Versión</span>
          <span>→</span>
          <span className="font-medium text-primary">2. Datos y firmantes</span>
          <span>→</span>
          <span>3. Revisar campos y enviar</span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
            <div className="min-w-0 space-y-5">
              <section className="rounded-lg border border-subtle p-4">
                <div className="flex items-center gap-2">
                  <FileClock className="size-4 text-accent-primary" />
                  <h3 className="text-12 font-semibold text-primary">Versión del documento</h3>
                </div>
                <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                  <select
                    className="focus:border-accent-primary h-9 min-w-0 flex-1 rounded-md border border-subtle bg-surface-1 px-3 text-11 text-primary outline-none"
                    value={selectedSource}
                    onChange={(event) => setSelectedSource(event.target.value)}
                  >
                    <option value="CURRENT">Word actual · últimos cambios guardados</option>
                    {(data?.revisions ?? []).map((revision) => (
                      <option key={revision.id} value={revision.id}>
                        Versión {revision.revision} · {new Date(revision.created_at).toLocaleString()}
                      </option>
                    ))}
                  </select>
                  <Button
                    variant="secondary"
                    size="lg"
                    onClick={() =>
                      setPreviewFile({
                        assetId: selectedRevision?.source_asset_id ?? variant.source_asset_id,
                        name:
                          selectedRevision != null
                            ? `${templateName} · versión ${selectedRevision.revision}.docx`
                            : variant.source_file_name,
                        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                      })
                    }
                  >
                    <Eye className="size-4" /> Vista previa
                  </Button>
                  {selectedSource === "CURRENT" ? (
                    <Button
                      variant="secondary"
                      size="lg"
                      disabled={isSavingVersion}
                      onClick={() => void saveCurrentVersion()}
                    >
                      {isSavingVersion ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                      Guardar versión
                    </Button>
                  ) : null}
                </div>
                {data?.manual_fields_status === "REQUIRES_REVIEW" ? (
                  <div className="mt-3 flex gap-2 rounded-md bg-warning-primary/10 p-3 text-10 text-warning-primary">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                    El Word cambió. Los campos manuales deben revisarse; las variables se recalcularán automáticamente.
                  </div>
                ) : data?.manual_fields_status === "COMPATIBLE" ? (
                  <div className="mt-3 flex gap-2 rounded-md bg-success-primary/10 p-3 text-10 text-success-primary">
                    <CheckCircle2 className="size-4 shrink-0" /> Esta versión conserva su configuración de campos.
                  </div>
                ) : null}
              </section>

              <label className="block text-11 font-medium text-secondary">
                Título del contrato
                <input className={INPUT_CLASS} value={title} onChange={(event) => setTitle(event.target.value)} />
              </label>

              {isLoading ? (
                <div className="grid min-h-40 place-items-center">
                  <Loader2 className="size-5 animate-spin text-tertiary" />
                </div>
              ) : null}

              {recipientCount > 0 ? (
                <section>
                  <div className="flex items-center gap-2">
                    <Users className="size-4 text-accent-primary" />
                    <h3 className="text-12 font-semibold text-primary">Personas del contrato</h3>
                  </div>
                  <p className="mt-1 text-10 text-tertiary">
                    Se detectaron por los marcadores y campos guardados de la plantilla.
                  </p>
                  <div className="mt-3 space-y-3">
                    {recipients.map((recipient, index) => (
                      <div key={recipient.clientKey} className="rounded-lg border border-subtle p-4">
                        <div className="mb-3 flex items-center justify-between gap-2">
                          <p className="text-11 font-semibold text-primary">
                            {recipient.placeholderLabel ?? `Firmante ${index + 1}`}
                          </p>
                          <span className="rounded-full bg-layer-2 px-2 py-1 text-9 text-tertiary">
                            {roleLabel[recipient.role ?? "SIGNER"]}
                          </span>
                        </div>
                        <div className="grid gap-3 sm:grid-cols-2">
                          <label className="text-10 font-medium text-secondary">
                            Nombre
                            <input
                              className={INPUT_CLASS}
                              value={recipient.name ?? ""}
                              onChange={(event) =>
                                setRecipients((current) =>
                                  current.map((item, itemIndex) =>
                                    itemIndex === index ? { ...item, name: event.target.value } : item
                                  )
                                )
                              }
                            />
                          </label>
                          <label className="text-10 font-medium text-secondary">
                            Correo
                            <input
                              className={INPUT_CLASS}
                              type="email"
                              value={recipient.email ?? ""}
                              onChange={(event) =>
                                setRecipients((current) =>
                                  current.map((item, itemIndex) =>
                                    itemIndex === index ? { ...item, email: event.target.value } : item
                                  )
                                )
                              }
                            />
                          </label>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}

              {(data?.schema.variables ?? []).length > 0 ? (
                <section>
                  <div className="flex items-center gap-2">
                    <Braces className="size-4 text-accent-primary" />
                    <h3 className="text-12 font-semibold text-primary">Datos del documento</h3>
                  </div>
                  <p className="mt-1 text-10 text-tertiary">
                    Desactiva “Aplicar” si quieres eliminar una variable de este contrato sin modificar la plantilla.
                  </p>
                  <div className="mt-3 space-y-2">
                    {data?.schema.variables.map((variable) => {
                      const enabled = !omittedVariableKeys.includes(variable.key);
                      return (
                        <div
                          key={variable.key}
                          className="grid gap-3 rounded-lg border border-subtle p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end"
                        >
                          <label className="text-10 font-medium text-secondary">
                            {variable.label}
                            <input
                              className={INPUT_CLASS}
                              type={variable.type}
                              disabled={!enabled}
                              value={variableValues[variable.key] ?? ""}
                              onChange={(event) =>
                                setVariableValues((current) => ({ ...current, [variable.key]: event.target.value }))
                              }
                            />
                            <span className="font-normal mt-1 block text-tertiary">
                              {`{{${variable.key}}}`}
                              {variable.occurrences > 1 ? ` · aparece ${variable.occurrences} veces` : ""}
                            </span>
                          </label>
                          <label className="flex h-9 cursor-pointer items-center gap-2 rounded-md border border-subtle px-3 text-10 text-secondary hover:bg-layer-1-hover">
                            <input
                              type="checkbox"
                              checked={enabled}
                              onChange={(event) =>
                                setOmittedVariableKeys((current) =>
                                  event.target.checked
                                    ? current.filter((key) => key !== variable.key)
                                    : [...current, variable.key]
                                )
                              }
                            />
                            Aplicar
                          </label>
                        </div>
                      );
                    })}
                  </div>
                </section>
              ) : null}
            </div>

            <aside className="h-fit overflow-hidden rounded-lg border border-subtle lg:sticky lg:top-0">
              <div className="border-b border-subtle p-4">
                <h3 className="text-11 font-semibold text-primary">Variables de esta versión</h3>
                <p className="mt-1 text-10 leading-4 text-tertiary">
                  Estas son las variables que Plane encontró en el Word seleccionado.
                </p>
                {data ? (
                  <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                    <div className="rounded-md bg-layer-1 p-2">
                      <strong className="block text-12 text-primary">{data.schema.variables.length}</strong>
                      <span className="text-9 text-tertiary">datos</span>
                    </div>
                    <div className="rounded-md bg-layer-1 p-2">
                      <strong className="block text-12 text-primary">{recipientCount}</strong>
                      <span className="text-9 text-tertiary">personas</span>
                    </div>
                    <div className="rounded-md bg-layer-1 p-2">
                      <strong className="block text-12 text-primary">
                        {data.schema.signing_fields.length + data.manual_field_count}
                      </strong>
                      <span className="text-9 text-tertiary">campos</span>
                    </div>
                  </div>
                ) : null}
              </div>

              <div className="max-h-52 space-y-1 overflow-y-auto p-3">
                {detectedTokens.length ? (
                  detectedTokens.map((token) => (
                    <button
                      key={token}
                      type="button"
                      className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-10 hover:bg-layer-1-hover"
                      onClick={() => void copyVariable(token)}
                    >
                      <code className="truncate">{token}</code>
                      {copiedToken === token ? (
                        <Check className="size-3.5 text-success-primary" />
                      ) : (
                        <Copy className="size-3.5 text-tertiary" />
                      )}
                    </button>
                  ))
                ) : !isLoading ? (
                  <div className="px-2 py-5 text-center text-10 text-tertiary">
                    No hay marcadores semánticos en esta versión. Los campos guardados seguirán cargándose y puedes
                    agregar variables desde Word.
                  </div>
                ) : null}
              </div>

              <div className="border-t border-subtle p-3">
                <Button variant="secondary" size="lg" className="w-full" onClick={onEditWord}>
                  <FilePenLine className="size-4" /> Editar variables en Word
                </Button>
                <p className="mt-2 text-9 leading-4 text-tertiary">
                  Al cerrar Word volverás aquí y Plane detectará los cambios.
                </p>
              </div>

              <details className="border-t border-subtle p-3">
                <summary className="cursor-pointer text-10 font-medium text-secondary">
                  Variables que puedes agregar
                </summary>
                <div className="mt-2 space-y-1">
                  {suggestedVariables.map((token) => (
                    <button
                      key={token}
                      type="button"
                      className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-9 hover:bg-layer-1-hover"
                      onClick={() => void copyVariable(token)}
                    >
                      <code>{token}</code>
                      <Copy className="size-3 text-tertiary" />
                    </button>
                  ))}
                </div>
              </details>
            </aside>
          </div>
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-subtle px-5 py-4 sm:px-6">
          <p className="min-w-0 text-10 text-warning-primary">{validationMessage}</p>
          <div className="ml-auto flex gap-2">
            <Button variant="secondary" size="lg" disabled={isPreparing} onClick={onClose}>
              Cancelar
            </Button>
            <Button
              variant="primary"
              size="lg"
              disabled={isPreparing || isLoading || Boolean(validationMessage)}
              onClick={() => void prepare()}
            >
              {isPreparing ? <Loader2 className="size-4 animate-spin" /> : null}
              Preparar y revisar campos
            </Button>
          </div>
        </footer>
      </ModalCore>
      <FilePreviewModal
        workspaceSlug={workspaceSlug}
        file={previewFile}
        onClose={() => setPreviewFile(null)}
        scope="contract"
        readOnly
      />
    </>
  );
}
