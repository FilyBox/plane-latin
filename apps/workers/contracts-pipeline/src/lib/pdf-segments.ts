/**
 * Where each document starts in a PDF that bundles several (contracts,
 * addenda, annexes, ID copies), as pure code over per-page verdicts.
 *
 * A vision model classifies every page in batches with a little overlap;
 * this file joins the batches, settles the overlap and applies the rules a
 * model alone gets wrong (annexes absorbed or split off, "1 de N" numbering,
 * an addendum signed apart), then turns the cuts into page ranges. A person
 * reviews the ranges in the card before anything is cut.
 *
 * Pages are numbered from 1. The limits match Django's plane/utils/pdf_ops.py.
 */

export const PDF_LIMITS = {
  maxPages: 300,
  maxSegments: 50,
  maxMergeFiles: 20,
  /** Pages per vision call, and pages shared with the next call */
  batch: 25,
  overlap: 2,
  /** The light preview of one batch (grayscale JPEG pages) */
  previewBytes: 25 * 1024 * 1024,
} as const;

export const DOC_TYPES = ["CONTRATO", "ADENDUM", "ANEXO", "IDENTIFICACION", "OTRO"] as const;
export type DocType = (typeof DOC_TYPES)[number];

/** What the model says about one page. */
export type PageVerdict = {
  page: number;
  starts_new_doc: boolean;
  doc_type: DocType;
  title: string;
  parties: string[];
  /** As printed: "1 de 5", "Página 2 de 5", "3/5"… or "" */
  page_label: string;
  has_signature_block: boolean;
  /** How sure it is about starts_new_doc, 0–1 */
  confidence: number;
  evidence: string;
};

export type Segment = {
  start_page: number;
  end_page: number;
  doc_type: DocType;
  title: string;
  parties?: string[];
  /** How sure the cut that opens this segment is (page 1 is always sure) */
  confidence: number;
  evidence?: string;
  first_line?: string;
  /** Rules that moved a cut, and pages where a cut was doubtful */
  notes?: string[];
};

export type AnnexRule = "with_document" | "separate";

// ----------------------------------------------------------------- batches

/** Batches of `size` pages, each sharing its last `overlap` pages with the next. */
export function batches(
  total: number,
  size: number = PDF_LIMITS.batch,
  overlap: number = PDF_LIMITS.overlap
): { from: number; to: number }[] {
  const result: { from: number; to: number }[] = [];
  if (total < 1) return result;
  const step = Math.max(1, size - overlap);
  for (let from = 1; ; from += step) {
    const to = Math.min(total, from + size - 1);
    result.push({ from, to });
    if (to >= total) break;
  }
  return result;
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

const text = (value: unknown, max = 300) => (typeof value === "string" ? value.trim().slice(0, max) : "");

/** The model's answer for one batch, coerced: unknown pages and fields drop out. */
export function normalizeVerdicts(raw: unknown, from: number, to: number): PageVerdict[] {
  const rows = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { pages?: unknown }).pages)
      ? (raw as { pages: unknown[] }).pages
      : [];
  const seen = new Set<number>();
  const verdicts: PageVerdict[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const item = row as Record<string, unknown>;
    const page = Number(item.page);
    if (!Number.isInteger(page) || page < from || page > to || seen.has(page)) continue;
    seen.add(page);
    const type = text(item.doc_type, 20).toUpperCase();
    const confidence = Number(item.confidence);
    verdicts.push({
      page,
      starts_new_doc: item.starts_new_doc === true,
      doc_type: (DOC_TYPES as readonly string[]).includes(type) ? (type as DocType) : "OTRO",
      title: text(item.title, 200),
      parties: Array.isArray(item.parties)
        ? item.parties
            .map((party) => text(party, 120))
            .filter(Boolean)
            .slice(0, 6)
        : [],
      page_label: text(item.page_label, 40),
      has_signature_block: item.has_signature_block === true,
      confidence: Number.isFinite(confidence) ? clamp(confidence, 0, 1) : 0.5,
      evidence: text(item.evidence, 240),
    });
  }
  return verdicts.sort((left, right) => left.page - right.page);
}

/**
 * One verdict per page. A page read in two batches keeps the reading where it
 * sat farther from the batch's edge: there the model saw what came before and
 * after it. A page no batch answered gets an unsure "continues" verdict.
 */
