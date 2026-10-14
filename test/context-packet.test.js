// Context packet tests.
//
// The three behaviours worth more than the rest:
//
//   * an unknown context limit is never presented as a known one,
//   * a packet that drops content says exactly what it dropped, and
//   * the packet is frozen against the mutation a continuation would otherwise
//     be able to reach.
//
// The rest is shape: which section a store fact lands in, and that a resume
// produces the same packet twice.

import test from "node:test";
import assert from "node:assert/strict";
import {
  CONTEXT_PACKET_VERSION,
  CONTEXT_LIMIT_SOURCE,
  CONTEXT_SECTION_KEYS,
  ContextPacketError,
  buildContextPacket,
  budgetContextPacket,
  renderContextPacket,
  packetSize,
} from "../src/core/context-packet.js";

const SESSION_ID = "ses_20260101T000000000Z_aaaaaa";

function sessionFixture(overrides = {}) {
  return {
    id: SESSION_ID,
    objective: "Ship the continuity milestone",
    state: "active",
    completedAt: null,
    provider: "opencode",
    model: "opencode/big-pickle",
    project: { root: "C:/work/repo", name: "repo" },
    entries: [
      { seq: 1, ts: "2026-01-01T00:00:00.000Z", kind: "conversation", role: "user", text: "please implement" },
      { seq: 2, ts: "2026-01-01T00:00:01.000Z", kind: "tool_result", tool: "shell.execute", scope: "shell", status: "ok", summary: "npm test exited 0", truncated: null, errorCode: null },
      { seq: 3, ts: "2026-01-01T00:00:02.000Z", kind: "tool_result", tool: "filesystem.read", scope: "read", status: "ok", summary: "read 10 lines", truncated: null, errorCode: null },
      { seq: 4, ts: "2026-01-01T00:00:03.000Z", kind: "note", text: "remember to update the README" },
      { seq: 5, ts: "2026-01-01T00:00:04.000Z", kind: "checkpoint", title: "before-switch" },
    ],
    ...overrides,
  };
}

function blackboardFixture(overrides = {}) {
  const summary = {
    id: "bb1",
    projectRoot: "C:/work/repo",
    nextAction: { text: "write tests" },
    inProgress: [{ id: "t6", title: "continuity", status: "in_progress" }],
    openTasks: [{ id: "t3", title: "README", status: "pending" }],
    latestTests: [{ suite: "full", passed: 721 }],
    activeDecisions: [{ id: "d1", title: "reuse M1" }],
    openBlockers: [{ id: "b1", title: "blocked on auth" }],
    openBugs: [{ id: "k1", title: "off by one" }],
    openQuestions: [{ id: "q1", title: "which provider" }],
    activeAssumptions: [{ id: "a1", title: "windows" }],
    openFindings: [{ id: "f1", title: "gh targets upstream" }],
    files: ["src/core/continuity.js"],
    commits: ["e232cac6"],
    ...overrides,
  };
  return { exists: () => true, get: () => summary };
}

test("builds a versioned packet with all sections from the stores", () => {
  const packet = buildContextPacket({
    session: sessionFixture(),
    blackboard: blackboardFixture(),
    task: { title: "finish continuity", taskId: "t6" },
    now: 1000,
  });

  assert.equal(packet.version, CONTEXT_PACKET_VERSION);
  assert.equal(packet.identity.session, SESSION_ID);
  assert.equal(packet.identity.workspaceRoot, "C:/work/repo");
  assert.equal(packet.identity.taskId, "t6");
  assert.equal(packet.task.objective, "Ship the continuity milestone");
  assert.equal(packet.task.state, "active");
  assert.deepEqual(packet.task.task, { title: "finish continuity", taskId: "t6" });
  assert.equal(packet.nextActions.nextAction.text, "write tests");
  assert.equal(packet.conversation.length, 2, "conversation and note both land here");
  assert.equal(packet.toolOutcomes.length, 2);
  assert.equal(packet.commands.length, 1, "only shell.execute is a command");
  assert.equal(packet.commands[0].tool, "shell.execute");
  assert.equal(packet.providers.current.provider, "opencode");
  assert.equal(packet.checkpoints.length, 1);
  assert.deepEqual(packet.metadata.sources, { session: true, blackboard: true, task: true });
  assert.equal(packet.metadata.builtAt, new Date(1000).toISOString());
});

test("a packet with no stores still builds and declares both sources absent", () => {
  const packet = buildContextPacket({});
  assert.equal(packet.identity.session, null);
  assert.equal(packet.task.objective, null);
  assert.deepEqual(packet.metadata.sources, { session: false, blackboard: false, task: false });
  assert.equal(packet.metadata.errors.session, "absent");
  assert.equal(packet.metadata.errors.blackboard, "absent");
  assert.equal(packet.conversation.length, 0);
});

test("an unknown context limit is reported as unknown, never as a known budget", () => {
  const packet = buildContextPacket({ session: sessionFixture(), blackboard: blackboardFixture() });
  assert.equal(packet.metadata.limitSource, CONTEXT_LIMIT_SOURCE.UNKNOWN);
  assert.equal(packet.metadata.limit, null);
  assert.equal(packet.metadata.budget, null);

  const unbudgeted = budgetContextPacket(packet, {});
  assert.equal(unbudgeted.metadata.limitSource, CONTEXT_LIMIT_SOURCE.UNKNOWN);
  assert.equal(unbudgeted.metadata.budget, null);
  assert.deepEqual(unbudgeted.metadata.truncated, {});
});

