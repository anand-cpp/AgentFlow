// Free-first model cost policy.
//
// The point of these tests is the line between evidence and guesswork. A local
// model and an OpenRouter `:free` id are free; a provider's no-card free tier is
// the weaker "free-tier"; everything else is unknown. Explicit user intent wins
// over every inference, and a disabled policy must not silently re-order.

import test from "node:test";
import assert from "node:assert/strict";

import { PROVIDERS } from "../src/core/gateway-server.js";
import {
  COST_CLASS,
  PROVIDER_COST,
  normaliseCostClass,
  classifyModelCost,
  orderByCost,
  costClassesFor,
  countCostClasses,
} from "../src/core/model-cost.js";

test("every registry provider has a deliberate cost class", () => {
  const registry = Object.keys(PROVIDERS).sort();
  const classified = Object.keys(PROVIDER_COST).sort();
  assert.deepEqual(classified, registry, "adding a provider must decide its cost class");
});

test("a local model is free on provider evidence", () => {
  const cost = classifyModelCost("ollama/llama3.1");
  assert.equal(cost.class, COST_CLASS.FREE);
  assert.equal(cost.source, "provider");
});

test("an OpenRouter :free id is free even though the provider is not", () => {
  const cost = classifyModelCost("openrouter/meta-llama/llama-3.3-70b-instruct:free");
  assert.equal(cost.class, COST_CLASS.FREE);
  assert.equal(cost.source, "model-id");
  assert.match(cost.reason, /:free/);
});

test("a no-card free-tier provider is free-tier, not free", () => {
  const cost = classifyModelCost("groq/llama-3.3-70b-versatile");
  assert.equal(cost.class, COST_CLASS.FREE_TIER);
  assert.equal(cost.source, "provider");
});

test("provider ambiguity is unknown, not optimistic", () => {
  assert.equal(classifyModelCost("openrouter/auto").class, COST_CLASS.UNKNOWN);
  assert.equal(classifyModelCost("together/llama").class, COST_CLASS.UNKNOWN);
  assert.equal(classifyModelCost("gpt-4").class, COST_CLASS.UNKNOWN);
});

test("a declared class overrides every inference", () => {
  const paid = classifyModelCost("ollama/llama3.1", { declared: { costClass: "paid" } });
  assert.equal(paid.class, COST_CLASS.PAID);
  assert.equal(paid.source, "declared");

  const free = classifyModelCost("openrouter/auto", { declared: { free: true } });
  assert.equal(free.class, COST_CLASS.FREE);
  assert.equal(free.source, "declared");

  const notFree = classifyModelCost("openrouter/x:free", { declared: { free: false } });
  assert.equal(notFree.class, COST_CLASS.PAID);
});

test("an unrecognised declared value falls through rather than poisoning the class", () => {
  const cost = classifyModelCost("groq/llama", { declared: { costClass: "cheap-ish" } });
  assert.equal(cost.class, COST_CLASS.FREE_TIER);
});

test("catalogue metadata can classify a model the id cannot", () => {
  const cost = classifyModelCost("acme/widget", { catalogueEntry: { id: "acme/widget", cost_class: "free" } });
  assert.equal(cost.class, COST_CLASS.FREE);
  assert.equal(cost.source, "catalogue");
});

test("cost labels are canonicalised", () => {
  assert.equal(normaliseCostClass("FREE"), COST_CLASS.FREE);
  assert.equal(normaliseCostClass("free_tier"), COST_CLASS.FREE_TIER);
  assert.equal(normaliseCostClass("metered"), COST_CLASS.PAID);
  assert.equal(normaliseCostClass(""), null);
  assert.equal(normaliseCostClass(null), null);
});

test("ordering is free -> free-tier -> unknown -> paid and stable within a class", () => {
  const ordered = orderByCost(
    ["groq/fast", "openrouter/b:free", "ollama/local", "openrouter/auto", "acme/paid"],
    { hints: { "acme/paid": { costClass: "paid" } } }
  );
  assert.deepEqual(ordered, [
    "openrouter/b:free",
    "ollama/local",
    "groq/fast",
    "openrouter/auto",
    "acme/paid",
  ]);
});

test("disabling the policy preserves the caller's order exactly", () => {
  const models = ["acme/paid", "openrouter/b:free", "groq/fast"];
  assert.deepEqual(orderByCost(models, { preferFree: false, hints: { "acme/paid": { costClass: "paid" } } }), models);
});

test("ordering accepts catalogue objects and uses their metadata", () => {
  const catalogue = [
    { id: "acme/paid", costClass: "paid" },
    { id: "acme/free", cost_class: "free" },
  ];
  assert.deepEqual(orderByCost(catalogue, { catalogue }), ["acme/free", "acme/paid"]);
});

test("cost classes and counts are receipt-ready", () => {
  const classes = costClassesFor(["ollama/local", "groq/fast", "openrouter/auto", "acme/paid"], {
    hints: { "acme/paid": { costClass: "paid" } },
  });
  assert.deepEqual(classes, {
    "ollama/local": "free",
    "groq/fast": "free-tier",
    "openrouter/auto": "unknown",
    "acme/paid": "paid",
  });
  assert.deepEqual(countCostClasses(classes), {
    free: 1,
    "free-tier": 1,
    unknown: 1,
    paid: 1,
  });
});
