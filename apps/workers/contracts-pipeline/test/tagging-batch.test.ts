import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  clusterNames,
  editDistance,
  fitProposals,
  isSoftModelFailure,
  joinGroups,
  nameKey,
  packClusters,
  maxTokensFor,
  pageSizeFor,
  pickOffered,
  salvageItems,
  splitInto,
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
  it("reads songs and releases in bigger pages, with room for every answer row", () => {
    assert.equal(pageSizeFor("music_track"), 40);
    assert.equal(pageSizeFor("music_release"), 40);
    assert.equal(pageSizeFor("contract"), 20);
    assert.equal(maxTokensFor("contract"), 8192);
  });

  it("keeps the complete rows of an answer cut off mid-row", () => {
    const cut =
      '{"items": [{"id": "a", "artistas": ["X"], "confianza": 0.9, "razon": "ok"}, ' +
      '{"id": "b", "artistas": [], "confianza": 0.7, "razon": "con } y ] dentro"}, {"id": "c", "confianza":}]}';
    assert.deepEqual(
      salvageItems(cut).map((row) => row.id),
      ["a", "b"]
    );
    assert.deepEqual(
      salvageItems('{"items": [{"id": "z"}]}').map((row) => row.id),
      ["z"]
    );
    assert.deepEqual(salvageItems(""), []);
    assert.deepEqual(salvageItems('{"items": [{"id": "a", "razon": "sin cerrar'), []);
  });

  it("splits a batch into halves and quarters", () => {
    assert.deepEqual(splitInto([1, 2, 3, 4, 5], 2), [
      [1, 2, 3],
      [4, 5],
    ]);
    assert.equal(splitInto([1, 2, 3, 4, 5], 4).length, 3);
    assert.deepEqual(splitInto([1], 4), [[1]]);
  });

  it("tells an unusable answer from an outage", () => {
    assert.ok(isSoftModelFailure(new Error("DeepSeek returned an empty response")));
    assert.ok(isSoftModelFailure(new SyntaxError('Unexpected token \'}\', ..."onfianza":}]}" is not valid JSON')));
    assert.ok(!isSoftModelFailure(new Error("DeepSeek -> 503: overloaded")));
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

describe("joining spellings of a name", () => {
  it("gives one key to names that only differ in case, spaces or accents", () => {
    assert.equal(nameKey("3ball Mty"), nameKey("3BallMTY"));
    assert.equal(nameKey("3-Ball MTY"), "3ballmty");
    assert.equal(nameKey("Ángela Aguilar"), nameKey("angela aguilar"));
    assert.notEqual(nameKey("3BALLMNTY"), nameKey("3BallMTY"));
  });

  it("counts typos, swaps included, and gives up early", () => {
    assert.equal(editDistance("3ballmnty", "3ballmty", 2), 1);
    assert.equal(editDistance("tigres", "tigers", 1), 1);
    assert.equal(editDistance("abcdef", "uvwxyz", 1), 2);
  });

  it("joins same-key names without the model and sends look-alikes for review", () => {
    const { exact, review } = clusterNames([
      "3ball Mty",
      "3BALLMNTY",
      "3BallMTY",
      "Los Tigres",
      "Tigres",
      "Kany",
      "Kanye",
    ]);
    assert.deepEqual(exact, [["3ball Mty", "3BallMTY"]]);
    assert.ok(review.some((cluster) => cluster.includes("3BALLMNTY") && cluster.includes("3BallMTY")));
    assert.ok(review.some((cluster) => cluster.includes("Los Tigres") && cluster.includes("Tigres")));
    // Short names: one letter is another artist
    assert.ok(!review.some((cluster) => cluster.includes("Kany")));
  });

  it("keeps tags that only differ in accents or case as separate spellings to join", () => {
    const { exact } = clusterNames(["América Sierra", "America Sierra", "3ball Mty", "3Ball Mty"]);
    assert.deepEqual(exact, [
      ["América Sierra", "America Sierra"],
      ["3ball Mty", "3Ball Mty"],
    ]);
  });

  it("never offers a collaboration as a spelling of one artist", () => {
    const { review } = clusterNames(["Carin León", "Carin Leon / Grupo Frontera", "Carin Leonn"]);
    assert.ok(review.every((cluster) => !cluster.includes("Carin Leon / Grupo Frontera")));
  });

  it("packs look-alikes into calls and joins overlapping groups", () => {
    assert.equal(
      packClusters(
        [
          ["a", "b"],
          ["c", "d"],
          ["e", "f"],
        ],
        4
      ).length,
      2
    );
    assert.deepEqual(
      joinGroups([
        ["A", "B"],
        ["B", "C"],
        ["X", "Y"],
      ]),
      [
        ["A", "B", "C"],
        ["X", "Y"],
      ]
    );
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
