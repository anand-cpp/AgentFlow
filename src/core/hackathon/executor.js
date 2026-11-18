// Hackathon Mode concurrent task execution engine.
//
// The SessionExecutor ties together the coordinator and workers to execute
// tasks in parallel, respecting dependency constraints, bounded concurrency,
// worker capabilities, leases, and failure recovery.
//
// It is the leader-side scheduling loop: it reads the task graph, dispatches
// ready tasks to eligible workers, watches for completions/failures, and when
// a task completes, checks whether any dependent tasks are now ready to run.
//
// Bounded concurrency: no more than maxConcurrentTasks tasks run at once, and
// no more than maxConcurrentWorkers workers are used.
//
// Dependency enforcement: a task is only dispatched when all its prerequisite
// tasks are COMPLETED. Failed tasks block their dependents until reassigned.

import { TASK_STATUS } from "./session.js";
import { Scheduler } from "./scheduler.js";
import { TaskGraph } from "./task-graph.js";
import { isActive } from "./lifecycle.js";
import { HACKATHON_EVENTS } from "./events.js";
import { redactVerified } from "../redact.js";

const DEFAULT_MAX_CONCURRENT_TASKS = 8;
const DEFAULT_MAX_CONCURRENT_WORKERS = 16;
const DEFAULT_DISPATCH_INTERVAL_MS = 1000; // scheduling tick
const DEFAULT_LEASE_CHECK_INTERVAL_MS = 5000; // lease expiry check

/** Result of an executor operation. */
class ExecutorResult {
  constructor({ ok, error, data } = {}) {
    this.ok = ok;
    this.error = error;
    this.data = data;
  }
  static ok(data) { return new ExecutorResult({ ok: true, data }); }
  static err(error) { return new ExecutorResult({ ok: false, error }); }
}

/**
 * SessionExecutor — concurrent task execution engine for Hackathon Mode.
 *
 * Runs on the leader. Coordinates the coordinator and one or more workers to
 * execute tasks in parallel.
 *
 * The executor does NOT execute tasks itself — it dispatches task contracts to
 * workers and each worker executes through its own local AgentRuntime. The
 * executor is purely the scheduling and state-reconciliation layer.
 */
export class SessionExecutor {
  constructor({
    coordinator = null,
    scheduler = null,
    taskGraph = null,
    workers = new Map(), // workerId -> { workerRuntime, capabilities }
    maxConcurrentTasks = DEFAULT_MAX_CONCURRENT_TASKS,
    maxConcurrentWorkers = DEFAULT_MAX_CONCURRENT_WORKERS,
    dispatchIntervalMs = DEFAULT_DISPATCH_INTERVAL_MS,
    leaseCheckIntervalMs = DEFAULT_LEASE_CHECK_INTERVAL_MS,
    eventLog = null,
  } = {}) {
    this.coordinator = coordinator;
    this.scheduler = scheduler || (coordinator ? coordinator.scheduler : new Scheduler({ maxConcurrency: maxConcurrentTasks }));
    this.taskGraph = taskGraph || new TaskGraph();
    this.workers = workers; // workerId -> { runtime, capabilities, connected }
    this.maxConcurrentTasks = maxConcurrentTasks;
    this.maxConcurrentWorkers = maxConcurrentWorkers;
    this.dispatchIntervalMs = dispatchIntervalMs;
    this.leaseCheckIntervalMs = leaseCheckIntervalMs;
    this.eventLog = eventLog || null;

    this._running = false;
    this._dispatchTimer = null;
    this._leaseTimer = null;
    this._dispatchCount = 0;
    this._completedCount = 0;
    this._failedCount = 0;
  }

  /** Register a worker with the executor. */
  registerWorker(workerId, { runtime = null, capabilities = [], connected = true } = {}) {
    this.workers.set(workerId, { runtime, capabilities, connected });
    this.scheduler.registerWorker(workerId, { capabilities, available: connected });
  }

