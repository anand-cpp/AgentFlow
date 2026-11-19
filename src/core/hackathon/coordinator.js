// Hackathon Mode coordinator runtime (leader side).
//
// The coordinator is the authoritative coordinator for a Hackathon session.
// It owns session state, worker registration, task assignment, and state
// reconciliation. Workers never mutate coordinator state directly — they
// report evidence and the coordinator reconciles it.
//
// Security: all worker operations require authenticated identity and valid
// session membership. Fail closed when authorization cannot be established.

import {
  SESSION_STATUS, WORKER_STATUS, TASK_STATUS,
  createSession, validateSession, persistSession, loadSession,
} from "./session.js";
import {
  issueInvitation, validateInvitation, revokeInvitation,
} from "./auth.js";
import { TaskGraph } from "./task-graph.js";
import { Scheduler } from "./scheduler.js";
import {
  HACKATHON_EVENTS, createEvent, validateEvent,
} from "./events.js";
import { validateTransition } from "./lifecycle.js";
import { DeviceRegistry, DEVICE_STATUS } from "./device-registry.js";
import { redactVerified } from "../redact.js";

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30 * 1000; // 30 seconds
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 90 * 1000; // 90 seconds
const DEFAULT_LEASE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_MAX_CONCURRENT_TASKS = 8;
const DEFAULT_MAX_CONCURRENT_WORKERS = 16;
const DEFAULT_MAX_RETRIES = 3;

// Deadline-aware execution thresholds (fraction of remaining time).
const DEADLINE_THRESHOLDS = {
  MORE_THAN_50: 0.5,   // > 50% remaining: core features + integration + testing
  TWENTY_FIVE_TO_50: 0.25, // 25–50%: prioritize core + integration
  TEN_TO_TWENTY_FIVE: 0.10, // 10–25%: stop optional, stabilize + fix
  LESS_THAN_10: 0.0,   // < 10%: critical bugs, security, build stability, submission
};

/** Execution policy based on time remaining. */
const DEADLINE_POLICIES = {
  [DEADLINE_THRESHOLDS.MORE_THAN_50]: {
    label: "implement",
    description: "Implement core features, integration, and testing",
    acceptOptional: true,
    maxConcurrentTasks: 8,
  },
  [DEADLINE_THRESHOLDS.TWENTY_FIVE_TO_50]: {
    label: "prioritize",
    description: "Prioritize core functionality and integration",
    acceptOptional: false,
    maxConcurrentTasks: 6,
  },
  [DEADLINE_THRESHOLDS.TEN_TO_TWENTY_FIVE]: {
    label: "stabilize",
    description: "Stop optional features; stabilize and fix important defects",
    acceptOptional: false,
    maxConcurrentTasks: 4,
  },
  [DEADLINE_THRESHOLDS.LESS_THAN_10]: {
    label: "critical",
    description: "Critical bugs, security, build stability, and submission only",
    acceptOptional: false,
    maxConcurrentTasks: 2,
  },
};

/** Priority order for task evaluation (1 = highest). */
const _TASK_PRIORITY_ORDER = [
  "critical_security",
  "crash_blocker",
  "core_functionality",
  "integration_failure",
  "important_defect",
  "deployment_reproducibility",
  "minor_ui",
  "optional_enhancement",
];

/** Result of a coordinator operation. */
class CoordinatorResult {
  constructor({ ok, error, data } = {}) {
    this.ok = ok;
    this.error = error;
    this.data = data;
  }
  static ok(data) { return new CoordinatorResult({ ok: true, data }); }
  static err(error) { return new CoordinatorResult({ ok: false, error }); }
}

/**
 * CoordinatorRuntime — leader-side execution runtime for Hackathon Mode.
 *
 * Responsibilities:
 *   - Session lifecycle (create, load, persist)
 *   - Authenticated worker registration and lifecycle
 *   - Task contract dispatch with capability and dependency validation
 *   - Task state transitions (validated via lifecycle)
 *   - Heartbeat monitoring and disconnection detection
 *   - Lease management (renewal, expiry, reassignment)
 *   - Event emission for all state changes
 *   - Bounded concurrency
 */
export class CoordinatorRuntime {
  constructor({
    stateDir = null,
    sessionId = null,
    heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
    heartbeatTimeoutMs = DEFAULT_HEARTBEAT_TIMEOUT_MS,
    leaseTtlMs = DEFAULT_LEASE_TTL_MS,
    maxConcurrentTasks = DEFAULT_MAX_CONCURRENT_TASKS,
    maxConcurrentWorkers = DEFAULT_MAX_CONCURRENT_WORKERS,
    maxRetries = DEFAULT_MAX_RETRIES,
    eventLog = null,
    bus = null,
  } = {}) {
    this.stateDir = stateDir;
    this.sessionId = sessionId;
    this.session = null;
    this.taskGraph = new TaskGraph();
    this.scheduler = new Scheduler({
      maxConcurrency: maxConcurrentTasks,
    });
    this.workers = new Map(); // workerId -> WorkerRecord (mirrors session.workers)
    this.transports = new Map(); // workerId -> transport
    this.eventLog = eventLog || null;
    this.bus = bus || null;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.heartbeatTimeoutMs = heartbeatTimeoutMs;
    this.leaseTtlMs = leaseTtlMs;
    this.maxConcurrentTasks = maxConcurrentTasks;
    this.maxConcurrentWorkers = maxConcurrentWorkers;
    this.maxRetries = maxRetries;
    this.deviceRegistry = new DeviceRegistry();
    this._heartbeatTimers = new Map(); // workerId -> timer
    this._nextEventSequence = 0;
    this._running = false;
  }

