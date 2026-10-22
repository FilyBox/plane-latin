import { useEffect, useId, useRef, useState } from "react";
import { MoveRight, X } from "lucide-react";
import { useTranslation } from "@plane/i18n";
import { CenterPanelIcon, FullScreenPanelIcon, SidePanelIcon } from "@plane/propel/icons";
import { CustomSelect } from "@plane/ui";
import { PeekPanel, type PeekMode } from "@/components/core/peek-panel";
import usePeekOverviewOutsideClickDetector from "@/hooks/use-peek-overview-outside-click";

type Props = {
  isOpen: boolean;
  title: string;
  description?: string;
  headerActions?: React.ReactNode;
  /** True when this opened from another panel. It then renders narrower and
   * inset, floating over the one underneath, so the stack is visible instead of
   * being explained by a back arrow. */
  nested?: boolean;
  onClose: () => void;
  width?: "md" | "lg" | "xl";
  children: React.ReactNode;
};

/** Open panels, oldest first. Panels render as sibling portals, so a click
 * inside a panel opened from another one is "outside" for the one underneath;
 * only the panel on top answers Escape and outside clicks, which keeps the
 * stack from closing all at once and losing what was typed further down. */
const openPanels: string[] = [];
const isTopPanel = (id: string) => openPanels[openPanels.length - 1] === id;

const modes = [
  { key: "side-peek", icon: SidePanelIcon, title: "common.side_peek" },
  { key: "modal", icon: CenterPanelIcon, title: "common.modal" },
  { key: "full-screen", icon: FullScreenPanelIcon, title: "common.full_screen" },
] as const;

export function PaymentsSidePanel({
  isOpen,
  title,
  description,
  headerActions,
  nested = false,
  onClose,
  children,
}: Props) {
  const { t } = useTranslation();
  const panelId = useId();
  const [mode, setMode] = useState<PeekMode>("side-peek");
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  usePeekOverviewOutsideClickDetector(
    ref,
    () => {
      if (!isOpen || !isTopPanel(panelId)) return;
      if (!document.querySelector('[data-headlessui-state="open"]')) closeRef.current();
    },
    isOpen ? title : "",
    ["main-sidebar"]
  );
  useEffect(() => {
    if (!isOpen) return;
    openPanels.push(panelId);
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || !isTopPanel(panelId)) return;
      if (document.querySelector('[data-headlessui-state="open"], .editor-image-full-screen-modal')) return;
      const focused = document.activeElement;
      // Rich text keeps Escape for itself. A plain field gives up focus first,
      // so a second Escape closes the panel instead of never closing it.
      if (focused?.closest('[contenteditable="true"]')) return;
      if (focused instanceof HTMLElement && focused.closest("input, textarea, select")) {
        focused.blur();
        return;
      }
      closeRef.current();
    };
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("keydown", escape);
      const index = openPanels.lastIndexOf(panelId);
      if (index >= 0) openPanels.splice(index, 1);
      previous?.focus();
    };
  }, [isOpen, panelId]);
  if (!isOpen) return null;
  const current = modes.find((item) => item.key === mode)!;
  return (
    <PeekPanel ref={ref} mode={mode} depth={nested ? "nested" : "root"} label={title}>
      <header className="relative flex shrink-0 items-center justify-between gap-4 p-4">
        <div className="flex min-w-0 items-center gap-4">
          {/* A sub-panel is a card on top of the one behind: it closes, it does not
            navigate, so it takes the plain X rather than the peek controls. */}
          {nested ? (
            <h2 className="truncate text-13 font-medium text-primary">{title}</h2>
          ) : (
            <>
              <button type="button" onClick={onClose} aria-label={t("common.close_peek_view")}>
                <MoveRight className="size-4 text-tertiary hover:text-secondary" />
              </button>
              <CustomSelect
                value={mode}
                onChange={(value: PeekMode) => setMode(value)}
                customButton={
                  <button type="button" aria-label={t("common.toggle_peek_view_layout")}>
                    <current.icon className="size-4 text-tertiary" />
                  </button>
                }
              >
                {modes.map((item) => (
                  <CustomSelect.Option key={item.key} value={item.key}>
                    <span className="flex items-center gap-1.5">
                      <item.icon className="size-4" />
                      {t(item.title)}
                    </span>
                  </CustomSelect.Option>
                ))}
              </CustomSelect>
              <h2 className="truncate text-13 text-secondary">{title}</h2>
            </>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {headerActions}
          {nested && (
            <button
              type="button"
              onClick={onClose}
              aria-label={t("common.close_peek_view")}
              className="rounded-sm p-1 text-tertiary hover:bg-layer-1-hover hover:text-primary"
            >
              <X className="size-4" />
            </button>
          )}
        </div>
      </header>
      {description && <p className="px-8 pb-3 text-12 text-tertiary">{description}</p>}
      {children}
    </PeekPanel>
  );
}
