// Tests for the durable-write primitives in src/core/persist.js.
//
// The lock tests here exist because of a real data-loss bug, not for coverage's
// sake. `withLockFile` used to treat "I could not stat the lock" as "the lock is
// stale" and unlink it. That is wrong twice over: a lock that cannot be read
// has not been shown to be abandoned, and the file sitting at that path by the
// time we unlink may be one a *different* writer acquired in between. Deleting a
// live writer's lock lets two writers into one read-modify-write, and the losing
// update disappears with no error anywhere -- which is exactly what happened to
// 2 of 32 concurrently added Blackboard tasks in CI.
//
// `canBreakLock` is the decision the fix is made of, so it is tested directly:
// the interleaving that triggers the bug is a few microseconds wide and cannot
// be forced from a test, but the rule that prevents it is a pure function.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { withLockFile, canBreakLock, LockError } from "../src/core/persist.js";

function tmp(label = "persist") {
  return fs.mkdtempSync(path.join(os.tmpdir(), `aflow-${label}-`));
}

// --- canBreakLock: the rule that prevents the lost update --------------------

const STALE_MS = 1_000;
const OLD = 1_700_000_000_000;
const NOW = OLD + 60_000;

test("a lock that could not be observed is never broken", () => {
  // The regression. `observed === null` means statSync failed, i.e. the lock was
  // gone at that instant. Absence is not evidence of abandonment: the previous
  // holder may simply have released and a new one acquired before we looked.
  assert.equal(canBreakLock(null, null, STALE_MS, NOW), false);
  assert.equal(canBreakLock(null, { dev: 1, ino: 1, mtimeMs: OLD }, STALE_MS, NOW), false);
  assert.equal(canBreakLock({ dev: 1, ino: 1, mtimeMs: OLD }, null, STALE_MS, NOW), false);
});

test("a lock that was replaced since the observation is never broken", () => {
  // Same path, same age, different file: the holder we judged stale has gone and
  // somebody else holds the lock now. Unlinking would hand out a second copy of
  // a lock that is very much in use.
  const observed = { dev: 1, ino: 7, mtimeMs: OLD };
  assert.equal(canBreakLock(observed, { dev: 1, ino: 8, mtimeMs: OLD }, STALE_MS, NOW), false);
  assert.equal(canBreakLock(observed, { dev: 2, ino: 7, mtimeMs: OLD }, STALE_MS, NOW), false);
  assert.equal(canBreakLock(observed, { dev: 1, ino: 7, mtimeMs: OLD + 1 }, STALE_MS, NOW), false);
});

test("a live lock is waited for, never broken", () => {
  const fresh = { dev: 1, ino: 7, mtimeMs: NOW };
  assert.equal(canBreakLock(fresh, fresh, STALE_MS, NOW), false);
  // Exactly at the threshold is still live: `>` is the only thing that breaks.
  assert.equal(canBreakLock({ dev: 1, ino: 7, mtimeMs: NOW - STALE_MS }, { dev: 1, ino: 7, mtimeMs: NOW - STALE_MS }, STALE_MS, NOW), false);
});

test("a genuinely stale lock that nobody replaced is still broken", () => {
  // The other half of the contract. Refusing to break stale locks would wedge
  // every record whose writer crashed, which is why the escape hatch exists --
  // so a fix for the lost update must not quietly remove it.
  const abandoned = { dev: 1, ino: 7, mtimeMs: OLD };
  assert.equal(canBreakLock(abandoned, { ...abandoned }, STALE_MS, NOW), true);
});

// --- withLockFile: observable behaviour --------------------------------------

test("the lock is held for the critical section and released after", () => {
  const dir = tmp();
  const lockFile = path.join(dir, "rec.lock");
  let seenInside;
  withLockFile(lockFile, "rec", () => {
    seenInside = fs.existsSync(lockFile);
  });
  assert.equal(seenInside, true, "the lock must exist while fn runs");
  assert.equal(fs.existsSync(lockFile), false, "the lock must be released afterwards");
});

test("the lock is released even when the critical section throws", () => {
  const dir = tmp();
  const lockFile = path.join(dir, "rec.lock");
  assert.throws(() => withLockFile(lockFile, "rec", () => {
    throw new Error("boom");
  }), /boom/);
  assert.equal(fs.existsSync(lockFile), false, "a failed write must not leave the record locked forever");
});

test("a second holder waits and is refused rather than allowed in", () => {
  // The direct consequence of the bug in miniature: a live lock must never be
  // broken to let a second writer through.
  const dir = tmp();
  const lockFile = path.join(dir, "rec.lock");
  fs.writeFileSync(lockFile, "held by another writer");
  assert.throws(
    () => withLockFile(lockFile, "rec", () => assert.fail("must not enter"), { staleMs: 60_000, timeoutMs: 40 }),
    LockError,
  );
  assert.equal(fs.readFileSync(lockFile, "utf8"), "held by another writer", "the live lock must be left untouched");
});

test("an abandoned lock is broken and the write goes through", () => {
  const dir = tmp();
  const lockFile = path.join(dir, "rec.lock");
  fs.writeFileSync(lockFile, "crashed writer");
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lockFile, old, old);

  let entered = false;
  withLockFile(lockFile, "rec", () => {
    entered = true;
  }, { staleMs: 1_000, timeoutMs: 2_000 });
  assert.equal(entered, true, "a crashed writer must not wedge the record forever");
});

test("nested acquisition of the same lock is refused, not silently re-entered", () => {
  const dir = tmp();
  const lockFile = path.join(dir, "rec.lock");
  let inner = "not reached";
  withLockFile(lockFile, "outer", () => {
    inner = (() => {
      try {
        withLockFile(lockFile, "inner", () => "entered", { staleMs: 60_000, timeoutMs: 40 });
        return "entered";
      } catch (err) {
        return err instanceof LockError ? "refused" : `wrong error: ${err}`;
      }
    })();
  }, { timeoutMs: 2_000 });
  assert.equal(inner, "refused", "re-entering a lock this process holds would deadlock or lose an update");
});

test("many sequential critical sections leave no lock behind", () => {
  const dir = tmp();
  const lockFile = path.join(dir, "rec.lock");
  for (let i = 0; i < 25; i += 1) {
    withLockFile(lockFile, "rec", () => i, { timeoutMs: 2_000 });
  }
  assert.equal(fs.existsSync(lockFile), false);
  assert.deepEqual(fs.readdirSync(dir), [], "no temp or lock residue may accumulate");
});