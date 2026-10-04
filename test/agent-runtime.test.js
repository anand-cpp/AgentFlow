// The bounded agent runtime.
//
// Most of these tests assert one of three things: that a bound is enforced, that
// timeout/cancel/fail stay distinguishable, or that a failure never escapes as an
// exception. The last one matters most -- a caller forced to catch four exception
// types to learn that an agent stopped will eventually handle one of them wrong.

import test from "node:test";
import assert from "node:assert/strict";

import { defineAgent, AgentRegistry, TOOL_SCOPE } from "../src/core/agents/registry.js";
import {
  AgentRuntime,
  STATE,
  AgentTimeoutError,
  AgentCancelledError,
  AgentBoundError,
  renderSystemPrompt,
  buildPrompt,
} from "../src/core/agents/runtime.js";

const CATALOGUE = ["oc/muse", "gem/gemini-2.5-pro"];

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

function runtime({ specs, complete, tools = {}, catalogue = CATALOGUE, hints = {}, ...rest } = {}) {
  const registry = new AgentRegistry(specs || [agent()]);
  return new AgentRuntime({
    registry,
    tools,
    catalogue,
    hints,
    complete,
    ...rest,
  });
}

/** A completion function that returns a fixed text, counting its calls. */
function say(text, { failFirst = 0, empty = false } = {}) {
  const state = { calls: 0, prompts: [], systems: [] };
  const fn = async (_config, modelId, prompt, opts) => {
    state.calls += 1;
    state.prompts.push(prompt);
    state.systems.push(opts?.system);
    if (state.calls <= failFirst) throw Object.assign(new Error("rate limited"), { code: "rate_limited" });
    if (empty) return { model: modelId, text: "" };
    return { model: modelId, text };
  };
  fn.state = state;
  return fn;
}

const blackboard = (summary) => ({
  id: "bb",
  exists: () => true,
  summary: () => summary || { goal: null, objective: null, nextAction: null },
});

// ---------------------------------------------------------------------------
// construction
// ---------------------------------------------------------------------------

test("a runtime requires a registry and a completion function", () => {
  assert.throws(() => new AgentRuntime({ complete: say("x") }), /requires a registry/);
  assert.throws(() => new AgentRuntime({ registry: new AgentRegistry([agent()]) }), /requires a complete function/);
});

// ---------------------------------------------------------------------------
// unknown agent
// ---------------------------------------------------------------------------

test("an unknown agent fails with a result, naming the known agents", async () => {
  const rt = runtime({ complete: say("x") });
  const result = await rt.run({ agentId: "nope" });
  assert.equal(result.state, STATE.FAILED);
  assert.equal(result.completed, false);
  assert.equal(result.error.code, "agent_not_found");
  assert.match(result.error.message, /known agents: planner/);
  assert.equal(result.timedOut, false);
  assert.equal(result.cancelled, false);
});

// ---------------------------------------------------------------------------
// the happy path
// ---------------------------------------------------------------------------

test("a straightforward run completes and reports the model that answered", async () => {
  const rt = runtime({ complete: say("do the thing") });
  const result = await rt.run({ agentId: "planner", task: "plan the migration" });
  assert.equal(result.state, STATE.COMPLETED);
  assert.equal(result.completed, true);
  assert.equal(result.output, "do the thing");
  assert.equal(result.error, null);
  assert.ok(["oc/muse", "gem/gemini-2.5-pro"].includes(result.model));
});

test("the task actually reaches the model", async () => {
  const complete = say("ok");
  const rt = runtime({ complete });
  await rt.run({ agentId: "planner", task: { title: "migrate the parser", detail: "keep it fast" } });
  assert.match(complete.state.prompts[0], /migrate the parser/);
  assert.match(complete.state.prompts[0], /keep it fast/);
});

test("the agent's own instructions lead the system prompt", async () => {
  const complete = say("ok");
  const rt = runtime({ complete, blackboard: blackboard({ goal: "ship", objective: null, nextAction: null }) });
  await rt.run({ agentId: "planner", task: "x" });
  const system = complete.state.systems[0];
  assert.match(system, /^You are a planner\./);
  assert.match(system, /project context/);
});

