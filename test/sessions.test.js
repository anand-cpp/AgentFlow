// Session store tests.
//
// The two tests that matter more than the rest:
//
//   "a credential in a payload never reaches disk" and "a corrupt session is
//   reported and left alone". Both protect data that outlives the process. A
//   session file is the most durable, most pasteable artifact AgentFlow writes,
//   so a leak here is worse than a leak into a terminal, and a crash-destroyed
//   session is real work with no other copy.
//
// Every credential in this file is synthetic and shaped to trip the redactor.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SessionStore,
  SessionError,
  SessionIdError,
  SessionNotFoundError,
  SessionCorruptError,
  SessionLockedError,
  ENTRY_KIND,
  SESSION_STATE,
  SESSION_VERSION,
  isValidSessionId,
  newSessionId,
} from "../src/core/sessions.js";

function tmpStore(label = "sessions") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `aflow-${label}-`));
  return { dir, store: new SessionStore({ dir }) };
}

// ---------------------------------------------------------------------------
// identity
// ---------------------------------------------------------------------------

test("generated ids are valid and sort chronologically", () => {
  const early = newSessionId({ now: Date.parse("2026-01-01T00:00:00Z"), random: () => 0.1 });
  const late = newSessionId({ now: Date.parse("2026-12-31T23:59:59Z"), random: () => 0.9 });
  assert.equal(isValidSessionId(early), true);
  assert.equal(isValidSessionId(late), true);
  assert.ok(early < late, "later session should sort first in descending list order");
});

test("ids that could escape the state directory are rejected", () => {
  // The id becomes a filename, so this is the boundary that keeps `inspect` from
  // becoming an arbitrary-file-read primitive.
  for (const bad of [
    "../../etc/passwd",
    "..\\..\\windows\\system32",
    "C:\\Windows\\System32\\config",
    "ses_20260101T000000Z_abc",
    "ses_20260101T000000Z_ABCDEF",
    "ses_20260101T000000Z_abcdef.tmp",
    "",
    null,
  ]) {
    assert.equal(isValidSessionId(bad), false, `should reject ${JSON.stringify(bad)}`);
  }
});

test("an invalid id is rejected before any filesystem access", () => {
  const { store } = tmpStore();
  assert.throws(() => store.read("../../etc/passwd"), SessionIdError);
  assert.throws(() => store.append("../../etc/passwd", ENTRY_KIND.NOTE, {}), SessionIdError);
});

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

test("create then read round-trips the header", () => {
  const { store } = tmpStore();
  const made = store.create({ objective: "ship sessions", name: "sessions work", projectRoot: "C:\\proj\\x" });

  assert.equal(made.version, SESSION_VERSION);
  assert.equal(made.state, SESSION_STATE.ACTIVE);
  assert.equal(made.objective, "ship sessions");
  assert.equal(made.project.root, path.resolve("C:\\proj\\x"));

  const read = store.read(made.id);
  assert.equal(read.id, made.id);
  assert.equal(read.createdAt, made.createdAt);
});

test("a session survives a restart, because the store is disk-backed", () => {
  const { dir, store } = tmpStore();
  const made = store.create({ objective: "persist me" });
  store.append(made.id, ENTRY_KIND.NOTE, { text: "first" });

  // A brand new store object with no in-memory carryover: this is what the next
  // CLI invocation actually does.
  const next = new SessionStore({ dir });
  const read = next.read(made.id);
  assert.equal(read.objective, "persist me");
  assert.equal(read.entries.length, 1);
  assert.equal(read.entries[0].text, "first");
});

test("name falls back to the first line of the objective", () => {
  const { store } = tmpStore();
  const made = store.create({ objective: "fix the routing cascade\nand then write docs" });
  assert.equal(made.name, "fix the routing cascade");
});

