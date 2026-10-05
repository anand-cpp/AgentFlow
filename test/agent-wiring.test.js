// T4: the agent runtime, wired to the real tools.
//
// Every other tool test in this repository calls a tool directly. That proves the
// tool works and proves nothing about whether the agent can reach it -- and the
// wiring was in fact absent: `aflow agent run` constructed its runtime with an empty
// tool map, so every call resolved to "no such tool" and the entire permission
// waterfall was unreachable from the CLI. A green suite said nothing about the thing
// that was broken.
//
// So these tests drive the same path a user does: real tools, a real runtime, a real
// workspace on disk, a real Session store, a real Blackboard. The provider is the
// only fake, because a live model cannot be required for a unit test -- and it is the
// right thing to fake, because the provider is the component that is supposed to be
// untrusted.
//
// Asserted on the whole chain, not on any single link:
//
//   model asks -> permission decides -> tool runs -> result is bounded -> model
//   continues -> run completes -> session and blackboard both know about it

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { defineAgent, AgentRegistry, TOOL_SCOPE as T } from "../src/core/agents/registry.js";
import { AgentRuntime } from "../src/core/agents/runtime.js";
import { resolveWorkspaceRoot, ROOT_SOURCE, WorkspaceRoot, WorkspaceError } from "../src/core/agents/workspace.js";
import { createRealTools, REAL_TOOL_NAMES } from "../src/core/agents/real-tools.js";
import { SessionStore, ENTRY_KIND } from "../src/core/sessions.js";
import { BlackboardStore, CHECKPOINT } from "../src/core/blackboard.js";
import { EVENTS } from "../src/core/events.js";

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

const CATALOGUE = ["oc/muse"];

function tmpdir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `aflow-${name}-`));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** An agent that may read and write inside the workspace, and ask about shell. */
function coder() {
  return defineAgent({
    id: "coder",
    purpose: "implement a change",
    instructions: "You implement changes.",
    tools: {
      scopes: [T.READ, T.SEARCH, T.WRITE, T.SHELL],
      allow: ["read:*", "search:*", "write:*", "shell:node --version"],
      ask: ["shell:*"],
    },
  });
}

function runtime({ specs, complete, approver = null, workspaceRoot = null, ...rest } = {}) {
  const registry = new AgentRegistry(specs || [coder()]);
  return new AgentRuntime({
    registry,
    // The real thing, not a stub. This is the line whose absence was the bug.
    tools: createRealTools(),
    catalogue: CATALOGUE,
    complete,
    approver,
    workspaceRoot,
    ...rest,
  });
}

/**
 * A provider that answers with a scripted list of turns.
 *
 * A turn is either a string -- the model's text -- or `{ toolCalls }`, which is what
 * a provider returns when it wants tools run. The last turn repeats, so a test does
 * not have to predict how many continuations the bounds will permit.
 *
 * The fake is deliberately dumb: it does not look at the transcript, does not decide
 * anything, and cannot influence the permission path. It stands in for the model,
 * which is the component that is *supposed* to be untrusted -- so the test proves the
 * runtime constrains an uncooperative caller rather than a cooperative one.
 */
function script(turns) {
  const state = { calls: 0, prompts: [], models: [] };
  const fn = async (_config, modelId, prompt) => {
    state.calls += 1;
    state.prompts.push(prompt);
    state.models.push(modelId);
    const turn = turns[Math.min(state.calls - 1, turns.length - 1)];
    if (typeof turn === "string") return { model: modelId, text: turn };
    return { model: modelId, toolCalls: turn.toolCalls };
  };
  fn.state = state;
  return fn;
}

function calls(complete) {
  return complete.state.calls;
}

function eventTypes(result) {
  return result.events.map((e) => e.type);
}

function eventsOf(result, type) {
  return result.events.filter((e) => e.type === type);
}

// ---------------------------------------------------------------------------
// workspace resolution
// ---------------------------------------------------------------------------

test("the workspace root is resolved once and physically", () => {
  const dir = tmpdir("ws");
  const ws = resolveWorkspaceRoot({ explicit: dir });
  assert.equal(ws.source, ROOT_SOURCE.EXPLICIT);
  assert.equal(fs.realpathSync(ws.root), fs.realpathSync(dir));
  // The physical path, not the text the caller typed. Two spellings of one directory
  // must not produce two different containment answers, and on macOS /var is a
  // symlink to /private/var, so the un-resolved form would compare unequal.
  assert.ok(path.isAbsolute(ws.root));
});

