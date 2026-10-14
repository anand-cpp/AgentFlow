// Cross-provider continuity wiring in AgentRuntime (task t8).
//
// The continuity primitives (src/core/continuity.js) are unit- and integration-
// tested on their own. What this file covers is the seam between them and the
// agent loop: after the bounded provider cascade exhausts its retry budget, the
// runtime gives continuity one shot to hand the same work to a provider the cap
// never reached. The decisions that keep that honest are asserted here:
//
//   * a transient fault continues, on a candidate the Router's cap excluded,
//   * a fault a second provider cannot fix does not (no_credentials, unknown),
//   * uncertain non-idempotent dispatches force approval instead of a blind replay,
//   * the reconstructed packet and the provider transition are persisted, and
//   * the dispatch tracer returns 0 for a settled run and counts the unsettled.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { defineAgent, AgentRegistry } from "../src/core/agents/registry.js";
import { AgentRuntime, STATE } from "../src/core/agents/runtime.js";
import { SessionStore, ENTRY_KIND } from "../src/core/sessions.js";
import { BlackboardStore } from "../src/core/blackboard.js";
import { EVENTS } from "../src/core/events.js";

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

/** @param {any} [opts] */
function runtime({ specs, complete, catalogue = [], hints = {}, ...rest } = {}) {
  const registry = new AgentRegistry(specs || [agent()]);
  return new AgentRuntime({ registry, tools: {}, catalogue, hints, complete, ...rest });
}

/**
 * Real stores on disk plus a seeded session. Continuity reconstructs the work from
 * the Session and the Blackboard, so a session is not incidental here -- it is the
 * thing being continued.
 */
function stores(label = "runtime-continuity") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `aflow-${label}-`));
  const sessions = new SessionStore({ dir: path.join(dir, "sessions"), now: () => 1000 });
  const board = new BlackboardStore({ dir: path.join(dir, "bb"), projectRoot: dir, now: () => 1000 });
  board.create({ goal: "durable agent state", objective: "continue across providers" });
  const session = sessions.create({ objective: "Ship the continuity milestone", provider: "oca", model: "oca/model-a" });
  return { dir, sessions, board, session };
}

/**
 * A completion whose behaviour is chosen by model id, recording every call so a
 * test can prove a model was never tried.
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

const rateLimited = () => Object.assign(new Error("429 rate limited"), { status: 429, code: "rate_limited" });
const noCredentials = () => Object.assign(new Error("missing api key"), { code: "missing_api_key" });

/**
 * An agent that will not retry on its own. With `maxRetries: 0` the cascade cap is
 * one attempt, so the Router reaches only the first candidate and the runner-up is
 * left for the continuation to pick up -- which is exactly the seam under test.
 */
const noRetryAgent = (over = {}) => agent({ failure: { maxRetries: 0 }, ...over });

/** A runtime wired with the real stores, plus a catalogue of two providers. */
function wired({ complete, sessions, board, specs = [noRetryAgent()] }) {
  return runtime({
    specs,
    complete,
    catalogue: ["oca/model-a", "gemb/model-b"],
    blackboard: board,
    sessions,
    now: () => 1000,
  });
}

// ---------------------------------------------------------------------------
// a transient fault continues on a candidate the cap never reached
// ---------------------------------------------------------------------------

test("a transient cascade failure continues on the provider the retry cap excluded", async () => {
  const { sessions, board, session } = stores();
  const complete = routedComplete((m) => (m.startsWith("oca/") ? { fail: rateLimited() } : { text: "continued" }));
  const rt = wired({ complete, session, sessions, board });

  const result = await rt.run({ agentId: "planner", task: "t", sessionId: session.id });

  assert.equal(result.state, STATE.COMPLETED);
  assert.equal(result.completed, true);
  assert.equal(result.model, "gemb/model-b");
  assert.equal(result.output, "continued");

  // The Router only tried the first model; the continuation reached the second.
  assert.equal(complete.state.byModel.get("oca/model-a"), 1);
  assert.equal(complete.state.byModel.get("gemb/model-b"), 1);

  assert.equal(result.continuation.action, "continued");
  assert.equal(result.continuation.model, "gemb/model-b");
  assert.equal(result.continuation.failureClass, "rate_limited");
});

// ---------------------------------------------------------------------------
// a fault a second provider cannot fix does not continue
// ---------------------------------------------------------------------------

test("a no-credentials failure does not continue", async () => {
  const { sessions, board, session } = stores();
  const complete = routedComplete((m) => (m.startsWith("oca/") ? { fail: noCredentials() } : { text: "b" }));
  const rt = wired({ complete, session, sessions, board });

  const result = await rt.run({ agentId: "planner", task: "t", sessionId: session.id });

  assert.equal(result.state, STATE.FAILED);
  assert.equal(result.completed, false);
  assert.equal(result.error.code, "no_route");
  // Refused at the transient gate, before continuity was ever consulted.
  assert.equal(result.continuation, null);
  assert.equal(complete.state.byModel.get("gemb/model-b") || 0, 0, "the runner-up must not be tried");
});