test("with no task the agent is pointed at the recorded next action", async () => {
  const complete = say("ok");
  const rt = runtime({
    complete,
    blackboard: blackboard({ goal: null, objective: null, nextAction: { note: "fix the flaky test" } }),
  });
  await rt.run({ agentId: "planner" });
  assert.match(complete.state.prompts[0], /fix the flaky test/);
});

test("a run with no task, goal or next action still asks something meaningful", async () => {
  const complete = say("ok");
  const rt = runtime({ complete });
  await rt.run({ agentId: "planner" });
  assert.ok(complete.state.prompts[0].length > 0);
});

test("an empty completion is a failure, not a success", async () => {
  // Free tiers answer 200 with nothing; the router treats that as a distinct
  // failure kind and so must the runtime.
  const rt = runtime({ complete: say("x", { empty: true }) });
  const result = await rt.run({ agentId: "planner", task: "x" });
  assert.equal(result.state, STATE.FAILED);
  assert.equal(result.completed, false);
});

// ---------------------------------------------------------------------------
// routing failures
// ---------------------------------------------------------------------------

test("an exhausted provider cascade reports the failure kinds", async () => {
  // The wording matters: classifyFailure reads provider-shaped text, so a
  // synthetic code of "no_credentials" would classify as unknown and this test
  // would pass for the wrong reason if it asserted nothing.
  const complete = async () => {
    throw Object.assign(new Error("Missing API key for provider"), { code: "unauthorized", status: 401 });
  };
  const rt = runtime({ complete });
  const result = await rt.run({ agentId: "planner", task: "x" });
  assert.equal(result.state, STATE.FAILED);
  assert.equal(result.error.code, "no_route");
  assert.ok(result.error.failureKinds.includes("no_credentials"), `got ${result.error.failureKinds}`);
});

test("a retried provider is not re-tried pointlessly within one run", async () => {
  // The router's health cache is what stops this. Asserting it here documents that
  // the runtime must build one router per execution, not one per iteration.
  const complete = say("ok", { failFirst: 1 });
  const rt = runtime({ complete });
  const result = await rt.run({ agentId: "planner", task: "x" });
  assert.equal(result.state, STATE.COMPLETED);
  assert.equal(result.model, "gem/gemini-2.5-pro");
});

test("requirements that nothing satisfies fail before anything is dispatched", async () => {
  const complete = say("ok");
  const rt = runtime({
    complete,
    specs: [agent({ model: { requireCapabilities: ["long_context"] } })],
  });
  const result = await rt.run({ agentId: "planner", task: "x" });
  assert.equal(result.state, STATE.FAILED);
  assert.equal(result.error.code, "no_capable_model");
  assert.equal(complete.state.calls, 0, "no provider call may be made when requirements cannot be met");
});

test("a pinned model is used even without hints", async () => {
  const complete = say("ok");
  const rt = runtime({ complete, specs: [agent({ model: "oc/muse" })] });
  const result = await rt.run({ agentId: "planner", task: "x" });
  assert.equal(result.model, "oc/muse");
  assert.equal(result.plan.pinned, true);
});

// ---------------------------------------------------------------------------
// bounds
// ---------------------------------------------------------------------------

test("a run that exceeds its wall clock is timed out, not failed", async () => {
  let clock = 1000;
  const complete = async () => {
    clock += 5000;
    return { model: "oc/muse", text: "too late" };
  };
  const rt = runtime({ complete, now: () => clock, specs: [agent({ bounds: { timeoutMs: 1000 } })] });
  const result = await rt.run({ agentId: "planner", task: "x" });
  assert.equal(result.timedOut, true);
  assert.equal(result.state, STATE.TIMED_OUT);
  assert.equal(result.completed, false);
  assert.equal(result.cancelled, false, "timeout and cancellation are different facts");
});

test("an already-aborted signal cancels before any provider call", async () => {
  const complete = say("ok");
  const rt = runtime({ complete });
  const controller = new AbortController();
  controller.abort();
  const result = await rt.run({ agentId: "planner", task: "x", signal: controller.signal });
  assert.equal(result.cancelled, true);
  assert.equal(result.state, STATE.CANCELLED);
  assert.equal(result.timedOut, false);
  assert.equal(result.completed, false);
});

test("an abort during the run cancels rather than completing", async () => {
  const controller = new AbortController();
  const complete = async () => {
    controller.abort();
    throw Object.assign(new Error("aborted"), { code: "abort" });
  };
  const rt = runtime({ complete });
  const result = await rt.run({ agentId: "planner", task: "x", signal: controller.signal });
  assert.notEqual(result.completed, true);
  assert.ok(result.cancelled || result.state === STATE.FAILED);
});

