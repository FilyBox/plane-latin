/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect } from "react";
import { observer } from "mobx-react";
import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { FileCheck2, LayoutTemplate, Sparkles } from "lucide-react";
// plane imports
import type { IWorkspaceSidebarNavigationItem } from "@plane/constants";
import { EUserPermissionsLevel } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { ChevronRightIcon } from "@plane/propel/icons";
import { cn, joinUrlPath } from "@plane/utils";
// components
import { SidebarNavItem } from "@/components/sidebar/sidebar-navigation";
// hooks
import { useAppTheme } from "@/hooks/store/use-app-theme";
import { useUserPermissions } from "@/hooks/store/user";
import useLocalStorage from "@/hooks/use-local-storage";
import { useWorkspaceNavigationPreferences } from "@/hooks/use-navigation-preferences";
// plane web imports
import { getSidebarNavigationItemIcon } from "@/plane-web/components/workspace/sidebar/helper";

type Props = { item: IWorkspaceSidebarNavigationItem };

const CONTRACT_ROUTES = [
  {
    key: "analyzed",
    href: "/file-library/contracts/analyzed",
    labelKey: "file_library.contracts.workflow.navigation.ai_analysis",
    icon: Sparkles,
  },
  {
    key: "templates",
    href: "/file-library/contracts/templates",
    labelKey: "file_library.contracts.workflow.navigation.templates",
    icon: LayoutTemplate,
  },
  {
    key: "documents",
    href: "/file-library/contracts/documents",
    labelKey: "file_library.contracts.workflow.navigation.created",
    icon: FileCheck2,
  },
] as const;

export const ContractsSidebarItem = observer(function ContractsSidebarItem({ item }: Props) {
  const { t } = useTranslation();
  const pathname = usePathname();
  const { workspaceSlug } = useParams();
  const { allowPermissions } = useUserPermissions();
  const { isWorkspaceItemPinned } = useWorkspaceNavigationPreferences();
  const { toggleSidebar, isExtendedSidebarOpened, toggleExtendedSidebar } = useAppTheme();
  const { storedValue: isOpen, setValue: setIsOpen } = useLocalStorage<boolean>("is_contracts_menu_open", true);

  const slug = workspaceSlug?.toString() ?? "";
  const baseHref = joinUrlPath(slug, item.href);
  const isContractsPath = pathname.includes(`/${slug}/file-library/contracts`);

  useEffect(() => {
    if (isContractsPath && !isOpen) setIsOpen(true);
  }, [isContractsPath, isOpen, setIsOpen]);

  if (!allowPermissions(item.access, EUserPermissionsLevel.WORKSPACE, slug) || !isWorkspaceItemPinned(item.key))
    return null;

  const handleLinkClick = () => {
    if (window.innerWidth < 768) toggleSidebar();
    if (isExtendedSidebarOpened) toggleExtendedSidebar(false);
  };

  return (
    <div className="flex flex-col gap-0.5">
      <SidebarNavItem isActive={isContractsPath} className="pr-1">
        <Link href={baseHref} onClick={handleLinkClick} className="flex min-w-0 flex-1 items-center gap-1.5 py-px">
          {getSidebarNavigationItemIcon(item.key)}
          <span className="truncate text-13 leading-5 font-medium">{t(item.labelTranslationKey)}</span>
        </Link>
        <button
          type="button"
          className="grid size-5 shrink-0 place-items-center rounded-sm text-placeholder hover:bg-layer-1"
          aria-label={t(
            isOpen
              ? "file_library.contracts.workflow.navigation.collapse"
              : "file_library.contracts.workflow.navigation.expand"
          )}
          onClick={() => setIsOpen(!isOpen)}
        >
          <ChevronRightIcon className={cn("size-3 transition-transform", { "rotate-90": isOpen })} />
        </button>
      </SidebarNavItem>

      <div
        className={cn("grid transition-[grid-template-rows,opacity] duration-150", {
          "grid-rows-[1fr] opacity-100": isOpen,
          "pointer-events-none grid-rows-[0fr] opacity-0": !isOpen,
        })}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="ml-4 flex flex-col gap-0.5 border-l border-subtle pl-1.5">
            {CONTRACT_ROUTES.map((route) => {
              const href = joinUrlPath(slug, route.href);
              const Icon = route.icon;
              const isActive =
                route.key === "templates"
                  ? pathname.includes(href)
                  : pathname === href || pathname.startsWith(`${href}/`);
              return (
                <Link key={route.key} href={href} onClick={handleLinkClick}>
                  <SidebarNavItem isActive={isActive} className="py-1">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <Icon
                        className={cn("size-3.5 shrink-0", isActive ? "text-accent-primary" : "text-placeholder")}
                      />
                      <span className="truncate text-11 font-medium">{t(route.labelKey)}</span>
                    </div>
                  </SidebarNavItem>
                </Link>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
});
