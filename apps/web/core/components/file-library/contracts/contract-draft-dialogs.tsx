/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * Dialogs around Word drafts: what to do with the changes when the editor
 * closes, and what changed in the variables once a version is published.
 */

import { useState } from "react";
import { AlertTriangle, CopyPlus, FileClock, Loader2, Minus, Plus, RotateCcw, Save, UserRound } from "lucide-react";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import type { TContractDraftPublishResponse } from "@plane/types";
import { EModalPosition, EModalWidth, ModalCore } from "@plane/ui";
import { cn } from "@plane/utils";
import { variableLabel } from "./template-utils";

export type TDraftCloseAction = "PUBLISH" | "KEEP" | "DISCARD" | "NEW_VARIANT";

const PREFIX = "file_library.contracts.workflow.draft";

const OPTIONS: Array<{ value: TDraftCloseAction; icon: typeof Save; titleKey: string; descriptionKey: string }> = [
  {
    value: "PUBLISH",
    icon: Save,
    titleKey: `${PREFIX}.publish_title`,
    descriptionKey: `${PREFIX}.publish_description`,
  },
  { value: "KEEP", icon: FileClock, titleKey: `${PREFIX}.keep_title`, descriptionKey: `${PREFIX}.keep_description` },
  {
    value: "DISCARD",
    icon: RotateCcw,
    titleKey: `${PREFIX}.discard_title`,
    descriptionKey: `${PREFIX}.discard_description`,
  },
  {
    value: "NEW_VARIANT",
    icon: CopyPlus,
    titleKey: `${PREFIX}.variant_title`,
    descriptionKey: `${PREFIX}.variant_description`,
  },
];

/**
 * Shown only when the Word session changed something. Dismissing it keeps the
 * draft (nothing is lost); "Seguir editando" reopens the editor.
 */
