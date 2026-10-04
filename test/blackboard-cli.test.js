// `aflow blackboard` command tests.
//
// The store is covered in blackboard.test.js; this file covers the command layer:
// subcommand dispatch, exit codes, usage errors, flag plumbing, and -- critically
// -- that the human renderer actually runs for every subcommand. A renderer only
// executes in text mode, so a stub that never calls `renderText` would let a crash
// in the rendering path ship. Every test here calls it.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { blackboardCommand } from "../src/commands/blackboard.js";
import { BlackboardStore, BlackboardCorruptError } from "../src/core/blackboard.js";

/** Stand-in for cli/output.js that records what was rendered instead of stdout. */
function stubOut() {
  const rendered = [];
  const out = {
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
  return out;
}

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aflow-blackboard-cli-"));
  return { dir, project: fs.mkdtempSync(path.join(os.tmpdir(), "aflow-blackboard-proj-")) };
}

/**
 * `args` are positionals only -- the router has already split argv, so passing
 * "--kind x" inside `args` would test a shape the command never sees.
 */
async function run(args, { dir, project }, extraFlags = {}) {
  // The router splits argv into positionals and flags before `run` is called, so a
  // flag smuggled into `args` exercises a shape the command never sees. Fail loudly
  // rather than let it quietly pass as "the command ignored my flag".
  const smuggled = args.filter((a) => typeof a === "string" && a.startsWith("--"));
  assert.deepEqual(smuggled, [], `flags belong in the third argument, not args: ${smuggled.join(" ")}`);

  const out = stubOut();
  const returned = await blackboardCommand.run({
    args,
    flags: { "state-dir": dir, project, ...extraFlags },
    config: {},
    out,
  });
  const code = typeof returned === "number" ? returned : 0;
  return { code, out, payload: out.last().result, text: out.last().text };
}

// ---------------------------------------------------------------------------
// creation and briefing
// ---------------------------------------------------------------------------

test("no subcommand creates the blackboard and explains what to do next", async () => {
  const s = scratch();
  const { code, payload, text } = await run([], s);

  assert.equal(code, 0);
  assert.equal(payload.created, true);
  assert.match(text, /created for/);
  assert.match(text, /aflow blackboard goal/);
  assert.match(text, /aflow blackboard next/);
});

test("show after creation briefs the state instead of re-creating it", async () => {
  const s = scratch();
  await run([], s);
  const { code, payload } = await run(["show"], s);

  assert.equal(code, 0);
  assert.equal(payload.created, undefined);
  assert.equal(payload.goal, null);
  assert.ok(payload.id, "the briefing carries the blackboard id");
});

test("the briefing leads with goal, objective and next action", async () => {
  const s = scratch();
  await run([], s);
  await run(["goal", "ship", "durable", "state"], s, { objective: "blackboard" });
  await run(["next", "add", "the", "cli"], s);

  const { payload, text } = await run(["show"], s);

  assert.equal(payload.goal, "ship durable state");
  assert.equal(payload.objective, "blackboard");
  assert.equal(payload.nextAction.text, "add the cli");
  assert.match(text, /ship durable state/);
  assert.match(text, /add the cli/);
});

test("the briefing separates in-progress, open and done work", async () => {
  const s = scratch();
  await run([], s);
  await run(["task", "add", "doing"], s);
  await run(["task", "add", "waiting"], s);
  await run(["task", "add", "finished"], s);
  await run(["task", "t1"], s, { status: "in_progress" });
  await run(["task", "t3"], s, { status: "done" });

  const { payload, text } = await run(["show"], s);

  assert.equal(payload.inProgress.length, 1);
  assert.equal(payload.openTasks.length, 1);
  assert.equal(payload.openTasks[0].id, "t2");
  assert.equal(payload.doneTasks.length, 1);
  assert.match(text, /in progress \(1\)/);
  assert.match(text, /done/);
});

