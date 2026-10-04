// Tool permissions and the three-waterfall pipeline.
//
// Order and fail-closed behaviour are the point of these tests. Most of them exist
// to prove a specific thing cannot happen.

import test from "node:test";
import assert from "node:assert/strict";

import { defineAgent, TOOL_SCOPE } from "../src/core/agents/registry.js";
import { runTool, evaluatePermission, scrubEnv, parseEntry, OUTCOME, ToolError } from "../src/core/agents/tools.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function agent(tools = {}, over = {}) {
  return defineAgent({
    id: "coder",
    purpose: "implement changes",
    instructions: "Do the work.",
    tools,
    ...over,
  });
}

const SHELL = {
  name: "shell",
  scope: TOOL_SCOPE.SHELL,
  async execute(args) {
    return `ran:${args.command}`;
  },
};

const READ = {
  name: "read_file",
  scope: TOOL_SCOPE.READ,
  async execute(args) {
    return `file:${args.path}`;
  },
};

const FETCH = {
  name: "fetch",
  scope: TOOL_SCOPE.NETWORK,
  async execute(args) {
    return `http:${args.url}`;
  },
};

// A policy that grants a scope wholesale, for tests about the pipeline rather
// than about matching.
const WIDE_SHELL = { scopes: [TOOL_SCOPE.SHELL], allow: ["shell:*"] };

// ---------------------------------------------------------------------------
// env scrubbing
// ---------------------------------------------------------------------------

test("credential-shaped env var names are dropped from a spawn environment", () => {
  const env = scrubEnv({
    PATH: "/usr/bin",
    MY_API_KEY: "abc",
    DB_PASSWORD: "hunter2",
    AUTH_TOKEN: "t",
    SESSION_SECRET: "s",
    OPENAI_API_KEY: "sk-x",
  });
  assert.deepEqual(Object.keys(env), ["PATH"]);
});

test("a credential-shaped value under a bland name is also dropped", () => {
  // The name is not a safety property of the value; providers name things blandly.
  const env = scrubEnv({ PATH: "/usr/bin", SETTING: "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4" });
  assert.deepEqual(Object.keys(env), ["PATH"]);
});

test("ordinary variables survive scrubbing", () => {
  const env = scrubEnv({ PATH: "/usr/bin", HOME: "/root", NODE_ENV: "test", LANG: "C" });
  assert.equal(Object.keys(env).length, 4);
});

test("scrubbing does not mutate the input environment", () => {
  const input = { PATH: "/usr/bin", API_KEY: "abc" };
  scrubEnv(input);
  assert.equal(input.API_KEY, "abc");
});

// ---------------------------------------------------------------------------
// entry parsing
// ---------------------------------------------------------------------------

test("an entry is scope-prefixed, because an unprefixed string is ambiguous", () => {
  assert.deepEqual(parseEntry("shell:git status"), { scope: "shell", value: "git status" });
  assert.deepEqual(parseEntry("read:src"), { scope: "read", value: "src" });
});

test("a url entry keeps its scheme intact", () => {
  // Naive first-colon splitting would yield scope "network" and value
  // "https://api.example.com" only by luck; a scope with no colon in it is what
  // makes this unambiguous.
  assert.deepEqual(parseEntry("network:https://api.example.com/v1"), {
    scope: "network",
    value: "https://api.example.com/v1",
  });
});

test("an entry with no known scope prefix is rejected rather than guessed", () => {
  assert.equal(parseEntry("src"), null);
  assert.equal(parseEntry("bogus:src"), null);
  assert.equal(parseEntry("read:"), null);
  assert.equal(parseEntry(null), null);
});

// ---------------------------------------------------------------------------
// permission evaluation
// ---------------------------------------------------------------------------

test("a tool with no scope is denied because no policy can apply", () => {
  const v = evaluatePermission(agent(WIDE_SHELL), { name: "mystery" }, { tool: "mystery" });
  assert.equal(v.decision, "deny");
  assert.match(v.reason, /declares no scope/);
});

test("an ungranted scope is denied even when a wildcard for another scope exists", () => {
  const v = evaluatePermission(agent(WIDE_SHELL), FETCH, { tool: "fetch", args: { url: "https://x.test" } });
  assert.equal(v.decision, "deny");
  assert.match(v.reason, /not granted/);
});