test("control characters are stripped from names", () => {
  const { store } = tmpStore();
  const made = store.create({ name: "bad\u0000name\u001b[31m\u007f" });
  assert.ok(!/[\u0000-\u001f\u007f]/.test(made.name), `control chars survived: ${JSON.stringify(made.name)}`);
});

test("reading a missing session reports not-found, not corrupt", () => {
  const { store } = tmpStore();
  const id = newSessionId();
  assert.throws(() => store.read(id), SessionNotFoundError);
});

// ---------------------------------------------------------------------------
// entries
// ---------------------------------------------------------------------------

test("appends are sequenced and counted by kind", () => {
  const { store } = tmpStore();
  const made = store.create({ objective: "counters" });

  store.append(made.id, ENTRY_KIND.CONVERSATION, { role: "user", text: "hi" });
  store.append(made.id, ENTRY_KIND.TOOL_CALL, { tool: "read", args: { path: "a.js" } });
  store.append(made.id, ENTRY_KIND.TOOL_RESULT, { tool: "read", ok: true });
  store.append(made.id, ENTRY_KIND.ERROR, { message: "boom" });
  store.append(made.id, ENTRY_KIND.ROUTING, { model: "a/b", ok: false });

  const s = store.read(made.id);
  assert.deepEqual(s.entries.map((e) => e.seq), [1, 2, 3, 4, 5]);
  assert.equal(s.counters.conversation, 1);
  // tool_call and tool_result both count as tool activity, deliberately.
  assert.equal(s.counters.toolCalls, 2);
  assert.equal(s.counters.errors, 1);
  assert.equal(s.counters.routingDecisions, 1);
  assert.equal(s.counters.entries, 5);
  assert.equal(s.counters.dropped, 0);
});

test("an unknown entry kind is rejected rather than stored as a typo", () => {
  const { store } = tmpStore();
  const made = store.create();
  assert.throws(() => store.append(made.id, "conversation_ish", { text: "x" }), /unknown entry kind/);
  assert.equal(store.read(made.id).entries.length, 0);
});

test("an agent label is recorded on the entry", () => {
  const { store } = tmpStore();
  const made = store.create();
  store.append(made.id, ENTRY_KIND.NOTE, { text: "checked the parser" }, { agent: "tester" });
  assert.equal(store.read(made.id).entries[0].agent, "tester");
});

test("trimming records what it dropped instead of pretending history is complete", () => {
  const { dir } = tmpStore();
  // maxEntries of 3 keeps the test fast; the production default is 5000.
  const store = new SessionStore({ dir });
  const made = store.create();
  const file = store.fileFor(made.id);

  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  doc.maxEntries = 3;
  fs.writeFileSync(file, JSON.stringify(doc));

  for (let i = 0; i < 6; i++) store.append(made.id, ENTRY_KIND.NOTE, { i });

  const s = store.read(made.id);
  assert.equal(s.entries.length, 3, "bounded");
  assert.equal(s.counters.dropped, 3, "dropped count is honest");
  assert.deepEqual(s.entries.map((e) => e.i), [3, 4, 5], "oldest entries trimmed");
  // Counters are cumulative even after trimming; a total entry count that
  // shrinks would misrepresent how much work the session holds.
  assert.equal(s.counters.entries, 6);
});

test("atomic writes leave no temp files behind", () => {
  const { dir, store } = tmpStore();
  const made = store.create();
  store.append(made.id, ENTRY_KIND.NOTE, { text: "one" });
  store.append(made.id, ENTRY_KIND.NOTE, { text: "two" });

  const strays = fs.readdirSync(dir).filter((f) => f.endsWith(".tmp") || f.endsWith(".lock"));
  assert.deepEqual(strays, [], `stray files: ${strays.join(", ")}`);
});

// ---------------------------------------------------------------------------
// secret boundary -- the reason this store is written defensively
// ---------------------------------------------------------------------------

