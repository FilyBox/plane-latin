/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  Braces,
  CheckCircle2,
  CopyPlus,
  Eye,
  FilePenLine,
  FileText,
  Loader2,
  Maximize2,
  Plus,
  Save,
  Send,
  Settings2,
  Trash2,
} from "lucide-react";
import { Link, useNavigate, useSearchParams } from "react-router";
import useSWR from "swr";
import { Button } from "@plane/propel/button";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TContractSignatureRequest, TContractTemplateRevision, TContractTemplateVariant } from "@plane/types";
import { AlertModalCore, EModalPosition, EModalWidth, ModalCore } from "@plane/ui";
import { contractService } from "@/services/contract.service";
import { CollaboraEditorModal } from "../collabora-editor-modal";
import { FilePreviewModal, type TPreviewFile } from "../file-preview-modal";
import { ContractAssetPreview } from "./contract-asset-preview";
import { ContractAuthoringModal } from "./contract-authoring-modal";
import { ContractTemplateUseDialog } from "./contract-template-use-dialog";

type Props = { workspaceSlug: string; templateId: string };
type UseSelection = { variant: TContractTemplateVariant; revisionId?: string };

const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const STATUS_LABELS: Record<TContractSignatureRequest["status"], string> = {
  DRAFT: "Borrador",
  PREPARING: "Preparando",
  READY: "Listo para revisar",
  PENDING: "Pendiente de firmas",
  COMPLETED: "Firmado",
  REJECTED: "Rechazado",
  CANCELLED: "Cancelado",
  ERROR: "Error",
};

