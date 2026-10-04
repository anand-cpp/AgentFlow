// Execution context assembly.
//
// Most of these tests exist to prove that truncation is *visible*. Silent clipping
// is the failure mode that matters: an agent reading a partial prompt cannot tell
// it is partial, and answers from the gap confidently.

import test from "node:test";
import assert from "node:assert/strict";

import { defineAgent } from "../src/core/agents/registry.js";
import { buildAgentContext, renderContext, ContextError } from "../src/core/agents/context.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function agent(bounds = {}) {
  return defineAgent({
    id: "coder",
    purpose: "implement changes",
    instructions: "Do the work.",
    bounds: { maxContextChars: 24_000, ...bounds },
  });
}

/** Minimal stand-in for a Blackboard store: `get()`/`summary()` and `require()`. */
function blackboard(summary) {
  const value = summary || {};
  return {
    id: "bb-1",
    get: () => value,
    summary: () => value,
    require: () => value,
  };
}

function emptySummary(extra = {}) {
  return {
    goal: "ship the thing",
    objective: "make it correct",
    nextAction: null,
    inProgress: [],
    openTasks: [],
    activeDecisions: [],
    openBlockers: [],
    openBugs: [],
    openQuestions: [],
    activeAssumptions: [],
    openFindings: [],
    latestTests: [],
    reviews: [],
    files: [],
    commits: [],
    ...extra,
  };
}

test("an agent runs with no blackboard and no session at all", () => {
  // A direct question with no project history must still work.
  const ctx = buildAgentContext({ agent: agent() });
  assert.equal(ctx.blackboardPresent, false);
  assert.equal(ctx.sessionId, null);
  assert.equal(ctx.goal, null);
});

test("goal, objective and next action are carried through", () => {
  const ctx = buildAgentContext({
    agent: agent(),
    blackboard: blackboard(emptySummary({ nextAction: { id: "n1", note: "run tests" } })),
  });
  assert.equal(ctx.goal, "ship the thing");
  assert.equal(ctx.objective, "make it correct");
  assert.deepEqual(ctx.nextAction, { id: "n1", note: "run tests" });
});

test("a missing blackboard is tolerated rather than fatal", () => {
  const store = { get: () => null, summary: () => null };
  const ctx = buildAgentContext({ agent: agent(), blackboard: store });
  assert.equal(ctx.blackboardPresent, false);
});

test("a corrupt blackboard propagates instead of yielding a partial view", () => {
  // Silently continuing past unreadable recorded state would let an agent act on
  // a truncated picture of the work and believe it saw everything. Absence and
  // corruption must not share a path, so this store says it exists and then
  // throws.
  const store = {
    exists: () => true,
    summary: () => {
      throw new Error("blackboard state file is corrupt");
    },
  };
  assert.throws(() => buildAgentContext({ agent: agent(), blackboard: store }), /corrupt/);
});

test("an absent blackboard is detected structurally, not by catching an error", () => {
  // `exists()` is the only trustworthy absence signal. Treating a throw as
  // "absent" would swallow corruption along with it.
  const store = { exists: () => false, summary: () => { throw new Error("must not be called"); } };
  const ctx = buildAgentContext({ agent: agent(), blackboard: store });
  assert.equal(ctx.blackboardPresent, false);
});

test("the caller's task outranks recorded history", () => {
  const ctx = buildAgentContext({
    agent: agent(),
    blackboard: blackboard(emptySummary()),
    task: { id: "t9", title: "fix the failing test" },
  });
  assert.equal(ctx.task.title, "fix the failing test");
});

test("a plain string task is accepted", () => {
  const ctx = buildAgentContext({ agent: agent(), task: "explain this stack trace" });
  assert.equal(ctx.task.title, "explain this stack trace");
});

test("session identity and agents are carried through", () => {
  const ctx = buildAgentContext({
    agent: agent(),
    session: { id: "ses-abc", name: "the big one", agents: ["coder", "reviewer"] },
  });
  assert.equal(ctx.sessionId, "ses-abc");
  assert.deepEqual(ctx.session.agents, ["coder", "reviewer"]);
});

// ---------------------------------------------------------------------------
// budget and truncation
// ---------------------------------------------------------------------------

test("context inside the budget reports no truncation", () => {
  const ctx = buildAgentContext({ agent: agent(), blackboard: blackboard(emptySummary()) });
  assert.deepEqual(ctx.truncated, {});
  assert.ok(ctx.chars < ctx.budget);
});

test("an oversized group is dropped whole and reported", () => {
  const many = Array.from({ length: 400 }, (_, i) => ({ id: `f${i}`, title: "x".repeat(200) }));
  const ctx = buildAgentContext({
    agent: agent({ maxContextChars: 4000 }),
    blackboard: blackboard(emptySummary({ files: many })),
  });
  assert.ok(Object.keys(ctx.truncated).length, "dropping records must be reported");
  assert.ok(ctx.truncated.files > 0);
});