  /** Mark a worker as connected/disconnected. */
  setWorkerConnected(workerId, connected) {
    const entry = this.workers.get(workerId);
    if (!entry) return false;
    entry.connected = connected;
    this.scheduler.registerWorker(workerId, {
      capabilities: entry.capabilities,
      available: connected,
    });
    return true;
  }

  /** Start the executor loop. */
  start() {
    if (this._running) return;
    this._running = true;

    // Periodic dispatch tick: schedule ready tasks to available workers.
    this._dispatchTimer = setInterval(() => this._dispatchTick(), this.dispatchIntervalMs);
    this._dispatchTimer.unref?.();

    // Periodic lease expiry check.
    this._leaseTimer = setInterval(() => this._leaseCheckTick(), this.leaseCheckIntervalMs);
    this._leaseTimer.unref?.();

    // Run an initial dispatch immediately.
    this._dispatchTick();
  }

  /** Stop the executor loop. */
  stop() {
    this._running = false;
    if (this._dispatchTimer) {
      clearInterval(this._dispatchTimer);
      this._dispatchTimer = null;
    }
    if (this._leaseTimer) {
      clearInterval(this._leaseTimer);
      this._leaseTimer = null;
    }
  }

  /** One scheduling tick: find ready tasks and dispatch them. */
  _dispatchTick() {
    if (!this._running || !this.coordinator) return;

    const session = this.coordinator.session;
    if (!session) return;

    // Count currently active (in-flight) tasks.
    const activeTasks = this._countActiveTasks();
    const availableSlots = this.maxConcurrentTasks - activeTasks;
    if (availableSlots <= 0) return;

    // Get task states from session.
    const taskStates = {};
    for (const [taskId, task] of Object.entries(session.tasks || {})) {
      taskStates[taskId] = task.state;
    }

    // Find ready tasks (no unsatisfied deps, in assignable state).
    const readyTaskIds = this.taskGraph.ready(taskStates);

    // Sort by priority.
    const sorted = readyTaskIds.sort((a, b) => {
      const ca = this.taskGraph.get(a);
      const cb = this.taskGraph.get(b);
      const pa = ca ? ca.priority : "medium";
      const pb = cb ? cb.priority : "medium";
      const rank = { high: 3, medium: 2, low: 1 };
      return (rank[pb] || 2) - (rank[pa] || 2);
    });

    let dispatched = 0;
    for (const taskId of sorted) {
      if (dispatched >= availableSlots) break;

      const contract = this.taskGraph.get(taskId);
      if (!contract) continue;

      // Find an eligible connected worker.
      const eligible = this.scheduler.eligibleWorkers(contract);
      const workerId = eligible.find((wid) => {
        const entry = this.workers.get(wid);
        return entry && entry.connected;
      });

      if (!workerId) continue; // no eligible connected worker

      // Dispatch the task.
      const result = this.coordinator.dispatchTask({ taskId, workerId });
      if (result.ok) {
        dispatched += 1;
        this._dispatchCount += 1;
        this._logEvent(HACKATHON_EVENTS.TASK_DISPATCHED, {
          workerId,
          taskId,
          payload: { leaseId: result.data.leaseId },
        });
      }
    }
  }

  /** Count tasks currently in an active (non-terminal) state. */
  _countActiveTasks() {
    let count = 0;
    const session = this.coordinator.session;
    if (!session) return 0;
    for (const task of Object.values(session.tasks || {})) {
      if (isActive(task.state)) count += 1;
    }
    return count;
  }

  /** Periodic lease expiry check. Expired leases make tasks reassignable. */
  _leaseCheckTick() {
    if (!this._running || !this.coordinator) return;
    const expired = this.coordinator.checkExpiredLeases();
    for (const lease of expired) {
      this._logEvent(HACKATHON_EVENTS.LEASE_EXPIRED, {
        workerId: lease.workerId,
        taskId: lease.taskId,
        payload: { reason: "lease expired" },
      });
    }
  }

