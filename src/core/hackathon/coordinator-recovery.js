// Coordinator recovery for Hackathon Mode.
//
// Rebuilds coordinator state after a restart from persisted session data and
// the event log. This is the recovery path: when the leader restarts, it
// reloads its session from disk, re-registers workers, and reconciles any
// in-flight tasks whose leases may have expired.

import {
  SESSION_STATUS, WORKER_STATUS, TASK_STATUS,
  validateSession, loadSession, persistSession,
} from "./session.js";
import { TaskGraph } from "./task-graph.js";
import { Scheduler } from "./scheduler.js";
import { EventSequence } from "./event-seq.js";
import { redactVerified } from "../redact.js";

/** Recover a coordinator after restart.
 *
 * Loads the session from disk, rebuilds the task graph and scheduler, and
 * returns a recovery report. Workers must re-register (their transports are
 * gone), but their task assignments and leases are preserved so in-flight
 * work is not lost.
 *
 * Returns { ok, session, taskGraph, scheduler, eventSeq, report }.
 */
export async function recoverCoordinator({
  stateDir,
  sessionId,
  eventLog = null,
} = {}) {
  if (!stateDir || !sessionId) {
    return { ok: false, error: new Error("stateDir and sessionId required") };
  }

  // Load session from disk.
  const result = loadSession(stateDir, sessionId);
  if (!result.ok) {
    return { ok: false, error: result.error || new Error("session not found") };
  }
  const session = result.value;
  validateSession(session);

  // Rebuild task graph from session state.
  const taskGraph = new TaskGraph();
  for (const [_taskId, contract] of Object.entries(session.tasks || {})) {
    taskGraph.upsert(contract);
  }

  // Rebuild scheduler and worker registry.
  const scheduler = new Scheduler({ maxConcurrency: 8 });
  const workers = new Map();
  for (const [workerId, record] of Object.entries(session.workers || {})) {
    workers.set(workerId, record);
    // Workers are marked disconnected after restart — they must reconnect.
    if (record.status === WORKER_STATUS.CONNECTED) {
      record.status = WORKER_STATUS.DISCONNECTED;
      record.disconnectedAt = new Date().toISOString();
    }
    scheduler.registerWorker(workerId, {
      capabilities: record.capabilities || [],
      available: false, // not available until worker reconnects
    });
  }

  // Rebuild event sequence tracker.
  const eventSeq = new EventSequence({ sessionId });
  // Restore from session event history if present.
  if (session.events && session.events.length) {
    let maxSeq = 0;
    for (const ev of session.events) {
      if (ev.sequence && ev.sequence > maxSeq) maxSeq = ev.sequence;
    }
    // Rebuild seen set from events.
    for (const ev of session.events) {
      if (ev.sequence) eventSeq.seen.add(ev.sequence);
    }
    eventSeq.lastSequence = maxSeq;
  }

  // Check for expired leases — these tasks become reassignable.
  const expiredLeases = scheduler.expiredLeases();
  const expiredTasks = [];
  for (const lease of expiredLeases) {
    const contract = taskGraph.get(lease.taskId);
    if (contract && contract.state === TASK_STATUS.ASSIGNED) {
      contract.state = TASK_STATUS.EXPIRED;
      contract.updatedAt = new Date().toISOString();
      taskGraph.upsert(contract);
      session.tasks[lease.taskId] = contract.toJSON();
      expiredTasks.push({ taskId: lease.taskId, workerId: lease.workerId });
    }
  }

  // Persist the recovered state.
  session.status = SESSION_STATUS.ACTIVE;
  session.updatedAt = new Date().toISOString();
  await persistSession(stateDir, session);

  const report = {
    sessionId,
    status: session.status,
    workerCount: workers.size,
    connectedWorkers: 0, // none connected after restart
    taskCount: Object.keys(session.tasks || {}).length,
    completedTasks: Object.values(session.tasks || {}).filter(
      (t) => t.state === TASK_STATUS.COMPLETED
    ).length,
    expiredLeases: expiredTasks.length,
    expiredTaskIds: expiredTasks.map((t) => t.taskId),
    recoveredAt: new Date().toISOString(),
  };

  if (eventLog) {
    eventLog.emit("hackathon.coordinator_recovered", redactVerified(report), "info");
  }

  return {
    ok: true,
    session,
    taskGraph,
    scheduler,
    workers,
    eventSeq,
    report,
  };
}

/** Validate that a recovered session is consistent.
 *
 * Checks: no two tasks assigned to the same worker with overlapping leases,
 * all task dependencies reference existing tasks, no cycles in the graph.
 */
export function validateRecovery({ taskGraph, _session } = {}) {
  const issues = [];

  // Check for dependency cycles.
  const cycle = taskGraph.detectCycle();
  if (cycle) {
    issues.push({ type: "dependency_cycle", tasks: cycle });
  }

  // Check that all task dependencies reference existing tasks.
  for (const [taskId, contract] of taskGraph.contracts) {
    for (const depId of contract.dependencies || []) {
      if (!taskGraph.get(depId)) {
        issues.push({
          type: "missing_dependency",
          taskId,
          dependency: depId,
        });
      }
    }
  }

  // Check that no worker has more than one active lease (shouldn't happen
  // but validates recovery integrity).
  const workerLeases = new Map();
  for (const [taskId, contract] of taskGraph.contracts) {
    if (contract.state === "assigned" && contract.leaseId && contract.assignedWorkerId) {
      const key = contract.assignedWorkerId;
      if (!workerLeases.has(key)) workerLeases.set(key, []);
      workerLeases.get(key).push(taskId);
    }
  }
  for (const [workerId, taskIds] of workerLeases) {
    if (taskIds.length > 1) {
      issues.push({
        type: "multiple_active_leases",
        workerId,
        tasks: taskIds,
      });
    }
  }

  return { valid: issues.length === 0, issues };
}

export default { recoverCoordinator, validateRecovery };
