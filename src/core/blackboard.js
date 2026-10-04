// Project Blackboard: durable workflow state, separate from source.
//
// The distinction that makes this subsystem work:
//
//   git       is authoritative for *what the code is*.
//   blackboard is authoritative for *what we were doing to it*.
//
// An agent that restarts mid-task needs to recover the goal, the current
// objective, which tasks are open, why a decision was made, what is blocked, what
// already failed, what the next action is, and which session/commit produced all
// of it. None of that lives in git: it lives in prompts, in a lost terminal, and
// in the working memory of whoever happened to be holding the conversation. That
// is precisely what loses work.
//
// Two rules keep the Blackboard from becoming a second source of truth:
//
//  1. No source duplication. The Blackboard records *references* -- a path, a
//     commit SHA, a URL, a command -- never a copy of file contents. Copying
//     source in here would immediately go stale and then contradict git.
//  2. Explicit ownership. Every fact has exactly one home: goal, objective,
//     tasks, decisions and blockers here; file contents and history in git.
//
// Storage is two files, split by access pattern:
//
//   <id>.state.json   authoritative current state, rewritten atomically. Bounded,
//                     because a file nobody can open is a file nobody trusts.
//   <id>.events.jsonl append-only timeline of meaningful checkpoints. Grows, is
//                     never replayed back into state, and survives a damaged
//                     state file as an independent record of what happened.
//
// Validation is explicit field-by-field rather than spreading a caller payload
// into a record. `...payload` is how a typo becomes a permanently stored field,
// and how an arbitrary object graph from provider output ends up nested inside
// state that is supposed to be trustworthy. Unknown keys are dropped on purpose.
//
// Every mutation takes the record lock, re-reads state inside the lock, and writes
// atomically, so two agents updating the same project cannot lose an update.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { redactVerified, SecretDetectedError } from "./redact.js";
import {
  writeAtomicFile,
  withLockFile,
  readJsonFile,
  assertVersion,
  appendLine,
  LockError,
} from "./persist.js";

export const BLACKBOARD_VERSION = 1;

export const TASK_STATUS = {
  PENDING: "pending",
  IN_PROGRESS: "in_progress",
  BLOCKED: "blocked",
  DONE: "done",
  CANCELLED: "cancelled",
};

export const DECISION_KIND = {
  ARCHITECTURE: "architecture",
  PROVIDER: "provider",
  ROUTING: "routing",
  TOOLING: "tooling",
  OTHER: "other",
};

export const SEVERITY = {
  INFO: "info",
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
  CRITICAL: "critical",
};

export const FINDING_SOURCE = {
  AGENT: "agent",
  REVIEWER: "reviewer",
  USER: "user",
  TOOL: "tool",
};

export const CHECKPOINT = {
  TASK_STARTED: "TASK_STARTED",
  PLAN_CREATED: "PLAN_CREATED",
  IMPLEMENTATION_UPDATED: "IMPLEMENTATION_UPDATED",
  TEST_FAILED: "TEST_FAILED",
  BUG_IDENTIFIED: "BUG_IDENTIFIED",
  BUG_FIXED: "BUG_FIXED",
  TEST_PASSED: "TEST_PASSED",
  DECISION_RECORDED: "DECISION_RECORDED",
  REVIEW_COMPLETED: "REVIEW_COMPLETED",
  TASK_COMPLETED: "TASK_COMPLETED",
  NEXT_ACTION_SET: "NEXT_ACTION_SET",
};

const CHECKPOINTS = new Set(Object.values(CHECKPOINT));
const TASK_STATUSES = new Set(Object.values(TASK_STATUS));
const DECISION_KINDS = new Set(Object.values(DECISION_KIND));
const SEVERITIES = new Set(Object.values(SEVERITY));
const FINDING_SOURCES = new Set(Object.values(FINDING_SOURCE));

// Which records still need attention. Deliberately a predicate shared across
// collections rather than each type's own enum: "open" means something slightly
// different for a blocker than for an assumption, but they share the lifecycle
// open -> addressed/answered/confirmed -> gone.
const OPEN_STATUSES = new Set(["open", "addressed", "active"]);
// The valid values for a finding's status. Kept separate from OPEN_STATUSES: a
// finding can be dismissed, which is not a synonym for anything in that set.
const FINDING_STATUSES = new Set(["open", "addressed", "dismissed"]);
const EVIDENCE_KINDS = new Set(["file", "url", "commit", "command", "note"]);

// A status change is only a checkpoint if it represents a real transition.
// "pending" means nothing has begun, and "cancelled" is not completion, so
// neither emits one.
const STATUS_CHECKPOINT = {
  [TASK_STATUS.PENDING]: null,
  [TASK_STATUS.IN_PROGRESS]: CHECKPOINT.TASK_STARTED,
  [TASK_STATUS.BLOCKED]: null,
  [TASK_STATUS.DONE]: CHECKPOINT.TASK_COMPLETED,
  [TASK_STATUS.CANCELLED]: null,
};

const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const SHA_RE = /^[0-9a-f]{7,40}$/i;

const MAX_RECORDS = 500;
const MAX_TEXT = 4000;
const MAX_SHORT = 300;
const MAX_LIST = 32;

const COLLECTIONS = [
  "findings",
  "decisions",
  "blockers",
  "tasks",
  "tests",
  "bugs",
  "questions",
  "assumptions",
  "evidence",
  "reviews",
];

const COUNTER_KEYS = [
  "task",
  "decision",
  "blocker",
  "finding",
  "bug",
  "question",
  "assumption",
  "test",
  "evidence",
  "review",
];

export class BlackboardError extends Error {
  constructor(message, code = "blackboard_error") {
    super(message);
    this.name = "BlackboardError";
    this.code = code;
  }
}

