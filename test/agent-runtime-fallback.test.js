// Cross-provider fallback wiring in AgentRuntime.
//
// The Router already owns the cascade and consumes an optional provider-level
// breaker. These tests cover the gap that existed ABOVE it: the runtime never
// built or injected a ProviderHealth, so the breaker was dead in every real run
// -- a provider that had just failed three times was retried immediately on the
// next request instead of cooling down. The router's own cascade is covered in
// routing.test.js and provider-health-routing.test.js; here we assert only that
// the runtime constructs the breaker, hands it to the Router, reuses the one
// breaker (no second one), and that real run outcomes reach it.

import test from "node:test";
import assert from "node:assert/strict";

import { defineAgent, AgentRegistry } from "../src/core/agents/registry.js";
import { AgentRuntime, STATE } from "../src/core/agents/runtime.js";
import {
  ProviderHealth,
  PROVIDER_STATUS,
  CIRCUIT_STATE,
  FAILURE_CLASS,
} from "../src/core/provider-health.js";

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

function agent(over = {}) {
  return defineAgent({
    id: "planner",
    purpose: "plan work",
    instructions: "You are a planner.",
    ...over,
  });
}

function runtime({ specs, complete, catalogue = [], hints = {}, ...rest } = {}) {
  const registry = new AgentRegistry(specs || [agent()]);
  return new AgentRuntime({ registry, tools: {}, catalogue, hints, complete, ...rest });
}

/**
 * A completion whose behaviour is chosen by model id.
 *
 * `handlers(modelId)` returns `{ text }` for a success or `{ fail: Error }` to
 * throw. Calls are recorded per-model so a test can prove a model was NOT tried.
 */
function routedComplete(handlers) {
  const state = { calls: [], byModel: new Map() };
  const fn = async (_config, modelId) => {
    state.calls.push(modelId);
    state.byModel.set(modelId, (state.byModel.get(modelId) || 0) + 1);
    const h = handlers(modelId) || {};
    if (h.fail) throw h.fail;
    return { model: modelId, text: h.text ?? `ok:${modelId}` };
  };
  fn.state = state;
  return fn;
}

const rateLimited = () => Object.assign(new Error("rate limited"), { code: "rate_limited" });
const noCredentials = () => Object.assign(new Error("missing api key"), { code: "missing_api_key" });

// ---------------------------------------------------------------------------
// construction
// ---------------------------------------------------------------------------

test("the runtime builds a ProviderHealth when none is injected, with its own clock", () => {
  const rt = runtime({ complete: routedComplete(() => ({ text: "x" })) });
  assert.ok(rt.providerHealth instanceof ProviderHealth, "a breaker is constructed by default");
});

test("an injected ProviderHealth is used as-is (never replaced by a second breaker)", () => {
  const ph = new ProviderHealth({ now: () => 1000 });
  const rt = runtime({ complete: routedComplete(() => ({ text: "x" })), providerHealth: ph });
  assert.equal(rt.providerHealth, ph);
});

// ---------------------------------------------------------------------------
// outcomes reach the breaker
// ---------------------------------------------------------------------------

test("a rate-limited provider falls back to another, and both outcomes reach the breaker", async () => {
  const ph = new ProviderHealth({ now: () => 1000 });
  const complete = routedComplete((m) =>
    m.startsWith("oca/") ? { fail: rateLimited() } : { text: "answer" }
  );
  const rt = runtime({
    complete,
    catalogue: ["oca/model-a", "gemb/model-b"],
    providerHealth: ph,
    now: () => 1000,
  });

  const result = await rt.run({ agentId: "planner", task: "t" });

  assert.equal(result.state, STATE.COMPLETED);
  assert.equal(result.model, "gemb/model-b");
  // The failure was recorded against the provider that failed ...
  const failed = ph.getProviderStatus("oca");
  assert.equal(failed.lastFailureType, FAILURE_CLASS.RATE_LIMITED);
  assert.equal(failed.status, PROVIDER_STATUS.DEGRADED);
  // ... and the success against the one that answered.
  assert.equal(ph.getProviderStatus("gemb").status, PROVIDER_STATUS.HEALTHY);
});

test("a success on the first provider marks it healthy in the breaker", async () => {
  const ph = new ProviderHealth({ now: () => 1000 });
  const complete = routedComplete(() => ({ text: "answer" }));
  const rt = runtime({ complete, catalogue: ["oca/model-a"], providerHealth: ph, now: () => 1000 });

  const result = await rt.run({ agentId: "planner", task: "t" });

  assert.equal(result.state, STATE.COMPLETED);
  assert.equal(ph.getProviderStatus("oca").status, PROVIDER_STATUS.HEALTHY);
  assert.equal(ph.getProviderStatus("oca").lastOutcome, FAILURE_CLASS.SUCCESS);
});

// ---------------------------------------------------------------------------
// cooldown: the bug this task fixes
// ---------------------------------------------------------------------------

