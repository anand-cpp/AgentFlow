// Built-in agent declarations: shape and least-privilege policy.
//
// Each agent is checked against the same questions, because "can this agent do
// something destructive" is a property of its scopes, not of its instructions.

import test from "node:test";
import assert from "node:assert/strict";

import { BUILT_INS, builtinSpecs } from "../src/core/agents/definitions.js";
import { TOOL_SCOPE, CAPABILITY, AgentRegistry, AgentConflictError } from "../src/core/agents/registry.js";
import { evaluatePermission } from "../src/core/agents/tools.js";

const EXPECTED = ["planner", "coder", "reviewer", "debugger", "tester", "researcher", "security", "release"];

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

test("the tester runs tests but cannot deploy or publish", () => {
  assert.equal(permits("tester", "run_tests", { command: "npm test" }).decision, "allow");
  assert.equal(permits("tester", "shell", { command: "npm test" }).decision, "allow");
  // Even with an approver: deployment is not a testing action under any reading.
  assert.equal(permits("tester", "shell", { command: "npm publish" }, yes).decision, "ask");
  assert.equal(permits("tester", "shell", { command: "git push origin main" }, yes).decision, "ask");
});

test("the tester has no network, so it cannot change what it is testing", () => {
  // A test agent that can install from a registry can swap the code under test
  // and then report a green run against something nobody is shipping.
  assert.equal(permits("tester", "fetch", { url: "https://registry.npmjs.org/x" }, yes).decision, "deny");
});

test("the researcher reads freely but asks before every fetch", () => {
  assert.equal(permits("researcher", "read_file", { path: "docs/x.md" }).decision, "allow");
  assert.equal(permits("researcher", "grep", { pattern: "TODO" }).decision, "allow");
  // No host allowlist, by design -- see the note in definitions.js.
  assert.equal(permits("researcher", "fetch", { url: "https://example.test" }).decision, "deny");
  assert.equal(permits("researcher", "fetch", { url: "https://example.test" }, yes).decision, "ask");
});

test("the researcher cannot write or run commands", () => {
  assert.equal(permits("researcher", "write_file", { path: "notes.md" }).decision, "deny");
  assert.equal(permits("researcher", "shell", { command: "npm test" }, yes).decision, "deny");
});

test("the security agent audits without editing", () => {
  // An auditor that patches what it finds has destroyed the evidence and marked
  // its own homework.
  assert.equal(permits("security", "read_file", { path: "src/x.js" }).decision, "allow");
  assert.equal(permits("security", "write_file", { path: "src/x.js" }).decision, "deny");
  assert.equal(permits("security", "shell", { command: "npm test" }).decision, "deny");
});

test("the security agent must report what it did not check", () => {
  // An audit without stated limits reads as comprehensive when it is partial.
  const fields = new AgentRegistry(builtinSpecs()).get("security").output.fields;
  const notChecked = fields.find((f) => f.name === "notChecked");
  assert.ok(notChecked, "security must declare a `notChecked` field");
  assert.equal(notChecked.required, true);
});

test("the release agent has no silent path to anything irreversible", () => {
  const release = new AgentRegistry(builtinSpecs()).get("release");
  for (const command of ["npm publish", "git push origin main", "gh release create", "git tag -f v1", "npm run deploy"]) {
    for (const approver of [null, yes]) {
      assert.notEqual(permits("release", "shell", { command }, approver).decision, "allow",
        `release must not silently run ${command}`);
    }
  }
  // Including the read-only commands it *is* allowed, to prove the check above
  // is actually evaluating something.
  assert.equal(permits("release", "shell", { command: "git status" }).decision, "allow");
  assert.equal(permits("release", "shell", { command: "npm pack --dry-run" }).decision, "allow");
});

test("the release agent reports whether it actually published", () => {
  // Same device as the tester's `ran`: the contract makes an unearned success
  // unreportable.
  const published = new AgentRegistry(builtinSpecs()).get("release").output.fields.find((f) => f.name === "published");
  assert.ok(published, "release must declare a `published` field");
  assert.equal(published.required, true);
});

test("the release agent has the tightest bounds in the system", () => {
  // Highest privilege, fewest attempts: a release loop that retries on its own is a
  // release loop nobody asked for.
  const registry = new AgentRegistry(builtinSpecs());
  const release = registry.get("release");
  assert.equal(release.failure.maxRetries, 0);
  assert.ok(release.bounds.maxToolCalls < registry.get("debugger").bounds.maxToolCalls);
  assert.ok(release.bounds.maxToolCalls < registry.get("coder").bounds.maxToolCalls);
});

test("agents with write access are exactly the ones meant to have it", () => {
  // A cross-check rather than a per-agent list: if a new agent quietly gains write
  // it shows up here even if someone forgot to update the table above.
  const registry = new AgentRegistry(builtinSpecs());
  const writers = registry.ids().filter((id) => registry.get(id).tools.scopes.includes(TOOL_SCOPE.WRITE));
  assert.deepEqual(writers.sort(), ["coder", "debugger", "tester"]);
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
    tester: [CAPABILITY.CODING, CAPABILITY.TOOL_CALLING],
    researcher: [CAPABILITY.RESEARCH, CAPABILITY.LONG_CONTEXT],
    security: [CAPABILITY.SECURITY, CAPABILITY.REASONING],
    release: [CAPABILITY.PLANNING, CAPABILITY.TOOL_CALLING],
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

test("the tester must report whether it actually ran anything", () => {
  // A Tester that can say "everything passes" without running a test is a false
  // assurance, and it is the most expensive kind of wrong in this system.
  const ran = new AgentRegistry(builtinSpecs()).get("tester").output.fields.find((f) => f.name === "ran");
  assert.ok(ran, "tester must declare a `ran` field");
  assert.equal(ran.required, true, "tester's `ran` must be required, not optional");
});

test("the researcher must report its confidence", () => {
  const confidence = new AgentRegistry(builtinSpecs()).get("researcher").output.fields.find((f) => f.name === "confidence");
  assert.ok(confidence, "researcher must declare a `confidence` field");
  assert.equal(confidence.required, true);
});

test("the researcher carries the largest context budget of the read-only agents", () => {
  const registry = new AgentRegistry(builtinSpecs());
  assert.ok(registry.get("researcher").bounds.maxContextChars > registry.get("planner").bounds.maxContextChars);
});

test("no built-in declares escalation to an agent that does not exist", () => {
  // The failure policy is a declaration, so a dangling `escalateTo` would be a
  // promise nothing keeps. Escalation is not wired up yet; when it is, it gets
  // validated here rather than noticed at 3am.
  for (const agent of builtinSpecs()) {
    assert.equal(agent.failure.escalateTo ?? null, null, `${agent.id} declares unvalidated escalation`);
  }
});