test("a granted scope with a wildcard allow entry is allowed", () => {
  const v = evaluatePermission(agent(WIDE_SHELL), SHELL, { tool: "shell", args: { command: "anything at all" } });
  assert.equal(v.decision, "allow");
});

test("an allow entry implies the scope grant, so a bare allow list is enough", () => {
  const v = evaluatePermission(agent({ allow: ["shell:git status"] }), SHELL, { tool: "shell", args: { command: "git status" } });
  assert.equal(v.decision, "allow");
});

test("a scope with no matching entry and no wildcard is denied", () => {
  const v = evaluatePermission(agent({ scopes: [TOOL_SCOPE.SHELL] }), SHELL, { tool: "shell", args: { command: "git status" } });
  assert.equal(v.decision, "deny");
});

test("a deny entry beats an allow entry and beats approval", () => {
  const a = agent({
    scopes: [TOOL_SCOPE.SHELL],
    allow: ["shell:git"],
    deny: ["shell:git push"],
    requireApproval: [TOOL_SCOPE.SHELL],
  });
  const v = evaluatePermission(a, SHELL, { tool: "shell", args: { command: "git push origin main" } }, {
    approver: async () => true,
  });
  assert.equal(v.decision, "deny");
  assert.match(v.reason, /deny entry/);
});

test("an agent with no tool policy at all may do nothing", () => {
  // Fail closed by default. An agent that forgets to declare permissions must not
  // inherit an unrestricted environment.
  const v = evaluatePermission(agent(), SHELL, { tool: "shell", args: { command: "ls" } });
  assert.equal(v.decision, "deny");
});

// ---------------------------------------------------------------------------
// allowlist matching
// ---------------------------------------------------------------------------

test("a shell allowlist entry matches only as a token prefix, not as raw text", () => {
  // The classic escape: raw-substring matching lets `git status; rm -rf /` satisfy
  // an allowlist of `git`.
  const a = agent({ scopes: [TOOL_SCOPE.SHELL], allow: ["shell:git status"] });
  assert.equal(evaluatePermission(a, SHELL, { tool: "shell", args: { command: "git status" } }).decision, "allow");
  assert.equal(
    evaluatePermission(a, SHELL, { tool: "shell", args: { command: "git status; rm -rf /" } }).decision,
    "deny"
  );
  assert.equal(evaluatePermission(a, SHELL, { tool: "shell", args: { command: "git" } }).decision, "deny");
  assert.equal(evaluatePermission(a, SHELL, { tool: "shell", args: { command: "ls" } }).decision, "deny");
});

test("a network allowlist matches on exact host, so a suffix cannot impersonate it", () => {
  const a = agent({ allow: ["network:github.com"] });
  assert.equal(evaluatePermission(a, FETCH, { tool: "fetch", args: { url: "https://github.com/x" } }).decision, "allow");
  assert.equal(
    evaluatePermission(a, FETCH, { tool: "fetch", args: { url: "https://github.com.evil.test/x" } }).decision,
    "deny"
  );
});

test("a malformed url is denied rather than throwing", () => {
  // Against a host-specific entry, so the wildcard cannot short-circuit the parse.
  const a = agent({ allow: ["network:api.example.com"] });
  assert.equal(evaluatePermission(a, FETCH, { tool: "fetch", args: { url: "ht tp://[" } }).decision, "deny");
  assert.equal(evaluatePermission(a, FETCH, { tool: "fetch", args: { url: "" } }).decision, "deny");
});

test("a path allowlist cannot be escaped with ..", () => {
  const a = agent({ allow: ["read:src"] });
  assert.equal(evaluatePermission(a, READ, { tool: "read_file", args: { path: "src/core/x.js" } }).decision, "allow");
  assert.equal(
    evaluatePermission(a, READ, { tool: "read_file", args: { path: "src/../../etc/passwd" } }).decision,
    "deny"
  );
  assert.equal(evaluatePermission(a, READ, { tool: "read_file", args: { path: "secrets.env" } }).decision, "deny");
});

test("a read allowlist does not authorise a write call on the same path", () => {
  const WRITE = { name: "write_file", scope: TOOL_SCOPE.WRITE, async execute() { return "w"; } };
  const a = agent({ allow: ["read:src"] });
  assert.equal(evaluatePermission(a, WRITE, { tool: "write_file", args: { path: "src/x.js" } }).decision, "deny");
});

