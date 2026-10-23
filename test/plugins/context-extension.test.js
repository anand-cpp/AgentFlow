// Unit tests for the context enricher extension point: validation,
// namespacing, serial collection with token budget, skip-not-truncate
// behaviour, timeout isolation, and rendering.
import test from "node:test";
import assert from "node:assert/strict";

import {
  PluginContextRegistry,
  renderPluginContext,
  estimateTokens,
  validateContextDef,
} from "../../src/core/plugins/context-extension.js";

const goodDef = { name: "notes", getContext: () => "some notes" };

test("validateContextDef catches malformed definitions", () => {
  assert.match(validateContextDef(null)[0], /must be an object/);
  assert.match(validateContextDef({ ...goodDef, name: "Bad Name!" })[0], /name must match/);
  assert.match(validateContextDef({ ...goodDef, getContext: null })[0], /getContext must be a function/);
  assert.deepEqual(validateContextDef(goodDef), []);
});

test("estimator matches the repo-wide chars/4 arithmetic", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("1234"), 1);
  assert.equal(estimateTokens("12345"), 2, "ceil, not floor: rounding up protects the budget");
  assert.equal(estimateTokens(null), 0);
});

test("register namespaces the provider name", () => {
  const reg = new PluginContextRegistry();
  const res = reg.register("plug", goodDef);
  assert.equal(res.ok, true);
  assert.equal(res.name, "plugin__plug__notes");
  assert.equal(reg.size, 1);
  assert.match(reg.register("plug", goodDef).error, /already registered/);
});

test("enrich collects blocks serially under the token budget", async () => {
  const reg = new PluginContextRegistry();
  const calls = [];
  reg.register("a", { name: "one", getContext: (_p) => { calls.push("a"); return "x".repeat(40); } });
  reg.register("b", { name: "two", getContext: (_p) => { calls.push("b"); return "y".repeat(40); } });
  const out = await reg.enrich({ query: "test" }, { tokenBudget: 20 });
  assert.equal(out.tokensUsed, 20, "2 blocks x 10 tokens each (40 chars / 4)");
  assert.equal(out.blocks.length, 2);
  assert.deepEqual(calls, ["a", "b"], "serial in sorted-name order");
});

test("a block that does not fit is skipped whole, not truncated", async () => {
  const reg = new PluginContextRegistry();
  reg.register("a", { name: "small", getContext: () => "w".repeat(16) }); // 4 tokens
  reg.register("b", { name: "big", getContext: () => "z".repeat(200) }); // 50 tokens
  const out = await reg.enrich({}, { tokenBudget: 20 });
  assert.equal(out.blocks.length, 1);
  assert.equal(out.blocks[0].name, "plugin__a__small");
  assert.equal(out.skipped.length, 1);
  assert.match(out.skipped[0].reason, /needs ~50 tokens, 16 left/);
  const rendered = renderPluginContext(out);
  assert.ok(!rendered.includes("zzzzz"), "the oversized content must not leak into the render");
});

test("null token budget is unbounded", async () => {
  const reg = new PluginContextRegistry();
  reg.register("a", { name: "big", getContext: () => "z".repeat(4000) });
  const out = await reg.enrich({}, { tokenBudget: null });
  assert.equal(out.blocks.length, 1);
  assert.equal(out.skipped.length, 0);
  assert.equal(out.tokensUsed, 1000);
});

test("empty and whitespace-only returns contribute nothing silently", async () => {
  const reg = new PluginContextRegistry();
  reg.register("a", { name: "empty", getContext: () => "" });
  reg.register("b", { name: "ws", getContext: () => "   \n  " });
  const out = await reg.enrich({});
  assert.deepEqual(out.blocks, []);
  assert.deepEqual(out.skipped, []);
  assert.equal(out.tokensUsed, 0);
  assert.equal(renderPluginContext(out), "");
});

test("throwing and hanging providers are captured without blocking the packet", async () => {
  const reg = new PluginContextRegistry({ timeoutMs: 40 });
  reg.register("bad", { name: "thrower", getContext: () => { throw new Error("no context today"); } });
  reg.register("slow", { name: "hanger", getContext: () => new Promise(() => {}) });
  reg.register("good", { name: "fine", getContext: () => "real content" });
  const out = await reg.enrich({});
  assert.equal(out.errors.length, 2);
  assert.match(out.errors[0].message, /no context today/);
  assert.match(out.errors.find((e) => e.pluginId === "slow").message, /timed out/);
  assert.equal(out.blocks.length, 1);
  assert.equal(out.blocks[0].pluginId, "good");
});

test("renderPluginContext tags every block with plugin and provider", async () => {
  const reg = new PluginContextRegistry();
  reg.register("weather", { name: "now", getContext: () => "sunny" });
  reg.register("fails", { name: "boom", getContext: () => { throw new Error("x"); } });
  reg.register("huge", { name: "giant", getContext: () => "z".repeat(400) });
  const out = await reg.enrich({}, { tokenBudget: 10 });
  const rendered = renderPluginContext(out);
  assert.match(rendered, /^plugin context \(1 blocks\); 1 provider error\(s\); 1 skipped \(budget\):/);
  assert.match(rendered, /<plugin-context provider="plugin__weather__now" plugin="weather">/);
  assert.match(rendered, /sunny/);
});

test("removePlugin and lookup helpers", () => {
  const reg = new PluginContextRegistry();
  reg.register("a", goodDef);
  reg.register("b", { name: "other", getContext: () => "x" });
  assert.equal(reg.get("plugin__a__notes").pluginId, "a");
  assert.equal(reg.removePlugin("a"), 1);
  assert.equal(reg.get("plugin__a__notes"), undefined);
  assert.deepEqual(reg.providersForPlugin("ghost"), []);
  assert.equal(reg.removePlugin("a"), 0);
});