test("the briefing renders an empty blackboard without crashing", async () => {
  const s = scratch();
  await run(["goal", "just a goal"], s);
  const { text } = await run(["show"], s);

  assert.match(text, /just a goal/);
  assert.match(text, /not set/, "the next action line still renders when unset");
});

test("the briefing lists the sections that have content and skips the rest", async () => {
  const s = scratch();
  await run([], s);
  const { text } = await run(["show"], s);

  assert.doesNotMatch(text, /blockers/, "an empty section should not appear at all");
  assert.match(text, /state v1/);
});

// ---------------------------------------------------------------------------
// intent
// ---------------------------------------------------------------------------

test("goal joins its words and records the objective alongside", async () => {
  const s = scratch();
  await run([], s);
  const { code, payload } = await run(["goal", "ship", "it"], s, { objective: "today" });

  assert.equal(code, 0);
  assert.equal(payload.goal, "ship it");
  assert.equal(payload.objective, "today");
});

test("goal without an objective leaves the existing objective alone", async () => {
  const s = scratch();
  await run([], s);
  await run(["goal", "first", "goal"], s, { objective: "keep me" });
  await run(["goal", "second", "goal"], s);

  const { payload } = await run(["show"], s);
  assert.equal(payload.objective, "keep me");
});

test("objective records without touching the goal", async () => {
  const s = scratch();
  await run([], s);
  await run(["goal", "the", "goal"], s);
  await run(["objective", "sharper", "focus"], s);

  const { payload } = await run(["show"], s);
  assert.equal(payload.goal, "the goal");
  assert.equal(payload.objective, "sharper focus");
});

// ---------------------------------------------------------------------------
// tasks
// ---------------------------------------------------------------------------

test("task add creates a task and prints its id", async () => {
  const s = scratch();
  await run([], s);
  const { code, payload, text } = await run(["task", "add", "fix", "the", "cascade"], s, { detail: "it falls through" });

  assert.equal(code, 0);
  assert.equal(payload.task.title, "fix the cascade");
  assert.equal(payload.task.id, "t1");
  assert.match(text, /t1/);
});

test("task add forwards status, dependencies and detail", async () => {
  const s = scratch();
  await run([], s);
  await run(["task", "add", "first"], s);
  await run(["task", "add", "second"], s, { depends: "t1", status: "pending", detail: "after the first" });

  const { payload } = await run(["task", "list"], s);
  const second = payload.tasks.find((t) => t.id === "t2");
  assert.deepEqual(second.dependsOn, ["t1"]);
  assert.equal(second.detail, "after the first");
});

test("task <id> --status moves it and the transition is recorded", async () => {
  const s = scratch();
  await run([], s);
  await run(["task", "add", "implement"], s);
  const { payload } = await run(["task", "t1"], s, { status: "in_progress" });

  assert.equal(payload.task.status, "in_progress");
  const { payload: briefing } = await run(["show"], s);
  assert.ok(briefing.recentCheckpoints.some((c) => c.checkpoint === "TASK_STARTED"));
});

test("task <id> accepts several shas at once", async () => {
  const s = scratch();
  await run([], s);
  await run(["task", "add", "implement"], s);
  const { payload } = await run(["task", "t1"], s, { status: "done", commit: "abc1234,def5678" });

  assert.deepEqual(payload.task.commits, ["abc1234", "def5678"]);
});

test("task list filters by status and honours the limit", async () => {
  const s = scratch();
  await run([], s);
  for (const title of ["a", "b", "c"]) await run(["task", "add", title], s);
  await run(["task", "t2"], s, { status: "done" });

  assert.equal((await run(["task", "list"], s, { status: "done" })).payload.count, 1);
  assert.equal((await run(["task", "list"], s, { limit: "2" })).payload.count, 2);
});

test("task list renders the empty case", async () => {
  const s = scratch();
  await run([], s);
  const { code, text } = await run(["task", "list"], s);
  assert.equal(code, 0);
  assert.match(text, /no tasks yet/);
});