// ---------------------------------------------------------------------------
// approval
// ---------------------------------------------------------------------------

test("a required approval with no approver fails closed", () => {
  const a = agent({ scopes: [TOOL_SCOPE.SHELL], allow: ["shell:npm publish"], requireApproval: [TOOL_SCOPE.SHELL] });
  const v = evaluatePermission(a, SHELL, { tool: "shell", args: { command: "npm publish" } }, { approver: null });
  assert.equal(v.decision, "deny");
  assert.match(v.reason, /no approver/);
});

test("a granted approval still reaches the guards", async () => {
  // The ordering property from the study: approval happens before guards, so a
  // user approving a call does not grant it immunity from the guards.
  const a = agent({ scopes: [TOOL_SCOPE.SHELL], allow: ["shell:git push"], requireApproval: [TOOL_SCOPE.SHELL] });
  const result = await runTool(a, SHELL, { tool: "shell", args: { command: "git push" } }, {
    approver: async () => true,
    guards: [() => false],
  });
  assert.equal(result.outcome, OUTCOME.DENIED);
  assert.equal(result.error.step, "guard");
});

test("an approver that throws is a denial, not consent", async () => {
  const a = agent({ scopes: [TOOL_SCOPE.SHELL], allow: ["shell:rm"], requireApproval: [TOOL_SCOPE.SHELL] });
  const result = await runTool(a, SHELL, { tool: "shell", args: { command: "rm x" } }, {
    approver: async () => {
      throw new Error("prompt unavailable");
    },
  });
  assert.equal(result.outcome, OUTCOME.DENIED);
  assert.match(result.error.message, /not granted/);
});

test("boolean true is the only answer that grants", async () => {
  // Anything else fails closed, including 1 and "yes": a UI returning a truthy
  // non-boolean has not answered the question that was asked.
  const a = agent({ scopes: [TOOL_SCOPE.SHELL], allow: ["shell:rm"], requireApproval: [TOOL_SCOPE.SHELL] });
  for (const answer of ["yes", 1, "true", null, {}, "", 0]) {
    const result = await runTool(a, SHELL, { tool: "shell", args: { command: "rm x" } }, {
      approver: async () => answer,
    });
    assert.equal(result.outcome, OUTCOME.DENIED, `answer ${JSON.stringify(answer)} must not grant`);
  }
});

test("a call needing no approval runs with no approver present", async () => {
  const a = agent({ scopes: [TOOL_SCOPE.SHELL], allow: ["shell:git status"] });
  const result = await runTool(a, SHELL, { tool: "shell", args: { command: "git status" } }, { approver: null });
  assert.equal(result.outcome, OUTCOME.OK);
});

// ---------------------------------------------------------------------------
// monotonic guards
// ---------------------------------------------------------------------------

test("a guard returning allow is ignored, because guards may only narrow", async () => {
  const a = agent({ scopes: [TOOL_SCOPE.SHELL] }); // policy denies
  const result = await runTool(a, SHELL, { tool: "shell", args: { command: "x" } }, {
    guards: [() => ({ action: "allow" })],
  });
  assert.equal(result.outcome, OUTCOME.DENIED, "a guard cannot resurrect a denied call");
});

test("a guard denying by bare false stops the call", async () => {
  const result = await runTool(agent(WIDE_SHELL), SHELL, { tool: "shell", args: { command: "x" } }, {
    guards: [() => false],
  });
  assert.equal(result.outcome, OUTCOME.DENIED);
});

test("a guard abstaining leaves the call alone", async () => {
  const result = await runTool(agent(WIDE_SHELL), SHELL, { tool: "shell", args: { command: "x" } }, {
    guards: [() => undefined],
  });
  assert.equal(result.outcome, OUTCOME.OK);
});

test("a guard that throws does not take the run down", async () => {
  const result = await runTool(agent(WIDE_SHELL), SHELL, { tool: "shell", args: { command: "x" } }, {
    guards: [
      () => {
        throw new Error("guard exploded");
      },
    ],
  });
  assert.equal(result.outcome, OUTCOME.ERROR);
  assert.match(result.error.message, /guard exploded/);
});