test("an open provider circuit is skipped on the next run instead of being retried", async () => {
  let now = 1000;
  const ph = new ProviderHealth({ openAfterFailures: 1, baseBackoffMs: 60_000, now: () => now });
  const complete = routedComplete((m) =>
    m.startsWith("oca/") ? { fail: rateLimited() } : { text: "b" }
  );
  const rt = runtime({
    complete,
    catalogue: ["oca/m1", "gemb/m2"],
    providerHealth: ph,
    now: () => now,
  });

  const r1 = await rt.run({ agentId: "planner", task: "t" });
  assert.equal(r1.state, STATE.COMPLETED);
  assert.equal(r1.model, "gemb/m2");
  assert.equal(ph.getProviderStatus("oca").circuitState, CIRCUIT_STATE.OPEN);

  const ocaCallsAfterRun1 = complete.state.byModel.get("oca/m1") || 0;
  assert.equal(ocaCallsAfterRun1, 1);

  // Same runtime, same clock: the breaker is still open, so oca is never tried.
  const r2 = await rt.run({ agentId: "planner", task: "t" });
  assert.equal(r2.state, STATE.COMPLETED);
  assert.equal(r2.model, "gemb/m2");
  assert.equal(
    complete.state.byModel.get("oca/m1") || 0,
    ocaCallsAfterRun1,
    "a cooling-down provider must not be re-attempted"
  );
});

test("the circuit closes again once the cooldown elapses", async () => {
  let now = 1000;
  const ph = new ProviderHealth({ openAfterFailures: 1, baseBackoffMs: 60_000, now: () => now });
  let ocaFails = true;
  const complete = routedComplete((m) => (m.startsWith("oca/") ? (ocaFails ? { fail: rateLimited() } : { text: "a" }) : { text: "b" }));
  const rt = runtime({
    complete,
    catalogue: ["oca/m1", "gemb/m2"],
    providerHealth: ph,
    now: () => now,
  });

  assert.equal((await rt.run({ agentId: "planner", task: "t" })).state, STATE.COMPLETED);
  assert.equal(ph.getProviderStatus("oca").circuitState, CIRCUIT_STATE.OPEN);

  // Advance past the backoff AND fix the provider: it should be probed again.
  now += 60_001;
  ocaFails = false;
  const r2 = await rt.run({ agentId: "planner", task: "t" });

  assert.equal(r2.state, STATE.COMPLETED);
  assert.equal(r2.model, "oca/m1");
  assert.equal(ph.getProviderStatus("oca").status, PROVIDER_STATUS.HEALTHY);
});

// ---------------------------------------------------------------------------
// no-credentials skips the provider; exhaustion fails closed
// ---------------------------------------------------------------------------

test("a no-credentials failure skips the whole provider but still tries the next", async () => {
  const ph = new ProviderHealth({ now: () => 1000 });
  const complete = routedComplete((m) =>
    m.startsWith("oca/") ? { fail: noCredentials() } : { text: "b" }
  );
  const rt = runtime({
    complete,
    catalogue: ["oca/m1", "oca/m2", "gemb/m3"],
    providerHealth: ph,
    now: () => 1000,
  });

  const result = await rt.run({ agentId: "planner", task: "t" });

  assert.equal(result.state, STATE.COMPLETED);
  assert.equal(result.model, "gemb/m3");
  // The second oca model is skipped: repeating a known "no credentials" answer
  // for the same provider cannot succeed.
  assert.equal(complete.state.byModel.get("oca/m1"), 1);
  assert.equal(complete.state.byModel.get("oca/m2") || 0, 0);
  assert.equal(ph.getProviderStatus("oca").status, PROVIDER_STATUS.UNAUTHENTICATED);
});

test("an exhausted cascade fails closed with no_route and a bounded attempt count", async () => {
  const ph = new ProviderHealth({ openAfterFailures: 100, now: () => 1000 });
  const complete = routedComplete(() => ({ fail: rateLimited() }));
  const rt = runtime({
    complete,
    catalogue: ["oca/m1", "gemb/m2", "ocl/m3"],
    providerHealth: ph,
    now: () => 1000,
  });

  const result = await rt.run({ agentId: "planner", task: "t" });

  assert.equal(result.state, STATE.FAILED);
  assert.equal(result.completed, false);
  assert.equal(result.error.code, "no_route");
  // maxRetries defaults to 2 => at most 3 attempts. No infinite loop.
  assert.ok(complete.state.calls.length <= 3, `expected <= 3 attempts, got ${complete.state.calls.length}`);
});

test("fallback does not throw when a provider keeps failing -- it returns a failure result", async () => {
  const complete = routedComplete(() => ({ fail: rateLimited() }));
  const rt = runtime({ complete, catalogue: ["oca/m1", "gemb/m2"], now: () => 1000 });

  const result = await rt.run({ agentId: "planner", task: "t" });

  assert.equal(result.state, STATE.FAILED);
  assert.equal(result.error.code, "no_route");
  assert.equal(result.cancelled, false);
  assert.equal(result.timedOut, false);
});
