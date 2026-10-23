// Model requirement resolution.
//
// Requirements are resolved into router tiers. This module never calls a provider
// and never picks a winner -- that is the router's job, with its health memory and
// failure taxonomy. Two selectors would mean two answers to "why this model".

import test from "node:test";
import assert from "node:assert/strict";

import { defineAgent, CAPABILITY } from "../src/core/agents/registry.js";
import {
  resolveModelPlan,
  checkRequirements,
  inferHints,
  resolveHints,
  explainPlan,
  RequirementError,
} from "../src/core/agents/requirements.js";

function agent(over = {}) {
  return defineAgent({
    id: "coder",
    purpose: "implement changes",
    instructions: "Do the work.",
    capabilities: [CAPABILITY.CODING],
    ...over,
  });
}

const CATALOGUE = ["oc/muse", "oc/deepseek-r1", "bzl/auto:free", "gem/gemini-2.5-pro"];

// ---------------------------------------------------------------------------
// hints
// ---------------------------------------------------------------------------

test("a model with no declaration is inferred from its id", () => {
  const hints = inferHints("oc/deepseek-r1");
  assert.ok(hints.capabilities.includes(CAPABILITY.REASONING));
  assert.equal(hints.provider, "oc");
  assert.equal(hints.source, "inferred");
});

test("inference is conservative: an unrecognisable id declares nothing", () => {
  // Guessing capabilities from substrings is how an agent silently runs with a
  // tool it cannot call, so an unknown name must yield nothing.
  assert.deepEqual(inferHints("acme/widget-7").capabilities, []);
});

test("inference handles a bare id with no provider prefix", () => {
  assert.equal(inferHints("gpt-4").provider, null);
  assert.deepEqual(inferHints("").capabilities, []);
});

test("declared hints win over inferred ones and are additive", () => {
  const merged = resolveHints("oc/muse", { capabilities: [CAPABILITY.LONG_CONTEXT] });
  assert.ok(merged.capabilities.includes(CAPABILITY.LONG_CONTEXT));
  assert.equal(merged.source, "declared");
});

test("declared numeric hints are carried through", () => {
  const merged = /** @type {any} */ (resolveHints("oc/muse", { contextWindow: 128000, toolCalling: true }));
  assert.equal(merged.contextWindow, 128000);
  assert.equal(merged.toolCalling, true);
});

// ---------------------------------------------------------------------------
// requirement checking
// ---------------------------------------------------------------------------

test("a model satisfies a requirement it declares", () => {
  const v = checkRequirements("oc/muse", [CAPABILITY.LONG_CONTEXT], { capabilities: [CAPABILITY.LONG_CONTEXT] });
  assert.equal(v.ok, true);
  assert.deepEqual(v.missing, []);
  assert.equal(v.hintSource, "declared");
});

test("a failed check names what was missing", () => {
  const v = checkRequirements("oc/muse", [CAPABILITY.CODING, CAPABILITY.LONG_CONTEXT], {
    capabilities: [CAPABILITY.CODING],
  });
  assert.equal(v.ok, false);
  assert.deepEqual(v.missing, [CAPABILITY.LONG_CONTEXT]);
});

test("no requirements means every model qualifies", () => {
  assert.equal(checkRequirements("anything/at-all", []).ok, true);
});

// ---------------------------------------------------------------------------
// plan resolution
// ---------------------------------------------------------------------------

test("an agent with no requirements can use the whole catalogue", () => {
  const plan = resolveModelPlan(agent(), { catalogue: CATALOGUE });
  assert.equal(plan.candidates.length, 4);
  assert.equal(plan.unfiltered, false);
  assert.ok(plan.tiers.length > 0);
});

test("requirements filter the catalogue and the receipt says why", () => {
  const plan = resolveModelPlan(
    agent({ model: { requireCapabilities: [CAPABILITY.LONG_CONTEXT] } }),
    { catalogue: CATALOGUE, hints: { "gem/gemini-2.5-pro": { capabilities: [CAPABILITY.LONG_CONTEXT] } } }
  );
  assert.deepEqual(plan.candidates, ["gem/gemini-2.5-pro"]);
  const rejected = plan.considered.filter((v) => !v.ok);
  assert.equal(rejected.length, 3);
  assert.deepEqual(rejected[0].missing, [CAPABILITY.LONG_CONTEXT]);
});