export function joinBatches(
  results: { from: number; to: number; verdicts: PageVerdict[] }[],
  total: number
): PageVerdict[] {
  const best = new Map<number, { verdict: PageVerdict; margin: number }>();
  for (const result of results) {
    for (const verdict of result.verdicts) {
      // The document's own first and last pages are not batch edges
      const before = result.from === 1 ? Infinity : verdict.page - result.from;
      const after = result.to === total ? Infinity : result.to - verdict.page;
      const margin = Math.min(before, after);
      const current = best.get(verdict.page);
      if (!current || margin > current.margin) best.set(verdict.page, { verdict, margin });
    }
  }
  const pages: PageVerdict[] = [];
  for (let page = 1; page <= total; page += 1) {
    pages.push(
      best.get(page)?.verdict ?? {
        page,
        starts_new_doc: false,
        doc_type: "OTRO",
        title: "",
        parties: [],
        page_label: "",
        has_signature_block: false,
        confidence: 0,
        evidence: "",
      }
    );
  }
  return pages;
}

// ----------------------------------------------------------------- rules

/** "1 de 5", "Página 2 de 5", "pág. 3/5", "2 of 5" → { index, total }. */
export function parseLabel(label: string): { index: number; total: number } | null {
  const match = /(\d{1,4})\s*(?:de|of|\/)\s*(\d{1,4})/i.exec(label || "");
  if (!match) return null;
  const index = Number(match[1]);
  const total = Number(match[2]);
  if (index < 1 || total < 1 || index > total) return null;
  return { index, total };
}

const ATTACHABLE = new Set<DocType>(["ANEXO", "IDENTIFICACION"]);

/**
 * The cuts, as segments. Rules on top of the model's verdicts:
 * - page 1 always starts a document;
 * - "1 de N" starts one, and "k de N" right after "k-1 de N" continues it;
 * - an annex or ID copy stays with the document before it (unless the user
 *   asked for annexes apart);
 * - an addendum right after a signature block is its own document.
 * A continuation the model was unsure about is noted as a possible cut.
 */
export function reconcile(
  verdicts: PageVerdict[],
  options: { annexes?: AnnexRule; texts?: Record<number, string> } = {}
): Segment[] {
  const total = verdicts.length;
  if (total === 0) return [];
  const annexes = options.annexes ?? "with_document";
  const starts: boolean[] = [];
  const notes = new Map<number, string[]>();
  const note = (page: number, message: string) => notes.set(page, [...(notes.get(page) ?? []), message]);
  const labels = verdicts.map((verdict) => parseLabel(verdict.page_label));

  let segmentType: DocType = verdicts[0].doc_type;
  for (let index = 0; index < total; index += 1) {
    const verdict = verdicts[index];
    const label = labels[index];
    const previous = index > 0 ? verdicts[index - 1] : null;
    const previousLabel = index > 0 ? labels[index - 1] : null;
    let start = index === 0 || verdict.starts_new_doc;
    const attach = index > 0 && annexes === "with_document" && ATTACHABLE.has(verdict.doc_type);

    if (index > 0 && label && !attach) {
      const continues =
        previousLabel !== null && previousLabel.total === label.total && previousLabel.index === label.index - 1;
      if (label.index === 1 && !start) {
        start = true;
        note(verdict.page, `Empieza de nuevo la numeración («${verdict.page_label}»).`);
      } else if (label.index > 1 && continues && start) {
        start = false;
        note(verdict.page, `Sigue la numeración de la página anterior («${verdict.page_label}»).`);
      }
    }

    if (attach && start) {
      start = false;
      note(
        verdict.page,
        verdict.doc_type === "ANEXO"
          ? "Anexo unido al documento anterior."
          : "Identificación unida al documento anterior."
      );
    }

    if (
      index > 0 &&
      !start &&
      previous?.has_signature_block &&
      verdict.doc_type === "ADENDUM" &&
      segmentType !== "ADENDUM"
    ) {
      start = true;
      note(verdict.page, "Adendum después de las firmas: va como documento propio.");
    }

    if (index > 0 && !start && verdict.starts_new_doc === false && verdict.confidence < 0.5 && verdict.confidence > 0) {
      note(verdict.page, `Posible corte dudoso en la página ${verdict.page}.`);
    }

    starts.push(start);
    if (start) segmentType = verdict.doc_type;
  }

  const segments: Segment[] = [];
  for (let index = 0; index < total; index += 1) {
    if (!starts[index]) continue;
    let end = index;
    while (end + 1 < total && !starts[end + 1]) end += 1;
    const first = verdicts[index];
    const inside = verdicts.slice(index, end + 1);
    const title = first.title || inside.find((verdict) => verdict.title)?.title || "";
    const segmentNotes = inside.flatMap((verdict) => notes.get(verdict.page) ?? []);
    const firstLine = firstLineOf(options.texts?.[first.page]);
    segments.push({
      start_page: first.page,
      end_page: verdicts[end].page,
      doc_type: first.doc_type,
      title,
      parties: first.parties.length ? first.parties : undefined,
      confidence: index === 0 ? 1 : first.confidence,
      evidence: first.evidence || undefined,
      first_line: firstLine || undefined,
      notes: segmentNotes.length ? segmentNotes : undefined,
    });
  }
  return segments;
}

