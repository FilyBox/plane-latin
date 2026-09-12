/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
// plane imports
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { EmptyStateCompact } from "@plane/propel/empty-state";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TExpenseCategory } from "@plane/types";
import { AlertModalCore, Input } from "@plane/ui";
// services
import { financeService } from "@/services/finance.service";
// local imports
import { PaymentsSidePanel } from "./side-panel";

type Props = {
  workspaceSlug: string;
  isOpen: boolean;
  categories: TExpenseCategory[];
  onClose: () => void;
  /** Set when this opened from another panel, so it stacks over it. */
  nested?: boolean;
  onChanged: () => void;
};

export function CategoriesModal(props: Props) {
  const { workspaceSlug, isOpen, categories, onClose, nested, onChanged } = props;
  const { t } = useTranslation();
  const [newName, setNewName] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<TExpenseCategory | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    setIsSubmitting(true);
    try {
      await financeService.createCategory(workspaceSlug, { name });
      setNewName("");
      onChanged();
    } catch (error: any) {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: t("payments.toasts.error"),
        // 409 when the name is taken; the serializer answers with {name: [...]}
        message: error?.name?.[0] ?? t("payments.toasts.duplicate_category"),
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setIsSubmitting(true);
    try {
      await financeService.deleteCategory(workspaceSlug, deleteTarget.id);
      setDeleteTarget(null);
      onChanged();
    } catch {
      setToast({ type: TOAST_TYPE.ERROR, title: t("payments.toasts.error") });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <>
      <AlertModalCore
        isOpen={deleteTarget !== null}
        handleClose={() => setDeleteTarget(null)}
        handleSubmit={() => void handleDelete()}
        isSubmitting={isSubmitting}
        title={t("payments.delete_category_title")}
        content={t("payments.delete_category_description")}
      />

      <PaymentsSidePanel
        isOpen={isOpen}
        onClose={onClose}
        nested={nested}
        width="md"
        title={t("payments.manage_categories")}
        description={t("payments.ledger.categories_help")}
      >
        {/* The name field is a form of its own: Enter files the category and
            leaves the cursor in place, ready for the next one. */}
        <form
          className="flex shrink-0 items-center gap-2 border-b border-subtle px-5 py-4"
          onSubmit={(event) => {
            event.preventDefault();
            void handleCreate();
          }}
        >
          <Input
            value={newName}
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            onChange={(event) => setNewName(event.target.value)}
            placeholder={t("payments.fields.name")}
            className="w-full"
          />
          <Button variant="primary" size="sm" type="submit" disabled={!newName.trim() || isSubmitting}>
            <Plus className="size-4" />
            {t("payments.ledger.add_category")}
          </Button>
        </form>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
          {categories.length === 0 ? (
            <EmptyStateCompact assetKey="label" title={t("payments.empty.categories")} />
          ) : (
            <ul className="divide-y divide-subtle">
              {categories.map((category) => (
                <li key={category.id} className="flex items-center justify-between gap-2 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-13 text-primary">{category.name}</p>
                    <p className="text-11 text-tertiary">
                      {t("payments.expense_count", { count: category.expense_count })}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setDeleteTarget(category)}
                    className="rounded-sm p-1 text-tertiary hover:bg-layer-1-hover hover:text-danger-primary"
                    title={t("payments.actions.delete")}
                  >
                    <Trash2 className="size-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </PaymentsSidePanel>
    </>
  );
}