test("a declared model window yields a model-sourced budget with the reserve removed", () => {
  const packet = buildContextPacket({ session: sessionFixture(), blackboard: blackboardFixture() });
  const budgeted = budgetContextPacket(packet, { contextWindow: 4000, reserveChars: 1500 });
  assert.equal(budgeted.metadata.limitSource, CONTEXT_LIMIT_SOURCE.MODEL_WINDOW);
  assert.equal(budgeted.metadata.budget, 2500);
  assert.equal(budgeted.metadata.incomplete, false);
});

test("with no window, the agent budget is used and labelled as such", () => {
  const packet = buildContextPacket({ session: sessionFixture(), blackboard: blackboardFixture() });
  const budgeted = budgetContextPacket(packet, { budgetChars: 5000 });
  assert.equal(budgeted.metadata.limitSource, CONTEXT_LIMIT_SOURCE.AGENT_BUDGET);
  assert.equal(budgeted.metadata.budget, 5000);
});

test("the same stores produce the same packet (deterministic)", () => {
  const make = () =>
    budgetContextPacket(
      buildContextPacket({ session: sessionFixture(), blackboard: blackboardFixture(), now: 1000 }),
      { contextWindow: 2000, reserveChars: 200 },
    );
  assert.deepEqual(JSON.parse(JSON.stringify(make())), JSON.parse(JSON.stringify(make())));
});

test("a budget too small for the core throws rather than shipping a hollow packet", () => {
  const packet = buildContextPacket({ session: sessionFixture(), blackboard: blackboardFixture() });
  assert.throws(
    () => budgetContextPacket(packet, { budgetChars: 10 }),
    (err) => err instanceof ContextPacketError && err.code === "budget_too_small",
  );
});

test("truncation drops whole arrays newest-first and reports the count", () => {
  const session = sessionFixture();
  // Many conversation turns so a modest budget forces a partial keep.
  session.entries = Array.from({ length: 30 }, (_, i) => ({
    seq: i + 1,
    ts: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
    kind: "conversation",
    role: "user",
    text: `turn ${i}`,
  }));

  const packet = buildContextPacket({ session });
  const budgeted = budgetContextPacket(packet, { budgetChars: 600 });

  assert.equal(budgeted.metadata.incomplete, true);
  assert.ok(budgeted.metadata.truncated.conversation > 0, "omitted count is reported");
  // Newest-first: the last turn survives, the first does not.
  const texts = budgeted.conversation.map((c) => c.text);
  assert.ok(texts.includes("turn 29"));
  assert.ok(!texts.includes("turn 0"));
});

test("a dropped non-array section is recorded as dropped, not as a count", () => {
  const packet = buildContextPacket({ session: sessionFixture(), blackboard: blackboardFixture() });
  // Reserve almost everything so only core survives and nextActions is dropped.
  const budgeted = budgetContextPacket(packet, { budgetChars: coreCost(packet) + 5 });
  assert.equal(budgeted.metadata.truncated.nextActions, "dropped");
});

test("the packet is deeply frozen against mutation", () => {
  const packet = buildContextPacket({ session: sessionFixture(), blackboard: blackboardFixture() });
  assert.throws(() => {
    packet.identity.session = "tampered";
  }, TypeError);
  assert.throws(() => {
    packet.conversation.push({ role: "user", text: "injected" });
  }, TypeError);
  assert.throws(() => {
    packet.metadata.sources.session = false;
  }, TypeError);
});

test("a credential in a note is redacted before it is carried in the packet", () => {
  // Assembled at runtime so no credential-shaped literal is committed.
  const fake = `sk-${"a".repeat(24)}`;
  const session = sessionFixture();
  session.entries = [{ seq: 1, ts: "t", kind: "note", text: `token is ${fake}` }];

  const packet = buildContextPacket({ session });
  const serialized = JSON.stringify(packet);
  assert.ok(!serialized.includes(fake), "raw secret must not survive");
  assert.ok(serialized.includes("sk-***"), "the mask is present instead");
});

test("render names the omissions when the packet was truncated", () => {
  const session = sessionFixture();
  session.entries = Array.from({ length: 30 }, (_, i) => ({
    seq: i + 1,
    ts: "t",
    kind: "conversation",
    role: "user",
    text: `turn ${i}`,
  }));
  const packet = budgetContextPacket(buildContextPacket({ session }), { budgetChars: 600 });
  const text = renderContextPacket(packet);
  assert.match(text, /incomplete/);
  assert.match(text, /omitted/);
});

test("render notes a complete fit without claiming completeness of the work", () => {
  const packet = budgetContextPacket(
    buildContextPacket({ session: sessionFixture(), blackboard: blackboardFixture() }),
    { contextWindow: 100000 },
  );
  const text = renderContextPacket(packet);
  assert.match(text, /fit within its 100000-char budget/);
  assert.doesNotMatch(text, /incomplete/);
});

test("exported section keys include the core and the optional sections", () => {
  for (const key of ["identity", "task", "metadata", "conversation", "toolOutcomes", "providers"]) {
    assert.ok(CONTEXT_SECTION_KEYS.includes(key), `missing ${key}`);
  }
  assert.equal(typeof packetSize(buildContextPacket({})), "number");
});

// The exact core cost is an implementation detail; this computes it the same
// way the module does (sum of the three serialised core sections) so the drop
// test does not hard-code a number that drifts with the core shape.
function coreCost(packet) {
  const size = (v) => (v === null || v === undefined ? 0 : JSON.stringify(v)?.length ?? 0);
  return size(packet.identity) + size(packet.task) + size(packet.metadata);
}
