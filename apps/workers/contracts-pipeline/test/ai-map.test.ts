import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildAiMapQuery, normalizeAiMapping } from "../src/lib/ai-map-result.ts";

const context = {
  headers: ["Track Name", "Isrc", "Writers", "Composers", "Track Play Link"],
  fields: ["track.title", "track.isrc", "writers", "track.streaming_url"],
  multi: ["writers", "track.streaming_url"],
  locked: ["track.title"],
};

describe("AI column mapping", () => {
  it("keeps only real fields and headers, one column for single fields", () => {
    const { mapping, suggestions } = normalizeAiMapping(
      {
        "track.title": { columns: ["Track Name", "Isrc"], confidence: 0.95, reason: "Nombre de la canción" },
        "track.isrc": "Isrc",
        writers: { columns: ["Writers", "Composers", "Nope"], confidence: 80, replace: true },
        "not.a.field": "Isrc",
        "track.streaming_url": ["Made Up"],
      },
      context
    );
    assert.deepEqual(mapping, { "track.title": "Track Name", "track.isrc": "Isrc", writers: ["Writers", "Composers"] });
    assert.deepEqual(suggestions["track.title"], {
      columns: ["Track Name"],
      confidence: 0.95,
      reason: "Nombre de la canción",
      replace: false,
      locked: true,
    });
    // Old bare shape: no confidence, no reason
    assert.deepEqual(suggestions["track.isrc"], {
      columns: ["Isrc"],
      confidence: null,
      reason: "",
      replace: false,
      locked: false,
    });
    // Percent confidence is scaled; replace only makes sense for multi fields
    assert.equal(suggestions.writers.confidence, 0.8);
    assert.equal(suggestions.writers.replace, true);
  });

  it("tolerates garbage", () => {
    assert.deepEqual(normalizeAiMapping(null, context), { mapping: {}, suggestions: {} });
    assert.deepEqual(normalizeAiMapping(["Isrc"], context), { mapping: {}, suggestions: {} });
    const { suggestions } = normalizeAiMapping(
      { "track.isrc": { column: "Isrc", confidence: "nope", reason: 42, replace: true } },
      context
    );
    assert.deepEqual(suggestions["track.isrc"], {
      columns: ["Isrc"],
      confidence: null,
      reason: "",
      replace: false,
      locked: false,
    });
  });

  it("sends the current mapping, locked fields and descriptions to the model", () => {
    const query = JSON.parse(
      buildAiMapQuery({
        columns: { Isrc: { non_empty: 3, total: 3, examples: ["USRC17607839"] } },
        canonical_fields: ["track.isrc"],
        multi_fields: [],
        locale: "en-US",
        current_mapping: { "track.title": "Track Name" },
        locked_fields: ["track.title"],
        constants: { "track.language": "es" },
        field_descriptions: { "track.isrc": "ISRC code of the recording" },
      })
    );
    assert.equal(query.locale, "en (English)");
    assert.deepEqual(query.current_mapping, { "track.title": "Track Name" });
    assert.deepEqual(query.locked_fields, ["track.title"]);
    assert.deepEqual(query.constants, ["track.language"]);
    assert.equal(query.field_descriptions["track.isrc"], "ISRC code of the recording");
    assert.equal(
      JSON.parse(buildAiMapQuery({ columns: {}, canonical_fields: [], multi_fields: [] })).locale,
      "es (español)"
    );
  });
});