  /** Get the next event sequence number. */
  _nextSequence() {
    this._nextEventSequence += 1;
    return this._nextEventSequence;
  }

  /** Emit an event to the event log and transport bus. */
  _emitEvent(type, { workerId = null, taskId = null, payload = {} } = {}) {
    const event = createEvent({
      sessionId: this.session ? this.session.id : null,
      workerId,
      taskId,
      sequence: this._nextSequence(),
      type,
      payload,
    });
    validateEvent(event);

    if (this.eventLog) {
      this.eventLog.emit(type, {
        sessionId: event.sessionId,
        workerId: event.workerId,
        taskId: event.taskId,
        sequence: event.sequence,
        payload: redactVerified(event.payload),
      }, "info");
    }

    if (this.bus) {
      this.bus.publish(this.session ? this.session.id : null, event.toJSON()).catch(() => {
        /* bus publish failures must not block coordination */
      });
    }

    // Record in session event history (bounded).
    if (this.session) {
      if (!Array.isArray(this.session.events)) {
        this.session.events = [];
      }
      this.session.events.push(event.toJSON());
      const MAX_EVENTS = 1000;
      if (this.session.events.length > MAX_EVENTS) {
        this.session.events = this.session.events.slice(-MAX_EVENTS);
      }
    }

    return event;
  }

  /** Start a new Hackathon session. */
  async startSession({
    leaderId,
    projectIdea,
    projectRoot,
    sessionId = null,
    timeBudget = null,
  } = {}) {
    if (this._running) {
      return CoordinatorResult.err(new Error("coordinator already running"));
    }

    this.session = createSession({
      leaderId,
      projectIdea,
      projectRoot,
      sessionId,
      timeBudget,
    });
    this.session.status = SESSION_STATUS.ACTIVE;
    this._running = true;

    // Persist the session.
    if (this.stateDir) {
      await persistSession(this.stateDir, this.session);
    }

    this._emitEvent(HACKATHON_EVENTS.WORKER_REGISTERED, {
      payload: { leaderId, sessionId: this.session.id },
    });

    return CoordinatorResult.ok({
      sessionId: this.session.id,
      leaderId: this.session.leaderId,
      status: this.session.status,
      timeBudget: this.session.timeBudget,
    });
  }

  /** Load an existing session from disk. */
  async loadExistingSession(sessionId) {
    if (!this.stateDir) {
      return CoordinatorResult.err(new Error("no stateDir configured"));
    }
    const result = loadSession(this.stateDir, sessionId);
    if (!result.ok) {
      return CoordinatorResult.err(result.error || new Error("session not found"));
    }
    this.session = result.value;
    validateSession(this.session);
    this.sessionId = sessionId;
    this._running = true;

    // Rebuild task graph and worker registry from session state.
    for (const [_taskId, contract] of Object.entries(this.session.tasks || {})) {
      this.taskGraph.upsert(contract);
    }
    for (const [workerId, record] of Object.entries(this.session.workers || {})) {
      this.workers.set(workerId, record);
    }

    return CoordinatorResult.ok({
      sessionId: this.session.id,
      status: this.session.status,
    });
  }

  /** Create an invitation for a worker to join the session. */
  createInvitation({ workerId, ttlMs = 30 * 60 * 1000 } = {}) {
    if (!this.session) {
      return CoordinatorResult.err(new Error("no active session"));
    }
    if (!workerId) {
      return CoordinatorResult.err(new Error("workerId required"));
    }

    const invitation = issueInvitation({
      sessionId: this.session.id,
      workerId,
      ttlMs,
    });

    // Store the invitation token on a pending worker record.
    const pending = {
      workerId,
      invitationToken: invitation.token,
      status: WORKER_STATUS.REGISTERED,
      capabilities: [],
      connectedAt: null,
      lastHeartbeat: null,
      invitationExpiresAt: invitation.expiresAt,
    };
    this.workers.set(workerId, pending);

    this._emitEvent(HACKATHON_EVENTS.WORKER_REGISTERED, {
      workerId,
      payload: { invited: true, expiresAt: invitation.expiresAt },
    });

    return CoordinatorResult.ok(invitation);
  }

  /** Create invitations for multiple teammates. Each gets a unique token.
   *
   * Returns { invitations: [{ workerId, token, issuedAt, expiresAt }] }.
   * Every invitation is independent and single-use.
   */
  createInvitations({ workerIds, ttlMs = 30 * 60 * 1000 } = {}) {
    if (!this.session) {
      return CoordinatorResult.err(new Error("no active session"));
    }
    if (!Array.isArray(workerIds) || workerIds.length === 0) {
      return CoordinatorResult.err(new Error("workerIds must be a non-empty array"));
    }

    const invitations = [];
    for (const workerId of workerIds) {
      if (this.workers.has(workerId)) {
        return CoordinatorResult.err(new Error(
          `worker ${workerId} already has an invitation`,
        ));
      }

      const invitation = issueInvitation({
        sessionId: this.session.id,
        workerId,
        ttlMs,
      });

      const pending = {
        workerId,
        invitationToken: invitation.token,
        status: WORKER_STATUS.REGISTERED,
        capabilities: [],
        connectedAt: null,
        lastHeartbeat: null,
        invitationExpiresAt: invitation.expiresAt,
      };
      this.workers.set(workerId, pending);

      // Track the invitation in the session for audit/display.
      this.session.invitations = this.session.invitations || {};
      this.session.invitations[workerId] = {
        token: invitation.token,
        issuedAt: invitation.issuedAt,
        expiresAt: invitation.expiresAt,
        status: "pending",
      };

      invitations.push({
        workerId,
        token: invitation.token,
        issuedAt: invitation.issuedAt,
        expiresAt: invitation.expiresAt,
        status: "pending",
      });

      this._emitEvent(HACKATHON_EVENTS.WORKER_REGISTERED, {
        workerId,
        payload: { invited: true, expiresAt: invitation.expiresAt },
      });
    }

    // Persist session.
    if (this.stateDir) {
      // Note: persist is async; callers that need durability should await
      // persistSession separately. Here we fire-and-forget for the batch.
      void persistSession(this.stateDir, this.session);
    }

    return CoordinatorResult.ok({ invitations });
  }

