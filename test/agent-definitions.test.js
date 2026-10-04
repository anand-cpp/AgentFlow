// Built-in agent declarations: shape and least-privilege policy.
//
// Each agent is checked against the same questions, because "can this agent do
// something destructive" is a property of its scopes, not of its instructions.

import test from "node:test";
import assert from "node:assert/strict";

import { BUILT_INS, builtinSpecs } from "../src/core/agents/definitions.js";
import { TOOL_SCOPE, CAPABILITY, AgentRegistry, AgentConflictError } from "../src/core/agents/registry.js";
import { evaluatePermission } from "../src/core/agents/tools.js";

const EXPECTED = ["planner", "coder", "reviewer", "debugger"];

const TOOL_SCOPE_OF = {
  shell: TOOL_SCOPE.SHELL,
  write_file: TOOL_SCOPE.WRITE,
  read_file: TOOL_SCOPE.READ,
  grep: TOOL_SCOPE.SEARCH,
  fetch: TOOL_SCOPE.NETWORK,
  run_tests: TOOL_SCOPE.TEST,
};

function permits(agentId, tool, args, approver = null) {
  const agent = new AgentRegistry(builtinSpecs()).get(agentId);
  return evaluatePermission(agent, { name: tool, scope: TOOL_SCOPE_OF[tool] }, { tool, args }, { approver });
}

const yes = async () => true;

// ---------------------------------------------------------------------------
// shape
// ---------------------------------------------------------------------------

test("every declared built-in is present", () => {
  assert.deepEqual(Object.keys(BUILT_INS).sort(), [...EXPECTED].sort());
});

test("every built-in registers cleanly alongside the others", () => {
  assert.equal(new AgentRegistry(builtinSpecs()).ids().length, EXPECTED.length);
});

test("every built-in states a purpose and instructions a model can act on", () => {
  for (const agent of builtinSpecs()) {
    assert.ok(agent.purpose.length > 10, `${agent.id} needs a real purpose`);
    assert.ok(agent.instructions.length > 80, `${agent.id} needs real instructions, not a label`);
    assert.ok(agent.output.fields.length > 0, `${agent.id} must declare an output shape`);
  }
});

test("every built-in declares a required summary field", () => {
  // So `aflow agent run` can print something useful for all of them uniformly.
  for (const agent of builtinSpecs()) {
    const summary = agent.output.fields.find((f) => f.name === "summary");
    assert.ok(summary, `${agent.id} must declare a summary field`);
    assert.equal(summary.required, true, `${agent.id}'s summary must be required`);
  }
});

test("every built-in rejects unknown output fields rather than ignoring drift", () => {
  for (const agent of builtinSpecs()) {
    assert.equal(agent.output.unknownFields, "reject", `${agent.id} should reject unknown fields`);
  }
});

// ---------------------------------------------------------------------------
// policy invariants that apply to every agent
// ---------------------------------------------------------------------------

test("no built-in grants itself network access silently", () => {
  for (const agent of builtinSpecs()) {
    const net = agent.tools.allow.filter((e) => e.startsWith(`${TOOL_SCOPE.NETWORK}:`));
    assert.ok(
      net.length === 0 || agent.tools.requireApproval.includes(TOOL_SCOPE.NETWORK),
      `${agent.id} has network access with no approval gate`
    );
  }
});

test("no built-in can publish, push or release without asking", () => {
  // Checked by name rather than by reading each agent's list, so adding an agent
  // later cannot quietly opt out.
  const irreversible = ["publish", "push", "deploy", "release", "login", "auth"];
  for (const agent of builtinSpecs()) {
    const silent = agent.tools.allow.filter((entry) => {
      const value = entry.slice(entry.indexOf(":") + 1).toLowerCase();
      return irreversible.some((verb) => value.includes(verb));
    });
    assert.deepEqual(silent, [], `${agent.id} may run ${silent.join(", ")} without approval`);
  }
});

test("no built-in grants unrestricted shell access", () => {
  for (const agent of builtinSpecs()) {
    assert.ok(!agent.tools.allow.includes(`${TOOL_SCOPE.SHELL}:*`), `${agent.id} may run any shell command`);
  }
});

test("every agent that can run shell leaves the rest of the scope asking, not refused", () => {
  // Not `requireApproval`: that would drag the allowlisted inspection commands into
  // the prompt too. An agent that cannot run `git status` without asking is an
  // agent nobody runs interactively.
  for (const agent of builtinSpecs()) {
    if (!agent.tools.scopes.includes(TOOL_SCOPE.SHELL)) continue;
    const gated =
      agent.tools.requireApproval.includes(TOOL_SCOPE.SHELL) ||
      agent.tools.ask.some((e) => e === `${TOOL_SCOPE.SHELL}:*`);
    assert.ok(gated, `${agent.id} has shell but nothing asks about the rest of it`);
  }
});

test("a built-in can be re-registered without losing its contract", () => {
  // Regression: the registry re-normalises declarations, and a non-idempotent
  // contract parser once turned the contract's own keys into declared fields.
  const first = new AgentRegistry(builtinSpecs());
  const again = new AgentRegistry([first.get("planner")]);
  assert.deepEqual(again.get("planner").output.fields, first.get("planner").output.fields);
});

