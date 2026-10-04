// Blackboard store tests.
//
// Four of these protect something that outlives the process, and matter more than
// their size suggests:
//
//   "a corrupt blackboard is reported and left alone"      -- state has no other copy
//   "concurrent writers never lose a task"                 -- two agents, one project
//   "a credential in agent output never reaches disk"      -- provider output is untrusted
//   "the timeline survives a torn final line"              -- crash mid-append is normal
//
// The rest are ordinary behaviour, but the schema is wide enough that a field
// silently accepting the wrong shape is a real risk, so validation is covered
// explicitly rather than assumed.
//
// Every credential in this file is synthetic and shaped to trip the redactor.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  BlackboardStore,
  BlackboardError,
  ValidationError,
  BlackboardNotFoundError,
  BlackboardCorruptError,
  BlackboardLockedError,
  blackboardIdForProject,
  BLACKBOARD_VERSION,
  TASK_STATUS,
  DECISION_KIND,
  SEVERITY,
  FINDING_SOURCE,
  CHECKPOINT,
} from "../src/core/blackboard.js";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORE = pathToFileURL(path.join(HERE, "..", "src", "core", "blackboard.js")).href;

function tmp(label = "blackboard") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `aflow-${label}-`));
  const projectRoot = path.join(dir, "project");
  fs.mkdirSync(projectRoot, { recursive: true });
  return { dir, projectRoot, store: new BlackboardStore({ dir: path.join(dir, "state"), projectRoot }) };
}

function checkpoints(store) {
  return store.timeline().map((e) => e.checkpoint);
}

// ---------------------------------------------------------------------------
// identity and creation
// ---------------------------------------------------------------------------

test("blackboard id is stable per project root and differs between projects", () => {
  const a = blackboardIdForProject("/tmp/one");
  const b = blackboardIdForProject("/tmp/one/");
  const c = blackboardIdForProject("/tmp/two");
  assert.equal(a, b, "a trailing separator must not change identity");
  assert.match(a, /^[0-9a-f]{12}$/);
  assert.notEqual(a, c);
});

test("creation is idempotent and never resets an existing blackboard", () => {
  const { store } = tmp();
  assert.equal(store.exists(), false);

  const first = store.create({ goal: "ship the blackboard", objective: "make state durable" });
  assert.equal(first.version, BLACKBOARD_VERSION);
  assert.equal(first.goal, "ship the blackboard");

  store.addTask({ title: "write tests" });
  const again = store.create({ goal: "a different goal entirely" });

  assert.equal(again.goal, "ship the blackboard", "re-create must not overwrite state");
  assert.equal(again.tasks.length, 1);
});

test("creation without a goal or objective records no checkpoint", () => {
  const { store } = tmp();
  store.create();
  assert.deepEqual(store.timeline(), []);
});

test("reading before creation returns null and require throws", () => {
  const { store } = tmp();
  assert.equal(store.read(), null);
  assert.throws(() => store.require(), BlackboardNotFoundError);
  assert.throws(() => store.addTask({ title: "x" }), BlackboardNotFoundError);
});

test("state survives a restart through a fresh store instance", () => {
  const { dir, projectRoot, store } = tmp();
  store.create({ goal: "durable", objective: "across restarts" });
  store.addTask({ title: "first task" });
  store.setNextAction({ text: "run the suite" });

  // A brand new object: nothing in memory, everything from disk.
  const reopened = new BlackboardStore({ dir: path.join(dir, "state"), projectRoot });
  const summary = reopened.summary();

  assert.equal(summary.goal, "durable");
  assert.equal(summary.objective, "across restarts");
  assert.equal(summary.openTasks.length, 1);
  assert.equal(summary.nextAction.text, "run the suite");
});

test("state and timeline live in two files keyed by project", () => {
  const { store } = tmp();
  store.create({ goal: "x" });
  store.addTask({ title: "t" });

  assert.ok(fs.existsSync(store.stateFile()));
  assert.ok(fs.existsSync(store.eventsFile()));
  assert.match(path.basename(store.stateFile()), new RegExp(`^${store.id}\\.`));
  assert.equal(store.stateFile().includes(store.eventsFile()), false);
});

// ---------------------------------------------------------------------------
// intent
// ---------------------------------------------------------------------------

test("setIntent updates only the fields provided", () => {
  const { store } = tmp();
  store.create({ goal: "original goal", objective: "original objective" });

  store.setIntent({ objective: "sharper objective" });
  const state = store.require();

  assert.equal(state.goal, "original goal", "goal must survive a partial update");
  assert.equal(state.objective, "sharper objective");
});

test("setIntent records PLAN_CREATED", () => {
  const { store } = tmp();
  store.create({ goal: "g" });
  store.setIntent({ objective: "o" });
  assert.ok(checkpoints(store).includes(CHECKPOINT.PLAN_CREATED));
});

// ---------------------------------------------------------------------------
// tasks
// ---------------------------------------------------------------------------

test("tasks get sequential ids that are never reused", () => {
  const { store } = tmp();
  store.create();
  assert.equal(store.addTask({ title: "a" }).id, "t1");
  assert.equal(store.addTask({ title: "b" }).id, "t2");
  assert.equal(store.addTask({ title: "c" }).id, "t3");
});