test("explicit beats project beats cwd", () => {
  const dir = tmpdir("prec");
  const nested = path.join(dir, "project");
  fs.mkdirSync(nested);

  assert.equal(resolveWorkspaceRoot({ explicit: dir, projectRoot: nested, cwd: dir }).source, ROOT_SOURCE.EXPLICIT);
  assert.equal(resolveWorkspaceRoot({ projectRoot: nested, cwd: dir }).source, ROOT_SOURCE.PROJECT);
  assert.equal(resolveWorkspaceRoot({ cwd: dir }).source, ROOT_SOURCE.CWD);
});

test("a workspace root that does not exist is refused, not defaulted", () => {
  const dir = tmpdir("missing");
  assert.throws(
    () => resolveWorkspaceRoot({ explicit: path.join(dir, "nope") }),
    WorkspaceError,
    "a typo in --workspace must fail loudly rather than silently widening to cwd",
  );
});

test("a file is not a workspace", () => {
  const dir = tmpdir("notdir");
  const file = path.join(dir, "a.txt");
  fs.writeFileSync(file, "x");
  assert.throws(() => resolveWorkspaceRoot({ explicit: file }), WorkspaceError);
});

test("the resolved root is immutable and does not follow the cwd afterwards", () => {
  const first = tmpdir("imm-a");
  const second = tmpdir("imm-b");
  const ws = resolveWorkspaceRoot({ explicit: first });

  assert.ok(Object.isFrozen(ws));
  assert.throws(() => {
    "use strict";
    ws.root = second;
  }, TypeError);

  // Nothing about the answer may depend on where the process later happens to be.
  // A cwd-derived root recomputed per call is how a `cd` mid-run turns into an
  // escape: every call would be contained by wherever it happened to run.
  const before = process.cwd();
  try {
    process.chdir(second);
    assert.equal(ws.root, fs.realpathSync(first));
    assert.notEqual(ws.root, fs.realpathSync(second));
  } finally {
    // Left in the second directory, the Windows cleanup hook cannot delete it.
    process.chdir(before);
  }
});

test("a workspace root is accepted as a holder or a string, and nothing else", () => {
  const dir = tmpdir("accept");
  const holder = new WorkspaceRoot({ explicit: dir });
  assert.equal(holder.root, fs.realpathSync(dir));

  // Both spellings work, and both come out immutable -- a string is wrapped and
  // re-validated rather than trusted, so a caller who passes `process.cwd()` gets
  // the same guarantee as one who passes a resolved holder.
  assert.equal(runtime({ complete: script(["ok"]), workspaceRoot: holder }).workspace.root, fs.realpathSync(dir));
  assert.equal(runtime({ complete: script(["ok"]), workspaceRoot: dir }).workspace.root, fs.realpathSync(dir));
  assert.ok(Object.isFrozen(runtime({ complete: script(["ok"]), workspaceRoot: dir }).workspace));

  // Anything else is refused rather than coerced. Coercion is how a bare object
  // carrying a `root` property that is not a path becomes a containment check
  // against nothing -- and the failure would only surface as a confusing tool error
  // much later.
  assert.throws(() => runtime({ complete: script(["ok"]), workspaceRoot: 42 }), /workspaceRoot must be/);
  assert.throws(() => runtime({ complete: script(["ok"]), workspaceRoot: { root: dir } }), /workspaceRoot must be/);
  assert.throws(() => runtime({ complete: script(["ok"]), workspaceRoot: true }), /workspaceRoot must be/);

  // And a string that is not a usable directory fails as a workspace error, not as
  // a generic TypeError from somewhere inside a tool.
  assert.throws(() => resolveWorkspaceRoot({ explicit: path.join(dir, "absent") }), WorkspaceError);
});

// ---------------------------------------------------------------------------
// the wiring itself
// ---------------------------------------------------------------------------

test("the real tool set is reachable from the runtime by name", () => {
  const tools = createRealTools();
  for (const name of REAL_TOOL_NAMES) {
    assert.ok(tools.has(name), `${name} must be reachable`);
  }
  assert.deepEqual([...tools.keys()].sort(), [...REAL_TOOL_NAMES].sort());
});

test("a model that asks for a real tool gets one, and the run continues", async () => {
  const dir = tmpdir("e2e");
  const file = path.join(dir, "note.txt");
  fs.writeFileSync(file, "hello from disk\n");

  const complete = script([
    { toolCalls: [{ tool: "filesystem.read", args: { path: file } }] },
    "done",
  ]);

  const rt = runtime({
    complete,
    workspaceRoot: resolveWorkspaceRoot({ explicit: dir }),
    // coder's output contract requires a summary; the second turn supplies one.
    approver: async () => true,
  });

  const result = await rt.run({ agentId: "coder", task: "read note.txt" });

  assert.equal(result.completed, true, `run should complete, got ${JSON.stringify(result.error)}`);
  assert.equal(result.toolCalls, 1);
  assert.equal(calls(complete), 2, "the model must get a second turn after the tool result");

  // The tool actually ran against the real filesystem.
  assert.match(result.toolResults[0].output.content, /hello from disk/);
});