  /** Register an authenticated worker. Validates the invitation token. */
  async registerWorker({ workerId, token, capabilities = [], transport = null } = {}) {
    if (!this.session) {
      return CoordinatorResult.err(new Error("no active session"));
    }
    if (!workerId || !token) {
      return CoordinatorResult.err(new Error("workerId and token required"));
    }

    const record = this.workers.get(workerId);
    if (!record) {
      return CoordinatorResult.err(new Error("worker not invited"));
    }

    const validation = validateInvitation({ token }, { workerRecord: record });
    if (!validation.ok) {
      return CoordinatorResult.err(new Error(validation.reason));
    }

    // Mark worker as registered/connected.
    record.status = WORKER_STATUS.CONNECTED;
    record.invitationToken = null; // consumed
    record.capabilities = capabilities;
    record.connectedAt = new Date().toISOString();
    record.lastHeartbeat = new Date().toISOString();

    if (transport) {
      this.transports.set(workerId, transport);
    }

    this.scheduler.registerWorker(workerId, { capabilities, available: true });

    // Register the device in the device registry and mark it pending approval.
    // The worker cannot receive project tasks until the Admin approves it.
    try {
      this.deviceRegistry.registerDevice({
        deviceId: workerId,
        sessionId: this.session.id,
        deviceInfo: { capabilities },
      });
      this.deviceRegistry.markPendingApproval(workerId);
    } catch {
      // Device already registered (e.g., reconnection) — ensure it's pending
      // approval if not already approved/rejected/revoked.
      const existing = this.deviceRegistry.getDevice(workerId);
      if (existing && existing.status === DEVICE_STATUS.REGISTERED) {
        this.deviceRegistry.markPendingApproval(workerId);
      }
    }

    this._emitEvent(HACKATHON_EVENTS.WORKER_CONNECTED, {
      workerId,
      payload: { capabilities, workerCount: this.workers.size },
    });

    // Start heartbeat monitoring for this worker.
    this._startHeartbeatMonitor(workerId);

    // Sync workers map to session for persistence.
    this.session.workers = {};
    for (const [wid, rec] of this.workers) {
      this.session.workers[wid] = { ...rec };
    }

    // Persist session.
    if (this.stateDir) {
      await persistSession(this.stateDir, this.session);
    }

    return CoordinatorResult.ok({
      workerId,
      sessionId: this.session.id,
      status: record.status,
    });
  }

  /** Record a worker heartbeat. Updates lastHeartbeat and resets the monitor. */
  heartbeat({ workerId, payload = {} } = {}) {
    if (!this.session) {
      return CoordinatorResult.err(new Error("no active session"));
    }
    const record = this.workers.get(workerId);
    if (!record) {
      return CoordinatorResult.err(new Error("unknown worker"));
    }
    if (record.status !== WORKER_STATUS.CONNECTED && record.status !== WORKER_STATUS.REGISTERED) {
      return CoordinatorResult.err(new Error("worker not connected"));
    }

    record.lastHeartbeat = new Date().toISOString();
    record.lastReport = payload;

    this._emitEvent(HACKATHON_EVENTS.WORKER_HEARTBEAT, {
      workerId,
      payload,
    });

    return CoordinatorResult.ok({ lastHeartbeat: record.lastHeartbeat });
  }

  /** Mark a worker as disconnected. Leases are NOT immediately revoked —
   *  offline work is allowed and reconciled on reconnection. */
  workerDisconnected({ workerId } = {}) {
    if (!this.session) {
      return CoordinatorResult.err(new Error("no active session"));
    }
    const record = this.workers.get(workerId);
    if (!record) {
      return CoordinatorResult.err(new Error("unknown worker"));
    }

    record.status = WORKER_STATUS.DISCONNECTED;
    record.disconnectedAt = new Date().toISOString();
    this.scheduler.workerDisconnected(workerId);

    this._emitEvent(HACKATHON_EVENTS.WORKER_DISCONNECTED, {
      workerId,
      payload: { disconnectedAt: record.disconnectedAt },
    });

    return CoordinatorResult.ok({ workerId, status: record.status });
  }

  /** Mark a worker as reconnected. Reconcile state and resume heartbeat monitoring. */
  async workerReconnected({ workerId, capabilities = [], transport = null } = {}) {
    if (!this.session) {
      return CoordinatorResult.err(new Error("no active session"));
    }
    const record = this.workers.get(workerId);
    if (!record) {
      return CoordinatorResult.err(new Error("unknown worker"));
    }

    record.status = WORKER_STATUS.CONNECTED;
    record.connectedAt = new Date().toISOString();
    record.disconnectedAt = null;
    record.lastHeartbeat = new Date().toISOString();
    record.capabilities = capabilities;

    if (transport) {
      this.transports.set(workerId, transport);
    }

    this.scheduler.workerReconnected(workerId);
    this._restartHeartbeatMonitor(workerId);

    this._emitEvent(HACKATHON_EVENTS.WORKER_RECONNECTED, {
      workerId,
      payload: { capabilities, reconciledAt: record.lastHeartbeat },
    });

    // Persist session.
    if (this.stateDir) {
      await persistSession(this.stateDir, this.session);
    }

    return CoordinatorResult.ok({
      workerId,
      status: record.status,
      activeTaskId: record.currentTaskId,
    });
  }