test("a task status change emits the matching checkpoint", () => {
  const { store } = tmp();
  store.create();
  const task = store.addTask({ title: "implement" });

  store.updateTask(task.id, { status: TASK_STATUS.IN_PROGRESS });
  store.updateTask(task.id, { status: TASK_STATUS.DONE });

  assert.deepEqual(checkpoints(store), [CHECKPOINT.TASK_STARTED, CHECKPOINT.TASK_COMPLETED]);
});

test("a status change that is not a transition emits nothing", () => {
  const { store } = tmp();
  store.create();
  const task = store.addTask({ title: "implement" });

  store.updateTask(task.id, { status: TASK_STATUS.PENDING }); // already pending
  store.updateTask(task.id, { title: "renamed", detail: "more detail" });
  store.updateTask(task.id, { status: TASK_STATUS.CANCELLED }); // not a checkpoint

  assert.deepEqual(store.timeline(), [], "only meaningful transitions belong in the timeline");
});

test("completing a task stamps completedAt and reopening clears it", () => {
  const { store } = tmp();
  store.create();
  const task = store.addTask({ title: "implement" });

  store.updateTask(task.id, { status: TASK_STATUS.DONE });
  assert.ok(store.task(task.id).completedAt, "a done task records when it finished");

  store.updateTask(task.id, { status: TASK_STATUS.IN_PROGRESS });
  assert.equal(store.task(task.id).completedAt, null, "reopening must clear the completion stamp");
});

test("a partial task patch never blanks an untouched field", () => {
  const { store } = tmp();
  store.create();
  const task = store.addTask({ title: "keep me", detail: "keep this too" });

  store.updateTask(task.id, { status: TASK_STATUS.IN_PROGRESS });
  const after = store.task(task.id);

  assert.equal(after.title, "keep me");
  assert.equal(after.detail, "keep this too");
});

test("dependsOn is validated against real tasks", () => {
  const { store } = tmp();
  store.create();
  const first = store.addTask({ title: "first" });

  assert.equal(store.addTask({ title: "second", dependsOn: [first.id] }).dependsOn[0], first.id);
  assert.throws(() => store.addTask({ title: "bad", dependsOn: ["t99"] }), ValidationError);
});

test("a dependent task can be created in the same call as its dependency's successor", () => {
  const { store } = tmp();
  store.create();
  const a = store.addTask({ title: "a" });
  const b = store.addTask({ title: "b", dependsOn: [a.id] });
  store.updateTask(b.id, { status: TASK_STATUS.DONE });
  assert.equal(store.listTasks({ status: TASK_STATUS.DONE }).length, 1);
});

test("listing tasks by status validates the filter", () => {
  const { store } = tmp();
  store.create();
  const task = store.addTask({ title: "a" });
  store.updateTask(task.id, { status: TASK_STATUS.IN_PROGRESS });

  assert.equal(store.listTasks({ status: TASK_STATUS.IN_PROGRESS }).length, 1);
  assert.equal(store.listTasks({ status: TASK_STATUS.DONE }).length, 0);
  assert.equal(store.listTasks().length, 1);
  assert.throws(() => store.listTasks({ status: "nonsense" }), ValidationError);
});

test("updating an unknown task fails instead of silently creating one", () => {
  const { store } = tmp();
  store.create();
  assert.throws(() => store.updateTask("t42", { status: TASK_STATUS.DONE }), ValidationError);
  assert.equal(store.listTasks().length, 0);
});

test("returned tasks are copies, so a caller cannot mutate persisted state", () => {
  const { store } = tmp();
  store.create();
  const task = store.addTask({ title: "original" });

  task.title = "tampered";
  store.listTasks()[0].title = "also tampered";

  assert.equal(store.task(task.id).title, "original");
});

// ---------------------------------------------------------------------------
// decisions
// ---------------------------------------------------------------------------

test("a decision keeps its kind, rationale and alternatives", () => {
  const { store } = tmp();
  store.create();
  const decision = store.recordDecision({
    title: "state lives in two files",
    kind: DECISION_KIND.ARCHITECTURE,
    rationale: "the state doc is bounded; the timeline is not",
    alternatives: ["single document", "sqlite"],
    commit: "abc1234",
  });

  assert.equal(decision.kind, DECISION_KIND.ARCHITECTURE);
  assert.equal(decision.rationale, "the state doc is bounded; the timeline is not");
  assert.deepEqual(decision.alternatives, ["single document", "sqlite"]);
  assert.equal(decision.status, "active");
  assert.ok(checkpoints(store).includes(CHECKPOINT.DECISION_RECORDED));
});

test("superseding a decision retires the old one and links both ways", () => {
  const { store } = tmp();
  store.create();
  const first = store.recordDecision({ title: "use json", kind: DECISION_KIND.ARCHITECTURE });
  const second = store.recordDecision({ title: "use jsonl", kind: DECISION_KIND.ARCHITECTURE, supersedes: first.id });

  const decisions = store.decisions();
  assert.equal(decisions[0].status, "superseded");
  assert.equal(decisions[0].supersededBy, second.id);
  assert.equal(decisions[1].supersedes, first.id);
  assert.equal(decisions[1].status, "active");
  assert.equal(store.decisions({ activeOnly: true }).length, 1);
});

