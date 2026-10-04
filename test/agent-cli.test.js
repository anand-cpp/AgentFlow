// `aflow agent` command tests.
//
// definitions.test.js covers what the agents are; this file covers the command
// layer: dispatch, exit codes, and the privilege display.
//
// The display tests are not cosmetic. `aflow agent` is the thing someone reads
// instead of running `aflow agent show`, so a summary that understates an agent's
// reach is a security defect, not a cosmetic one. There is a test for that below.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentCommand } from "../src/commands/agent.js";

function stubOut() {
  const rendered = [];
  return {
    json: false,
    quiet: false,
    verbose: false,
    rendered,
    last() {
      return rendered[rendered.length - 1];
    },
    async init(result, renderText) {
      const text = typeof renderText === "function" ? renderText(result) : null;
      rendered.push({ result, text });
      return text;
    },
    error(message) {
      rendered.push({ error: message });
    },
    warn(message) {
      rendered.push({ warn: message });
    },
    detail(message) {
      rendered.push({ detail: message });
    },
  };
}

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aflow-agent-cli-"));
}

/**
 * No flags that would dispatch to a provider. `run` is tested in runtime.test.js
 * with an injected completion; here it only needs to reach its own guards.
 */
async function run(args, extraFlags = {}) {
  const out = stubOut();
  const returned = await agentCommand.run({
    args,
    flags: { "state-dir": scratch(), "blackboard-dir": scratch(), ...extraFlags },
    config: {},
    out,
  });
  const code = typeof returned === "number" ? returned : 0;
  return { code, out, payload: out.last()?.result, text: out.last()?.text };
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

test("no subcommand lists the built-ins", async () => {
  const { code, payload, text } = await run([]);
  assert.equal(code, 0);
  assert.equal(payload.count, 8);
  // The renderer must actually run; a stub that never calls it would let a crash
  // in the text path ship.
  assert.match(text, /aflow agent/);
  for (const id of ["planner", "coder", "reviewer", "debugger", "tester", "researcher", "security", "release"]) {
    assert.match(text, new RegExp(id));
  }
});

test("list dispatches nothing to a provider", async () => {
  // An empty config means any real gateway call would throw, so a clean exit is
  // itself the assertion.
  const { code } = await run(["list"]);
  assert.equal(code, 0);
});

test("list reports a privilege level for every agent", async () => {
  const { payload } = await run(["list"]);
  for (const agent of payload.agents) {
    assert.ok(["read-only", "elevated", "high"].includes(agent.privilege), `${agent.id} has ${agent.privilege}`);
  }
});

test("the listing never calls an agent with shell access read-only", async () => {
  // The bug this guards: Release has no write scope but can run `git push` on
  // approval, and a write/shell-only split labelled it "read-only". Someone reading
  // the list instead of `show` would be misled about the highest-privilege agent
  // in the system.
  const { payload } = await run(["list"]);
  const byId = Object.fromEntries(payload.agents.map((a) => [a.id, a]));
  assert.equal(byId.release.privilege, "elevated");
  assert.equal(byId.researcher.privilege, "elevated");
  assert.equal(byId.coder.privilege, "high");
  assert.equal(byId.planner.privilege, "read-only");
  for (const agent of payload.agents) {
    if (!agent.scopes.includes("shell")) continue;
    assert.notEqual(agent.privilege, "read-only", `${agent.id} has shell but is labelled read-only`);
  }
});

// ---------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------

test("show prints an agent's scopes, gates and bounds", async () => {
  const { code, text } = await run(["show", "coder"]);
  assert.equal(code, 0);
  assert.match(text, /shell:git status/);
  assert.match(text, /ask\s+shell:\*/);
  assert.match(text, /bounds/);
  assert.match(text, /output contract/);
});

test("show describes ask as approval rather than refusal", async () => {
  // The three states -- silent, approval-gated, refused -- are easy to conflate,
  // and the difference between "asks" and "refused" is the entire point.
  const { text } = await run(["show", "coder"]);
  assert.match(text, /needs approval/);
  assert.match(text, /anything else is refused/);
});

test("show says plainly that a scope-gated agent needs approval for everything", async () => {
  const { text } = await run(["show", "planner"]);
  assert.match(text, /allow/);
});

test("show with no id is a usage error", async () => {
  const { code, text } = await run(["show"]);
  assert.equal(code, 2);
  assert.match(text, /which agent/);
});

test("show on an unknown agent is an error, not a usage mistake", async () => {
  // Exit 1: "no such agent" is a real answer, not a malformed command.
  await assert.rejects(() => agentCommand.run({
    args: ["show", "nope"],
    flags: {},
    config: {},
    out: stubOut(),
  }));
});

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

test("run with no task is a usage error with exit 2", async () => {
  // Regression: the subcommand is async, so `return runSub(...)` handed its
  // rejection past the try/catch and this exited 1 through the generic handler.
  const { code, text } = await run(["run", "coder"]);
  assert.equal(code, 2);
  assert.match(text, /nothing to do/);
});

test("run with no agent id is a usage error", async () => {
  const { code, text } = await run(["run"]);
  assert.equal(code, 2);
  assert.match(text, /which agent/);
});

test("run on an unknown agent names the known ones", async () => {
  await assert.rejects(
    () => agentCommand.run({ args: ["run", "nope", "do a thing"], flags: {}, config: {}, out: stubOut() }),
    /no such agent: nope; known agents: .*planner/,
  );
});

// ---------------------------------------------------------------------------
// dispatch and usage text
// ---------------------------------------------------------------------------

test("an unknown subcommand is a usage error and prints the usage text", async () => {
  const { code, text } = await run(["bogus"]);
  assert.equal(code, 2);
  assert.match(text, /unknown subcommand: bogus/);
  assert.match(text, /aflow agent run/);
});

test("the command declares the flags it reads", async () => {
  // The argv parser needs valueFlags before it can tell `--session x` from two
  // positionals, so a flag used but not declared silently swallows the next arg.
  for (const flag of ["task", "session", "state-dir", "blackboard-dir", "project"]) {
    assert.ok(agentCommand.valueFlags.includes(flag), `${flag} must be a declared value flag`);
  }
});

test("the usage text tells the reader that scopes are the control, not the prompt", async () => {
  const { text } = await run(["bogus"]);
  assert.match(text, /instructions do not/);
  assert.match(text, /untrusted party/);
});

test("the usage text states the exit codes", async () => {
  const { text } = await run(["bogus"]);
  assert.match(text, /0 completed, 1 failed\/timed out\/cancelled, 2 usage/);
});

test("the privilege summary is derived from scopes, so it cannot drift from them", async () => {
  // Cross-check against the registry directly: if the derivation and the
  // declarations ever disagree, this is where it shows.
  const { builtinSpecs } = await import("../src/core/agents/definitions.js");
  const { payload } = await run(["list"]);
  const shown = Object.fromEntries(payload.agents.map((a) => [a.id, a.privilege]));
  for (const spec of builtinSpecs()) {
    assert.ok(shown[spec.id], `${spec.id} missing from the listing`);
    // scopes is a list of names, so membership is the question -- not position.
    const writes = spec.tools.scopes.includes("write");
    const shells = spec.tools.scopes.includes("shell");
    const networked = spec.tools.scopes.includes("network");
    // Three levels, and network counts as elevating: an agent that can make
    // outbound requests on approval is not read-only in any useful sense.
    if (writes && shells) assert.equal(shown[spec.id], "high", spec.id);
    else if (!writes && !shells && !networked) assert.equal(shown[spec.id], "read-only", spec.id);
    else assert.equal(shown[spec.id], "elevated", spec.id);
  }
});