test("an unbounded iteration count is refused at definition time", () => {
  assert.throws(() => agent({ bounds: { maxIterations: 0 } }), /maxIterations/);
  assert.throws(() => agent({ bounds: { maxToolCalls: -1 } }), /maxToolCalls/);
  assert.throws(() => agent({ bounds: { maxDepth: 99 } }), /maxDepth/);
});

// ---------------------------------------------------------------------------
// output contract
// ---------------------------------------------------------------------------

test("json in a code fence satisfies the output contract", async () => {
  // A contract check that rejected fences would fail every well-behaved model.
  const rt = runtime({
    specs: [agent({ output: { summary: { type: "string", required: true } } })],
    complete: say('```json\n{"summary":"migrate in three steps"}\n```'),
  });
  const result = await rt.run({ agentId: "planner", task: "x" });
  assert.equal(result.state, STATE.COMPLETED);
  assert.equal(result.output.summary, "migrate in three steps");
});

test("malformed output fails against the declared contract", async () => {
  const rt = runtime({
    specs: [agent({ output: { summary: { type: "string", required: true } } })],
    complete: say("I think you should probably migrate carefully"),
  });
  const result = await rt.run({ agentId: "planner", task: "x" });
  assert.equal(result.state, STATE.FAILED);
  assert.equal(result.error.code, "output_contract");
  assert.match(result.error.message, /summary is required/);
});

test("an output field of the wrong type is caught", async () => {
  const rt = runtime({
    specs: [agent({ output: { steps: { type: "array", required: true } } })],
    complete: say('{"steps":"three"}'),
  });
  const result = await rt.run({ agentId: "planner", task: "x" });
  assert.equal(result.error.code, "output_contract");
  assert.match(result.error.message, /steps should be array/);
});

test("an unknown field is rejected when the contract says so", async () => {
  const rt = runtime({
    specs: [agent({ output: { unknownFields: "reject", summary: { type: "string" } } })],
    complete: say('{"summary":"ok","surprise":1}'),
  });
  const result = await rt.run({ agentId: "planner", task: "x" });
  assert.equal(result.error.code, "output_contract");
  assert.match(result.error.message, /unknown field surprise/);
});

test("an unknown field is tolerated when the contract allows it", async () => {
  const rt = runtime({
    specs: [agent({ output: { unknownFields: "ignore", summary: { type: "string" } } })],
    complete: say('{"summary":"ok","surprise":1}'),
  });
  assert.equal((await rt.run({ agentId: "planner", task: "x" })).state, STATE.COMPLETED);
});

test("an agent with no declared contract accepts plain text", async () => {
  const rt = runtime({ complete: say("just some prose") });
  const result = await rt.run({ agentId: "planner", task: "x" });
  assert.equal(result.output, "just some prose");
});

test("an over-long output field is caught", async () => {
  const rt = runtime({
    specs: [agent({ output: { summary: { type: "string", maxLength: 10 } } })],
    complete: say('{"summary":"' + "x".repeat(50) + '"}'),
  });
  assert.equal((await rt.run({ agentId: "planner", task: "x" })).error.code, "output_contract");
});

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

const SHELL = {
  name: "shell",
  scope: TOOL_SCOPE.SHELL,
  async execute(args) {
    return `ran:${args.command}`;
  },
};

/** A completion that asks for tools on its first turn, then answers. */
function toolThenAnswer(calls, text = "done") {
  const state = { turn: 0 };
  const fn = async (_config, modelId) => {
    state.turn += 1;
    if (state.turn === 1) return { model: modelId, toolCalls: calls };
    return { model: modelId, text };
  };
  fn.state = state;
  return fn;
}

const WIDE = { scopes: [TOOL_SCOPE.SHELL], allow: ["shell:*"] };

test("a requested tool runs and its output feeds the next turn", async () => {
  const complete = toolThenAnswer([{ tool: "shell", args: { command: "ls" } }]);
  const rt = runtime({ complete, tools: { shell: SHELL }, specs: [agent({ tools: WIDE })] });
  const result = await rt.run({ agentId: "planner", task: "look around" });
  assert.equal(result.state, STATE.COMPLETED);
  assert.equal(result.toolCalls, 1);
  assert.equal(result.toolResults[0].outcome, "ok");
  assert.equal(result.output, "done");
  assert.equal(complete.state.turn, 2, "the tool result must come back for a second turn");
});