test("superseding an unknown decision fails", () => {
  const { store } = tmp();
  store.create();
  assert.throws(() => store.recordDecision({ title: "x", supersedes: "d99" }), ValidationError);
});

test("a decision can be attached to a task and a commit", () => {
  const { store } = tmp();
  store.create();
  const task = store.addTask({ title: "design" });
  store.recordDecision({ title: "chose x", taskId: task.id, commit: "deadbee" });

  assert.equal(store.commits().includes("deadbee"), true);
  assert.throws(() => store.recordDecision({ title: "y", taskId: "t99" }), ValidationError);
});

// ---------------------------------------------------------------------------
// blockers, bugs, questions, assumptions
// ---------------------------------------------------------------------------

test("a blocker on a task marks that task blocked and records the link", () => {
  const { store } = tmp();
  store.create();
  const task = store.addTask({ title: "finish feature" });
  const blocker = store.recordBlocker({ title: "waiting on upstream", severity: SEVERITY.HIGH, taskId: task.id });

  const updated = store.task(task.id);
  assert.equal(updated.status, TASK_STATUS.BLOCKED);
  assert.deepEqual(updated.blockedBy, [blocker.id]);
});

test("resolving a blocker keeps the resolution", () => {
  const { store } = tmp();
  store.create();
  const blocker = store.recordBlocker({ title: "flaky test" });
  const resolved = store.resolveBlocker(blocker.id, "pinned the dependency");

  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.resolution, "pinned the dependency");
  assert.ok(resolved.resolvedAt);
  assert.equal(store.blockers({ status: "open" }).length, 0);
});

test("unblocking a task clears its blocker links", () => {
  const { store } = tmp();
  store.create();
  const task = store.addTask({ title: "ship" });
  const blocker = store.recordBlocker({ title: "blocked", taskId: task.id });
  store.resolveBlocker(blocker.id, "unblocked");
  store.updateTask(task.id, { status: TASK_STATUS.IN_PROGRESS });

  assert.deepEqual(store.task(task.id).blockedBy, []);
});

test("a bug can be identified and later fixed", () => {
  const { store } = tmp();
  store.create();
  const bug = store.recordBug({ title: "off-by-one", severity: SEVERITY.HIGH });

  assert.ok(checkpoints(store).includes(CHECKPOINT.BUG_IDENTIFIED));
  const fixed = store.fixBug(bug.id, "recomputed the bound");
  assert.equal(fixed.status, "fixed");
  assert.ok(fixed.fixedAt);
  assert.ok(checkpoints(store).includes(CHECKPOINT.BUG_FIXED));
});

test("a question can be asked and answered", () => {
  const { store } = tmp();
  store.create();
  const question = store.recordQuestion({ question: "which provider?" });
  assert.equal(store.questions({ status: "open" }).length, 1);

  const answered = store.answerQuestion(question.id, "the configured one");
  assert.equal(answered.status, "answered");
  assert.equal(answered.answer, "the configured one");
  assert.equal(store.questions({ status: "open" }).length, 0);
});

test("an assumption can be recorded and invalidated", () => {
  const { store } = tmp();
  store.create();
  const assumption = store.recordAssumption({ statement: "tests run offline", basis: "no network in CI" });
  assert.equal(store.assumptions({ status: "active" }).length, 1);

  const invalidated = store.invalidateAssumption(assumption.id, "CI gained network access");
  assert.equal(invalidated.status, "invalidated");
  assert.equal(invalidated.reason, "CI gained network access");
  assert.equal(store.assumptions({ status: "active" }).length, 0);
});

// ---------------------------------------------------------------------------
// findings and reviews
// ---------------------------------------------------------------------------

test("findings record their source and can be filtered by it", () => {
  const { store } = tmp();
  store.create();
  const task = store.addTask({ title: "review me" });
  store.recordFinding({ title: "agent note", source: FINDING_SOURCE.AGENT, taskId: task.id });
  store.recordFinding({ title: "reviewer note", source: FINDING_SOURCE.REVIEWER, severity: SEVERITY.HIGH });
  store.recordFinding({
    title: "with files",
    source: FINDING_SOURCE.REVIEWER,
    files: ["src/core/blackboard.js", "test/blackboard.test.js"],
  });

  assert.equal(store.findings().length, 3);
  assert.equal(store.findings({ source: FINDING_SOURCE.REVIEWER }).length, 2);
  assert.deepEqual(store.findings({ source: FINDING_SOURCE.AGENT })[0].files, []);
});

test("a finding's status can be advanced", () => {
  const { store } = tmp();
  store.create();
  const finding = store.recordFinding({ title: "fix me" });

  assert.equal(store.updateFinding(finding.id, { status: "addressed" }).status, "addressed");
  assert.equal(store.updateFinding(finding.id, { status: "dismissed" }).status, "dismissed");
  assert.throws(() => store.updateFinding(finding.id, { status: "invented" }), ValidationError);
});

