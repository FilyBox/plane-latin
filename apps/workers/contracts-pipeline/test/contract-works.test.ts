import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  WORKS_SCHEMA,
  joinPageLines,
  mergeWorks,
  normalizeWorks,
  splitMatches,
  toWorkPayload,
  validateModelOutput,
  worksFocus,
} from "../src/lib/contract-analysis.ts";
import { contractPrefix, worksPrompt } from "../src/prompts.ts";

const TEXT = joinPageLines([
  { text: "CONTRATO DE DISTRIBUCIÓN entre Sello SA y Juan Pérez.", page: 1 },
  { text: "ANEXO A. Obras: 1. «Tú y Yo» (ISRC MX-A01-23-00001), interpretada por Juan Pérez.", page: 2 },
  { text: "2. Noche de Verano. Álbum: Caminos (UPC 0123456789012).", page: 3 },
]);

describe("works schema", () => {
  it("accepts a list or null, and rejects a missing or non-list obras", () => {
    assert.equal(validateModelOutput({ text: '{"obras": []}', truncated: false }, WORKS_SCHEMA).ok, true);
    assert.equal(validateModelOutput({ text: '{"obras": null}', truncated: false }, WORKS_SCHEMA).ok, true);
    assert.equal(validateModelOutput({ text: "{}", truncated: false }, WORKS_SCHEMA).ok, false);
    assert.equal(validateModelOutput({ text: '{"obras": "Tú y Yo"}', truncated: false }, WORKS_SCHEMA).ok, false);
  });
});

describe("normalizeWorks", () => {
  it("cleans codes, checks pages, and drops works not in the text", () => {
    const works = normalizeWorks(
      [
        {
          titulo: "“Tú y Yo”",
          artistas: "Juan Pérez",
          isrc: "MX-A01-23-00001",
          tipo: "canción",
          cita: "«Tú y Yo» (ISRC MX-A01-23-00001)",
          pagina: 9,
        },
        { titulo: "Caminos", upc: "0123456789012", tipo: "album" },
        { titulo: "Inventada Total", cita: "no está" },
        { titulo: "" },
        "basura",
        { titulo: "tu y yo", isrc: "MXA012300001" },
      ],
      TEXT
    );
    assert.deepEqual(works, [
      {
        titulo: "Tú y Yo",
        artistas: ["Juan Pérez"],
        isrc: "MXA012300001",
        tipo: "cancion",
        cita: "«Tú y Yo» (ISRC MX-A01-23-00001)",
        pagina: 2,
      },
      { titulo: "Caminos", upc: "0123456789012", tipo: "album", pagina: null },
    ]);
    assert.deepEqual(normalizeWorks(null, TEXT), []);
  });

  it("merges parts without repeats and builds Django's payload", () => {
    const a = normalizeWorks([{ titulo: "Noche de Verano", cita: "2. Noche de Verano." }], TEXT);
    const b = normalizeWorks([{ titulo: "NOCHE DE VERANO" }, { titulo: "Caminos", tipo: "album" }], TEXT);
    const merged = mergeWorks([a, b]);
    assert.deepEqual(
      merged.map((work) => work.titulo),
      ["Noche de Verano", "Caminos"]
    );
    assert.deepEqual(toWorkPayload(merged), [
      { title: "Noche de Verano", cita: "2. Noche de Verano.", pagina: 3 },
      { title: "Caminos", kind: "release" },
    ]);
  });
});

describe("works focus and prompt", () => {
  it("keeps short texts whole and long ones to the opening plus annex windows", () => {
    assert.deepEqual(worksFocus("corto", 100), { text: "corto", excerpted: false });
    const long = `${"a".repeat(30_000)}\n[[p. 7]]\n${"b".repeat(20_000)} ANEXO 1: Canción Uno ${"c".repeat(40_000)}`;
    const focus = worksFocus(long, 30_000);
    assert.equal(focus.excerpted, true);
    assert.ok(focus.text.startsWith("a".repeat(100)));
    assert.ok(focus.text.includes("[[p. 7]]\n"));
    assert.ok(focus.text.includes("ANEXO 1: Canción Uno"));
    assert.ok(focus.text.length <= 30_000 + 200);
  });

  it("puts the contract text first and the instructions after", () => {
    const prefix = contractPrefix("a.pdf", "TEXTO");
    const prompt = worksPrompt(prefix);
    assert.ok(prompt.startsWith(prefix));
    assert.match(prompt.slice(prefix.length), /json/);
    assert.match(prompt, /"obras": \[\]/);
    assert.ok(!prompt.includes("fragmentos del contrato"));
    const focused = worksPrompt(prefix, { excerpted: true, focus: "las del anexo B" });
    assert.ok(focused.includes("fragmentos del contrato"));
    assert.ok(focused.includes("las del anexo B"));
  });
});

describe("splitMatches", () => {
  it("splits matched and unmatched works from a tolerant answer", () => {
    const works = [
      { title: "Tú y Yo", isrc: "MXA012300001" },
      { title: "Caminos", kind: "release" as const },
      { title: "Nueva" },
    ];
    const { matched, unmatched } = splitMatches(
      works,
      {
        results: [
          {
            index: 0,
            match: { entity_type: "music_track", entity_id: "t1", title: "Tú y Yo", artists: ["Juan"], confidence: 1 },
          },
          {
            index: 1,
            candidates: [
              {
                entity_type: "music_release",
                entity_id: "r1",
                entity: { title: "Caminos", path: "/ws/music?release=r1" },
              },
            ],
          },
          { index: 2, match: null },
        ],
      },
      "ws"
    );
    assert.deepEqual(matched, [
      {
        work: works[0],
        entity_type: "music_track",
        entity_id: "t1",
        title: "Tú y Yo",
        path: "/ws/music?track=t1",
        artists: "Juan",
        confidence: 1,
      },
      { work: works[1], entity_type: "music_release", entity_id: "r1", title: "Caminos", path: "/ws/music?release=r1" },
    ]);
    assert.deepEqual(unmatched, [{ work: works[2] }]);
    assert.deepEqual(splitMatches(works, null, "ws").unmatched.length, 3);
  });
});

import { splitMatches as splitDjango } from "../src/lib/contract-analysis.ts";
import assertDjango from "node:assert/strict";
import { it as itDjango } from "node:test";

itDjango("reads Django's {matched, unmatched} match response", () => {
  const works = [{ title: "Amor" }, { title: "Nueva" }];
  const { matched, unmatched } = splitDjango(
    works,
    {
      matched: [
        { index: 0, entity_type: "music_track", entity_id: "11111111-1111-4111-8111-111111111111", title: "Amor" },
      ],
      unmatched: [{ index: 1, work: works[1] }],
    },
    "ws"
  );
  assertDjango.equal(matched.length, 1);
  assertDjango.equal(matched[0].entity_id, "11111111-1111-4111-8111-111111111111");
  assertDjango.equal(unmatched.length, 1);
});