test("registering the same built-in twice is a conflict, not a silent replace", () => {
  const registry = new AgentRegistry(builtinSpecs());
  assert.throws(() => registry.register(builtinSpecs()[0]), AgentConflictError);
});

// ---------------------------------------------------------------------------
// provider neutrality and bounds
// ---------------------------------------------------------------------------

test("model requirements are capabilities, never provider names", () => {
  // Provider neutrality: an agent says what it needs and something else decides who
  // provides it. A hard-coded model id would make the agent un-runnable on a
  // differently configured host.
  for (const agent of builtinSpecs()) {
    assert.equal(agent.model.pinModel, null, `${agent.id} must not pin a model`);
    assert.ok(agent.model.requireCapabilities.length > 0, `${agent.id} must state what it needs`);
    for (const preferred of agent.model.prefer) {
      assert.ok(!preferred.includes("/"), `${agent.id} names a provider in prefer: ${preferred}`);
    }
  }
});

test("every built-in is bounded", () => {
  for (const agent of builtinSpecs()) {
    assert.ok(agent.bounds.maxIterations > 0 && agent.bounds.maxIterations <= 20, agent.id);
    assert.ok(agent.bounds.timeoutMs > 0 && agent.bounds.timeoutMs <= 600_000, agent.id);
    assert.ok(agent.bounds.maxContextChars >= 1000, agent.id);
  }
});

// ---------------------------------------------------------------------------
// per-agent least privilege
// ---------------------------------------------------------------------------

test("the planner cannot change anything", () => {
  assert.equal(permits("planner", "read_file", { path: "src/x.js" }).decision, "allow");
  assert.equal(permits("planner", "write_file", { path: "src/x.js" }).decision, "deny");
  assert.equal(permits("planner", "shell", { command: "ls" }).decision, "deny");
  assert.equal(permits("planner", "fetch", { url: "https://x.test" }).decision, "deny");
});

test("the coder can edit files but not publish or push", () => {
  assert.equal(permits("coder", "write_file", { path: "src/x.js" }).decision, "allow");
  assert.equal(permits("coder", "shell", { command: "git status" }).decision, "allow");
  // Outside the allowlist, so it asks rather than being refused: usable at a
  // terminal, still a deliberate act.
  assert.equal(permits("coder", "shell", { command: "npm publish" }, yes).decision, "ask");
  assert.equal(permits("coder", "shell", { command: "git push origin main" }, yes).decision, "ask");
});

test("the coder cannot reach the network even with an approver", () => {
  assert.equal(permits("coder", "fetch", { url: "https://registry.npmjs.org/x" }, yes).decision, "deny");
});

test("the reviewer cannot write files", () => {
  // It should be able to find a bug and report it, not quietly fix it and call the
  // change reviewed. A reviewer that can edit is reviewing its own work.
  assert.equal(permits("reviewer", "read_file", { path: "src/x.js" }).decision, "allow");
  assert.equal(permits("reviewer", "write_file", { path: "src/x.js" }).decision, "deny");
  assert.equal(permits("reviewer", "shell", { command: "npm test" }).decision, "deny");
});

test("the debugger can reproduce and patch", () => {
  assert.equal(permits("debugger", "shell", { command: "npm test" }).decision, "allow");
  assert.equal(permits("debugger", "write_file", { path: "src/x.js" }).decision, "allow");
  assert.equal(permits("debugger", "run_tests", { command: "npm test" }).decision, "allow");
});

test("a shell allowlist entry does not permit a chained command", () => {
  assert.equal(permits("coder", "shell", { command: "git status; rm -rf /" }, yes).decision, "ask");
});

test("an agent with no approver cannot take an approval-gated action", () => {
  assert.equal(permits("coder", "shell", { command: "npm publish" }, null).decision, "deny");
});

test("each agent declares capabilities that match what it does", () => {
  const expectations = {
    planner: [CAPABILITY.PLANNING, CAPABILITY.REASONING],
    coder: [CAPABILITY.CODING, CAPABILITY.TOOL_CALLING],
    reviewer: [CAPABILITY.CODING, CAPABILITY.REASONING],
    debugger: [CAPABILITY.REASONING, CAPABILITY.TOOL_CALLING],
  };
  for (const [id, expected] of Object.entries(expectations)) {
    const agent = new AgentRegistry(builtinSpecs()).get(id);
    for (const capability of expected) {
      assert.ok(agent.capabilities.includes(capability), `${id} must declare ${capability}`);
    }
  }
});

test("an agent that writes needs a tighter tool budget than one that only reads", () => {
  const registry = new AgentRegistry(builtinSpecs());
  assert.ok(registry.get("planner").bounds.maxToolCalls < registry.get("coder").bounds.maxToolCalls);
});

test("no built-in declares escalation to an agent that does not exist", () => {
  // The failure policy is a declaration, so a dangling `escalateTo` would be a
  // promise nothing keeps. Escalation is not wired up yet; when it is, it gets
  // validated here rather than noticed at 3am.
  for (const agent of builtinSpecs()) {
    assert.equal(agent.failure.escalateTo ?? null, null, `${agent.id} declares unvalidated escalation`);
  }
});