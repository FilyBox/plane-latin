/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useMemo, useState } from "react";
import {
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  Eye,
  FileCheck2,
  Link2,
  Loader2,
  RefreshCcw,
  Send,
  UserRoundCheck,
} from "lucide-react";
import { useSearchParams } from "react-router";
import useSWR from "swr";
import { Button } from "@plane/propel/button";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TContractSignatureRequest, TContractSigningLink } from "@plane/types";
import { cn } from "@plane/utils";
import { contractService } from "@/services/contract.service";
import { FilePreviewModal, type TPreviewFile } from "../file-preview-modal";
import { ContractAuthoringModal } from "./contract-authoring-modal";
import { ContractSigningLinksDialog } from "./contract-signing-links-dialog";

type Props = { workspaceSlug: string };

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

const statusClass = (status: TContractSignatureRequest["status"]) => {
  if (status === "COMPLETED") return "bg-success-primary/10 text-success-primary";
  if (status === "REJECTED" || status === "ERROR") return "bg-danger-primary/10 text-danger-primary";
  if (status === "PENDING") return "bg-warning-primary/10 text-warning-primary";
  return "bg-layer-2 text-secondary";
};

const signerStatusLabel: Record<string, string> = {
  NOT_SENT: "Sin enviar",
  NOT_SIGNED: "Pendiente",
  SENT: "Enviado",
  OPENED: "Abierto",
  SIGNED: "Completado",
  REJECTED: "Rechazado",
  PENDING: "Pendiente",
  APPROVED: "Aprobado",
  COMPLETED: "Completado",
};

