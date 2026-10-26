/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * "Obras incluidas": the songs and releases a contract covers. Linked works
 * first (rights type, open in place, remove), then what the AI found in the
 * document, to confirm or dismiss. A work the AI read that is not in the
 * catalog yet can be added to it and linked from here.
 */

import { useState } from "react";
import { Check, Loader2, Plus, Search, Sparkles, X } from "lucide-react";
import { Link } from "react-router";
import useSWR from "swr";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import { Tooltip } from "@plane/propel/tooltip";
import type {
  TContractWorkEntityType,
  TContractWorkEvidence,
  TContractWorkLink,
  TContractWorkRightsType,
} from "@plane/types";
import { cn } from "@plane/utils";
import { usePeekLinkClick } from "@/components/entity-peek/use-entity-peek";
import { ENTITY_ICONS, entityLabelKey } from "@/components/references/entity-meta";
import { contractWorksService, isNotFound } from "@/services/contract-works.service";
import { ContractWorksPickerModal } from "./works-picker-modal";
import {
  ConfidenceChip,
  EvidenceTip,
  WorkRightsSelect,
  artistsText,
  contractWorksKey,
  refreshWorkLinks,
} from "./works-shared";

type Props = {
  workspaceSlug: string;
  contractId: string;
  canEdit: boolean;
  /** Scrolls the PDF to where the AI read the work */
  onSeeEvidence?: (evidence: TContractWorkEvidence) => void;
  /** The panel's Escape must not close it while the picker is open */
  onPickerOpenChange?: (open: boolean) => void;
};

const FIELD =
  "w-full rounded-sm border border-subtle bg-transparent px-2 py-1 text-12 text-primary outline-none focus:border-accent-strong";

/** Linked works rendered per step; past SEARCH_THRESHOLD the filter shows */
const PAGE_SIZE = 20;
const SEARCH_THRESHOLD = 10;
const SUGGESTIONS_PAGE = 10;

const normalizeSearch = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();

/** Title, artists and codes of a link, for the filter box */
const searchText = (link: TContractWorkLink) =>
  normalizeSearch(
    [
      link.entity?.title,
      link.entity?.subtitle,
      link.entity?.isrc,
      link.entity?.upc,
      link.suggested?.title,
      artistsText(link.suggested?.artists),
      link.suggested?.isrc,
    ]
      .filter(Boolean)
      .join(" ")
  );

function WorkThumb({ link }: { link: TContractWorkLink }) {
  const Icon = ENTITY_ICONS[link.entity_type] ?? ENTITY_ICONS.music_track;
  if (link.entity?.cover_url)
    return <img src={link.entity.cover_url} alt="" className="size-8 shrink-0 rounded-sm object-cover" />;
  return (
    <span className="grid size-8 shrink-0 place-items-center rounded-sm bg-layer-1">
      <Icon className="size-3.5 text-secondary" />
    </span>
  );
}

