// Persistent session store.
//
// A session is the unit of continuity in AgentFlow: one unit of work that
// survives process exit, so the next command -- or the next agent -- can pick up
// where the last one stopped instead of re-deriving everything from scratch.
//
// Four constraints shaped this module, in priority order:
//
//  1. Never persist a credential. Every field written here passes through
//     redactDeep first. Session content includes provider output, tool results,
//     and prompts, all of which can echo a key back at us. The store is the last
//     place that can catch that before it becomes a file on disk that outlives
//     the process and ends up pasted into an issue. See assertNoSecrets().
//
//  2. A crash must not destroy history. Writes go to a temp file and are then
//     renamed over the target, which is atomic on both POSIX and NTFS. A process
//     killed mid-write leaves the previous session intact rather than a
//     half-written one.
//
//  3. Never silently discard or overwrite. A session that fails to parse is
//     reported as corrupt, and the store refuses to write over it -- a corrupt
//     file may be the only surviving record of real work. Likewise, entry
//     trimming counts what it dropped rather than pretending the history is
//     complete.
//
//  4. Concurrency is expected, not theoretical. An orchestrated workflow has
//     several agents appending to one session. Appends take a lock file and
//     re-read inside it, so a lost update cannot silently erase an agent's
//     findings.
//
// Storage layout: one JSON file per session under the state directory. A single
// append-only JSONL log was rejected because it cannot be rewritten atomically
// (rename) when a session is renamed or archived, and those are operations users
// expect to be safe.
//
// Why an id that encodes a timestamp: `list` sorts by name, and a
// lexicographically sortable id means the default order is chronological without
// reading every file's contents.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { redactDeep, redact } from "./redact.js";

export const SESSION_VERSION = 1;

export const SESSION_STATE = {
  ACTIVE: "active",
  COMPLETED: "completed",
};

export const ENTRY_KIND = {
  NOTE: "note",
  CONVERSATION: "conversation",
  TOOL_CALL: "tool_call",
  TOOL_RESULT: "tool_result",
  ROUTING: "routing",
  ERROR: "error",
  AGENT: "agent",
  BLACKBOARD_REF: "blackboard_ref",
  CHECKPOINT: "checkpoint",
};

const ENTRY_KINDS = new Set(Object.values(ENTRY_KIND));

/**
 * Deliberately narrow. The id becomes a filename, so anything permissive enough
 * to be convenient is also permissive enough to escape the state directory via
 * `..` or an absolute path. Rejecting everything that is not exactly the shape
 * we generate is the cheapest way to make traversal unrepresentable.
 *
 * The timestamp carries milliseconds (`T` + 9 digits) because second precision
 * made `list` order arbitrary for sessions created in the same second -- which is
 * exactly what an orchestrated workflow does when it spawns several.
 */
const SESSION_ID_RE = /^ses_\d{8}T\d{9}Z_[0-9a-z]{6}$/;

const MAX_NAME_LENGTH = 120;
const DEFAULT_MAX_ENTRIES = 5000;

export class SessionError extends Error {
  constructor(message, code = "session_error") {
    super(message);
    this.name = "SessionError";
    this.code = code;
  }
}

export class SessionIdError extends SessionError {
  constructor(id) {
    super(`invalid session id: ${JSON.stringify(String(id))}`, "invalid_session_id");
    this.name = "SessionIdError";
  }
}

export class SessionNotFoundError extends SessionError {
  constructor(id) {
    super(`no such session: ${id}`, "session_not_found");
    this.name = "SessionNotFoundError";
  }
}

export class SessionCorruptError extends SessionError {
  constructor(id, file, cause) {
    super(`session ${id} is corrupt and was not modified: ${cause?.message || cause}`, "session_corrupt");
    this.name = "SessionCorruptError";
    this.file = file;
  }
}

export class SessionLockedError extends SessionError {
  constructor(id) {
    super(`session ${id} is locked by another writer; try again`, "session_locked");
    this.name = "SessionLockedError";
  }
}

/** Default state directory, mirroring events.js conventions. */
export function defaultSessionsDir() {
  if (process.env.AGENTFLOW_STATE_DIR) return path.join(process.env.AGENTFLOW_STATE_DIR, "sessions");
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "agentflow", "sessions");
  }
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(base, "agentflow", "sessions");
}