test("task with nothing to change is a usage error", async () => {
  const s = scratch();
  await run([], s);
  await run(["task", "add", "implement"], s);
  const { code } = await run(["task", "t1"], s);

  assert.equal(code, 2);
});

test("task with no subcommand is a usage error", async () => {
  const s = scratch();
  await run([], s);
  const { code, payload } = await run(["task"], s);

  assert.equal(code, 2);
  assert.equal(payload.error.includes("task needs a subcommand"), true);
});

// ---------------------------------------------------------------------------
// decisions, blockers, bugs, findings
// ---------------------------------------------------------------------------

test("decide records the kind and rationale", async () => {
  const s = scratch();
  await run([], s);
  const { payload, text } = await run(["decide", "two", "files", "not", "one"], s, {
    kind: "architecture",
    rationale: "the state doc is bounded",
    alternatives: "one document,sqlite",
  });

  assert.equal(payload.decision.kind, "architecture");
  assert.deepEqual(payload.decision.alternatives, ["one document", "sqlite"]);
  assert.match(text, /architecture/);
});

test("decide --supersedes retires the earlier decision", async () => {
  const s = scratch();
  await run([], s);
  await run(["decide", "use", "json"], s);
  const { payload } = await run(["decide", "use", "jsonl"], s, { supersedes: "d1" });

  assert.equal(payload.decision.supersedes, "d1");
  assert.equal(payload.decision.status, "active");
});

test("block marks its task blocked", async () => {
  const s = scratch();
  await run([], s);
  await run(["task", "add", "finish", "the", "feature"], s);
  const { payload, text } = await run(["block", "waiting", "on", "upstream"], s, { task: "t1", severity: "high" });

  assert.equal(payload.blocker.taskId, "t1");
  assert.match(text, /blocked b1/);
  assert.equal((await run(["show"], s)).payload.openTasks[0].status, "blocked");
});

test("unblock records the resolution", async () => {
  const s = scratch();
  await run([], s);
  await run(["block", "flaky", "test"], s);
  const { payload } = await run(["unblock", "b1", "pinned", "the", "dependency"], s);

  assert.equal(payload.blocker.status, "resolved");
  assert.equal(payload.blocker.resolution, "pinned the dependency");
});

test("bug then fix records both ends of the lifecycle", async () => {
  const s = scratch();
  await run([], s);
  await run(["bug", "off", "by", "one"], s, { severity: "high" });
  const { payload } = await run(["fix", "k1", "recomputed", "the", "bound"], s);

  assert.equal(payload.bug.status, "fixed");
  assert.equal((await run(["show"], s)).payload.openBugs.length, 0);
});

test("finding records its source and files", async () => {
  const s = scratch();
  await run([], s);
  const { payload } = await run(["finding", "duplicate", "helper"], s, {
    source: "reviewer",
    severity: "medium",
    files: "src/core/persist.js",
  });

  assert.equal(payload.finding.source, "reviewer");
  assert.deepEqual(payload.finding.files, ["src/core/persist.js"]);
});

test("review records the cleared gate", async () => {
  const s = scratch();
  await run([], s);
  const { payload } = await run(["review", "reviewed", "the", "store"], s, { verdict: "approve" });

  assert.equal(payload.review.verdict, "approve");
  assert.ok((await run(["show"], s)).payload.recentCheckpoints.some((c) => c.checkpoint === "REVIEW_COMPLETED"));
});

test("note records an open question", async () => {
  const s = scratch();
  await run([], s);
  const { payload } = await run(["note", "which", "provider"], s);

  assert.equal(payload.question.question, "which provider");
  assert.equal((await run(["show"], s)).payload.openQuestions.length, 1);
});

// ---------------------------------------------------------------------------
// tests, implementation, next action
// ---------------------------------------------------------------------------

