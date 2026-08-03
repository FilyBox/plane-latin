/**
 * Community-compatible signing link dialog based on Documenso's
 * DocumentRecipientLinkCopyDialog.
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Check, Copy, Link as LinkIcon, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "@plane/i18n";
import type { TContractSigningLink } from "@plane/types";
import { Button } from "@plane/propel/button";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import { EModalPosition, EModalWidth, ModalCore } from "@plane/ui";

type Props = {
  links: TContractSigningLink[];
  onClose: () => void;
};

export function ContractSigningLinksDialog({ links, onClose }: Props) {
  const { t } = useTranslation();
  const [copiedUrl, setCopiedUrl] = useState<string>();

  const copy = async (value: string) => {
    await navigator.clipboard.writeText(value);
    setCopiedUrl(value);
    window.setTimeout(() => setCopiedUrl((current) => (current === value ? undefined : current)), 1800);
  };

  const bulkCopy = async () => {
    await navigator.clipboard.writeText(links.map((link) => `${link.email}\n${link.url}`).join("\n\n"));
    setToast({ type: TOAST_TYPE.SUCCESS, title: t("file_library.contracts.workflow.signing_links.copied_all") });
  };

  return (
    <ModalCore isOpen handleClose={onClose} position={EModalPosition.CENTER} width={EModalWidth.LG}>
      <header className="flex items-start justify-between px-6 pt-6 pb-3">
        <div>
          <h2 className="text-16 font-semibold">{t("file_library.contracts.workflow.signing_links.title")}</h2>
          <p className="mt-1 text-12 text-tertiary">{t("file_library.contracts.workflow.signing_links.description")}</p>
        </div>
        <button type="button" className="rounded p-1.5 hover:bg-layer-1-hover" onClick={onClose}>
          <X className="size-4" />
        </button>
      </header>

      <ul className="mx-6 divide-y divide-subtle overflow-hidden rounded-lg border border-subtle">
        {links.length === 0 ? (
          <li className="py-8 text-center text-12 text-tertiary">
            {t("file_library.contracts.workflow.signing_links.empty")}
          </li>
        ) : null}
        {links.map((link) => (
          <li key={link.id ?? link.url} className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="flex min-w-0 items-center gap-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-full bg-layer-2 text-12 font-semibold">
                {(link.email || link.name).slice(0, 1).toUpperCase()}
              </span>
              <div className="min-w-0">
                <p className="truncate text-12 text-secondary">{link.email || link.name}</p>
                <p className="mt-0.5 text-10 text-tertiary">{link.role}</p>
              </div>
            </div>
            <button
              type="button"
              className="flex shrink-0 items-center gap-1 rounded-md border border-subtle px-2.5 py-1.5 text-10 hover:bg-layer-1-hover"
              onClick={() => void copy(link.url)}
            >
              {copiedUrl === link.url ? (
                <Check className="size-3.5 text-success-primary" />
              ) : (
                <Copy className="size-3.5" />
              )}
              {t(
                copiedUrl === link.url
                  ? "file_library.contracts.workflow.common.copied"
                  : "file_library.contracts.workflow.common.copy"
              )}
            </button>
          </li>
        ))}
      </ul>

      <footer className="flex justify-end gap-2 px-6 py-5">
        <Button variant="secondary" size="sm" onClick={onClose}>
          {t("file_library.contracts.workflow.common.close")}
        </Button>
        <Button variant="primary" size="sm" disabled={links.length === 0} onClick={() => void bulkCopy()}>
          <LinkIcon className="size-3.5" /> {t("file_library.contracts.workflow.signing_links.copy_all")}
        </Button>
      </footer>
    </ModalCore>
  );
}
