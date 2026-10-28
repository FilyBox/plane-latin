import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  batches,
  joinBatches,
  normalizeVerdicts,
  pagesFor,
  parseLabel,
  parsePageList,
  reconcile,
  validateSegments,
  type PageVerdict,
} from "../src/lib/pdf-segments.ts";

const page = (number: number, overrides: Partial<PageVerdict> = {}): PageVerdict => ({
  page: number,
  starts_new_doc: false,
  doc_type: "CONTRATO",
  title: "",
  parties: [],
  page_label: "",
  has_signature_block: false,
  confidence: 0.9,
  evidence: "",
  ...overrides,
});

const ranges = (segments: { start_page: number; end_page: number }[]) =>
  segments.map((segment) => `${segment.start_page}-${segment.end_page}`);

describe("pdf batches", () => {
  it("reads 25 pages at a time sharing 2 with the next batch", () => {
    assert.deepEqual(batches(60), [
      { from: 1, to: 25 },
      { from: 24, to: 48 },
      { from: 47, to: 60 },
    ]);
    assert.deepEqual(batches(25), [{ from: 1, to: 25 }]);
    assert.deepEqual(batches(26), [
      { from: 1, to: 25 },
      { from: 24, to: 26 },
    ]);
    assert.deepEqual(batches(0), []);
  });

  it("keeps only pages of the batch, once, with sane fields", () => {
    const verdicts = normalizeVerdicts(
      {
        pages: [
          { page: 3, starts_new_doc: true, doc_type: "adendum", confidence: 3, parties: ["A", 4, ""] },
          { page: 3, starts_new_doc: false },
          { page: 9, starts_new_doc: true },
          { page: "x" },
          { page: 2, doc_type: "MEMO" },
        ],
      },
      2,
      5
    );
    assert.deepEqual(
      verdicts.map((verdict) => [verdict.page, verdict.doc_type, verdict.starts_new_doc, verdict.confidence]),
      [
        [2, "OTRO", false, 0.5],
        [3, "ADENDUM", true, 1],
      ]
    );
    assert.deepEqual(verdicts[1].parties, ["A"]);
    assert.deepEqual(normalizeVerdicts("nonsense", 1, 5), []);
  });

  it("settles overlap pages with the batch that saw both sides of them", () => {
    const first = { from: 1, to: 25, verdicts: [page(1), page(24, { starts_new_doc: false }), page(25)] };
    // In the second batch page 24 is the first page: it can't see what came before
    const second = { from: 24, to: 30, verdicts: [page(24, { starts_new_doc: true }), page(25), page(26)] };
    const joined = joinBatches([first, second], 30);
    assert.equal(joined.length, 30);
    assert.equal(joined[23].starts_new_doc, false);
    // A page nobody answered continues, with no confidence
    assert.equal(joined[28].confidence, 0);
  });
});

