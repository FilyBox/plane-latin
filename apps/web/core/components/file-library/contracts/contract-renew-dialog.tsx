/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * "Renew from template": loads a template and opens the regular "use this
 * template" form for it. When the template has several usable variants the
 * person picks one first; when none is configured it says so instead.
 */

import { useState } from "react";
import { AlertTriangle, ChevronRight, Loader2, RefreshCcw, X } from "lucide-react";
import { useLocation, useNavigate } from "react-router";
import useSWR from "swr";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { EModalPosition, EModalWidth, ModalCore } from "@plane/ui";
import { cn } from "@plane/utils";
import { contractService } from "@/services/contract.service";
import { ContractTemplateUseDialog, isTemplateSourceReady } from "./contract-template-use-dialog";

type Props = {
  workspaceSlug: string;
  templateId: string;
  isOpen: boolean;
  onClose: () => void;
  /** Prefills the new contract's title (e.g. the expiring contract's name). */
  initialTitle?: string;
};

export function ContractRenewDialog(props: Props) {
  // Mounted only while open, so the variant choice resets between openings.
  if (!props.isOpen) return null;
  return <RenewFlow {...props} />;
}

function RenewFlow({ workspaceSlug, templateId, onClose, initialTitle }: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [chosenVariantId, setChosenVariantId] = useState<string>();
  // Same key as the template detail page, so both share the cached template.
  const {
    data: template,
    error,
    isLoading,
  } = useSWR(
    `CONTRACT_TEMPLATE_${workspaceSlug}_${templateId}`,
    () => contractService.getTemplate(workspaceSlug, templateId),
    { revalidateOnFocus: false }
  );

  const templatePath = `/${workspaceSlug}/file-library/contracts/templates/${templateId}`;
  const readyVariants = template?.variants.filter((variant) => isTemplateSourceReady(variant)) ?? [];
  // Skip the picker when there is only one usable variant.
  const variant =
    template?.variants.find((item) => item.id === chosenVariantId) ??
    (readyVariants.length === 1 ? readyVariants[0] : undefined);

  if (template && variant)
    return (
      <ContractTemplateUseDialog
        workspaceSlug={workspaceSlug}
        templateName={template.name}
        variant={variant}
        initialTitle={initialTitle}
        // Word editing lives on the template page; take the person there.
        onEditWord={() => {
          onClose();
          navigate(templatePath);
        }}
        onClose={onClose}
        onPrepared={(request) => {
          onClose();
          const returnTo = `${location.pathname}${location.search}`;
          navigate(
            `/${workspaceSlug}/file-library/contracts/documents/${request.id}/editor?returnTo=${encodeURIComponent(returnTo)}`
          );
        }}
      />
    );

  return (
    <ModalCore isOpen handleClose={onClose} position={EModalPosition.CENTER} width={EModalWidth.MD}>
      <header className="flex items-start justify-between gap-3 border-b border-subtle px-5 py-4">
        <div className="flex min-w-0 items-center gap-2">
          <RefreshCcw className="size-4 shrink-0 text-accent-primary" />
          <div className="min-w-0">
            <h3 className="text-15 truncate font-semibold text-primary">
              {t("file_library.contracts.workflow.renew.title")}
            </h3>
            {template ? <p className="mt-0.5 truncate text-11 text-tertiary">{template.name}</p> : null}
          </div>
        </div>
        <button
          type="button"
          aria-label={t("file_library.contracts.workflow.common.close")}
          className="grid size-8 shrink-0 place-items-center rounded-md hover:bg-layer-1-hover"
          onClick={onClose}
        >
          <X className="size-4" />
        </button>
      </header>

      {isLoading ? (
        <div className="grid min-h-40 place-items-center">
          <Loader2 className="size-5 animate-spin text-tertiary" />
        </div>
      ) : error || !template ? (
        <div className="flex items-center gap-2 p-5 text-13 text-danger-primary">
          <AlertTriangle className="size-4 shrink-0" />
          {t("file_library.contracts.workflow.renew.load_failed")}
        </div>
      ) : readyVariants.length === 0 ? (
        <div className="p-5">
          <p className="text-13 font-medium text-primary">
            {t("file_library.contracts.workflow.renew.not_ready_title")}
          </p>
          <p className="mt-1 text-11 text-tertiary">
            {t("file_library.contracts.workflow.renew.not_ready_description")}
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={onClose}>
              {t("file_library.contracts.workflow.common.cancel")}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                onClose();
                navigate(templatePath);
              }}
            >
              {t("file_library.contracts.workflow.renew.open_template")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="p-5">
          <p className="text-11 text-tertiary">{t("file_library.contracts.workflow.renew.choose_variant")}</p>
          <ul className="mt-3 space-y-1.5">
            {template.variants.map((item) => {
              const ready = isTemplateSourceReady(item);
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    disabled={!ready}
                    onClick={() => setChosenVariantId(item.id)}
                    className={cn(
                      "flex w-full items-center justify-between gap-3 rounded-md border border-subtle px-3 py-2.5 text-left",
                      ready ? "hover:bg-layer-1-hover" : "cursor-not-allowed opacity-60"
                    )}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-13 font-medium text-primary">{item.name}</span>
                      <span className="block text-11 text-tertiary">
                        {ready
                          ? t("file_library.contracts.workflow.common.version_count", { count: item.revision_count })
                          : t("file_library.contracts.workflow.renew.variant_not_ready")}
                      </span>
                    </span>
                    {ready ? <ChevronRight className="size-4 shrink-0 text-tertiary" /> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </ModalCore>
  );
}