  /** Revoke a worker (permanent disconnection). Revoke all its leases. */
  revokeWorker({ workerId } = {}) {
    if (!this.session) {
      return CoordinatorResult.err(new Error("no active session"));
    }
    const record = this.workers.get(workerId);
    if (!record) {
      return CoordinatorResult.err(new Error("unknown worker"));
    }

    revokeInvitation(record);
    this.scheduler.revokeWorkerLeases(workerId);
    record.status = WORKER_STATUS.REVOKED;
    record.disconnectedAt = new Date().toISOString();
    this._stopHeartbeatMonitor(workerId);
    this.transports.delete(workerId);

    this._emitEvent(HACKATHON_EVENTS.WORKER_DISCONNECTED, {
      workerId,
      payload: { revoked: true },
    });

    return CoordinatorResult.ok({ workerId, status: record.status });
  }

  /** Approve a device for project-task access. Requires explicit Admin approval. */
  approveDevice({ workerId, approvedBy } = {}) {
    if (!this.session) {
      return CoordinatorResult.err(new Error("no active session"));
    }
    if (!workerId || !approvedBy) {
      return CoordinatorResult.err(new Error("workerId and approvedBy required"));
    }

    const record = this.workers.get(workerId);
    if (!record) {
      return CoordinatorResult.err(new Error(`unknown worker: ${workerId}`));
    }

    try {
      const device = this.deviceRegistry.approveDevice({ deviceId: workerId, approvedBy });

      this._emitEvent(HACKATHON_EVENTS.WORKER_REGISTERED, {
        workerId,
        payload: { deviceApproved: true, approvedBy },
      });

      return CoordinatorResult.ok({
        workerId,
        device: device,
        status: record.status,
      });
    } catch (err) {
      return CoordinatorResult.err(err);
    }
  }

  /** Reject a device (deny project-task access). */
  rejectDevice({ workerId, rejectedBy, reason } = {}) {
    if (!this.session) {
      return CoordinatorResult.err(new Error("no active session"));
    }
    if (!workerId || !rejectedBy) {
      return CoordinatorResult.err(new Error("workerId and rejectedBy required"));
    }

    try {
      const device = this.deviceRegistry.rejectDevice({
        deviceId: workerId,
        rejectedBy,
        reason,
      });

      this._emitEvent(HACKATHON_EVENTS.WORKER_DISCONNECTED, {
        workerId,
        payload: { deviceRejected: true, rejectedBy, reason },
      });

      return CoordinatorResult.ok({
        workerId,
        device: device,
        status: "rejected",
      });
    } catch (err) {
      return CoordinatorResult.err(err);
    }
  }

  /** Revoke a device (immediate isolation). Also revokes the worker. */
  revokeDevice({ workerId, revokedBy, reason } = {}) {
    if (!this.session) {
      return CoordinatorResult.err(new Error("no active session"));
    }
    if (!workerId || !revokedBy) {
      return CoordinatorResult.err(new Error("workerId and revokedBy required"));
    }

    // Revoke the worker first (leases, heartbeat, transport).
    const workerResult = this.revokeWorker({ workerId });
    if (!workerResult.ok) {
      return workerResult;
    }

    try {
      const device = this.deviceRegistry.revokeDevice({
        deviceId: workerId,
        revokedBy,
        reason,
      });

      this._emitEvent(HACKATHON_EVENTS.WORKER_DISCONNECTED, {
        workerId,
        payload: { deviceRevoked: true, revokedBy, reason },
      });

      return CoordinatorResult.ok({
        workerId,
        device: device,
        status: "revoked",
      });
    } catch (err) {
      return CoordinatorResult.err(err);
    }
  }

  /** List devices awaiting Admin approval. */
  getPendingDevices() {
    return this.deviceRegistry.getPendingApproval();
  }

  /** List all devices with their status. */
  getDevices() {
    return this.deviceRegistry.listDevices();
  }

  /** Get device stats by status. */
  getDeviceStats() {
    return this.deviceRegistry.getStats();
  }

  /** Check whether a worker's device is approved. */
  isDeviceApproved(workerId) {
    return this.deviceRegistry.isApproved(workerId);
  }

  /** Get a device record by id. */
  getDevice(workerId) {
    return this.deviceRegistry.getDevice(workerId);
  }

  /** Start heartbeat monitoring for a worker. */
  _startHeartbeatMonitor(workerId) {
    this._stopHeartbeatMonitor(workerId);
    const timer = setTimeout(() => {
      this._checkWorkerHeartbeat(workerId);
    }, this.heartbeatTimeoutMs);
    // unref so the monitor timer does not keep the process alive after tests exit.
    timer.unref?.();
    this._heartbeatTimers.set(workerId, timer);
  }

  /** Restart heartbeat monitoring (used on reconnect). */
  _restartHeartbeatMonitor(workerId) {
    this._startHeartbeatMonitor(workerId);
  }