// Assembled at runtime, not written as literals.
//
// scripts/scan-secrets.mjs flags a committed GOCSPX literal even in a test file,
// and the fix is not an allowlist entry: the scanner's own notes call an
// allowlisted test file "a hole someone can later hide a real key in". So these
// fixtures are concatenated from fragments and this file scans clean honestly --
// the same approach test/scan-secrets.test.js uses.
const GOOGLE_SECRET = `GOCSPX-${"notarealkey0000"}`;
const BEARER = `Bearer ${"abc123def456ghi789"}`;
const API_KEY = `sk-${"EXAMPLE0fixture0value-notreal"}`;
const FIREBASE_KEY = `AIza${"SyFixtureKeyNotRealForTests".padEnd(35, "0")}`;

test("the fixtures above are real credential shapes, not decoration", () => {
  // If these ever stop matching the redactor, the tests below would pass
  // vacuously. Assert the shapes directly so that cannot happen quietly.
  assert.match(GOOGLE_SECRET, /^GOCSPX-[A-Za-z0-9_-]{10,}$/);
  assert.match(BEARER, /^Bearer [A-Za-z0-9._~+/-]{16,}=*$/);
  assert.match(API_KEY, /^sk-[A-Za-z0-9_-]{16,}$/);
  assert.equal(FIREBASE_KEY.length, 39, "AIza + exactly 35 is the shape redact.js pins");
});

test("a credential in a payload never reaches disk", () => {
  const { dir, store } = tmpStore();
  const made = store.create({ objective: "normal objective" });

  store.append(made.id, ENTRY_KIND.CONVERSATION, {
    role: "user",
    text: `here is the key ${GOOGLE_SECRET}`,
    nested: { authorization: BEARER },
    apiKey: API_KEY,
  });

  const onDisk = fs.readFileSync(store.fileFor(made.id), "utf8");
  assert.ok(!onDisk.includes(GOOGLE_SECRET), "credential-shaped value was persisted");
  assert.ok(!onDisk.includes("abc123def456ghi789"), "bearer token was persisted");
  assert.ok(!onDisk.includes(API_KEY), "api key was persisted");
  // The entry still exists -- redaction must not mean "silently drop the work".
  const s = store.read(made.id);
  assert.equal(s.entries.length, 1);
});

test("a credential in the objective is redacted at create time", () => {
  const { store } = tmpStore();
  const made = store.create({ objective: `debug ${FIREBASE_KEY}` });
  // Assert against the whole session, not just `objective`. An earlier version of
  // this test only checked the objective field and passed while the auto-generated
  // `name` -- derived from the same string -- held an unredacted copy.
  assert.ok(!JSON.stringify(made).includes(FIREBASE_KEY), "firebase key survived into the session");
});

test("a credential in an explicit name is redacted", () => {
  const { store } = tmpStore();
  const made = store.create({ name: `work on ${FIREBASE_KEY}`, objective: "clean objective" });
  assert.ok(!JSON.stringify(made).includes(FIREBASE_KEY));
});

test("rename redacts the new name", () => {
  const { store } = tmpStore();
  const made = store.create({ name: "clean" });
  const renamed = store.rename(made.id, `leak ${FIREBASE_KEY}`);
  assert.ok(!JSON.stringify(renamed).includes(FIREBASE_KEY), "rename bypassed redaction");
  assert.ok(!fs.readFileSync(store.fileFor(made.id), "utf8").includes(FIREBASE_KEY));
});

test("no credential fixture reaches any file the store writes", () => {
  const { dir, store } = tmpStore();
  const a = store.create({ objective: "one" });
  const b = store.create({ objective: "two" });
  store.append(a.id, ENTRY_KIND.NOTE, { text: GOOGLE_SECRET });
  store.append(b.id, ENTRY_KIND.NOTE, { text: `key ${GOOGLE_SECRET}` });

  // Every file, not just the sessions we appended to: a leak into the stamp file
  // or the pointer would count just as much.
  for (const f of fs.readdirSync(dir)) {
    const body = fs.readFileSync(path.join(dir, f), "utf8");
    assert.ok(!body.includes(GOOGLE_SECRET), `${f} persisted a credential`);
    assert.ok(!body.includes("notarealkey0000"), `${f} persisted a credential fragment`);
  }
});