export class ValidationError extends BlackboardError {
  constructor(message, field = null) {
    super(message, "invalid_argument");
    this.name = "ValidationError";
    this.field = field;
  }
}

export class BlackboardNotFoundError extends BlackboardError {
  constructor(projectRoot) {
    super(`no blackboard for project ${projectRoot}`, "not_found");
    this.name = "BlackboardNotFoundError";
  }
}

export class BlackboardCorruptError extends BlackboardError {
  constructor(file, cause) {
    super(`blackboard state at ${file} is unreadable and was left untouched`, "corrupt");
    this.name = "BlackboardCorruptError";
  }
}

export class BlackboardLockedError extends BlackboardError {
  constructor(label) {
    super(`blackboard ${label} is locked by another writer; try again`, "blackboard_locked");
    this.name = "BlackboardLockedError";
  }
}

/**
 * Stable id for a project, derived from its resolved root.
 *
 * Hashing the real path rather than using the basename means two checkouts both
 * named `agentflow` do not collide on one Blackboard, and the id stays stable
 * across restarts because it depends only on where the project lives.
 */
export function blackboardIdForProject(projectRoot) {
  const resolved = path.resolve(String(projectRoot));
  return crypto.createHash("sha256").update(resolved).digest("hex").slice(0, 12);
}

export function defaultBlackboardDir() {
  const base =
    process.env.AGENTFLOW_STATE_DIR ||
    (process.platform === "win32"
      ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "agentflow")
      : process.platform === "darwin"
        ? path.join(os.homedir(), "Library", "Application Support", "agentflow")
        : path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "agentflow"));
  return path.join(base, "blackboard");
}

// --- validators -----------------------------------------------------------
//
// Each names the offending field, because "invalid input" with no field name is
// unusable when an agent has to correct itself.

function asString(value, field, { max = MAX_SHORT, required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new ValidationError(`${field} is required`, field);
    return null;
  }
  if (typeof value !== "string") throw new ValidationError(`${field} must be a string`, field);
  const trimmed = value.trim();
  if (!trimmed) {
    if (required) throw new ValidationError(`${field} must not be empty`, field);
    return null;
  }
  if (trimmed.length > max) throw new ValidationError(`${field} exceeds ${max} characters`, field);
  return trimmed;
}

function asText(value, field, { required = false } = {}) {
  return asString(value, field, { max: MAX_TEXT, required });
}

function asOneOf(value, field, allowed, { fallback = null } = {}) {
  if (value === undefined || value === null) {
    if (fallback !== null) return fallback;
    throw new ValidationError(`${field} is required`, field);
  }
  if (!allowed.has(value)) throw new ValidationError(`${field} must be one of: ${[...allowed].join(", ")}`, field);
  return value;
}

/**
 * Loose reference format rather than a strict session-id check.
 *
 * Sessions own their id format and may extend it. Blackboard validating against
 * today's pattern would start rejecting references written by a newer build --
 * the same version-skew trap that persist.js:assertVersion exists to avoid.
 */
function asRef(value, field, { required = false } = {}) {
  const text = asString(value, field, { max: 64, required });
  if (text === null) return null;
  if (!REF_RE.test(text)) throw new ValidationError(`${field} is not a valid reference`, field);
  return text;
}

function asSha(value, field, { required = false } = {}) {
  const text = asString(value, field, { max: 40, required });
  if (text === null) return null;
  if (!SHA_RE.test(text)) throw new ValidationError(`${field} is not a git sha`, field);
  return text.toLowerCase();
}

function asFilePath(value, field) {
  const text = asString(value, field, { max: 400, required: true });
  if (path.isAbsolute(text)) throw new ValidationError(`${field} must be project-relative`, field);
  const normalised = path.normalize(text).replace(/\\/g, "/");
  if (normalised.split("/").includes("..")) {
    throw new ValidationError(`${field} must not traverse outside the project`, field);
  }
  return normalised;
}

function asList(value, field, { max = MAX_LIST, item = asString } = {}) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ValidationError(`${field} must be an array`, field);
  if (value.length > max) throw new ValidationError(`${field} exceeds ${max} entries`, field);
  const out = [];
  for (const raw of value) {
    if (raw === undefined || raw === null) continue;
    const cleaned = item(raw, `${field}[]`);
    if (cleaned !== null && !out.includes(cleaned)) out.push(cleaned);
  }
  return out;
}

function asNumber(value, field, { min = 0 } = {}) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ValidationError(`${field} must be a finite number`, field);
  }
  if (value < min) throw new ValidationError(`${field} must be >= ${min}`, field);
  return value;
}

function asStatusFilter(value, field, allowed) {
  if (value === undefined || value === null) return null;
  if (!allowed.has(value)) throw new ValidationError(`${field} must be one of: ${[...allowed].join(", ")}`, field);
  return value;
}

/** Redact and verify before bytes reach disk. See redact.js:redactVerified. */
function safe(value, where) {
  try {
    return redactVerified(value, where);
  } catch (err) {
    if (err instanceof SecretDetectedError) {
      throw new BlackboardError(`refusing to persist an unredacted credential-shaped value in ${where}`, "secret_detected");
    }
    throw err;
  }
}

/** Read APIs hand out copies, so a caller cannot mutate persisted state by accident. */
function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function addUnique(list, value) {
  if (value !== null && value !== undefined && !list.includes(value)) list.push(value);
}

