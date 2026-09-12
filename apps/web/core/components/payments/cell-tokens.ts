import type { CSSProperties } from "react";

/** Compartimos estilos entre las tablas React y RevoGrid: cellStyle devuelve CSSProperties y cellStyleKebab convierte las claves. */

/** What kind of row the cell sits in. */
export type RowFamily =
  /** An ordinary data row: an account, a department, a person. */
  | "row"
  /** A heading that opens a block of rows. */
  | "group"
  /** The line that closes a block, or the grid. */
  | "subtotal"
  /** Context beside a row rather than a row of its own, like a prior year. */
  | "reference"
  /** A strip of fixed data above the rows, like the days of each month. */
  | "strip";

/** What the cell holds, which decides its alignment and typeface. */
export type CellContent =
  /** A figure. Monospace, right aligned. */
  | "amount"
  /** Words. Proportional, left aligned. */
  | "text"
  /** The name in the first column, which stands for the whole row. */
  | "concept"
  /** The figure that closes a row, set apart by a rule and extra weight. */
  | "total";

/** What is true about this particular cell. */
export interface CellFlags {
  /** Carries a conversation: the orange corner. */
  hasThread?: boolean;
  /** Typed by hand over a calculated figure: the purple corner. */
  override?: boolean;
  /** Outside what this person may type in. */
  isLocked?: boolean;
  /** Inside what this person was handed. */
  isMine?: boolean;
  /** No figure captured yet. */
  isEmpty?: boolean;
  /** Comes from a resource or another sheet rather than a typed number. */
  isLinked?: boolean;
  /** First cell of a block, which carries the dividing rule. */
  isFirst?: boolean;
  /** Row background the caller computed, when it beats the family's own. */
  background?: string;
}

/* ─────────── the palette, traced from the design document ─────────── */

/** Orange corner of the cell that carries a conversation. Top and right. */
export const THREAD_CORNER = "inset -5px 5px 0 -3px #B9651F";

/** Purple corner of a figure typed by hand over a calculation. */
export const OVERRIDE_CORNER = "inset 4px -4px 0 -3px #6B44A0";

/** Distinguimos los renglones propios de los reservados por otra persona. */
export const BG_LOCKED = "#F6F7F9";
export const BG_MINE = "var(--accent-tint)";
export const BG_EMPTY = "#FCFCFD";
export const BG_REFERENCE = "#FBFCFD";

/** Height of a data row. The design draws it the same in every table. */
export const ROW_HEIGHT = 30;
export const STRIP_HEIGHT = 26;
export const HEADER_HEIGHT = 31;

/* ─────────── the style ─────────── */

const FRAME: CSSProperties = {
  display: "flex",
  alignItems: "center",
  height: "100%",
  boxSizing: "border-box",
  // A cell that navigates is a <button>, and a button with no declared border
  // keeps the browser's own "2px outset". Every cell draws its own rules, so
  // it starts from zero and doesn't depend on any global reset.
  border: "none",
  borderRadius: 0,
  appearance: "none",
  textAlign: "inherit",
  font: "inherit",
};

/** How far the concept column indents, by row family — the hierarchy shows. */
const INDENT: Record<RowFamily, string> = {
  group: "13px",
  subtotal: "20px",
  strip: "12px",
  row: "26px",
  reference: "26px",
};

function backgroundFor(family: RowFamily, m: CellFlags): string | undefined {
  if (m.isLocked) return BG_LOCKED;
  if (m.isMine) return BG_MINE;
  if (family === "strip") return "var(--panel-alt)";
  if (family === "group") return "var(--group)";
  if (family === "reference") return BG_REFERENCE;
  if (m.isEmpty) return BG_EMPTY;
  return m.background;
}

function colorFor(family: RowFamily, content: CellContent, m: CellFlags): string {
  if (family === "strip") return "var(--muted)";
  if (family === "reference") return "var(--muted)";
  if (family === "subtotal" && content === "amount") return "var(--ink-4)";
  if (m.isLocked) return "var(--muted-2)";
  if (m.isEmpty) return "var(--muted-3)";
  if (m.isLinked) return "var(--accent)";
  return "var(--ink)";
}

/** Usamos tamaños menores para totales y referencias que para los importes capturados. */
function fontSizeFor(family: RowFamily, content: CellContent): string {
  if (family === "strip") return "9.5px";
  if (family === "reference") return "10px";
  if (family === "group") return content === "amount" ? "11.5px" : "10.5px";
  if (family === "subtotal") return content === "text" || content === "total" ? "11.5px" : "11px";
  return content === "amount" || content === "concept" ? "11.5px" : "10.5px";
}

/** Los consumidores pueden sobrescribir los estilos base de la celda. */
export function cellStyle(family: RowFamily, content: CellContent, m: CellFlags = {}): CSSProperties {
  const mono = content === "amount" || content === "total";
  const s: CSSProperties = {
    ...FRAME,
    justifyContent: mono ? "flex-end" : "flex-start",
    fontFamily: mono ? "var(--font-mono)" : "inherit",
    // The month figure sits tighter than the rest: there are twelve in a row.
    padding: content === "amount" ? "0 6px" : "0 8px",
    fontSize: fontSizeFor(family, content),
    color: colorFor(family, content, m),
    background: backgroundFor(family, m),
  };

  if (content === "concept") {
    s.paddingLeft = INDENT[family];
    s.borderRight = "1px solid var(--line-softer)";
    s.whiteSpace = "nowrap";
    s.overflow = "hidden";
    s.textOverflow = "ellipsis";
  }
  if (content === "text" || content === "total") {
    s.whiteSpace = "nowrap";
    s.overflow = "hidden";
    s.textOverflow = "ellipsis";
  }
  if (content === "amount") {
    s.borderLeft = m.isFirst ? "1px solid var(--line-soft)" : "1px solid transparent";
  }
  if (content === "total") {
    s.borderLeft = "1px solid var(--line-soft)";
    s.fontWeight = family === "subtotal" ? 600 : 500;
  }

  if (family === "group") {
    s.fontWeight = 600;
    if (content === "concept") s.letterSpacing = ".05em";
  }
  if (family === "subtotal") {
    s.fontWeight = s.fontWeight ?? 500;
    s.borderTop = "1px solid var(--line-input)";
  }
  if (family === "strip" && content === "concept") {
    s.textTransform = "uppercase";
    s.letterSpacing = ".04em";
  }
  if (family === "reference") s.fontFamily = "var(--font-mono)";

  const shadows: string[] = [];
  // The override goes first because it belongs to the figure itself; the
  // thread corner wraps around it.
  if (m.override) shadows.push(OVERRIDE_CORNER);
  if (m.hasThread) shadows.push(THREAD_CORNER);
  if (shadows.length) s.boxShadow = shadows.join(", ");
  if (m.override) s.color = "var(--purple)";

  return s;
}

/* ─────────── RevoGrid adapter ─────────── */

const kebab = (k: string) => k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());

/** Turns a React style object into the plain map RevoGrid templates take. */
export function toKebabCase(s: CSSProperties): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(s)) {
    if (v === undefined || v === null) continue;
    out[kebab(k)] = String(v);
  }
  return out;
}

/** The same cell, for a grid that renders through templates instead of JSX. */
export const cellStyleKebab = (family: RowFamily, content: CellContent, m: CellFlags = {}) =>
  toKebabCase(cellStyle(family, content, m));