  /** Stop heartbeat monitoring for a worker. */
  _stopHeartbeatMonitor(workerId) {
    const timer = this._heartbeatTimers.get(workerId);
    if (timer) {
      clearTimeout(timer);
      this._heartbeatTimers.delete(workerId);
    }
  }

  /** Check whether a worker's heartbeat has expired. */
  _checkWorkerHeartbeat(workerId) {
    const record = this.workers.get(workerId);
    if (!record) return;
    if (record.status !== WORKER_STATUS.CONNECTED) return;

    const lastBeat = Date.parse(record.lastHeartbeat || record.connectedAt);
    if (Date.now() - lastBeat > this.heartbeatTimeoutMs) {
      this.workerDisconnected({ workerId });
    } else {
      // Reschedule.
      this._startHeartbeatMonitor(workerId);
    }
  }

  /** Dispatch a task contract to a worker.
   *
   * Validates: contract exists, worker is registered and connected,
   * capabilities match, dependencies are satisfied, lease can be acquired.
   */
  async dispatchTask({ taskId, workerId } = {}) {
    if (!this.session) {
      return CoordinatorResult.err(new Error("no active session"));
    }
    if (!taskId || !workerId) {
      return CoordinatorResult.err(new Error("taskId and workerId required"));
    }

    const contract = this.taskGraph.get(taskId);
    if (!contract) {
      return CoordinatorResult.err(new Error(`unknown task: ${taskId}`));
    }

    const record = this.workers.get(workerId);
    if (!record) {
      return CoordinatorResult.err(new Error(`unknown worker: ${workerId}`));
    }
    if (record.status !== WORKER_STATUS.CONNECTED) {
      return CoordinatorResult.err(new Error(`worker not connected: ${workerId}`));
    }

    // Device approval: only approved devices may receive project tasks.
    if (!this.deviceRegistry.isApproved(workerId)) {
      const device = this.deviceRegistry.getDevice(workerId);
      const deviceState = device ? device.status : "unknown";
      return CoordinatorResult.err(new Error(
        `worker ${workerId} device is ${deviceState} — not approved for tasks`,
      ));
    }

    // Capability validation.
    if (!this.scheduler.canPerform(workerId, contract)) {
      return CoordinatorResult.err(new Error(
        `worker ${workerId} lacks required capabilities for task ${taskId}`,
      ));
    }

    // Dependency validation: all dependencies must be completed.
    const deps = contract.dependencies || [];
    for (const depId of deps) {
      const dep = this.taskGraph.get(depId);
      if (!dep || dep.state !== TASK_STATUS.COMPLETED) {
        return CoordinatorResult.err(new Error(
          `dependency ${depId} not completed for task ${taskId}`,
        ));
      }
    }

    // Concurrency check: worker's active lease count (deadline-aware).
    const activeLeases = this.scheduler.activeLeaseCount(workerId);
    const deadlineMaxConcurrent = this.getMaxConcurrentTasks();
    if (activeLeases >= deadlineMaxConcurrent) {
      return CoordinatorResult.err(new Error(
        `worker ${workerId} at max concurrent tasks (deadline limit: ${deadlineMaxConcurrent})`,
      ));
    }

    // Transition: PENDING/ASSIGNED -> ASSIGNED.
    const transition = validateTransition(contract.state, TASK_STATUS.ASSIGNED);
    if (!transition.ok) {
      return CoordinatorResult.err(new Error(
        `cannot assign task ${taskId}: ${transition.reason}`,
      ));
    }

    // Create lease.
    const lease = this.scheduler.createLease({
      taskId,
      workerId,
      ttlMs: this.leaseTtlMs,
    });

    // Update contract.
    contract.assignedWorkerId = workerId;
    contract.state = TASK_STATUS.ASSIGNED;
    contract.leaseId = lease.leaseId;
    contract.updatedAt = new Date().toISOString();
    this.taskGraph.upsert(contract);

    // Update worker record.
    record.currentTaskId = taskId;

    // Update session.
    this.session.tasks[taskId] = contract.toJSON();

    this._emitEvent(HACKATHON_EVENTS.TASK_DISPATCHED, {
      workerId,
      taskId,
      payload: { leaseId: lease.leaseId, ttlMs: this.leaseTtlMs },
    });

    // Persist session.
    if (this.stateDir) {
      await persistSession(this.stateDir, this.session);
    }

    return CoordinatorResult.ok({
      taskId,
      workerId,
      leaseId: lease.leaseId,
      expiresAt: lease.expiresAt,
      state: contract.state,
    });
  }

  /** Worker accepts a dispatched task. Validates ownership and lease. */
  async acceptTask({ taskId, workerId } = {}) {
    if (!this.session) {
      return CoordinatorResult.err(new Error("no active session"));
    }

    const contract = this.taskGraph.get(taskId);
    if (!contract) {
      return CoordinatorResult.err(new Error(`unknown task: ${taskId}`));
    }
    if (contract.assignedWorkerId !== workerId) {
      return CoordinatorResult.err(new Error(
        `task ${taskId} not assigned to worker ${workerId}`,
      ));
    }

    const lease = this.scheduler.getLease(taskId);
    if (!lease || lease.workerId !== workerId) {
      return CoordinatorResult.err(new Error(
        `no active lease for task ${taskId} held by worker ${workerId}`,
      ));
    }

    const transition = validateTransition(contract.state, TASK_STATUS.ACCEPTED);
    if (!transition.ok) {
      return CoordinatorResult.err(new Error(
        `cannot accept task ${taskId}: ${transition.reason}`,
      ));
    }

    contract.state = TASK_STATUS.ACCEPTED;
    contract.updatedAt = new Date().toISOString();
    this.taskGraph.upsert(contract);
    this.session.tasks[taskId] = contract.toJSON();

    this._emitEvent(HACKATHON_EVENTS.TASK_ACCEPTED, {
      workerId,
      taskId,
      payload: {},
    });

    if (this.stateDir) {
      await persistSession(this.stateDir, this.session);
    }

    return CoordinatorResult.ok({ taskId, workerId, state: contract.state });
  }

