import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  PRIMARY_SCHEMA,
  SECONDARY_SCHEMA,
  finalizeExtracted,
  isYearOnlyQuote,
  joinPageLines,
  locateQuote,
  mergePartResults,
  normalizeContractType,
  normalizeEvidence,
  packVector,
  partRanges,
  relevantTags,
  runValidated,
  summarizeUsage,
  textFingerprint,
  unpackVector,
  validateModelOutput,
  withEvidence,
} from "../src/lib/contract-analysis.ts";
import { artistsPrompt, contractPrefix, primaryPrompt, secondaryPrompt } from "../src/prompts.ts";

const TEXT = joinPageLines([
  { text: "CONTRATO DE REPRESENTACIÓN", page: 1 },
  { text: "Celebrado el 3 de marzo de 2020 entre Sello SA", page: 1 },
  { text: "y Juan Pérez, EL ARTISTA.", page: 2 },
  { text: "La vigencia será de tres años.", page: 2 },
  { text: "Firmado en 2019.", page: 3 },
]);

describe("page markers", () => {
  it("opens each page with a marker", () => {
    assert.ok(TEXT.startsWith("[[p. 1]]\nCONTRATO"));
    assert.ok(TEXT.includes("\n\n[[p. 2]]\ny Juan Pérez"));
    assert.equal(TEXT.match(/\[\[p\. \d+\]\]/g)?.length, 3);
  });

  it("keeps unpaged lines on the previous page", () => {
    assert.equal(joinPageLines([{ text: "a", page: 4 }, { text: "b" }]), "[[p. 4]]\na\nb");
  });

  it("finds the page of a quote, ignoring case, accents and line breaks", () => {
    assert.equal(locateQuote(TEXT, "vigencia sera de tres años"), 2);
    assert.equal(locateQuote(TEXT, "Sello SA y Juan"), null);
    assert.equal(locateQuote("no markers here", "no markers"), null);
  });
});

describe("evidence", () => {
  it("normalizes quotes, checks pages and flags year-only dates", () => {
    const evidence = normalizeEvidence(
      {
        fechaInicio: { cita: "Firmado en 2019.", pagina: 1 },
        duracionMeses: { cita: "La vigencia será de tres años.", pagina: 9 },
        involucrados: "y Juan Pérez, EL ARTISTA.",
        tipoContrato: { cita: "" },
        unknown: { cita: "x" },
      },
      TEXT,
      ["fechaInicio", "duracionMeses", "involucrados", "tipoContrato"],
      { fechaInicio: "2019-01-01" }
    );
    assert.deepEqual(evidence, {
      fechaInicio: { cita: "Firmado en 2019.", pagina: 3, aproximada: true },
      duracionMeses: { cita: "La vigencia será de tres años.", pagina: 2 },
      involucrados: { cita: "y Juan Pérez, EL ARTISTA.", pagina: 2 },
    });
  });

  it("drops the evidence key when nothing is backed by a quote", () => {
    assert.deepEqual(withEvidence({ artistas: ["Juan"], _evidence: { artistas: { cita: " " } } }, TEXT, ["artistas"]), {
      artistas: ["Juan"],
    });
    const kept = withEvidence({ artistas: ["Juan"], _evidence: { artistas: "Juan Pérez, EL ARTISTA" } }, TEXT, [
      "artistas",
    ]);
    assert.deepEqual(kept._evidence, { artistas: { cita: "Juan Pérez, EL ARTISTA", pagina: 2 } });
  });

  it("keeps pages null for text without markers", () => {
    const evidence = normalizeEvidence({ fechaFin: { cita: "hasta 2030", pagina: 4 } }, "hasta 2030", ["fechaFin"]);
    assert.deepEqual(evidence.fechaFin, { cita: "hasta 2030", pagina: null });
  });

  it("tells year-only quotes from full dates", () => {
    assert.equal(isYearOnlyQuote("durante el año 2021"), true);
    assert.equal(isYearOnlyQuote("el 3 de marzo de 2021"), false);
    assert.equal(isYearOnlyQuote("el 03/05/2021"), false);
  });
});

describe("shared prompt prefix", () => {
  it("puts the identical contract text first and instructions after", () => {
    const prefix = contractPrefix("a.pdf", "TEXTO");
    const prompts = [
      primaryPrompt(prefix, ["fechaInicio"]),
      secondaryPrompt(prefix, ["testigos"]),
      artistsPrompt(prefix, ["Juan"], ["artistas"]),
    ];
    for (const prompt of prompts) {
      assert.ok(prompt.startsWith(prefix));
      assert.match(prompt.slice(prefix.length), /json/);
    }
    assert.ok(!prompts[0].includes("estatusContrato"));
    assert.ok(prompts[0].includes("CESION_DERECHOS"));
  });
});

