/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import { CopyPlus, FileClock, Loader2, RotateCcw, Save } from "lucide-react";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { EModalPosition, EModalWidth, ModalCore } from "@plane/ui";

export type TContractEditDecision = "DISCARD" | "OVERWRITE" | "NEW_REVISION" | "NEW_VARIANT";

const OPTIONS: Array<{
  value: TContractEditDecision;
  titleKey: string;
  descriptionKey: string;
  icon: typeof Save;
}> = [
  {
    value: "OVERWRITE",
    titleKey: "file_library.contracts.workflow.edit_decision.overwrite_title",
    descriptionKey: "file_library.contracts.workflow.edit_decision.overwrite_description",
    icon: Save,
  },
  {
    value: "NEW_REVISION",
    titleKey: "file_library.contracts.workflow.edit_decision.revision_title",
    descriptionKey: "file_library.contracts.workflow.edit_decision.revision_description",
    icon: FileClock,
  },
  {
    value: "NEW_VARIANT",
    titleKey: "file_library.contracts.workflow.edit_decision.variant_title",
    descriptionKey: "file_library.contracts.workflow.edit_decision.variant_description",
    icon: CopyPlus,
  },
  {
    value: "DISCARD",
    titleKey: "file_library.contracts.workflow.edit_decision.discard_title",
    descriptionKey: "file_library.contracts.workflow.edit_decision.discard_description",
    icon: RotateCcw,
  },
];

export function ContractWordEditDecisionDialog({
  isOpen,
  isSubmitting,
  suggestedRevisionName,
  onSubmit,
}: {
  isOpen: boolean;
  isSubmitting: boolean;
  suggestedRevisionName: string;
  onSubmit: (decision: TContractEditDecision, name?: string) => void;
}) {
  const { t } = useTranslation();
  const [decision, setDecision] = useState<TContractEditDecision>("OVERWRITE");
  const [name, setName] = useState(suggestedRevisionName);
  const needsName = decision === "NEW_REVISION" || decision === "NEW_VARIANT";

  return (
    <ModalCore isOpen={isOpen} handleClose={() => undefined} position={EModalPosition.CENTER} width={EModalWidth.LG}>
      <header className="border-b border-subtle px-6 py-5">
        <h2 className="text-15 font-semibold text-primary">
          {t("file_library.contracts.workflow.edit_decision.title")}
        </h2>
        <p className="mt-1 text-13 leading-5 text-tertiary">
          {t("file_library.contracts.workflow.edit_decision.description")}
        </p>
      </header>

      <div className="space-y-2 p-5">
        {OPTIONS.map((option) => {
          const Icon = option.icon;
          const selected = decision === option.value;
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => {
                setDecision(option.value);
                if (option.value === "NEW_REVISION") setName(suggestedRevisionName);
                if (option.value === "NEW_VARIANT") setName("");
              }}
              className={`flex w-full items-start gap-3 rounded-lg border p-3.5 text-left ${
                selected
                  ? "border-accent-strong bg-accent-primary/5 ring-1 ring-accent-strong"
                  : "border-subtle hover:bg-layer-1-hover"
              }`}
            >
              <span className="grid size-8 shrink-0 place-items-center rounded-md bg-layer-1 text-secondary">
                <Icon className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-13 font-semibold text-primary">{t(option.titleKey)}</span>
                <span className="mt-0.5 block text-11 leading-4 text-tertiary">{t(option.descriptionKey)}</span>
              </span>
              <span
                className={`mt-1 size-4 rounded-full border-2 ${selected ? "border-[5px] border-accent-strong" : "border-subtle"}`}
              />
            </button>
          );
        })}

        {needsName ? (
          <label className="block pt-2 text-11 font-medium text-secondary">
            {t(
              decision === "NEW_VARIANT"
                ? "file_library.contracts.workflow.edit_decision.variant_name"
                : "file_library.contracts.workflow.edit_decision.revision_name"
            )}
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={255}
              className="focus:border-accent-primary mt-1.5 h-9 w-full rounded-md border border-subtle bg-surface-1 px-3 text-13 text-primary outline-none"
              placeholder={t(
                decision === "NEW_VARIANT"
                  ? "file_library.contracts.workflow.edit_decision.variant_placeholder"
                  : "file_library.contracts.workflow.edit_decision.revision_placeholder"
              )}
            />
          </label>
        ) : null}
      </div>

      <footer className="flex justify-end border-t border-subtle px-6 py-4">
        <Button
          variant={decision === "DISCARD" ? "secondary" : "primary"}
          size="sm"
          disabled={isSubmitting || (needsName && !name.trim())}
          onClick={() => onSubmit(decision, needsName ? name.trim() : undefined)}
        >
          {isSubmitting ? <Loader2 className="size-4 animate-spin" /> : null}
          {t(
            decision === "DISCARD"
              ? "file_library.contracts.workflow.edit_decision.discard"
              : "file_library.contracts.workflow.edit_decision.confirm"
          )}
        </Button>
      </footer>
    </ModalCore>
  );
}
