/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * Rename a template and edit its description. Used from the template list
 * menu and from the template detail header.
 */

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TContractActionError, TContractTemplate } from "@plane/types";
import { EModalPosition, EModalWidth, ModalCore } from "@plane/ui";
import { contractService } from "@/services/contract.service";
import { ContractField, ContractInput, ContractTextarea } from "./ui";

type Props = {
  workspaceSlug: string;
  /** The template being edited; the dialog is closed while undefined. */
  template: TContractTemplate | undefined;
  onClose: () => void;
  onSaved: (template: TContractTemplate) => void;
};

export function ContractTemplateDetailsDialog({ workspaceSlug, template, onClose, onSaved }: Props) {
  return (
    <ModalCore isOpen={Boolean(template)} handleClose={onClose} position={EModalPosition.CENTER} width={EModalWidth.MD}>
      {/* Keyed so the form starts from the template's current values each time. */}
      {template ? (
        <DetailsForm
          key={template.id}
          workspaceSlug={workspaceSlug}
          template={template}
          onClose={onClose}
          onSaved={onSaved}
        />
      ) : null}
    </ModalCore>
  );
}

function DetailsForm({
  workspaceSlug,
  template,
  onClose,
  onSaved,
}: Omit<Props, "template"> & { template: TContractTemplate }) {
  const { t } = useTranslation();
  const [name, setName] = useState(template.name);
  const [description, setDescription] = useState(template.description);
  const [isSaving, setIsSaving] = useState(false);
  const trimmedName = name.trim();
  const trimmedDescription = description.trim();
  const isDirty = trimmedName !== template.name || trimmedDescription !== template.description;

  const save = async () => {
    if (!trimmedName || !isDirty) return;
    setIsSaving(true);
    try {
      const updated = await contractService.updateTemplate(workspaceSlug, template.id, {
        name: trimmedName,
        description: trimmedDescription,
      });
      onSaved(updated);
      setToast({ type: TOAST_TYPE.SUCCESS, title: t("file_library.contracts.workflow.templates.details_saved") });
    } catch (error) {
      const apiError = error as TContractActionError;
      setToast({
        type: TOAST_TYPE.ERROR,
        title: apiError?.error ?? t("file_library.contracts.workflow.templates.details_save_failed"),
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="border-b border-subtle px-5 py-4">
        <h3 className="text-15 font-semibold text-primary">
          {t("file_library.contracts.workflow.templates.edit_details")}
        </h3>
        <p className="mt-1 text-11 text-tertiary">
          {t("file_library.contracts.workflow.templates.edit_details_description")}
        </p>
      </div>
      <div className="space-y-4 p-5">
        <ContractField label={t("file_library.contracts.workflow.common.name")}>
          <ContractInput
            value={name}
            hasError={!trimmedName}
            onChange={(event) => setName(event.target.value)}
            placeholder={t("file_library.contracts.workflow.templates.name_placeholder")}
          />
        </ContractField>
        <ContractField
          label={t("file_library.contracts.workflow.common.description")}
          optional
          optionalLabel={t("file_library.contracts.workflow.common.optional")}
        >
          <ContractTextarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder={t("file_library.contracts.workflow.templates.description_placeholder")}
            className="min-h-20 resize-none"
          />
        </ContractField>
      </div>
      <footer className="flex justify-end gap-2 border-t border-subtle px-5 py-4">
        <Button variant="secondary" size="sm" type="button" disabled={isSaving} onClick={onClose}>
          {t("file_library.contracts.workflow.common.cancel")}
        </Button>
        <Button variant="primary" size="sm" type="submit" disabled={!trimmedName || !isDirty || isSaving}>
          {isSaving ? <Loader2 className="size-4 animate-spin" /> : null}
          {t("file_library.contracts.workflow.templates.save")}
        </Button>
      </footer>
    </form>
  );
}
