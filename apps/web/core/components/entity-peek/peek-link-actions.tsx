/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * Header buttons shared by every entity panel: copy a link that opens this
 * panel for anyone in the workspace, and (when opened outside its section)
 * go to the element in its own page.
 */

import { ExternalLink, Link2 } from "lucide-react";
import { useTranslation } from "@plane/i18n";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import { Tooltip } from "@plane/propel/tooltip";
import { cn } from "@plane/utils";

type Props = {
  /** Shown when the panel is open outside the element's own page */
  onOpenInSection?: () => void;
  className?: string;
  /** Smaller icons, for headers whose other buttons use them */
  small?: boolean;
};

export function PeekLinkActions({ onOpenInSection, className, small }: Props) {
  const { t } = useTranslation();
  const button = cn("rounded-sm p-1.5 text-tertiary hover:bg-layer-1-hover hover:text-secondary", className);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setToast({ type: TOAST_TYPE.SUCCESS, title: t("references.peek.link_copied") });
    } catch {
      setToast({ type: TOAST_TYPE.ERROR, title: t("references.peek.link_failed") });
    }
  };

  return (
    <>
      <Tooltip tooltipContent={t("references.peek.copy_link")}>
        <button
          type="button"
          onClick={() => void copy()}
          className={button}
          aria-label={t("references.peek.copy_link")}
        >
          <Link2 className={small ? "size-3.5" : "size-4"} />
        </button>
      </Tooltip>
      {onOpenInSection && (
        <Tooltip tooltipContent={t("references.peek.open_in_section")}>
          <button
            type="button"
            onClick={onOpenInSection}
            className={button}
            aria-label={t("references.peek.open_in_section")}
          >
            <ExternalLink className={small ? "size-3.5" : "size-4"} />
          </button>
        </Tooltip>
      )}
    </>
  );
}