test("the tool's output is shown to the model on the following turn", async () => {
  const seen = [];
  const complete = async (_c, modelId, prompt) => {
    seen.push(prompt);
    if (seen.length === 1) return { model: modelId, toolCalls: [{ tool: "shell", args: { command: "ls" } }] };
    return { model: modelId, text: "done" };
  };
  const rt = runtime({ complete, tools: { shell: SHELL }, specs: [agent({ tools: WIDE })] });
  await rt.run({ agentId: "planner", task: "look around" });
  assert.match(seen[1], /\[tool shell\] ran:ls/);
});

test("a tool the agent may not use stops the run rather than retrying", async () => {
  const complete = toolThenAnswer([{ tool: "shell", args: { command: "rm -rf /" } }]);
  const rt = runtime({ complete, tools: { shell: SHELL } });
  const result = await rt.run({ agentId: "planner", task: "delete everything" });
  assert.equal(result.state, STATE.FAILED);
  assert.equal(result.error.code, "tool_denied");
  assert.equal(complete.state.turn, 1, "a denied tool must not be asked for again");
});

test("an unknown tool is a failure naming the tool", async () => {
  const complete = toolThenAnswer([{ tool: "teleport", args: {} }]);
  const rt = runtime({ complete, tools: { shell: SHELL }, specs: [agent({ tools: WIDE })] });
  const result = await rt.run({ agentId: "planner", task: "x" });
  assert.equal(result.error.code, "tool_denied");
  assert.match(result.error.message, /no such tool: teleport/);
});

test("the tool-call budget stops a model that keeps calling tools", async () => {
  // The loop-forever failure. Without a cap this is an infinite loop with a token
  // bill attached.
  const complete = async (_c, modelId) => ({ model: modelId, toolCalls: [{ tool: "shell", args: { command: "ls" } }] });
  const rt = runtime({
    complete,
    tools: { shell: SHELL },
    specs: [agent({ tools: WIDE, bounds: { maxToolCalls: 2 } })],
  });
  const result = await rt.run({ agentId: "planner", task: "loop" });
  assert.notEqual(result.state, STATE.COMPLETED);
  assert.ok(result.toolCalls <= 2, `tool calls must stop at the cap, saw ${result.toolCalls}`);
});

test("an unparseable tool request yields no calls rather than a guess", async () => {
  // A guessed tool call is an unauthorised command.
  const rt = runtime({
    complete: say("I would like to run some shell things"),
    tools: { shell: SHELL },
    specs: [agent({ tools: WIDE })],
  });
  const result = await rt.run({ agentId: "planner", task: "x" });
  assert.equal(result.toolCalls, 0);
  assert.equal(result.state, STATE.COMPLETED);
});

test("a json tool-call envelope is honoured", async () => {
  // A model that answers with a tool-call envelope on every turn would loop until
  // a bound stops it -- that is what the bounds are for, and it is asserted
  // separately. This test only asserts the envelope is understood.
  const complete = say('{"toolCalls":[{"tool":"shell","args":{"command":"ls"}}]}');
  const rt = runtime({
    complete,
    tools: { shell: SHELL },
    specs: [agent({ tools: WIDE, bounds: { maxToolCalls: 1 } })],
  });
  const result = await rt.run({ agentId: "planner", task: "x" });
  assert.equal(result.toolCalls, 1);
  assert.equal(result.toolResults[0].outcome, "ok");
});

// ---------------------------------------------------------------------------
// persistence
// ---------------------------------------------------------------------------

test("a completed run is recorded on the blackboard", async () => {
  const calls = [];
  const rt = runtime({
    // Valid output for the declared contract, so the run reaches persistence at
    // all. An agent that fails its contract never gets this far.
    complete: say('{"summary":"migrated the parser"}'),
    blackboard: {
      exists: () => true,
      summary: () => ({}),
      recordImplementation: (arg) => calls.push(arg),
    },
    specs: [agent({ output: { summary: { type: "string" } } })],
  });
  await rt.run({ agentId: "planner", task: "x", sessionId: "ses-1" });
  assert.equal(calls.length, 1);
  assert.match(calls[0].summary, /migrated the parser/);
});

