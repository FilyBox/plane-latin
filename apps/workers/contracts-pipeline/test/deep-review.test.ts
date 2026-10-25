import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assignLanes,
  chunkCount,
  estimateDeepReview,
  mergeChunkAnswers,
  parseChunkAnswer,
  splitText,
} from "../src/deep-review/core.ts";
import { deepseekCallCost, deepseekPrice, nextDeepseekOffPeak } from "../src/lib/pricing.ts";

const FLASH = { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 };

describe("estimateDeepReview", () => {
  it("prices 300 contracts of ~50 pages within the expected range", () => {
    const sizes = Array.from({ length: 300 }, () => 150_000);
    const estimate = estimateDeepReview(
      sizes,
      { "deepseek-flash": FLASH },
      {
        lanes: 50,
        nowPeak: true,
        defaultModel: "deepseek-flash",
      }
    );
    const { peak, off_peak: offPeak } = estimate.models["deepseek-flash"];
    // 45M bytes x 0.26–0.34 tokens/byte at $0.30/M input
    assert.ok(peak.low > 3.5 && peak.low < 4.5, `low ${peak.low}`);
    assert.ok(peak.high > 4.5 && peak.high < 5.5, `high ${peak.high}`);
    assert.equal(offPeak.high, Math.round((peak.high / 2) * 10_000) / 10_000);
    assert.equal(estimate.chunks, 300);
    assert.equal(estimate.lanes, 50);
  });

  it("counts chunks for texts longer than one call", () => {
    assert.equal(chunkCount(100), 1);
    assert.equal(chunkCount(2_000_000), 3);
  });
});

describe("assignLanes", () => {
  it("balances total size and never creates more lanes than contracts", () => {
    const items = [
      { id: "a", bytes: 600 },
      { id: "b", bytes: 300 },
      { id: "c", bytes: 300 },
      { id: "d", bytes: 10 },
    ];
    const lanes = assignLanes(items, 2);
    assert.equal(lanes.length, 2);
    // 600 alone vs 300 + 300, then the 10 goes to the first of the tied lanes
    assert.deepEqual(lanes, [
      ["a", "d"],
      ["b", "c"],
    ]);
    assert.equal(assignLanes(items, 50).length, 4);
    assert.equal(assignLanes([], 50).length, 0);
  });
});

describe("splitText", () => {
  it("keeps short texts whole and overlaps long ones", () => {
    assert.deepEqual(splitText("abc", 10, 2), ["abc"]);
    const parts = splitText("0123456789abcdef", 8, 2);
    assert.deepEqual(parts, ["01234567", "6789abcd", "cdef"]);
    assert.ok(parts.join("").includes("0123456789abcdef".slice(0, 8)));
  });
});

describe("chunk answers", () => {
  it("normalizes the model's keys and drops bad dates", () => {
    const answer = parseChunkAnswer({
      coincide: "true",
      confianza: 140,
      razon: "Tiene exclusividad",
      cita: "en exclusiva",
      fechaInicio: "2020-01-01",
      fechaFin: "31/12/2021",
      artistas: ["A", 3],
    });
    assert.equal(answer.matches, true);
    assert.equal(answer.confidence, 100);
    assert.equal(answer.start_date, "2020-01-01");
    assert.equal(answer.end_date, null);
    assert.deepEqual(answer.artists, ["A", "3"]);
  });

  it("matches when any chunk does and keeps the most confident reason", () => {
    const base = parseChunkAnswer({ coincide: false, confianza: 90, razon: "no", fechaInicio: "2019-05-01" });
    const hit = parseChunkAnswer({ coincide: true, confianza: 70, razon: "sí", cita: "cláusula 9" });
    const merged = mergeChunkAnswers([base, hit]);
    assert.equal(merged.matches, true);
    assert.equal(merged.reason, "sí");
    assert.equal(merged.quote, "cláusula 9");
    assert.equal(merged.start_date, "2019-05-01");
  });
});

describe("pricing", () => {
  it("halves the cost off-peak and waits for the end of a peak window", () => {
    const peak = new Date("2026-10-26T07:30:00Z"); // Monday, 06–10 UTC window
    const offPeak = new Date("2026-10-25T07:30:00Z"); // Sunday
    const usage = { cacheHit: 0, cacheMiss: 1_000_000, output: 0 };
    assert.equal(deepseekCallCost("deepseek-flash", usage, peak), 0.3);
    assert.equal(deepseekCallCost("deepseek-flash", usage, offPeak), 0.15);
    assert.equal(nextDeepseekOffPeak(peak).toISOString(), "2026-10-26T10:00:00.000Z");
    assert.equal(nextDeepseekOffPeak(offPeak), offPeak);
    assert.deepEqual(deepseekPrice("deepseek-chat"), FLASH);
  });
});