export class BlackboardStore {
  constructor({
    dir = defaultBlackboardDir(),
    projectRoot = process.cwd(),
    now = () => Date.now(),
    lockStaleMs = 10_000,
    lockTimeoutMs = 2_000,
    maxRecords = MAX_RECORDS,
  } = {}) {
    this.dir = dir;
    this.projectRoot = path.resolve(String(projectRoot));
    this.id = blackboardIdForProject(this.projectRoot);
    this.now = now;
    this.lockStaleMs = lockStaleMs;
    this.lockTimeoutMs = lockTimeoutMs;
    this.maxRecords = maxRecords;
  }

  stateFile() {
    return path.join(this.dir, `${this.id}.state.json`);
  }

  eventsFile() {
    return path.join(this.dir, `${this.id}.events.jsonl`);
  }

  lockFile() {
    return path.join(this.dir, `${this.id}.state.json.lock`);
  }

  ts() {
    return new Date(this.now()).toISOString();
  }

  withLock(fn) {
    try {
      return withLockFile(this.lockFile(), this.id, fn, {
        staleMs: this.lockStaleMs,
        timeoutMs: this.lockTimeoutMs,
      });
    } catch (err) {
      if (err instanceof LockError) throw new BlackboardLockedError(this.id);
      throw err;
    }
  }

  /** Load state, or null when this project has no Blackboard yet. */
  read() {
    const file = this.stateFile();
    const result = readJsonFile(file);
    if (!result.ok) {
      if (result.reason === "missing") return null;
      throw new BlackboardCorruptError(file);
    }
    try {
      return assertVersion(result.value, BLACKBOARD_VERSION, file);
    } catch (err) {
      throw new BlackboardCorruptError(file);
    }
  }

  require() {
    const state = this.read();
    if (!state) throw new BlackboardNotFoundError(this.projectRoot);
    return state;
  }

  exists() {
    return fs.existsSync(this.stateFile());
  }

  emptyState() {
    const ts = this.ts();
    const counters = {};
    const dropped = {};
    const state = {
      version: BLACKBOARD_VERSION,
      id: this.id,
      projectRoot: this.projectRoot,
      createdAt: ts,
      updatedAt: ts,
      goal: null,
      objective: null,
      nextAction: null,
      counters,
      files: {},
      sessionIds: [],
      commits: [],
      dropped,
    };
    for (const key of COUNTER_KEYS) counters[key] = 0;
    for (const key of COLLECTIONS) {
      state[key] = [];
      dropped[key] = 0;
    }
    return state;
  }

  /** Create the Blackboard. Idempotent: an existing one is returned unchanged. */
  create({ goal = null, objective = null, sessionId = null } = {}) {
    const cleanGoal = asText(goal, "goal");
    const cleanObjective = asText(objective, "objective");
    const ref = sessionId ? asRef(sessionId, "sessionId") : null;

    return this.withLock(() => {
      // An existing Blackboard is never reinitialised, and a corrupt one is never
      // overwritten -- there would be nothing left to recover from.
      const existing = this.read();
      if (existing) return existing;

      const state = this.emptyState();
      state.goal = cleanGoal;
      state.objective = cleanObjective;
      if (ref) addUnique(state.sessionIds, ref);

      this.persist(
        state,
        state.goal || state.objective ? [{ checkpoint: CHECKPOINT.PLAN_CREATED, summary: "goal and objective recorded" }] : [],
      );
      return state;
    });
  }

  /**
   * Apply `mutateFn(state)` under the lock and persist the result.
   *
   * `checkpoints` is either an array or a function of the mutated state, evaluated
   * inside the lock. The function form exists for cases where the checkpoint
   * depends on the transition the mutator performed -- a task update cannot know
   * its previous status without reading it under the same lock.
   */
  mutate(mutateFn, checkpoints = []) {
    return this.withLock(() => {
      const state = this.require();
      const result = mutateFn(state);
      const resolved = typeof checkpoints === "function" ? checkpoints(state) : checkpoints;
      this.persist(state, resolved);
      return result === undefined ? state : result;
    });
  }

  persist(state, checkpoints) {
    state.updatedAt = this.ts();
    this.trim(state);
    // The redacted copy is what gets written, not the original: `safe` returns a
    // new object, so serialising `state` here would persist the raw text.
    const persisted = safe(state, "blackboard.state");
    writeAtomicFile(this.stateFile(), `${JSON.stringify(persisted, null, 2)}\n`);

    const entries = [];
    for (const c of checkpoints || []) {
      if (!c || !CHECKPOINTS.has(c.checkpoint)) continue;
      entries.push(
        JSON.stringify(
          safe(
            {
              ts: state.updatedAt,
              checkpoint: c.checkpoint,
              summary: asText(c.summary, "checkpoint.summary", { max: MAX_SHORT }) || c.checkpoint,
              ...(c.taskId ? { taskId: c.taskId } : {}),
              ...(c.sessionId ? { sessionId: c.sessionId } : {}),
            },
            "checkpoint",
          ),
        ),
      );
    }
    if (!entries.length) return;

    try {
      appendLine(this.eventsFile(), entries.join("\n"));
    } catch (err) {
      // State is already durable and self-consistent. Say exactly that, rather
      // than letting the caller conclude nothing was saved.
      throw new BlackboardError(
        `state was saved but the checkpoint timeline append failed (${err.message}); the timeline is now behind state`,
        "timeline_append_failed",
      );
    }
  }

  /**
   * Bound the state file.
   *
   * Dropping the oldest entries keeps the document openable, and counting them
   * keeps the result honest: a list reading "500 findings" must not silently mean
   * "500 of 900". The dropped counts surface in summary() so a caller can notice.
   */
  trim(state) {
    for (const key of COLLECTIONS) {
      const list = state[key];
      const overflow = list.length - this.maxRecords;
      if (overflow > 0) {
        state.dropped[key] += overflow;
        list.splice(0, overflow);
      }
    }
  }