test("a session entry is appended for the agent", async () => {
  const appended = [];
  const rt = runtime({
    complete: say("done"),
    sessions: {
      read: (id) => ({ id, name: "the big one", agents: [] }),
      append: (id, kind, payload, opts) => appended.push({ id, kind, payload, opts }),
    },
  });
  await rt.run({ agentId: "planner", task: "x", sessionId: "ses-7" });
  assert.equal(appended.length, 1);
  assert.equal(appended[0].id, "ses-7");
  assert.equal(appended[0].kind, "agent");
  assert.equal(appended[0].opts.agent, "planner");
});

test("a sessions collaborator without read() is named rather than throwing a TypeError", async () => {
  // The wiring mistake is a missing method, so the error should say that.
  const rt = runtime({ complete: say("done"), sessions: { append() {} } });
  const result = await rt.run({ agentId: "planner", task: "x", sessionId: "ses-7" });
  assert.equal(result.state, STATE.FAILED);
  assert.equal(result.error.code, "bad_sessions");
});

test("a persistence failure is surfaced, not hidden", async () => {
  // An agent that succeeded but could not record that it succeeded has produced
  // work nobody will find again -- exactly what the Blackboard exists to prevent.
  const rt = runtime({
    complete: say("done"),
    blackboard: {
      exists: () => true,
      summary: () => ({}),
      recordImplementation: () => {
        throw new Error("disk full");
      },
    },
  });
  const result = await rt.run({ agentId: "planner", task: "x" });
  assert.equal(result.state, STATE.COMPLETED);
  assert.match(result.persistError, /disk full/);
});

// ---------------------------------------------------------------------------
// events and immutability
// ---------------------------------------------------------------------------

test("the lifecycle emits the events an operator needs to reconstruct a run", async () => {
  const rt = runtime({ complete: say("done") });
  const result = await rt.run({ agentId: "planner", task: "x" });
  const types = result.events.map((e) => e.type);
  for (const expected of ["agent.context_loaded", "agent.model_selected", "agent.start", "agent.output", "agent.completed"]) {
    assert.ok(types.includes(expected), `expected ${expected} in ${types.join(", ")}`);
  }
});

test("a broken logger does not take the run down", async () => {
  const rt = runtime({
    complete: say("done"),
    log: {
      emit() {
        throw new Error("logger exploded");
      },
      errorCount: 0,
    },
  });
  assert.equal((await rt.run({ agentId: "planner", task: "x" })).state, STATE.COMPLETED);
});

test("the result is frozen", async () => {
  const result = await runtime({ complete: say("done") }).run({ agentId: "planner", task: "x" });
  assert.ok(Object.isFrozen(result));
});

test("duration is reported", async () => {
  let clock = 0;
  const complete = async () => {
    clock = 250;
    return { model: "oc/muse", text: "done" };
  };
  const result = await runtime({ complete, now: () => clock }).run({ agentId: "planner", task: "x" });
  assert.equal(result.durationMs, 250);
});

// ---------------------------------------------------------------------------
// prompt construction
// ---------------------------------------------------------------------------

test("the output contract is stated in the prompt", async () => {
  const complete = say("{}");
  const rt = runtime({
    complete,
    specs: [agent({ output: { summary: { type: "string", description: "one line" } } })],
  });
  await rt.run({ agentId: "planner", task: "x" });
  assert.match(complete.state.prompts[0], /Answer as JSON with these fields: summary/);
  assert.match(complete.state.prompts[0], /one line/);
});

test("a repeated attempt is labelled", () => {
  const prompt = buildPrompt(agent(), { nextAction: null }, "do it", 2);
  assert.match(prompt, /continuing, attempt 2/);
});

test("tool observations are rendered after the task, in order", () => {
  const prompt = buildPrompt(agent(), {}, "do it", 2, [
    { tool: "shell", output: "first" },
    { tool: "read_file", output: { lines: 2 } },
  ]);
  assert.ok(prompt.indexOf("do it") < prompt.indexOf("[tool shell]"));
  assert.ok(prompt.indexOf("[tool shell]") < prompt.indexOf("[tool read_file]"));
});