test("a completed review is a checkpoint and keeps its findings", () => {
  const { store } = tmp();
  store.create();
  const review = store.recordReview({
    summary: "reviewed the store",
    verdict: "approve",
    findings: [{ title: "nit: rename this", severity: SEVERITY.LOW }],
  });

  assert.ok(checkpoints(store).includes(CHECKPOINT.REVIEW_COMPLETED));
  assert.equal(review.findings.length, 1);
  assert.equal(review.findings[0].severity, SEVERITY.LOW);
  assert.equal(store.reviews().length, 1);
});

test("a malformed review finding is rejected rather than stored", () => {
  const { store } = tmp();
  store.create();
  assert.throws(() => store.recordReview({ summary: "s", findings: "not an array" }), ValidationError);
  assert.throws(() => store.recordReview({ summary: "s", findings: [{ severity: "low" }] }), ValidationError);
  assert.throws(() => store.recordReview({ summary: "s", findings: [null] }), ValidationError);
  assert.equal(store.reviews().length, 0, "a rejected review must leave nothing behind");
});

// ---------------------------------------------------------------------------
// implementation, tests, evidence
// ---------------------------------------------------------------------------

test("implementation records file paths and commit shas as references", () => {
  const { store } = tmp();
  store.create();
  store.recordImplementation({
    summary: "added the store",
    files: ["src\\core\\blackboard.js", "test/blackboard.test.js"],
    commits: ["ABC1234"],
  });

  // Windows separators normalised, sha lowercased, contents never copied.
  assert.deepEqual(Object.keys(store.files()), ["src/core/blackboard.js", "test/blackboard.test.js"]);
  assert.deepEqual(store.commits(), ["abc1234"]);
  assert.ok(checkpoints(store).includes(CHECKPOINT.IMPLEMENTATION_UPDATED));
});

test("file references must be relative and must not escape the project", () => {
  const { store } = tmp();
  store.create();
  assert.throws(() => store.recordImplementation({ summary: "s", files: ["../outside.js"] }), ValidationError);
  assert.throws(() => store.recordImplementation({ summary: "s", files: ["a/../../b.js"] }), ValidationError);
  assert.throws(() => store.recordImplementation({ summary: "s", files: ["/etc/passwd"] }), ValidationError);
});

test("a commit reference must look like a sha", () => {
  const { store } = tmp();
  store.create();
  assert.throws(() => store.recordImplementation({ summary: "s", commits: ["not-a-sha"] }), ValidationError);
  assert.throws(() => store.recordDecision({ title: "t", commit: "zzzz" }), ValidationError);
});

test("a passing test run records TEST_PASSED", () => {
  const { store } = tmp();
  store.create();
  store.recordTest({ suite: "unit", passed: 12, failed: 0, command: "npm test" });

  assert.ok(checkpoints(store).includes(CHECKPOINT.TEST_PASSED));
  assert.equal(store.tests()[0].passed, 12);
});

test("a failing test run records TEST_FAILED and keeps the failure detail", () => {
  const { store } = tmp();
  store.create();
  store.recordTest({ suite: "unit", passed: 10, failed: 2, failures: ["a fails", "b fails"] });

  assert.ok(checkpoints(store).includes(CHECKPOINT.TEST_FAILED));
  assert.deepEqual(store.tests()[0].failures, ["a fails", "b fails"]);
});

test("a run that verified nothing is treated as a failure", () => {
  const { store } = tmp();
  store.create();
  store.recordTest({ suite: "unit", passed: 0, failed: 0 });
  assert.ok(checkpoints(store).includes(CHECKPOINT.TEST_FAILED));
});

test("latestOnly keeps the newest run per suite", () => {
  const { store } = tmp();
  store.create();
  store.recordTest({ suite: "unit", passed: 5, failed: 0 });
  store.recordTest({ suite: "unit", passed: 9, failed: 0 });
  store.recordTest({ suite: "cli", passed: 3, failed: 0 });

  const latest = store.tests({ latestOnly: true });
  assert.equal(latest.length, 2);
  assert.equal(latest.find((t) => t.suite === "unit").passed, 9);
  assert.equal(store.tests().length, 3);
});

test("negative test counts are rejected", () => {
  const { store } = tmp();
  store.create();
  assert.throws(() => store.recordTest({ suite: "unit", passed: -1 }), ValidationError);
  assert.throws(() => store.recordTest({ suite: "unit", passed: "many" }), ValidationError);
});

test("evidence records a typed reference and can be noted", () => {
  const { store } = tmp();
  store.create();
  const evidence = store.recordEvidence({ kind: "commit", ref: "abc1234", note: "the fix" });

  assert.equal(evidence.kind, "commit");
  assert.equal(store.evidence().length, 1);
  assert.throws(() => store.recordEvidence({ kind: "vibes", ref: "x" }), ValidationError);
});

// ---------------------------------------------------------------------------
// next action and sessions
// ---------------------------------------------------------------------------

test("the next action is the most recent one set", () => {
  const { store } = tmp();
  store.create();
  store.setNextAction({ text: "write the store" });
  store.setNextAction({ text: "write the tests" });

  assert.equal(store.require().nextAction.text, "write the tests");
  assert.equal(checkpoints(store).filter((c) => c === CHECKPOINT.NEXT_ACTION_SET).length, 2);
});

test("the next action can be cleared", () => {
  const { store } = tmp();
  store.create();
  store.setNextAction({ text: "temporary" });
  assert.equal(store.clearNextAction(), null);
  assert.equal(store.require().nextAction, null);
});