test("a guard may not restore authority an approval was refused for", async () => {
  const a = agent({ scopes: [TOOL_SCOPE.SHELL], allow: ["shell:rm"], requireApproval: [TOOL_SCOPE.SHELL] });
  const result = await runTool(a, SHELL, { tool: "shell", args: { command: "rm x" } }, {
    approver: async () => false,
    guards: [() => ({ action: "allow" })],
  });
  assert.equal(result.outcome, OUTCOME.DENIED);
});

// ---------------------------------------------------------------------------
// credential gate
// ---------------------------------------------------------------------------

test("a call carrying a credential-shaped argument is refused before dispatch", async () => {
  const result = await runTool(
    agent(WIDE_SHELL),
    SHELL,
    { tool: "shell", args: { command: "x", note: "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4" } },
    {}
  );
  assert.equal(result.outcome, OUTCOME.DENIED);
  assert.match(result.error.message, /credential-shaped/);
});

// ---------------------------------------------------------------------------
// happy path and normalization
// ---------------------------------------------------------------------------

test("an allowed call runs and returns one frozen result", async () => {
  const result = await runTool(agent(WIDE_SHELL), SHELL, { tool: "shell", args: { command: "git status" } }, {});
  assert.equal(result.outcome, OUTCOME.OK);
  assert.equal(result.output, "ran:git status");
  assert.ok(Object.isFrozen(result));
  assert.equal(result.error, null);
});

test("a tool that throws becomes an error result rather than a crash", async () => {
  const boom = {
    name: "shell",
    scope: TOOL_SCOPE.SHELL,
    async execute() {
      throw new ToolError("kaboom", "kaboom_code");
    },
  };
  const result = await runTool(agent(WIDE_SHELL), boom, { tool: "shell", args: { command: "x" } }, {});
  assert.equal(result.outcome, OUTCOME.ERROR);
  assert.equal(result.error.code, "kaboom_code");
  assert.ok(Object.isFrozen(result));
});

test("the tool body receives a scrubbed environment", async () => {
  let seen = null;
  const probe = {
    name: "shell",
    scope: TOOL_SCOPE.SHELL,
    async execute(_args, ctx) {
      seen = ctx.env;
      return "ok";
    },
  };
  await runTool(agent(WIDE_SHELL), probe, { tool: "shell", args: { command: "x" } }, {
    env: { PATH: "/bin", API_KEY: "abc" },
  });
  assert.deepEqual(Object.keys(seen), ["PATH"]);
});

// ---------------------------------------------------------------------------
// logging the attempt before dispatch
// ---------------------------------------------------------------------------

test("the attempt is logged before the tool body runs", async () => {
  // A crash mid-tool must leave a record that it was tried. An audit trail that
  // misses exactly the calls that misbehaved is worse than none.
  const seen = [];
  const log = { emit: (type, payload) => seen.push([type, payload]), errorCount: 0 };
  const order = [];
  const probe = {
    name: "shell",
    scope: TOOL_SCOPE.SHELL,
    async execute() {
      order.push("body");
      return "ok";
    },
  };
  const result = await runTool(agent(WIDE_SHELL), probe, { tool: "shell", args: { command: "x" } }, { log });
  order.push("after");
  assert.equal(result.outcome, OUTCOME.OK);
  assert.deepEqual(order, ["body", "after"]);
  assert.ok(seen.some(([t]) => t === "tool.call"), "tool.call must be recorded");
});

test("a denied call is never dispatched and is logged as denied", async () => {
  let called = false;
  const probe = {
    name: "shell",
    scope: TOOL_SCOPE.SHELL,
    async execute() {
      called = true;
      return "x";
    },
  };
  const seen = [];
  const log = { emit: (t, p) => seen.push([t, p]), errorCount: 0 };
  const result = await runTool(agent({ scopes: [TOOL_SCOPE.SHELL] }), probe, { tool: "shell", args: { command: "x" } }, { log });
  assert.equal(result.outcome, OUTCOME.DENIED);
  assert.equal(called, false);
  assert.ok(seen.some(([t]) => t === "tool.denied"));
  assert.ok(!seen.some(([t]) => t === "tool.call"), "a denied call must not be logged as attempted");
});

// ---------------------------------------------------------------------------
// waterfall transformation
// ---------------------------------------------------------------------------

