/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useMemo, useState } from "react";
import { Download, Loader2, Search } from "lucide-react";
import { useSearchParams } from "react-router";
import useSWR from "swr";
import useSWRInfinite from "swr/infinite";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type {
  TEntityCard,
  TEntityName,
  TSharedTag,
  TSharedTagEntities,
  TSharedTagFilters,
  TSharedTagMode,
} from "@plane/types";
import { cn } from "@plane/utils";
import useDebounce from "@/hooks/use-debounce";
import { referencesService } from "@/services/references.service";
import { ENTITY_ICONS, ENTITY_ORDER, entityGroupKey, tagKindKey } from "../entity-meta";
import { EntityRow } from "../entity-row";
import { SharedTagChip, TAG_KIND_ICONS } from "../shared-tag-chip";
import { AskAssistantButton } from "@/components/assistant/ask";
import { CombineTags, MAX_COMBINED_TAGS } from "./combine-tags";

/** Items shown per type in "All"; each group links to its full list. */
const PREVIEW = 8;
/** Items fetched per page once a single type is chosen. */
const PAGE = 50;

type TDateMode = "any" | "custom" | `${number}`;

const FIELD =
  "h-8 rounded-md border border-subtle bg-transparent px-2 text-13 text-primary outline-none focus:border-accent-strong";
/** Tag chips shown under an item before "+N". */
const ROW_CHIPS = 3;

/** An item's other tags, on their own line under its title so a long tag
 * never squeezes the name: a few chips, then "+N" for the rest. */
function RowTagChips({ tags }: { tags: TSharedTag[] }) {
  const [expanded, setExpanded] = useState(false);
  if (tags.length === 0) return null;
  const shown = expanded ? tags : tags.slice(0, ROW_CHIPS);
  const hidden = tags.slice(ROW_CHIPS);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1 pr-3 pb-1.5 pl-[2.875rem]">
      {shown.map((tag) => (
        <SharedTagChip key={tag.id} tag={tag} className="max-w-56" />
      ))}
      {!expanded && hidden.length > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          title={hidden.map((tag) => tag.name).join(", ")}
          className="inline-flex h-5 items-center rounded-sm border border-subtle px-1.5 text-body-xs-regular text-secondary hover:bg-layer-1-hover"
        >
          +{hidden.length}
        </button>
      )}
    </div>
  );
}

/** Everything carrying one tag — contracts, files, songs, work items… —
 * searchable, narrowable by date, and one step from downloading. */
