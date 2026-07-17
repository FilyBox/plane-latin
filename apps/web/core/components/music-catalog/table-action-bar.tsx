import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronLeft, ChevronRight, Download, Trash2, X } from "lucide-react";
import { Button } from "@plane/propel/button";
import { cn } from "@plane/utils";

type Props = {
  selectedCount: number;
  page: number;
  totalPages: number;
  isBusy?: boolean;
  onClear: () => void;
  onDownload: () => void;
  onDelete: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onGoTo: (page: number) => void;
};

const actionButton =
  "group flex h-8 shrink-0 items-center gap-1.5 overflow-hidden rounded-md px-2 text-12 font-medium transition-colors duration-200";

export function MusicTableActionBar(props: Props) {
  const {
    selectedCount,
    page,
    totalPages,
    isBusy = false,
    onClear,
    onDelete,
    onDownload,
    onNext,
    onPrevious,
    onGoTo,
  } = props;
  const hasSelection = selectedCount > 0;
  const [pageInput, setPageInput] = useState(String(page));

  useEffect(() => setPageInput(String(page)), [page]);

  const submitPage = () => {
    const target = Number(pageInput);
    if (Number.isInteger(target) && target >= 1 && target <= totalPages) onGoTo(target);
    else setPageInput(String(page));
  };

  return (
    <div className="sticky right-0 bottom-3 left-0 z-20 mt-4 flex justify-center px-1 sm:px-4">
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={hasSelection ? "selection" : "pagination"}
          initial={{ opacity: 0, scale: 0.96, y: 12 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.96, y: 12 }}
          transition={{ type: "spring", stiffness: 360, damping: 28 }}
          className="flex max-w-full items-center gap-1 overflow-x-auto rounded-xl border border-subtle bg-layer-1 px-2 py-1.5 shadow-raised-200"
        >
          {hasSelection && (
            <>
              <motion.span
                initial={{ opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                className="shrink-0 px-1.5 text-12 font-medium text-primary"
              >
                {selectedCount} selected
              </motion.span>
              <span className="bg-subtle mx-0.5 h-5 w-px shrink-0" />
              <button
                type="button"
                className={cn(
                  actionButton,
                  "text-secondary hover:bg-layer-1-hover",
                  isBusy && "pointer-events-none opacity-50"
                )}
                disabled={isBusy}
                onClick={onDownload}
              >
                <Download className="size-3.5 shrink-0" />
                <span className="max-w-0 overflow-hidden whitespace-nowrap transition-all duration-200 sm:max-w-28 sm:group-hover:max-w-32">
                  Download XLSX
                </span>
              </button>
              <button
                type="button"
                className={cn(
                  actionButton,
                  "text-danger-primary hover:bg-danger-subtle",
                  isBusy && "pointer-events-none opacity-50"
                )}
                disabled={isBusy}
                onClick={onDelete}
              >
                <Trash2 className="size-3.5 shrink-0" />
                <span className="max-w-0 overflow-hidden whitespace-nowrap transition-all duration-200 sm:max-w-16 sm:group-hover:max-w-20">
                  Delete
                </span>
              </button>
              <button
                type="button"
                className={cn(actionButton, "px-1.5 text-tertiary hover:bg-layer-1-hover")}
                disabled={isBusy}
                onClick={onClear}
                aria-label="Clear selection"
              >
                <X className="size-3.5" />
              </button>
              <span className="bg-subtle mx-0.5 h-5 w-px shrink-0" />
            </>
          )}
          <span className="shrink-0 px-1.5 text-11 text-secondary">Página</span>
          <input
            type="number"
            min="1"
            max={totalPages}
            value={pageInput}
            disabled={isBusy}
            onChange={(event) => setPageInput(event.target.value)}
            onBlur={submitPage}
            onKeyDown={(event) => event.key === "Enter" && submitPage()}
            aria-label="Ir a página"
            className="focus:border-accent-primary h-8 w-12 rounded-md border border-subtle bg-transparent px-1 text-center text-12 outline-none"
          />
          <span className="shrink-0 text-11 text-secondary">de {totalPages}</span>
          <Button
            variant="secondary"
            size="sm"
            className="h-8 px-2"
            disabled={page === 1 || isBusy}
            onClick={onPrevious}
          >
            <ChevronLeft className="size-4" />
            <span className="hidden sm:inline">Previous</span>
          </Button>
          <Button
            variant="secondary"
            size="sm"
            className="h-8 px-2"
            disabled={page >= totalPages || isBusy}
            onClick={onNext}
          >
            <span className="hidden sm:inline">Next</span>
            <ChevronRight className="size-4" />
          </Button>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
