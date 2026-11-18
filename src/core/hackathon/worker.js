// Hackathon Mode worker runtime.
//
// A worker runs on a separate computer with its own AgentFlow process,
// AgentRuntime, model/provider, and local repository. It receives only
// authorized task contracts from the coordinator, executes them locally
// through its own AgentRuntime and permission system, and reports progress,
// evidence, and outcomes back to the coordinator.
//
// Security: workers never receive provider API keys, never get unrestricted
// filesystem access, and can only execute tasks assigned to them by the
// coordinator. All worker reports are treated as untrusted data by the
// coordinator.

import { TASK_STATUS } from "./session.js";
import {
  HACKATHON_EVENTS, createEvent,
} from "./events.js";
import { validateTransition } from "./lifecycle.js";
import { redactVerified } from "../redact.js";
import { AgentRuntime } from "../agents/runtime.js";
import { AgentRegistry } from "../agents/registry.js";
import { builtinSpecs } from "../agents/definitions.js";
import { createRealTools } from "../agents/real-tools.js";
import { complete } from "../gateway.js";

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30 * 1000; // 30 seconds
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_TASK_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/** Result of a worker operation. */
class WorkerResult {
  constructor({ ok, error, data } = {}) {
    this.ok = ok;
    this.error = error;
    this.data = data;
  }
  static ok(data) { return new WorkerResult({ ok: true, data }); }
  static err(error) { return new WorkerResult({ ok: false, error }); }
}

/**
 * WorkerRuntime — worker-side execution runtime for Hackathon Mode.
 *
 * Responsibilities:
 *   - Register with the coordinator using an invitation token
 *   - Receive and accept/reject task contracts
 *   - Execute tasks through a local AgentRuntime with mode-scoped permissions
 *   - Report progress, evidence, completion, and failure
 *   - Maintain task state across temporary disconnections
 *   - Send heartbeats to the coordinator
 *   - Reconnect and reconcile state after disconnection
 */
export class WorkerRuntime {
  constructor({
    workerId = null,
    sessionId = null,
    coordinator = null, // CoordinatorRuntime reference (local-process mode)
    transport = null, // HackathonTransport (remote mode)
    workspaceRoot = process.cwd(),
    mode = "plan",
    heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
    maxRetries = DEFAULT_MAX_RETRIES,
    taskTimeoutMs = DEFAULT_TASK_TIMEOUT_MS,
    eventLog = null,
  } = {}) {
    this.workerId = workerId;
    this.sessionId = sessionId;
    this.coordinator = coordinator; // local-process coupling (Phase 2)
    this.transport = transport; // remote coupling (future phases)
    this.workspaceRoot = workspaceRoot;
    this.mode = mode;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.maxRetries = maxRetries;
    this.taskTimeoutMs = taskTimeoutMs;
    this.eventLog = eventLog || null;

    this._runtime = null; // AgentRuntime, built lazily
    this._tasks = new Map(); // taskId -> task state
    this._currentTaskId = null;

    this._connected = false;
    this._registered = false;
    this._heartbeatTimer = null;
  }

  /** Build the local AgentRuntime on first use. */
  _buildRuntime() {
    if (this._runtime) return this._runtime;

    const registry = new AgentRegistry(builtinSpecs());
    const tools = createRealTools();

    this._runtime = new AgentRuntime({
      registry,
      tools,
      complete: (config, modelId, prompt, opts) => complete(config, modelId, prompt, opts),
      workspaceRoot: this.workspaceRoot,
      log: this.eventLog,
      config: {},
    });

    return this._runtime;
  }

  /** Get the worker's local AgentRuntime. */
  get runtime() {
    if (!this._runtime) this._buildRuntime();
    return this._runtime;
  }

  /** Register with the coordinator. */
  async register({ invitationToken } = {}) {
    if (!invitationToken) {
      return WorkerResult.err(new Error("invitationToken required"));
    }

    if (this.coordinator) {
      // Local-process mode: call coordinator directly.
      const result = await this.coordinator.registerWorker({
        workerId: this.workerId,
        token: invitationToken,
        capabilities: this._getCapabilities(),
        transport: null,
      });
      if (result.ok) {
        this._registered = true;
        this._connected = true;
        this.sessionId = result.data.sessionId;
        this._startHeartbeat();
        this._logEvent(HACKATHON_EVENTS.WORKER_REGISTERED, {
          workerId: this.workerId,
          payload: { sessionId: this.sessionId },
        });
      }
      return result;
    }

    if (this.transport) {
      // Remote mode: send registration over transport.
      await this.transport.connect();
      const event = createEvent({
        sessionId: this.sessionId,
        workerId: this.workerId,
        type: HACKATHON_EVENTS.WORKER_REGISTERED,
        payload: { invitationToken, capabilities: this._getCapabilities() },
      });
      await this.transport.send(event);
      this._registered = true;
      this._connected = true;
      this._startHeartbeat();
      return WorkerResult.ok({ workerId: this.workerId });
    }

    return WorkerResult.err(new Error("no coordinator or transport configured"));
  }

