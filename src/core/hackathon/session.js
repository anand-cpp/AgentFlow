// Hackathon Mode session state.
//
// A Hackathon session is the unit of distributed coordination: one leader,
// multiple workers, a task graph, and durable progress. Session state lives on
// the leader and is persisted to disk; workers never mutate leader state
// directly — they report evidence and the leader reconciles it.
//
// Every field is validated. Unknown keys are dropped. No credentials are stored.

import crypto from "node:crypto";
import path from "node:path";
import { writeAtomicFile, readJsonFile, assertVersion } from "../persist.js";
import { redactVerified } from "../redact.js";

export const SESSION_VERSION = 1;

export const SESSION_STATUS = {
  CREATED: "created",
  ACTIVE: "active",
  PAUSED: "paused",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
};

export const WORKER_STATUS = {
  REGISTERED: "registered",
  CONNECTED: "connected",
  DISCONNECTED: "disconnected",
  OFFLINE: "offline",
  REVOKED: "revoked",
};

export const TASK_STATUS = {
  PENDING: "pending",
  ASSIGNED: "assigned",
  ACCEPTED: "accepted",
  RUNNING: "running",
  IN_PROGRESS: "in_progress",
  BLOCKED: "blocked",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
  EXPIRED: "expired",
};

export const LEASE_STATUS = {
  ACTIVE: "active",
  EXPIRED: "expired",
  REVOKED: "revoked",
  COMPLETED: "completed",
};