export function assertValidSessionId(id) {
  const s = String(id ?? "");
  if (!SESSION_ID_RE.test(s)) throw new SessionIdError(s);
  return s;
}

export function isValidSessionId(id) {
  return SESSION_ID_RE.test(String(id ?? ""));
}

const RANDOM_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/**
 * Sortable, collision-resistant, and readable in a directory listing.
 *
 * Six random base-36 characters is ~31 bits, which is ample for sessions created
 * by one human on one machine; the timestamp supplies the ordering.
 */
export function newSessionId({ now = Date.now(), random = Math.random } = {}) {
  const d = new Date(now);
  const stamp =
    `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}` +
    `T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}` +
    `${String(d.getUTCMilliseconds()).padStart(3, "0")}Z`;

  let rand = "";
  for (let i = 0; i < 6; i++) {
    rand += RANDOM_ALPHABET[Math.floor(random() * RANDOM_ALPHABET.length)];
  }
  return `ses_${stamp}_${rand}`;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

/**
 * Last line of defence before bytes hit disk.
 *
 * redactDeep already masks credential-shaped strings and sensitive key names, so
 * the check here is not "does this look secret" -- it is "did redaction leave
 * anything behind". That is done by re-running the redactor over the serialised
 * result: if a second pass still changes something, a credential shape survived
 * the first one.
 *
 * Deriving the check this way means it stays correct as redact.js gains patterns,
 * instead of hard-coding prefixes here. An earlier version grepped for `GOCSPX-`
 * and `Bearer ` and threw on every *successfully redacted* value, because the
 * masks themselves contain those prefixes.
 *
 * Throwing is the right outcome: refusing to record an entry is recoverable,
 * persisting a secret is not.
 */
function assertNoSecrets(value, where) {
  const json = JSON.stringify(value);
  if (json === undefined) return value;
  if (redact(json) !== json) {
    throw new SessionError(`refusing to persist an unredacted credential-shaped value in ${where}`, "secret_detected");
  }
  return value;
}

/** Redact then assert. Used for every field that reaches the store. */
function safe(value, where) {
  return assertNoSecrets(redactDeep(value), where);
}

function normaliseName(raw, fallback) {
  const s = String(raw ?? "").trim();
  if (!s) return fallback;
  // Control characters would corrupt the terminal and the JSONL echo of a
  // session; strip them rather than trusting input that ends up in a TUI.
  const cleaned = s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.slice(0, MAX_NAME_LENGTH) || fallback;
}

function assertProjectRoot(root) {
  if (root === undefined || root === null || root === "") return null;
  return path.resolve(String(root));
}

export class SessionStore {
  constructor({ dir = defaultSessionsDir(), now = () => Date.now(), lockStaleMs = 10_000, lockTimeoutMs = 2_000 } = {}) {
    this.dir = dir;
    this.now = now;
    this.lockStaleMs = lockStaleMs;
    this.lockTimeoutMs = lockTimeoutMs;
    this._tmpCounter = 0;
  }

  fileFor(id) {
    return path.join(this.dir, `${assertValidSessionId(id)}.json`);
  }

  pointerFile() {
    return path.join(this.dir, "current.json");
  }

  ensureDir() {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /**
   * Atomic write. The temp file lives in the same directory so the rename stays
   * on one filesystem, which is what makes it atomic -- a cross-device rename
   * degrades to copy-then-delete and could leave a partial file.
   */
  writeAtomic(file, data) {
    this.ensureDir();
    this._tmpCounter += 1;
    const tmp = `${file}.${process.pid}.${this._tmpCounter}.tmp`;
    try {
      fs.writeFileSync(tmp, data, { encoding: "utf8", mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (err) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* the write already failed; a stray temp file is not worth masking it */
      }
      throw err;
    }
  }

  /**
   * Advisory lock around read-modify-write.
   *
   * `wx` fails if the file exists, which is the atomic test. A lock older than
   * `lockStaleMs` is treated as abandoned and broken, because a crashed process
   * must not wedge every future write to that session. Returns the callback's
   * value; the lock is always released.
   *
   * Takes a lock *path* rather than a session id so it can also guard the
   * non-session bookkeeping file (the id high-water mark), which has no id.
   */
  withLockFile(lockFile, label, fn) {
    this.ensureDir();
    const deadline = Date.now() + this.lockTimeoutMs;
    let fd = null;

    for (;;) {
      try {
        fd = fs.openSync(lockFile, "wx");
        break;
      } catch (err) {
        if (err.code !== "EEXIST") throw err;

        let stale = false;
        try {
          stale = Date.now() - fs.statSync(lockFile).mtimeMs > this.lockStaleMs;
        } catch {
          stale = true; // vanished between open and stat: retry immediately
        }
        if (stale) {
          try {
            fs.unlinkSync(lockFile);
          } catch {
            /* another process broke it first, which is fine */
          }
          continue;
        }
        if (Date.now() >= deadline) throw new SessionLockedError(label);
        // Busy-wait: reservations and appends are both short, and a sleep keeps
        // this dependency-free. The lock is held for a single JSON write.
        sleepMs(5);
      }
    }

    try {
      return fn();
    } finally {
      try {
        if (fd !== null) fs.closeSync(fd);
        fs.unlinkSync(lockFile);
      } catch {
        /* releasing must never mask the caller's own error */
      }
    }
  }

  withLock(id, fn) {
    return this.withLockFile(`${this.fileFor(id)}.lock`, id, fn);
  }

  /**
   * Strictly increasing timestamp for the next id.
   *
   * Wall-clock resolution is not enough: a loop (or several agent processes)
   * creating sessions faster than the clock ticks produced ids that differed only
   * in their random suffix, and `list` -- which sorts by id -- shuffled them.
   * Remembering the highest stamp issued and claiming `max(now, high + 1)` makes
   * ids strictly monotonic, so lexicographic order is creation order and no
   * wall-clock assumption is needed.
   *
   * The stamp file is deliberately not a session, so `list` ignores it.
   */
  reserveStamp() {
    const seqFile = path.join(this.dir, "seq.json");
    return this.withLockFile(`${seqFile}.lock`, "seq", () => {
      let high = 0;
      try {
        const parsed = JSON.parse(fs.readFileSync(seqFile, "utf8"));
        if (Number.isFinite(parsed?.high)) high = parsed.high;
      } catch {
        /* absent or unreadable: fall back to the wall clock */
      }
      const next = Math.max(this.now(), high + 1);
      this.writeAtomic(seqFile, `${JSON.stringify({ high: next }, null, 2)}\n`);
      return next;
    });
  }

  newId({ now = null, random = Math.random } = {}) {
    // An explicit `now` bypasses reservation so tests can pin time; otherwise
    // claim a monotonic stamp.
    const stamp = now ?? this.reserveStamp();
    let id = newSessionId({ now: stamp, random });

    // Reservation makes a collision impossible across stores sharing this
    // directory, but an injected `now` plus a pinned `random` can still collide
    // with an existing file. Overwriting a real session is not an acceptable
    // outcome, so nudge the stamp forward until the id is free.
    let guard = 0;
    while (this.exists(id) && guard < 64) {
      id = newSessionId({ now: stamp + guard + 1, random });
      guard += 1;
    }
    if (this.exists(id)) {
      throw new SessionError(`could not allocate a unique session id after ${guard} attempts`, "id_exhausted");
    }
    return id;
  }

  create({ objective = null, name = null, projectRoot = null, provider = null, model = null, agents = [] } = {}) {
    this.ensureDir();
    const id = this.newId();
    const ts = new Date(this.now()).toISOString();
    const root = assertProjectRoot(projectRoot);

    // Redact first, then derive. The auto-generated name is built from the
    // objective, so deriving it from the raw objective would have written an
    // unredacted copy of every secret into a second field -- a leak that only
    // showed up because a test asserted on the whole serialised session.
    const safeObjective = objective ? safe(String(objective), "objective") : null;
    const safeName = name ? safe(String(name), "name") : null;

    const session = {
      version: SESSION_VERSION,
      id,
      name: normaliseName(safeName, defaultNameFor(safeObjective, id)),
      project: root ? { root, name: path.basename(root) } : null,
      createdAt: ts,
      updatedAt: ts,
      archivedAt: null,
      completedAt: null,
      state: SESSION_STATE.ACTIVE,
      objective: safeObjective,
      provider: provider ? safe(String(provider), "provider") : null,
      model: model ? safe(String(model), "model") : null,
      agents: normaliseAgents(agents),
      blackboardRefs: [],
      maxEntries: DEFAULT_MAX_ENTRIES,
      counters: { entries: 0, conversation: 0, toolCalls: 0, errors: 0, routingDecisions: 0, dropped: 0 },
      entries: [],
    };

    this.writeAtomic(this.fileFor(id), `${JSON.stringify(session, null, 2)}\n`);
    return session;
  }

  /** Read + parse. Distinguishes "absent" from "present but unreadable". */
  read(id) {
    const file = this.fileFor(id);
    let raw;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") throw new SessionNotFoundError(id);
      throw err;
    }
    try {
      return migrate(JSON.parse(raw), file);
    } catch (err) {
      throw new SessionCorruptError(id, file, err);
    }
  }

  exists(id) {
    try {
      return fs.existsSync(this.fileFor(id));
    } catch {
      return false;
    }
  }

  /**
   * Append one entry, returning the updated session.
   *
   * Re-reads inside the lock so two concurrent appends serialise instead of the
   * second clobbering the first.
   */
  append(id, kind, payload = {}, { agent = null } = {}) {
    if (!ENTRY_KINDS.has(kind)) {
      throw new SessionError(`unknown entry kind: ${kind}`, "unknown_entry_kind");
    }
    assertValidSessionId(id);

    return this.withLock(id, () => {
      const session = this.read(id); // throws SessionCorruptError, refusing to overwrite
      const ts = new Date(this.now()).toISOString();

      const entry = {
        seq: session.entries.length + 1,
        ts,
        kind,
        ...(agent ? { agent: safe(String(agent), "entry.agent") } : {}),
        ...safe(payload, `entry.${kind}`),
      };
      assertNoSecrets(entry, `entry.${kind}`);

      session.entries.push(entry);
      session.updatedAt = ts;
      applyCounter(session, kind);

      // Trimming keeps a runaway agent from producing a file no editor can open,
      // but the dropped count is recorded so "entries: 5000" never reads as
      // "that was all of it".
      //
      // The `||` covers sessions written before this field existed; without it a
      // missing maxEntries would compare against undefined and silently disable
      // trimming entirely, which is the exact failure this bound exists to stop.
      const maxEntries = Number.isInteger(session.maxEntries) && session.maxEntries > 0 ? session.maxEntries : DEFAULT_MAX_ENTRIES;
      if (session.entries.length > maxEntries) {
        const excess = session.entries.length - maxEntries;
        session.entries.splice(0, excess);
        session.counters.dropped += excess;
      }

      this.writeAtomic(this.fileFor(id), `${JSON.stringify(session, null, 2)}\n`);
      return session;
    });
  }

  /** Shallow field update for the mutable header fields. */
  update(id, patch = {}) {
    assertValidSessionId(id);
    return this.withLock(id, () => {
      const session = this.read(id);
      if (patch.objective !== undefined) session.objective = patch.objective ? safe(String(patch.objective), "objective") : null;
      if (patch.provider !== undefined) session.provider = patch.provider ? safe(String(patch.provider), "provider") : null;
      if (patch.model !== undefined) session.model = patch.model ? safe(String(patch.model), "model") : null;
      if (patch.agents !== undefined) session.agents = normaliseAgents(patch.agents);
      if (Array.isArray(patch.blackboardRefs)) {
        session.blackboardRefs = dedupeStrings(patch.blackboardRefs, "blackboardRef");
      }
      session.updatedAt = new Date(this.now()).toISOString();
      this.writeAtomic(this.fileFor(id), `${JSON.stringify(session, null, 2)}\n`);
      return session;
    });
  }

  rename(id, name) {
    assertValidSessionId(id);
    const clean = normaliseName(safe(String(name), "name"), `session-${id}`);
    return this.withLock(id, () => {
      const session = this.read(id);
      session.name = clean;
      session.updatedAt = new Date(this.now()).toISOString();
      this.writeAtomic(this.fileFor(id), `${JSON.stringify(session, null, 2)}\n`);
      return session;
    });
  }

  setArchived(id, archived = true) {
    return this.withLock(id, () => {
      const session = this.read(id);
      session.archivedAt = archived ? new Date(this.now()).toISOString() : null;
      session.updatedAt = session.archivedAt;
      this.writeAtomic(this.fileFor(id), `${JSON.stringify(session, null, 2)}\n`);
      return session;
    });
  }

  complete(id) {
    return this.withLock(id, () => {
      const session = this.read(id);
      const ts = new Date(this.now()).toISOString();
      session.state = SESSION_STATE.COMPLETED;
      session.completedAt = ts;
      session.updatedAt = ts;
      this.writeAtomic(this.fileFor(id), `${JSON.stringify(session, null, 2)}\n`);
      return session;
    });
  }

  /**
   * Directory scan rather than a maintained index file.
   *
   * An index is a second copy of the truth that can drift from the sessions it
   * describes -- and a drifted index silently hides sessions. A directory
   * listing cannot drift, and session counts here are human-scale.
   */
  list({ includeArchived = false, projectRoot = null, limit = 0 } = {}) {
    let names;
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return [];
    }

    const wantedRoot = assertProjectRoot(projectRoot);
    const out = [];

    for (const file of names) {
      if (!file.endsWith(".json") || file === "current.json") continue;
      const id = file.slice(0, -5);
      if (!isValidSessionId(id)) continue;

      let session;
      try {
        session = this.read(id);
      } catch (err) {
        if (err instanceof SessionCorruptError) {
          // Surfaced rather than skipped: a session you cannot read is a
          // problem the user needs to see, not a gap in a listing.
          out.push({ id, corrupt: true, error: err.message });
          continue;
        }
        if (err instanceof SessionNotFoundError) continue;
        throw err;
      }

      if (!includeArchived && session.archivedAt) continue;
      if (wantedRoot && session.project?.root !== wantedRoot) continue;
      out.push(session);
    }

    // Ids sort chronologically, so name order is time order without stat()ing
    // every file's mtime.
    out.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    return limit > 0 ? out.slice(0, limit) : out;
  }

  setCurrent(id) {
    const session = this.read(id); // validates existence and id
    this.writeAtomic(this.pointerFile(), `${JSON.stringify({ id, at: new Date(this.now()).toISOString() }, null, 2)}\n`);
    return session;
  }

  getCurrent() {
    try {
      const raw = fs.readFileSync(this.pointerFile(), "utf8");
      const parsed = JSON.parse(raw);
      return isValidSessionId(parsed?.id) ? parsed.id : null;
    } catch {
      return null;
    }
  }

  clearCurrent() {
    try {
      fs.unlinkSync(this.pointerFile());
    } catch {
      /* already absent */
    }
  }
}

function applyCounter(session, kind) {
  session.counters.entries += 1;
  if (kind === ENTRY_KIND.CONVERSATION) session.counters.conversation += 1;
  else if (kind === ENTRY_KIND.TOOL_CALL || kind === ENTRY_KIND.TOOL_RESULT) session.counters.toolCalls += 1;
  else if (kind === ENTRY_KIND.ERROR) session.counters.errors += 1;
  else if (kind === ENTRY_KIND.ROUTING) session.counters.routingDecisions += 1;
}

function dedupeStrings(values, where) {
  return [...new Set(values.map((v) => safe(String(v), where)).map((v) => v.trim()).filter(Boolean))];
}

function normaliseAgents(agents) {
  return Array.isArray(agents) ? dedupeStrings(agents, "agent") : [];
}

function defaultNameFor(objective, id) {
  const text = String(objective ?? "").trim();
  if (!text) return `session ${id.slice(4, 18)}`;
  const firstLine = text.split("\n")[0].slice(0, 60).trim();
  return firstLine || `session ${id.slice(4, 18)}`;
}

/**
 * Forward-compatible loader.
 *
 * A file written by a newer AgentFlow is refused rather than coerced: silently
 * downgrading a v2 session to v1 would drop fields this version does not
 * understand, and losing an agent's findings is worse than refusing to read it.
 */
function migrate(parsed, file) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("session file is not an object");
  }
  if (parsed.version === SESSION_VERSION) return parsed;
  if (typeof parsed.version !== "number") throw new Error("session file has no version field");
  if (parsed.version > SESSION_VERSION) {
    throw new Error(`session file version ${parsed.version} is newer than supported ${SESSION_VERSION} (${file})`);
  }
  throw new Error(`session file version ${parsed.version} predates the supported version ${SESSION_VERSION} (${file})`);
}

function sleepMs(ms) {
  const shared = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(shared), 0, 0, ms);
}

export { ENTRY_KINDS, SESSION_ID_RE };