export function TagDetail({ workspaceSlug, tagId }: { workspaceSlug: string; tagId: string }) {
  const { t, currentLocale } = useTranslation();
  // Other tags combined with this one live in the URL (?with=a,b&mode=all),
  // so a combination can be shared and back/forward steps through it.
  const [searchParams, setSearchParams] = useSearchParams();
  const withParam = searchParams.get("with") ?? "";
  const withIds = useMemo(
    () => [...new Set(withParam.split(",").filter((id) => id && id !== tagId))].slice(0, MAX_COMBINED_TAGS),
    [withParam, tagId]
  );
  const mode: TSharedTagMode = searchParams.get("mode") === "any" ? "any" : "all";
  const combining = withIds.length > 0;
  const combination = useMemo(() => (combining ? { with: withIds, mode } : {}), [combining, withIds, mode]);
  const combineKey = combining ? `${withIds.join(",")}|${mode}` : "";
  const setCombination = (ids: string[], nextMode: TSharedTagMode) => {
    const next = new URLSearchParams(searchParams);
    if (ids.length) {
      next.set("with", ids.join(","));
      next.set("mode", nextMode);
    } else {
      next.delete("with");
      next.delete("mode");
    }
    setSearchParams(next);
  };
  const [type, setType] = useState<TEntityName | "all">("all");
  const [kindTag, setKindTag] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  // Narrowing within the tag: one song, a year of releases…
  const [query, setQuery] = useState("");
  const [dateMode, setDateMode] = useState<TDateMode>("any");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const debouncedQuery = useDebounce(query.trim(), 300);

  const filters = useMemo<TSharedTagFilters>(() => {
    let range: TSharedTagFilters = {};
    if (dateMode === "custom") range = { date_from: from || undefined, date_to: to || undefined };
    else if (dateMode !== "any") range = { date_from: `${dateMode}-01-01`, date_to: `${dateMode}-12-31` };
    return { q: debouncedQuery || undefined, ...range };
  }, [debouncedQuery, dateMode, from, to]);
  const filtering = Boolean(filters.q || filters.date_from || filters.date_to);
  const filterKey = [filters.q ?? "", filters.date_from ?? "", filters.date_to ?? ""].join("|");

  // Counts for every type plus a short preview of each.
  const { data, isValidating } = useSWR(
    ["SHARED_TAG_ENTITIES", workspaceSlug, tagId, filterKey, combineKey],
    () => referencesService.getTagEntities(workspaceSlug, tagId, { ...filters, ...combination, limit: PREVIEW }),
    { keepPreviousData: true }
  );

  // One type chosen: its full list, a page at a time.
  const pages = useSWRInfinite(
    (index, previous: TSharedTagEntities | null) => {
      if (type === "all") return null;
      if (previous && index * PAGE >= (previous.groups[type]?.count ?? 0)) return null;
      return ["SHARED_TAG_ENTITIES_PAGE", workspaceSlug, tagId, type, filterKey, combineKey, index] as const;
    },
    ([, , , entityName, , , index]) =>
      referencesService.getTagEntities(workspaceSlug, tagId, {
        ...filters,
        ...combination,
        types: [entityName],
        offset: index * PAGE,
        limit: PAGE,
      }),
    { revalidateFirstPage: false }
  );

  const counts = (name: TEntityName) => data?.groups[name]?.count ?? 0;
  const types = ENTITY_ORDER.filter((name) => counts(name) > 0 || name === type);
  const total = ENTITY_ORDER.reduce((sum, name) => sum + counts(name), 0);

  // The unfiltered total, kept while filters narrow the list.
  const [baseTotal, setBaseTotal] = useState<number | null>(null);
  useEffect(() => {
    if (data && !filtering) setBaseTotal(total);
  }, [data, filtering, total]);
  // The tags applied, as the server resolved them (deleted ones drop out).
  const withTags = data?.with_tags ?? [];
  // Chips of the tags being browsed say nothing new on each item.
  const browsing = useMemo(() => new Set([tagId, ...withIds]), [tagId, withIds]);
  // Years arrive with answers not narrowed by date; keep them while a year
  // is picked so the choices do not collapse to that one year.
  const [years, setYears] = useState<number[]>([]);
  useEffect(() => {
    if (data?.years && !filters.date_from && !filters.date_to) setYears(data.years);
  }, [data, filters.date_from, filters.date_to]);

  const typedItems = useMemo(
    () => (type === "all" ? [] : (pages.data ?? []).flatMap((page) => page.groups[type]?.items ?? [])),
    [pages.data, type]
  );
  const typedCount = type === "all" ? 0 : (pages.data?.[0]?.groups[type]?.count ?? counts(type));

  // "What it is" tags carried by the items on screen: cover art, service
  // contract… — a quick second way to narrow the list.
  const kindTags = useMemo(() => {
    const cards = type === "all" ? ENTITY_ORDER.flatMap((name) => data?.groups[name]?.items ?? []) : typedItems;
    const found = new Map<string, { tag: TSharedTag; count: number }>();
    for (const card of cards) {
      for (const tag of card.tags ?? []) {
        if (browsing.has(tag.id) || tag.kind !== "TYPE") continue;
        const entry = found.get(tag.id) ?? { tag, count: 0 };
        entry.count += 1;
        found.set(tag.id, entry);
      }
    }
    return [...found.values()].sort((a, b) => b.count - a.count);
  }, [data, typedItems, type, browsing]);

  const byKind = (card: TEntityCard) => !kindTag || (card.tags ?? []).some((tag) => tag.id === kindTag);
  const shownGroups =
    type === "all"
      ? types.map((name) => ({ name, count: counts(name), items: (data?.groups[name]?.items ?? []).filter(byKind) }))
      : [{ name: type, count: typedCount, items: typedItems.filter(byKind) }];
  const nothingShown = shownGroups.every((group) => group.items.length === 0);
  const loadingList = type === "all" ? !data : pages.isLoading;

  const chooseType = (name: TEntityName | "all") => {
    setType(name);
    setKindTag(null);
  };

  const clearFilters = () => {
    setQuery("");
    setDateMode("any");
    setFrom("");
    setTo("");
    setKindTag(null);
  };

  const formatDate = (value: string) => {
    const parsed = new Date(`${value.slice(0, 10)}T00:00:00`);
    return Number.isNaN(parsed.getTime())
      ? ""
      : parsed.toLocaleDateString(currentLocale, { day: "numeric", month: "short", year: "numeric" });
  };

  const download = async () => {
    setExporting(true);
    try {
      const { export_id } = await referencesService.exportTag(
        workspaceSlug,
        tagId,
        type === "all" ? undefined : [type],
        { ...filters, ...combination }
      );
      setToast({ type: TOAST_TYPE.INFO, title: t("references.export.started") });
      for (let attempt = 0; attempt < 150; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 2000));
        // eslint-disable-next-line no-await-in-loop
        const job = await referencesService.getTagExport(workspaceSlug, tagId, export_id);
        if (job.status === "completed" && job.url) {
          window.location.assign(job.url);
          setToast({ type: TOAST_TYPE.SUCCESS, title: t("references.export.ready") });
          return;
        }
        if (job.status === "failed") throw new Error(job.reason ?? "failed");
      }
    } catch {
      setToast({ type: TOAST_TYPE.ERROR, title: t("references.export.failed") });
    } finally {
      setExporting(false);
    }
  };

  if (!data) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="size-5 animate-spin text-tertiary" />
      </div>
    );
  }

  const KindIcon = TAG_KIND_ICONS[data.tag.kind];
  let exportLabel = t("references.export.all");
  if (filtering || combining) exportLabel = t("references.export.filtered");
  else if (type !== "all") exportLabel = t("references.export.type", { type: t(entityGroupKey(type)) });
  const heading = [data.tag.name, ...withTags.map((tag) => tag.name)].join(
    mode === "any" ? t("references.tags.combine.or") : " + "
  );
  const searchLabel = t("references.tags.search_in", { name: heading });

  return (
    <div className="h-full overflow-y-auto">
      <header className="flex flex-wrap items-start justify-between gap-4 px-6 pt-6 pb-3">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-12 text-tertiary">
            <KindIcon className="size-3.5" aria-hidden />
            {t(tagKindKey(data.tag.kind))}
          </p>
          <h1 className="mt-1 truncate text-20 font-semibold text-primary" title={heading}>
            {heading}
          </h1>
          <p className="mt-0.5 text-13 text-secondary" aria-live="polite">
            {filtering && baseTotal !== null
              ? t("references.tags.matching", { count: total, total: baseTotal })
              : t("references.tags.total", { count: total })}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <AskAssistantButton
            mentions={[data.tag, ...withTags].map((tag) => ({ type: "tag", id: tag.id, label: tag.name }))}
            className="py-1.5"
          />
          <Button
            variant="primary"
            size="lg"
            loading={exporting}
            disabled={(type === "all" ? total : typedCount) === 0}
            onClick={() => void download()}
          >
            <Download className="size-3.5" />
            {exportLabel}
          </Button>
        </div>
      </header>

      {((baseTotal ?? total) > 0 || combining) && (
        <div className="flex flex-wrap items-center gap-2 px-6 pb-3">
          <div className="relative min-w-48 flex-1 sm:max-w-sm">
            <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-tertiary" aria-hidden />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={searchLabel}
              aria-label={searchLabel}
              className={cn(FIELD, "w-full pl-8")}
            />
          </div>
          <select
            value={dateMode}
            onChange={(event) => setDateMode(event.target.value as TDateMode)}
            aria-label={t("references.tags.date_label")}
            title={t("references.tags.date_help")}
            className={cn(FIELD, "pr-7")}
          >
            <option value="any">{t("references.tags.any_date")}</option>
            {years.map((year) => (
              <option key={year} value={String(year)}>
                {year}
              </option>
            ))}
            <option value="custom">{t("references.tags.custom_range")}</option>
          </select>
          {dateMode === "custom" && (
            <span className="flex items-center gap-1.5">
              <input
                type="date"
                value={from}
                max={to || undefined}
                onChange={(event) => setFrom(event.target.value)}
                aria-label={t("references.tags.from")}
                className={FIELD}
              />
              <span className="text-12 text-tertiary" aria-hidden>
                –
              </span>
              <input
                type="date"
                value={to}
                min={from || undefined}
                onChange={(event) => setTo(event.target.value)}
                aria-label={t("references.tags.to")}
                className={FIELD}
              />
            </span>
          )}
          <CombineTags
            workspaceSlug={workspaceSlug}
            tagId={tagId}
            withTags={withTags}
            mode={mode}
            onChange={setCombination}
          />
          {(query || dateMode !== "any" || kindTag) && (
            <Button variant="ghost" size="base" onClick={clearFilters}>
              {t("references.tags.clear")}
            </Button>
          )}
          {isValidating && <Loader2 className="size-3.5 animate-spin text-tertiary" aria-hidden />}
        </div>
      )}

      {(total > 0 || type !== "all") && (
        // The counts are the summary and the filter at once.
        <div className="flex gap-1 overflow-x-auto border-y border-subtle px-5 py-2" role="tablist">
          {(["all", ...types] as const).map((name) => {
            const Icon = name === "all" ? null : ENTITY_ICONS[name];
            const count = name === "all" ? total : counts(name);
            return (
              <button
                key={name}
                type="button"
                role="tab"
                aria-selected={type === name}
                onClick={() => chooseType(name)}
                className={cn(
                  "flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-13",
                  type === name ? "bg-layer-1 font-medium text-primary" : "text-tertiary hover:text-primary"
                )}
              >
                {Icon && <Icon className="size-3.5" aria-hidden />}
                {name === "all" ? t("references.picker.all") : t(entityGroupKey(name))}
                <span className="text-12 text-tertiary tabular-nums">{count}</span>
              </button>
            );
          })}
        </div>
      )}

      {kindTags.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 px-6 pt-3">
          <span className="text-12 text-tertiary">{t("references.tags.narrow")}</span>
          {kindTags.map(({ tag, count }) => (
            <button
              key={tag.id}
              type="button"
              aria-pressed={kindTag === tag.id}
              onClick={() => setKindTag(kindTag === tag.id ? null : tag.id)}
              className={cn(
                "inline-flex h-6 items-center gap-1 rounded-md border px-2 text-12",
                kindTag === tag.id
                  ? "border-accent-strong bg-accent-subtle text-primary"
                  : "border-subtle text-secondary hover:bg-layer-1-hover"
              )}
            >
              {tag.name}
              <span className="text-tertiary tabular-nums">{count}</span>
            </button>
          ))}
        </div>
      )}

      <div className="space-y-6 px-6 py-4">
        {loadingList && <Loader2 className="mx-auto my-6 size-4 animate-spin text-tertiary" />}
        {!loadingList && nothingShown && !filtering && !kindTag && combining && mode === "all" && (
          <div className="flex flex-col items-center py-10 text-center">
            <p className="text-13 text-tertiary">{t("references.tags.combine.nothing_all")}</p>
            <Button variant="secondary" size="base" className="mt-3" onClick={() => setCombination(withIds, "any")}>
              {t("references.tags.combine.switch_any")}
            </Button>
          </div>
        )}
        {!loadingList && nothingShown && !filtering && !kindTag && !(combining && mode === "all") && (
          <p className="py-10 text-center text-13 text-tertiary">{t("references.tags.nothing_tagged")}</p>
        )}
        {!loadingList && nothingShown && (filtering || kindTag) && (
          <div className="flex flex-col items-center py-10 text-center">
            <p className="text-13 text-tertiary">{t("references.tags.no_matches")}</p>
            <Button variant="secondary" size="base" className="mt-3" onClick={clearFilters}>
              {t("references.tags.clear")}
            </Button>
          </div>
        )}
        {shownGroups
          .filter((group) => group.items.length > 0)
          .map((group) => (
            <section key={group.name}>
              {type === "all" && (
                <h2 className="mb-1.5 flex items-baseline gap-2 text-13 font-medium text-primary">
                  {t(entityGroupKey(group.name))}
                  <span className="font-normal text-12 text-tertiary tabular-nums">{group.count}</span>
                </h2>
              )}
              <ul className="divide-y divide-subtle rounded-md border border-subtle">
                {group.items.map((card) => (
                  <li key={card.id}>
                    {/* The title gets the row; only the date shares it. */}
                    <div className="flex items-center gap-3 pr-3">
                      <EntityRow card={card} showType={false} className="min-w-0 flex-1" />
                      {card.date && (
                        <time
                          dateTime={card.date}
                          className="w-24 shrink-0 text-right text-12 text-tertiary tabular-nums"
                        >
                          {formatDate(card.date)}
                        </time>
                      )}
                    </div>
                    <RowTagChips tags={(card.tags ?? []).filter((tag) => !browsing.has(tag.id))} />
                  </li>
                ))}
              </ul>
              {type === "all" && group.count > group.items.length && !kindTag && (
                <button
                  type="button"
                  onClick={() => chooseType(group.name)}
                  className="mt-1.5 text-12 font-medium text-accent-primary hover:underline"
                >
                  {t("references.tags.see_all", { count: group.count })}
                </button>
              )}
              {type !== "all" && (
                <div className="mt-2 flex items-center gap-3">
                  <span className="text-12 text-tertiary">
                    {t("references.tags.showing", { shown: typedItems.length, count: group.count })}
                  </span>
                  {typedItems.length < group.count && (
                    <Button
                      variant="secondary"
                      size="sm"
                      loading={pages.isValidating}
                      onClick={() => void pages.setSize(pages.size + 1)}
                    >
                      {t("references.tags.load_more")}
                    </Button>
                  )}
                </div>
              )}
            </section>
          ))}

        {data.mentioned_in.length > 0 && type === "all" && !kindTag && !filtering && !combining && (
          <section>
            <h2 className="mb-1.5 text-13 font-medium text-primary">{t("references.tags.mentioned_in")}</h2>
            <ul className="divide-y divide-subtle rounded-md border border-subtle">
              {data.mentioned_in.map((card) => (
                <li key={`${card.entity_name}:${card.id}`}>
                  <EntityRow card={card} />
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
