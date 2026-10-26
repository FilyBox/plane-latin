import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  fitProposals,
  maxTokensFor,
  pageSizeFor,
  pickOffered,
  topicsForBatch,
  type TagProposal,
} from "../src/lib/tagging-batch.ts";
import { classifyPrompt } from "../src/tagging-prompts.ts";

const song = (text: string, title = "La Puerta") => ({ id: "1", title, text, tags: [] });

const tags = [
  { name: "Los Tigres", kind: "ARTIST", usage: 500 },
  { name: "Portada", kind: "TYPE", usage: 300 },
  { name: "Catálogo Norte", kind: "CUSTOM", usage: 2 },
  { name: "Campaña Verano", kind: "CUSTOM", usage: 40 },
  { name: "Pop", kind: "CUSTOM", usage: 1 },
];

describe("tag mapping batches", () => {
  it("reads songs and releases in bigger pages", () => {
    assert.equal(pageSizeFor("music_track"), 75);
    assert.equal(pageSizeFor("music_release"), 75);
    assert.equal(pageSizeFor("contract"), 40);
    assert.ok(maxTokensFor("music_track") > maxTokensFor("contract"));
  });

  it("offers existing topic tags named in the batch, never people or types", () => {
    const offered = topicsForBatch(
      tags,
      [song("catálogo: catalogo norte | artistas: Los Tigres | Portada")],
      "contract"
    );
    assert.deepEqual(offered, ["Catálogo Norte"]);
  });

  it("matches whole words only", () => {
    assert.deepEqual(topicsForBatch(tags, [song("géneros: Popular")], "contract"), []);
    assert.deepEqual(topicsForBatch(tags, [song("géneros: pop, rock")], "contract"), ["Pop"]);
  });

  it("adds the most used topic tags for songs and releases", () => {
    const offered = topicsForBatch(tags, [song("nada en común")], "music_track", { popular: 2 });
    assert.deepEqual(offered, ["Campaña Verano", "Catálogo Norte"]);
    assert.deepEqual(topicsForBatch(tags, [song("nada en común")], "file"), []);
  });

  it("keeps only offered tags, in their own spelling", () => {
    const offered = ["Catálogo Norte", "Campaña Verano"];
    assert.deepEqual(pickOffered(["catalogo norte", "Invented", "CAMPAÑA VERANO", "Catálogo Norte"], offered), [
      "Catálogo Norte",
      "Campaña Verano",
    ]);
    assert.deepEqual(pickOffered("Catálogo Norte", offered), []);
    assert.deepEqual(pickOffered(["Catálogo Norte"], []), []);
  });
});

describe("classify prompt", () => {
  it("is unchanged when there are no topic tags to offer", () => {
    const prompt = classifyPrompt("contract", [], [], [song("x")]);
    assert.ok(!prompt.includes('"etiquetas"'));
  });

  it("explains songs and lists the offered tags", () => {
    const prompt = classifyPrompt("music_track", [], ["Los Tigres"], [song("x")], ["Campaña Verano"]);
    assert.match(prompt, /canciones y videos del catálogo/);
    assert.match(prompt, /Nunca compositores/);
    assert.ok(prompt.includes('"etiquetas"') && prompt.includes('["Campaña Verano"]'));
  });
});

const item = (id: string, confidence: number) => ({
  entity_name: "music_track",
  id,
  title: `Song ${id}`,
  confidence,
  reason: "Artista principal en los créditos de la canción",
});
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

describe("fitting proposals", () => {
  const proposals: TagProposal[] = [
    { name: "Los Tigres", kind: "ARTIST", items: Array.from({ length: 40 }, (_, i) => item(`a${i}`, i / 40)) },
    { name: "Campaña", kind: "CUSTOM", items: Array.from({ length: 10 }, (_, i) => item(`b${i}`, 0.99)) },
  ];

  it("leaves small runs alone", () => {
    const result = fitProposals(proposals, 1_000_000);
    assert.equal(result.tags, proposals);
    assert.equal(result.dropped, 0);
  });

  it("drops reasons first, then the least confident items", () => {
    const withoutReasons = fitProposals(proposals, bytes(proposals) - 10);
    assert.equal(withoutReasons.dropped, 0);
    assert.ok(withoutReasons.tags.every((tag) => tag.items.every((entry) => entry.reason === "")));

    const tight = fitProposals(proposals, 2_500);
    assert.ok(bytes(tight.tags) <= 2_500);
    assert.ok(tight.dropped > 0);
    // The confident items survive.
    assert.equal(tight.tags.find((tag) => tag.name === "Campaña")?.items.length, 10);
  });
});