/** Small prefilled form: add the work to the catalog as a draft song and link it */
function CreateInCatalogForm({
  link,
  onDone,
  onCancel,
  workspaceSlug,
}: {
  link: TContractWorkLink;
  onDone: () => void;
  onCancel: () => void;
  workspaceSlug: string;
}) {
  const { t } = useTranslation();
  const [title, setTitle] = useState(link.suggested?.title ?? "");
  const [artists, setArtists] = useState(artistsText(link.suggested?.artists));
  const [isrc, setIsrc] = useState(link.suggested?.isrc ?? "");
  const [isSaving, setIsSaving] = useState(false);

  const submit = async () => {
    if (!title.trim()) return;
    setIsSaving(true);
    try {
      await contractWorksService.createInCatalog(workspaceSlug, link.id, {
        title: title.trim(),
        artists: artists.trim() || undefined,
        isrc: isrc.trim() || undefined,
      });
      setToast({ type: TOAST_TYPE.SUCCESS, title: t("file_library.contracts.works.created_in_catalog") });
      onDone();
    } catch {
      setToast({ type: TOAST_TYPE.ERROR, title: t("file_library.contracts.works.action_failed") });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="mt-1.5 space-y-1.5 rounded-md border border-subtle bg-layer-1/50 p-2">
      <p className="text-11 text-tertiary">{t("file_library.contracts.works.create_hint")}</p>
      <input
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder={t("file_library.contracts.works.fields.title")}
        aria-label={t("file_library.contracts.works.fields.title")}
        className={FIELD}
      />
      <div className="grid grid-cols-1 gap-1.5 @sm:grid-cols-2">
        <input
          value={artists}
          onChange={(event) => setArtists(event.target.value)}
          placeholder={t("file_library.contracts.works.fields.artists")}
          aria-label={t("file_library.contracts.works.fields.artists")}
          className={FIELD}
        />
        <input
          value={isrc}
          onChange={(event) => setIsrc(event.target.value)}
          placeholder="ISRC"
          aria-label="ISRC"
          className={cn(FIELD, "font-mono")}
        />
      </div>
      <div className="flex justify-end gap-1.5">
        <Button variant="secondary" size="sm" onClick={onCancel} disabled={isSaving}>
          {t("cancel")}
        </Button>
        <Button variant="primary" size="sm" onClick={() => void submit()} loading={isSaving} disabled={!title.trim()}>
          {t("file_library.contracts.works.create_and_link")}
        </Button>
      </div>
    </div>
  );
}

export function ContractWorksSection({ workspaceSlug, contractId, canEdit, onSeeEvidence, onPickerOpenChange }: Props) {
  const { t } = useTranslation();
  const openInPlace = usePeekLinkClick();
  const [isPickerOpen, setPickerOpen] = useState(false);
  const setIsPickerOpen = (open: boolean) => {
    setPickerOpen(open);
    onPickerOpenChange?.(open);
  };
  const [busyId, setBusyId] = useState<string | null>(null);
  const [creatingId, setCreatingId] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [linkedLimit, setLinkedLimit] = useState(PAGE_SIZE);
  const [suggestionsLimit, setSuggestionsLimit] = useState(SUGGESTIONS_PAGE);

  const { data, error, mutate } = useSWR(contractWorksKey(contractId), () =>
    contractWorksService.getContractWorks(workspaceSlug, contractId)
  );

  // Backend without the feature yet: no section at all
  if (error && isNotFound(error)) return null;

  const links = data?.links ?? [];
  const linked = links.filter((link) => link.status === "LINKED");
  const suggested = links.filter((link) => link.status === "SUGGESTED");
  const linkedKeys = linked.filter((link) => link.entity_id).map((link) => `${link.entity_type}:${link.entity_id}`);
  // A contract can cover hundreds of works: past a few, a filter box, the
  // count per kind, and rows rendered a page at a time
  const isLong = linked.length > SEARCH_THRESHOLD;
  const needle = normalizeSearch(filter);
  const matching = needle ? linked.filter((link) => searchText(link).includes(needle)) : linked;
  const shownLinked = matching.slice(0, linkedLimit);
  const songCount = linked.filter((link) => link.entity_type === "music_track").length;
  const shownSuggested = suggested.slice(0, suggestionsLimit);

  const afterChange = async () => {
    await mutate();
    void refreshWorkLinks();
  };

  const run = async (linkId: string, action: () => Promise<unknown>, successKey?: string) => {
    setBusyId(linkId);
    try {
      await action();
      await afterChange();
      if (successKey) setToast({ type: TOAST_TYPE.SUCCESS, title: t(successKey) });
    } catch {
      setToast({ type: TOAST_TYPE.ERROR, title: t("file_library.contracts.works.action_failed") });
    } finally {
      setBusyId(null);
    }
  };

  const setRights = (link: TContractWorkLink, rights: TContractWorkRightsType | null) => {
    // Shown at once; reverted by the refetch if the save fails
    void mutate(
      (current) =>
        current && {
          links: current.links.map((item) => (item.id === link.id ? { ...item, rights_type: rights } : item)),
        },
      { revalidate: false }
    );
    void run(link.id, () => contractWorksService.updateLink(workspaceSlug, link.id, { rights_type: rights }));
  };

  const addWorks = async (
    items: { entity_type: TContractWorkEntityType; entity_id: string }[],
    rightsType: TContractWorkRightsType | null
  ) => {
    try {
      await contractWorksService.linkWorks(
        workspaceSlug,
        contractId,
        items.map((item) => ({ ...item, rights_type: rightsType }))
      );
      await afterChange();
      setToast({
        type: TOAST_TYPE.SUCCESS,
        title: t("file_library.contracts.works.linked_count", { count: items.length }),
      });
    } catch (failure) {
      setToast({ type: TOAST_TYPE.ERROR, title: t("file_library.contracts.works.action_failed") });
      throw failure;
    }
  };

  const titleOf = (link: TContractWorkLink) =>
    link.restricted ? t("references.restricted") : link.entity?.title || link.suggested?.title || "—";
  const subtitleOf = (link: TContractWorkLink) => link.entity?.subtitle || artistsText(link.suggested?.artists);

  const linkedRow = (link: TContractWorkLink) => {
    const path = link.entity?.path;
    const body = (
      <>
        <WorkThumb link={link} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-13 text-primary">{titleOf(link)}</span>
          <span className="block truncate text-11 text-tertiary">
            {[t(entityLabelKey(link.entity_type)), subtitleOf(link)].filter(Boolean).join(" · ")}
          </span>
        </span>
      </>
    );
    return (
      <li key={link.id} className="group flex items-center gap-2 px-2 py-1.5">
        {path && link.entity_id ? (
          <Link
            to={path}
            onClick={(event) => openInPlace(event, { entity_name: link.entity_type, id: link.entity_id! })}
            className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md hover:bg-layer-1-hover"
          >
            {body}
          </Link>
        ) : (
          <span className="flex min-w-0 flex-1 items-center gap-2.5">{body}</span>
        )}
        <WorkRightsSelect
          value={link.rights_type}
          onChange={(value) => setRights(link, value)}
          disabled={!canEdit || busyId === link.id}
          className="max-w-32 shrink-0"
        />
        {canEdit && (
          <Tooltip tooltipContent={t("file_library.contracts.works.remove")}>
            <button
              type="button"
              onClick={() =>
                void run(
                  link.id,
                  () => contractWorksService.deleteLink(workspaceSlug, link.id),
                  "file_library.contracts.works.removed"
                )
              }
              disabled={busyId === link.id}
              aria-label={t("file_library.contracts.works.remove")}
              className="rounded-sm p-1 text-tertiary opacity-0 group-hover:opacity-100 hover:bg-layer-1-hover hover:text-primary focus-visible:opacity-100 disabled:opacity-50"
            >
              {busyId === link.id ? <Loader2 className="size-3.5 animate-spin" /> : <X className="size-3.5" />}
            </button>
          </Tooltip>
        )}
      </li>
    );
  };

  const suggestionRow = (link: TContractWorkLink) => {
    const inCatalog = !!link.entity_id;
    const busy = busyId === link.id;
    const evidence = link.evidence;
    return (
      <li key={link.id} className="px-2 py-1.5">
        <div className="flex items-center gap-2">
          <Sparkles className="size-3.5 shrink-0 text-accent-primary" aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-1.5">
              {inCatalog && link.entity?.path ? (
                <Link
                  to={link.entity.path}
                  onClick={(event) => openInPlace(event, { entity_name: link.entity_type, id: link.entity_id! })}
                  className="truncate text-13 text-primary hover:underline"
                >
                  {titleOf(link)}
                </Link>
              ) : (
                <span className="truncate text-13 text-primary">{titleOf(link)}</span>
              )}
              <ConfidenceChip value={link.confidence} />
              <EvidenceTip
                evidence={evidence}
                onClick={onSeeEvidence && evidence ? () => onSeeEvidence(evidence) : undefined}
              />
            </span>
            <span className="block truncate text-11 text-tertiary">
              {[
                inCatalog ? t(entityLabelKey(link.entity_type)) : t("file_library.contracts.works.not_in_catalog"),
                subtitleOf(link),
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </span>
          {canEdit && (
            <span className="flex shrink-0 items-center gap-1">
              {inCatalog ? (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      link.id,
                      () => contractWorksService.updateLink(workspaceSlug, link.id, { status: "LINKED" }),
                      "file_library.contracts.works.confirmed"
                    )
                  }
                >
                  {busy ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
                  {t("file_library.contracts.works.confirm")}
                </Button>
              ) : (
                creatingId !== link.id && (
                  <Button variant="secondary" size="sm" disabled={busy} onClick={() => setCreatingId(link.id)}>
                    <Plus className="size-3" />
                    {t("file_library.contracts.works.add_to_catalog")}
                  </Button>
                )
              )}
              <Button
                variant="tertiary"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void run(link.id, () =>
                    contractWorksService.updateLink(workspaceSlug, link.id, { status: "DISMISSED" })
                  )
                }
              >
                {t("file_library.contracts.works.dismiss")}
              </Button>
            </span>
          )}
        </div>
        {creatingId === link.id && (
          <CreateInCatalogForm
            link={link}
            workspaceSlug={workspaceSlug}
            onCancel={() => setCreatingId(null)}
            onDone={() => {
              setCreatingId(null);
              void afterChange();
            }}
          />
        )}
      </li>
    );
  };

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-11 font-medium text-tertiary">
          {t("file_library.contracts.works.title")}
          {linked.length > 0 && <span className="font-normal ml-1.5">{linked.length}</span>}
        </h3>
        {canEdit && data && (
          <button
            type="button"
            onClick={() => setIsPickerOpen(true)}
            className="flex items-center gap-1 rounded-sm px-1 text-11 text-accent-primary hover:bg-layer-1-hover"
          >
            <Plus className="size-3" />
            {t("file_library.contracts.works.add")}
          </button>
        )}
      </div>
      {!data && !error && (
        <div className="flex items-center gap-2 px-2 py-1 text-12 text-tertiary" role="status">
          <Loader2 className="size-3.5 animate-spin" />
          <span className="sr-only">{t("common.loading")}</span>
        </div>
      )}
      {error && !isNotFound(error) && (
        <p className="flex items-center gap-2 px-2 text-12 text-tertiary">
          {t("file_library.contracts.works.load_failed")}
          <button type="button" onClick={() => void mutate()} className="text-accent-primary hover:underline">
            {t("file_library.contracts.retry.button")}
          </button>
        </p>
      )}
      {data && linked.length === 0 && suggested.length === 0 && (
        <p className="px-2 text-12 text-tertiary">{t("file_library.contracts.works.empty")}</p>
      )}
      {isLong && (
        <div className="space-y-1">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-tertiary" />
            <input
              value={filter}
              onChange={(event) => {
                setFilter(event.target.value);
                setLinkedLimit(PAGE_SIZE);
              }}
              placeholder={t("file_library.contracts.works.filter_placeholder")}
              aria-label={t("file_library.contracts.works.filter_placeholder")}
              className={cn(FIELD, "pl-7")}
            />
          </div>
          <p className="px-1 text-11 text-tertiary">
            {[
              t("file_library.contracts.works.songs_count", { count: songCount }),
              t("file_library.contracts.works.releases_count", { count: linked.length - songCount }),
              needle ? t("file_library.contracts.works.matching_count", { count: matching.length }) : "",
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
      )}
      {isLong && needle && matching.length === 0 && (
        <p className="px-2 text-12 text-tertiary">{t("file_library.contracts.works.no_match")}</p>
      )}
      {shownLinked.length > 0 && (
        <ul className="divide-y divide-subtle rounded-md border border-subtle">{shownLinked.map(linkedRow)}</ul>
      )}
      {matching.length > shownLinked.length && (
        <button
          type="button"
          onClick={() => setLinkedLimit((current) => current + PAGE_SIZE)}
          className="w-full rounded-md px-2 py-1 text-center text-11 text-accent-primary hover:bg-layer-1-hover"
        >
          {t("file_library.contracts.works.show_more", {
            count: Math.min(PAGE_SIZE, matching.length - shownLinked.length),
            total: matching.length - shownLinked.length,
          })}
        </button>
      )}
      {shownLinked.length > PAGE_SIZE && (
        <button
          type="button"
          onClick={() => setLinkedLimit(PAGE_SIZE)}
          className="w-full rounded-md px-2 py-1 text-center text-11 text-tertiary hover:bg-layer-1-hover"
        >
          {t("file_library.contracts.works.show_less")}
        </button>
      )}
      {suggested.length > 0 && (
        <div className="space-y-1">
          <p className="flex items-center gap-1.5 px-1 text-11 text-tertiary">
            <Sparkles className="size-3 text-accent-primary" aria-hidden />
            {t("file_library.contracts.works.suggestions_title")}
            <span>{suggested.length}</span>
          </p>
          <ul className="divide-y divide-subtle rounded-md border border-dashed border-subtle">
            {shownSuggested.map(suggestionRow)}
          </ul>
          {suggested.length > shownSuggested.length && (
            <button
              type="button"
              onClick={() => setSuggestionsLimit(suggested.length)}
              className="w-full rounded-md px-2 py-1 text-center text-11 text-accent-primary hover:bg-layer-1-hover"
            >
              {t("file_library.contracts.works.show_all_suggestions", { count: suggested.length })}
            </button>
          )}
        </div>
      )}
      <ContractWorksPickerModal
        workspaceSlug={workspaceSlug}
        isOpen={isPickerOpen}
        onClose={() => setIsPickerOpen(false)}
        linkedKeys={linkedKeys}
        onConfirm={addWorks}
      />
    </section>
  );
}