test("test records counts and marks a clean run as passing", async () => {
  const s = scratch();
  await run([], s);
  const { payload, text } = await run(["test", "unit"], s, { passed: 261, failed: 0, command: "npm test" });

  assert.equal(payload.test.passed, 261);
  assert.match(text, /261 passed/);
  assert.ok((await run(["show"], s)).payload.recentCheckpoints.some((c) => c.checkpoint === "TEST_PASSED"));
});

test("test with failures surfaces them in the output", async () => {
  const s = scratch();
  await run([], s);
  const { payload, text } = await run(["test", "unit"], s, { passed: 2, failed: 1 });

  assert.equal(payload.test.failed, 1);
  assert.match(text, /2 passed, 1 failed/);
  assert.ok((await run(["show"], s)).payload.recentCheckpoints.some((c) => c.checkpoint === "TEST_FAILED"));
});

test("test defaults its suite when none is given", async () => {
  const s = scratch();
  await run([], s);
  const { payload } = await run(["test"], s, { passed: 1 });
  assert.equal(payload.test.suite, "tests");
});

test("implemented records the files and commits as references", async () => {
  const s = scratch();
  await run([], s);
  const { payload, text } = await run(["implemented", "added", "the", "store"], s, {
    files: "src/core/blackboard.js,test/blackboard.test.js",
    commit: "abc1234",
  });

  assert.deepEqual(payload.files, ["src/core/blackboard.js", "test/blackboard.test.js"]);
  assert.deepEqual(payload.commits, ["abc1234"]);
  assert.match(text, /files\s+2/);
});

test("next records the handoff field", async () => {
  const s = scratch();
  await run([], s);
  await run(["task", "add", "finish"], s);
  const { payload, text } = await run(["next", "write", "the", "docs"], s, { task: "t1" });

  assert.equal(payload.nextAction.text, "write the docs");
  assert.equal(payload.nextAction.taskId, "t1");
  assert.match(text, /write the docs/);
});

// ---------------------------------------------------------------------------
// sessions, timeline, destroy
// ---------------------------------------------------------------------------

test("link records session ids and reports an already-linked one", async () => {
  const s = scratch();
  await run([], s);
  const first = await run(["link", "ses_20261004T080615614Z_0ter6m"], s);
  assert.deepEqual(first.payload.linked, ["ses_20261004T080615614Z_0ter6m"]);

  const again = await run(["link", "ses_20261004T080615614Z_0ter6m"], s);
  assert.deepEqual(again.payload.linked, []);
  assert.match(again.text, /already linked/);
});

test("link with no id is a usage error", async () => {
  const s = scratch();
  await run([], s);
  const { code } = await run(["link"], s);
  assert.equal(code, 2);
});

test("timeline prints checkpoints newest last", async () => {
  const s = scratch();
  await run([], s);
  await run(["next", "first"], s);
  await run(["next", "second"], s);
  const { code, payload, text } = await run(["timeline"], s);

  assert.equal(code, 0);
  assert.equal(payload.count, 2);
  assert.match(text, /NEXT_ACTION_SET/);
  assert.match(text, /second/);
});

test("timeline renders the empty case", async () => {
  const s = scratch();
  await run([], s);
  const { text } = await run(["timeline"], s);
  assert.match(text, /no checkpoints yet/);
});

// ---------------------------------------------------------------------------
// exit codes and error propagation
// ---------------------------------------------------------------------------

test("an unknown subcommand is a usage error and prints the usage text", async () => {
  const s = scratch();
  const { code, payload, text } = await run(["nonsense"], s);

  assert.equal(code, 2);
  assert.match(payload.error, /unknown subcommand: nonsense/);
  assert.match(text, /aflow blackboard \[show\|list\]/);
});

test("a subcommand missing its required text is a usage error", async () => {
  const s = scratch();
  await run([], s);

  for (const sub of ["goal", "objective", "next", "decide", "block", "bug", "finding", "review", "note"]) {
    const { code } = await run([sub], s);
    assert.equal(code, 2, `${sub} should reject missing text`);
  }
});