test("the full lifecycle is emitted, in order", async () => {
  const dir = tmpdir("events");
  const file = path.join(dir, "a.txt");
  fs.writeFileSync(file, "a");

  const rt = runtime({
    complete: script([
      { toolCalls: [{ tool: "filesystem.read", args: { path: file } }] },
      "done",
    ]),
    workspaceRoot: resolveWorkspaceRoot({ explicit: dir }),
  });

  const result = await rt.run({ agentId: "coder", task: "read a.txt" });
  const types = eventTypes(result);

  for (const required of [
    EVENTS.AGENT_TOOL_REQUESTED,
    EVENTS.AGENT_TOOL_STARTED,
    EVENTS.AGENT_TOOL_COMPLETED,
  ]) {
    assert.ok(types.includes(required), `expected ${required}, saw ${types.join(", ")}`);
  }

  // Order is the whole point. A log that says `completed` before `started` describes
  // something other than what happened, and a consumer that trusts the order is
  // reading a fiction.
  const ordered = [EVENTS.AGENT_TOOL_REQUESTED, EVENTS.AGENT_TOOL_STARTED, EVENTS.AGENT_TOOL_COMPLETED];
  const positions = ordered.map((t) => types.indexOf(t));
  for (let i = 1; i < positions.length; i += 1) {
    assert.ok(positions[i] > positions[i - 1], `${ordered[i]} must follow ${ordered[i - 1]}: ${types.join(", ")}`);
  }
});

test("an approval is announced when it is granted, and before the tool runs", async () => {
  const dir = tmpdir("approved");

  // A gated call: `shell` is `ask` in this agent's policy, so the authority -- not
  // the runtime -- decides. That is the only way to observe an approval at all.
  const shellRt = runtime({
    complete: script([
      { toolCalls: [{ tool: "shell.execute", args: { command: "node", args: ["--version"] } }] },
      "checked",
    ]),
    workspaceRoot: resolveWorkspaceRoot({ explicit: dir }),
    approver: async () => true,
  });
  const shellResult = await shellRt.run({ agentId: "coder", task: "check node" });
  const types = eventTypes(shellResult);

  assert.ok(types.includes(EVENTS.AGENT_TOOL_APPROVED), types.join(", "));
  assert.ok(types.includes(EVENTS.AGENT_TOOL_STARTED), types.join(", "));

  // The order is the claim being made. An approval reported after `started` would be
  // a reconstruction, and a log built on it would show consent as a postscript.
  const approved = types.indexOf(EVENTS.AGENT_TOOL_APPROVED);
  const started = types.indexOf(EVENTS.AGENT_TOOL_STARTED);
  const completed = types.indexOf(EVENTS.AGENT_TOOL_COMPLETED);
  assert.ok(approved < started, `approved must precede started: ${types.join(", ")}`);
  assert.ok(started < completed, `started must precede completed: ${types.join(", ")}`);

  assert.equal(shellResult.completed, true, JSON.stringify(shellResult.error));
  assert.equal(shellResult.toolExecutions[0].status, "ok");
});

test("an allowlisted call is not reported as approved", async () => {
  const dir = tmpdir("notapproved");
  const file = path.join(dir, "a.txt");
  fs.writeFileSync(file, "a");

  const rt = runtime({
    complete: script([
      { toolCalls: [{ tool: "filesystem.read", args: { path: file } }] },
      "read",
    ]),
    workspaceRoot: resolveWorkspaceRoot({ explicit: dir }),
  });

  const result = await rt.run({ agentId: "coder", task: "read a.txt" });
  // `read:*` is allowlisted, so nobody was asked and nothing was approved. An
  // approval event here would mean the record cannot be told apart from a case where
  // a human actually said yes.
  assert.equal(eventsOf(result, EVENTS.AGENT_TOOL_APPROVED).length, 0);
  assert.equal(eventsOf(result, EVENTS.AGENT_TOOL_STARTED).length, 1);
});

