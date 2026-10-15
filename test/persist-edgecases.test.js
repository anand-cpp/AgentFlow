// Edge cases for src/core/persist.js: the atomic write, the read-modify-write
// lock, corruption handling, and version refusal.
//
// These four behaviours are what keep on-disk state trustworthy, and each one
// fails in a way that is silent unless a test forces the exact condition.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  writeAtomicFile,
  readJsonFile,
  assertVersion,
  appendLine,
  canBreakLock,
  withLockFile,
  LockError,
  RecordVersionError,
} from "../src/core/persist.js";

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aflow-persist-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("writeAtomicFile leaves no temp file behind", (t) => {
  const dir = tmpdir(t);
  const file = path.join(dir, "rec.json");

  writeAtomicFile(file, '{"a":1}\n');

  assert.equal(fs.readFileSync(file, "utf8"), '{"a":1}\n');
  const leftovers = fs.readdirSync(dir).filter((n) => n.endsWith(".tmp"));
  assert.deepEqual(leftovers, [], "the sibling temp file is renamed away");
});

test("readJsonFile distinguishes missing, unparseable, non-object and valid", (t) => {
  const dir = tmpdir(t);

  assert.deepEqual(readJsonFile(path.join(dir, "absent.json")), { ok: false, reason: "missing" });

  const bad = path.join(dir, "bad.json");
  fs.writeFileSync(bad, "{ not json");
  const res = readJsonFile(bad);
  assert.equal(res.ok, false);
  assert.equal(res.reason, "unparseable");
  assert.ok(res.error, "the parse error is surfaced");

  const arr = path.join(dir, "arr.json");
  fs.writeFileSync(arr, "[1,2]");
  assert.equal(readJsonFile(arr).reason, "unparseable", "a top-level array is not a record");

  const good = path.join(dir, "good.json");
  fs.writeFileSync(good, '{"version":1}');
  const ok = readJsonFile(good);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value, { version: 1 });
});

test("assertVersion accepts the supported version and refuses newer records", () => {
  assert.deepEqual(assertVersion({ version: 1 }, 1, "f.json"), { version: 1 });

  assert.throws(() => assertVersion({ version: 2 }, 1, "f.json"), RecordVersionError);
  assert.throws(() => assertVersion({ version: 2 }, 1, "f.json"), /newer than supported/);

  assert.throws(() => assertVersion({}, 1, "f.json"), /no version field/);
});

test("canBreakLock refuses fresh, changed, and unobservable locks", () => {
  const now = 100000;
  const stale = { dev: 1, ino: 7, mtimeMs: now - 60000 };
  const same = { dev: 1, ino: 7, mtimeMs: now - 60000 };

  // Stale and identity unchanged: safe to break.
  assert.equal(canBreakLock(stale, same, 1000, now), true);

  // Too recent to be abandoned.
  const freshLock = { dev: 1, ino: 7, mtimeMs: now - 10 };
  assert.equal(canBreakLock(freshLock, freshLock, 1000, now), false);

  // The file changed since observation: a new holder may be writing right now.
  const replaced = { dev: 1, ino: 7, mtimeMs: now - 60001 };
  assert.equal(canBreakLock(stale, replaced, 1000, now), false);

  // Different inode: not the same file any more.
  assert.equal(canBreakLock(stale, { dev: 1, ino: 9, mtimeMs: stale.mtimeMs }, 1000, now), false);

  // Could not be observed at all.
  assert.equal(canBreakLock(null, same, 1000, now), false);
  assert.equal(canBreakLock(stale, null, 1000, now), false);
});

test("a live lock causes a retryable LockError rather than corrupting data", (t) => {
  const dir = tmpdir(t);
  const lock = path.join(dir, "rec.lock");
  fs.writeFileSync(lock, "held", "utf8"); // brand new: reads as live

  assert.throws(
    () => withLockFile(lock, "record", () => assert.fail("must not run"), { staleMs: 60_000, timeoutMs: 60 }),
    LockError,
  );

  // The live lock is left alone for its real owner.
  assert.ok(fs.existsSync(lock));
});

test("a stale lock is broken and the work proceeds", (t) => {
  const dir = tmpdir(t);
  const lock = path.join(dir, "rec.lock");
  fs.writeFileSync(lock, "abandoned", "utf8");
  const past = new Date(Date.now() - 60000);
  fs.utimesSync(lock, past, past);

  let ran = false;
  const out = withLockFile(lock, "record", () => {
    ran = true;
    return "done";
  }, { staleMs: 1000, timeoutMs: 500 });

  assert.equal(ran, true, "the crashed holder did not wedge the record");
  assert.equal(out, "done");
  assert.ok(!fs.existsSync(lock), "the lock is released on exit");
});

test("withLockFile releases the lock even when the work throws", (t) => {
  const dir = tmpdir(t);
  const lock = path.join(dir, "rec.lock");

  assert.throws(() =>
    withLockFile(lock, "record", () => {
      throw new Error("boom");
    }),
  );
  assert.ok(!fs.existsSync(lock), "the finally path always unlinks");
});

test("appendLine appends each line durably", (t) => {
  const dir = tmpdir(t);
  const file = path.join(dir, "sub", "events.jsonl");

  appendLine(file, '{"a":1}');
  appendLine(file, '{"b":2}');

  assert.equal(fs.readFileSync(file, "utf8"), '{"a":1}\n{"b":2}\n');
});