test("a next action must say something", () => {
  const { store } = tmp();
  store.create();
  assert.throws(() => store.setNextAction({}), ValidationError);
  assert.throws(() => store.setNextAction({ text: "   " }), ValidationError);
});

test("sessions are linked by reference and unlinked cleanly", () => {
  const { store } = tmp();
  store.create();
  store.linkSession("ses_20261004T080615614Z_0ter6m");
  store.linkSession("ses_20261004T080615614Z_0ter6m"); // idempotent

  assert.deepEqual(store.require().sessionIds, ["ses_20261004T080615614Z_0ter6m"]);

  store.unlinkSession("ses_20261004T080615614Z_0ter6m");
  assert.deepEqual(store.require().sessionIds, []);
});

test("recording anything with a session also links that session", () => {
  const { store } = tmp();
  store.create();
  const sessionId = "ses_20261004T080615614Z_0ter6m";
  store.addTask({ title: "t", sessionId });
  store.recordTest({ suite: "unit", passed: 1, sessionId });

  assert.deepEqual(store.require().sessionIds, [sessionId]);
});

test("a malformed session reference is rejected", () => {
  const { store } = tmp();
  store.create();
  assert.throws(() => store.linkSession("has spaces"), ValidationError);
  assert.throws(() => store.linkSession(""), ValidationError);
});

test("blackboard and session reference each other without duplicating content", async () => {
  const { SessionStore, blackboardIdForProject: _unused } = await import("../src/core/sessions.js");
  void _unused;

  const { dir, projectRoot, store } = tmp();
  const sessions = new SessionStore({ dir: path.join(dir, "sessions"), projectRoot });

  const session = sessions.create({ objective: "wire the blackboard", projectRoot });
  const blackboardId = blackboardIdForProject(projectRoot);

  store.create({ goal: "integrate", sessionId: session.id });
  store.linkSession(session.id);
  sessions.update(session.id, { blackboardRefs: [blackboardId] });

  // Both sides hold an id for the other.
  assert.ok(store.require().sessionIds.includes(session.id));
  assert.ok(sessions.read(session.id).blackboardRefs.includes(blackboardId));

  // And neither copied the other's payload: the objective lives in the session,
  // the goal in the blackboard, and neither string appears in the other's file.
  const bbText = fs.readFileSync(store.stateFile(), "utf8");
  const sessionText = fs.readFileSync(sessions.fileFor(session.id), "utf8");
  assert.equal(bbText.includes("wire the blackboard"), false);
  assert.equal(sessionText.includes("integrate"), false);
});

// ---------------------------------------------------------------------------
// timeline
// ---------------------------------------------------------------------------

test("the timeline records meaningful transitions in order", () => {
  const { store } = tmp();
  store.create({ goal: "g" });
  const task = store.addTask({ title: "implement" });
  store.updateTask(task.id, { status: TASK_STATUS.IN_PROGRESS });
  store.recordDecision({ title: "chose x" });
  store.recordTest({ suite: "unit", passed: 3 });
  store.setNextAction({ text: "commit" });

  assert.deepEqual(checkpoints(store), [
    CHECKPOINT.PLAN_CREATED,
    CHECKPOINT.TASK_STARTED,
    CHECKPOINT.DECISION_RECORDED,
    CHECKPOINT.TEST_PASSED,
    CHECKPOINT.NEXT_ACTION_SET,
  ]);
});

test("every checkpoint type the subsystem promises is reachable", () => {
  const { store } = tmp();
  store.create({ goal: "g", objective: "o" });
  const task = store.addTask({ title: "implement" });
  store.updateTask(task.id, { status: TASK_STATUS.IN_PROGRESS });
  store.recordImplementation({ summary: "wrote it", files: ["a.js"] });
  store.recordTest({ suite: "failing", failed: 1 });
  const bug = store.recordBug({ title: "bug" });
  store.fixBug(bug.id);
  store.recordTest({ suite: "passing", passed: 1 });
  store.recordDecision({ title: "decided" });
  store.recordReview({ summary: "reviewed" });
  store.updateTask(task.id, { status: TASK_STATUS.DONE });
  store.setNextAction({ text: "next" });

  const seen = new Set(checkpoints(store));
  for (const type of Object.values(CHECKPOINT)) {
    assert.ok(seen.has(type), `${type} was never emitted`);
  }
});

test("a checkpoint summary is stored alongside the type", () => {
  const { store } = tmp();
  store.create();
  store.setNextAction({ text: "run npm test" });
  assert.equal(store.timeline()[0].summary, "run npm test");
});

test("the timeline survives a torn final line", () => {
  const { store } = tmp();
  store.create({ goal: "g" });
  store.setNextAction({ text: "first" });
  store.setNextAction({ text: "second" });

  // Simulate a crash partway through an append.
  fs.appendFileSync(store.eventsFile(), '{"ts":"2026-01-01T00:00:00.000Z","checkpo');

  const entries = store.timeline();
  assert.equal(entries.filter((e) => e.corrupt).length, 1);
  assert.equal(entries.filter((e) => e.checkpoint === CHECKPOINT.NEXT_ACTION_SET).length, 2);
});