const firstLineOf = (value?: string) =>
  (value ?? "")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 2)
    ?.slice(0, 160) ?? "";

// ----------------------------------------------------------------- ranges

/** "1-3, 7, 9–12" → [1, 2, 3, 7, 9, 10, 11, 12]; null when a part is not a page. */
export function parsePageList(value: string): number[] | null {
  const pages: number[] = [];
  for (const part of value.split(/[,;\s]+/).filter(Boolean)) {
    const match = /^(\d+)(?:[-–—](\d+))?$/.exec(part);
    if (!match) return null;
    const start = Number(match[1]);
    const end = Number(match[2] ?? match[1]);
    const step = end >= start ? 1 : -1;
    for (let page = start; page !== end + step; page += step) {
      pages.push(page);
      if (pages.length > 1000) return null;
    }
  }
  return pages;
}

export type PageOperation = "extract" | "remove" | "reorder";

/** The pages, in order, of the document an operation produces; or why not. */
export function pagesFor(
  operation: PageOperation,
  pages: number[],
  total: number
): { pages: number[] } | { error: string } {
  if (pages.length === 0) return { error: "Elige al menos una página." };
  const outside = pages.find((page) => !Number.isInteger(page) || page < 1 || page > total);
  if (outside !== undefined) return { error: `La página ${outside} no existe (el PDF tiene ${total}).` };
  if (operation === "extract") return { pages: [...new Set(pages)].sort((a, b) => a - b) };
  if (operation === "remove") {
    const removed = new Set(pages);
    const kept = Array.from({ length: total }, (_, index) => index + 1).filter((page) => !removed.has(page));
    return kept.length ? { pages: kept } : { error: "Quitar todas las páginas dejaría el PDF vacío." };
  }
  const sorted = [...pages].sort((a, b) => a - b);
  if (sorted.length !== total || sorted.some((page, index) => page !== index + 1)) {
    return { error: `Un orden nuevo debe incluir cada página del 1 al ${total} una sola vez.` };
  }
  return { pages };
}

/**
 * Segments that cover the document once, in order (1–5, 6–8, 9–20); or the
 * first problem in words the model can act on.
 */
export function validateSegments(
  segments: { start_page: number; end_page: number }[],
  total: number
): { ok: true } | { ok: false; error: string } {
  if (segments.length < 2) return { ok: false, error: "Para separar hacen falta al menos dos partes." };
  if (segments.length > PDF_LIMITS.maxSegments)
    return { ok: false, error: `Como máximo ${PDF_LIMITS.maxSegments} partes.` };
  let expected = 1;
  for (const { start_page: start, end_page: end } of segments) {
    if (!Number.isInteger(start) || !Number.isInteger(end)) return { ok: false, error: "Las páginas van en números." };
    if (start !== expected) {
      return {
        ok: false,
        error:
          start < expected
            ? `Las partes se enciman: la página ${start} ya está en la parte anterior.`
            : start - 1 === expected
              ? `Falta la página ${expected}: agrégala a una parte.`
              : `Faltan las páginas ${expected}–${start - 1}: agrégalas a una parte.`,
      };
    }
    if (end < start || end > total) {
      return { ok: false, error: `La parte ${start}–${end} se sale del documento (1–${total}).` };
    }
    expected = end + 1;
  }
  if (expected !== total + 1) {
    return { ok: false, error: `Las partes terminan en la página ${expected - 1}, pero el PDF tiene ${total}.` };
  }
  return { ok: true };
}

/** "Separados de Paquete 2024", without the .pdf */
export const baseName = (name: string) => name.replace(/\.pdf$/i, "").trim();