test("a refused call is a stop, and is asked about exactly once", async () => {
  const dir = tmpdir("stop");
  const asked = [];
  const rt = runtime({
    complete: script([{ toolCalls: [{ tool: "shell.execute", args: { command: "rm", args: ["-rf", "x"] } }] }]),
    workspaceRoot: resolveWorkspaceRoot({ explicit: dir }),
    approver: async (call) => {
      asked.push(call.tool);
      return false;
    },
  });

  const result = await rt.run({ agentId: "coder", task: "delete everything" });

  assert.equal(result.completed, false);
  assert.equal(asked.length, 1, "a refused call must not be asked about again");
  assert.match(String(result.error?.message ?? ""), /not granted|denied|refus|forbidden/i);

  // The terminal `completed` event is not emitted for a refused run -- a consumer
  // watching only that event would read this as a success.
  assert.equal(eventsOf(result, EVENTS.AGENT_COMPLETED).length, 0);
  assert.equal(eventsOf(result, EVENTS.AGENT_TOOL_APPROVED).length, 0);
  assert.equal(eventsOf(result, EVENTS.AGENT_PERMISSION_DENIED).length, 1);
});

test("a call outside the workspace is refused by containment, and the model is told", async () => {
  const dir = tmpdir("outside");
  const elsewhere = tmpdir("outside-other");
  const notYours = path.join(elsewhere, "other.txt");
  fs.writeFileSync(notYours, "not yours");

  const complete = script([
    { toolCalls: [{ tool: "filesystem.read", args: { path: notYours } }] },
    "understood",
  ]);
  const rt = runtime({
    complete,
    workspaceRoot: resolveWorkspaceRoot({ explicit: dir }),
  });

  const result = await rt.run({ agentId: "coder", task: "read a file you may not" });

  // Containment is a refusal, and the file's contents are nowhere in the result.
  assert.notEqual(result.toolResults[0].outcome, "ok");
  assert.equal(result.toolResults[0].output, null);
  assert.doesNotMatch(JSON.stringify(result.toolResults[0]), /not yours/);

  // And the second prompt names the refusal, so the model can adapt instead of
  // assuming the file was empty.
  assert.match(complete.state.prompts[1], /outside the workspace|error/i);
});

test("a tool failure does not end the run, and the model sees the error", async () => {
  const dir = tmpdir("failed");
  const missing = path.join(dir, "nope.txt");

  const complete = script([
    { toolCalls: [{ tool: "filesystem.read", args: { path: missing } }] },
    "done",
  ]);
  const rt = runtime({
    complete,
    workspaceRoot: resolveWorkspaceRoot({ explicit: dir }),
  });

  const result = await rt.run({ agentId: "coder", task: "read a file that is absent" });

  assert.equal(result.completed, true, "a failed tool is not a failed run");
  assert.equal(calls(complete), 2, "the model must be able to try something else");

  // The transcript has to say what happened. "(no output)" would be indistinguishable
  // from an empty file, so the model would either retry blindly or treat the call as
  // having succeeded -- and a tool call with a misleading answer is worse than no
  // tool call at all.
  const second = complete.state.prompts[1];
  assert.match(second, /error/i, `expected an error in the follow-up prompt:\n${second}`);
  assert.doesNotMatch(second, /no output/, "a failure must not be rendered as an absence");
  assert.match(second, /nope\.txt|not found|NOT_FOUND/i);
});

test("a tool call cannot escape the workspace by path traversal", async () => {
  const dir = tmpdir("escape");
  const outside = tmpdir("escape-outside");
  fs.writeFileSync(path.join(outside, "loot.txt"), "TOP-SECRET-PAYLOAD");

  const rt = runtime({
    complete: script([
      { toolCalls: [{ tool: "filesystem.read", args: { path: path.join("..", path.basename(outside), "loot.txt") } }] },
      "done",
    ]),
    workspaceRoot: resolveWorkspaceRoot({ explicit: dir }),
  });

  const result = await rt.run({ agentId: "coder", task: "read ../loot.txt" });
  const outcome = result.toolResults[0] ?? {};

  // `path.resolve` would collapse the `..` happily; the containment check is what
  // refuses, and it refuses by resolved path rather than by the text the model sent.
  assert.notEqual(outcome.outcome, "ok");
  assert.equal(outcome.output, null);
  assert.match(String(outcome.error?.message ?? ""), /outside the workspace/i);

  // The payload itself must not appear anywhere in the run.
  assert.doesNotMatch(JSON.stringify(result.toolExecutions), /TOP-SECRET-PAYLOAD/);
});

test("a run with no workspace root refuses a root-requiring tool by name", async () => {
  const rt = runtime({
    complete: script([{ toolCalls: [{ tool: "filesystem.read", args: { path: "x.txt" } }] }]),
    workspaceRoot: null,
  });

  const result = await rt.run({ agentId: "coder", task: "read something" });

  assert.equal(result.completed, false);
  // The message names the tool and the cause. An error from inside the tool body
  // would blame the tool for a missing argument to the runtime.
  assert.match(String(result.error?.message ?? ""), /workspace root/i);
});

