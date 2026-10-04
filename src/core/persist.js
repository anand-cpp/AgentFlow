// Durable file primitives shared by the stores.
//
// Sessions and Blackboard both need the same three things to keep their on-disk
// state trustworthy: an atomic write, a lock around read-modify-write, and
// strict refusal to guess at a file it cannot parse. Those are subtle enough
// that having two copies would eventually mean two behaviours -- one of them
// subtly wrong, and wrong in the direction of losing data.
//
// This module is deliberately not a framework. It exports four functions with no
// schema knowledge, no ids, and no opinions about what a record is. Domain rules
// stay in the store that owns them.
//
// The behaviours encoded here, and why each one exists:
//
//   writeAtomicFile  A crash must not truncate state. Write to a sibling temp
//                    file, then rename. Same directory, so the rename stays on
//                    one filesystem; across devices it degrades to
//                    copy-then-delete and could leave a partial file.
//   withLockFile    Two agents updating one record must not lose an update.
//                    `open(..., "wx")` is the atomic test for "nobody holds
//                    this". A lock older than staleMs is broken, because a
//                    crashed writer must not wedge the record forever; a live
//                    one raises a retryable error rather than corrupting data.
//   readJsonFile    Distinguishes absent / unparseable / valid. Collapsing these
//                    is how a corrupt file gets silently treated as an empty
//                    one, which loses history without any error.
//   assertVersion   A record written by a newer build is refused, not coerced.
//                    Coercing silently discards fields this build cannot read.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

export class LockError extends Error {
  constructor(label, message) {
    super(message || `record ${label} is locked by another writer; try again`);
    this.name = "LockError";
    this.code = "record_locked";
    this.label = label;
  }
}

export class RecordVersionError extends Error {
  constructor(message, file) {
    super(message);
    this.name = "RecordVersionError";
    this.code = "unsupported_version";
    this.file = file;
  }
}

/** Busy-wait helper: no dependencies, and always held for a single write. */
export function sleepMs(ms) {
  // SharedArrayBuffer + Atomics.wait is the only true synchronous sleep in
  // Node. A lock holder is always in a tight, sub-millisecond critical section,
  // so spinning is cheaper than any async alternative here.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function ensureDirFor(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

let tmpCounter = 0;

/**
 * Replace `file` with `data`, atomically.
 *
 * The temp file is a sibling of the target, which is what keeps the rename on one
 * filesystem. Mode 0600 because every record these stores write can contain
 * details of a user's project.
 */
export function writeAtomicFile(file, data) {
  ensureDirFor(file);
  tmpCounter += 1;
  const tmp = `${file}.${process.pid}.${tmpCounter}.tmp`;
  try {
    fs.writeFileSync(tmp, data, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // The write already failed; a stray temp file is not worth masking it.
    }
    throw err;
  }
}

/** Identity of a lock file, or null when it cannot be stat-ed at all. */
function observeLock(file) {
  try {
    const st = fs.statSync(file);
    return { dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

/**
 * Whether an observed lock may be broken.
 *
 * Breaking a stale lock is the one destructive thing this module does, and it is
 * only safe when the file about to be unlinked is provably the same file that was
 * observed to be stale. A lock that could not be observed, or one whose identity
 * has changed since the observation, belongs to a writer that may be running
 * right now: the previous holder released and a new holder acquired between the
 * failed open and the stat. Unlinking that hands two writers the lock at once,
 * and two writers inside one read-modify-write is how an update is lost with no
 * error anywhere.
 *
 * `fresh` is a second observation taken immediately before the unlink.
 */
export function canBreakLock(observed, fresh, staleMs, now = Date.now()) {
  if (observed === null || fresh === null) return false;
  if (now - observed.mtimeMs <= staleMs) return false;
  return fresh.dev === observed.dev && fresh.ino === observed.ino && fresh.mtimeMs === observed.mtimeMs;
}

/**
 * Run `fn` while holding an exclusive lock on `lockFile`.
 *
 * Returns `fn`'s value and always releases. `staleMs` bounds how long a crashed
 * holder can block writers; `timeoutMs` bounds how long a *live* holder is
 * waited for before giving up with a retryable error rather than hanging.
 */
export function withLockFile(lockFile, label, fn, { staleMs = 10_000, timeoutMs = 2_000 } = {}) {
  ensureDirFor(lockFile);
  const deadline = Date.now() + timeoutMs;
  let fd = null;

  for (;;) {
    try {
      fd = fs.openSync(lockFile, "wx");
      break;
    } catch (err) {
      // EEXIST is the atomic "somebody holds this". Windows reports a held lock
      // as EPERM/EACCES instead, because the holder has the file open, so those
      // mean the same thing here and must wait rather than propagate.
      if (err.code !== "EEXIST" && err.code !== "EPERM" && err.code !== "EACCES") throw err;

      let observed = null;
      try {
        const st = fs.statSync(lockFile);
        observed = { dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs };
      } catch (statErr) {
        // Not contention, and not staleness: the lock is unreadable for some
        // reason other than being absent. Surface the open failure it masked.
        if (statErr.code !== "ENOENT") throw err;
      }

      const waitOrFail = () => {
        if (Date.now() >= deadline) throw new LockError(label);
        sleepMs(5);
      };

      // Absent: we lost the race for it between the failed open and this stat.
      // That is not evidence it was abandoned, so observe again and never unlink.
      if (observed === null) {
        waitOrFail();
        continue;
      }

      // Live: wait for the holder.
      if (Date.now() - observed.mtimeMs <= staleMs) {
        waitOrFail();
        continue;
      }

      // Stale, so it must be broken -- but only the exact file just judged
      // stale. Re-observe immediately before unlinking and let canBreakLock
      // refuse if a new holder has taken over in the meantime.
      if (canBreakLock(observed, observeLock(lockFile), staleMs)) {
        try {
          fs.unlinkSync(lockFile);
        } catch {
          // Another writer broke it first, which is fine: observe again.
        }
        continue;
      }
      waitOrFail();
    }
  }

  try {
    return fn();
  } finally {
    try {
      if (fd !== null) fs.closeSync(fd);
      fs.unlinkSync(lockFile);
    } catch {
      // Releasing must never mask the caller's own error.
    }
  }
}

/**
 * @returns {{ok: true, value: object} | {ok: false, reason: "missing"|"unparseable", error?: Error}}
 */
export function readJsonFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return { ok: false, reason: "missing" };
    throw err;
  }
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, reason: "unparseable", error: new Error("record is not an object") };
    }
    return { ok: true, value };
  } catch (err) {
    return { ok: false, reason: "unparseable", error: err };
  }
}

/**
 * Guard against reading -- and then writing back -- a record whose schema this
 * build does not understand. Round-tripping it would persist whatever we
 * guessed, destroying the newer build's fields.
 */
export function assertVersion(value, version, file) {
  if (value.version === version) return value;
  if (typeof value.version !== "number") {
    throw new RecordVersionError(`record has no version field (${file})`, file);
  }
  throw new RecordVersionError(
    `record version ${value.version} is newer than supported ${version} (${file})`,
    file,
  );
}

/** Append one line durably, creating the parent directory if needed. */
export function appendLine(file, line) {
  ensureDirFor(file);
  // Appending a single short line with a single write is atomic enough in
  // practice on both POSIX and NTFS for a record this size, and the caller
  // holds a lock for anything that must not interleave.
  fs.appendFileSync(file, `${line}\n`, { encoding: "utf8", mode: 0o600 });
}

export default { writeAtomicFile, withLockFile, readJsonFile, assertVersion, appendLine, canBreakLock, LockError, RecordVersionError };