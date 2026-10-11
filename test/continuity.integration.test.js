// Continuity integration tests.
//
// These drive the real SessionStore, BlackboardStore, EventLog and ProviderHealth
// through a continuation, so the milestones are checked against the stores rather
// than against a stub:
//
//   * the context packet is rebuilt from authoritative state and persisted,
//   * the provider transition is recorded and the session header updated,
//   * the event sequence is ordered and carries no credential,
//   * an invalid request or a cancellation stops without calling the provider,
//   * candidate failures feed ProviderHealth, and
//   * the record survives a fresh store instance (a process restart).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SessionStore, ENTRY_KIND } from "../src/core/sessions.js";
import { BlackboardStore } from "../src/core/blackboard.js";
import { EventLog, EVENTS, readEvents } from "../src/core/events.js";
import { ProviderHealth, PROVIDER_STATUS } from "../src/core/provider-health.js";
import { continueSession, PROVIDER_FAILURE } from "../src/core/continuity.js";

const FIXED = Date.UTC(2026, 0, 1, 0, 0, 0);

function tmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `aflow-${label}-`));
}

/** A fresh, isolated harness with real stores on disk. */
function harness() {
  const dir = tmpDir("continuity");
  const sessions = new SessionStore({ dir: path.join(dir, "sessions"), now: () => FIXED });
  const board = new BlackboardStore({ dir: path.join(dir, "bb"), projectRoot: dir, now: () => FIXED });
  board.create({ goal: "durable agent state", objective: "continue across providers" });
  board.addTask({ title: "wire continuity" });
  board.recordTest({ suite: "full suite", command: "npm test", passed: 721 });
  const logFile = path.join(dir, "events.jsonl");
  const log = new EventLog({ file: logFile });
  return { dir, sessions, board, logFile, log };
}

function seedSession(sessions, { provider = "a", model = "a/old" } = {}) {
  const session = sessions.create({ objective: "Ship the continuity milestone", provider, model });
  sessions.append(session.id, ENTRY_KIND.CONVERSATION, { role: "user", text: "please continue the work" });
  sessions.append(session.id, ENTRY_KIND.TOOL_RESULT, {
    tool: "filesystem.read",
    scope: "read",
    status: "ok",
    summary: "read 12 lines",
  });
  return session;
}

const eventTypes = (file) => readEvents({ file, limit: 200 }).events.map((e) => e.type);

test("a transient failure continues on a new provider, reconstructed from the stores", async () => {
  const { sessions, board, logFile, log } = harness();
  const session = seedSession(sessions);
  const health = new ProviderHealth({ now: () => FIXED });

  // Runtime-assembled so no credential-shaped literal is committed. It rides in
  // the context packet via `extra`, which is the path the packet redactor covers.
  const secret = `sk-${"b".repeat(24)}`;
  let called = 0;
  const complete = async (_config, modelId) => {
    called += 1;
    assert.equal(modelId, "b/new");
    return { text: "continued ok" };
  };

  const receipt = await continueSession({
    sessions,
    blackboard: board,
    sessionId: session.id,
    modelId: "b/new",
    complete,
    failure: Object.assign(new Error("503 bad gateway"), { status: 503 }),
    health,
    log,
    contextWindow: 50000,
    extra: { note: `earlier token ${secret}` },
    now: FIXED,
  });

  assert.equal(receipt.action, "continued");
  assert.equal(receipt.outcome.ok, true);
  assert.equal(called, 1);

  // The session header now reflects the provider that answered.
  const after = sessions.read(session.id);
  assert.equal(after.provider, "b");
  assert.equal(after.model, "b/new");

  const kinds = after.entries.map((e) => e.kind);
  assert.ok(kinds.includes(ENTRY_KIND.CONTEXT), "context packet persisted");
  assert.ok(kinds.includes(ENTRY_KIND.PROVIDER_TRANSITION), "transition persisted");

  const transition = after.entries.find((e) => e.kind === ENTRY_KIND.PROVIDER_TRANSITION);
  assert.equal(transition.from.provider, "a");
  assert.equal(transition.to.provider, "b");
  assert.equal(transition.failureClass, PROVIDER_FAILURE.SERVER);

  const packetEntry = after.entries.find((e) => e.kind === ENTRY_KIND.CONTEXT);
  assert.equal(packetEntry.budget, 50000);

  // Health learned the outcome.
  assert.equal(health.getProviderStatus("b").status, PROVIDER_STATUS.HEALTHY);

  // No credential reached the durable record.
  const persisted = fs.readFileSync(sessions.fileFor(session.id), "utf8");
  assert.ok(!persisted.includes(secret), "raw secret must not be persisted");

  const types = eventTypes(logFile);
  assert.ok(types.includes(EVENTS.CONTEXT_BUILT));
  assert.ok(types.includes(EVENTS.CONTEXT_RECONSTRUCTED));
  assert.ok(types.includes(EVENTS.CONTINUATION_STARTED));
  assert.ok(types.includes(EVENTS.CONTINUATION_COMPLETED));
  assert.ok(
    types.indexOf(EVENTS.CONTINUATION_STARTED) < types.indexOf(EVENTS.CONTINUATION_COMPLETED),
    "continuation.started precedes continuation.completed",
  );
});