export function ContractDocuments({ workspaceSlug }: Props) {
  const [searchParams, setSearchParams] = useSearchParams();
  const {
    data: requests,
    mutate,
    isLoading,
  } = useSWR(
    `CONTRACT_SIGNATURE_REQUESTS_${workspaceSlug}`,
    () => contractService.getSignatureRequests(workspaceSlug),
    { refreshInterval: 15000, revalidateOnFocus: false }
  );
  const [expandedId, setExpandedId] = useState<string>();
  const [syncingId, setSyncingId] = useState<string>();
  const [syncedId, setSyncedId] = useState<string>();
  const [authoringRequest, setAuthoringRequest] = useState<TContractSignatureRequest>();
  const [signingLinks, setSigningLinks] = useState<TContractSigningLink[]>();
  const [loadingLinksFor, setLoadingLinksFor] = useState<string>();
  const [previewFile, setPreviewFile] = useState<TPreviewFile | null>(null);
  const {
    data: detail,
    mutate: mutateDetail,
    isLoading: isDetailLoading,
  } = useSWR(
    expandedId ? `CONTRACT_SIGNATURE_REQUEST_${workspaceSlug}_${expandedId}` : null,
    () => contractService.getSignatureRequest(workspaceSlug, expandedId!),
    { revalidateOnFocus: false }
  );

  useEffect(() => {
    const requestId = searchParams.get("request");
    if (!requestId) return;
    setExpandedId(requestId);
    setSearchParams({}, { replace: true });
  }, [searchParams, setSearchParams]);

  const orderedRequests = useMemo(
    () => [...(requests ?? [])].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()),
    [requests]
  );

  const syncRequest = async (requestId: string) => {
    setSyncingId(requestId);
    setSyncedId(undefined);
    try {
      await contractService.syncSignatureRequest(workspaceSlug, requestId);
      await Promise.all([mutate(), expandedId === requestId ? mutateDetail() : Promise.resolve()]);
      setSyncedId(requestId);
      window.setTimeout(() => setSyncedId((current) => (current === requestId ? undefined : current)), 1800);
      setToast({ type: TOAST_TYPE.SUCCESS, title: "Estado de firmas actualizado" });
    } catch (error: any) {
      setToast({ type: TOAST_TYPE.ERROR, title: error?.error ?? "No se pudo sincronizar" });
    } finally {
      setSyncingId(undefined);
    }
  };

  const showSigningLinks = async (requestId: string) => {
    setLoadingLinksFor(requestId);
    try {
      setSigningLinks(await contractService.getSignatureRequestLinks(workspaceSlug, requestId));
    } catch (error: any) {
      setToast({ type: TOAST_TYPE.ERROR, title: error?.error ?? "No se pudieron obtener los enlaces" });
    } finally {
      setLoadingLinksFor(undefined);
    }
  };

  const previewRequest = (request: TContractSignatureRequest) => {
    const assetId = request.signed_asset_id ?? request.pdf_asset_id;
    if (!assetId) return;
    setPreviewFile({
      assetId,
      name: `${request.title}${request.signed_asset_id ? " · firmado" : ""}.pdf`,
      contentType: "application/pdf",
    });
  };

  return (
    <div className="h-full overflow-y-auto bg-surface-1">
      <div className="mx-auto max-w-6xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
        <header>
          <h1 className="text-20 font-semibold text-primary">Contratos creados</h1>
          <p className="mt-1 text-12 text-secondary">
            Revisa borradores, entregas, firmas y los valores completados por cada participante.
          </p>
        </header>

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-lg border border-subtle p-4">
            <FileCheck2 className="size-4 text-accent-primary" />
            <p className="mt-2 text-18 font-semibold text-primary">{orderedRequests.length}</p>
            <p className="text-10 text-tertiary">Contratos creados</p>
          </div>
          <div className="rounded-lg border border-subtle p-4">
            <Clock3 className="size-4 text-warning-primary" />
            <p className="mt-2 text-18 font-semibold text-primary">
              {orderedRequests.filter((request) => request.status === "PENDING").length}
            </p>
            <p className="text-10 text-tertiary">Esperando firmas</p>
          </div>
          <div className="rounded-lg border border-subtle p-4">
            <UserRoundCheck className="size-4 text-success-primary" />
            <p className="mt-2 text-18 font-semibold text-primary">
              {orderedRequests.filter((request) => request.status === "COMPLETED").length}
            </p>
            <p className="text-10 text-tertiary">Completados</p>
          </div>
        </div>

        <section className="overflow-hidden rounded-lg border border-subtle">
          <div className="border-b border-subtle px-4 py-3">
            <h2 className="text-13 font-semibold text-primary">Seguimiento</h2>
            <p className="mt-0.5 text-10 text-tertiary">Expande un contrato para consultar firmantes y respuestas.</p>
          </div>
          {isLoading ? (
            <div className="grid min-h-48 place-items-center">
              <Loader2 className="size-5 animate-spin text-tertiary" />
            </div>
          ) : orderedRequests.length === 0 ? (
            <div className="px-6 py-14 text-center">
              <Send className="mx-auto size-7 text-tertiary" />
              <p className="mt-3 text-12 font-medium text-primary">No hay contratos preparados</p>
              <p className="mt-1 text-10 text-tertiary">Usa una versión desde Plantillas para comenzar.</p>
            </div>
          ) : (
            <div className="divide-y divide-subtle">
              {orderedRequests.map((request) => {
                const signedCount = request.signers.filter((signer) => signer.status === "SIGNED").length;
                const signerCount =
                  request.signers.length ||
                  request.recipients.filter((recipient) => recipient.role === "SIGNER").length;
                const isExpanded = expandedId === request.id;
                return (
                  <article key={request.id}>
                    <div className="grid gap-3 px-4 py-3.5 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
                      <button
                        type="button"
                        onClick={() => setExpandedId(isExpanded ? undefined : request.id)}
                        className="flex min-w-0 items-start gap-3 text-left"
                      >
                        <span className="mt-0.5 text-tertiary">
                          {isExpanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-12 font-medium text-primary">{request.title}</span>
                          <span className="mt-1 flex flex-wrap items-center gap-2 text-9 text-tertiary">
                            <span>Versión {request.revision.revision}</span>
                            <span>·</span>
                            <span
                              className={cn(
                                "font-medium",
                                signerCount > 0 && signedCount === signerCount ? "text-success-primary" : ""
                              )}
                            >
                              {signedCount}/{signerCount} firmantes completados
                            </span>
                            <span>·</span>
                            <span>{new Date(request.created_at).toLocaleString()}</span>
                          </span>
                        </span>
                      </button>
                      <div className="flex flex-wrap items-center gap-2 md:justify-end">
                        <span className={cn("rounded-full px-2 py-1 text-9 font-medium", statusClass(request.status))}>
                          {STATUS_LABELS[request.status]}
                        </span>
                        {request.pdf_asset_id ? (
                          <Button variant="secondary" size="sm" onClick={() => previewRequest(request)}>
                            <Eye className="size-3.5" /> Ver PDF
                          </Button>
                        ) : null}
                        {request.status === "READY" ? (
                          <Button variant="primary" size="sm" onClick={() => setAuthoringRequest(request)}>
                            <Send className="size-3.5" /> Revisar y enviar
                          </Button>
                        ) : null}
                        {request.documenso_envelope_id ? (
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={syncingId === request.id}
                            onClick={() => void syncRequest(request.id)}
                          >
                            {syncingId === request.id ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : syncedId === request.id ? (
                              <Check className="size-3.5 text-success-primary" />
                            ) : (
                              <RefreshCcw className="size-3.5" />
                            )}{" "}
                            {syncingId === request.id
                              ? "Sincronizando…"
                              : syncedId === request.id
                                ? "Actualizado"
                                : "Sincronizar"}
                          </Button>
                        ) : null}
                        {request.documenso_envelope_id ? (
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={loadingLinksFor === request.id}
                            onClick={() => void showSigningLinks(request.id)}
                          >
                            {loadingLinksFor === request.id ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              <Link2 className="size-3.5" />
                            )}{" "}
                            Enlaces
                          </Button>
                        ) : null}
                      </div>
                    </div>
                    {isExpanded ? (
                      <ContractProgressDetail
                        request={detail?.id === request.id ? detail : request}
                        isLoading={isDetailLoading && !detail}
                      />
                    ) : null}
                  </article>
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
      {authoringRequest ? (
        <ContractAuthoringModal
          workspaceSlug={workspaceSlug}
          signatureRequest={authoringRequest}
          onClose={() => setAuthoringRequest(undefined)}
          onSent={() => {
            setAuthoringRequest(undefined);
            void mutate();
          }}
        />
      ) : null}
      {signingLinks ? (
        <ContractSigningLinksDialog links={signingLinks} onClose={() => setSigningLinks(undefined)} />
      ) : null}
    </div>
  );
}

function ContractProgressDetail({ request, isLoading }: { request: TContractSignatureRequest; isLoading: boolean }) {
  if (isLoading)
    return (
      <div className="grid min-h-28 place-items-center border-t border-subtle bg-layer-1">
        <Loader2 className="size-4 animate-spin text-tertiary" />
      </div>
    );
  const remoteRecipients = request.signing_details?.recipients ?? [];
  const participants =
    remoteRecipients.length > 0
      ? remoteRecipients
      : request.signers.map((signer) => ({
          id: signer.documenso_recipient_id,
          name: signer.name,
          email: signer.email,
          role: signer.role,
          signing_order: signer.signing_order,
          signing_status: signer.status,
          read_status: signer.status === "OPENED" || signer.status === "SIGNED" ? "OPENED" : "NOT_OPENED",
          send_status: signer.status === "NOT_SENT" ? "NOT_SENT" : "SENT",
          signed_at: null,
          rejection_reason: null,
        }));
  return (
    <div className="border-t border-subtle bg-layer-1 p-4 sm:p-5">
      {request.signing_details?.error ? (
        <p className="mb-3 rounded-md bg-warning-primary/10 p-3 text-10 text-warning-primary">
          No fue posible consultar el detalle remoto: {request.signing_details.error}
        </p>
      ) : null}
      <div className="grid gap-3 lg:grid-cols-2">
        {participants.length === 0 ? (
          <p className="text-11 text-tertiary">Aún no hay participantes configurados.</p>
        ) : (
          participants.map((recipient, index) => {
            const fields = (request.signing_details?.fields ?? []).filter(
              (field) => field.recipient_id === recipient.id
            );
            const completed = ["SIGNED", "APPROVED", "COMPLETED"].includes(recipient.signing_status);
            return (
              <div
                key={`${recipient.id ?? recipient.email}-${recipient.role}`}
                className="rounded-lg border border-subtle bg-surface-1 p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-11 font-semibold text-primary">
                      {recipient.name || `Participante ${index + 1}`}
                    </p>
                    <p className="mt-0.5 truncate text-9 text-tertiary">{recipient.email}</p>
                  </div>
                  <span
                    className={cn(
                      "flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-9 font-medium",
                      completed ? "bg-success-primary/10 text-success-primary" : "bg-layer-2 text-secondary"
                    )}
                  >
                    {completed ? <CheckCircle2 className="size-3" /> : <Clock3 className="size-3" />}
                    {signerStatusLabel[recipient.signing_status] ?? recipient.signing_status}
                  </span>
                </div>
                <div className="mt-3 flex flex-wrap gap-2 text-9 text-tertiary">
                  <span>{recipient.send_status === "SENT" ? "Correo enviado" : "Sin enviar"}</span>
                  <span>·</span>
                  <span>{recipient.read_status === "OPENED" ? "Documento abierto" : "Sin abrir"}</span>
                  {recipient.signed_at ? (
                    <>
                      <span>·</span>
                      <span>Firmó {new Date(recipient.signed_at).toLocaleString()}</span>
                    </>
                  ) : null}
                </div>
                {fields.length > 0 ? (
                  <div className="mt-3 overflow-hidden rounded-md border border-subtle">
                    <div className="bg-layer-1 px-3 py-2 text-9 font-semibold text-tertiary">CAMPOS COMPLETADOS</div>
                    <dl className="divide-y divide-subtle">
                      {fields.map((field) => (
                        <div
                          key={`${field.id ?? `${recipient.id}-${field.type}-${field.page}-${field.label}`}`}
                          className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-3 px-3 py-2"
                        >
                          <dt className="truncate text-9 text-tertiary">{field.label || field.type}</dt>
                          <dd className={cn("text-10 break-words text-primary", !field.value && "text-tertiary")}>
                            {field.value || "Pendiente"}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                ) : (
                  <p className="mt-3 text-9 text-tertiary">No hay valores de campos disponibles todavía.</p>
                )}
              </div>
            );
          })
        )}
      </div>
      {request.signing_details?.synced_at ? (
        <p className="mt-3 text-right text-9 text-tertiary">
          Última consulta: {new Date(request.signing_details.synced_at).toLocaleString()}
        </p>
      ) : null}
    </div>
  );
}