  nextId(state, key, prefix) {
    state.counters[key] += 1;
    return `${prefix}${state.counters[key]}`;
  }

  find(state, key, id) {
    const record = state[key].find((r) => r.id === id);
    if (!record) throw new ValidationError(`no ${key.replace(/s$/, "")} with id ${id}`, "id");
    return record;
  }

  /** A blocked task records which blocker holds it, so the graph stays traversable both ways. */
  markTaskBlocked(state, taskId, blockerId, ts) {
    const task = state.tasks.find((t) => t.id === taskId);
    if (!task) return;
    if (task.status !== TASK_STATUS.BLOCKED) {
      task.status = TASK_STATUS.BLOCKED;
      task.updatedAt = ts;
    }
    addUnique(task.blockedBy || (task.blockedBy = []), blockerId);
  }

  // --- intent -------------------------------------------------------------

  setIntent({ goal, objective, sessionId = null } = {}) {
    const cleanGoal = goal === undefined ? undefined : asText(goal, "goal");
    const cleanObjective = objective === undefined ? undefined : asText(objective, "objective");
    const ref = sessionId ? asRef(sessionId, "sessionId") : null;

    return this.mutate(
      (state) => {
        if (cleanGoal !== undefined) state.goal = cleanGoal;
        if (cleanObjective !== undefined) state.objective = cleanObjective;
        if (ref) addUnique(state.sessionIds, ref);
        return { goal: state.goal, objective: state.objective };
      },
      [
        {
          checkpoint: CHECKPOINT.PLAN_CREATED,
          summary: "goal and objective recorded",
          ...(ref ? { sessionId: ref } : {}),
        },
      ],
    );
  }

  // --- tasks --------------------------------------------------------------

  addTask({
    title,
    detail = null,
    dependsOn = [],
    sessionId = null,
    commits = [],
    status = TASK_STATUS.PENDING,
  } = {}) {
    const cleanTitle = asString(title, "title", { required: true });
    const cleanDetail = asText(detail, "detail");
    const deps = asList(dependsOn, "dependsOn", { item: asRef });
    const ref = sessionId ? asRef(sessionId, "sessionId") : null;
    const shas = asList(commits, "commits", { item: asSha });
    const cleanStatus = asOneOf(status, "status", TASK_STATUSES, { fallback: TASK_STATUS.PENDING });

    return this.mutate((state) => {
      for (const dep of deps) {
        if (!state.tasks.some((t) => t.id === dep)) {
          throw new ValidationError(`dependsOn references unknown task ${dep}`, "dependsOn");
        }
      }
      const ts = this.ts();
      const task = {
        id: this.nextId(state, "task", "t"),
        title: cleanTitle,
        detail: cleanDetail,
        status: cleanStatus,
        dependsOn: deps,
        blockedBy: [],
        sessionIds: ref ? [ref] : [],
        commits: shas,
        createdAt: ts,
        updatedAt: ts,
        completedAt: null,
      };
      state.tasks.push(task);
      if (ref) addUnique(state.sessionIds, ref);
      for (const sha of shas) addUnique(state.commits, sha);
      return clone(task);
    });
  }

  /**
   * Update a task. Only `status` is treated as a transition; every other field is
   * optional and untouched when absent, so a partial patch cannot blank a field.
   */
  updateTask(id, patch = {}) {
    const taskId = asRef(id, "id", { required: true });
    const nextStatus = patch.status === undefined ? null : asOneOf(patch.status, "status", TASK_STATUSES);
    const title = patch.title === undefined ? undefined : asString(patch.title, "title", { required: true });
    const detail = patch.detail === undefined ? undefined : asText(patch.detail, "detail");
    const sessionId = patch.sessionId === undefined ? null : asRef(patch.sessionId, "sessionId");
    const commits = patch.commits === undefined ? [] : asList(patch.commits, "commits", { item: asSha });

    let previous = null;

    return this.mutate(
      (state) => {
        const task = this.find(state, "tasks", taskId);
        previous = task.status;

        if (title !== undefined) task.title = title;
        if (detail !== undefined) task.detail = detail;
        if (sessionId) {
          addUnique(task.sessionIds, sessionId);
          addUnique(state.sessionIds, sessionId);
        }
        for (const sha of commits) {
          addUnique(task.commits, sha);
          addUnique(state.commits, sha);
        }
        if (nextStatus !== null && nextStatus !== previous) {
          task.status = nextStatus;
          task.completedAt = nextStatus === TASK_STATUS.DONE ? this.ts() : null;
          if (nextStatus !== TASK_STATUS.BLOCKED) task.blockedBy = [];
        }
        task.updatedAt = this.ts();
        return clone(task);
      },
      (state) => {
        // Evaluated inside the lock, so `previous` and the task were both read
        // under it: only a real status change becomes a checkpoint.
        const task = state.tasks.find((t) => t.id === taskId);
        if (!task || previous === null || task.status === previous) return [];
        const checkpoint = STATUS_CHECKPOINT[task.status];
        if (!checkpoint) return [];
        return [{ checkpoint, taskId: task.id, summary: `${task.title}: ${previous} -> ${task.status}` }];
      },
    );
  }

  task(id) {
    return clone(this.find(this.require(), "tasks", asRef(id, "id", { required: true })));
  }

  listTasks({ status = null } = {}) {
    const wanted = asStatusFilter(status, "status", TASK_STATUSES);
    const state = this.require();
    return clone(state.tasks.filter((t) => wanted === null || t.status === wanted));
  }

  // --- decisions ----------------------------------------------------------