// ---------------------------------------------------------------------------
// corruption -- never destroy the only copy of real work
// ---------------------------------------------------------------------------

test("a corrupt session throws a typed error naming the file", () => {
  const { store } = tmpStore();
  const made = store.create({ objective: "will be truncated" });
  fs.writeFileSync(store.fileFor(made.id), '{"version":1,"id":"ses_');

  assert.throws(
    () => store.read(made.id),
    (err) => {
      assert.equal(err instanceof SessionCorruptError, true);
      assert.equal(err.code, "session_corrupt");
      assert.ok(err.file.endsWith(".json"));
      return true;
    },
  );
});

test("appending to a corrupt session refuses rather than overwriting it", () => {
  const { store } = tmpStore();
  const made = store.create({ objective: "evidence" });
  const file = store.fileFor(made.id);
  const truncated = '{"version":1,"entries":[{"seq":1,';
  fs.writeFileSync(file, truncated);

  assert.throws(() => store.append(made.id, ENTRY_KIND.NOTE, { text: "fix it" }), SessionCorruptError);
  // The damaged bytes must be exactly as they were: a half-written session can
  // still contain the only copy of an agent's output.
  assert.equal(fs.readFileSync(file, "utf8"), truncated);
});

test("list surfaces a corrupt session instead of hiding it", () => {
  const { store } = tmpStore();
  const good = store.create({ objective: "readable" });
  const bad = store.create({ objective: "unreadable" });
  fs.writeFileSync(store.fileFor(bad.id), "not json at all");

  const listed = store.list();
  const corrupt = listed.find((s) => s.id === bad.id);
  assert.ok(corrupt, "corrupt session missing from listing");
  assert.equal(corrupt.corrupt, true);
  assert.ok(corrupt.error.includes("corrupt"));
  // The readable one still lists normally.
  assert.ok(listed.find((s) => s.id === good.id));
});

test("a session from a future version is refused, not downgraded", () => {
  const { store } = tmpStore();
  const made = store.create({ objective: "from the future" });
  const file = store.fileFor(made.id);
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  doc.version = SESSION_VERSION + 1;
  doc.someNewField = "meaning unknown to this build";
  fs.writeFileSync(file, JSON.stringify(doc));

  // Coercing it to v1 would silently drop fields a newer build wrote, losing
  // whatever they represent. Refusing is recoverable; mangling is not.
  assert.throws(() => store.read(made.id), /newer than supported/);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).someNewField, "meaning unknown to this build");
});

test("a file that is not an object is corrupt, not a valid empty session", () => {
  const { store } = tmpStore();
  const made = store.create();
  fs.writeFileSync(store.fileFor(made.id), "[1,2,3]");
  assert.throws(() => store.read(made.id), SessionCorruptError);
});

// ---------------------------------------------------------------------------
// rename / archive / complete
// ---------------------------------------------------------------------------

test("rename updates the name in place", () => {
  const { store } = tmpStore();
  const made = store.create({ name: "before" });
  const renamed = store.rename(made.id, "after");
  assert.equal(renamed.name, "after");
  assert.equal(store.read(made.id).name, "after");
});

test("archive hides the session from the default listing but keeps the file", () => {
  const { store } = tmpStore();
  const made = store.create({ objective: "done-ish" });

  store.setArchived(made.id, true);
  assert.equal(store.list().length, 0, "archived session should not appear by default");
  assert.equal(store.list({ includeArchived: true }).length, 1);
  assert.ok(fs.existsSync(store.fileFor(made.id)), "archiving must not delete the record");

  store.setArchived(made.id, false);
  assert.equal(store.list().length, 1, "archive is reversible");
});