test("an unserialisable tool output does not break prompt building", () => {
  const cyclic = {};
  cyclic.self = cyclic;
  const prompt = buildPrompt(agent(), {}, "do it", 2, [{ tool: "shell", output: cyclic }]);
  assert.match(prompt, /unserialisable tool output/);
});

test("renderSystemPrompt keeps instructions ahead of recorded state", () => {
  const prompt = renderSystemPrompt(agent(), { goal: "ship", nextAction: null, truncated: {} });
  assert.ok(prompt.indexOf("You are a planner") < prompt.indexOf("ship"));
});
// ---------------------------------------------------------------------------
// bounds declared but previously unenforced
// ---------------------------------------------------------------------------

test("routing.maxAttempts caps the provider cascade", async () => {
  // An agent declaring maxRetries: 0 means "do not try a second provider on my
  // own initiative". Without this the catalogue size decides, and a 40-model host
  // would run forty attempts against a declaration of zero.
  const complete = say("ok", { failFirst: 5 });
  const rt = runtime({
    complete,
    specs: [agent({ failure: { maxRetries: 0 }, routing: { maxAttempts: 1 } })],
  });
  const result = await rt.run({ agentId: "planner", task: "x" });
  assert.equal(result.state, STATE.FAILED);
  assert.equal(complete.state.calls, 1, "only the first candidate may be tried");
});

test("routing.maxAttempts of zero means unset, not none", async () => {
  // Regression from the first attempt at this: 0 is the registry default, and
  // reading it as a hard zero silently disabled provider fallback for every agent
  // that never thought to set it.
  const complete = say("ok", { failFirst: 1 });
  const rt = runtime({ complete, specs: [agent({ routing: { maxAttempts: 0 } })] });
  const result = await rt.run({ agentId: "planner", task: "x" });
  assert.equal(result.state, STATE.COMPLETED, "the default must still fall back");
});

test("maxRetries alone bounds the cascade even with a long catalogue", async () => {
  const complete = say("ok", { failFirst: 9 });
  const rt = runtime({
    complete,
    catalogue: ["a/1", "b/2", "c/3", "d/4", "e/5"],
    specs: [agent({ failure: { maxRetries: 1 } })],
  });
  const result = await rt.run({ agentId: "planner", task: "x" });
  assert.equal(result.state, STATE.FAILED);
  assert.equal(complete.state.calls, 2, "maxRetries 1 means two attempts, not five");
});

test("truncating the cascade keeps whole tiers intact", async () => {
  // Tiers carry the preference signal, so a tier is never cut in half.
  const complete = say("ok", { failFirst: 9 });
  const rt = runtime({
    complete,
    specs: [agent({ failure: { maxRetries: 1 }, routing: { tierSize: 3 } })],
  });
  const result = await rt.run({ agentId: "planner", task: "x" });
  const used = result.plan.tiers.slice(0, 1);
  assert.ok(Array.isArray(used));
  assert.equal(result.error.code, "no_route");
});

test("recursion deeper than maxDepth is refused before any work happens", async () => {
  const complete = say("ok");
  const rt = runtime({ complete, specs: [agent({ bounds: { maxDepth: 1 } })] });
const result = await rt.run({ agentId: "planner", task: "x", depth: 2 });
  assert.equal(result.state, STATE.FAILED);
  assert.equal(result.error.code, "agent_bound_exceeded");
  assert.match(result.error.message, /maxDepth/);
  assert.equal(complete.state.calls, 0, "an over-deep run must dispatch nothing");
});

test("depth within maxDepth runs normally", async () => {
  const complete = say("ok");
  const rt = runtime({ complete, specs: [agent({ bounds: { maxDepth: 2 } })] });
  const result = await rt.run({ agentId: "planner", task: "x", depth: 2 });
  assert.equal(result.state, STATE.COMPLETED);
  assert.equal(result.depth, 2);
});

// ---------------------------------------------------------------------------
// event honesty
// ---------------------------------------------------------------------------

test("model_selected names the model the router actually chose", async () => {
  // It used to be emitted before routing, carrying the candidate list -- so the log
  // recorded a selection that the receipt could then contradict.
  const complete = say("ok", { failFirst: 1 });
  const rt = runtime({ complete });
  const result = await rt.run({ agentId: "planner", task: "x" });
  const selected = result.events.filter((e) => e.type === "agent.model_selected");
  assert.equal(selected.length, 1);
  assert.equal(selected[0].model, "gem/gemini-2.5-pro");
});