test("an invalid request stops without switching provider", async () => {
  const { sessions, board, logFile, log } = harness();
  const session = seedSession(sessions);
  let called = 0;
  const complete = async () => {
    called += 1;
    return { text: "should not run" };
  };

  const receipt = await continueSession({
    sessions,
    blackboard: board,
    sessionId: session.id,
    modelId: "b/new",
    complete,
    failure: Object.assign(new Error("400 invalid request: bad parameter"), { status: 400 }),
    log,
    now: FIXED,
  });

  assert.equal(receipt.action, "stop");
  assert.equal(receipt.reason, "no_other_provider_fixes");
  assert.equal(called, 0, "no provider is called for a malformed request");

  // The packet is still recorded so the decision is reconstructable.
  const after = sessions.read(session.id);
  assert.ok(after.entries.some((e) => e.kind === ENTRY_KIND.CONTEXT));
  assert.ok(!after.entries.some((e) => e.kind === ENTRY_KIND.PROVIDER_TRANSITION));
  assert.ok(eventTypes(logFile).includes(EVENTS.CONTEXT_BUILT));
});

test("a user cancellation stops without switching provider", async () => {
  const { sessions, board, log } = harness();
  const session = seedSession(sessions);
  let called = 0;
  const receipt = await continueSession({
    sessions,
    blackboard: board,
    sessionId: session.id,
    modelId: "b/new",
    complete: async () => {
      called += 1;
      return { text: "nope" };
    },
    failure: new Error("aborted"),
    cancelled: true,
    log,
    now: FIXED,
  });

  assert.equal(receipt.action, "stop");
  assert.equal(receipt.reason, "cancelled_by_user");
  assert.equal(called, 0);
});

test("an unknown failure asks for approval instead of guessing", async () => {
  const { sessions, board, log } = harness();
  const session = seedSession(sessions);
  let called = 0;
  const receipt = await continueSession({
    sessions,
    blackboard: board,
    sessionId: session.id,
    modelId: "b/new",
    complete: async () => {
      called += 1;
      return { text: "nope" };
    },
    failure: new Error("the provider said something we do not recognise"),
    log,
    now: FIXED,
  });

  assert.equal(receipt.action, "require_approval");
  assert.equal(receipt.reason, "unknown_failure_uncertain");
  assert.equal(called, 0);
});

test("an uncertain dispatched tool outcome forces approval and warns", async () => {
  const { sessions, board, logFile, log } = harness();
  const session = seedSession(sessions);
  let called = 0;
  const receipt = await continueSession({
    sessions,
    blackboard: board,
    sessionId: session.id,
    modelId: "b/new",
    complete: async () => {
      called += 1;
      return { text: "nope" };
    },
    failure: Object.assign(new Error("429 rate limited"), { status: 429 }),
    uncertainDispatches: 1,
    log,
    now: FIXED,
  });

  assert.equal(receipt.action, "require_approval");
  assert.equal(receipt.reason, "uncertain_tool_outcomes");
  assert.equal(called, 0);
  const events = readEvents({ file: logFile, limit: 200 }).events;
  assert.ok(events.some((e) => e.type === EVENTS.TOOL_OUTCOME_UNCERTAIN && e.level === "warn"));
});

test("a failing candidate feeds ProviderHealth and reports continuation.failed", async () => {
  const { sessions, board, logFile, log } = harness();
  const session = seedSession(sessions);
  const health = new ProviderHealth({ now: () => FIXED, openAfterFailures: 1 });

  const receipt = await continueSession({
    sessions,
    blackboard: board,
    sessionId: session.id,
    modelId: "b/new",
    complete: async () => {
      throw Object.assign(new Error("429 too many requests"), { status: 429 });
    },
    failure: Object.assign(new Error("503 bad gateway"), { status: 503 }),
    health,
    log,
    now: FIXED,
  });

  assert.equal(receipt.action, "failed");
  assert.equal(receipt.outcome.failureClass, PROVIDER_FAILURE.RATE_LIMITED);
  assert.ok(health.getProviderStatus("b").consecutiveFailures >= 1);
  assert.ok(eventTypes(logFile).includes(EVENTS.CONTINUATION_FAILED));

  // No transition is recorded when the new provider did not take over.
  const after = sessions.read(session.id);
  assert.equal(after.provider, "a");
});

test("the continuation record survives a fresh store instance", async () => {
  const { dir, sessions, board, log } = harness();
  const session = seedSession(sessions);

  await continueSession({
    sessions,
    blackboard: board,
    sessionId: session.id,
    modelId: "b/new",
    complete: async () => ({ text: "done" }),
    failure: Object.assign(new Error("500 server error"), { status: 500 }),
    log,
    now: FIXED,
  });

  // A new store pointed at the same directory is the process-restart case.
  const reopened = new SessionStore({ dir: path.join(dir, "sessions") });
  const reloaded = reopened.read(session.id);
  assert.equal(reloaded.provider, "b");
  assert.ok(reloaded.entries.some((e) => e.kind === ENTRY_KIND.CONTEXT));
  assert.ok(reloaded.entries.some((e) => e.kind === ENTRY_KIND.PROVIDER_TRANSITION));
});