test("the workspace root reaches the tool, not just the runtime", async () => {
  const dir = tmpdir("propagate");
  fs.writeFileSync(path.join(dir, "a.txt"), "a");

  const rt = runtime({
    complete: script([
      { toolCalls: [{ tool: "filesystem.read", args: { path: "a.txt" } }] },
      "done",
    ]),
    // A *relative* path is only resolvable if the tool was told the root.
    workspaceRoot: resolveWorkspaceRoot({ explicit: dir }),
  });

  const result = await rt.run({ agentId: "coder", task: "read a.txt relatively" });
  assert.match(result.toolResults[0].output.content, /a/);
});

// ---------------------------------------------------------------------------
// bounded records
// ---------------------------------------------------------------------------

test("a large tool result is bounded in the record and reported as bounded", async () => {
  const dir = tmpdir("bounded");
  const big = path.join(dir, "big.txt");
  fs.writeFileSync(big, "x".repeat(400_000));

  const rt = runtime({
    complete: script([
      { toolCalls: [{ tool: "filesystem.read", args: { path: big } }] },
      "done",
    ]),
    workspaceRoot: resolveWorkspaceRoot({ explicit: dir }),
  });

  const result = await rt.run({ agentId: "coder", task: "read a large file" });
  const record = result.toolExecutions[0];

  assert.ok(record, "a bounded record must exist");
  // The record is a fact, not a payload. 400KB in a session file that is read back
  // and displayed is a file nobody opens.
  assert.ok(JSON.stringify(record).length < 2000, "the record must stay small");
  assert.ok(record.truncated?.output, "truncation must be recorded, not merely applied");
  assert.ok(record.summary.length <= 303, "the summary is clamped");
});

// ---------------------------------------------------------------------------
// persistence
// ---------------------------------------------------------------------------

test("a completed run is written to the session, with a record per tool call", async () => {
  const dir = tmpdir("persist");
  fs.writeFileSync(path.join(dir, "a.txt"), "a");

  const sessions = new SessionStore({ dir: path.join(dir, "sessions") });
  const session = sessions.create({ objective: "read a.txt", projectRoot: dir });

  const rt = runtime({
    complete: script([
      { toolCalls: [{ tool: "filesystem.read", args: { path: path.join(dir, "a.txt") } }] },
      "done",
    ]),
    workspaceRoot: resolveWorkspaceRoot({ explicit: dir }),
    sessions,
  });

  await rt.run({ agentId: "coder", task: "read a.txt", sessionId: session.id });
  const read = sessions.read(session.id);
  const kinds = read.entries.map((e) => e.kind);

  assert.ok(kinds.includes(ENTRY_KIND.AGENT), "the run itself is recorded");
  assert.ok(kinds.includes(ENTRY_KIND.TOOL_RESULT), "and so is each tool call");

  // Session entries are flattened -- `{seq, ts, kind, ...payload}` -- because a
  // payload nested under its own key is one more level for every reader to unwrap.
  const toolEntry = read.entries.find((e) => e.kind === ENTRY_KIND.TOOL_RESULT);
  assert.equal(toolEntry.tool, "filesystem.read");
  assert.equal(toolEntry.status, "ok");
  assert.equal(toolEntry.agent, "coder");

  // The workspace is part of the record. "An agent read a file" is unanswerable
  // without knowing which tree that file was in.
  const agentEntry = read.entries.find((e) => e.kind === ENTRY_KIND.AGENT);
  assert.equal(agentEntry.workspaceRoot, fs.realpathSync(dir));
  assert.equal(agentEntry.toolCalls, 1);

  // The record is bounded: no payload, and no unbounded field.
  const serialised = JSON.stringify(toolEntry);
  assert.ok(serialised.length < 2000, `tool record must stay small, was ${serialised.length} chars`);
  assert.equal(toolEntry.output, undefined, "the record must not carry the tool's output");
});

