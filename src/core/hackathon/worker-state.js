// Worker state persistence for Hackathon Mode.
//
// A worker saves its own task state to disk so it can recover after a restart
// without losing track of assigned tasks, leases, or progress. This is the
// worker's local copy of task state — the coordinator remains authoritative.
//
// Storage: one JSON file per worker under the state dir, written atomically.
// No credentials are stored.

import path from "node:path";
import { writeAtomicFile, readJsonFile, assertVersion } from "../persist.js";
import { redactVerified } from "../redact.js";
import { TASK_STATUS } from "./session.js";

export const WORKER_STATE_VERSION = 1;

/** Create the initial worker state record. */
export function createWorkerState({ workerId, sessionRef } = {}) {
  if (!workerId) throw new Error("workerId required");
  if (!sessionRef) throw new Error("sessionRef required");
  return {
    version: WORKER_STATE_VERSION,
    workerId,
    sessionRef,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tasks: {},          // taskId -> TaskState (worker's local view)
    currentTaskId: null,
    leases: {},         // leaseId -> { taskId, expiresAt }
    lastHeartbeat: null,
  };
}

/** Validate worker state. Throws on invalid. */
export function validateWorkerState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new Error("worker state must be an object");
  }
  if (state.version !== WORKER_STATE_VERSION) {
    throw new Error(`unsupported worker state version: ${state.version}`);
  }
  return true;
}

/** Persist worker state atomically. */
export async function persistWorkerState(stateDir, state) {
  validateWorkerState(state);
  state.updatedAt = new Date().toISOString();
  const file = path.join(stateDir, `worker-${state.workerId}.json`);
  const clean = redactVerified(JSON.parse(JSON.stringify(state)));
  await writeAtomicFile(file, JSON.stringify(clean, null, 2));
  return state;
}

/** Load worker state from disk. */
export function loadWorkerState(stateDir, workerId) {
  const file = path.join(stateDir, `worker-${workerId}.json`);
  const result = readJsonFile(file);
  if (!result.ok) return result;
  assertVersion(result.value, WORKER_STATE_VERSION, file);
  return { ok: true, value: result.value };
}

/** Record a task in worker state. */
export function recordTask(state, {
  taskId, leaseId, leaseExpiresAt, objective, assignedWorkerId,
  requiredCapabilities, dependencies, requiredTests, filesOwned,
} = {}) {
  state.tasks[taskId] = {
    taskId,
    leaseId,
    leaseExpiresAt,
    objective,
    assignedWorkerId,
    requiredCapabilities: requiredCapabilities || [],
    dependencies: dependencies || [],
    requiredTests: requiredTests || [],
    filesOwned: filesOwned || [],
    state: TASK_STATUS.ASSIGNED,
    progress: 0,
    evidence: [],
    receivedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  state.currentTaskId = taskId;
  state.leases[leaseId] = { taskId, expiresAt: leaseExpiresAt };
  return state;
}

/** Update task progress in worker state. */
export function updateTaskProgress(state, taskId, progress, evidence = []) {
  const task = state.tasks[taskId];
  if (!task) throw new Error(`unknown task: ${taskId}`);
  task.progress = Math.min(100, Math.max(0, progress));
  task.updatedAt = new Date().toISOString();
  if (evidence.length) {
    task.evidence.push(...evidence.map((e) => ({ ...e, at: new Date().toISOString() })));
  }
  return state;
}

/** Mark a task completed in worker state. */
export function completeTaskInState(state, taskId) {
  const task = state.tasks[taskId];
  if (!task) throw new Error(`unknown task: ${taskId}`);
  task.state = TASK_STATUS.COMPLETED;
  task.progress = 100;
  task.completedAt = new Date().toISOString();
  task.updatedAt = new Date().toISOString();
  if (state.currentTaskId === taskId) state.currentTaskId = null;
  return state;
}

/** Mark a task failed in worker state. */
export function failTaskInState(state, taskId, error) {
  const task = state.tasks[taskId];
  if (!task) throw new Error(`unknown task: ${taskId}`);
  task.state = TASK_STATUS.FAILED;
  task.failedAt = new Date().toISOString();
  task.error = String(error);
  task.updatedAt = new Date().toISOString();
  if (state.currentTaskId === taskId) state.currentTaskId = null;
  return state;
}

/** Remove a lease from worker state. */
export function releaseLease(state, leaseId) {
  delete state.leases[leaseId];
  return state;
}

export default {
  WORKER_STATE_VERSION,
  createWorkerState,
  validateWorkerState,
  persistWorkerState,
  loadWorkerState,
  recordTask,
  updateTaskProgress,
  completeTaskInState,
  failTaskInState,
  releaseLease,
};