export function ContractDraftCloseDialog({
  isOpen,
  nextVersionNumber,
  isSubmitting,
  error,
  onSubmit,
  onKeepEditing,
  onDismiss,
}: {
  isOpen: boolean;
  nextVersionNumber: number;
  isSubmitting: boolean;
  error?: string;
  onSubmit: (action: TDraftCloseAction, name?: string) => void;
  onKeepEditing: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const [action, setAction] = useState<TDraftCloseAction>("PUBLISH");
  const [versionName, setVersionName] = useState("");
  const [variantName, setVariantName] = useState("");
  const needsVariantName = action === "NEW_VARIANT" && !variantName.trim();

  const submitLabel: Record<TDraftCloseAction, string> = {
    PUBLISH: t(`${PREFIX}.publish_confirm`, { number: nextVersionNumber }),
    KEEP: t(`${PREFIX}.keep_confirm`),
    DISCARD: t(`${PREFIX}.discard_confirm`),
    NEW_VARIANT: t(`${PREFIX}.variant_confirm`),
  };

  return (
    <ModalCore
      isOpen={isOpen}
      handleClose={() => (isSubmitting ? undefined : onDismiss())}
      position={EModalPosition.CENTER}
      width={EModalWidth.LG}
    >
      <header className="border-b border-subtle px-6 py-5">
        <h2 className="text-15 font-semibold text-primary">{t(`${PREFIX}.close_title`)}</h2>
        <p className="mt-1 text-13 leading-5 text-tertiary">{t(`${PREFIX}.close_description`)}</p>
      </header>

      <div className="space-y-2 p-5">
        {OPTIONS.map((option) => {
          const Icon = option.icon;
          const selected = action === option.value;
          return (
            <div
              key={option.value}
              className={cn(
                "rounded-lg border transition-colors",
                selected ? "border-accent-strong bg-accent-primary/5 ring-1 ring-accent-strong" : "border-subtle",
                option.value === "NEW_VARIANT" && !selected && "opacity-90"
              )}
            >
              <button
                type="button"
                disabled={isSubmitting}
                onClick={() => setAction(option.value)}
                className="flex w-full items-start gap-3 p-3.5 text-left"
              >
                <span
                  className={cn(
                    "grid size-8 shrink-0 place-items-center rounded-md bg-layer-1",
                    option.value === "DISCARD" ? "text-danger-primary" : "text-secondary"
                  )}
                >
                  <Icon className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-13 font-semibold text-primary">
                    {t(option.titleKey, { number: nextVersionNumber })}
                  </span>
                  <span className="mt-0.5 block text-11 leading-4 text-tertiary">{t(option.descriptionKey)}</span>
                </span>
                <span
                  className={cn(
                    "mt-1 size-4 shrink-0 rounded-full border-2",
                    selected ? "border-[5px] border-accent-strong" : "border-subtle"
                  )}
                />
              </button>
              {selected && option.value === "PUBLISH" ? (
                <label className="block px-3.5 pb-3.5 text-11 font-medium text-secondary">
                  {t(`${PREFIX}.version_name`)}{" "}
                  <span className="font-normal text-tertiary">
                    ({t("file_library.contracts.workflow.common.optional")})
                  </span>
                  <input
                    value={versionName}
                    disabled={isSubmitting}
                    onChange={(event) => setVersionName(event.target.value)}
                    maxLength={255}
                    className="mt-1.5 h-9 w-full rounded-md border border-subtle bg-surface-1 px-3 text-13 text-primary outline-none focus:border-accent-strong"
                    placeholder={t("file_library.contracts.workflow.edit_decision.revision_placeholder")}
                  />
                </label>
              ) : null}
              {selected && option.value === "NEW_VARIANT" ? (
                <label className="block px-3.5 pb-3.5 text-11 font-medium text-secondary">
                  {t("file_library.contracts.workflow.edit_decision.variant_name")}
                  <input
                    value={variantName}
                    disabled={isSubmitting}
                    onChange={(event) => setVariantName(event.target.value)}
                    maxLength={255}
                    className="mt-1.5 h-9 w-full rounded-md border border-subtle bg-surface-1 px-3 text-13 text-primary outline-none focus:border-accent-strong"
                    placeholder={t("file_library.contracts.workflow.edit_decision.variant_placeholder")}
                  />
                </label>
              ) : null}
            </div>
          );
        })}
        {error ? (
          <p role="alert" className="rounded-md bg-danger-primary/10 px-3 py-2 text-12 text-danger-primary">
            {error}
          </p>
        ) : null}
      </div>

      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-subtle px-6 py-4">
        <Button variant="secondary" size="sm" disabled={isSubmitting} onClick={onKeepEditing}>
          {t(`${PREFIX}.keep_editing`)}
        </Button>
        <Button
          variant={action === "DISCARD" ? "secondary" : "primary"}
          size="sm"
          disabled={isSubmitting || needsVariantName}
          onClick={() =>
            onSubmit(
              action,
              action === "PUBLISH"
                ? versionName.trim() || undefined
                : action === "NEW_VARIANT"
                  ? variantName.trim()
                  : undefined
            )
          }
        >
          {isSubmitting ? <Loader2 className="size-4 animate-spin" /> : null}
          <span className={cn(action === "DISCARD" && "text-danger-primary")}>{submitLabel[action]}</span>
        </Button>
      </footer>
    </ModalCore>
  );
}

/**
 * After publishing: which variables and signers came or went, and whether the
 * manually placed fields need a look.
 */
export function ContractPublishResultDialog({
  result,
  onReviewFields,
  onClose,
}: {
  result: (TContractDraftPublishResponse & { versionNumber?: number }) | undefined;
  onReviewFields: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const changes = result?.variable_changes;
  const needsReview = result?.manual_fields_status === "REQUIRES_REVIEW";
  const rows: Array<{ key: string; icon: typeof Plus; tone: "success" | "danger"; text: string }> = [
    ...(changes?.added ?? []).map((key) => ({
      key: `a:${key}`,
      icon: Plus,
      tone: "success" as const,
      text: t(`${PREFIX}.change_added`, { name: variableLabel(key), token: `{{${key}}}` }),
    })),
    ...(changes?.removed ?? []).map((key) => ({
      key: `r:${key}`,
      icon: Minus,
      tone: "danger" as const,
      text: t(`${PREFIX}.change_removed`, { name: variableLabel(key), token: `{{${key}}}` }),
    })),
    ...(changes?.signers_added ?? []).map((index) => ({
      key: `sa:${index}`,
      icon: UserRound,
      tone: "success" as const,
      text: t(`${PREFIX}.change_signer_added`, { number: index + 1 }),
    })),
    ...(changes?.signers_removed ?? []).map((index) => ({
      key: `sr:${index}`,
      icon: UserRound,
      tone: "danger" as const,
      text: t(`${PREFIX}.change_signer_removed`, { number: index + 1 }),
    })),
  ];

  return (
    <ModalCore isOpen={Boolean(result)} handleClose={onClose} position={EModalPosition.CENTER} width={EModalWidth.MD}>
      <header className="border-b border-subtle px-6 py-5">
        <h2 className="text-15 font-semibold text-primary">
          {result?.versionNumber
            ? t(`${PREFIX}.published_title`, { number: result.versionNumber })
            : t(`${PREFIX}.published_title_plain`)}
        </h2>
        <p className="mt-1 text-13 text-tertiary">
          {rows.length > 0 ? t(`${PREFIX}.published_changes`) : t(`${PREFIX}.published_no_changes`)}
        </p>
      </header>
      <div className="space-y-3 p-5">
        {rows.length > 0 ? (
          <ul className="space-y-1.5">
            {rows.map((row) => {
              const Icon = row.icon;
              return (
                <li key={row.key} className="flex items-start gap-2 text-13 text-secondary">
                  <Icon
                    className={cn(
                      "mt-0.5 size-3.5 shrink-0",
                      row.tone === "success" ? "text-success-primary" : "text-danger-primary"
                    )}
                  />
                  {row.text}
                </li>
              );
            })}
          </ul>
        ) : null}
        {needsReview ? (
          <div className="flex items-start gap-2 rounded-md bg-warning-primary/10 px-3 py-2 text-12 text-warning-primary">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            {t(`${PREFIX}.review_fields_hint`, { count: result?.manual_field_count ?? 0 })}
          </div>
        ) : null}
      </div>
      <footer className="flex justify-end gap-2 border-t border-subtle px-6 py-4">
        <Button variant={needsReview ? "secondary" : "primary"} size="sm" onClick={onClose}>
          {t("file_library.contracts.workflow.common.done")}
        </Button>
        {needsReview ? (
          <Button variant="primary" size="sm" onClick={onReviewFields}>
            {t(`${PREFIX}.review_fields`)}
          </Button>
        ) : null}
      </footer>
    </ModalCore>
  );
}