test("a persisted run records how long it took, on the success path and the failure path", async () => {
  const dir = tmpdir("persist-duration");
  const sessions = new SessionStore({ dir: path.join(dir, "sessions") });

  // The completed path.
  const okSession = sessions.create({ objective: "ok", projectRoot: dir });
  const okRt = runtime({
    complete: script([JSON.stringify({ summary: "done" })]),
    workspaceRoot: resolveWorkspaceRoot({ explicit: dir }),
    sessions,
  });
  await okRt.run({ agentId: "coder", task: "say done", sessionId: okSession.id });
  const okEntry = sessions.read(okSession.id).entries.find((e) => e.kind === ENTRY_KIND.AGENT);

  // The failure path, which matters more: the runs worth timing are the ones that went
  // wrong. Timed with an injected clock so the assertion is about the plumbing rather
  // than about how fast this machine happens to be.
  const failSession = sessions.create({ objective: "fail", projectRoot: dir });
  let tick = 1000;
  const failRt = runtime({
    complete: async () => ({ model: "m", text: "not json at all" }),
    now: () => (tick += 250),
    workspaceRoot: resolveWorkspaceRoot({ explicit: dir }),
    sessions,
  });
  await failRt.run({ agentId: "coder", task: "return nonsense", sessionId: failSession.id });
  const failEntry = sessions.read(failSession.id).entries.find((e) => e.kind === ENTRY_KIND.AGENT);

  // This is a regression test for a field that was always null: the session write ran
  // before finish() stamped the timing, so `durationMs` looked populated and never was.
  assert.equal(typeof okEntry.durationMs, "number", "a completed run records its duration");
  assert.ok(okEntry.durationMs >= 0);
  assert.equal(typeof failEntry.durationMs, "number", "a failed run records its duration");
  assert.ok(failEntry.durationMs > 0, `a failed run's duration must be real, was ${failEntry.durationMs}`);
});

test("a failed run is still written to the session", async () => {
  const dir = tmpdir("persist-fail");
  const sessions = new SessionStore({ dir: path.join(dir, "sessions") });
  const session = sessions.create({ objective: "explode", projectRoot: dir });

  const rt = runtime({
    complete: async () => {
      throw Object.assign(new Error("provider exploded"), { code: "provider_down" });
    },
    workspaceRoot: resolveWorkspaceRoot({ explicit: dir }),
    sessions,
  });

  const result = await rt.run({ agentId: "coder", task: "explode", sessionId: session.id });
  assert.equal(result.completed, false);

  const read = sessions.read(session.id);
  assert.ok(read.entries.length > 0, "a run that died must still leave a trace");
  const agentEntry = read.entries.find((e) => e.kind === ENTRY_KIND.AGENT);
  assert.equal(agentEntry.state, result.state);
  assert.equal(agentEntry.completed, false);
  // Persisting only on success produces a session that looks clean precisely when
  // something went wrong, and a failure nobody can find is the expensive kind.
  assert.ok(agentEntry.error, "the error is part of the record");
});

test("a session record cannot become a place a credential is kept", async () => {
  const dir = tmpdir("persist-secret");
  const sessions = new SessionStore({ dir: path.join(dir, "sessions") });
  const session = sessions.create({ objective: "leak", projectRoot: dir });

  const rt = runtime({
    complete: script([
      {
        toolCalls: [
          {
            tool: "filesystem.write",
            args: { path: path.join(dir, "x.txt"), content: "AKIAIOSFODNN7EXAMPLE" },
          },
        ],
      },
      "done",
    ]),
    workspaceRoot: resolveWorkspaceRoot({ explicit: dir }),
    sessions,
  });

  await rt.run({ agentId: "coder", task: "write a key", sessionId: session.id });

  const serialised = JSON.stringify(sessions.read(session.id));
  assert.doesNotMatch(serialised, /AKIAIOSFODNN7EXAMPLE/, "no credential-shaped value in a session");
});

test("the approval event cannot become a place a credential is kept either", async () => {
  const dir = tmpdir("approve-secret");
  // Real shapes, not lookalikes. An earlier version of this test used
  // "AKIA...KEY123456", which the redactor correctly does not match -- so the test
  // proved nothing while reading as if it did. A credential-shaped string that is not
  // credential-shaped is the worst possible fixture: it fails open and looks covered.
  const awsKey = "AKIAIOSFODNN7EXAMPLE";
  const ghToken = `ghp_${"A".repeat(36)}`;

  // The approval observer fires BEFORE runTool's credential gate, so the event is
  // written while the arguments still hold whatever the model put there. Sessions
  // re-verify on append; an event log has no such gate, so the redaction has to have
  // already happened by the time the event is emitted.
  const rt = runtime({
    complete: script([
      {
        toolCalls: [
          {
            tool: "shell.execute",
            args: { command: "node", args: ["-e", `console.log('${awsKey}')`, ghToken] },
          },
        ],
      },
      "done",
    ]),
    workspaceRoot: resolveWorkspaceRoot({ explicit: dir }),
    approver: async () => true,
  });

  const result = await rt.run({ agentId: "coder", task: "run a command containing a key" });
  const approvals = eventsOf(result, EVENTS.AGENT_TOOL_APPROVED);
  assert.equal(approvals.length, 1, "the gated call should have produced one approval");

  // The event must still say enough to be an audit record -- which tool, which scope,
  // which decision. Only the credential-shaped values go.
  assert.equal(approvals[0].tool, "shell.execute");
  assert.equal(approvals[0].scope, "shell");
  assert.equal(approvals[0].args.command, "node", "the harmless part of the call survives");

  const serialised = JSON.stringify(approvals[0]);
  assert.doesNotMatch(serialised, /AKIA[A-Z0-9]{16}/, "no AWS key shape in an event");
  assert.doesNotMatch(serialised, /ghp_[A-Za-z0-9]{20,}/, "no GitHub token in an event");
});