test("a missing timeline reads as empty rather than failing", () => {
  const { store } = tmp();
  store.create(); // no goal, so no PLAN_CREATED and therefore no timeline file yet
  assert.equal(fs.existsSync(store.eventsFile()), false);

  assert.deepEqual(store.timeline(), []);

  // And a write after that recreates it cleanly.
  store.setNextAction({ text: "start" });
  assert.equal(store.timeline().length, 1);
});

test("timeline limit returns the most recent entries", () => {
  const { store } = tmp();
  store.create();
  store.setNextAction({ text: "a" });
  store.setNextAction({ text: "b" });
  store.setNextAction({ text: "c" });

  const recent = store.timeline({ limit: 2 });
  assert.equal(recent.length, 2);
  assert.deepEqual(recent.map((e) => e.summary), ["b", "c"]);
});

// ---------------------------------------------------------------------------
// summary
// ---------------------------------------------------------------------------

test("summary leads with the next action and separates open from done", () => {
  const { store } = tmp();
  store.create({ goal: "ship it", objective: "today" });
  const doing = store.addTask({ title: "in progress" });
  const todo = store.addTask({ title: "not started" });
  const done = store.addTask({ title: "finished" });
  store.updateTask(doing.id, { status: TASK_STATUS.IN_PROGRESS });
  store.updateTask(done.id, { status: TASK_STATUS.DONE });
  store.setNextAction({ text: "write the docs", taskId: doing.id });
  store.recordBlocker({ title: "still blocked" });
  store.recordBug({ title: "known bug" });
  store.recordQuestion({ question: "open question" });

  const summary = store.summary();
  assert.equal(summary.goal, "ship it");
  assert.equal(summary.nextAction.text, "write the docs");
  assert.equal(summary.inProgress.length, 1);
  assert.equal(summary.openTasks.length, 1);
  assert.equal(summary.openTasks[0].id, todo.id);
  assert.equal(summary.doneTasks.length, 1);
  assert.equal(summary.openBlockers.length, 1);
  assert.equal(summary.openBugs.length, 1);
  assert.equal(summary.openQuestions.length, 1);
});

test("summary includes only the tail of long lists", () => {
  const { store } = tmp();
  store.create();
  for (let i = 0; i < 12; i += 1) store.recordFinding({ title: `finding ${i}` });
  for (let i = 0; i < 25; i += 1) store.recordImplementation({ summary: `impl ${i}`, files: [`f${i}.js`] });

  const summary = store.summary();
  assert.equal(summary.openFindings.length, 10);
  assert.equal(summary.files.length, 20);
  assert.equal(summary.recentCheckpoints.length, 10);
});

test("summary reports how many records were dropped", () => {
  const { dir, projectRoot } = tmp("blackboard-trim");
  const small = new BlackboardStore({
    dir: path.join(dir, "state"),
    projectRoot,
    maxRecords: 3,
  });
  small.create();
  for (let i = 0; i < 10; i += 1) small.recordFinding({ title: `finding ${i}` });

  assert.equal(small.summary().openFindings.length, 3);
  assert.equal(small.summary().dropped.findings, 7);
});

// ---------------------------------------------------------------------------
// concurrency
// ---------------------------------------------------------------------------

test("concurrent writers never lose a task", async () => {
  const { dir, projectRoot } = tmp("blackboard-concurrent");
  const stateDir = path.join(dir, "state");
  const store = new BlackboardStore({ dir: stateDir, projectRoot });
  store.create({ goal: "contended" });

  const script = path.join(dir, "writer.mjs");
  fs.writeFileSync(
    script,
    `import { BlackboardStore } from ${JSON.stringify(CORE)};
const store = new BlackboardStore({ dir: ${JSON.stringify(stateDir)}, projectRoot: ${JSON.stringify(projectRoot)} });
for (let i = 0; i < 8; i += 1) store.addTask({ title: process.argv[2] + "-" + i });
`,
    "utf8",
  );

  const writers = ["alpha", "beta", "gamma", "delta"].map((name) =>
    execFileAsync(process.execPath, [script, name]),
  );
  await Promise.all(writers);

  const reopened = new BlackboardStore({ dir: stateDir, projectRoot });
  const titles = reopened.listTasks().map((t) => t.title).sort();

  assert.equal(titles.length, 32, "every concurrently-added task must survive");
  assert.equal(new Set(titles).size, 32, "no duplicates from a lost-update retry");
  assert.equal(reopened.require().counters.task, 32, "ids must be allocated without collision");
});

test("a live lock surfaces as a retryable error, not a corrupt write", () => {
  const { store } = tmp();
  store.create({ goal: "contended" });
  const before = fs.readFileSync(store.stateFile(), "utf8");
  fs.writeFileSync(store.lockFile(), "held by another writer");

  const impatient = new BlackboardStore({
    dir: store.dir,
    projectRoot: store.projectRoot,
    lockTimeoutMs: 30,
    lockStaleMs: 60_000,
  });

  assert.throws(() => impatient.addTask({ title: "blocked by lock" }), BlackboardLockedError);
  assert.equal(
    fs.readFileSync(store.stateFile(), "utf8"),
    before,
    "a refused write must leave the state file byte-identical",
  );
  assert.equal(impatient.listTasks().length, 0, "the refused task must not be recorded");
});