  recordDecision({
    title,
    detail = null,
    rationale = null,
    kind = DECISION_KIND.OTHER,
    alternatives = [],
    supersedes = null,
    taskId = null,
    sessionId = null,
    commit = null,
  } = {}) {
    const cleanTitle = asString(title, "title", { required: true });
    const cleanDetail = asText(detail, "detail");
    const cleanRationale = asText(rationale, "rationale");
    const cleanKind = asOneOf(kind, "kind", DECISION_KINDS, { fallback: DECISION_KIND.OTHER });
    const alts = asList(alternatives, "alternatives");
    const ref = sessionId ? asRef(sessionId, "sessionId") : null;
    const sha = commit === null ? null : asSha(commit, "commit");
    const task = taskId === null ? null : asRef(taskId, "taskId");
    const superseded = supersedes === null ? null : asRef(supersedes, "supersedes");

    return this.mutate(
      (state) => {
        if (task) this.find(state, "tasks", task);
        const previous = superseded ? this.find(state, "decisions", superseded) : null;
        if (ref) addUnique(state.sessionIds, ref);
        if (sha) addUnique(state.commits, sha);

        const record = {
          id: this.nextId(state, "decision", "d"),
          kind: cleanKind,
          title: cleanTitle,
          detail: cleanDetail,
          rationale: cleanRationale,
          alternatives: alts,
          status: "active",
          supersedes: superseded,
          supersededBy: null,
          taskId: task,
          sessionId: ref,
          commit: sha,
          createdAt: this.ts(),
        };
        if (previous) {
          previous.status = "superseded";
          previous.supersededBy = record.id;
        }
        state.decisions.push(record);
        return clone(record);
      },
      [
        {
          checkpoint: CHECKPOINT.DECISION_RECORDED,
          summary: cleanTitle,
          ...(task ? { taskId: task } : {}),
          ...(ref ? { sessionId: ref } : {}),
        },
      ],
    );
  }

  decisions({ activeOnly = false } = {}) {
    const state = this.require();
    return clone(state.decisions.filter((d) => !activeOnly || d.status === "active"));
  }

  // --- blockers -----------------------------------------------------------

  recordBlocker({
    title,
    detail = null,
    severity = SEVERITY.MEDIUM,
    taskId = null,
    sessionId = null,
    raisedBy = null,
  } = {}) {
    const cleanTitle = asString(title, "title", { required: true });
    const cleanDetail = asText(detail, "detail");
    const sev = asOneOf(severity, "severity", SEVERITIES, { fallback: SEVERITY.MEDIUM });
    const task = taskId === null ? null : asRef(taskId, "taskId");
    const ref = sessionId ? asRef(sessionId, "sessionId") : null;
    const by = raisedBy ? asRef(raisedBy, "raisedBy") : null;

    return this.mutate((state) => {
      if (task) this.find(state, "tasks", task);
      if (ref) addUnique(state.sessionIds, ref);
      const ts = this.ts();
      const record = {
        id: this.nextId(state, "blocker", "b"),
        title: cleanTitle,
        detail: cleanDetail,
        severity: sev,
        status: "open",
        taskId: task,
        sessionId: ref,
        raisedBy: by,
        createdAt: ts,
        resolvedAt: null,
        resolution: null,
      };
      state.blockers.push(record);
      if (task) this.markTaskBlocked(state, task, record.id, ts);
      return clone(record);
    });
  }

  resolveBlocker(id, resolution) {
    const blockerId = asRef(id, "id", { required: true });
    const clean = asText(resolution, "resolution", { required: true });
    return this.mutate((state) => {
      const record = this.find(state, "blockers", blockerId);
      record.status = "resolved";
      record.resolution = clean;
      record.resolvedAt = this.ts();
      return clone(record);
    });
  }

  blockers({ status = null } = {}) {
    const wanted = asStatusFilter(status, "status", new Set(["open", "resolved", "accepted"]));
    const state = this.require();
    return clone(state.blockers.filter((b) => wanted === null || b.status === wanted));
  }

  // --- bugs ---------------------------------------------------------------

  recordBug({
    title,
    detail = null,
    severity = SEVERITY.MEDIUM,
    taskId = null,
    sessionId = null,
    discoveredBy = null,
  } = {}) {
    const cleanTitle = asString(title, "title", { required: true });
    const cleanDetail = asText(detail, "detail");
    const sev = asOneOf(severity, "severity", SEVERITIES, { fallback: SEVERITY.MEDIUM });
    const task = taskId === null ? null : asRef(taskId, "taskId");
    const ref = sessionId ? asRef(sessionId, "sessionId") : null;
    const by = discoveredBy ? asRef(discoveredBy, "discoveredBy") : null;

    return this.mutate(
      (state) => {
        if (task) this.find(state, "tasks", task);
        if (ref) addUnique(state.sessionIds, ref);
        const record = {
          id: this.nextId(state, "bug", "k"),
          title: cleanTitle,
          detail: cleanDetail,
          severity: sev,
          status: "open",
          taskId: task,
          sessionId: ref,
          discoveredBy: by,
          createdAt: this.ts(),
          fixedAt: null,
          resolution: null,
        };
        state.bugs.push(record);
        return clone(record);
      },
      [
        {
          checkpoint: CHECKPOINT.BUG_IDENTIFIED,
          summary: cleanTitle,
          ...(task ? { taskId: task } : {}),
        },
      ],
    );
  }

  fixBug(id, resolution = null) {
    const bugId = asRef(id, "id", { required: true });
    const clean = asText(resolution, "resolution");
    let title = null;
    return this.mutate(
      (state) => {
        const record = this.find(state, "bugs", bugId);
        title = record.title;
        record.status = "fixed";
        record.resolution = clean;
        record.fixedAt = this.ts();
        return clone(record);
      },
      [{ checkpoint: CHECKPOINT.BUG_FIXED, summary: `${title} -> fixed` }],
    );
  }