test("a write against a missing blackboard creates it instead of failing", async () => {
  const s = scratch();
  // Deliberately no bare `aflow blackboard` first: making the user run a
  // no-argument command before every other one is a rule nobody will remember.
  const { code, payload } = await run(["task", "add", "first thing"], s);

  assert.equal(code, 0);
  assert.equal(payload.task.title, "first thing");
  const store = new BlackboardStore({ dir: s.dir, projectRoot: s.project });
  assert.equal(store.exists(), true);
  assert.equal(store.summary().goal, null);
});

test("read-only subcommands report an absent blackboard without failing", async () => {
  const s = scratch();

  const tasks = await run(["task", "list"], s);
  assert.equal(tasks.code, 0);
  assert.match(tasks.text, /no blackboard yet/);

  const timeline = await run(["timeline"], s);
  assert.equal(timeline.code, 0);
  assert.match(timeline.text, /no checkpoints yet/);
});

test("a rejected value exits 2 and names the field the store objected to", async () => {
  const s = scratch();
  await run([], s);
  await run(["task", "add", "a"], s);
  const { code, payload } = await run(["task", "t1"], s, { status: "nonsense" });

  // A ValidationError is the caller being wrong, not the stored state being wrong,
  // so it is a usage mistake: exit 2 with the store's own wording intact.
  assert.equal(code, 2);
  assert.equal(payload.error.includes("status"), true, `expected the message to name the field, got: ${payload.error}`);
});

test("a corrupt blackboard propagates rather than being reported as usage", async () => {
  const s = scratch();
  await run([], s);
  const store = new BlackboardStore({ dir: s.dir, projectRoot: s.project });
  fs.writeFileSync(store.stateFile(), "corrupt");

  await assert.rejects(() => run(["show"], s), (err) => {
    assert.ok(err instanceof BlackboardCorruptError);
    return true;
  });
});

test("destroy refuses without the exact id and succeeds with it", async () => {
  const s = scratch();
  await run([], s);
  const store = new BlackboardStore({ dir: s.dir, projectRoot: s.project });
  store.addTask({ title: "irreplaceable" });

  // No confirm token at all, then a wrong one, then the real id.
  assert.equal((await run(["destroy"], s)).code, 2);
  assert.equal((await run(["destroy"], s, { confirm: "wrong" })).code, 2);
  assert.equal(store.exists(), true, "a refused destroy must not delete anything");

  const { code } = await run(["destroy"], s, { confirm: store.id });
  assert.equal(code, 0);
  assert.equal(store.exists(), false);
});

// ---------------------------------------------------------------------------
// registration and help
// ---------------------------------------------------------------------------

test("the command is registered so --help lists it", async () => {
  const { getCommand } = await import("../src/cli/registry.js");
  await import("../src/commands/blackboard.js");

  const command = getCommand("blackboard");
  assert.ok(command, "blackboard must be reachable from the registry");
  assert.match(command.summary, /workflow state/);
  assert.match(command.usage, /aflow blackboard/);
  assert.match(command.usage, /--json/);
  assert.match(command.usage, /Credentials are redacted/);
});

test("the help text explains itself without needing the source", async () => {
  // Every subcommand reachable in the dispatcher must be discoverable in usage.
  // This is the test that catches a new subcommand added to the switch but
  // forgotten in the help, which is the usual way a CLI rots.
  const usage = blackboardCommand.usage;
  for (const sub of [
    "goal",
    "objective",
    "task",
    "decide",
    "block",
    "unblock",
    "bug",
    "fix",
    "finding",
    "review",
    "note",
    "test",
    "implemented",
    "next",
    "link",
    "timeline",
    "destroy",
  ]) {
    assert.match(usage, new RegExp(`aflow blackboard ${sub}\\b`), `${sub} is undocumented`);
  }
  // show/list are aliases shown as one group on the first usage line.
  assert.match(usage, /aflow blackboard \[show\|list\]/);
});