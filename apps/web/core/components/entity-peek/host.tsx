/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 *
 * Renders the entity panels named by `?open=<kind>:<id>` over whatever page
 * the user is on (opened from the assistant, a page mention, a reference
 * list or a shared link). Several `open` values stack, in URL order, over the
 * page's own panel. When no panel is open yet, a page with its own panel for
 * that kind takes the link over instead, so its list highlights and
 * refreshes the row.
 */

import { useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence } from "framer-motion";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import useSWR, { useSWRConfig } from "swr";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import { useTranslation } from "@plane/i18n";
import { ContractPeekPanel } from "@/components/file-library/contracts/peek-panel";
import { MusicReleaseModal } from "@/components/music-catalog/release-modal";
import { MusicTrackPeekPanel } from "@/components/music-catalog/track-peek-panel";
import { ExpenseModal } from "@/components/payments/expense-modal";
import { financeService } from "@/services/finance.service";
import { musicService } from "@/services/music.service";
import { PanelLayerRank } from "@/components/panel-stack/use-panel-layer";
import { OPEN_PARAM, encodeOpen, ownOpenParams, ownParam, parseOpenList, sectionPath } from "./routes";
import type { TPeekTarget } from "./routes";

type PanelProps = { slug: string; id: string; onClose: () => void; onOpenInSection: () => void };

/** Refreshes every cached list whose key starts with `prefix` (string or array keys). */
function useRefresh(prefix: string) {
  const { mutate } = useSWRConfig();
  return () =>
    void mutate(
      (key) => (typeof key === "string" && key.startsWith(prefix)) || (Array.isArray(key) && key[0] === prefix),
      undefined,
      { revalidate: true }
    );
}

function useNotFound(failed: boolean, onClose: () => void) {
  const { t } = useTranslation();
  useEffect(() => {
    if (!failed) return;
    setToast({ type: TOAST_TYPE.ERROR, title: t("references.peek.not_available") });
    onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failed]);
}

function ContractPanel({ slug, id, onClose, onOpenInSection }: PanelProps) {
  const refresh = useRefresh(`CONTRACTS_${slug}`);
  return (
    <ContractPeekPanel
      workspaceSlug={slug}
      contractId={id}
      onClose={onClose}
      onMutate={refresh}
      onDeleted={() => {
        refresh();
        onClose();
      }}
      onOpenInSection={onOpenInSection}
    />
  );
}

/** The song panel needs the song and the catalog's lookup lists; the keys
 * are the catalog page's, so both share the cache. */
function TrackPanel({ slug, id, onClose, onOpenInSection }: PanelProps) {
  const {
    data: track,
    error,
    mutate,
  } = useSWR(["MUSIC_TRACK_PEEK", slug, id], async () => {
    const response = await musicService.getTracks(slug, { ids: id });
    const found = (Array.isArray(response) ? response : response.results)[0];
    if (!found) throw new Error("not found");
    return found;
  });
  const { data: options } = useSWR(`MUSIC_OPTIONS_${slug}`, () => musicService.getOptions(slug));
  const { data: parties = [], mutate: mutateParties } = useSWR(`MUSIC_PARTIES_${slug}`, () =>
    musicService.getParties(slug)
  );
  const { data: companies = [], mutate: mutateCompanies } = useSWR(`MUSIC_COMPANIES_${slug}`, () =>
    musicService.getCompanies(slug)
  );
  const { data: genres = [], mutate: mutateGenres } = useSWR(`MUSIC_GENRES_${slug}`, () =>
    musicService.getGenres(slug)
  );
  const { data: releases = [], mutate: mutateReleases } = useSWR(["MUSIC_RELEASES", slug], () =>
    musicService.getReleases(slug)
  );
  const refreshTracks = useRefresh("MUSIC_TRACKS");
  useNotFound(Boolean(error), onClose);
  const portal = typeof document === "undefined" ? null : document.getElementById("full-screen-portal");
  if (!track || !portal) return null;

  return createPortal(
    <MusicTrackPeekPanel
      workspaceSlug={slug}
      track={track}
      options={options}
      parties={parties}
      genres={genres}
      companies={companies}
      releases={releases}
      onClose={onClose}
      onSaved={() => {
        void mutate();
        refreshTracks();
      }}
      onCreated={() => undefined}
      onResourcesChanged={() => {
        void mutateParties();
        void mutateCompanies();
        void mutateGenres();
        void mutateReleases();
      }}
      onOpenInSection={onOpenInSection}
    />,
    portal
  );
}

