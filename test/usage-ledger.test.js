// Usage ledger: observations only, never invented tokens, prices, or balances.

import test from "node:test";
import assert from "node:assert/strict";

import { UsageLedger, normaliseUsage } from "../src/core/usage-ledger.js";

test("provider usage is recorded with its source", () => {
  const ledger = new UsageLedger({ now: () => 1_000 });
  const record = ledger.record({
    provider: "groq",
    model: "groq/llama",
    outcome: "ok",
    usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
  });
  assert.deepEqual(record.tokens, { prompt: 12, completion: 8, total: 20 });
  assert.equal(record.usageSource, "provider");
  assert.equal(record.at, new Date(1_000).toISOString());
});

test("missing usage stays unknown rather than estimated", () => {
  const ledger = new UsageLedger({ now: () => 1_000 });
  const record = ledger.record({ provider: "p", model: "p/m", outcome: "ok" });
  assert.equal(record.tokens, null);
  assert.equal(record.usageSource, "unknown");
  assert.equal(ledger.summary().tokens.total, null);
});

test("a partial usage object keeps only the fields the provider sent", () => {
  assert.deepEqual(normaliseUsage({ prompt_tokens: 3 }).tokens, { prompt: 3, completion: null, total: null });
});

test("a prompt-only observation does not fabricate a total of zero", () => {
  const ledger = new UsageLedger({ now: () => 1_000 });
  ledger.record({ provider: "p", model: "p/m", outcome: "ok", usage: { prompt_tokens: 3 } });

  const summary = ledger.summary();
  assert.equal(summary.tokens.prompt, 3);
  assert.equal(summary.tokens.completion, null, "missing completion stays unknown");
  assert.equal(summary.tokens.total, null, "a total the provider never sent is not zero");
  assert.equal(summary.tokens.promptObservedRequests, 1);
  assert.equal(summary.tokens.totalObservedRequests, 0);
  assert.equal(summary.byModel["p/m"].totalTokens, null, "per-bucket totals follow the same rule");
});

test("cost without a named pricing source is discarded", () => {
  const ledger = new UsageLedger({ now: () => 1_000 });
  const noSource = ledger.record({ provider: "p", model: "p/m", outcome: "ok", costUsd: 0.5 });
  assert.equal(noSource.costUsd, null);
  assert.equal(noSource.pricingSource, null);

  const sourced = ledger.record({
    provider: "p",
    model: "p/m",
    outcome: "ok",
    costUsd: 0.5,
    pricingSource: "provider-price-list:2026-01",
  });
  assert.equal(sourced.costUsd, 0.5);
  assert.equal(sourced.pricingSource, "provider-price-list:2026-01");
  assert.equal(ledger.summary().cost.usd, 0.5);
  assert.equal(ledger.summary().cost.unknownRequests, 1);
});

test("the ledger records no prompt, response, header, or credential fields", () => {
  const ledger = new UsageLedger({ now: () => 1_000 });
  const record = ledger.record(/** @type {object} */ ({
    provider: "p",
    model: "p/m",
    outcome: "ok",
    prompt: "SECRET_PROMPT",
    response: "SECRET_RESPONSE",
    headers: { authorization: "Bearer SECRET" },
  }));
  const text = JSON.stringify(record);
  assert.doesNotMatch(text, /SECRET/);
});

test("retry accounting counts requests, not assistant turns", () => {
  const ledger = new UsageLedger({ now: () => 1_000 });
  ledger.record({ provider: "p", model: "p/a", outcome: "server", attempt: 1, retryCount: 0 });
  ledger.record({ provider: "q", model: "q/b", outcome: "ok", attempt: 2, retryCount: 1 });
  const summary = ledger.summary();
  assert.equal(summary.requests, 2);
  assert.equal(summary.retries, 1);
  assert.equal(summary.byProvider.p.failed, 1);
  assert.equal(summary.byProvider.q.ok, 1);
});

test("the ledger is bounded and summaries follow the retained records", () => {
  const ledger = new UsageLedger({ now: () => 1_000, maxRecords: 3 });
  for (let i = 0; i < 5; i++) ledger.record({ provider: "p", model: `p/m${i}`, outcome: "ok" });
  assert.equal(ledger.records().length, 3);
  assert.deepEqual(ledger.records().map((r) => r.model), ["p/m2", "p/m3", "p/m4"]);
  assert.equal(ledger.summary().requests, 3);
});

test("toJSON/fromJSON round-trips bounded records", () => {
  const ledger = new UsageLedger({ now: () => 1_000, maxRecords: 2 });
  ledger.record({ provider: "p", model: "p/a", outcome: "ok" });
  ledger.record({ provider: "p", model: "p/b", outcome: "ok" });
  const restored = new UsageLedger({ now: () => 1_000, maxRecords: 2 }).fromJSON(ledger.toJSON());
  assert.equal(restored.records().length, 2);
  assert.equal(restored.records()[1].model, "p/b");
});