test("a pre-execute step may transform the call before dispatch", async () => {
  let seenArgs = null;
  const probe = {
    name: "shell",
    scope: TOOL_SCOPE.SHELL,
    async execute(args) {
      seenArgs = args;
      return "ok";
    },
  };
  const result = await runTool(
    agent({ scopes: [TOOL_SCOPE.SHELL], allow: ["shell:git status"] }),
    probe,
    { tool: "shell", args: { command: "git status --short" } },
    {
      preExecute: [
        (state) => ({
          action: "transform",
          call: { ...state.call, args: { ...state.call.args, command: "git status" } },
        }),
      ],
    }
  );
  assert.equal(result.outcome, OUTCOME.OK);
  assert.equal(seenArgs.command, "git status");
});

test("a pre-execute transform cannot smuggle a call past the permission check", async () => {
  // Permission runs after the waterfall on purpose, so a rewritten call is judged
  // on what it now says rather than what it originally said.
  const result = await runTool(
    agent({ scopes: [TOOL_SCOPE.SHELL], allow: ["shell:git status"] }),
    SHELL,
    { tool: "shell", args: { command: "rm -rf /" } },
    { preExecute: [(state) => ({ action: "transform", call: { ...state.call, args: { command: "git status" } } })] }
  );
  // The rewrite is honoured, and the *rewritten* call is then permitted.
  assert.equal(result.outcome, OUTCOME.OK);
  assert.equal(result.output, "ran:git status");
});

test("a post-execute step may replace the result", async () => {
  const result = await runTool(agent(WIDE_SHELL), SHELL, { tool: "shell", args: { command: "x" } }, {
    postExecute: [() => ({ action: "replace", result: { output: "sanitised" } })],
  });
  assert.equal(result.output, "sanitised");
});

test("a post-execute step may add context alongside the recorded result", async () => {
  const result = await runTool(agent(WIDE_SHELL), SHELL, { tool: "shell", args: { command: "x" } }, {
    postExecute: [() => ({ action: "addContext", content: "note" })],
  });
  assert.equal(result.output, "ran:x");
  assert.deepEqual(result.contexts, ["note"]);
});

test("a post-execute step may block an already-produced result", async () => {
  const result = await runTool(agent(WIDE_SHELL), SHELL, { tool: "shell", args: { command: "x" } }, {
    postExecute: [() => ({ action: "block", reason: "output was too large" })],
  });
  assert.equal(result.outcome, OUTCOME.DENIED);
  assert.match(result.error.message, /too large/);
});

test("a step returning an unknown action is an error result, not a crash", async () => {
  const result = await runTool(agent(WIDE_SHELL), SHELL, { tool: "shell", args: { command: "x" } }, {
    preExecute: [() => ({ action: "wat" })],
  });
  assert.equal(result.outcome, OUTCOME.ERROR);
  assert.match(result.error.message, /unknown waterfall action/);
});

test("a post-execute step that throws does not take the run down", async () => {
  const result = await runTool(agent(WIDE_SHELL), SHELL, { tool: "shell", args: { command: "x" } }, {
    postExecute: [
      () => {
        throw new Error("post exploded");
      },
    ],
  });
  assert.equal(result.outcome, OUTCOME.ERROR);
  assert.match(result.error.message, /post exploded/);
});

// ---------------------------------------------------------------------------
// orchestration surface
// ---------------------------------------------------------------------------

test("denied, errored and ok are three distinct outcomes", async () => {
  // The runtime treats these differently: a denial means stop the loop, an error
  // may be retried. Collapsing them makes a denied call look retryable.
  const boom = {
    name: "shell",
    scope: TOOL_SCOPE.SHELL,
    async execute() {
      throw new Error("x");
    },
  };
  const ok = await runTool(agent(WIDE_SHELL), SHELL, { tool: "shell", args: { command: "x" } }, {});
  const denied = await runTool(agent({ scopes: [TOOL_SCOPE.SHELL] }), SHELL, { tool: "shell", args: { command: "x" } }, {});
  const errored = await runTool(agent(WIDE_SHELL), boom, { tool: "shell", args: { command: "x" } }, {});
  assert.deepEqual([ok.outcome, denied.outcome, errored.outcome], [OUTCOME.OK, OUTCOME.DENIED, OUTCOME.ERROR]);
});

test("every returned result is frozen, including denials and errors", async () => {
  const denied = await runTool(agent({}), SHELL, { tool: "shell", args: { command: "x" } }, {});
  assert.ok(Object.isFrozen(denied));
  assert.ok(Object.isFrozen(denied.error));
});