test("unsatisfiable requirements raise an actionable error rather than an empty plan", () => {
  assert.throws(
    () => resolveModelPlan(agent({ model: { requireCapabilities: [CAPABILITY.LONG_CONTEXT] } }), { catalogue: CATALOGUE }),
    (err) => {
      assert.ok(err instanceof RequirementError);
      assert.equal(err.code, "no_capable_model");
      assert.match(err.message, /long_context/);
      assert.match(err.message, /declare hints/);
      return true;
    }
  );
});

test("an empty catalogue is refused before any capability reasoning", () => {
  assert.throws(
    () => resolveModelPlan(agent(), { catalogue: [] }),
    (err) => {
      assert.equal(/** @type {any} */ (err).code, "empty_catalogue");
      return true;
    }
  );
});

test("a pinned model bypasses filtering entirely and says so", () => {
  const plan = resolveModelPlan(agent({ model: "acme/whatever" }), { catalogue: CATALOGUE });
  assert.equal(plan.pinned, true);
  assert.equal(plan.model, "acme/whatever");
  assert.equal(plan.unfiltered, true);
  assert.deepEqual(plan.tiers, [{ name: "pinned", models: ["acme/whatever"] }]);
});

test("a pinned model is used even when the catalogue does not advertise it", () => {
  // The pin is explicit intent. Silently substituting something else would be a
  // different model than the one the agent asked for.
  const plan = resolveModelPlan(agent({ model: "acme/not-advertised" }), { catalogue: CATALOGUE });
  assert.deepEqual(plan.candidates, ["acme/not-advertised"]);
});

// ---------------------------------------------------------------------------
// preference ordering
// ---------------------------------------------------------------------------

test("preferences come first, each in its own tier", () => {
  const plan = resolveModelPlan(agent({ model: { prefer: ["bzl/auto:free", "oc/muse"] } }), { catalogue: CATALOGUE });
  assert.deepEqual(plan.tiers[0], { name: "pref1", models: ["bzl/auto:free"] });
  assert.deepEqual(plan.tiers[1], { name: "pref2", models: ["oc/muse"] });
  assert.equal(plan.candidates[0], "bzl/auto:free");
});

test("a preferred model that cannot meet the requirements is dropped, not promoted", () => {
  const plan = resolveModelPlan(
    agent({
      model: {
        prefer: ["bzl/auto:free"],
        requireCapabilities: [CAPABILITY.LONG_CONTEXT],
      },
    }),
    { catalogue: CATALOGUE, hints: { "gem/gemini-2.5-pro": { capabilities: [CAPABILITY.LONG_CONTEXT] } } }
  );
  assert.deepEqual(plan.droppedPreferences, ["bzl/auto:free"]);
  assert.deepEqual(plan.candidates, ["gem/gemini-2.5-pro"]);
});

test("a preference that is not advertised at all is reported as dropped", () => {
  const plan = resolveModelPlan(agent({ model: { prefer: ["nope/gone"] } }), { catalogue: CATALOGUE });
  assert.deepEqual(plan.droppedPreferences, ["nope/gone"]);
});

test("tier size comes from routing policy", () => {
  const plan = resolveModelPlan(agent({ routing: { tierSize: 1 } }), { catalogue: CATALOGUE });
  for (const tier of plan.tiers) assert.equal(tier.models.length, 1);
});

// ---------------------------------------------------------------------------
// free-first ordering
// ---------------------------------------------------------------------------

test("the anonymous remainder is ordered free -> free-tier -> unknown -> paid", () => {
  const plan = resolveModelPlan(agent(), {
    catalogue: ["acme/paid", "openrouter/free:free", "groq/fast", "acme/unknown"],
    hints: { "acme/paid": { costClass: "paid" } },
  });

  assert.deepEqual(plan.candidates, ["openrouter/free:free", "groq/fast", "acme/unknown", "acme/paid"]);
  assert.equal(plan.cost.preference, "free-first");
  assert.deepEqual(plan.cost.classes, {
    "openrouter/free:free": "free",
    "groq/fast": "free-tier",
    "acme/unknown": "unknown",
    "acme/paid": "paid",
  });
});