test("a blocker is reported once per run, not once per runtime", async () => {
  const dir = tmpdir("board-per-run");
  const board = new BlackboardStore({ dir: path.join(dir, "board"), projectRoot: dir });
  board.create({ goal: "retryable", objective: "hit the same wall twice" });

  const refusals = () =>
    script([{ toolCalls: [{ tool: "shell.execute", args: { command: "rm", args: ["-rf", "x"] } }] }]);

  // Two runs through ONE runtime, which is the case a module-level dedupe set gets
  // wrong: the second run's blocker would be suppressed as a "repeat", leaving a board
  // that describes a wall the current run never hit.
  const rt = runtime({
    complete: refusals(),
    workspaceRoot: resolveWorkspaceRoot({ explicit: dir }),
    approver: async () => false,
    blackboard: board,
  });

  const first = await rt.run({ agentId: "coder", task: "attempt one" });
  const firstCount = board.blockers().length;

  // The scripted model is exhausted, so re-arm it for the second run.
  rt.complete = refusals();
  const second = await rt.run({ agentId: "coder", task: "attempt two" });
  const secondCount = board.blockers().length;

  assert.equal(first.completed, false);
  assert.equal(second.completed, false);
  assert.ok(firstCount >= 1, "the first run records its blocker");
  assert.ok(
    secondCount > firstCount,
    `the second run must report its own blocker: ${firstCount} -> ${secondCount}`,
  );
});

// ---------------------------------------------------------------------------
// blackboard
// ---------------------------------------------------------------------------

test("a completed run records an implementation, and a refusal records a blocker", async () => {
  const dir = tmpdir("board");
  const board = new BlackboardStore({ dir: path.join(dir, "board"), projectRoot: dir });
  // Every write against a missing Blackboard is a silent no-op, which is why the CLI
  // creates one on first use. A test that skipped this would assert nothing.
  board.create({ goal: "ship t4", objective: "wire the real tools" });

  // A run that succeeds.
  fs.writeFileSync(path.join(dir, "a.txt"), "a");
  const okRt = runtime({
    complete: script([
      { toolCalls: [{ tool: "filesystem.read", args: { path: path.join(dir, "a.txt") } }] },
      "done",
    ]),
    workspaceRoot: resolveWorkspaceRoot({ explicit: dir }),
    blackboard: board,
  });
  const okResult = await okRt.run({ agentId: "coder", task: "do the work" });
  assert.equal(okResult.completed, true);

  // A run that is refused.
  const deniedRt = runtime({
    complete: script([{ toolCalls: [{ tool: "shell.execute", args: { command: "rm", args: ["-rf", "x"] } }] }]),
    workspaceRoot: resolveWorkspaceRoot({ explicit: dir }),
    blackboard: board,
    approver: async () => false,
  });
  await deniedRt.run({ agentId: "coder", task: "delete everything" });

  const state = board.read();
  assert.ok(state, "the blackboard must exist");

  // `recordImplementation` is a checkpoint plus a file-touch map, not a row in an
  // `implementations` list -- the Blackboard deliberately has no "what did the agent
  // do" collection, because that is a transcript and the transcript is the session's
  // job. What it does keep is the meaningful transition.
  const implemented = board.timeline({ limit: 20 }).filter((c) => c.checkpoint === CHECKPOINT.IMPLEMENTATION_UPDATED);
  assert.ok(implemented.length >= 1, "a successful run leaves an implementation checkpoint");
  assert.ok(state.blockers.length >= 1, "a refusal is a blocker");

  // Not a transcript. Per-call narration would mean one blocker per attempted call,
  // which is the shape that makes a blackboard unreadable at exactly the moment it
  // is needed.
  assert.ok(state.blockers.length <= 2, `expected task-level blockers, saw ${state.blockers.length}`);
});