  /** Worker reports task started. Validates ownership and lease. */
  async taskStarted({ taskId, workerId } = {}) {
    if (!this.session) {
      return CoordinatorResult.err(new Error("no active session"));
    }

    const contract = this.taskGraph.get(taskId);
    if (!contract) {
      return CoordinatorResult.err(new Error(`unknown task: ${taskId}`));
    }
    if (contract.assignedWorkerId !== workerId) {
      return CoordinatorResult.err(new Error(
        `task ${taskId} not assigned to worker ${workerId}`,
      ));
    }

    const lease = this.scheduler.getLease(taskId);
    if (!lease || lease.workerId !== workerId) {
      return CoordinatorResult.err(new Error("no active lease"));
    }

    const transition = validateTransition(contract.state, TASK_STATUS.RUNNING);
    if (!transition.ok) {
      return CoordinatorResult.err(new Error(
        `cannot start task ${taskId}: ${transition.reason}`,
      ));
    }

    contract.state = TASK_STATUS.RUNNING;
    contract.progress = 0;
    contract.updatedAt = new Date().toISOString();
    this.taskGraph.upsert(contract);
    this.session.tasks[taskId] = contract.toJSON();

    this._emitEvent(HACKATHON_EVENTS.TASK_STARTED, {
      workerId,
      taskId,
      payload: {},
    });

    if (this.stateDir) {
      await persistSession(this.stateDir, this.session);
    }

    return CoordinatorResult.ok({ taskId, workerId, state: contract.state });
  }

  /** Worker reports progress on a task. */
  async taskProgress({ taskId, workerId, progress, evidence = [] } = {}) {
    if (!this.session) {
      return CoordinatorResult.err(new Error("no active session"));
    }
    if (progress === undefined || progress === null) {
      return CoordinatorResult.err(new Error("progress required"));
    }

    const contract = this.taskGraph.get(taskId);
    if (!contract) {
      return CoordinatorResult.err(new Error(`unknown task: ${taskId}`));
    }
    if (contract.assignedWorkerId !== workerId) {
      return CoordinatorResult.err(new Error(
        `task ${taskId} not assigned to worker ${workerId}`,
      ));
    }

    contract.progress = Math.min(100, Math.max(0, progress));
    contract.updatedAt = new Date().toISOString();
    if (evidence.length) {
      contract.evidence.push(...evidence.map((e) => ({ ...e, at: new Date().toISOString(), by: workerId })));
    }
    this.taskGraph.upsert(contract);
    this.session.tasks[taskId] = contract.toJSON();

    this._emitEvent(HACKATHON_EVENTS.TASK_PROGRESS, {
      workerId,
      taskId,
      payload: { progress: contract.progress, evidence },
    });

    if (this.stateDir) {
      await persistSession(this.stateDir, this.session);
    }

    return CoordinatorResult.ok({ taskId, workerId, progress: contract.progress });
  }

  /** Worker reports task completion with evidence.
   *
   * Requires requiredTests evidence. Self-reported completion is NOT
   * treated as independently verified — it is marked COMPLETED pending
   * supervisor verification (Phase 3).
   */
  async completeTask({ taskId, workerId, evidence = [], testResults = [] } = {}) {
    if (!this.session) {
      return CoordinatorResult.err(new Error("no active session"));
    }

    const contract = this.taskGraph.get(taskId);
    if (!contract) {
      return CoordinatorResult.err(new Error(`unknown task: ${taskId}`));
    }
    if (contract.assignedWorkerId !== workerId) {
      return CoordinatorResult.err(new Error(
        `task ${taskId} not assigned to worker ${workerId}`,
      ));
    }

    const lease = this.scheduler.getLease(taskId);
    if (!lease || lease.workerId !== workerId) {
      return CoordinatorResult.err(new Error("no active lease"));
    }

    const transition = validateTransition(contract.state, TASK_STATUS.COMPLETED);
    if (!transition.ok) {
      return CoordinatorResult.err(new Error(
        `cannot complete task ${taskId}: ${transition.reason}`,
      ));
    }

    // Require evidence for completion.
    const requiredTests = contract.requiredTests || [];
    const missingTests = requiredTests.filter((t) => !testResults.includes(t));
    if (missingTests.length > 0) {
      return CoordinatorResult.err(new Error(
        `task ${taskId} missing required test evidence: ${missingTests.join(", ")}`,
      ));
    }

    contract.state = TASK_STATUS.COMPLETED;
    contract.progress = 100;
    contract.evidence.push(...evidence.map((e) => ({ ...e, at: new Date().toISOString(), by: workerId })));
    contract.updatedAt = new Date().toISOString();
    this.taskGraph.upsert(contract);
    this.session.tasks[taskId] = contract.toJSON();

    // Complete the lease.
    this.scheduler.completeLease(lease.leaseId);

    // Update worker record.
    const record = this.workers.get(workerId);
    if (record) {
      record.currentTaskId = null;
      if (!record.completedTaskIds) record.completedTaskIds = [];
      record.completedTaskIds.push(taskId);
    }

    this._emitEvent(HACKATHON_EVENTS.TASK_COMPLETED, {
      workerId,
      taskId,
      payload: { evidence, testResults, verified: false },
    });

    if (this.stateDir) {
      await persistSession(this.stateDir, this.session);
    }

    return CoordinatorResult.ok({
      taskId,
      workerId,
      state: contract.state,
      verified: false, // pending Integration Supervisor verification (Phase 3)
    });
  }

