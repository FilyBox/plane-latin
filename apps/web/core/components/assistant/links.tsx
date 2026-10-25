/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * Links inside the assistant open in the app (router, no reload). A contract,
 * song, release or expense opens its panel right where the user is instead
 * of leaving the page. On phones the panel covers the screen, so following a
 * link also closes it.
 */

import type { ComponentProps, MouseEvent } from "react";
import { useCallback } from "react";
import { parsePeekHref } from "@/components/entity-peek/routes";
import { useEntityPeek } from "@/components/entity-peek/use-entity-peek";
import { useAppRouter } from "@/hooks/use-app-router";
import { useAppTheme } from "@/hooks/store/use-app-theme";
import { cn } from "@plane/utils";

// Below desktop the panel lies over the page: following a link closes it.
const MOBILE_QUERY = "(max-width: 1023px)";

export function useAssistantNavigate() {
  const router = useAppRouter();
  const { toggleAssistantPanel } = useAppTheme();
  const { open } = useEntityPeek();
  return useCallback(
    (path: string) => {
      const target = parsePeekHref(path);
      if (target) open(target);
      else router.push(path);
      if (typeof window !== "undefined" && window.matchMedia(MOBILE_QUERY).matches) toggleAssistantPanel(false);
    },
    [router, toggleAssistantPanel, open]
  );
}

const isInternal = (href?: string) => Boolean(href && href.startsWith("/") && !href.startsWith("//"));

/** <a> that routes inside the app for "/…" paths and opens others in a new tab. */
export function AssistantLink({ href, className, onClick, children, ...props }: ComponentProps<"a">) {
  const navigate = useAssistantNavigate();
  const internal = isInternal(href);
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (!internal || !href || event.defaultPrevented) return;
    // Let modified clicks (new tab) behave like a normal link.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    navigate(href);
  };
  return (
    <a
      {...props}
      href={href}
      onClick={handleClick}
      target={internal ? undefined : "_blank"}
      rel={internal ? undefined : "noopener noreferrer"}
      className={cn("text-accent-primary hover:underline", className)}
    >
      {children}
    </a>
  );
}
