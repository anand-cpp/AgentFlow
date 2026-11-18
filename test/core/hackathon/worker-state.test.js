// Worker state persistence tests.

import assert from "node:assert/strict";
import { describe, it, after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createWorkerState, validateWorkerState, persistWorkerState, loadWorkerState,
  recordTask, updateTaskProgress, completeTaskInState, failTaskInState,
  releaseLease,
} from "../../../src/core/hackathon/worker-state.js";
import { TASK_STATUS } from "../../../src/core/hackathon/session.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hackathon-worker-state-"));
after(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* cleanup best-effort */
  }
});

describe("Worker state", () => {
  it("creates and validates initial state", () => {
    const state = createWorkerState({
      workerId: "worker-1",
      sessionRef: "sess-1",
    });
    assert.strictEqual(state.workerId, "worker-1");
    assert.strictEqual(state.sessionRef, "sess-1");
    assert.strictEqual(state.version, 1);
    assert.deepStrictEqual(state.tasks, {});
    assert.strictEqual(state.currentTaskId, null);
    assert.strictEqual(validateWorkerState(state), true);
  });

  it("rejects wrong version", () => {
    const state = createWorkerState({
      workerId: "worker-1",
      sessionRef: "sess-1",
    });
    state.version = 99;
    assert.throws(() => validateWorkerState(state), /unsupported worker state version/);
  });

  it("records a task", () => {
    const state = createWorkerState({
      workerId: "worker-1",
      sessionRef: "sess-1",
    });
    recordTask(state, {
      taskId: "task-1",
      leaseId: "lease-1",
      leaseExpiresAt: "2026-12-01T00:00:00Z",
      objective: "Do task 1",
      assignedWorkerId: "worker-1",
      requiredCapabilities: ["node"],
      dependencies: [],
      requiredTests: [],
      filesOwned: [],
    });
    assert.strictEqual(state.currentTaskId, "task-1");
    assert.ok(state.tasks["task-1"]);
    assert.strictEqual(state.tasks["task-1"].state, TASK_STATUS.ASSIGNED);
    assert.strictEqual(state.leases["lease-1"].taskId, "task-1");
  });

  it("updates task progress", () => {
    const state = createWorkerState({
      workerId: "worker-1",
      sessionRef: "sess-1",
    });
    recordTask(state, {
      taskId: "task-1",
      leaseId: "lease-1",
      leaseExpiresAt: "2026-12-01T00:00:00Z",
      objective: "Do task 1",
      assignedWorkerId: "worker-1",
      requiredCapabilities: [],
      dependencies: [],
      requiredTests: [],
      filesOwned: [],
    });
    updateTaskProgress(state, "task-1", 50, [{ kind: "note", value: "half done" }]);
    assert.strictEqual(state.tasks["task-1"].progress, 50);
    assert.strictEqual(state.tasks["task-1"].evidence.length, 1);
  });

  it("completes a task in state", () => {
    const state = createWorkerState({
      workerId: "worker-1",
      sessionRef: "sess-1",
    });
    recordTask(state, {
      taskId: "task-1",
      leaseId: "lease-1",
      leaseExpiresAt: "2026-12-01T00:00:00Z",
      objective: "Do task 1",
      assignedWorkerId: "worker-1",
      requiredCapabilities: [],
      dependencies: [],
      requiredTests: [],
      filesOwned: [],
    });
    completeTaskInState(state, "task-1");
    assert.strictEqual(state.tasks["task-1"].state, TASK_STATUS.COMPLETED);
    assert.strictEqual(state.tasks["task-1"].progress, 100);
    assert.strictEqual(state.currentTaskId, null);
  });

  it("fails a task in state", () => {
    const state = createWorkerState({
      workerId: "worker-1",
      sessionRef: "sess-1",
    });
    recordTask(state, {
      taskId: "task-1",
      leaseId: "lease-1",
      leaseExpiresAt: "2026-12-01T00:00:00Z",
      objective: "Do task 1",
      assignedWorkerId: "worker-1",
      requiredCapabilities: [],
      dependencies: [],
      requiredTests: [],
      filesOwned: [],
    });
    failTaskInState(state, "task-1", new Error("boom"));
    assert.strictEqual(state.tasks["task-1"].state, TASK_STATUS.FAILED);
    assert.ok(state.tasks["task-1"].error);
    assert.strictEqual(state.currentTaskId, null);
  });

  it("releases a lease", () => {
    const state = createWorkerState({
      workerId: "worker-1",
      sessionRef: "sess-1",
    });
    recordTask(state, {
      taskId: "task-1",
      leaseId: "lease-1",
      leaseExpiresAt: "2026-12-01T00:00:00Z",
      objective: "Do task 1",
      assignedWorkerId: "worker-1",
      requiredCapabilities: [],
      dependencies: [],
      requiredTests: [],
      filesOwned: [],
    });
    assert.ok(state.leases["lease-1"]);
    releaseLease(state, "lease-1");
    assert.strictEqual(state.leases["lease-1"], undefined);
  });

  it("persists and loads worker state", async () => {
    const state = createWorkerState({
      workerId: "worker-1",
      sessionRef: "sess-1",
    });
    recordTask(state, {
      taskId: "task-1",
      leaseId: "lease-1",
      leaseExpiresAt: "2026-12-01T00:00:00Z",
      objective: "Do task 1",
      assignedWorkerId: "worker-1",
      requiredCapabilities: ["node"],
      dependencies: [],
      requiredTests: [],
      filesOwned: [],
    });
    await persistWorkerState(dir, state);

    const result = loadWorkerState(dir, "worker-1");
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.value.workerId, "worker-1");
    assert.strictEqual(result.value.sessionRef, "sess-1");
    assert.ok(result.value.tasks["task-1"]);
    assert.strictEqual(result.value.currentTaskId, "task-1"); // recordTask sets current task
  });

  it("rejects loading missing worker state", () => {
    const result = loadWorkerState(dir, "nonexistent-worker");
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, "missing");
  });

  it("redacts secrets before persisting", async () => {
    const state = createWorkerState({
      workerId: "worker-1",
      sessionRef: "sess-1",
    });
    // Inject a secret-like field with short value (won't trip secret scanner).
    state.apiKey = "x";

    await persistWorkerState(dir, state);

    const file = path.join(dir, `worker-worker-1.json`);
    const raw = fs.readFileSync(file, "utf8");
    assert.ok(!raw.includes('"apiKey": "x"'), "apiKey should be redacted");
  });

  it("TASK_STATUS matches session task statuses", () => {
    // Worker state imports TASK_STATUS from the same session module.
    assert.strictEqual(TASK_STATUS.PENDING, "pending");
    assert.strictEqual(TASK_STATUS.COMPLETED, "completed");
    assert.strictEqual(TASK_STATUS.FAILED, "failed");
    assert.strictEqual(TASK_STATUS.ASSIGNED, "assigned");
  });
});
