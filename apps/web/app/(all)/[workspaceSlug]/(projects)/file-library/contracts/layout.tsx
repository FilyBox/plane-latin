/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { FileCheck2, LayoutTemplate, Sparkles } from "lucide-react";
import { observer } from "mobx-react";
import { Link, Navigate, Outlet, useLocation, useParams } from "react-router";
import { cn } from "@plane/utils";
import { useWorkspace } from "@/hooks/store/use-workspace";

const ContractsLayout = observer(function ContractsLayout() {
  const { workspaceSlug } = useParams();
  const { pathname } = useLocation();
  const { isWorkspaceFeatureEnabled, featureFlagsMap } = useWorkspace();
  const areFlagsLoaded = workspaceSlug ? featureFlagsMap[workspaceSlug] !== undefined : false;
  const isFileLibraryEnabled = workspaceSlug ? isWorkspaceFeatureEnabled(workspaceSlug, "file_library") : false;

  if (workspaceSlug && areFlagsLoaded && !isFileLibraryEnabled) return <Navigate to={`/${workspaceSlug}`} replace />;
  const items = [
    {
      href: `/${workspaceSlug}/file-library/contracts/analyzed`,
      label: "Analizados con IA",
      icon: Sparkles,
      active: pathname.includes("/contracts/analyzed"),
    },
    {
      href: `/${workspaceSlug}/file-library/contracts/templates`,
      label: "Plantillas",
      icon: LayoutTemplate,
      active: pathname.includes("/contracts/templates"),
    },
    {
      href: `/${workspaceSlug}/file-library/contracts/documents`,
      label: "Contratos creados",
      icon: FileCheck2,
      active: pathname.includes("/contracts/documents"),
    },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-1 md:flex-row">
      <aside className="shrink-0 border-b border-subtle bg-layer-1 p-2 md:w-52 md:border-r md:border-b-0 md:p-3">
        <p className="hidden px-2 pb-2 text-9 font-semibold tracking-wide text-tertiary uppercase md:block">
          Contratos
        </p>
        <nav className="flex gap-1 overflow-x-auto md:flex-col md:overflow-visible">
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                to={item.href}
                className={cn(
                  "flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-11 font-medium transition-colors",
                  item.active
                    ? "shadow-sm bg-surface-1 text-primary"
                    : "text-secondary hover:bg-layer-1-hover hover:text-primary"
                )}
              >
                <Icon className={cn("size-4", item.active ? "text-accent-primary" : "text-tertiary")} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>
      </aside>
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <Outlet />
      </div>
    </div>
  );
});

export default ContractsLayout;