  bugs({ status = null } = {}) {
    const wanted = asStatusFilter(status, "status", new Set(["open", "fixed", "wontfix"]));
    const state = this.require();
    return clone(state.bugs.filter((b) => wanted === null || b.status === wanted));
  }

  // --- questions ----------------------------------------------------------

  recordQuestion({ question, detail = null, taskId = null, sessionId = null } = {}) {
    const cleanQuestion = asString(question, "question", { required: true });
    const cleanDetail = asText(detail, "detail");
    const task = taskId === null ? null : asRef(taskId, "taskId");
    const ref = sessionId ? asRef(sessionId, "sessionId") : null;

    return this.mutate((state) => {
      if (task) this.find(state, "tasks", task);
      if (ref) addUnique(state.sessionIds, ref);
      const record = {
        id: this.nextId(state, "question", "q"),
        question: cleanQuestion,
        detail: cleanDetail,
        status: "open",
        answer: null,
        taskId: task,
        sessionId: ref,
        createdAt: this.ts(),
        answeredAt: null,
      };
      state.questions.push(record);
      return clone(record);
    });
  }

  answerQuestion(id, answer) {
    const questionId = asRef(id, "id", { required: true });
    const clean = asText(answer, "answer", { required: true });
    return this.mutate((state) => {
      const record = this.find(state, "questions", questionId);
      record.status = "answered";
      record.answer = clean;
      record.answeredAt = this.ts();
      return clone(record);
    });
  }

  questions({ status = null } = {}) {
    const wanted = asStatusFilter(status, "status", new Set(["open", "answered", "dismissed"]));
    const state = this.require();
    return clone(state.questions.filter((q) => wanted === null || q.status === wanted));
  }

  // --- assumptions --------------------------------------------------------

  recordAssumption({ statement, basis = null, taskId = null } = {}) {
    const clean = asText(statement, "statement", { required: true });
    const cleanBasis = asText(basis, "basis");
    const task = taskId === null ? null : asRef(taskId, "taskId");
    return this.mutate((state) => {
      if (task) this.find(state, "tasks", task);
      const record = {
        id: this.nextId(state, "assumption", "a"),
        statement: clean,
        basis: cleanBasis,
        status: "active",
        taskId: task,
        createdAt: this.ts(),
        invalidatedAt: null,
        reason: null,
      };
      state.assumptions.push(record);
      return clone(record);
    });
  }

  invalidateAssumption(id, reason = null) {
    const assumptionId = asRef(id, "id", { required: true });
    const clean = asText(reason, "reason");
    return this.mutate((state) => {
      const record = this.find(state, "assumptions", assumptionId);
      record.status = "invalidated";
      record.reason = clean;
      record.invalidatedAt = this.ts();
      return clone(record);
    });
  }

  assumptions({ status = null } = {}) {
    const wanted = asStatusFilter(status, "status", new Set(["active", "confirmed", "invalidated"]));
    const state = this.require();
    return clone(state.assumptions.filter((a) => wanted === null || a.status === wanted));
  }

  // --- findings -----------------------------------------------------------

  recordFinding({
    title,
    detail = null,
    source = FINDING_SOURCE.AGENT,
    author = null,
    severity = SEVERITY.INFO,
    taskId = null,
    sessionId = null,
    files = [],
    status = "open",
  } = {}) {
    const cleanTitle = asString(title, "title", { required: true });
    const cleanDetail = asText(detail, "detail");
    const cleanSource = asOneOf(source, "source", FINDING_SOURCES, { fallback: FINDING_SOURCE.AGENT });
    const sev = asOneOf(severity, "severity", SEVERITIES, { fallback: SEVERITY.INFO });
    const task = taskId === null ? null : asRef(taskId, "taskId");
    const ref = sessionId ? asRef(sessionId, "sessionId") : null;
    const by = author ? asRef(author, "author") : null;
    const fileList = asList(files, "files", { max: 16, item: asFilePath });
    const cleanStatus = asOneOf(status, "status", FINDING_STATUSES, { fallback: "open" });

    return this.mutate((state) => {
      if (task) this.find(state, "tasks", task);
      if (ref) addUnique(state.sessionIds, ref);
      const record = {
        id: this.nextId(state, "finding", "f"),
        source: cleanSource,
        author: by,
        severity: sev,
        title: cleanTitle,
        detail: cleanDetail,
        status: cleanStatus,
        taskId: task,
        sessionId: ref,
        files: fileList,
        createdAt: this.ts(),
        updatedAt: null,
      };
      state.findings.push(record);
      return clone(record);
    });
  }

  updateFinding(id, { status = null, detail = null } = {}) {
    const findingId = asRef(id, "id", { required: true });
    const cleanStatus = status === null ? null : asOneOf(status, "status", FINDING_STATUSES);
    const cleanDetail = detail === null ? null : asText(detail, "detail");
    return this.mutate((state) => {
      const record = this.find(state, "findings", findingId);
      if (cleanStatus) record.status = cleanStatus;
      if (cleanDetail) record.detail = cleanDetail;
      record.updatedAt = this.ts();
      return clone(record);
    });
  }

  findings({ source = null, status = null } = {}) {
    const wantedSource = asStatusFilter(source, "source", FINDING_SOURCES);
    const wantedStatus = asStatusFilter(status, "status", FINDING_STATUSES);
    const state = this.require();
    return clone(
      state.findings.filter(
        (f) =>
          (wantedSource === null || f.source === wantedSource) && (wantedStatus === null || f.status === wantedStatus),
      ),
    );
  }

