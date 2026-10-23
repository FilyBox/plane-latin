import { lazy, Suspense, useMemo } from "react";
import type { ColumnRegular } from "@revolist/react-datagrid";
import useSize from "@/hooks/use-window-size";
import { cellStyleKebab, ROW_HEIGHT, type CellFlags, type RowFamily } from "./cell-tokens";
// eslint-disable-next-line import/no-unassigned-import -- stylesheet
import "./finance-grid.css";

/** Header row plus its bottom rule, as RevoGrid's compact theme draws it. */
const HEADER_HEIGHT = 46;
/** Rows kept visible on an empty sheet so its message has room. */
const EMPTY_ROWS = 4;

const RevoGrid = lazy(() => import("@revolist/react-datagrid").then((module) => ({ default: module.RevoGrid })));

export type FinanceGridRow = { id: string; family?: RowFamily; [key: string]: unknown };
export type FinanceGridColumn = {
  prop: string;
  name: string;
  size?: number;
  pin?: "colPinStart" | "colPinEnd";
  amount?: boolean;
  editable?: boolean;
  display?: (row: FinanceGridRow) => string;
  flags?: (row: FinanceGridRow) => CellFlags;
  onClick?: (row: FinanceGridRow) => void;
  /** Marks the cell as a reference the caller resolves with its own picker —
   * office, category. The grid only reports where it was clicked. */
  pickable?: boolean;
};

export function FinanceGrid({
  rows,
  totals,
  columns,
  emptyLabel,
  onEdit,
  onComment,
  onPickCell,
}: {
  rows: FinanceGridRow[];
  /** Pinned to the bottom of the grid. Always rendered, even with no rows, so
   * the closing line of the sheet never disappears and never scrolls away. */
  totals: FinanceGridRow[];
  columns: FinanceGridColumn[];
  /** Shown over the empty rows area. Text only — the grid paints its own
   * overlays above anything we stack here, so a control would be unclickable. */
  emptyLabel?: string;
  onEdit?: (row: FinanceGridRow, prop: string, value: string) => Promise<void>;
  onComment?: (row: FinanceGridRow, prop: string) => void;
  /** A reference cell was clicked. `anchor` is its position on screen. */
  onPickCell?: (row: FinanceGridRow, prop: string, anchor: DOMRect) => void;
}) {
  // On a phone the two pinned columns would fill the screen and leave no room
  // to scroll the figures: only the concept stays pinned, and narrower.
  const [windowWidth] = useSize();
  const narrow = windowWidth < 640;
  const gridColumns = useMemo<ColumnRegular[]>(
    () =>
      columns.map((column, index) => ({
        prop: column.prop,
        name: column.name,
        size: narrow && column.pin === "colPinStart" ? Math.min(column.size ?? 130, 140) : (column.size ?? 130),
        pin: narrow && column.pin === "colPinEnd" ? undefined : column.pin,
        // Order comes from the page's own sort menu: sorting here compared
        // figures as text and pulled group headings away from their rows.
        sortable: false,
        readonly: (props) =>
          !column.editable ||
          !!column.pickable ||
          !!props.model.family ||
          !!column.flags?.(props.model as FinanceGridRow).isLocked,
        cellTemplate: (h, props) => {
          const row = props.model as FinanceGridRow;
          const pickable = column.pickable && !row.family;
          const clickable = (column.onClick || pickable) && !row.family;
          const value = column.display ? column.display(row) : String(row[column.prop] ?? "");
          const style = cellStyleKebab(
            row.family ?? "row",
            index === 0 ? "concept" : column.pin === "colPinEnd" ? "total" : column.amount ? "amount" : "text",
            column.flags?.(row)
          );
          return h(
            clickable ? "button" : "span",
            {
              "data-pickable": pickable ? "true" : undefined,
              type: clickable ? "button" : undefined,
              "data-rowid": row.id,
              "data-prop": column.prop,
              title: value,
              onClick: clickable ? () => column.onClick?.(row) : undefined,
              style,
            },
            value || "—"
          );
        },
      })),
    [columns, narrow]
  );
  // The grid is as tall as what it holds: a short sheet ends right under its
  // last line instead of leaving a blank block above the totals. A long one is
  // capped by the page (`shrink`) and scrolls inside.
  const contentHeight =
    HEADER_HEIGHT + (Math.max(rows.length, rows.length === 0 ? EMPTY_ROWS : 0) + totals.length) * ROW_HEIGHT + 1;
  // RevoGrid renders its cells through templates, not React, so the clicks and
  // the context menu are delegated here. The cells themselves are buttons and
  // carry the keyboard behaviour.
  /* eslint-disable jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events */
  return (
    <div
      className="finance-grid relative min-h-0 shrink overflow-hidden"
      style={{ height: contentHeight }}
      onClick={(event) => {
        const cell = (event.target as HTMLElement).closest<HTMLElement>("[data-pickable='true']");
        if (!cell || !onPickCell) return;
        const row = rows.find((item) => item.id === cell.dataset.rowid);
        if (!row) return;
        onPickCell(row, cell.dataset.prop ?? "", cell.getBoundingClientRect());
      }}
      onContextMenu={(event) => {
        const cell = (event.target as HTMLElement).closest<HTMLElement>("[data-rowid]");
        const row = rows.find((item) => item.id === cell?.dataset.rowid);
        if (!row || row.family || !onComment) return;
        event.preventDefault();
        onComment(row, cell?.dataset.prop ?? "");
      }}
    >
      <Suspense fallback={<div className="h-full animate-pulse bg-layer-1" />}>
        <RevoGrid
          theme="compact"
          source={rows}
          columns={gridColumns}
          pinnedBottomSource={totals}
          rowSize={ROW_HEIGHT}
          // Spare width goes to the last column, not to a blank strip after it.
          stretch
          resize
          range={false}
          onBeforeedit={(event) => {
            event.preventDefault();
            const { model, prop, val } = event.detail;
            const column = columns.find((item) => item.prop === prop);
            if (model.family || column?.flags?.(model as FinanceGridRow).isLocked) return;
            void onEdit?.(model as FinanceGridRow, String(prop), String(val ?? ""));
          }}
        />
      </Suspense>
      {rows.length === 0 && emptyLabel && (
        <p className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 text-center text-12 text-tertiary">
          {emptyLabel}
        </p>
      )}
    </div>
  );
}