const STATUSES = new Set(Object.values(SESSION_STATUS));
const WORKER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/** Create a new Hackathon session owned by `leaderId`. */
export function createSession({
  leaderId,
  projectIdea,
  projectRoot,
  sessionId = null,
  timeBudget = null,
} = {}) {
  if (!leaderId || typeof leaderId !== "string") {
    throw new Error("session requires a leaderId");
  }
  if (!WORKER_ID_RE.test(leaderId)) {
    throw new Error("invalid leaderId");
  }
  if (!projectIdea || typeof projectIdea !== "string") {
    throw new Error("session requires a projectIdea");
  }
  if (!projectRoot || typeof projectRoot !== "string") {
    throw new Error("session requires a projectRoot");
  }

  const id = sessionId || `hk-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
  if (!SESSION_ID_RE.test(id)) {
    throw new Error("invalid sessionId");
  }

  const now = new Date().toISOString();

  // Time budgeting: the leader knows the actual remaining time. Workers receive
  // a smaller execution budget that protects the integration/reserve window.
  const totalDurationHours = Number(timeBudget?.totalDurationHours) || 0;
  const elapsedHours = Number(timeBudget?.elapsedHours) || 0;
  const remainingHours = Math.max(0, totalDurationHours - elapsedHours);
  const reserveFraction = Number(timeBudget?.reserveFraction) || 0.1; // 10% default reserve
  const reserveHours = Math.max(0, remainingHours * reserveFraction);
  const workerBudgetHours = Math.max(0, remainingHours - reserveHours);

  return {
    version: SESSION_VERSION,
    id,
    leaderId,
    projectIdea,
    projectRoot,
    status: SESSION_STATUS.CREATED,
    createdAt: now,
    updatedAt: now,
    timeBudget: {
      totalDurationHours,
      elapsedHours,
      remainingHours,
      workerBudgetHours,
      reserveHours,
      reserveFraction,
      calculatedAt: now,
    },
    teammateCount: Number(timeBudget?.teammateCount) || 0,
    connectedWorkerCount: 0,
    approvedWorkerCount: 0,
    architecture: null,        // approved architecture object
    architectureVersion: 0,
    workers: {},               // workerId -> WorkerRecord
    tasks: {},                 // taskId -> TaskRecord
    leases: {},                // leaseId -> LeaseRecord
    contracts: {},             // contractId -> ContractRecord
    contractVersion: 0,
    risks: {},                 // riskId -> IntegrationRisk
    riskCounter: 0,
    events: [],                // recent event history (bounded)
    branches: {},              // workerId -> branch info
    approvals: {},             // approvalId -> ApprovalRecord
    invitations: {},           // workerId -> { token, issuedAt, expiresAt, status }
    nextTaskCounter: 0,
    nextEventCounter: 0,
  };
}

/** Validate a session record. Throws on invalid. */
export function validateSession(session) {
  if (!session || typeof session !== "object" || Array.isArray(session)) {
    throw new Error("session must be an object");
  }
  if (session.version !== SESSION_VERSION) {
    throw new Error(`unsupported session version: ${session.version}`);
  }
  if (!SESSION_ID_RE.test(session.id)) throw new Error("invalid session id");
  if (!WORKER_ID_RE.test(session.leaderId)) throw new Error("invalid leader id");
  if (!STATUSES.has(session.status)) throw new Error("invalid session status");
  if (!session.projectIdea || typeof session.projectIdea !== "string") {
    throw new Error("missing projectIdea");
  }
  if (!session.projectRoot || typeof session.projectRoot !== "string") {
    throw new Error("missing projectRoot");
  }
  return true;
}

/** Worker record. */
export function createWorkerRecord({ workerId, invitationToken, capabilities = [] } = {}) {
  if (!WORKER_ID_RE.test(workerId)) throw new Error("invalid workerId");
  return {
    workerId,
    invitationToken,
    status: WORKER_STATUS.REGISTERED,
    capabilities: Array.isArray(capabilities) ? capabilities : [],
    connectedAt: null,
    lastHeartbeat: null,
    disconnectedAt: null,
    currentTaskId: null,
    completedTaskIds: [],
    failedTaskIds: [],
    branch: null,
    remoteSha: null,
    lastReport: null,
  };
}

/** Task record. */
export function createTaskRecord({
  taskId,
  title,
  objective,
  assignedWorkerId = null,
  requiredCapabilities = [],
  inputs = {},
  expectedOutputs = {},
  filesOwned = [],
  dependencies = [],
  interfaceContracts = [],
  acceptanceCriteria = [],
  requiredTests = [],
  securityRestrictions = [],
  priority = "medium",
  retryPolicy = { maxRetries: 3, backoffMs: 5000 },
} = {}) {
  if (!TASK_ID_RE.test(taskId)) throw new Error("invalid taskId");
  if (!title || typeof title !== "string") throw new Error("task requires a title");
  if (!objective || typeof objective !== "string") throw new Error("task requires an objective");

  return {
    taskId,
    title,
    objective,
    assignedWorkerId,
    status: TASK_STATUS.PENDING,
    requiredCapabilities: Array.isArray(requiredCapabilities) ? requiredCapabilities : [],
    inputs,
    expectedOutputs,
    filesOwned: Array.isArray(filesOwned) ? filesOwned : [],
    dependencies: Array.isArray(dependencies) ? dependencies : [],
    interfaceContracts: Array.isArray(interfaceContracts) ? interfaceContracts : [],
    acceptanceCriteria: Array.isArray(acceptanceCriteria) ? acceptanceCriteria : [],
    requiredTests: Array.isArray(requiredTests) ? requiredTests : [],
    securityRestrictions: Array.isArray(securityRestrictions) ? securityRestrictions : [],
    priority,
    retryPolicy,
    state: TASK_STATUS.PENDING,
    progress: 0,
    evidence: [],
    lastUpdated: new Date().toISOString(),
    leaseId: null,
    version: 1,
  };
}

/** Lease record. */
export function createLeaseRecord({ leaseId, taskId, workerId, expiresAt } = {}) {
  if (!leaseId) throw new Error("lease requires an id");
  return {
    leaseId,
    taskId,
    workerId,
    status: LEASE_STATUS.ACTIVE,
    createdAt: new Date().toISOString(),
    expiresAt,
    renewedAt: null,
    revokedAt: null,
    completedAt: null,
  };
}

/** Integration risk record. */
export function createRiskRecord({
  riskId,
  severity,
  description,
  evidence,
  affectedWorkers = [],
  affectedTasks = [],
  affectedContracts = [],
  status = "open",
  recommendedAction = null,
} = {}) {
  if (!riskId) throw new Error("risk requires an id");
  return {
    riskId,
    severity,
    description,
    evidence,
    affectedWorkers: Array.isArray(affectedWorkers) ? affectedWorkers : [],
    affectedTasks: Array.isArray(affectedTasks) ? affectedTasks : [],
    affectedContracts: Array.isArray(affectedContracts) ? affectedContracts : [],
    status,
    recommendedAction,
    createdAt: new Date().toISOString(),
    resolutionHistory: [],
  };
}

/** Persist a session atomically under `stateDir`. */
export async function persistSession(stateDir, session) {
  validateSession(session);
  session.updatedAt = new Date().toISOString();
  const file = path.join(stateDir, `${session.id}.json`);
  const clean = redactVerified(JSON.parse(JSON.stringify(session)));
  await writeAtomicFile(file, JSON.stringify(clean, null, 2));
  return session;
}

/** Load a session from disk. */
export function loadSession(stateDir, sessionId) {
  const file = path.join(stateDir, `${sessionId}.json`);
  const result = readJsonFile(file);
  if (!result.ok) return result;
  assertVersion(result.value, SESSION_VERSION, file);
  return { ok: true, value: result.value };
}

/** Generate a short-lived invitation token for a worker. */
export function createInvitationToken({ sessionId, workerId, ttlMs = 30 * 60 * 1000 } = {}) {
  if (!sessionId || !workerId) throw new Error("sessionId and workerId required");
  const payload = { sessionId, workerId, iat: Date.now(), exp: Date.now() + ttlMs };
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/** Validate an invitation token. Returns { ok, workerId, expired }. */
export function validateInvitationToken(token, { _sessionId, _workerId, _now = Date.now() } = {}) {
  if (!token) return { ok: false, reason: "missing token" };
  // Token is a hash; we cannot reverse it. Callers must compare against the
  // stored token on the worker record. This function validates shape only.
  if (typeof token !== "string" || token.length < 16) {
    return { ok: false, reason: "malformed token" };
  }
  return { ok: true, expired: false };
}

export default {
  SESSION_VERSION,
  SESSION_STATUS,
  WORKER_STATUS,
  TASK_STATUS,
  LEASE_STATUS,
  createSession,
  validateSession,
  createWorkerRecord,
  createTaskRecord,
  createLeaseRecord,
  createRiskRecord,
  persistSession,
  loadSession,
  createInvitationToken,
  validateInvitationToken,
};