  // --- reviews ------------------------------------------------------------

  /**
   * A completed review is a checkpoint, not merely another finding: the whole
   * point of recording it is that a gate was cleared by a second pair of eyes.
   */
  recordReview({ summary, verdict = null, findings = [], sessionId = null } = {}) {
    const cleanSummary = asString(summary, "summary", { required: true });
    const cleanVerdict = asString(verdict, "verdict");
    const ref = sessionId ? asRef(sessionId, "sessionId") : null;
    if (!Array.isArray(findings)) throw new ValidationError("findings must be an array", "findings");
    if (findings.length > 16) throw new ValidationError("findings exceeds 16 entries", "findings");

    return this.mutate(
      (state) => {
        if (ref) addUnique(state.sessionIds, ref);
        const record = {
          id: this.nextId(state, "review", "rv"),
          summary: cleanSummary,
          verdict: cleanVerdict,
          findings: findings.map((item) => {
            if (!item || typeof item !== "object" || Array.isArray(item)) {
              throw new ValidationError("each finding must be an object", "findings[]");
            }
            return {
              title: asString(item.title, "findings[].title", { required: true }),
              severity: asOneOf(item.severity ?? null, "findings[].severity", SEVERITIES, {
                fallback: SEVERITY.MEDIUM,
              }),
            };
          }),
          sessionId: ref,
          createdAt: this.ts(),
        };
        state.reviews.push(record);
        return clone(record);
      },
      [{ checkpoint: CHECKPOINT.REVIEW_COMPLETED, summary: cleanSummary, ...(ref ? { sessionId: ref } : {}) }],
    );
  }

  reviews() {
    return clone(this.require().reviews);
  }

  // --- implementation, files, commits --------------------------------------

  /**
   * Record that implementation happened: which files, which commits.
   *
   * This is a *reference* record. Contents stay in git; if the two ever diverge,
   * git is right and this is stale.
   */
  recordImplementation({ summary, files = [], commits = [], sessionId = null, taskId = null } = {}) {
    const cleanSummary = asString(summary, "summary", { required: true });
    const fileList = asList(files, "files", { max: 64, item: asFilePath });
    const shas = asList(commits, "commits", { max: 64, item: asSha });
    const ref = sessionId ? asRef(sessionId, "sessionId") : null;
    const task = taskId === null ? null : asRef(taskId, "taskId");

    return this.mutate(
      (state) => {
        if (task) this.find(state, "tasks", task);
        if (ref) addUnique(state.sessionIds, ref);
        const ts = this.ts();
        for (const file of fileList) state.files[file] = { reason: cleanSummary, lastTouchedAt: ts };
        for (const sha of shas) addUnique(state.commits, sha);
        return { files: fileList, commits: shas };
      },
      [
        {
          checkpoint: CHECKPOINT.IMPLEMENTATION_UPDATED,
          summary: cleanSummary,
          ...(task ? { taskId: task } : {}),
        },
      ],
    );
  }

  files() {
    return clone(this.require().files);
  }

  commits() {
    return clone(this.require().commits);
  }

  // --- tests --------------------------------------------------------------

  /**
   * Record a test run. The checkpoint follows the outcome: a passing run and a
   * failing run are different facts, and a timeline that cannot tell them apart
   * is not a timeline.
   */
  recordTest({
    suite,
    command = null,
    passed = 0,
    failed = 0,
    skipped = 0,
    durationMs = null,
    failures = [],
    taskId = null,
    sessionId = null,
    commit = null,
  } = {}) {
    const cleanSuite = asString(suite, "suite", { required: true });
    const cleanCommand = asString(command, "command", { max: MAX_TEXT });
    const p = asNumber(passed, "passed") ?? 0;
    const f = asNumber(failed, "failed") ?? 0;
    const s = asNumber(skipped, "skipped") ?? 0;
    const duration = asNumber(durationMs, "durationMs");
    const failureList = asList(failures, "failures", { max: 32 });
    const task = taskId === null ? null : asRef(taskId, "taskId");
    const ref = sessionId ? asRef(sessionId, "sessionId") : null;
    const sha = commit === null ? null : asSha(commit, "commit");
    // A run with nothing passing counts as a failure: zero passing tests means
    // nothing was verified, and recording that as success would be a lie.
    const failedRun = f > 0 || p === 0;

    return this.mutate(
      (state) => {
        if (task) this.find(state, "tasks", task);
        if (ref) addUnique(state.sessionIds, ref);
        if (sha) addUnique(state.commits, sha);
        const record = {
          id: this.nextId(state, "test", "tr"),
          suite: cleanSuite,
          command: cleanCommand,
          passed: p,
          failed: f,
          skipped: s,
          durationMs: duration,
          failures: failureList,
          taskId: task,
          sessionId: ref,
          commit: sha,
          createdAt: this.ts(),
        };
        state.tests.push(record);
        return clone(record);
      },
      [
        {
          checkpoint: failedRun ? CHECKPOINT.TEST_FAILED : CHECKPOINT.TEST_PASSED,
          summary: `${cleanSuite}: ${p} passed, ${f} failed`,
          ...(task ? { taskId: task } : {}),
        },
      ],
    );
  }

  tests({ latestOnly = false } = {}) {
    const state = this.require();
    if (!latestOnly) return clone(state.tests);
    const bySuite = new Map();
    for (const test of state.tests) bySuite.set(test.suite, test);
    return clone([...bySuite.values()]);
  }

  // --- evidence -----------------------------------------------------------

