import { test } from "node:test";
import assert from "node:assert/strict";
import { receiptData, receiptPrompt } from "../src/expenses/extraction.ts";

test("receipt output never creates payment, recurrence or arbitrary fields", () => {
  const result = receiptData({ amount: "123.45", currency: "MXN", status: "PAID", recurrence: "MONTHLY", category: "other-workspace", tags: ["Office", 12], concept: "Receipt" });
  assert.equal(result.amount, "123.45");
  assert.deepEqual(result.tags, ["Office"]);
  assert.equal(result.status, undefined);
  assert.equal(result.category, undefined);
  assert.equal(result.recurrence, undefined);
});
test("ambiguous and excessive money values stay missing for human review", () => {
  for (const amount of ["$1,200", "-12", "1e9", "9999999999999", {}, null]) assert.equal(receiptData({ amount }).amount, null);
  assert.equal(receiptData({ currency: "pesos", expense_date: "next Friday" }).currency, null);
  assert.throws(() => receiptData([]));
});
test("receipt prompt bounds document text and treats it as untrusted", () => {
  const prompt = receiptPrompt("x".repeat(200000));
  assert.ok(prompt.includes("untrusted document"));
  assert.ok(prompt.length < 102000);
});
