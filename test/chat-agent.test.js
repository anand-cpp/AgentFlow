// Chat reaches the agent runtime, and a held continuation reaches the approver (t9).
//
// `aflow chat` builds its own AgentRuntime (src/core/chat.js) and could always run
// a bounded agent task, but nothing in the loop ever called it: the `/agent` slash
// command was missing, so the whole runtime -- tools, permissions, and cross-
// provider continuation -- was unreachable from a chat. These tests cover the two
// seams t9 is about:
//
//   * the session the chat is in is the session the agent run continues from, and
//   * a continuation held for approval is put to the approver the CLI binds, and
//     to nobody (fail closed) when none is bound.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ChatSession } from "../src/core/chat.js";
import { defineAgent, AgentRegistry } from "../src/core/agents/registry.js";
import { SessionStore } from "../src/core/sessions.js";
import { BlackboardStore } from "../src/core/blackboard.js";

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

const CATALOGUE = ["oca/model-a", "gemb/model-b"];

/**
 * A planner that will not retry on its own. `maxRetries: 0` keeps the Router on the
 * first candidate so the runner-up is left for the continuation, which is the seam
 * under test. Capability-free, so both catalogue models are eligible.
 */
function chatPlanner() {
  return defineAgent({
    id: "chatplanner",
    purpose: "plan work",
    instructions: "You are a planner.",
    failure: { maxRetries: 0 },
  });
}

/** A completion whose behaviour is chosen by model id, recording every call. */
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

/**
 * A ChatSession on real stores, on a temp dir, with a controllable provider.
 *
 * @param {{ complete?: any, approver?: ((call: any) => Promise<boolean>) | null }} [opts]
 */
async function chat({ complete, approver = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aflow-chat-agent-"));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sessions = new SessionStore({ dir: path.join(dir, "sessions"), now: () => 1000 });
  const blackboard = new BlackboardStore({ dir: path.join(dir, "bb"), projectRoot: dir, now: () => 1000 });
  blackboard.create({ goal: "chat with agents", objective: "reach the runtime" });

  const session = new ChatSession({
    sessions,
    blackboard,
    registry: new AgentRegistry([chatPlanner()]),
    agentId: "chatplanner",
    catalogue: CATALOGUE,
    complete,
    workspaceRoot: dir,
    projectRoot: dir,
    now: () => 1000,
  });
  await session.init({ forceNew: true });
  if (approver) session.setApprover(approver);
  return { session, sessions, blackboard, dir };
}

// ---------------------------------------------------------------------------
// the runtime is reachable, and it runs against THIS session
// ---------------------------------------------------------------------------

test("/agent runs a bounded agent task against the live session", async () => {
  const { session } = await chat({ complete: routedComplete(() => ({ text: "unused" })) });

  const seen = [];
  // Replace the runtime with a recorder: the point is the wiring from the slash
  // command to runtime.run, not the run itself (covered elsewhere).
  session.runtime = /** @type {any} */ ({
    run: async (args) => {
      seen.push(args);
      return { completed: true, output: { summary: "did the task" } };
    },
  });

  const result = await session.command({ name: "agent", arg: "do the thing" });

  assert.equal(result.kind, "agent");
  assert.equal(result.text, "did the task");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].agentId, "chatplanner");
  assert.equal(seen[0].task, "do the thing");
  assert.equal(seen[0].sessionId, session.session.id, "the run continues from the live session");
});

test("/agent with no task is usage, not a run", async () => {
  const { session } = await chat({ complete: routedComplete(() => ({ text: "unused" })) });
  let called = false;
  session.runtime = /** @type {any} */ ({ run: async () => ((called = true), { completed: true }) });

  const result = await session.command({ name: "agent", arg: "" });

  assert.equal(result.kind, "agent");
  assert.match(result.text, /usage: \/agent/);
  assert.equal(called, false);
});

// ---------------------------------------------------------------------------
// setApprover binds the permission waterfall, and null restores fail-closed
// ---------------------------------------------------------------------------

test("setApprover binds and clears the runtime's approver", async () => {
  const { session } = await chat({ complete: routedComplete(() => ({ text: "x" })) });
  const fn = async () => true;

  const before = session.runtime;
  session.setApprover(fn);
  assert.equal(session.runtime.approver, fn, "the approver the CLI binds is the one the runtime holds");
  assert.notEqual(session.runtime, before, "a fresh runtime carries the new approver");

  session.setApprover(null);
  assert.equal(session.runtime.approver, null, "clearing restores fail-closed");
});

// ---------------------------------------------------------------------------
// a held continuation is put to the approver, through the chat
// ---------------------------------------------------------------------------

test("a held continuation reaches the chat approver and proceeds when allowed", async () => {
  const complete = routedComplete((m) => (m.startsWith("oca/") ? { fail: rateLimited() } : { text: "continued" }));
  const seen = [];
  const { session } = await chat({
    complete,
    approver: async (call) => {
      seen.push(call);
      return true;
    },
  });
  // Force the uncertain-dispatch case: the tracer is the only place the loop knows
  // a mutation may have run, and here there is no real tool to leave one behind.
  session.runtime.traceUncertainTools = () => ({ count: 1, tools: [{ tool: "write", scope: "write" }] });

  const result = await session.command({ name: "agent", arg: "ship it" });

  assert.equal(result.kind, "agent");
  assert.equal(result.data.model, "gemb/model-b");
  assert.equal(result.data.continuation.action, "continued");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].continuation, true);
  assert.equal(seen[0].tool, "write");
  assert.equal(complete.state.byModel.get("gemb/model-b"), 1);
});

test("a held continuation with no chat approver fails closed", async () => {
  const complete = routedComplete((m) => (m.startsWith("oca/") ? { fail: rateLimited() } : { text: "b" }));
  const { session } = await chat({ complete }); // no approver bound
  session.runtime.traceUncertainTools = () => ({ count: 1, tools: [{ tool: "write", scope: "write" }] });

  const result = await session.command({ name: "agent", arg: "ship it" });

  assert.equal(result.data.continuation.action, "require_approval");
  assert.equal(complete.state.byModel.get("gemb/model-b") || 0, 0, "nothing is replayed without a human");
  assert.equal(result.data.completed, false);
});