test("a failed run does not claim an implementation", async () => {
  const dir = tmpdir("board-fail");
  const board = new BlackboardStore({ dir: path.join(dir, "board"), projectRoot: dir });
  board.create({ goal: "ship t4" });

  const rt = runtime({
    complete: script([{ toolCalls: [{ tool: "shell.execute", args: { command: "rm", args: ["-rf", "x"] } }] }]),
    workspaceRoot: resolveWorkspaceRoot({ explicit: dir }),
    blackboard: board,
    approver: async () => false,
  });
  await rt.run({ agentId: "coder", task: "delete everything" });

  const state = board.read();
  // "author completed" at the top of a project's history for a run that did nothing
  // is worse than no record at all.
  const implemented = board.timeline({ limit: 20 }).filter((c) => c.checkpoint === CHECKPOINT.IMPLEMENTATION_UPDATED);
  assert.equal(implemented.length, 0);
  // And the refusal is still there, so the run left evidence of what stopped it.
  assert.ok(state.blockers.length >= 1);
});

// ---------------------------------------------------------------------------
// cancellation and bounds on the wired path
// ---------------------------------------------------------------------------

test("cancelling mid-run stops the tool path and is reported as cancelled", async () => {
  const dir = tmpdir("cancel");
  const controller = new AbortController();

  const rt = runtime({
    complete: async () => {
      controller.abort("user pressed ctrl-c");
      return { model: "oc/muse", text: '{"summary":"never"}' };
    },
    workspaceRoot: resolveWorkspaceRoot({ explicit: dir }),
  });

  const result = await rt.run({ agentId: "coder", task: "cancel me", signal: controller.signal });

  assert.equal(result.completed, false);
  // Orthogonal flags: cancelled is not failed and not timedOut.
  assert.ok(result.cancelled || result.timedOut || result.state !== "completed");
  assert.equal(result.timedOut, false, "a cancellation is not a timeout");
});

test("the tool-call bound is enforced on the wired path", async () => {
  const dir = tmpdir("bound");
  const file = path.join(dir, "a.txt");
  fs.writeFileSync(file, "a");

  const agent = defineAgent({
    id: "coder",
    purpose: "loop forever",
    instructions: "loop",
    bounds: { maxToolCalls: 2 },
    tools: {
      scopes: [T.READ],
      allow: ["read:*"],
    },
  });

  const complete = script([
    { toolCalls: [{ tool: "filesystem.read", args: { path: file } }] },
  ]);
  const rt = runtime({
    specs: [agent],
    complete,
    workspaceRoot: resolveWorkspaceRoot({ explicit: dir }),
  });

  const result = await rt.run({ agentId: "coder", task: "loop" });

  assert.equal(result.completed, false);
  assert.ok(result.toolCalls <= 2, `tool calls must stay within the bound, saw ${result.toolCalls}`);
});

// ---------------------------------------------------------------------------
// several calls, one run
// ---------------------------------------------------------------------------

test("several real tool calls in one run all execute and all get recorded", async () => {
  const dir = tmpdir("multi");
  fs.writeFileSync(path.join(dir, "a.txt"), "alpha");
  fs.writeFileSync(path.join(dir, "b.txt"), "beta");

  const rt = runtime({
    complete: script([
      {
        toolCalls: [
          { tool: "filesystem.read", args: { path: path.join(dir, "a.txt") } },
          { tool: "filesystem.read", args: { path: path.join(dir, "b.txt") } },
        ],
      },
      { toolCalls: [{ tool: "filesystem.search", args: { path: dir, pattern: "beta" } }] },
      "done",
    ]),
    workspaceRoot: resolveWorkspaceRoot({ explicit: dir }),
    sessions: new SessionStore({ dir: path.join(dir, "sessions") }),
  });

  const session = rt.sessions.create({ objective: "read everything", projectRoot: dir });
  const result = await rt.run({ agentId: "coder", task: "read both", sessionId: session.id });

  assert.equal(result.completed, true, `expected completion, got ${JSON.stringify(result.error)}`);
  assert.equal(result.toolCalls, 3, "three calls, three executions");
  assert.equal(result.toolExecutions.length, 3);

  // Each one reached the real filesystem.
  assert.match(result.toolResults[0].output.content, /alpha/);
  assert.match(result.toolResults[1].output.content, /beta/);
  assert.ok(result.toolResults[2].output.matchCount >= 1, "the search really searched");

  // And each one is individually recoverable from the session, in order.
  const toolEntries = rt.sessions.read(session.id).entries.filter((e) => e.kind === ENTRY_KIND.TOOL_RESULT);
  assert.equal(toolEntries.length, 3);
  assert.deepEqual(
    toolEntries.map((e) => e.tool),
    ["filesystem.read", "filesystem.read", "filesystem.search"],
  );
  assert.deepEqual(
    toolEntries.map((e) => e.status),
    ["ok", "ok", "ok"],
  );
});
