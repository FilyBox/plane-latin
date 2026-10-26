/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useMemo, useState } from "react";
import { Check, ListChecks, Loader2, Plus, Search, Sparkles } from "lucide-react";
import { Link, useNavigate, useSearchParams } from "react-router";
import useSWR from "swr";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { cn } from "@plane/utils";
import { referencesService, taggingService } from "@/services/references.service";
import { TAG_KINDS, tagKindKey } from "../entity-meta";
import { TAG_KIND_ICONS } from "../shared-tag-chip";
import { MAX_COMBINED_TAGS } from "./combine-tags";
import { TagDetail } from "./tag-detail";

type Props = {
  workspaceSlug: string;
  tagId?: string;
  /** Opens the AI mapping panel (phase 4). */
  onMapWithAI?: () => void;
};

/** Every shared tag of the workspace on the left; on the right, everything
 * carrying the chosen one — contracts, files, songs, work items… — one step
 * from downloading it all. */
export function SharedTagsRoot({ workspaceSlug, tagId, onMapWithAI }: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  // Several tags at once: pick them, then see what carries all of them.
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [searchParams] = useSearchParams();
  const combined = new Set((searchParams.get("with") ?? "").split(",").filter(Boolean));
  const startSelecting = () => {
    setSelected(tagId ? [tagId, ...combined].slice(0, MAX_COMBINED_TAGS + 1) : []);
    setSelecting(true);
  };
  const toggle = (id: string) =>
    setSelected((current) => {
      if (current.includes(id)) return current.filter((value) => value !== id);
      // The open tag plus up to MAX_COMBINED_TAGS more.
      return current.length > MAX_COMBINED_TAGS ? current : [...current, id];
    });
  const openSelected = () => {
    const [first, ...rest] = selected;
    if (!first) return;
    setSelecting(false);
    navigate(`/${workspaceSlug}/tags/${first}${rest.length ? `?with=${rest.join(",")}&mode=all` : ""}`);
  };
  const { data: tags, isLoading } = useSWR(["SHARED_TAGS_USAGE", workspaceSlug], () =>
    referencesService.getTags(workspaceSlug, { usage: true })
  );
  // Proposals waiting for an admin (e.g. for files just uploaded).
  const { data: overview } = useSWR(onMapWithAI ? ["TAGGING_OVERVIEW", workspaceSlug] : null, () =>
    taggingService.overview(workspaceSlug)
  );
  const pendingReview = overview?.runs.some((run) => run.status === "REVIEW");

  const groups = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const visible = (tags ?? []).filter((tag) => !needle || tag.name.toLowerCase().includes(needle));
    return TAG_KINDS.map((kind) => ({
      kind,
      tags: visible.filter((tag) => tag.kind === kind).sort((a, b) => (b.usage ?? 0) - (a.usage ?? 0)),
    })).filter((group) => group.tags.length > 0);
  }, [search, tags]);

  // Desktop opens the most used tag right away instead of an empty pane.
  useEffect(() => {
    if (tagId || !tags?.length || window.innerWidth < 1024) return;
    const top = [...tags].sort((a, b) => (b.usage ?? 0) - (a.usage ?? 0))[0];
    if (top?.usage) navigate(`/${workspaceSlug}/tags/${top.id}`, { replace: true });
  }, [tagId, tags, navigate, workspaceSlug]);

  return (
    <div className="flex h-full min-h-0">
      <aside
        className={cn(
          "flex w-full shrink-0 flex-col border-r border-subtle lg:w-72",
          tagId ? "hidden lg:flex" : "flex"
        )}
      >
        <div className="space-y-2 border-b border-subtle p-3">
          <div className="relative">
            <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-tertiary" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("references.tags.search")}
              aria-label={t("references.tags.search")}
              className="h-8 w-full rounded-md border border-subtle bg-transparent pr-2 pl-8 text-13 outline-none focus:border-accent-strong"
            />
          </div>
          <Button
            variant={selecting ? "primary" : "ghost"}
            size="base"
            className="w-full"
            aria-pressed={selecting}
            onClick={() => (selecting ? setSelecting(false) : startSelecting())}
          >
            <ListChecks className="size-3.5" />
            {selecting ? t("references.tags.combine.cancel_select") : t("references.tags.combine.select_many")}
          </Button>
          {onMapWithAI && (
            <Button variant="secondary" size="base" className="w-full" onClick={onMapWithAI}>
              <Sparkles className="size-3.5" />
              {t("references.ai.open")}
              {pendingReview && (
                <span className="rounded-full bg-accent-primary px-1.5 text-11 font-medium text-on-color">
                  {t("references.ai.to_review")}
                </span>
              )}
            </Button>
          )}
        </div>
        <nav className="min-h-0 flex-1 overflow-y-auto p-2" aria-label={t("references.tags.title")}>
          {isLoading && <Loader2 className="mx-auto my-6 size-4 animate-spin text-tertiary" />}
          {!isLoading && groups.length === 0 && (
            <p className="px-2 py-6 text-center text-13 text-tertiary">{t("references.tags.empty")}</p>
          )}
          {groups.map(({ kind, tags: items }) => {
            const Icon = TAG_KIND_ICONS[kind];
            return (
              <section key={kind} className="mb-3">
                <h3 className="flex items-center gap-1.5 px-2 pb-1 text-11 font-medium text-tertiary">
                  <Icon className="size-3" aria-hidden />
                  {t(tagKindKey(kind))}
                </h3>
                <ul>
                  {items.map((tag) => (
                    <li key={tag.id}>
                      {selecting ? (
                        <label className="relative flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-13 text-secondary hover:bg-layer-1-hover has-[:focus-visible]:ring-1 has-[:focus-visible]:ring-accent-strong">
                          <input
                            type="checkbox"
                            checked={selected.includes(tag.id)}
                            onChange={() => toggle(tag.id)}
                            aria-label={t("references.tags.combine.select_tag", { name: tag.name })}
                            className="sr-only"
                          />
                          <span
                            className={cn(
                              "grid size-4 shrink-0 place-items-center rounded-sm border",
                              selected.includes(tag.id)
                                ? "border-accent-strong bg-accent-primary text-on-color"
                                : "border-strong"
                            )}
                            aria-hidden
                          >
                            {selected.includes(tag.id) && <Check className="size-3" />}
                          </span>
                          <span className="min-w-0 flex-1 truncate">{tag.name}</span>
                          <span className="text-11 text-tertiary tabular-nums">{tag.usage || ""}</span>
                        </label>
                      ) : (
                        <Link
                          to={`/${workspaceSlug}/tags/${tag.id}`}
                          aria-current={tag.id === tagId ? "page" : undefined}
                          className={cn(
                            "flex items-center gap-2 rounded-md px-2 py-1.5 text-13",
                            tag.id === tagId
                              ? "bg-layer-1 font-medium text-primary"
                              : combined.has(tag.id)
                                ? "bg-accent-subtle text-primary"
                                : "text-secondary hover:bg-layer-1-hover"
                          )}
                        >
                          {combined.has(tag.id) && tag.id !== tagId && (
                            <Plus
                              className="size-3 shrink-0 text-accent-primary"
                              aria-label={t("references.tags.combine.combined")}
                            />
                          )}
                          <span className="min-w-0 flex-1 truncate">{tag.name}</span>
                          <span className="text-11 text-tertiary tabular-nums">{tag.usage || ""}</span>
                        </Link>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </nav>
        {selecting && (
          <div className="space-y-2 border-t border-subtle p-3">
            <p className="text-12 text-tertiary" aria-live="polite">
              {t("references.tags.combine.selected", { count: selected.length })}
            </p>
            <Button variant="primary" size="base" className="w-full" disabled={!selected.length} onClick={openSelected}>
              {t("references.tags.combine.view_selected")}
            </Button>
          </div>
        )}
      </aside>
      <main className={cn("min-w-0 flex-1", tagId ? "block" : "hidden lg:block")}>
        {tagId ? (
          <TagDetail key={tagId} workspaceSlug={workspaceSlug} tagId={tagId} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <p className="text-15 font-medium text-primary">{t("references.tags.pick_title")}</p>
            <p className="mt-1 max-w-sm text-13 text-tertiary">{t("references.tags.pick_body")}</p>
          </div>
        )}
      </main>
    </div>
  );
}