  /** Worker reports task failure. */
  async failTask({ taskId, workerId, error, evidence = [] } = {}) {
    if (!this.session) {
      return CoordinatorResult.err(new Error("no active session"));
    }

    const contract = this.taskGraph.get(taskId);
    if (!contract) {
      return CoordinatorResult.err(new Error(`unknown task: ${taskId}`));
    }
    if (contract.assignedWorkerId !== workerId) {
      return CoordinatorResult.err(new Error(
        `task ${taskId} not assigned to worker ${workerId}`,
      ));
    }

    const transition = validateTransition(contract.state, TASK_STATUS.FAILED);
    if (!transition.ok) {
      return CoordinatorResult.err(new Error(
        `cannot fail task ${taskId}: ${transition.reason}`,
      ));
    }

    contract.state = TASK_STATUS.FAILED;
    contract.updatedAt = new Date().toISOString();
    contract.evidence.push(...evidence.map((e) => ({ ...e, at: new Date().toISOString(), by: workerId })));
    this.taskGraph.upsert(contract);
    this.session.tasks[taskId] = contract.toJSON();

    // Release the lease so the task can be reassigned.
    const lease = this.scheduler.getLease(taskId);
    if (lease) {
      this.scheduler.expireLease(lease.leaseId);
    }

    const record = this.workers.get(workerId);
    if (record) {
      record.currentTaskId = null;
      if (!record.failedTaskIds) record.failedTaskIds = [];
      record.failedTaskIds.push(taskId);
    }

    this._emitEvent(HACKATHON_EVENTS.TASK_FAILED, {
      workerId,
      taskId,
      payload: { error: String(error), evidence },
    });

    if (this.stateDir) {
      await persistSession(this.stateDir, this.session);
    }

    return CoordinatorResult.ok({ taskId, workerId, state: contract.state });
  }

  /** Cancel a task. Releases the lease and makes the task reassignable. */
  async cancelTask({ taskId, workerId = null } = {}) {
    if (!this.session) {
      return CoordinatorResult.err(new Error("no active session"));
    }

    const contract = this.taskGraph.get(taskId);
    if (!contract) {
      return CoordinatorResult.err(new Error(`unknown task: ${taskId}`));
    }

    const transition = validateTransition(contract.state, TASK_STATUS.CANCELLED);
    if (!transition.ok) {
      return CoordinatorResult.err(new Error(
        `cannot cancel task ${taskId}: ${transition.reason}`,
      ));
    }

    contract.state = TASK_STATUS.CANCELLED;
    contract.updatedAt = new Date().toISOString();
    this.taskGraph.upsert(contract);
    this.session.tasks[taskId] = contract.toJSON();

    const lease = this.scheduler.getLease(taskId);
    if (lease) {
      this.scheduler.expireLease(lease.leaseId);
    }

    const assignedWorker = contract.assignedWorkerId;
    const record = this.workers.get(assignedWorker);
    if (record && record.currentTaskId === taskId) {
      record.currentTaskId = null;
    }

    this._emitEvent(HACKATHON_EVENTS.TASK_CANCELLED, {
      workerId: assignedWorker,
      taskId,
      payload: { cancelledBy: workerId || "coordinator" },
    });

    if (this.stateDir) {
      await persistSession(this.stateDir, this.session);
    }

    return CoordinatorResult.ok({ taskId, state: contract.state });
  }

  /** Renew a task lease. Validates worker ownership. */
  async renewLease({ taskId, workerId } = {}) {
    if (!this.session) {
      return CoordinatorResult.err(new Error("no active session"));
    }

    const lease = this.scheduler.getLease(taskId);
    if (!lease || lease.workerId !== workerId) {
      return CoordinatorResult.err(new Error(
        `no active lease for task ${taskId} held by worker ${workerId}`,
      ));
    }

    this.scheduler.renewLease(lease.leaseId, { ttlMs: this.leaseTtlMs });

    this._emitEvent(HACKATHON_EVENTS.LEASE_RENEWED, {
      workerId,
      taskId,
      payload: { leaseId: lease.leaseId, expiresAt: lease.expiresAt },
    });

    return CoordinatorResult.ok({ leaseId: lease.leaseId, expiresAt: lease.expiresAt });
  }

  /** Check for expired leases and expire them. Returns list of expired leases. */
  checkExpiredLeases() {
    const expired = this.scheduler.expiredLeases();
    for (const lease of expired) {
      const contract = this.taskGraph.get(lease.taskId);
      if (contract && contract.leaseId === lease.leaseId) {
        contract.state = TASK_STATUS.EXPIRED;
        contract.updatedAt = new Date().toISOString();
        this.taskGraph.upsert(contract);
        this.session.tasks[lease.taskId] = contract.toJSON();

        this._emitEvent(HACKATHON_EVENTS.LEASE_EXPIRED, {
          workerId: lease.workerId,
          taskId: lease.taskId,
          payload: { leaseId: lease.leaseId },
        });
      }
    }
    return expired;
  }