test("a record is never clipped in half", () => {
  // Half a task is worse than no task: the model cannot tell it is half a task.
  const items = Array.from({ length: 50 }, (_, i) => ({ id: `t${i}`, title: "y".repeat(400) }));
  const ctx = buildAgentContext({
    agent: agent({ maxContextChars: 5000 }),
    blackboard: blackboard(emptySummary({ openTasks: items })),
  });
  for (const kept of ctx.openTasks || []) {
    assert.ok(kept.title.length === 400, "a retained record must be intact");
  }
});

test("the newest records are the ones kept", () => {
  const items = Array.from({ length: 50 }, (_, i) => ({ id: `t${i}`, title: "z".repeat(400) }));
  const ctx = buildAgentContext({
    agent: agent({ maxContextChars: 5000 }),
    blackboard: blackboard(emptySummary({ openTasks: items })),
  });
  if (ctx.openTasks?.length) {
    assert.equal(ctx.openTasks[ctx.openTasks.length - 1].id, "t49", "the most recent record must survive");
  }
});

test("intent is kept ahead of history when the budget is tight", () => {
  // An agent that knows the goal but not the next action will invent one.
  const lots = Array.from({ length: 200 }, (_, i) => ({ id: `b${i}`, note: "w".repeat(300) }));
  const ctx = buildAgentContext({
    agent: agent({ maxContextChars: 3000 }),
    blackboard: blackboard(emptySummary({ openBlockers: lots, openTasks: lots })),
  });
  assert.equal(ctx.goal, "ship the thing");
  assert.equal(ctx.objective, "make it correct");
});

test("a budget too small for the intent is a named configuration error", () => {
  assert.throws(
    () => buildAgentContext({ agent: agent({ maxContextChars: 1000 }), task: { title: "x".repeat(2000) } }),
    (err) => {
      assert.ok(err instanceof ContextError);
      assert.equal(err.code, "budget_too_small");
      return true;
    }
  );
});

test("an agent without a budget cannot assemble context", () => {
  assert.throws(() => buildAgentContext({}), (err) => {
    assert.equal(err.code, "no_budget");
    return true;
  });
});

test("assembled context never exceeds its budget", () => {
  const lots = Array.from({ length: 300 }, (_, i) => ({ id: `f${i}`, title: "q".repeat(150) }));
  for (const budget of [2000, 5000, 12_000, 24_000]) {
    const ctx = buildAgentContext({
      agent: agent({ maxContextChars: budget }),
      blackboard: blackboard(emptySummary({ files: lots, openTasks: lots, openBlockers: lots })),
    });
    assert.ok(ctx.chars <= ctx.budget, `chars ${ctx.chars} must stay within ${budget}`);
  }
});

// ---------------------------------------------------------------------------
// redaction
// ---------------------------------------------------------------------------

test("a credential in recorded state is masked before it reaches a model", () => {
  // Context is shipped to a provider verbatim, so a token pasted into a task
  // title three sessions ago must not ride along on every future run.
  const ctx = buildAgentContext({
    agent: agent(),
    blackboard: blackboard(
      emptySummary({ openTasks: [{ id: "t1", title: "rotate ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4" }] })
    ),
  });
  assert.doesNotMatch(JSON.stringify(ctx), /ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4/);
  assert.match(JSON.stringify(ctx), /\*\*\*/);
});

// ---------------------------------------------------------------------------
// immutability
// ---------------------------------------------------------------------------

test("the assembled context is frozen", () => {
  const ctx = buildAgentContext({ agent: agent(), blackboard: blackboard(emptySummary()) });
  assert.ok(Object.isFrozen(ctx));
  assert.ok(Object.isFrozen(ctx.truncated));
});

test("a truncated group cannot be mutated by a later step", () => {
  const ctx = buildAgentContext({
    agent: agent({ maxContextChars: 2000 }),
    blackboard: blackboard(emptySummary({ files: Array.from({ length: 200 }, (_, i) => ({ id: `f${i}`, t: "u".repeat(200) })) })),
  });
  assert.throws(() => {
    "use strict";
    ctx.truncated.files = 0;
  });
});

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

test("rendering states plainly when context is incomplete", () => {
  const ctx = buildAgentContext({
    agent: agent({ maxContextChars: 2000 }),
    blackboard: blackboard(emptySummary({ files: Array.from({ length: 200 }, (_, i) => ({ id: `f${i}`, t: "u".repeat(200) })) })),
  });
  const text = renderContext(ctx);
  assert.match(text, /this context is incomplete/);
  assert.match(text, /older omitted/);
  assert.match(text, /Ask for what you need/);
});

test("rendering omits empty groups rather than printing noise", () => {
  const ctx = buildAgentContext({ agent: agent(), blackboard: blackboard(emptySummary()) });
  const text = renderContext(ctx);
  assert.match(text, /goal:\s+ship the thing/);
  assert.doesNotMatch(text, /openTasks:/);
  assert.doesNotMatch(text, /incomplete/);
});

test("rendering covers the caller's task", () => {
  const ctx = buildAgentContext({ agent: agent(), task: { title: "do the thing" } });
  assert.match(renderContext(ctx), /current task:.*do the thing/s);
});