export function ContractTemplateDetail({ workspaceSlug, templateId }: Props) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const {
    data: template,
    mutate: mutateTemplate,
    isLoading,
  } = useSWR(
    `CONTRACT_TEMPLATE_${workspaceSlug}_${templateId}`,
    () => contractService.getTemplate(workspaceSlug, templateId),
    { revalidateOnFocus: false }
  );
  const { data: requests, mutate: mutateRequests } = useSWR(
    `CONTRACT_SIGNATURE_REQUESTS_${workspaceSlug}`,
    () => contractService.getSignatureRequests(workspaceSlug),
    { revalidateOnFocus: false }
  );
  const [selectedVariantId, setSelectedVariantId] = useState<string>();
  const selectedVariant =
    template?.variants.find((variant) => variant.id === selectedVariantId) ?? template?.variants[0];
  const {
    data: schema,
    mutate: mutateSchema,
    isLoading: isSchemaLoading,
  } = useSWR(
    selectedVariant ? `CONTRACT_TEMPLATE_SCHEMA_${workspaceSlug}_${selectedVariant.id}_CURRENT` : null,
    () => contractService.getTemplateSchema(workspaceSlug, selectedVariant!.id),
    { revalidateOnFocus: false }
  );
  const [previewFile, setPreviewFile] = useState<TPreviewFile | null>(null);
  const [selectedVersionId, setSelectedVersionId] = useState("CURRENT");
  const [editingVariant, setEditingVariant] = useState<TContractTemplateVariant>();
  const [usingSelection, setUsingSelection] = useState<UseSelection>();
  const [authoringRequest, setAuthoringRequest] = useState<TContractSignatureRequest>();
  const [variantDraft, setVariantDraft] = useState("");
  const [variantModalOpen, setVariantModalOpen] = useState(false);
  const [isCreatingVariant, setIsCreatingVariant] = useState(false);
  const [isSavingVersion, setIsSavingVersion] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    if (!selectedVariantId && template?.variants[0]) setSelectedVariantId(template.variants[0].id);
  }, [selectedVariantId, template]);

  useEffect(() => {
    setSelectedVersionId("CURRENT");
  }, [selectedVariant?.id]);

  useEffect(() => {
    if (searchParams.get("edit") !== "1" || !selectedVariant) return;
    setEditingVariant(selectedVariant);
    setSearchParams({}, { replace: true });
  }, [searchParams, selectedVariant, setSearchParams]);

  const templateRequests = useMemo(
    () =>
      (requests ?? []).filter((request) =>
        template?.variants.some((variant) => variant.id === request.revision.variant_id)
      ),
    [requests, template]
  );

  const createVariant = async () => {
    if (!template || !selectedVariant || !variantDraft.trim()) return;
    setIsCreatingVariant(true);
    try {
      const updated = await contractService.createVariant(workspaceSlug, template.id, {
        name: variantDraft.trim(),
        source_variant_id: selectedVariant.id,
      });
      await mutateTemplate(updated, { revalidate: true });
      setVariantModalOpen(false);
      setVariantDraft("");
      setSelectedVariantId(updated.variants.at(-1)?.id);
      setToast({ type: TOAST_TYPE.SUCCESS, title: "Variante creada" });
    } catch (error: any) {
      setToast({ type: TOAST_TYPE.ERROR, title: error?.error ?? "No se pudo crear la variante" });
    } finally {
      setIsCreatingVariant(false);
    }
  };

  const saveVersion = async () => {
    if (!selectedVariant) return;
    setIsSavingVersion(true);
    try {
      const revision = await contractService.saveTemplateRevision(workspaceSlug, selectedVariant.id);
      await Promise.all([mutateTemplate(), mutateSchema()]);
      setSelectedVersionId(revision.id);
      setToast({ type: TOAST_TYPE.SUCCESS, title: "Nueva versión guardada" });
    } catch (error: any) {
      setToast({ type: TOAST_TYPE.ERROR, title: error?.error ?? "No se pudo guardar la versión" });
    } finally {
      setIsSavingVersion(false);
    }
  };

  const configureFields = async () => {
    if (!selectedVariant || !template) return;
    try {
      const request = await contractService.prepareSignatureRequest(workspaceSlug, {
        variant_id: selectedVariant.id,
        title: `${template.name} · configuración`,
        authoring_mode: "TEMPLATE",
      });
      setAuthoringRequest(request);
    } catch (error: any) {
      setToast({ type: TOAST_TYPE.ERROR, title: error?.error ?? "No se pudo abrir la configuración" });
    }
  };

  const deleteTemplate = async () => {
    if (!template) return;
    setIsDeleting(true);
    try {
      await contractService.deleteTemplate(workspaceSlug, template.id);
      setToast({ type: TOAST_TYPE.SUCCESS, title: "Plantilla eliminada de la biblioteca" });
      navigate(`/${workspaceSlug}/file-library/contracts/templates`);
    } catch (error: any) {
      setToast({ type: TOAST_TYPE.ERROR, title: error?.error ?? "No se pudo eliminar la plantilla" });
    } finally {
      setIsDeleting(false);
    }
  };

  const selectedRevision = schema?.revisions.find((revision) => revision.id === selectedVersionId);
  const selectedAsset = selectedRevision
    ? {
        assetId: selectedRevision.pdf_asset_id,
        name: `${template?.name ?? "Contrato"} · versión ${selectedRevision.revision}.pdf`,
        contentType: "application/pdf" as const,
      }
    : selectedVariant
      ? {
          assetId: selectedVariant.source_asset_id,
          name: selectedVariant.source_file_name,
          contentType: DOCX_TYPE,
        }
      : undefined;

  const previewRevision = (revision: TContractTemplateRevision, kind: "word" | "pdf") =>
    setPreviewFile({
      assetId: kind === "word" ? revision.source_asset_id : revision.pdf_asset_id,
      name: `${template?.name ?? "Contrato"} · v${revision.revision}.${kind === "word" ? "docx" : "pdf"}`,
      contentType: kind === "word" ? DOCX_TYPE : "application/pdf",
    });

  if (isLoading || !template)
    return (
      <div className="grid h-full place-items-center">
        <Loader2 className="size-5 animate-spin text-tertiary" />
      </div>
    );

  return (
    <div className="h-full overflow-y-auto bg-surface-1">
      <div className="w-full space-y-6 px-4 py-5 sm:px-5 lg:px-6">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <Link
              to={`/${workspaceSlug}/file-library/contracts/templates`}
              className="mb-2 inline-flex items-center gap-1 text-10 text-tertiary hover:text-primary"
            >
              <ArrowLeft className="size-3.5" /> Plantillas
            </Link>
            <h1 className="truncate text-20 font-semibold text-primary">{template.name}</h1>
            <p className="mt-1 text-12 text-secondary">
              {template.description || "Administra variantes, versiones y contratos creados."}
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            {template.variants.length > 1 ? (
              <label className="text-9 font-medium text-tertiary">
                Variante
                <select
                  value={selectedVariant?.id ?? ""}
                  onChange={(event) => setSelectedVariantId(event.target.value)}
                  className="focus:border-accent-primary mt-1 block h-9 min-w-44 rounded-md border border-subtle bg-surface-1 px-3 text-11 font-medium text-primary outline-none"
                >
                  {template.variants.map((variant) => (
                    <option key={variant.id} value={variant.id}>
                      {variant.name} · {variant.revision_count} versiones
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <Button variant="secondary" size="lg" onClick={() => setDeleteOpen(true)}>
              <Trash2 className="size-4" /> Eliminar
            </Button>
            <Button variant="primary" size="lg" onClick={() => setVariantModalOpen(true)}>
              <CopyPlus className="size-4" /> Nueva variante
            </Button>
          </div>
        </header>

        <section className="min-w-0">
          {selectedVariant ? (
            <div className="min-w-0 space-y-5">
              <section className="overflow-hidden rounded-lg border border-subtle bg-surface-1">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-subtle px-4 py-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="grid size-9 shrink-0 place-items-center rounded-md bg-accent-primary/10 text-accent-primary">
                      <FileText className="size-4" />
                    </span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <h2 className="truncate text-13 font-semibold text-primary">
                          {selectedRevision ? `Versión ${selectedRevision.revision}` : "Documento actual"}
                        </h2>
                        {!selectedRevision ? (
                          <span className="rounded-full bg-accent-primary/10 px-2 py-0.5 text-9 font-medium text-accent-primary">
                            Editable
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-0.5 truncate text-10 text-tertiary">{selectedAsset?.name}</p>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="secondary"
                      size="lg"
                      disabled={!selectedAsset}
                      onClick={() => selectedAsset && setPreviewFile(selectedAsset)}
                    >
                      <Maximize2 className="size-4" /> Ampliar
                    </Button>
                    {selectedRevision ? (
                      <Button
                        variant="secondary"
                        size="lg"
                        onClick={() =>
                          setPreviewFile({
                            assetId: selectedRevision.source_asset_id,
                            name: `${template.name} · versión ${selectedRevision.revision}.docx`,
                            contentType: DOCX_TYPE,
                          })
                        }
                      >
                        <Eye className="size-4" /> Ver Word
                      </Button>
                    ) : null}
                    <Button variant="secondary" size="lg" onClick={() => setEditingVariant(selectedVariant)}>
                      <FilePenLine className="size-4" /> Editar Word
                    </Button>
                    <Button variant="secondary" size="lg" disabled={isSavingVersion} onClick={() => void saveVersion()}>
                      {isSavingVersion ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                      {isSavingVersion ? "Guardando…" : "Guardar versión"}
                    </Button>
                  </div>
                </div>

                <div className="grid min-h-[620px] xl:grid-cols-[minmax(0,1fr)_18rem]">
                  <div className="min-h-[620px] bg-layer-1 p-3 sm:p-4">
                    {selectedAsset ? (
                      <ContractAssetPreview
                        key={selectedAsset.assetId}
                        workspaceSlug={workspaceSlug}
                        assetId={selectedAsset.assetId}
                        fileName={selectedAsset.name}
                        contentType={selectedAsset.contentType}
                        className="shadow-sm h-[min(68vh,760px)] min-h-[580px] overflow-hidden rounded-md border border-subtle bg-surface-1"
                      />
                    ) : (
                      <div className="grid h-full place-items-center">
                        <Loader2 className="size-5 animate-spin text-tertiary" />
                      </div>
                    )}
                  </div>

                  <aside className="flex min-h-0 flex-col border-t border-subtle xl:border-t-0 xl:border-l">
                    <div className="border-b border-subtle px-3 py-3">
                      <p className="text-11 font-semibold text-primary">Elige una versión</p>
                      <p className="mt-0.5 text-9 text-tertiary">La vista grande cambia al seleccionarla.</p>
                    </div>
                    <div className="max-h-[min(68vh,760px)] space-y-2 overflow-y-auto p-2.5">
                      <ContractVersionCard
                        isSelected={selectedVersionId === "CURRENT"}
                        title="Documento actual"
                        subtitle="Editable · últimos cambios"
                        thumbnailUrl={contractService.getContractAssetThumbnailUrl(
                          workspaceSlug,
                          selectedVariant.source_asset_id,
                          selectedVariant.updated_at
                        )}
                        onSelect={() => setSelectedVersionId("CURRENT")}
                      />
                      {isSchemaLoading ? (
                        <div className="grid min-h-24 place-items-center">
                          <Loader2 className="size-4 animate-spin text-tertiary" />
                        </div>
                      ) : null}
                      {schema?.revisions.map((revision) => (
                        <ContractVersionCard
                          key={revision.id}
                          isSelected={selectedVersionId === revision.id}
                          title={`Versión ${revision.revision}`}
                          subtitle={new Date(revision.created_at).toLocaleString()}
                          meta={`${revision.variable_schema?.placeholder_count ?? 0} variables · ${revision.signature_blueprint.length} campos`}
                          thumbnailUrl={contractService.getContractAssetThumbnailUrl(
                            workspaceSlug,
                            revision.pdf_asset_id,
                            revision.content_sha256
                          )}
                          onSelect={() => setSelectedVersionId(revision.id)}
                        />
                      ))}
                      {!isSchemaLoading && (schema?.revisions.length ?? 0) === 0 ? (
                        <p className="rounded-md border border-dashed border-subtle p-3 text-center text-9 text-tertiary">
                          Guarda una versión para conservar un punto inmutable.
                        </p>
                      ) : null}
                    </div>
                  </aside>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-subtle p-4">
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-10 text-tertiary">
                    <span className="flex items-center gap-1.5">
                      <Braces className="size-3.5" />
                      {selectedRevision?.variable_schema?.placeholder_count ??
                        schema?.schema.placeholder_count ??
                        0}{" "}
                      variables
                    </span>
                    <span>
                      {selectedRevision?.signature_blueprint.length ?? selectedVariant.signature_blueprint.length}{" "}
                      campos
                    </span>
                    <span>
                      {selectedRevision?.recipient_blueprint.length ?? selectedVariant.recipient_blueprint.length}{" "}
                      participantes
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="secondary" size="lg" onClick={() => void configureFields()}>
                      <Settings2 className="size-4" /> Configurar documento actual
                    </Button>
                    <Button
                      variant="primary"
                      size="lg"
                      onClick={() => setUsingSelection({ variant: selectedVariant, revisionId: selectedRevision?.id })}
                    >
                      <Send className="size-4" />
                      {selectedRevision ? `Usar versión ${selectedRevision.revision}` : "Usar documento actual"}
                    </Button>
                  </div>
                </div>
              </section>

              <section className="hidden" aria-hidden="true">
                <div className="flex flex-wrap items-start justify-between gap-3 border-b border-subtle p-4">
                  <div className="flex min-w-0 gap-3">
                    <span className="grid size-9 shrink-0 place-items-center rounded-md bg-accent-primary/10 text-accent-primary">
                      <FileText className="size-4" />
                    </span>
                    <div className="min-w-0">
                      <h2 className="truncate text-13 font-semibold text-primary">Documento de trabajo</h2>
                      <p className="mt-0.5 truncate text-10 text-tertiary">{selectedVariant.source_file_name}</p>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="secondary"
                      size="lg"
                      onClick={() =>
                        setPreviewFile({
                          assetId: selectedVariant.source_asset_id,
                          name: selectedVariant.source_file_name,
                          contentType: DOCX_TYPE,
                        })
                      }
                    >
                      <Eye className="size-4" /> Vista previa
                    </Button>
                    <Button variant="secondary" size="lg" onClick={() => setEditingVariant(selectedVariant)}>
                      <FilePenLine className="size-4" /> Editar Word
                    </Button>
                    <Button variant="secondary" size="lg" disabled={isSavingVersion} onClick={() => void saveVersion()}>
                      {isSavingVersion ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}{" "}
                      {isSavingVersion ? "Guardando…" : "Guardar versión"}
                    </Button>
                  </div>
                </div>
                <div className="grid gap-3 p-4 sm:grid-cols-3">
                  <div className="rounded-md bg-layer-1 p-3">
                    <Braces className="size-4 text-accent-primary" />
                    <p className="mt-2 text-12 font-medium text-primary">
                      {schema?.schema.placeholder_count ?? 0} variables
                    </p>
                    <p className="mt-0.5 text-9 text-tertiary">Detectadas en el Word actual</p>
                  </div>
                  <div className="rounded-md bg-layer-1 p-3">
                    <Settings2 className="size-4 text-accent-primary" />
                    <p className="mt-2 text-12 font-medium text-primary">
                      {selectedVariant.signature_blueprint.length} campos
                    </p>
                    <p className="mt-0.5 text-9 text-tertiary">Campos de firma configurados</p>
                  </div>
                  <div className="rounded-md bg-layer-1 p-3">
                    <Send className="size-4 text-accent-primary" />
                    <p className="mt-2 text-12 font-medium text-primary">
                      {selectedVariant.recipient_blueprint.length} participantes
                    </p>
                    <p className="mt-0.5 text-9 text-tertiary">Roles reutilizables</p>
                  </div>
                </div>
                <div className="flex flex-wrap justify-end gap-2 border-t border-subtle p-4">
                  <Button variant="secondary" size="lg" onClick={() => void configureFields()}>
                    <Settings2 className="size-4" /> Configurar campos
                  </Button>
                  <Button variant="primary" size="lg" onClick={() => setUsingSelection({ variant: selectedVariant })}>
                    <Send className="size-4" /> Usar versión actual
                  </Button>
                </div>
              </section>

              <section className="hidden" aria-hidden="true">
                <div className="border-b border-subtle px-4 py-3">
                  <h2 className="text-13 font-semibold text-primary">Versiones guardadas</h2>
                  <p className="mt-0.5 text-10 text-tertiary">Previsualiza el Word o el PDF exacto antes de elegir.</p>
                </div>
                {isSchemaLoading ? (
                  <div className="grid min-h-28 place-items-center">
                    <Loader2 className="size-4 animate-spin text-tertiary" />
                  </div>
                ) : (schema?.revisions ?? []).length === 0 ? (
                  <div className="px-4 py-8 text-center text-11 text-tertiary">
                    Guarda la primera versión para crear un punto inmutable.
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[700px] text-left">
                      <thead className="bg-layer-1 text-10 text-tertiary">
                        <tr>
                          <th className="px-4 py-2.5">Versión</th>
                          <th className="px-4 py-2.5">Variables</th>
                          <th className="px-4 py-2.5">Campos</th>
                          <th className="px-4 py-2.5">Fecha</th>
                          <th className="px-4 py-2.5 text-right">Acciones</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-subtle">
                        {schema?.revisions.map((revision) => (
                          <tr key={revision.id} className="hover:bg-layer-1-hover">
                            <td className="px-4 py-3 text-11 font-medium text-primary">v{revision.revision}</td>
                            <td className="px-4 py-3 text-11 text-secondary">
                              {revision.variable_schema?.placeholder_count ?? 0}
                            </td>
                            <td className="px-4 py-3 text-11 text-secondary">{revision.signature_blueprint.length}</td>
                            <td className="px-4 py-3 text-11 text-secondary">
                              {new Date(revision.created_at).toLocaleString()}
                            </td>
                            <td className="px-4 py-3">
                              <div className="flex justify-end gap-2">
                                <Button variant="secondary" size="sm" onClick={() => previewRevision(revision, "word")}>
                                  <Eye className="size-3.5" /> Word
                                </Button>
                                <Button variant="secondary" size="sm" onClick={() => previewRevision(revision, "pdf")}>
                                  <Eye className="size-3.5" /> PDF
                                </Button>
                                <Button
                                  variant="primary"
                                  size="sm"
                                  onClick={() =>
                                    setUsingSelection({ variant: selectedVariant, revisionId: revision.id })
                                  }
                                >
                                  Usar v{revision.revision}
                                </Button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </div>
          ) : null}
        </section>

        <section className="overflow-hidden rounded-lg border border-subtle">
          <div className="flex items-center justify-between border-b border-subtle px-4 py-3">
            <div>
              <h2 className="text-13 font-semibold text-primary">Contratos creados desde esta plantilla</h2>
              <p className="mt-0.5 text-10 text-tertiary">Incluye todas sus variantes y versiones.</p>
            </div>
            <Link
              to={`/${workspaceSlug}/file-library/contracts/documents`}
              className="text-10 font-medium text-accent-primary hover:underline"
            >
              Ver todos
            </Link>
          </div>
          {templateRequests.length === 0 ? (
            <div className="px-4 py-8 text-center text-11 text-tertiary">
              Todavía no se ha creado ningún contrato con esta plantilla.
            </div>
          ) : (
            <div className="divide-y divide-subtle">
              {templateRequests.slice(0, 8).map((request) => {
                const signed = request.signers.filter((signer) => signer.status === "SIGNED").length;
                return (
                  <Link
                    key={request.id}
                    to={`/${workspaceSlug}/file-library/contracts/documents?request=${request.id}`}
                    className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-layer-1-hover"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-11 font-medium text-primary">{request.title}</p>
                      <p className="mt-0.5 text-9 text-tertiary">
                        Versión {request.revision.revision} · {signed}/
                        {request.signers.length || request.recipients.length} firmantes completados
                      </p>
                    </div>
                    <span
                      className={`shrink-0 rounded-full px-2 py-1 text-9 ${request.status === "COMPLETED" ? "bg-success-primary/10 text-success-primary" : "bg-layer-2 text-secondary"}`}
                    >
                      {STATUS_LABELS[request.status]}
                    </span>
                  </Link>
                );
              })}
            </div>
          )}
        </section>
      </div>

      <FilePreviewModal
        workspaceSlug={workspaceSlug}
        file={previewFile}
        onClose={() => setPreviewFile(null)}
        scope="contract"
        readOnly
      />
      <CollaboraEditorModal
        workspaceSlug={workspaceSlug}
        assetId={editingVariant?.source_asset_id ?? null}
        fileName={editingVariant?.source_file_name ?? ""}
        onClose={() => {
          setEditingVariant(undefined);
          void Promise.all([mutateTemplate(), mutateSchema()]);
        }}
      />
      {usingSelection ? (
        <ContractTemplateUseDialog
          workspaceSlug={workspaceSlug}
          templateName={template.name}
          variant={usingSelection.variant}
          initialRevisionId={usingSelection.revisionId}
          onEditWord={() => {
            setEditingVariant(usingSelection.variant);
            setUsingSelection(undefined);
          }}
          onClose={() => setUsingSelection(undefined)}
          onPrepared={(request) => {
            setUsingSelection(undefined);
            setAuthoringRequest(request);
            void mutateRequests();
          }}
        />
      ) : null}
      {authoringRequest ? (
        <ContractAuthoringModal
          workspaceSlug={workspaceSlug}
          signatureRequest={authoringRequest}
          onClose={() => setAuthoringRequest(undefined)}
          onSent={() => {
            void mutateRequests();
            void mutateTemplate();
          }}
        />
      ) : null}

      <ModalCore
        isOpen={variantModalOpen}
        handleClose={() => setVariantModalOpen(false)}
        position={EModalPosition.CENTER}
        width={EModalWidth.SM}
      >
        <form
          className="p-5"
          onSubmit={(event) => {
            event.preventDefault();
            void createVariant();
          }}
        >
          <h3 className="text-14 font-semibold text-primary">Nueva variante</h3>
          <p className="mt-1 text-10 text-tertiary">
            Copia el Word, campos y participantes de la variante seleccionada.
          </p>
          <label className="mt-4 block text-11 font-medium text-secondary">
            Nombre
            <input
              value={variantDraft}
              onChange={(event) => setVariantDraft(event.target.value)}
              className="focus:border-accent-primary mt-1.5 h-9 w-full rounded-md border border-subtle bg-surface-1 px-3 text-11 outline-none"
              placeholder="Ej. Encabezado alternativo"
            />
          </label>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" size="lg" type="button" onClick={() => setVariantModalOpen(false)}>
              Cancelar
            </Button>
            <Button variant="primary" size="lg" type="submit" disabled={!variantDraft.trim() || isCreatingVariant}>
              {isCreatingVariant ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />} Crear
              variante
            </Button>
          </div>
        </form>
      </ModalCore>
      <AlertModalCore
        isOpen={deleteOpen}
        handleClose={() => setDeleteOpen(false)}
        handleSubmit={() => void deleteTemplate()}
        isSubmitting={isDeleting}
        title="Eliminar plantilla"
        content={
          <>La plantilla desaparecerá de la biblioteca. Los contratos enviados y sus versiones se conservarán.</>
        }
      />
    </div>
  );
}

function ContractVersionCard({
  title,
  subtitle,
  meta,
  thumbnailUrl,
  isSelected,
  onSelect,
}: {
  title: string;
  subtitle: string;
  meta?: string;
  thumbnailUrl: string;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const [thumbnailFailed, setThumbnailFailed] = useState(false);

  return (
    <button
      type="button"
      aria-pressed={isSelected}
      onClick={onSelect}
      className={`group flex w-full gap-3 rounded-lg border p-2 text-left transition-colors ${
        isSelected
          ? "border-accent-strong bg-accent-primary/5 ring-1 ring-accent-strong"
          : "border-subtle bg-surface-1 hover:bg-layer-1-hover"
      }`}
    >
      <span className="shadow-sm grid h-24 w-[4.5rem] shrink-0 place-items-center overflow-hidden rounded border border-subtle bg-layer-1">
        {thumbnailFailed ? (
          <FileText className="size-5 text-tertiary" />
        ) : (
          <img
            src={thumbnailUrl}
            alt=""
            loading="lazy"
            className="size-full bg-white object-cover object-top"
            onError={() => setThumbnailFailed(true)}
          />
        )}
      </span>
      <span className="min-w-0 flex-1 py-1">
        <span className="flex items-center justify-between gap-2">
          <span className="truncate text-11 font-semibold text-primary">{title}</span>
          {isSelected ? <CheckCircle2 className="size-3.5 shrink-0 text-accent-primary" /> : null}
        </span>
        <span className="mt-1 line-clamp-2 text-9 leading-4 text-tertiary">{subtitle}</span>
        {meta ? <span className="mt-2 block text-9 leading-4 text-secondary">{meta}</span> : null}
      </span>
    </button>
  );
}
