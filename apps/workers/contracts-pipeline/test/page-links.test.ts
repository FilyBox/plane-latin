import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { collectEntities, linkMentions } from "../src/lib/page-links.ts";

const KINDS = ["contract", "file", "music_track"];
const A = "2ae6ed26-1111-4222-8333-444455556666";
const B = "9bc1aa10-1111-4222-8333-444455556666";

const results = [
  { results: [{ contract_id: A, titulo: "Contrato de edición Serrano", file_name: "serrano-2016.pdf" }] },
  { results: [{ contract_id: B, titulo: "Cesión de derechos Montoya" }] },
];

describe("page links", () => {
  it("links plain titles in tables, keeps text that names nothing", () => {
    const entities = collectEntities(results, KINDS);
    const { markdown, linked } = linkMentions(
      "| Contrato | Doc |\n|---|---|\n| **Contrato de edición Serrano** | INE |\n| Otro contrato | IFE |",
      entities
    );
    assert.equal(linked, 1);
    assert.ok(markdown.includes(`| :contract[Contrato de edición Serrano]{name=${A}} | INE |`));
    assert.ok(markdown.includes("| Otro contrato | IFE |"));
  });

  it("repairs a made-up id and the loose syntax, leaves known mentions and links alone", () => {
    const entities = collectEntities(results, KINDS);
    const input = `:contract[Cesión de derechos Montoya]{name="00000000-0000-4000-8000-000000000000"} y :contract[X]{name=${A}} [Contrato de edición Serrano](/a/b)`;
    const { markdown } = linkMentions(input, entities);
    assert.equal(
      markdown,
      `:contract[Cesión de derechos Montoya]{name=${B}} y :contract[X]{name=${A}} [Contrato de edición Serrano](/a/b)`
    );
  });

  it("keeps only the name of a mention with a broken id it can't repair", () => {
    assert.equal(linkMentions(":contract[Algo]{name=3f2c…}", collectEntities(results, KINDS)).markdown, "Algo");
  });

  it("skips a title shared by two items", () => {
    const entities = collectEntities(
      [
        {
          results: [
            { contract_id: A, titulo: "Contrato general" },
            { contract_id: B, titulo: "Contrato general" },
          ],
        },
      ],
      KINDS
    );
    assert.equal(linkMentions("Contrato general", entities).linked, 0);
  });
});