function ReleasePanel({ slug, id, onClose, onOpenInSection }: PanelProps) {
  const { data: releases, mutate } = useSWR(["MUSIC_RELEASES", slug], () => musicService.getReleases(slug));
  const { data: options } = useSWR(`MUSIC_OPTIONS_${slug}`, () => musicService.getOptions(slug));
  const { data: parties = [] } = useSWR(`MUSIC_PARTIES_${slug}`, () => musicService.getParties(slug));
  const release = useMemo(() => releases?.find((item) => item.id === id), [releases, id]);
  const refreshTracks = useRefresh("MUSIC_TRACKS");
  useNotFound(releases !== undefined && !release, onClose);
  if (!release) return null;
  return (
    <MusicReleaseModal
      workspaceSlug={slug}
      isOpen
      release={release}
      parties={parties}
      options={options}
      onClose={onClose}
      onSaved={() => {
        void mutate();
        refreshTracks();
      }}
      onResourcesChanged={() => void mutate()}
      onOpenInSection={onOpenInSection}
    />
  );
}

function ExpensePanel({ slug, id, onClose, onOpenInSection }: PanelProps) {
  const {
    data: expense,
    error,
    mutate,
  } = useSWR(["EXPENSE_PEEK", slug, id], () => financeService.getExpense(slug, id));
  const refreshExpenses = useRefresh("PAYMENT_EXPENSES");
  useNotFound(Boolean(error), onClose);
  if (!expense) return null;
  return (
    <ExpenseModal
      workspaceSlug={slug}
      isOpen
      expense={expense}
      onClose={onClose}
      onSaved={() => {
        void mutate();
        refreshExpenses();
      }}
      onOpenInSection={onOpenInSection}
    />
  );
}

const PANELS: Record<TPeekTarget["kind"], (props: PanelProps) => React.ReactNode> = {
  contract: ContractPanel,
  music_track: TrackPanel,
  music_release: ReleasePanel,
  expense: ExpensePanel,
};

export function EntityPeekHost() {
  const { workspaceSlug } = useParams();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const opened = parseOpenList(searchParams);
  const pagePanelOpen = ownOpenParams(pathname, searchParams).length > 0;
  // Only the bottom panel can belong to the page: one opened over another
  // panel stays in the stack, even when the page has a panel for its kind.
  const first = opened[0];
  const handOff = first && !pagePanelOpen ? ownParam(pathname, first.kind) : null;

  // On a page with its own panel for this kind (a shared `?open=` link landing
  // on the contracts list, say), hand the link to the page.
  useEffect(() => {
    if (!first || !handOff) return;
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        const rest = parseOpenList(next).filter((item) => encodeOpen(item) !== encodeOpen(first));
        next.delete(OPEN_PARAM);
        next.set(handOff, first.id);
        rest.forEach((item) => next.append(OPEN_PARAM, encodeOpen(item)));
        return next;
      },
      { replace: true }
    );
  }, [first?.kind, first?.id, handOff]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!workspaceSlug) return null;
  const slug = String(workspaceSlug);
  // Closing one removes only its own entry; the panels under it stay
  const close = (target: TPeekTarget) =>
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        const rest = parseOpenList(next).filter((item) => encodeOpen(item) !== encodeOpen(target));
        next.delete(OPEN_PARAM);
        rest.forEach((item) => next.append(OPEN_PARAM, encodeOpen(item)));
        return next;
      },
      { replace: true }
    );
  const stacked = handOff ? opened.slice(1) : opened;
  return (
    // Keeps a closed panel mounted while it slides out
    <AnimatePresence>
      {stacked.map((target, index) => {
        const Panel = PANELS[target.kind];
        return (
          <PanelLayerRank key={encodeOpen(target)} rank={index + 1}>
            <Panel
              slug={slug}
              id={target.id}
              onClose={() => close(target)}
              onOpenInSection={() => navigate(sectionPath(slug, target))}
            />
          </PanelLayerRank>
        );
      })}
    </AnimatePresence>
  );
}