describe("pdf reconciliation", () => {
  it("cuts where documents start and keeps annexes with their document", () => {
    const segments = reconcile(
      [
        page(1, { title: "Contrato de edición", evidence: "CONTRATO DE EDICIÓN" }),
        page(2),
        page(3, { has_signature_block: true }),
        page(4, { starts_new_doc: true, doc_type: "ANEXO" }),
        page(5, { starts_new_doc: true, doc_type: "IDENTIFICACION" }),
        page(6, { starts_new_doc: true, doc_type: "ADENDUM", title: "Adendum 1", confidence: 0.55 }),
        page(7, { doc_type: "ADENDUM" }),
      ],
      { texts: { 1: "\n  CONTRATO DE EDICIÓN MUSICAL\nque celebran" } }
    );
    assert.deepEqual(ranges(segments), ["1-5", "6-7"]);
    assert.equal(segments[0].title, "Contrato de edición");
    assert.equal(segments[0].first_line, "CONTRATO DE EDICIÓN MUSICAL");
    assert.equal(segments[0].confidence, 1);
    assert.ok(segments[0].notes?.some((note) => note.startsWith("Anexo unido")));
    assert.equal(segments[1].doc_type, "ADENDUM");
    assert.equal(segments[1].confidence, 0.55);
  });

  it("separates annexes when asked to", () => {
    const segments = reconcile([page(1), page(2, { starts_new_doc: true, doc_type: "ANEXO" }), page(3)], {
      annexes: "separate",
    });
    assert.deepEqual(ranges(segments), ["1-1", "2-3"]);
  });

  it('anchors ranges on "1 de N" numbering', () => {
    const segments = reconcile([
      page(1, { page_label: "1 de 3" }),
      page(2, { page_label: "2 de 3", starts_new_doc: true }),
      page(3, { page_label: "3 de 3" }),
      // Same format again: the model missed it, the numbering restart doesn't
      page(4, { page_label: "Página 1 de 2" }),
      page(5, { page_label: "2/2" }),
    ]);
    assert.deepEqual(ranges(segments), ["1-3", "4-5"]);
    assert.ok(segments[1].notes?.some((note) => note.includes("numeración")));
  });

  it("an addendum after a signature block is its own document", () => {
    const segments = reconcile([
      page(1),
      page(2, { has_signature_block: true }),
      page(3, { doc_type: "ADENDUM" }),
      page(4, { doc_type: "ADENDUM" }),
    ]);
    assert.deepEqual(ranges(segments), ["1-2", "3-4"]);
  });

  it("notes doubtful continuations", () => {
    const segments = reconcile([page(1), page(2, { confidence: 0.3 }), page(3)]);
    assert.deepEqual(ranges(segments), ["1-3"]);
    assert.ok(segments[0].notes?.some((note) => note.includes("página 2")));
  });

  it("parses printed page numbers", () => {
    assert.deepEqual(parseLabel("Página 2 de 5"), { index: 2, total: 5 });
    assert.deepEqual(parseLabel("3/4"), { index: 3, total: 4 });
    assert.deepEqual(parseLabel("1 of 9"), { index: 1, total: 9 });
    assert.equal(parseLabel("6 de 5"), null);
    assert.equal(parseLabel(""), null);
  });
});

describe("pdf ranges", () => {
  it("accepts parts that cover the document once", () => {
    const ok = validateSegments(
      [
        { start_page: 1, end_page: 5 },
        { start_page: 6, end_page: 8 },
        { start_page: 9, end_page: 20 },
      ],
      20
    );
    assert.deepEqual(ok, { ok: true });
  });

  it("explains gaps, overlaps and pages outside the document", () => {
    const check = (segments: [number, number][], total = 10) => {
      const result = validateSegments(
        segments.map(([start_page, end_page]) => ({ start_page, end_page })),
        total
      );
      return result.ok ? "ok" : result.error;
    };
    assert.match(check([[1, 10]]), /al menos dos/);
    assert.match(
      check([
        [1, 4],
        [4, 10],
      ]),
      /enciman/
    );
    assert.match(
      check([
        [1, 3],
        [6, 10],
      ]),
      /Faltan las páginas 4–5/
    );
    assert.match(
      check([
        [1, 3],
        [5, 10],
      ]),
      /Falta la página 4:/
    );
    assert.match(
      check([
        [1, 3],
        [4, 12],
      ]),
      /se sale/
    );
    assert.match(
      check([
        [1, 3],
        [4, 8],
      ]),
      /terminan en la página 8/
    );
  });

  it("reads page lists and works out the new document", () => {
    assert.deepEqual(parsePageList("1-3, 7, 9–10"), [1, 2, 3, 7, 9, 10]);
    assert.deepEqual(parsePageList("3-1"), [3, 2, 1]);
    assert.equal(parsePageList("1, dos"), null);
    assert.deepEqual(pagesFor("extract", [5, 2, 2], 6), { pages: [2, 5] });
    assert.deepEqual(pagesFor("remove", [1, 6], 6), { pages: [2, 3, 4, 5] });
    assert.deepEqual(pagesFor("reorder", [3, 1, 2], 3), { pages: [3, 1, 2] });
    assert.ok("error" in pagesFor("reorder", [3, 1], 3));
    assert.ok("error" in pagesFor("remove", [1, 2], 2));
    assert.ok("error" in pagesFor("extract", [7], 6));
  });
});