test("an abandoned lock is broken once it goes stale", () => {
  const { store } = tmp();
  store.create();
  const lockFile = store.lockFile();
  fs.writeFileSync(lockFile, "crashed writer");

  // Backdate the lock past the staleness threshold.
  const old = Date.now() - 60_000;
  fs.utimesSync(lockFile, new Date(old), new Date(old));

  const recovering = new BlackboardStore({
    dir: store.dir,
    projectRoot: store.projectRoot,
    lockStaleMs: 1_000,
    lockTimeoutMs: 500,
  });
  assert.equal(recovering.addTask({ title: "after recovery" }).title, "after recovery");
});

// ---------------------------------------------------------------------------
// corruption
// ---------------------------------------------------------------------------

test("a corrupt state file is reported and left untouched", () => {
  const { store } = tmp();
  store.create({ goal: "irreplaceable" });
  const file = store.stateFile();
  fs.writeFileSync(file, "{ this is not json");

  assert.throws(() => store.read(), BlackboardCorruptError);
  assert.throws(() => store.summary(), BlackboardCorruptError);
  assert.throws(() => store.addTask({ title: "must not overwrite" }), BlackboardCorruptError);
  assert.equal(fs.readFileSync(file, "utf8"), "{ this is not json", "the damaged file is preserved for inspection");
});

test("a state file that is valid JSON but the wrong shape is still corruption", () => {
  const { store } = tmp();
  store.create();
  fs.writeFileSync(store.stateFile(), "[1, 2, 3]"); // an array, not a record
  assert.throws(() => store.read(), BlackboardCorruptError);
});

test("a state file from a newer version is refused rather than coerced", () => {
  const { store } = tmp();
  store.create();
  const state = store.require();
  state.version = BLACKBOARD_VERSION + 1;
  state.someFutureField = "written by a newer build";
  fs.writeFileSync(store.stateFile(), JSON.stringify(state));

  assert.throws(() => store.read(), BlackboardCorruptError);

  // The point of refusing: the newer build's field is still there, not erased by
  // this build round-tripping a record it does not understand.
  assert.equal(JSON.parse(fs.readFileSync(store.stateFile(), "utf8")).someFutureField, "written by a newer build");
});

test("a corrupt state file does not block reading the timeline", () => {
  const { store } = tmp();
  store.create({ goal: "g" });
  store.setNextAction({ text: "recorded before the damage" });
  fs.writeFileSync(store.stateFile(), "corrupt");

  assert.throws(() => store.summary(), BlackboardCorruptError);
  assert.deepEqual(
    store.timeline().map((e) => e.summary),
    ["goal and objective recorded", "recorded before the damage"],
    "the timeline is an independent record and is still readable",
  );
});

test("an empty state file is reported as corrupt, not as empty state", () => {
  const { store } = tmp();
  store.create();
  fs.writeFileSync(store.stateFile(), "");
  assert.throws(() => store.read(), BlackboardCorruptError);
});

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

test("required text fields reject empty, whitespace-only and wrong types", () => {
  const { store } = tmp();
  store.create();

  assert.throws(() => store.addTask({}), ValidationError);
  assert.throws(() => store.addTask({ title: "" }), ValidationError);
  assert.throws(() => store.addTask({ title: "   " }), ValidationError);
  assert.throws(() => store.addTask({ title: 42 }), ValidationError);
  assert.throws(() => store.recordDecision({}), ValidationError);
  assert.throws(() => store.recordBlocker({}), ValidationError);
  assert.throws(() => store.recordBug({}), ValidationError);
  assert.throws(() => store.recordQuestion({}), ValidationError);
  assert.throws(() => store.recordAssumption({}), ValidationError);
  assert.throws(() => store.recordFinding({}), ValidationError);
  assert.throws(() => store.recordTest({}), ValidationError);
  assert.throws(() => store.recordReview({}), ValidationError);
});

test("validation errors name the field that was wrong", () => {
  const { store } = tmp();
  store.create();

  try {
    store.addTask({ title: "ok", status: "almost_done" });
    assert.fail("expected a ValidationError");
  } catch (err) {
    assert.ok(err instanceof ValidationError);
    assert.equal(err.field, "status");
    assert.equal(err.code, "invalid_argument");
  }
});

test("over-long text is rejected instead of silently truncated", () => {
  const { store } = tmp();
  store.create();
  assert.throws(() => store.addTask({ title: "x".repeat(5000) }), ValidationError);
  assert.equal(store.listTasks().length, 0);
});

test("unknown keys in a payload are dropped rather than stored", () => {
  const { store } = tmp();
  store.create();
  const task = store.addTask({
    title: "legitimate",
    injected: "should not be stored",
    __proto__: { polluted: true },
    nested: { deep: "also dropped" },
  });

  assert.equal(task.injected, undefined);
  assert.equal(task.nested, undefined);
  assert.equal(task.title, "legitimate");
  assert.equal(JSON.parse(fs.readFileSync(store.stateFile(), "utf8")).tasks[0].injected, undefined);
});