  /** Process a task completion event from a worker. */
  async onTaskCompleted({ taskId, workerId, evidence, testResults } = {}) {
    if (!this.coordinator) {
      return ExecutorResult.err(new Error("no coordinator"));
    }

    const contract = this.taskGraph.get(taskId);
    if (!contract) {
      return ExecutorResult.err(new Error(`unknown task: ${taskId}`));
    }
    if (contract.assignedWorkerId !== workerId) {
      return ExecutorResult.err(new Error(
        `task ${taskId} not assigned to worker ${workerId}`,
      ));
    }

    const result = await this.coordinator.completeTask({
      taskId,
      workerId,
      evidence,
      testResults,
    });

    if (result.ok) {
      this._completedCount += 1;
      this._logEvent(HACKATHON_EVENTS.TASK_COMPLETED, {
        workerId,
        taskId,
        payload: { verified: result.data.verified },
      });
      // After completion, the next dispatch tick will pick up newly-ready dependents.
    }

    return result;
  }

  /** Process a task failure event from a worker. */
  async onTaskFailed({ taskId, workerId, error, evidence = [] } = {}) {
    if (!this.coordinator) {
      return ExecutorResult.err(new Error("no coordinator"));
    }

    const result = await this.coordinator.failTask({
      taskId,
      workerId,
      error,
      evidence,
    });

    if (result.ok) {
      this._failedCount += 1;
      this._logEvent(HACKATHON_EVENTS.TASK_FAILED, {
        workerId,
        taskId,
        payload: { error: String(error) },
      });
    }

    return result;
  }

  /** Process a worker disconnection. */
  onWorkerDisconnected({ workerId } = {}) {
    if (!this.coordinator) return;
    this.coordinator.workerDisconnected({ workerId });
    this.setWorkerConnected(workerId, false);

    // Revoke the worker's leases so its tasks become reassignable.
    this.scheduler.revokeWorkerLeases(workerId);

    // Mark the worker's current task as expired (reassignable).
    const entry = this.workers.get(workerId);
    if (entry && entry.runtime) {
      const current = entry.runtime.getCurrentTask();
      if (current) {
        const contract = this.taskGraph.get(current.taskId);
        if (contract && isActive(contract.state)) {
          contract.state = TASK_STATUS.EXPIRED;
          contract.updatedAt = new Date().toISOString();
          this.taskGraph.upsert(contract);
          this._logEvent(HACKATHON_EVENTS.TASK_REASSIGNED, {
            workerId,
            taskId: current.taskId,
            payload: { reason: "worker disconnected" },
          });
        }
      }
    }
  }

  /** Process a worker reconnection. */
  onWorkerReconnected({ workerId, capabilities = [] } = {}) {
    if (!this.coordinator) return;
    this.coordinator.workerReconnected({ workerId, capabilities });
    this.setWorkerConnected(workerId, true);
  }

  /** Get execution statistics. */
  getStats() {
    return {
      dispatchCount: this._dispatchCount,
      completedCount: this._completedCount,
      failedCount: this._failedCount,
      activeTaskCount: this._countActiveTasks(),
      workerCount: this.workers.size,
      connectedWorkerCount: [...this.workers.values()].filter((w) => w.connected).length,
    };
  }

  /** Get all tasks with their current state. */
  getTasks() {
    if (!this.coordinator || !this.coordinator.session) return [];
    return Object.values(this.coordinator.session.tasks || {});
  }

  /** Log an event. */
  _logEvent(type, { workerId = null, taskId = null, payload = {} } = {}) {
    if (!this.eventLog) return;
    this.eventLog.emit(type, redactVerified({
      workerId,
      taskId,
      sessionId: this.coordinator?.session?.id || null,
      payload,
    }), "info");
  }
}

export default { SessionExecutor, ExecutorResult };