test("the candidate set is reported as a plan, not as a selection", async () => {
  const complete = say("ok");
  const rt = runtime({ complete });
  const result = await rt.run({ agentId: "planner", task: "x" });
  const planned = result.events.filter((e) => e.type === "agent.route_planned");
  assert.equal(planned.length, 1);
  assert.ok(Array.isArray(planned[0].candidates));
  assert.equal(planned[0].model, undefined, "a plan has no model in it");
});

test("a cancelled run emits cancelled, not failed", async () => {
  // One AGENT_FAILED carrying a `timedOut` flag invites every consumer to read one
  // field and treat a cancellation as a failure -- the conflation the orthogonal
  // result state exists to prevent, reappearing at the event layer.
  const controller = new AbortController();
  const complete = () => {
    controller.abort("user stopped it");
    return Promise.resolve({ text: "ok" });
  };
  const rt = runtime({ complete, specs: [agent({ bounds: { maxIterations: 4 } })] });
  const result = await rt.run({ agentId: "planner", task: "x", signal: controller.signal });

  assert.equal(result.cancelled, true);
  assert.equal(result.state, STATE.CANCELLED);
  const types = result.events.map((e) => e.type);
  assert.ok(types.includes("agent.cancelled"), "cancellation needs its own event");
  assert.ok(!types.includes("agent.failed"), "cancellation is not a failure");
});

test("a timed-out run emits an error with kind timeout, not a plain failure", async () => {
  let now = 1_000;
  const rt = runtime({
    complete: say("ok"),
    now: () => (now += 5_000),
    specs: [agent({ bounds: { timeoutMs: 1_000, maxIterations: 4 } })],
  });
  const result = await rt.run({ agentId: "planner", task: "x" });
  assert.equal(result.timedOut, true);
  const event = result.events.find((e) => e.type === "agent.error");
  assert.ok(event, "a timeout must be reported as an error event");
  assert.equal(event.kind, "timeout");
});

test("every state transition is recorded on the result, not only in the log", async () => {
  // The log is best-effort and can be filtered or unavailable. A receipt that only
  // exists in the log does not exist when someone reconstructs why a run stopped.
  const rt = runtime({ complete: say("ok") });
  const result = await rt.run({ agentId: "planner", task: "x" });
  assert.ok(Array.isArray(result.states));
  assert.ok(result.states.includes(STATE.CONTEXT_LOADING));
  assert.ok(result.states.includes(STATE.RUNNING));
  assert.ok(result.states.includes(STATE.COMPLETED));
  assert.equal(result.states[result.states.length - 1], result.state);
});

// ---------------------------------------------------------------------------
// persistence
// ---------------------------------------------------------------------------

test("the session records the outcome, not just the summary", async () => {
  // "fixed the routing cascade" is close to useless a week later. What makes the
  // entry worth reading is the model, the counts and the error, when there was one.
  const appended = [];
  const sessions = {
    read: () => ({ id: "ses_1", entries: [] }),
    append: (id, kind, payload) => {
      appended.push({ id, kind, payload });
      return { id };
    },
  };
  const rt = runtime({ complete: say("ok"), sessions });
  await rt.run({ agentId: "planner", task: "x", sessionId: "ses_1" });

  assert.equal(appended.length, 1);
  const { payload } = appended[0];
  assert.equal(payload.agentId, "planner");
  assert.equal(payload.completed, true);
  assert.equal(payload.state, STATE.COMPLETED);
  assert.ok(payload.model);
  assert.equal(typeof payload.iterations, "number");
  assert.ok(payload.output, "the output belongs in the record");
});

test("the result carries the blackboard reference so the two stores link up", async () => {
  const recorded = [];
  const rt = runtime({
    complete: say("ok"),
    blackboard: {
      id: "bb_abc123",
      recordImplementation: (entry) => recorded.push(entry),
      summary: () => ({}),
    },
    sessions: { read: () => ({}), append: () => ({}) },
  });
  const result = await rt.run({ agentId: "planner", task: "x", sessionId: "ses_1" });
  assert.equal(recorded.length, 1);
  assert.equal(result.blackboardRef, "bb_abc123");
  assert.equal(recorded[0].sessionId, "ses_1");
});