test("a list field rejects a non-array and an oversized list", () => {
  const { store } = tmp();
  store.create();
  assert.throws(() => store.addTask({ title: "t", dependsOn: "t1" }), ValidationError);
  assert.throws(() => store.recordImplementation({ summary: "s", files: new Array(100).fill("a.js") }), ValidationError);
});

test("unknown enum values are rejected rather than defaulted", () => {
  const { store } = tmp();
  store.create();
  assert.throws(() => store.recordDecision({ title: "t", kind: "vibes" }), ValidationError);
  assert.throws(() => store.recordFinding({ title: "t", source: "twitter" }), ValidationError);
  assert.throws(() => store.recordBlocker({ title: "t", severity: "spicy" }), ValidationError);
});

test("every Blackboard error carries a machine-readable code", () => {
  const { store } = tmp();
  store.create();
  try {
    store.addTask({ title: "ok", status: "nope" });
    assert.fail("expected a ValidationError");
  } catch (err) {
    assert.ok(err instanceof BlackboardError);
    assert.equal(err.code, "invalid_argument");
  }
});

// ---------------------------------------------------------------------------
// the secret boundary
// ---------------------------------------------------------------------------

test("a credential in a task title is redacted before it reaches disk", () => {
  const { store } = tmp();
  store.create();
  const secret = ["GOCSPX", "-", "A".repeat(12), "b", "C".repeat(8)].join("");
  store.addTask({ title: `fix auth using ${secret}` });

  const raw = fs.readFileSync(store.stateFile(), "utf8");
  assert.equal(raw.includes(secret), false, "the raw credential must never be persisted");
  assert.ok(raw.includes("GOCSPX-***"), "and it is replaced by the mask, not dropped");
});

test("a credential anywhere in agent-provided text is redacted", () => {
  const { store } = tmp();
  store.create();
  const token = ["gh", "p", "_", "a".repeat(30)].join("");

  store.addTask({ title: "rotate tokens", detail: `the current one is ${token}` });
  store.recordDecision({ title: "auth approach", rationale: `rejected ${token}` });
  store.recordFinding({ title: "found a leak", detail: `contains ${token}` });
  store.recordQuestion({ question: "which key?", detail: token });
  store.setNextAction({ text: `rotate ${token}` });
  store.recordImplementation({ summary: `update auth for ${token}`, files: ["src/auth.js"] });

  const raw = fs.readFileSync(store.stateFile(), "utf8");
  assert.equal(raw.includes(token), false);
  assert.ok(raw.includes("github_***"));
});

test("a bearer token in a recorded failure is redacted", () => {
  const { store } = tmp();
  store.create();
  const bearer = `Bearer ${"z".repeat(40)}`;
  store.recordTest({ suite: "unit", failed: 1, failures: [`401 ${bearer}`] });

  const raw = fs.readFileSync(store.stateFile(), "utf8");
  assert.equal(raw.includes("z".repeat(40)), false);
  assert.ok(raw.includes("Bearer ***"));
});

test("a credential in a checkpoint summary never reaches the timeline", () => {
  const { store } = tmp();
  store.create();
  const secret = ["sk", "-", "k".repeat(24)].join("");
  store.setNextAction({ text: `deploy with ${secret}` });

  const raw = fs.readFileSync(store.eventsFile(), "utf8");
  assert.equal(raw.includes(secret), false);
  assert.ok(raw.includes("sk-***"));
});

test("the raw credential never appears anywhere in the blackboard directory", () => {
  const { dir, store } = tmp();
  store.create();
  // Exactly 16 characters after AKIA, as the detector requires.
  const secret = `AKIA${"Q7ZR4M2X9T1W6Y3B"}`;
  store.recordFinding({ title: "audit", detail: secret });

  for (const name of fs.readdirSync(path.join(dir, "state"))) {
    const raw = fs.readFileSync(path.join(dir, "state", name), "utf8");
    assert.equal(raw.includes(secret), false, `${name} leaked the credential`);
  }
});

// ---------------------------------------------------------------------------
// teardown
// ---------------------------------------------------------------------------

test("destroy requires the exact blackboard id as confirmation", () => {
  const { store } = tmp();
  store.create();
  store.addTask({ title: "t" });

  assert.throws(() => store.destroy(), ValidationError);
  assert.throws(() => store.destroy({ confirm: "yes" }), ValidationError);
  assert.throws(() => store.destroy({ confirm: store.id.toUpperCase() }), ValidationError);
  assert.equal(store.exists(), true, "a failed destroy leaves the record alone");

  const removed = store.destroy({ confirm: store.id });
  assert.equal(store.exists(), false);
  assert.equal(fs.existsSync(store.eventsFile()), false);
  assert.ok(removed.length >= 2);
});

test("destroy is per project and leaves other projects intact", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aflow-destroy-"));
  const stateDir = path.join(dir, "state");
  const one = new BlackboardStore({ dir: stateDir, projectRoot: path.join(dir, "one") });
  const two = new BlackboardStore({ dir: stateDir, projectRoot: path.join(dir, "two") });
  one.create({ goal: "one" });
  two.create({ goal: "two" });

  one.destroy({ confirm: one.id });
  assert.equal(one.exists(), false);
  assert.equal(two.exists(), true);
  assert.equal(two.summary().goal, "two");
});