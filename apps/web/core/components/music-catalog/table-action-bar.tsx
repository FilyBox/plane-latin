import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { ChevronLeft, ChevronRight, Download, Trash2, X } from "lucide-react";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { cn } from "@plane/utils";

type Props = {
  selectedCount: number;
  /** Total rows matching the active filters (for select-all-matching) */
  totalMatching?: number;
  isSelectingAll?: boolean;
  onSelectAllMatching?: () => void;
  page: number;
  totalPages: number;
  isBusy?: boolean;
  onClear: () => void;
  onDownload: () => void;
  onDelete: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onGoTo: (page: number) => void;
  /** More selection actions (e.g. tagging), shown before Delete. */
  selectionActions?: ReactNode;
};

/** Selection action: icon only until there is room (laptop widths), then icon + label. */
export const actionButton =
  "flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-12 font-medium transition-colors duration-150";
/** The label inside an action: shown only when the bar has room — measured on
 * the bar's own width (container query), so it adapts when the assistant
 * panel narrows the page, not just to the window. The button keeps an aria-label. */
export const actionLabel = "hidden whitespace-nowrap @4xl:inline";

/** One bar for both states. It never unmounts while switching between
 * paging and a selection — the selection actions fade in beside the pager —
 * so selecting or clearing rows does not make it blink. */
export function MusicTableActionBar(props: Props) {
  const {
    selectedCount,
    totalMatching = 0,
    isSelectingAll = false,
    onSelectAllMatching,
    page,
    totalPages,
    isBusy = false,
    onClear,
    onDelete,
    onDownload,
    onNext,
    onPrevious,
    onGoTo,
    selectionActions,
  } = props;
  const { t } = useTranslation();
  const hasSelection = selectedCount > 0;
  const [pageInput, setPageInput] = useState(String(page));

  useEffect(() => setPageInput(String(page)), [page]);

  const submitPage = () => {
    const target = Number(pageInput);
    if (Number.isInteger(target) && target >= 1 && target <= totalPages) onGoTo(target);
    else setPageInput(String(page));
  };

  return (
    // mt-auto pins the bar to the bottom of the flex-column scroll container
    // even with few rows; sticky keeps it in view while scrolling long lists
    <div className="@container sticky right-0 bottom-3 left-0 z-20 mt-auto flex justify-center px-1 pt-4 sm:px-4">
      <div className="flex max-w-full items-center gap-1 overflow-x-auto rounded-xl border border-subtle bg-layer-1 px-2 py-1.5 shadow-raised-200">
        {hasSelection && (
          <div className="flex shrink-0 animate-fade-in items-center gap-1 motion-reduce:animate-none">
            <span className="shrink-0 px-1.5 text-12 font-medium text-primary tabular-nums" aria-live="polite">
              {t("music_catalog.action_bar.selected", { count: selectedCount })}
            </span>
            {onSelectAllMatching && totalMatching > selectedCount && (
              <button
                type="button"
                disabled={isBusy || isSelectingAll}
                onClick={onSelectAllMatching}
                className={cn(
                  "shrink-0 rounded-full border border-accent-strong px-2.5 py-1 text-11 font-medium whitespace-nowrap text-accent-primary hover:bg-accent-primary/10",
                  (isBusy || isSelectingAll) && "pointer-events-none opacity-50"
                )}
              >
                {isSelectingAll ? (
                  t("music_catalog.action_bar.selecting")
                ) : (
                  <>
                    <span className="@4xl:hidden">
                      {t("music_catalog.action_bar.select_all_short", { count: totalMatching })}
                    </span>
                    <span className="hidden @4xl:inline">
                      {t("music_catalog.action_bar.select_all", { count: totalMatching })}
                    </span>
                  </>
                )}
              </button>
            )}
            <span className="bg-subtle mx-0.5 h-5 w-px shrink-0" aria-hidden />
            <button
              type="button"
              className={cn(
                actionButton,
                "text-secondary hover:bg-layer-1-hover",
                isBusy && "pointer-events-none opacity-50"
              )}
              disabled={isBusy}
              onClick={onDownload}
              aria-label={t("music_catalog.action_bar.download")}
              title={t("music_catalog.action_bar.download")}
            >
              <Download className="size-3.5 shrink-0" />
              <span className={actionLabel}>{t("music_catalog.action_bar.download")}</span>
            </button>
            {selectionActions}
            <button
              type="button"
              className={cn(
                actionButton,
                "text-danger-primary hover:bg-danger-subtle",
                isBusy && "pointer-events-none opacity-50"
              )}
              disabled={isBusy}
              onClick={onDelete}
              aria-label={t("music_catalog.action_bar.delete")}
              title={t("music_catalog.action_bar.delete")}
            >
              <Trash2 className="size-3.5 shrink-0" />
              <span className={actionLabel}>{t("music_catalog.action_bar.delete")}</span>
            </button>
            <button
              type="button"
              className={cn(actionButton, "px-1.5 text-tertiary hover:bg-layer-1-hover")}
              disabled={isBusy}
              onClick={onClear}
              aria-label={t("music_catalog.action_bar.clear")}
              title={t("music_catalog.action_bar.clear")}
            >
              <X className="size-3.5" />
            </button>
          </div>
        )}
        {/* Paging stays put; on phones it steps aside while rows are selected
            so the actions fit without crowding. */}
        <div className={cn("flex shrink-0 items-center gap-1", hasSelection && "@max-xl:hidden")}>
          {hasSelection && <span className="bg-subtle mx-0.5 h-5 w-px shrink-0" aria-hidden />}
          <span className="hidden shrink-0 px-1.5 text-11 text-secondary @xl:inline">
            {t("music_catalog.action_bar.page")}
          </span>
          <input
            type="number"
            min="1"
            max={totalPages}
            value={pageInput}
            disabled={isBusy}
            onChange={(event) => setPageInput(event.target.value)}
            onBlur={submitPage}
            onKeyDown={(event) => event.key === "Enter" && submitPage()}
            aria-label={t("music_catalog.action_bar.go_to_page")}
            className="h-8 w-12 rounded-md border border-subtle bg-transparent px-1 text-center text-12 outline-none focus:border-accent-strong"
          />
          <span className="shrink-0 text-11 whitespace-nowrap text-secondary tabular-nums">
            {t("music_catalog.action_bar.of_pages", { count: totalPages })}
          </span>
          <Button
            variant="secondary"
            size="sm"
            className="h-8 px-2"
            disabled={page === 1 || isBusy}
            onClick={onPrevious}
            aria-label={t("music_catalog.action_bar.previous")}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <Button
            variant="secondary"
            size="sm"
            className="h-8 px-2"
            disabled={page >= totalPages || isBusy}
            onClick={onNext}
            aria-label={t("music_catalog.action_bar.next")}
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