test("an explicit preference outranks a cheaper anonymous model", () => {
  const plan = resolveModelPlan(agent({ model: { prefer: ["acme/paid"] } }), {
    catalogue: ["openrouter/free:free", "acme/paid"],
    hints: { "acme/paid": { costClass: "paid" } },
  });

  assert.equal(plan.candidates[0], "acme/paid");
  assert.deepEqual(plan.tiers[0], { name: "pref1", models: ["acme/paid"] });
});

test("free-first can be disabled without changing the catalogue order", () => {
  const catalogue = ["acme/paid", "openrouter/free:free", "groq/fast"];
  const plan = resolveModelPlan(agent(), {
    catalogue,
    hints: { "acme/paid": { costClass: "paid" } },
    preferFree: false,
  });

  assert.deepEqual(plan.candidates, catalogue);
  assert.equal(plan.cost.preference, "catalogue");
});

test("a pinned model is never re-ordered and still reports its cost", () => {
  const plan = resolveModelPlan(agent({ model: "ollama/local" }), { catalogue: [] });
  assert.deepEqual(plan.candidates, ["ollama/local"]);
  assert.equal(plan.cost.preference, "pinned");
  assert.equal(plan.cost.classes["ollama/local"], "free");
});

test("the explanation names the free-first policy and its evidence", () => {
  const plan = resolveModelPlan(agent(), {
    catalogue: ["openrouter/free:free", "groq/fast"],
  });
  assert.match(explainPlan(plan), /free-first \(1 free, 1 free-tier\)/);
});

test("a cost-only hint does not make an inferred capability look declared", () => {
  const plan = resolveModelPlan(agent({ model: { requireCapabilities: [CAPABILITY.REASONING] } }), {
    catalogue: ["oc/deepseek-r1"],
    hints: { "oc/deepseek-r1": { costClass: "paid" } },
  });
  assert.deepEqual(plan.unhinted, ["oc/deepseek-r1"]);
});

// ---------------------------------------------------------------------------
// honest reporting
// ---------------------------------------------------------------------------

test("a model matched only by inference is reported as such", () => {
  // The operator should be able to see that a choice rested on a guess.
  const plan = resolveModelPlan(
    agent({ model: { requireCapabilities: [CAPABILITY.REASONING] } }),
    { catalogue: ["oc/deepseek-r1"] }
  );
  assert.deepEqual(plan.unhinted, ["oc/deepseek-r1"]);
});

test("includeUnhinted=false excludes models with no declared hints", () => {
  const plan = resolveModelPlan(
    agent(),
    { catalogue: ["oc/deepseek-r1", "oc/muse"], hints: { "oc/muse": { capabilities: [CAPABILITY.CODING] } }, includeUnhinted: false }
  );
  assert.deepEqual(plan.candidates, ["oc/muse"]);
});

test("excluding every model is refused rather than returning nothing", () => {
  assert.throws(
    () => resolveModelPlan(agent(), { catalogue: ["oc/deepseek-r1"], includeUnhinted: false }),
    (err) => {
      assert.equal(/** @type {any} */ (err).code, "no_tiers");
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// explanation
// ---------------------------------------------------------------------------

test("a pinned plan explains itself", () => {
  assert.match(explainPlan(resolveModelPlan(agent({ model: "oc/muse" }), { catalogue: CATALOGUE })), /pinned to oc\/muse/);
});

test("the explanation names requirements, rejections and inference", () => {
  const plan = resolveModelPlan(
    agent({ model: { requireCapabilities: [CAPABILITY.LONG_CONTEXT] } }),
    { catalogue: CATALOGUE, hints: { "gem/gemini-2.5-pro": { capabilities: [CAPABILITY.LONG_CONTEXT] } } }
  );
  const text = explainPlan(plan);
  assert.match(text, /requires long_context/);
  assert.match(text, /1 candidate/);
  assert.match(text, /3 rejected/);
  assert.match(text, /missing long_context/);
});

test("the explanation reports inference and dropped preferences", () => {
  const plan = resolveModelPlan(
    agent({ model: { prefer: ["nope/gone"], requireCapabilities: [CAPABILITY.REASONING] } }),
    { catalogue: ["oc/deepseek-r1"] }
  );
  const text = explainPlan(plan);
  assert.match(text, /matched on inference/);
  assert.match(text, /ignored preferences not meeting requirements: nope\/gone/);
});

test("an absent plan does not throw in the explainer", () => {
  assert.equal(explainPlan(null), "no plan");
  assert.match(explainPlan(undefined), /no plan/);
});