  recordEvidence({ kind, ref, note = null, taskId = null, sessionId = null } = {}) {
    const cleanKind = asOneOf(kind, "kind", EVIDENCE_KINDS);
    const cleanRef = asString(ref, "ref", { max: 400, required: true });
    const cleanNote = asText(note, "note");
    const task = taskId === null ? null : asRef(taskId, "taskId");
    const refId = sessionId ? asRef(sessionId, "sessionId") : null;

    return this.mutate((state) => {
      if (task) this.find(state, "tasks", task);
      if (refId) addUnique(state.sessionIds, refId);
      const record = {
        id: this.nextId(state, "evidence", "e"),
        kind: cleanKind,
        ref: cleanRef,
        note: cleanNote,
        taskId: task,
        sessionId: refId,
        createdAt: this.ts(),
      };
      state.evidence.push(record);
      return clone(record);
    });
  }

  evidence() {
    return clone(this.require().evidence);
  }

  // --- next action and sessions -------------------------------------------

  /**
   * The single most important field for handoff: what should happen next.
   *
   * Setting it explicitly is the point of the subsystem. An agent that stops
   * without writing this leaves the next agent to guess, which is the exact
   * failure this module exists to prevent.
   */
  setNextAction({ text, taskId = null, sessionId = null } = {}) {
    const clean = asText(text, "text", { required: true });
    const task = taskId === null ? null : asRef(taskId, "taskId");
    const ref = sessionId ? asRef(sessionId, "sessionId") : null;

    return this.mutate(
      (state) => {
        if (task) this.find(state, "tasks", task);
        if (ref) addUnique(state.sessionIds, ref);
        state.nextAction = { text: clean, taskId: task, sessionId: ref, createdAt: this.ts() };
        return clone(state.nextAction);
      },
      [
        {
          checkpoint: CHECKPOINT.NEXT_ACTION_SET,
          summary: clean,
          ...(task ? { taskId: task } : {}),
          ...(ref ? { sessionId: ref } : {}),
        },
      ],
    );
  }

  clearNextAction() {
    return this.mutate((state) => {
      state.nextAction = null;
      return null;
    });
  }

  /**
   * Link a session by reference.
   *
   * Deliberately no content is copied in either direction: the session already
   * points back through its own `blackboardRefs`, so both sides hold an id and
   * neither can contradict the other.
   */
  linkSession(sessionId) {
    const ref = asRef(sessionId, "sessionId", { required: true });
    return this.mutate((state) => {
      addUnique(state.sessionIds, ref);
      return clone(state.sessionIds);
    });
  }

  unlinkSession(sessionId) {
    const ref = asRef(sessionId, "sessionId", { required: true });
    return this.mutate((state) => {
      state.sessionIds = state.sessionIds.filter((id) => id !== ref);
      return clone(state.sessionIds);
    });
  }

  // --- timeline -----------------------------------------------------------

  /** Read the append-only checkpoint timeline. Never used to rebuild state. */
  timeline({ limit = 0 } = {}) {
    let raw;
    try {
      raw = fs.readFileSync(this.eventsFile(), "utf8");
    } catch (err) {
      if (err.code === "ENOENT") return [];
      throw err;
    }
    const entries = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        // A torn final line is expected after a crash mid-append. Losing the last
        // checkpoint is acceptable; refusing to read the log is not.
        entries.push({ corrupt: true, raw: line.slice(0, 200) });
      }
    }
    return limit > 0 ? entries.slice(-limit) : entries;
  }

  /**
   * Everything a fresh agent needs in order to continue, in one call.
   *
   * Ordered by what an agent reads first, and deliberately not the whole state
   * document: the point is fast recovery, and an agent that must page through 500
   * findings to find the next action has not been helped.
   */
  summary() {
    const state = this.require();
    const open = (list) => list.filter((r) => OPEN_STATUSES.has(r.status));
    return {
      id: state.id,
      projectRoot: state.projectRoot,
      goal: state.goal,
      objective: state.objective,
      nextAction: clone(state.nextAction),
      updatedAt: state.updatedAt,
      inProgress: clone(state.tasks.filter((t) => t.status === TASK_STATUS.IN_PROGRESS)),
      openTasks: clone(
        state.tasks.filter((t) => t.status === TASK_STATUS.PENDING || t.status === TASK_STATUS.BLOCKED),
      ),
      doneTasks: clone(state.tasks.filter((t) => t.status === TASK_STATUS.DONE)),
      activeDecisions: clone(state.decisions.filter((d) => d.status === "active")),
      openBlockers: clone(open(state.blockers)),
      openBugs: clone(open(state.bugs)),
      openQuestions: clone(open(state.questions)),
      activeAssumptions: clone(open(state.assumptions)),
      openFindings: clone(open(state.findings).slice(-10)),
      latestTests: this.tests({ latestOnly: true }),
      reviews: clone(state.reviews.slice(-5)),
      files: Object.keys(state.files).slice(-20),
      commits: state.commits.slice(-10),
      sessionIds: state.sessionIds.slice(),
      dropped: clone(state.dropped),
      recentCheckpoints: this.timeline({ limit: 10 }),
    };
  }

  /**
   * Remove this project's Blackboard.
   *
   * Requires `confirm` to equal the blackboard id, so a stray call cannot destroy
   * a project's recorded state just because someone typed the command.
   */
  destroy({ confirm = null } = {}) {
    if (confirm !== this.id) throw new ValidationError(`destroy requires confirm === ${this.id}`, "confirm");
    return this.withLock(() => {
      const removed = [];
      for (const file of [this.stateFile(), this.eventsFile(), this.lockFile()]) {
        try {
          fs.unlinkSync(file);
          removed.push(file);
        } catch (err) {
          if (err.code !== "ENOENT") throw err;
        }
      }
      return removed;
    });
  }
}

export default BlackboardStore;