describe("validation", () => {
  it("accepts a valid answer and rejects truncated, broken or mistyped ones", () => {
    const ok = validateModelOutput(
      { text: '{"testigos":["A"],"esNotariado":false,"esEditorial":"true"}', truncated: false },
      SECONDARY_SCHEMA
    );
    assert.equal(ok.ok, true);
    assert.deepEqual(validateModelOutput({ text: "{}", truncated: true }, SECONDARY_SCHEMA), {
      ok: false,
      reason: "truncated",
      detail: "output hit the token limit",
    });
    const broken = validateModelOutput({ text: '{"testigos": ["A"', truncated: false }, SECONDARY_SCHEMA);
    assert.equal(broken.ok === false && broken.reason, "invalid_json");
    const wrong = validateModelOutput(
      { text: '{"tipoContrato": 3, "resumenGeneral": "x"}', truncated: false },
      PRIMARY_SCHEMA
    );
    assert.equal(wrong.ok === false && wrong.reason, "schema");
  });

  it("retries once, then repairs as a flagged last resort", async () => {
    const answers = ['{"esNotariado": tr', '{"esNotariado": true, "esEditorial": false}'];
    const good = await runValidated(
      async (attempt) => ({ text: answers[attempt - 1], truncated: false }),
      SECONDARY_SCHEMA,
      JSON.parse
    );
    assert.equal(good.attempts, 2);
    assert.equal(good.repaired, false);

    const repaired = await runValidated(
      async () => ({ text: '{"esNotariado": true, "esEditorial": false', truncated: false }),
      SECONDARY_SCHEMA,
      (text) => JSON.parse(`${text}}`)
    );
    assert.equal(repaired.repaired, true);
    assert.equal(repaired.outputs.length, 2);

    await assert.rejects(
      runValidated(async () => ({ text: "nope", truncated: false }), SECONDARY_SCHEMA, JSON.parse),
      /invalid model output/
    );
  });
});

describe("finalize and merge", () => {
  it("drops estatus, normalizes types, flags and months, and joins evidence", () => {
    const data = finalizeExtracted([
      {
        tipoContrato: "Management",
        estatusContrato: "VIGENTE",
        duracionMeses: "36 meses",
        _evidence: { tipoContrato: { cita: "a", pagina: 1 } },
      },
      { esNotariado: "false", esEditorial: "sí", _evidence: { esNotariado: { cita: "b", pagina: null } } },
    ]);
    assert.deepEqual(data, {
      tipoContrato: "REPRESENTACION",
      duracionMeses: 36,
      esNotariado: false,
      esEditorial: true,
      _evidence: { tipoContrato: { cita: "a", pagina: 1 }, esNotariado: { cita: "b", pagina: null } },
    });
    assert.equal(normalizeContractType("cesión derechos"), "CESION_DERECHOS");
    assert.equal(normalizeContractType("algo raro"), "OTRO");
  });

  it("merges parts: first value wins, lists join, notarized if any part says so", () => {
    const merged = mergePartResults([
      {
        fechaInicio: "2020-03-03",
        fechaFin: "",
        involucrados: ["Sello SA"],
        esNotariado: false,
        resumenGeneral: "inicio",
        _evidence: { fechaInicio: { cita: "x" } },
      },
      {
        fechaInicio: "2021-01-01",
        fechaFin: "2023-03-03",
        involucrados: ["sello sa", "Juan"],
        esNotariado: true,
        resumenGeneral: "fin",
        _evidence: { fechaFin: { cita: "y" }, fechaInicio: { cita: "z" } },
      },
    ]);
    assert.equal(merged.fechaInicio, "2020-03-03");
    assert.equal(merged.fechaFin, "2023-03-03");
    assert.deepEqual(merged.involucrados, ["Sello SA", "Juan"]);
    assert.equal(merged.esNotariado, true);
    assert.equal(merged.resumenGeneral, "inicio");
    // Evidence follows the part each value came from
    assert.deepEqual(merged._evidence, { fechaInicio: { cita: "x" }, fechaFin: { cita: "y" } });
  });

  it("cuts long texts into overlapping parts", () => {
    assert.deepEqual(partRanges(1_000), [[0, 1_000]]);
    assert.deepEqual(partRanges(100, 40, 10, 50), [
      [0, 40],
      [30, 70],
      [60, 100],
    ]);
  });
});

describe("tags, usage, hashing and vectors", () => {
  it("sends only the tags that appear in the text", () => {
    assert.deepEqual(relevantTags(["Juan Pérez", "3 Ball MTY", "Otro Artista", "Jo"], "juan perez y 3BALLMTY"), [
      "Juan Pérez",
      "3 Ball MTY",
    ]);
  });

  it("sums usage costs", () => {
    const usage = summarizeUsage([
      {
        prompt: "primary",
        model: "deepseek-flash",
        input_tokens: 10,
        cached_tokens: 0,
        output_tokens: 5,
        cost_usd: 0.0000011,
      },
      {
        prompt: "secondary",
        model: "deepseek-flash",
        input_tokens: 10,
        cached_tokens: 8,
        output_tokens: 5,
        cost_usd: 0.0000004,
      },
    ]);
    assert.equal(usage.total_cost_usd, 0.000002);
    assert.equal(usage.calls.length, 2);
  });

  it("fingerprints text and packs vectors", async () => {
    assert.equal((await textFingerprint("abc")).length, 16);
    assert.notEqual(await textFingerprint("abc"), await textFingerprint("abd"));
    const vector = [0.1, -0.25, 0.123456789];
    const back = unpackVector(packVector(vector));
    back.forEach((value, i) => assert.ok(Math.abs(value - vector[i]) < 1e-6));
  });
});