  /** Get session state summary. */
  getSessionState() {
    if (!this.session) return null;
    return {
      sessionId: this.session.id,
      status: this.session.status,
      leaderId: this.session.leaderId,
      workerCount: this.workers.size,
      connectedWorkers: [...this.workers.values()].filter((w) => w.status === WORKER_STATUS.CONNECTED).length,
      taskCount: Object.keys(this.session.tasks || {}).length,
      completedTasks: Object.values(this.session.tasks || {}).filter((t) => t.state === TASK_STATUS.COMPLETED).length,
      failedTasks: Object.values(this.session.tasks || {}).filter((t) => t.state === TASK_STATUS.FAILED).length,
    };
  }

  /** Get all tasks. */
  getTasks() {
    if (!this.session) return [];
    return Object.values(this.session.tasks || {});
  }

  /** Get all workers. */
  getWorkers() {
    return [...this.workers.values()];
  }

  /** Get deadline status: time remaining, budget, reserve, and fraction. */
  getDeadlineStatus() {
    if (!this.session) return null;
    const tb = this.session.timeBudget || {};
    const total = tb.totalDurationHours || 0;
    const elapsed = tb.elapsedHours || 0;
    const remaining = tb.remainingHours || 0;
    const workerBudget = tb.workerBudgetHours || 0;
    const reserve = tb.reserveHours || 0;

    const fraction = total > 0 ? remaining / total : 0;

    return {
      totalDurationHours: total,
      elapsedHours: elapsed,
      remainingHours: remaining,
      workerBudgetHours: workerBudget,
      reserveHours: reserve,
      remainingFraction: fraction,
      percentageRemaining: Math.round(fraction * 100),
      calculatedAt: tb.calculatedAt || null,
    };
  }

  /** Get the current deadline-aware execution policy. */
  getExecutionPolicy() {
    const status = this.getDeadlineStatus();
    if (!status) {
      return DEADLINE_POLICIES[DEADLINE_THRESHOLDS.MORE_THAN_50];
    }

    // No time budget configured — default to implement policy.
    if (status.totalDurationHours === 0) {
      return DEADLINE_POLICIES[DEADLINE_THRESHOLDS.MORE_THAN_50];
    }

    const { remainingFraction } = status;
    if (remainingFraction > DEADLINE_THRESHOLDS.MORE_THAN_50) {
      return DEADLINE_POLICIES[DEADLINE_THRESHOLDS.MORE_THAN_50];
    }
    if (remainingFraction > DEADLINE_THRESHOLDS.TWENTY_FIVE_TO_50) {
      return DEADLINE_POLICIES[DEADLINE_THRESHOLDS.TWENTY_FIVE_TO_50];
    }
    if (remainingFraction > DEADLINE_THRESHOLDS.TEN_TO_TWENTY_FIVE) {
      return DEADLINE_POLICIES[DEADLINE_THRESHOLDS.TEN_TO_TWENTY_FIVE];
    }
    return DEADLINE_POLICIES[DEADLINE_THRESHOLDS.LESS_THAN_10];
  }

  /** Whether optional (non-critical) work should be accepted. */
  shouldAcceptOptionalWork() {
    return this.getExecutionPolicy().acceptOptional;
  }

  /** Get the max concurrent tasks allowed under the current deadline policy. */
  getMaxConcurrentTasks() {
    const policy = this.getExecutionPolicy();
    return Math.min(policy.maxConcurrentTasks, this.maxConcurrentTasks);
  }

  /** Rank a task by deadline-aware priority. Lower rank = higher priority. */
  rankTaskPriority(task) {
    const priority = (task.priority || "medium").toLowerCase();
    const security = task.securityRestrictions || [];
    const isCriticalSecurity = security.includes("critical") ||
      priority === "critical_security";
    const isCrashBlocker = priority === "crash_blocker";
    const isCore = priority === "core_functionality";
    const isIntegration = priority === "integration_failure";
    const isImportant = priority === "important_defect";
    const isDeployment = priority === "deployment_reproducibility";
    const isMinorUI = priority === "minor_ui";

    if (isCriticalSecurity) return 1;
    if (isCrashBlocker) return 2;
    if (isCore) return 3;
    if (isIntegration) return 4;
    if (isImportant) return 5;
    if (isDeployment) return 6;
    if (isMinorUI) return 7;
    return 8; // optional_enhancement
  }

  /** Pause the session (no new task dispatching). */
  pauseSession() {
    if (!this.session) {
      return { ok: false, error: new Error("no active session") };
    }
    if (this.session.status === SESSION_STATUS.PAUSED) {
      return { ok: true, message: "already paused" };
    }
    this.session.status = SESSION_STATUS.PAUSED;
    this.session.updatedAt = new Date().toISOString();
    return { ok: true, status: SESSION_STATUS.PAUSED };
  }

  /** Resume the session (task dispatching resumes). */
  resumeSession() {
    if (!this.session) {
      return { ok: false, error: new Error("no active session") };
    }
    if (this.session.status === SESSION_STATUS.ACTIVE) {
      return { ok: true, message: "already active" };
    }
    this.session.status = SESSION_STATUS.ACTIVE;
    this.session.updatedAt = new Date().toISOString();
    return { ok: true, status: SESSION_STATUS.ACTIVE };
  }

  /** Shutdown the coordinator. Stop all heartbeat monitors. */
  async shutdown() {
    this._running = false;
    for (const workerId of this._heartbeatTimers.keys()) {
      this._stopHeartbeatMonitor(workerId);
    }
    this.transports.clear();
  }
}

export default { CoordinatorRuntime, CoordinatorResult };