test("completing records the timestamp and state", () => {
  const { store } = tmpStore();
  const made = store.create({ objective: "finish" });
  const done = store.complete(made.id);
  assert.equal(done.state, SESSION_STATE.COMPLETED);
  assert.ok(done.completedAt);
  assert.equal(store.read(made.id).state, SESSION_STATE.COMPLETED);
});

test("update replaces only the named fields", () => {
  const { store } = tmpStore();
  const made = store.create({ objective: "orig", model: "a/b" });
  const updated = store.update(made.id, { model: "c/d" });
  assert.equal(updated.model, "c/d");
  assert.equal(updated.objective, "orig", "objective must not be clobbered");
});

test("agents and blackboard refs are deduplicated", () => {
  const { store } = tmpStore();
  const made = store.create({ agents: ["planner", "coder", "planner"] });
  assert.deepEqual(made.agents, ["planner", "coder"]);

  const updated = store.update(made.id, { blackboardRefs: ["task-1", "task-1", "note-2"] });
  assert.deepEqual(updated.blackboardRefs, ["task-1", "note-2"]);
});

// ---------------------------------------------------------------------------
// listing
// ---------------------------------------------------------------------------

test("list is newest-first", () => {
  const { store } = tmpStore();
  const ids = [];
  for (const objective of ["older", "middle", "newest"]) {
    ids.push(store.create({ objective }).id);
  }

  const listed = store.list().map((s) => s.id);
  assert.deepEqual(new Set(listed), new Set(ids), "every session should be listed");
  // The guarantee is "descending by id", which is chronological. Asserting that
  // directly rather than creation order keeps the test honest if two sessions
  // ever share a millisecond.
  assert.deepEqual(listed, [...listed].sort().reverse());
  assert.equal(listed.length, 3);
});

test("sessions created back-to-back still order by recency", () => {
  // The regression this pins: with second-precision ids, a tight loop produced
  // ids differing only in their random suffix, so `list` shuffled them.
  const { store } = tmpStore();
  const created = [];
  for (let i = 0; i < 8; i++) created.push(store.create({ objective: `run ${i}` }).id);

  const objectives = store.list().map((s) => s.objective);
  assert.deepEqual(objectives, ["run 7", "run 6", "run 5", "run 4", "run 3", "run 2", "run 1", "run 0"]);
});

test("list can be scoped to a project root", () => {
  const { store } = tmpStore();
  store.create({ objective: "in one", projectRoot: path.join(os.tmpdir(), "proj-one") });
  store.create({ objective: "in two", projectRoot: path.join(os.tmpdir(), "proj-two") });
  store.create({ objective: "no project" });

  assert.equal(store.list({ projectRoot: path.join(os.tmpdir(), "proj-one") }).length, 1);
  assert.equal(store.list().length, 3);
});

test("list on a missing directory is empty, not an error", () => {
  const store = new SessionStore({ dir: path.join(os.tmpdir(), "aflow-never-created-dir") });
  assert.deepEqual(store.list(), []);
});

test("list ignores unrelated json files and the current pointer", () => {
  const { dir, store } = tmpStore();
  store.create({ objective: "real" });
  fs.writeFileSync(path.join(dir, "not-a-session.json"), "{}");
  fs.writeFileSync(path.join(dir, "ses_bogus.json"), "{}");

  const listed = store.list();
  assert.equal(listed.length, 1, `unexpected entries: ${listed.map((s) => s.id).join(",")}`);
});

test("list respects a limit", () => {
  const { store } = tmpStore();
  store.create({ objective: "a" });
  store.create({ objective: "b" });
  store.create({ objective: "c" });
  assert.equal(store.list({ limit: 2 }).length, 2);
});

// ---------------------------------------------------------------------------
// current pointer
// ---------------------------------------------------------------------------