  /** Get the capabilities this worker advertises to the coordinator. */
  _getCapabilities() {
    const caps = ["filesystem", "shell", "node", this.mode];
    return caps;
  }

  /** Start the heartbeat loop. */
  _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeatTimer = setInterval(async () => {
      await this._sendHeartbeat();
    }, this.heartbeatIntervalMs);
    this._heartbeatTimer.unref?.();
  }

  /** Stop the heartbeat loop. */
  _stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  /** Send a heartbeat to the coordinator. */
  async _sendHeartbeat() {
    if (!this._registered) return;

    const payload = {
      workerId: this.workerId,
      currentTaskId: this._currentTaskId,
      at: new Date().toISOString(),
    };

    if (this.coordinator) {
      await this.coordinator.heartbeat({ workerId: this.workerId, payload });
    } else if (this.transport) {
      const event = createEvent({
        sessionId: this.sessionId,
        workerId: this.workerId,
        type: HACKATHON_EVENTS.WORKER_HEARTBEAT,
        payload,
      });
      await this.transport.send(event);
    }

    this._logEvent(HACKATHON_EVENTS.WORKER_HEARTBEAT, {
      workerId: this.workerId,
      payload,
    });
  }

  /** Receive a task contract from the coordinator. */
  async receiveTask({ task, leaseId, expiresAt } = {}) {
    if (!task || !task.taskId) {
      return WorkerResult.err(new Error("invalid task contract"));
    }

    // Validate the task is for this worker.
    if (task.assignedWorkerId !== this.workerId) {
      return WorkerResult.err(new Error(
        `task ${task.taskId} not assigned to this worker`,
      ));
    }

    // Store the task.
    const taskState = {
      ...task,
      leaseId,
      leaseExpiresAt: expiresAt,
      state: TASK_STATUS.ASSIGNED,
      progress: 0,
      evidence: [],
      receivedAt: new Date().toISOString(),
    };
    this._tasks.set(task.taskId, taskState);

    this._logEvent(HACKATHON_EVENTS.TASK_DISPATCHED, {
      workerId: this.workerId,
      taskId: task.taskId,
      payload: { leaseId },
    });

    return WorkerResult.ok({ taskId: task.taskId, state: taskState.state });
  }

  /** Accept a dispatched task. */
  async acceptTask({ taskId } = {}) {
    if (!this._registered) {
      return WorkerResult.err(new Error("worker not registered"));
    }

    const taskState = this._tasks.get(taskId);
    if (!taskState) {
      return WorkerResult.err(new Error(`unknown task: ${taskId}`));
    }
    if (taskState.state !== TASK_STATUS.ASSIGNED) {
      return WorkerResult.err(new Error(
        `task ${taskId} not in ASSIGNED state (${taskState.state})`,
      ));
    }

    // Validate transition ASSIGNED -> ACCEPTED.
    const transition = validateTransition(taskState.state, TASK_STATUS.ACCEPTED);
    if (!transition.ok) {
      return WorkerResult.err(new Error(
        `cannot accept task ${taskId}: ${transition.reason}`,
      ));
    }

    taskState.state = TASK_STATUS.ACCEPTED;
    taskState.updatedAt = new Date().toISOString();
    this._currentTaskId = taskId;

    if (this.coordinator) {
      await this.coordinator.acceptTask({ taskId, workerId: this.workerId });
    } else if (this.transport) {
      const event = createEvent({
        sessionId: this.sessionId,
        workerId: this.workerId,
        taskId,
        type: HACKATHON_EVENTS.TASK_ACCEPTED,
        payload: {},
      });
      await this.transport.send(event);
    }

    this._logEvent(HACKATHON_EVENTS.TASK_ACCEPTED, {
      workerId: this.workerId,
      taskId,
      payload: {},
    });

    return WorkerResult.ok({ taskId, state: taskState.state });
  }

  /** Start executing an accepted task. */
  async startTask({ taskId } = {}) {
    if (!this._registered) {
      return WorkerResult.err(new Error("worker not registered"));
    }

    const taskState = this._tasks.get(taskId);
    if (!taskState) {
      return WorkerResult.err(new Error(`unknown task: ${taskId}`));
    }
    if (taskState.state !== TASK_STATUS.ACCEPTED) {
      return WorkerResult.err(new Error(
        `task ${taskId} not in ACCEPTED state (${taskState.state})`,
      ));
    }

    const transition = validateTransition(taskState.state, TASK_STATUS.RUNNING);
    if (!transition.ok) {
      return WorkerResult.err(new Error(
        `cannot start task ${taskId}: ${transition.reason}`,
      ));
    }

    taskState.state = TASK_STATUS.RUNNING;
    taskState.progress = 0;
    taskState.startedAt = new Date().toISOString();
    this._currentTaskId = taskId;

    if (this.coordinator) {
      await this.coordinator.taskStarted({ taskId, workerId: this.workerId });
    } else if (this.transport) {
      const event = createEvent({
        sessionId: this.sessionId,
        workerId: this.workerId,
        taskId,
        type: HACKATHON_EVENTS.TASK_STARTED,
        payload: {},
      });
      await this.transport.send(event);
    }

    this._logEvent(HACKATHON_EVENTS.TASK_STARTED, {
      workerId: this.workerId,
      taskId,
      payload: {},
    });

    return WorkerResult.ok({ taskId, state: taskState.state });
  }

  /** Execute a task through the local AgentRuntime. */
  async executeTask({ taskId } = {}) {
    if (!this._registered) {
      return WorkerResult.err(new Error("worker not registered"));
    }

    const taskState = this._tasks.get(taskId);
    if (!taskState) {
      return WorkerResult.err(new Error(`unknown task: ${taskId}`));
    }
    if (taskState.state !== TASK_STATUS.RUNNING) {
      return WorkerResult.err(new Error(
        `task ${taskId} not in RUNNING state (${taskState.state})`,
      ));
    }

    const runtime = this.runtime;
    const startedAt = Date.now();

    try {
      const result = await runtime.run({
        agentId: taskState.assignedWorkerId || "coder",
        task: `${taskState.objective}\n\nTask: ${taskState.title}\nFiles owned: ${JSON.stringify(taskState.filesOwned || [])}\nAcceptance criteria: ${JSON.stringify(taskState.acceptanceCriteria || [])}`,
        sessionId: this.sessionId,
      });

      const durationMs = Date.now() - startedAt;

      taskState.state = TASK_STATUS.COMPLETED;
      taskState.progress = 100;
      taskState.completedAt = new Date().toISOString();
      taskState.durationMs = durationMs;
      taskState.output = result.output;

      // Report completion to coordinator (evidence-based, not self-verified).
      const evidence = [
        { kind: "command", value: `agent run ${taskState.assignedWorkerId || "coder"}` },
        { kind: "note", value: `completed in ${durationMs}ms` },
      ];
      if (result.output) {
        evidence.push({ kind: "note", value: `output: ${String(result.output).slice(0, 500)}` });
      }

      if (this.coordinator) {
        await this.coordinator.completeTask({
          taskId,
          workerId: this.workerId,
          evidence,
          testResults: [],
        });
      } else if (this.transport) {
        const event = createEvent({
          sessionId: this.sessionId,
          workerId: this.workerId,
          taskId,
          type: HACKATHON_EVENTS.TASK_COMPLETED,
          payload: { evidence, verified: false },
        });
        await this.transport.send(event);
      }

      this._logEvent(HACKATHON_EVENTS.TASK_COMPLETED, {
        workerId: this.workerId,
        taskId,
        payload: { evidence, verified: false },
      });

      this._currentTaskId = null;

      return WorkerResult.ok({
        taskId,
        state: taskState.state,
        durationMs,
        verified: false,
      });
    } catch (err) {
      taskState.state = TASK_STATUS.FAILED;
      taskState.failedAt = new Date().toISOString();
      taskState.error = String(err);

      if (this.coordinator) {
        await this.coordinator.failTask({
          taskId,
          workerId: this.workerId,
          error: err,
        });
      } else if (this.transport) {
        const event = createEvent({
          sessionId: this.sessionId,
          workerId: this.workerId,
          taskId,
          type: HACKATHON_EVENTS.TASK_FAILED,
          payload: { error: String(err) },
        });
        await this.transport.send(event);
      }

      this._logEvent(HACKATHON_EVENTS.TASK_FAILED, {
        workerId: this.workerId,
        taskId,
        payload: { error: String(err) },
      });

      this._currentTaskId = null;

      return WorkerResult.err(err);
    }
  }

  /** Report progress on a running task. */
  async reportProgress({ taskId, progress, evidence = [] } = {}) {
    if (progress === undefined || progress === null) {
      return WorkerResult.err(new Error("progress required"));
    }

    const taskState = this._tasks.get(taskId);
    if (!taskState) {
      return WorkerResult.err(new Error(`unknown task: ${taskId}`));
    }

    taskState.progress = Math.min(100, Math.max(0, progress));
    taskState.updatedAt = new Date().toISOString();
    if (evidence.length) {
      taskState.evidence.push(...evidence.map((e) => ({ ...e, at: new Date().toISOString(), by: this.workerId })));
    }

    if (this.coordinator) {
      await this.coordinator.taskProgress({
        taskId,
        workerId: this.workerId,
        progress: taskState.progress,
        evidence,
      });
    } else if (this.transport) {
      const event = createEvent({
        sessionId: this.sessionId,
        workerId: this.workerId,
        taskId,
        type: HACKATHON_EVENTS.TASK_PROGRESS,
        payload: { progress: taskState.progress, evidence },
      });
      await this.transport.send(event);
    }

    this._logEvent(HACKATHON_EVENTS.TASK_PROGRESS, {
      workerId: this.workerId,
      taskId,
      payload: { progress: taskState.progress },
    });

    return WorkerResult.ok({ taskId, progress: taskState.progress });
  }

  /** Report a blocker on a task. */
  async reportBlocked({ taskId, reason } = {}) {
    const taskState = this._tasks.get(taskId);
    if (!taskState) {
      return WorkerResult.err(new Error(`unknown task: ${taskId}`));
    }

    taskState.state = TASK_STATUS.BLOCKED;
    taskState.updatedAt = new Date().toISOString();

    if (this.coordinator) {
      // Coordinator doesn't have a direct blockTask; use failTask or a custom event.
      // Emit via transport-style event.
      if (this.transport) {
        const event = createEvent({
          sessionId: this.sessionId,
          workerId: this.workerId,
          taskId,
          type: HACKATHON_EVENTS.TASK_BLOCKED,
          payload: { reason },
        });
        await this.transport.send(event);
      }
    }

    this._logEvent(HACKATHON_EVENTS.TASK_BLOCKED, {
      workerId: this.workerId,
      taskId,
      payload: { reason },
    });

    return WorkerResult.ok({ taskId, state: taskState.state });
  }

  /** Renew the lease on the current task. */
  async renewLease({ taskId } = {}) {
    if (this.coordinator) {
      return this.coordinator.renewLease({ taskId, workerId: this.workerId });
    }
    return WorkerResult.err(new Error("lease renewal requires coordinator"));
  }

  /** Handle reconnection: reconcile task state with coordinator. */
  async reconnect() {
    this._connected = true;
    this._startHeartbeat();

    // Re-announce current tasks to coordinator.
    for (const [taskId, taskState] of this._tasks) {
      if (taskState.state === TASK_STATUS.RUNNING || taskState.state === TASK_STATUS.ACCEPTED) {
        await this.renewLease({ taskId });
      }
    }

    this._logEvent(HACKATHON_EVENTS.WORKER_RECONNECTED, {
      workerId: this.workerId,
      payload: { reconciledAt: new Date().toISOString() },
    });

    return WorkerResult.ok({ workerId: this.workerId, sessionId: this.sessionId });
  }

  /** Disconnect from the coordinator. */
  async disconnect() {
    this._connected = false;
    this._stopHeartbeat();
    return WorkerResult.ok({ workerId: this.workerId });
  }

  /** Get all tasks known to this worker. */
  getTasks() {
    return [...this._tasks.values()];
  }

  /** Get the current task. */
  getCurrentTask() {
    if (!this._currentTaskId) return null;
    return this._tasks.get(this._currentTaskId);
  }

  /** Is the worker connected? */
  get connected() {
    return this._connected;
  }

  /** Is the worker registered? */
  get registered() {
    return this._registered;
  }

  /** Log an event to the event log. */
  _logEvent(type, { workerId = null, taskId = null, payload = {} } = {}) {
    if (!this.eventLog) return;
    this.eventLog.emit(type, redactVerified({
      workerId: workerId || this.workerId,
      taskId,
      sessionId: this.sessionId,
      payload,
    }), "info");
  }
}

export default { WorkerRuntime, WorkerResult };