test("an unclassifiable failure does not continue", async () => {
  const { sessions, board, session } = stores();
  const complete = routedComplete((m) =>
    m.startsWith("oca/") ? { fail: new Error("the provider said something we do not recognise") } : { text: "b" }
  );
  const rt = wired({ complete, session, sessions, board });

  const result = await rt.run({ agentId: "planner", task: "t", sessionId: session.id });

  assert.equal(result.state, STATE.FAILED);
  assert.equal(result.continuation, null);
  assert.equal(complete.state.byModel.get("gemb/model-b") || 0, 0);
});

// ---------------------------------------------------------------------------
// uncertain non-idempotent dispatches force approval, never a blind replay
// ---------------------------------------------------------------------------

test("an uncertain non-idempotent dispatch blocks the continuation", async () => {
  const { sessions, board, session } = stores();
  const complete = routedComplete((m) => (m.startsWith("oca/") ? { fail: rateLimited() } : { text: "b" }));
  const rt = wired({ complete, session, sessions, board });

  // The real tracer returns 0 for a settled run (asserted separately); here we
  // force the uncertain case to prove the runtime honours it rather than replaying.
  rt.traceUncertainDispatches = () => 1;

  const result = await rt.run({ agentId: "planner", task: "t", sessionId: session.id });

  assert.equal(result.state, STATE.FAILED);
  assert.equal(result.continuation.action, "require_approval");
  assert.equal(result.continuation.reason, "uncertain_tool_outcomes");
  assert.equal(complete.state.byModel.get("gemb/model-b") || 0, 0, "no replay without approval");
});

// ---------------------------------------------------------------------------
// a run without a session cannot reconstruct anything, and says so
// ---------------------------------------------------------------------------

test("a transient failure with no session refuses to continue, and records why", async () => {
  const complete = routedComplete((m) => (m.startsWith("oca/") ? { fail: rateLimited() } : { text: "b" }));
  const rt = runtime({ specs: [noRetryAgent()], complete, catalogue: ["oca/model-a", "gemb/model-b"], now: () => 1000 });

  const result = await rt.run({ agentId: "planner", task: "t" });

  assert.equal(result.state, STATE.FAILED);
  assert.equal(result.continuation.action, "stop");
  assert.equal(result.continuation.reason, "no_session_store");
  assert.equal(complete.state.byModel.get("gemb/model-b") || 0, 0);
});

// ---------------------------------------------------------------------------
// the dispatch tracer is honest
// ---------------------------------------------------------------------------

test("the dispatch tracer counts unsettled non-idempotent dispatches", () => {
  const rt = runtime({ complete: routedComplete(() => ({ text: "x" })) });

  // A write dispatched with no matching execution record: one uncertain call.
  const pending = {
    events: [{ type: EVENTS.AGENT_TOOL_STARTED, scope: "write" }],
    toolExecutions: [],
  };
  assert.equal(rt.traceUncertainDispatches(pending), 1);

  // The same dispatch, now recorded as settled: nothing is uncertain.
  const settled = {
    events: [{ type: EVENTS.AGENT_TOOL_STARTED, scope: "write" }],
    toolExecutions: [{ scope: "write", status: "ok" }],
  };
  assert.equal(rt.traceUncertainDispatches(settled), 0);

  // Reads and searches are idempotent, so an unsettled one is not counted.
  const read = {
    events: [{ type: EVENTS.AGENT_TOOL_STARTED, scope: "read" }],
    toolExecutions: [],
  };
  assert.equal(rt.traceUncertainDispatches(read), 0);

  // An empty/absent result is zero, not a crash.
  assert.equal(rt.traceUncertainDispatches({}), 0);
  assert.equal(rt.traceUncertainDispatches(null), 0);
});

// ---------------------------------------------------------------------------
// the continuation persists the reconstructed packet and the transition
// ---------------------------------------------------------------------------

test("the continuation records the packet and the provider transition in the session", async () => {
  const { sessions, board, session } = stores();
  const complete = routedComplete((m) => (m.startsWith("oca/") ? { fail: rateLimited() } : { text: "done" }));
  const rt = wired({ complete, session, sessions, board });

  const result = await rt.run({ agentId: "planner", task: "t", sessionId: session.id });

  assert.equal(result.state, STATE.COMPLETED);
  assert.equal(result.model, "gemb/model-b");

  const after = sessions.read(session.id);
  // The header now reflects the provider that answered.
  assert.equal(after.provider, "gemb");
  assert.equal(after.model, "gemb/model-b");

  const kinds = after.entries.map((e) => e.kind);
  assert.ok(kinds.includes(ENTRY_KIND.CONTEXT), "the reconstructed packet is persisted");
  assert.ok(kinds.includes(ENTRY_KIND.PROVIDER_TRANSITION), "the provider transition is persisted");

  const transition = after.entries.find((e) => e.kind === ENTRY_KIND.PROVIDER_TRANSITION);
  assert.equal(transition.from.provider, "oca");
  assert.equal(transition.to.provider, "gemb");
  assert.equal(transition.failureClass, "rate_limited");
});