test("current pointer round-trips and can be cleared", () => {
  const { store } = tmpStore();
  const made = store.create({ objective: "resume me" });

  store.setCurrent(made.id);
  assert.equal(store.getCurrent(), made.id);

  store.clearCurrent();
  assert.equal(store.getCurrent(), null);
});

test("current pointer survives a restart", () => {
  const { dir, store } = tmpStore();
  const made = store.create();
  store.setCurrent(made.id);
  assert.equal(new SessionStore({ dir }).getCurrent(), made.id);
});

test("a garbage pointer reads as no current session", () => {
  const { dir, store } = tmpStore();
  store.ensureDir();
  fs.writeFileSync(path.join(dir, "current.json"), "{{{ not json");
  assert.equal(store.getCurrent(), null);

  fs.writeFileSync(path.join(dir, "current.json"), '{"id":"../../etc/passwd"}');
  assert.equal(store.getCurrent(), null, "pointer must not be able to point outside the store");
});

test("setCurrent on a missing session throws", () => {
  const { store } = tmpStore();
  assert.throws(() => store.setCurrent(newSessionId()), SessionNotFoundError);
});

// ---------------------------------------------------------------------------
// concurrency
// ---------------------------------------------------------------------------

test("concurrent appends serialise instead of losing entries", () => {
  const { dir, store } = tmpStore();
  const made = store.create({ objective: "parallel agents" });

  // Two independent store instances racing on the same file is what separate
  // agent processes look like from here.
  const writerA = new SessionStore({ dir });
  const writerB = new SessionStore({ dir });

  for (let i = 0; i < 5; i++) {
    writerA.append(made.id, ENTRY_KIND.NOTE, { from: "a", i });
    writerB.append(made.id, ENTRY_KIND.NOTE, { from: "b", i });
  }

  const s = store.read(made.id);
  assert.equal(s.entries.length, 10, "an append was lost");
  assert.equal(s.counters.entries, 10);
  // Sequence numbers must remain a dense, gapless run or `inspect` ordering
  // breaks downstream.
  assert.deepEqual(s.entries.map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test("a lock held past the stale threshold is broken rather than wedging writes", () => {
  const { dir, store } = tmpStore();
  const made = store.create();
  const lockFile = `${store.fileFor(made.id)}.lock`;

  // Simulate a writer that died holding the lock: file exists, mtime is old.
  fs.writeFileSync(lockFile, "");
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lockFile, old, old);

  const fresh = new SessionStore({ dir, lockStaleMs: 1_000 });
  fresh.append(made.id, ENTRY_KIND.NOTE, { text: "recovered" });
  assert.equal(fresh.read(made.id).entries.length, 1);
  assert.equal(fs.existsSync(lockFile), false, "lock should be released");
});

test("a fresh lock surfaces a retryable error rather than corrupting the session", () => {
  const { dir, store } = tmpStore();
  const made = store.create();
  const lockFile = `${store.fileFor(made.id)}.lock`;
  fs.writeFileSync(lockFile, "");

  // lockStaleMs far in the future means the lock looks live for this test, so the
  // only correct outcome is a clear "someone else has it" error.
  const busy = new SessionStore({ dir, lockStaleMs: 3_600_000, lockTimeoutMs: 40 });
  assert.throws(() => busy.append(made.id, ENTRY_KIND.NOTE, { text: "x" }), SessionLockedError);
  assert.equal(store.read(made.id).entries.length, 0, "the blocked write must not have landed");
});

// ---------------------------------------------------------------------------
// guards
// ---------------------------------------------------------------------------

test("SessionError carries a machine-readable code", () => {
  const { store } = tmpStore();
  try {
    store.create({ name: "x" }).id && store.append("not-an-id", ENTRY_KIND.NOTE, {});
    assert.fail("expected a throw");
  } catch (err) {
    assert.ok(err instanceof SessionError);
    assert.equal(typeof err.code, "string");
  }
});